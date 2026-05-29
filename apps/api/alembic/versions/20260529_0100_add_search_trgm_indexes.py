"""add pg_trgm GIN indexes + btree for search performance

Revision ID: 07a8c4f2b1d9
Revises: f6a7b8c9d0e1
Create Date: 2026-05-29 01:00:00.000000+00:00

背景:
  /api/v1/search は title / description / director_name / maker_name /
  label_name / actresses.name / genres.name / series.name に対して
  ILIKE '%kw%' で部分一致検索する。'%xxx%' は前方一致ではないため
  通常の B-tree index は使えず、データ量が増えるとフルスキャンになり
  検索レイテンシが急激に悪化する。

対策:
  - pg_trgm 拡張を有効化し、対象テキストカラムに対して
    gin_trgm_ops の GIN インデックスを作成する。これにより
    ILIKE '%kw%' / ILIKE 'kw%' のいずれもインデックススキャン可能になる。
  - 詳細検索パネルのサジェスト (`/api/v1/search/suggest`) で
    director_name / maker_name / label_name の GROUP BY が
    フルスキャンになるのを避けるため、これらにも GIN trgm index を張る
    (suggest の prefix サジェストにもそのまま効く)。

注:
  - GIN trgm index はサイズが大きい (元データの数倍) ので、
    description のように長文だがあまり検索ヒット率が高くないカラムも
    張るかは要検討だが、現状の検索は description を OR 条件に
    含めているのでカバーしておく。description だけ後で外したい場合は
    別マイグレーションで drop する。
  - 通常 production では CREATE INDEX CONCURRENTLY が望ましいが、
    Alembic はトランザクションで実行するため CONCURRENTLY を使えない。
    本番運用ではオフピーク帯にこのマイグレーションを当てるか、
    手で CONCURRENTLY を流して alembic_version だけ進める運用にする。
  - IF NOT EXISTS を併用して、既に手動で張られた index に対しても
    冪等に upgrade できるようにしている。
"""
from typing import Sequence, Union

from alembic import op


revision: str = "07a8c4f2b1d9"
down_revision: Union[str, None] = "f6a7b8c9d0e1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# (index_name, table, column) のセット。
# movies の director/maker/label は NULL 許容なので、その GIN は NULL を
# 自動的に弾く (trigram は NULL を含まない)。
_TRGM_INDEXES: list[tuple[str, str, str]] = [
    ("ix_movies_title_trgm", "movies", "title"),
    ("ix_movies_description_trgm", "movies", "description"),
    ("ix_movies_director_name_trgm", "movies", "director_name"),
    ("ix_movies_maker_name_trgm", "movies", "maker_name"),
    ("ix_movies_label_name_trgm", "movies", "label_name"),
    ("ix_actresses_name_trgm", "actresses", "name"),
    ("ix_genres_name_trgm", "genres", "name"),
    ("ix_series_name_trgm", "series", "name"),
]


def upgrade() -> None:
    # 1) pg_trgm 拡張を有効化 (DB 全体で 1 回でよい。既にあれば no-op)
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")

    # 2) 部分一致検索対象の各カラムに GIN trigram index を作成
    for idx_name, table, column in _TRGM_INDEXES:
        op.execute(
            f'CREATE INDEX IF NOT EXISTS "{idx_name}" '
            f'ON "{table}" USING gin ("{column}" gin_trgm_ops)'
        )


def downgrade() -> None:
    for idx_name, table, _column in reversed(_TRGM_INDEXES):
        op.execute(f'DROP INDEX IF EXISTS "{idx_name}"')
    # pg_trgm 拡張は他で使っている可能性もあるので drop しない。
