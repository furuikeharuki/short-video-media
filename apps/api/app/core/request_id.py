"""X-Request-Id ASGI ミドルウェア。

各リクエストに `X-Request-Id` を関連付けてレスポンスヘッダにそのまま返す。
クライアント (Next.js / curl 等) が既に `X-Request-Id` を送っていればそれを
採用し、なければ新しい UUID4 を生成する。

ログ相関のための最小実装。構造化ロガーや Sentry スコープへの注入は
別途行う (現状未配線)。既存挙動への影響:
  - レスポンスヘッダが 1 つ増えるだけ (CORS allow_headers にも追加 = expose_headers)。
  - ASGI スコープ `request.state.request_id` に保持し、ハンドラから参照可能。
  - 例外時もヘッダが返るよう、Send をラップする方式で実装している。
"""
from __future__ import annotations

import uuid
from typing import Awaitable, Callable

from starlette.types import ASGIApp, Message, Receive, Scope, Send


REQUEST_ID_HEADER = "x-request-id"
REQUEST_ID_STATE_KEY = "request_id"


def _is_valid_request_id(value: str) -> bool:
    """信頼境界。任意の文字列を受け入れるとログ injection リスクがあるので、
    印字可能な ASCII で長さ 1..128 のものに限定する。
    """
    if not value or len(value) > 128:
        return False
    return all(0x20 <= ord(c) < 0x7F for c in value)


class RequestIdMiddleware:
    """X-Request-Id を ASGI スコープに伝搬し、レスポンスヘッダに echo する。"""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(
        self, scope: Scope, receive: Receive, send: Send
    ) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        # 入力ヘッダから既存 ID を拾う
        request_id: str | None = None
        for k, v in scope.get("headers", []):
            if k == REQUEST_ID_HEADER.encode("latin-1"):
                try:
                    candidate = v.decode("latin-1")
                except UnicodeDecodeError:
                    candidate = ""
                if _is_valid_request_id(candidate):
                    request_id = candidate
                break
        if request_id is None:
            request_id = uuid.uuid4().hex

        # ハンドラから request.state 経由でアクセスできるようにする
        state = scope.setdefault("state", {})
        state[REQUEST_ID_STATE_KEY] = request_id

        encoded_name = REQUEST_ID_HEADER.encode("latin-1")
        encoded_value = request_id.encode("latin-1")

        async def send_with_request_id(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                # 既存ヘッダがあれば差し替えない (uvicorn 等が付けるケースに敬意)
                if not any(name == encoded_name for name, _ in headers):
                    headers.append((encoded_name, encoded_value))
                    message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_with_request_id)
