"""null out movies.dmm_keywords again to force re-extraction (laugh marker boundary)

Revision ID: c3f8b6a2e174
Revises: a7c1e9d54b28
Create Date: 2026-07-16 06:00:00.000000+00:00

文末ネットスラングの感情マーカー (笑=笑い / 涙=泣 / 汗=焦り) を 1 文字トークンとして
複合語連結の境界とし、単独でも連結でも出力しない修正を、既存レコードにも反映させる
ためのデータマイグレーション。

旧ロジックで保存済みの dmm_keywords には「笑くらしな」(本番 movie h-1832msoc00065)
のような感情マーカーを巻き込んだ壊れた連結が残る。全行の dmm_keywords を NULL に
戻すことで、GET /api/v1/movies/{slug} の write-on-read 補完が新ロジックで再抽出・
再保存する (a7c1e9d54b28 と同じパターン)。

upgrade  : movies.dmm_keywords を一括で NULL にする (単純な UPDATE)。
downgrade: 旧値は復元できないため no-op (可逆・無害)。
"""
from typing import Sequence, Union

from alembic import op


revision: str = "c3f8b6a2e174"
down_revision: Union[str, None] = "a7c1e9d54b28"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 既存の抽出済みキーワードを破棄し、write-on-read で再抽出させる。
    op.execute("UPDATE movies SET dmm_keywords = NULL")


def downgrade() -> None:
    # 破棄した旧キーワードは復元不能。ダウングレードは何もしない (無害)。
    pass
