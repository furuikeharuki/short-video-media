"""null out movies.dmm_keywords again to force re-extraction (single alnum boundary)

Revision ID: a7c1e9d54b28
Revises: 5294b991734a
Create Date: 2026-07-16 05:00:00.000000+00:00

1 文字のラテン英字・数字トークン ('w'(笑) 等のネットスラング) を複合語連結の境界
とし、単独でも連結でも出力しない修正を、既存レコードにも反映させるためのデータ
マイグレーション。

旧ロジックで保存済みの dmm_keywords には「wくらしな」(本番 movie h-1832msoc00065)
のような 1 文字英数字を巻き込んだ壊れた連結が残る。全行の dmm_keywords を NULL に
戻すことで、GET /api/v1/movies/{slug} の write-on-read 補完が新ロジックで再抽出・
再保存する (5294b991734a と同じパターン)。

upgrade  : movies.dmm_keywords を一括で NULL にする (単純な UPDATE)。
downgrade: 旧値は復元できないため no-op (可逆・無害)。
"""
from typing import Sequence, Union

from alembic import op


revision: str = "a7c1e9d54b28"
down_revision: Union[str, None] = "5294b991734a"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 既存の抽出済みキーワードを破棄し、write-on-read で再抽出させる。
    op.execute("UPDATE movies SET dmm_keywords = NULL")


def downgrade() -> None:
    # 破棄した旧キーワードは復元不能。ダウングレードは何もしない (無害)。
    pass
