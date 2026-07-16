"""null out movies.dmm_keywords to force re-extraction

Revision ID: e2a4c6b8d031
Revises: d1f3b5a7c920
Create Date: 2026-07-16 02:00:00.000000+00:00

複合語連結に対応した新しいキーワード抽出ロジック (メンズエステ / 顔面騎乗位 を
1 語として抽出) を既存レコードにも反映させるためのデータマイグレーション。

旧ロジックで保存済みの dmm_keywords は「メンズ」「エステ」等の壊れた断片を含む。
全行の dmm_keywords を NULL に戻すことで、GET /api/v1/movies/{slug} の
write-on-read 補完が新ロジックで再抽出・再保存する。

upgrade  : movies.dmm_keywords を一括で NULL にする (単純な UPDATE)。
downgrade: 旧値は復元できないため no-op (可逆・無害)。
"""
from typing import Sequence, Union

from alembic import op


revision: str = "e2a4c6b8d031"
down_revision: Union[str, None] = "d1f3b5a7c920"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 既存の抽出済みキーワードを破棄し、write-on-read で再抽出させる。
    op.execute("UPDATE movies SET dmm_keywords = NULL")


def downgrade() -> None:
    # 破棄した旧キーワードは復元不能。ダウングレードは何もしない (無害)。
    pass
