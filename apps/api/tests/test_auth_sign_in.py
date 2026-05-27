"""POST /api/v1/auth/sign-in のテスト。

- 正常系: 新規 Identity 作成 -> 新規 User 作成 -> User JWT を返す
- 既存 Identity ヒット: 既存 User の last_seen_at を更新して JWT を返す
- 異常系: 不正な exchange_token / purpose 不一致 / 期限切れ
- 競合系: IntegrityError (並行 sign-in で UNIQUE 衝突) を再 SELECT で吸収する
- レートリミット: 同一 IP からの sign-in 連打で 429

実 DB に接続せず、`get_db` を fake session に差し替える。
"""
from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from typing import Any, Iterator

import jwt
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import IntegrityError

from app.api.v1.endpoints import auth as auth_endpoint
from app.core.config import settings
from app.core.rate_limit import (
    SlidingWindowRateLimiter,
    get_signin_rate_limiter,
)
from app.core.security import JWT_ALGORITHM, compute_sub_hash
from app.db.models.user import Identity, User
from app.db.session import get_db
from app.main import app


SIGNIN_AUD = auth_endpoint.SIGNIN_AUDIENCE


def _make_exchange_token(
    *,
    provider: str = "twitter",
    sub: str = "tw-user-1",
    purpose: str = "signin",
    expired: bool = False,
    bad_aud: bool = False,
) -> str:
    now = datetime.now(timezone.utc)
    if expired:
        iat = now - timedelta(minutes=10)
        exp = now - timedelta(minutes=9)
    else:
        iat = now
        exp = now + timedelta(seconds=60)
    payload = {
        "purpose": purpose,
        "provider": provider,
        "sub": sub,
        "iat": int(iat.timestamp()),
        "exp": int(exp.timestamp()),
        "aud": "bad-aud" if bad_aud else SIGNIN_AUD,
    }
    return jwt.encode(payload, settings.AUTH_SECRET, algorithm=JWT_ALGORITHM)


class _FakeResult:
    def __init__(self, obj: Any) -> None:
        self._obj = obj

    def scalar_one_or_none(self):
        return self._obj

    def scalar_one(self):
        if self._obj is None:
            raise RuntimeError("scalar_one with None")
        return self._obj


class _FakeAuthSession:
    """sign-in が呼ぶ最小限のクエリだけ模擬する。

    保持する状態:
      identities[(provider, sub_hash)] -> Identity
      users[user_id] -> User
    """

    def __init__(self) -> None:
        self.identities: dict[tuple[str, str], Identity] = {}
        self.users: dict[str, User] = {}
        self.commits = 0
        self.rollbacks = 0
        # IntegrityError を 1 回だけ flush 時に投げるためのスイッチ
        self.raise_integrity_once = False
        # raise_integrity_once 時、再 SELECT のために事前に登録しておく Identity
        self.preload_identity: Identity | None = None

    async def execute(self, stmt: Any):
        compiled = stmt.compile(compile_kwargs={"literal_binds": True})
        sql = str(compiled).lower()
        if "from identities" in sql:
            # provider と sub_hash で SELECT する想定
            import re

            m_p = re.search(r"identities\.provider\s*=\s*'([^']+)'", sql)
            m_s = re.search(r"identities\.sub_hash\s*=\s*'([^']+)'", sql)
            if m_p and m_s:
                key = (m_p.group(1), m_s.group(1))
                return _FakeResult(self.identities.get(key))
            return _FakeResult(None)
        if "from users" in sql:
            import re

            m_u = re.search(r"users\.id\s*=\s*'([^']+)'", sql)
            if m_u:
                return _FakeResult(self.users.get(m_u.group(1)))
            return _FakeResult(None)
        return _FakeResult(None)

    def add(self, obj: Any) -> None:
        # ORM の default が flush 時に効かないので、id が未割当なら付与する
        if isinstance(obj, User):
            if not getattr(obj, "id", None):
                import uuid

                obj.id = str(uuid.uuid4())
            obj.last_seen_at = datetime.now(timezone.utc).replace(tzinfo=None)
            self._pending_user = obj  # flush で id を確定させる代わりに保持
            self.users[obj.id] = obj
        elif isinstance(obj, Identity):
            if not getattr(obj, "id", None):
                import uuid

                obj.id = str(uuid.uuid4())
            self.identities[(obj.provider, obj.sub_hash)] = obj

    async def flush(self) -> None:
        if self.raise_integrity_once:
            self.raise_integrity_once = False
            # 並行 sign-in で他リクエストが先に Identity を作ったケースを模擬:
            # 再 SELECT で見つけられるように、事前準備した identity を仕込む
            if self.preload_identity is not None:
                self.identities[
                    (
                        self.preload_identity.provider,
                        self.preload_identity.sub_hash,
                    )
                ] = self.preload_identity
                self.users[self.preload_identity.user_id] = User(
                    id=self.preload_identity.user_id
                )
            raise IntegrityError("INSERT", {}, Exception("dup"))

    async def commit(self) -> None:
        self.commits += 1

    async def rollback(self) -> None:
        self.rollbacks += 1


