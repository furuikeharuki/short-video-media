"""テスト共通セットアップ。

DB に実接続しないため、SQLAlchemy が URL パースだけ通せるダミー DSN を
APP_ENV=development 前提で渡す。テスト本体は services を monkeypatch して
DB アクセスを完全にバイパスする。
"""
from __future__ import annotations

import os

# config.Settings を import する前に環境変数を投入
os.environ.setdefault("APP_ENV", "development")
os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/test_db",
)
