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

import pytest


@pytest.fixture(autouse=True)
def _reset_resolver_client_state() -> None:
    """テスト間で resolver_client の in-flight / 短期キャッシュをクリアする。

    同じ content_id を複数テストで使うと、前のテストのキャッシュが残っていて
    MockTransport の handler が呼ばれない事故を防ぐ。
    """
    from app.services import resolver_client

    resolver_client._reset_state_for_tests()
    yield
    resolver_client._reset_state_for_tests()