@pytest.fixture(autouse=True)
def _reset_signin_limiter() -> Iterator[None]:
    # 各テストの前後で sign-in リミッタの状態をクリアする
    limiter = get_signin_rate_limiter()
    limiter._reset_for_tests()
    yield
    limiter._reset_for_tests()


@pytest.fixture
def fake_db() -> _FakeAuthSession:
    return _FakeAuthSession()


@pytest.fixture
def client(fake_db: _FakeAuthSession) -> Iterator[TestClient]:
    async def _fake_get_db():
        yield fake_db

    app.dependency_overrides[get_db] = _fake_get_db
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.pop(get_db, None)


def test_sign_in_creates_new_user(client: TestClient, fake_db: _FakeAuthSession) -> None:
    token = _make_exchange_token(provider="twitter", sub="tw-user-new")
    res = client.post("/api/v1/auth/sign-in", json={"exchange_token": token})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["user_id"]
    assert isinstance(body["token"], str) and body["token"]
    # 新規 User が作られている
    assert body["user_id"] in fake_db.users
    # Identity も作られている
    sub_hash = compute_sub_hash("twitter", "tw-user-new")
    assert ("twitter", sub_hash) in fake_db.identities


def test_sign_in_returns_existing_user(
    client: TestClient, fake_db: _FakeAuthSession
) -> None:
    # 事前に Identity と User を登録
    sub_hash = compute_sub_hash("twitter", "tw-existing")
    user = User(id="user-existing")
    fake_db.users[user.id] = user
    fake_db.identities[("twitter", sub_hash)] = Identity(
        id="id-1", user_id=user.id, provider="twitter", sub_hash=sub_hash
    )
    token = _make_exchange_token(provider="twitter", sub="tw-existing")
    res = client.post("/api/v1/auth/sign-in", json={"exchange_token": token})
    assert res.status_code == 200
    assert res.json()["user_id"] == "user-existing"


def test_sign_in_expired_token_returns_401(client: TestClient) -> None:
    token = _make_exchange_token(expired=True)
    res = client.post("/api/v1/auth/sign-in", json={"exchange_token": token})
    assert res.status_code == 401
    assert "expired" in res.json()["detail"].lower()


def test_sign_in_invalid_audience_returns_401(client: TestClient) -> None:
    token = _make_exchange_token(bad_aud=True)
    res = client.post("/api/v1/auth/sign-in", json={"exchange_token": token})
    assert res.status_code == 401


def test_sign_in_invalid_purpose_returns_401(client: TestClient) -> None:
    token = _make_exchange_token(purpose="not-signin")
    res = client.post("/api/v1/auth/sign-in", json={"exchange_token": token})
    assert res.status_code == 401


def test_sign_in_unknown_provider_returns_400(client: TestClient) -> None:
    token = _make_exchange_token(provider="github", sub="x")
    res = client.post("/api/v1/auth/sign-in", json={"exchange_token": token})
    assert res.status_code == 400


def test_sign_in_race_integrity_error_falls_back_to_select(
    client: TestClient, fake_db: _FakeAuthSession
) -> None:
    """並行 sign-in で UNIQUE 衝突した場合、再 SELECT で既存 User を拾う。"""
    # 衝突対象を仕込む
    sub_hash = compute_sub_hash("twitter", "tw-race")
    preload = Identity(
        id="id-race",
        user_id="user-race",
        provider="twitter",
        sub_hash=sub_hash,
    )
    fake_db.preload_identity = preload
    fake_db.raise_integrity_once = True

    token = _make_exchange_token(provider="twitter", sub="tw-race")
    res = client.post("/api/v1/auth/sign-in", json={"exchange_token": token})
    assert res.status_code == 200, res.text
    assert res.json()["user_id"] == "user-race"
    assert fake_db.rollbacks >= 1


def test_sign_in_rate_limit_enforced(
    client: TestClient, fake_db: _FakeAuthSession
) -> None:
    """同一 IP から短時間に大量 POST すると 429 を返す。"""
    # 既存 User を 1 件用意して、毎回 DB 操作を成功させる
    sub_hash = compute_sub_hash("twitter", "tw-r1")
    user = User(id="u-r1")
    fake_db.users[user.id] = user
    fake_db.identities[("twitter", sub_hash)] = Identity(
        id="id-r1", user_id=user.id, provider="twitter", sub_hash=sub_hash
    )
    token = _make_exchange_token(provider="twitter", sub="tw-r1")

    limiter = get_signin_rate_limiter()
    # SIGNIN_RATE_LIMIT_PER_MINUTE を超えるまで連打する
    per_minute = limiter._per_minute  # type: ignore[attr-defined]
    seen_429 = False
    for _ in range(per_minute + 5):
        res = client.post(
            "/api/v1/auth/sign-in", json={"exchange_token": token}
        )
        if res.status_code == 429:
            seen_429 = True
            break
    assert seen_429, "expected at least one 429 from sign-in rate limit"


def test_sign_in_rate_limit_isolated_from_events(
    client: TestClient, fake_db: _FakeAuthSession
) -> None:
    """sign-in リミッタは events 用とは独立しているはず (名前空間分離)。"""
    from app.core.rate_limit import get_event_rate_limiter

    assert get_signin_rate_limiter() is not get_event_rate_limiter()
