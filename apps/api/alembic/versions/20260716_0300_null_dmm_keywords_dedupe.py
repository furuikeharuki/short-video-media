"""null out movies.dmm_keywords again to force re-extraction (substring dedupe)

Revision ID: f3b5d7c9e142
Revises: e2a4c6b8d031
Create Date: 2026-07-16 03:00:00.000000+00:00

部分文字列の重複除去 (「くらし」⊂「くらしな」等を統合・除外) に対応した新しい
キーワード抽出ロジックを既存レコードにも反映させるためのデータマイグレーション。

旧ロジックで保存済みの dmm_keywords は「くらし」「くらしな」のような部分文字列の
重複を含む。全行の dmm_keywords を NULL に戻すことで、GET /api/v1/movies/{slug} の
write-on-read 補完が新ロジックで再抽出・再保存する (e2a4c6b8d031 と同じパターン)。

upgrade  : movies.dmm_keywords を一括で NULL にする (単純な UPDATE)。
downgrade: 旧値は復元できないため no-op (可逆・無害)。
"""
from typing import Sequence, Union

from alembic import op


revision: str = "f3b5d7c9e142"
down_revision: Union[str, None] = "e2a4c6b8d031"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 既存の抽出済みキーワードを破棄し、write-on-read で再抽出させる。
    op.execute("UPDATE movies SET dmm_keywords = NULL")


def downgrade() -> None:
    # 破棄した旧キーワードは復元不能。ダウングレードは何もしない (無害)。
    pass
