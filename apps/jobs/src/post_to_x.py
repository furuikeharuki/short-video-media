"""X (旧 Twitter) 自アカウントへの定期投稿ボット (流入施策)。

GitHub Actions の cron / workflow_dispatch から実行する想定。
公開 API からサイト内の人気・新着コンテンツを取得し、女優ページ・ジャンルページ・
作品ページへの誘導ポストを 1 回の実行で 1 件だけ投稿する。

安全設計 (重要):
  - 投稿するのは自アカウントへの通常ポストのみ。リプライ / メンション / DM /
    フォロー等、他人に作用する操作は一切実装しない (x_client は POST /2/tweets だけ)。
  - 本文に `@` を入れない (post_templates.sanitize_* で無害化)。
  - 投稿 URL は canonical な https://av-shorts.com/... のみ。
  - 同じ文面・同じ URL の連投を避けるため、日付+スロットで決定的にローテーション。
  - X の認証情報 (Secrets) が未設定なら投稿せず dry-run にフォールバックする。
    DRY_RUN=true でも投稿せず本文だけ出力する (デフォルト安全側)。

環境変数:
  必須 (本番投稿時のみ。未設定なら自動 dry-run):
    X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_TOKEN_SECRET
  任意:
    X_BOT_API_BASE_URL : 公開 API のベース URL (デフォルト https://av-shorts-api.com)
    X_BOT_DRY_RUN      : 1/true で投稿せず本文だけ出力 (CLI --dry-run と OR)
    X_BOT_SLOT         : その日の投稿スロット番号 (種別/文面ローテーション用、デフォルト 0)

使い方:
  cd apps/jobs
  python -m src.post_to_x --dry-run            # 投稿せず本文だけ表示
  python -m src.post_to_x                       # Secrets が揃っていれば実投稿
  python -m src.post_to_x --slot 1 --dry-run    # スロット 1 の候補を確認
"""
from __future__ import annotations

import argparse
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import httpx

# apps/jobs/src を import パスに追加 (`python -m src.post_to_x` でも直接実行でも動くように)
_HERE = Path(__file__).resolve()
sys.path.insert(0, str(_HERE.parents[1]))

from src import scheduled_config as cfg  # noqa: E402
from src.post_candidates import (  # noqa: E402
    build_candidates,
    fetch_home,
    pick_candidate,
)
from src.post_templates import render_post  # noqa: E402
from src.x_client import XCredentials, post_tweet  # noqa: E402

DEFAULT_API_BASE_URL = "https://av-shorts-api.com"


def _jst_today() -> date:
    """JST の「今日」を返す。

    cron は UTC で動くが、種別/文面ローテーションは日本のユーザー向け運用に
    合わせて JST 基準の日付で回す。
    """
    # zoneinfo を使わず固定 +9h オフセットで十分 (JST は DST がない)
    now_utc = datetime.now(timezone.utc)
    return (now_utc + timedelta(hours=9)).date()


def _resolve_cli_args(argv: list[str] | None = None) -> dict:
    """CLI 引数と環境変数から実行パラメータを解決する。優先順位は CLI > env > default。"""
    parser = argparse.ArgumentParser(description="AV Shorts X 自動投稿ボット")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="投稿せず本文だけ出力 (env X_BOT_DRY_RUN=1 でも有効)",
    )
    parser.add_argument(
        "--slot",
        type=int,
        default=None,
        help="その日の投稿スロット番号 (種別/文面ローテーション用、未指定なら env X_BOT_SLOT → 0)",
    )
    parser.add_argument(
        "--api-base-url",
        type=str,
        default=None,
        help=f"公開 API のベース URL (未指定なら env X_BOT_API_BASE_URL → {DEFAULT_API_BASE_URL})",
    )
    args = parser.parse_args(argv)

    try:
        dry_run = bool(args.dry_run) or cfg.env_bool("X_BOT_DRY_RUN", default=False)
        slot = args.slot
        if slot is None:
            slot = cfg.env_int("X_BOT_SLOT", minimum=0)
        if slot is None:
            slot = 0
        api_base_url = (
            args.api_base_url
            or cfg.env_str("X_BOT_API_BASE_URL")
            or DEFAULT_API_BASE_URL
        )
    except cfg.EnvConfigError as e:
        raise SystemExit(f"[post_to_x] 設定エラー: {e}") from e

    return dict(dry_run=dry_run, slot=slot, api_base_url=api_base_url)


def run(*, dry_run: bool, slot: int, api_base_url: str) -> int:
    """1 件投稿を試みる。戻り値はプロセス終了コード。"""
    today = _jst_today()
    creds = XCredentials.from_env()

    # Secrets 未設定なら強制 dry-run。明確にログで知らせる (静かな失敗を避ける)。
    effective_dry_run = dry_run
    if creds is None and not dry_run:
        print(
            "[post_to_x] X の認証情報 (X_API_KEY / X_API_SECRET / "
            "X_ACCESS_TOKEN / X_ACCESS_TOKEN_SECRET) が揃っていないため "
            "dry-run に切り替えます。"
        )
        effective_dry_run = True

    print(
        f"[post_to_x] start: date={today} slot={slot} dry_run={effective_dry_run} "
        f"api_base_url={api_base_url} creds={'set' if creds else 'unset'}"
    )

    try:
        with httpx.Client(timeout=20) as client:
            home = fetch_home(api_base_url, client=client)
    except httpx.HTTPError as e:
        print(f"[post_to_x] /home の取得に失敗しました: {e}")
        return 1

    candidates = build_candidates(home)
    counts = {k: len(v) for k, v in candidates.items()}
    print(f"[post_to_x] candidates: {counts}")

    candidate = pick_candidate(candidates, today, slot)
    if candidate is None:
        print("[post_to_x] 投稿候補が見つかりませんでした (API の home が空?)。skip します。")
        return 0

    text = render_post(candidate, today, slot)
    print("[post_to_x] ----- 投稿本文 -----")
    print(text)
    print(f"[post_to_x] -------------------- ({len(text)} 文字, kind={candidate.kind})")

    if effective_dry_run:
        print("[post_to_x] dry-run のため実際の投稿は行いません。")
        return 0

    assert creds is not None  # effective_dry_run の分岐で保証済み
    result = post_tweet(creds, text)
    if result.ok:
        print(f"[post_to_x] 投稿成功: tweet_id={result.tweet_id}")
        return 0
    print(
        f"[post_to_x] 投稿失敗: status={result.status_code} error={result.error}"
    )
    return 1


def main(argv: list[str] | None = None) -> int:
    return run(**_resolve_cli_args(argv))


if __name__ == "__main__":
    raise SystemExit(main())
