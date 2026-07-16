"""null out movies.dmm_keywords again to force re-extraction (symbol boundaries)

Revision ID: 5294b991734a
Revises: f3b5d7c9e142
Create Date: 2026-07-16 04:00:00.000000+00:00

記号 ('/' ':' 括弧等) をまたいだ複合語連結の除去と、1 文字ひらがなトークンを
連結に含めない修正を、既存レコードにも反映させるためのデータマイグレーション。

旧ロジックで保存済みの dmm_keywords には「/IT系企業勤務/絶頂回数:」のような記号
混じりの語や「かくらしな」のような壊れた連結が残る。全行の dmm_keywords を NULL に
戻すことで、GET /api/v1/movies/{slug} の write-on-read 補完が新ロジックで再抽出・
再保存する (e2a4c6b8d031 / f3b5d7c9e142 と同じパターン)。

upgrade  : movies.dmm_keywords を一括で NULL にする (単純な UPDATE)。
downgrade: 旧値は復元できないため no-op (可逆・無害)。
"""
from typing import Sequence, Union

from alembic import op


revision: str = "5294b991734a"
down_revision: Union[str, None] = "f3b5d7c9e142"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 既存の抽出済みキーワードを破棄し、write-on-read で再抽出させる。
    op.execute("UPDATE movies SET dmm_keywords = NULL")


def downgrade() -> None:
    # 破棄した旧キーワードは復元不能。ダウングレードは何もしない (無害)。
    pass
