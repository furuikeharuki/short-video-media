"""X (旧 Twitter) API v2 への投稿クライアント。

自アカウントへの通常ポスト (`POST /2/tweets`) だけを行う最小実装。
リプライ / メンション / DM / フォロー等、他人に作用する API は一切呼ばない。

認証は OAuth 1.0a User Context (api key / api secret / access token /
access token secret の 4 点) を使う。外部 OAuth ライブラリには依存せず、
標準ライブラリ (hmac / hashlib / base64 / urllib) だけで署名を組み立てる。

環境変数 (GitHub Secrets 経由で渡す想定):
  - X_API_KEY               : API Key (Consumer Key)
  - X_API_SECRET            : API Key Secret (Consumer Secret)
  - X_ACCESS_TOKEN          : Access Token (アプリを自アカウントに紐付けて発行)
  - X_ACCESS_TOKEN_SECRET   : Access Token Secret

4 つのうち 1 つでも欠けていれば「未設定」とみなし、呼び出し側で dry-run /
skip に倒す (本番投稿は 4 点すべて揃ったときだけ)。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import time
import urllib.parse
from dataclasses import dataclass

import httpx

X_TWEETS_ENDPOINT = "https://api.twitter.com/2/tweets"

# X のポスト本文上限 (通常アカウント)。これを超えると 403 になるため事前に弾く。
MAX_TWEET_LENGTH = 280


class XCredentialsError(RuntimeError):
    """OAuth1.0a の認証情報が不足している。"""


@dataclass(frozen=True)
class XCredentials:
    api_key: str
    api_secret: str
    access_token: str
    access_token_secret: str

    @classmethod
    def from_env(cls) -> "XCredentials | None":
        """環境変数から認証情報を読む。1 つでも欠けていれば None を返す。"""
        api_key = (os.getenv("X_API_KEY") or "").strip()
        api_secret = (os.getenv("X_API_SECRET") or "").strip()
        access_token = (os.getenv("X_ACCESS_TOKEN") or "").strip()
        access_token_secret = (os.getenv("X_ACCESS_TOKEN_SECRET") or "").strip()
        if not (api_key and api_secret and access_token and access_token_secret):
            return None
        return cls(
            api_key=api_key,
            api_secret=api_secret,
            access_token=access_token,
            access_token_secret=access_token_secret,
        )


def _percent_encode(value: str) -> str:
    """RFC 3986 準拠の percent encode (OAuth 署名で使う)。"""
    return urllib.parse.quote(value, safe="~")


def _build_oauth1_header(
    creds: XCredentials,
    method: str,
    url: str,
    *,
    nonce: str | None = None,
    timestamp: str | None = None,
) -> str:
    """OAuth 1.0a の Authorization ヘッダを組み立てる。

    JSON ボディ (POST /2/tweets) のリクエストでは、署名ベース文字列に含めるのは
    OAuth パラメータのみ (ボディや query string は含めない)。これは X API v2 の
    仕様に従っている。
    """
    oauth_params = {
        "oauth_consumer_key": creds.api_key,
        "oauth_nonce": nonce or secrets.token_hex(16),
        "oauth_signature_method": "HMAC-SHA1",
        "oauth_timestamp": timestamp or str(int(time.time())),
        "oauth_token": creds.access_token,
        "oauth_version": "1.0",
    }

    # 署名ベース文字列: METHOD&percentEncode(url)&percentEncode(sorted params)
    param_string = "&".join(
        f"{_percent_encode(k)}={_percent_encode(v)}"
        for k, v in sorted(oauth_params.items())
    )
    base_string = "&".join(
        [method.upper(), _percent_encode(url), _percent_encode(param_string)]
    )
    signing_key = f"{_percent_encode(creds.api_secret)}&{_percent_encode(creds.access_token_secret)}"
    digest = hmac.new(
        signing_key.encode("utf-8"), base_string.encode("utf-8"), hashlib.sha1
    ).digest()
    signature = base64.b64encode(digest).decode("utf-8")

    header_params = dict(oauth_params)
    header_params["oauth_signature"] = signature
    header = "OAuth " + ", ".join(
        f'{_percent_encode(k)}="{_percent_encode(v)}"'
        for k, v in sorted(header_params.items())
    )
    return header


@dataclass
class PostResult:
    ok: bool
    tweet_id: str | None = None
    status_code: int | None = None
    error: str | None = None


def post_tweet(creds: XCredentials, text: str, *, client: httpx.Client | None = None) -> PostResult:
    """自アカウントに 1 件ポストする。

    リプライ系のフィールド (`reply`, `in_reply_to_tweet_id`) は一切付けないため、
    常に通常投稿になる。
    """
    if len(text) > MAX_TWEET_LENGTH:
        return PostResult(
            ok=False,
            error=f"text too long ({len(text)} > {MAX_TWEET_LENGTH})",
        )

    header = _build_oauth1_header(creds, "POST", X_TWEETS_ENDPOINT)
    headers = {
        "Authorization": header,
        "Content-Type": "application/json",
    }
    payload = {"text": text}

    owns_client = client is None
    http = client or httpx.Client(timeout=20)
    try:
        res = http.post(X_TWEETS_ENDPOINT, headers=headers, json=payload)
    except httpx.HTTPError as e:
        return PostResult(ok=False, error=f"HTTP error: {e}")
    finally:
        if owns_client:
            http.close()

    if res.status_code in (200, 201):
        data = res.json()
        tweet_id = (data.get("data") or {}).get("id")
        return PostResult(ok=True, tweet_id=tweet_id, status_code=res.status_code)
    return PostResult(
        ok=False,
        status_code=res.status_code,
        error=res.text[:400],
    )
