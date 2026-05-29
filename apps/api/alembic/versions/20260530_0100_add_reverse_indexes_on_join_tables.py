"""add reverse btree indexes on join tables + merge heads

Revision ID: 5e1c8b2a90f4
Revises: ('07a8c4f2b1d9', '2b8d1e0f7a34')
Create Date: 2026-05-30 01:00:00.000000+00:00

背景:
  movie_genres / movie_actresses はそれぞれ PRIMARY KEY (movie_id, X_id)
  しか持っていない。これは「ある作品のジャンル/女優を引く」用途には最適だが、
  「あるジャンル/女優を持つ作品を引く」逆方向のクエリでは leading-column
  index が無いため Postgres は Seq Scan に倒れる。

  本番診断 (q=巨乳 ジャンル絞り込み): 154ms のうち movie_genres の
  Parallel Seq Scan + 22,747 回の movies pkey lookup が支配的だった。

  /api/v1/search の OR + EXISTS パスにも同じ JOIN 形が含まれるため
  (`EXISTS (... movie_genres JOIN genres ... WHERE movie_id = movies.id ...)`)、
  ここに逆方向 index があれば planner はその index を使うことができる。

  なお、相関 EXISTS は `movie_id = movies.id` で絞られるので逆方向 index が
  あっても (movie_id, _) PK と同じくらい速い可能性が高い。
  しかしジャンル単独タグ検索 (`/search?genre=巨乳` 等) など、
  逆方向走査が支配的なクエリでは確実に効くので、安全な追加。

対策:
  - ix_movie_genres_genre_id (genre_id, movie_id)
  - ix_movie_actresses_actress_id (actress_id, movie_id)

  これらは PK と重複しないので冪等に追加できる。サイズ増は数 MB 〜
  数十 MB 程度 (行数 × 16 byte 程度)。

複数 head 解消:
  origin/main には PR #289 由来の watch_count 系 (head: 2b8d1e0f7a34)
  と PR #291 由来の trgm 索引 (head: 07a8c4f2b1d9) が独立した 2 head と
  して残っている。本マイグレーションは両 head に依存する merge revision と
  して定義し、これ以降 head が 1 本に戻るようにする (移行時の `upgrade heads`
  必要性を解消)。

運用:
  - 通常 production では CREATE INDEX CONCURRENTLY が望ましいが、Alembic は
    トランザクション内なので CONCURRENTLY が使えない。本リポジトリ既存の
    trgm migration と同じく、CREATE INDEX IF NOT EXISTS で冪等にしておき、
    本番では:
      * オフピーク帯にこのマイグレーションを当てる、または
      * 事前に psql から手で CREATE INDEX CONCURRENTLY を流し、
        `alembic stamp 5e1c8b2a90f4` で alembic_version だけ進める
    のどちらかで対応する。
"""
from typing import Sequence, Union

from alembic import op


revision: str = "5e1c8b2a90f4"
# 既存の 2 head を 1 本に merge する。
down_revision: Union[str, Sequence[str], None] = (
    "07a8c4f2b1d9",  # PR #291: add pg_trgm GIN indexes
    "2b8d1e0f7a34",  # PR (interaction_events watch_count partial indexes)
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# (index_name, table, columns) のセット。
# 既存 PK (movie_id, X_id) と重複しない形 (X_id, movie_id) で張る。
# 第二カラムを含めておくと「genre_id でフィルタしつつ movie_id だけ
# 取得する」covering scan が成立しやすい。
_REVERSE_INDEXES: list[tuple[str, str, list[str]]] = [
    ("ix_movie_genres_genre_id", "movie_genres", ["genre_id", "movie_id"]),
    (
        "ix_movie_actresses_actress_id",
        "movie_actresses",
        ["actress_id", "movie_id"],
    ),
]


def upgrade() -> None:
    for idx_name, table, columns in _REVERSE_INDEXES:
        cols_sql = ", ".join(f'"{c}"' for c in columns)
        op.execute(
            f'CREATE INDEX IF NOT EXISTS "{idx_name}" ON "{table}" ({cols_sql})'
        )


def downgrade() -> None:
    for idx_name, _table, _columns in reversed(_REVERSE_INDEXES):
        op.execute(f'DROP INDEX IF EXISTS "{idx_name}"')
