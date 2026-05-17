"""DMM (FANZA) ActressSearch API から DB に存在する女優のプロフィールを取得・更新するバッチ。

DB に存在する女優についてだけ ActressSearch API を叩く (1 件ずつ actress_id 指定)。
新しい女優は ItemList 経由でしか作らないので、ここでは原則 INSERT は行わず UPDATE のみ。

実行頻度: 月 1 程度。ActressSearch API のレスポンスはほぼ静的 (生年月日や出身地は不変、
スリーサイズは滅多に更新されない) なので頻繁に呼ぶ意味がない。

仕様メモ:
  - https://affiliate.dmm.com/api/v3/actresssearch.html
  - 1 回の API 呼び出しで最大 100 件 (今回は actress_id 指定で 1 件ずつ取得する)
  - レート制限に配慮して 1 秒に 1 リクエストまで
  - DB の Actress.content_id が DMM 側の actress id に対応する
  - content_id が無い (= ItemList 経由で id が来なかった) 女優は keyword=name で探す
    フォールバックを試す

環境変数:
  - DMM_API_ID
  - DMM_AFFILIATE_ID        : API 呼び出し用 ID (末尾 -990〜-999)
  - DMM_LINK_AFFILIATE_ID   : listURL の af_id 用 (購入ページ紐付け用)
  - DATABASE_URL

使い方:
  cd apps/jobs
  python -m src.sync_actress_profiles                 # DB の全女優を更新
  python -m src.sync_actress_profiles --limit 50      # 先頭 50 件だけ更新
  python -m src.sync_actress_profiles --only-missing  # ruby が空の女優だけ更新 (差分実行)
  python -m src.sync_actress_profiles --dry-run       # DB に書き込まずログだけ
"""
from __future__ import annotations

import argparse
import asyncio
import os
import re
import sys
import time
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any

import httpx
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

# apps/api を import パスに追加 (モデルを共有するため)
_REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(_REPO_ROOT / "apps" / "api"))

from app.db.models.actress import Actress  # noqa: E402


DMM_ENDPOINT = "https://api.dmm.com/affiliate/v3/ActressSearch"
RATE_LIMIT_SLEEP_SEC = 1.0


def _get_async_url(url: str) -> str:
    if url.startswith("postgresql://"):
        return url.replace("postgresql://", "postgresql+asyncpg://", 1)
    return url


def _parse_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def _parse_birthday(value: Any) -> date | None:
    if not value:
        return None
    s = str(value).strip().split(" ")[0]
    for fmt in ("%Y-%m-%d", "%Y/%m/%d"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def _swap_af_id(url: str | None, link_affiliate_id: str) -> str | None:
    """listURL.digital に含まれる affiliate ID を購入ページ用の af_id に差し替える。

    DMM API は API 呼び出し用 ID (末尾 -990〜-999) で URL を返してくるので、
    末尾を購入ページ紐付け用 ID (例: -001) に置換する。
    """
    if not url:
        return None
    # URL 中の "affiliate=xxxxxx-990" などを置換
    return re.sub(r"affiliate=[A-Za-z0-9_-]+", f"affiliate={link_affiliate_id}", url)


@dataclass
class UpdateCounters:
    updated: int = 0
    not_found: int = 0
    unchanged: int = 0
    errors: int = 0


async def fetch_actress(
    client: httpx.AsyncClient,
    *,
    api_id: str,
    affiliate_id: str,
    actress_id: str | None = None,
    keyword: str | None = None,
) -> dict | None:
    """ActressSearch API を叩いて 1 件目の actress dict を返す (見つからなければ None)。"""
    params: dict[str, Any] = {
        "api_id": api_id,
        "affiliate_id": affiliate_id,
        "hits": 1,
        "offset": 1,
        "output": "json",
    }
    if actress_id:
        params["actress_id"] = actress_id
    elif keyword:
        params["keyword"] = keyword
    else:
        return None

    res = await client.get(DMM_ENDPOINT, params=params, timeout=20)
    if res.status_code >= 400:
        body_snippet = res.text[:400]
        raise httpx.HTTPStatusError(
            f"HTTP {res.status_code} from DMM ActressSearch: {body_snippet}",
            request=res.request,
            response=res,
        )
    data = res.json()
    result = data.get("result") or {}
    status = result.get("status")
    if status and status != 200:
        msg = result.get("message") or result.get("errors") or data
        raise RuntimeError(f"DMM ActressSearch status={status}: {msg}")
    actresses = result.get("actress") or []
    if not actresses:
        return None
    # keyword 検索の場合は完全一致を優先する
    if keyword:
        for a in actresses:
            if a.get("name") == keyword:
                return a
    return actresses[0]


def _apply_profile(actress: Actress, data: dict, link_affiliate_id: str) -> bool:
    """DMM API レスポンスを Actress に適用する。変更があれば True を返す。

    既存値を保護: API が None / 空文字を返したフィールドは上書きしない。
    """
    changed = False

    def _set_if_better(field: str, new_value: Any) -> None:
        nonlocal changed
        if new_value in (None, ""):
            return
        if getattr(actress, field) != new_value:
            setattr(actress, field, new_value)
            changed = True

    api_id = data.get("id")
    if api_id is not None and not actress.content_id:
        actress.content_id = str(api_id)
        changed = True

    _set_if_better("ruby", data.get("ruby"))
    _set_if_better("bust", _parse_int(data.get("bust")))
    _set_if_better("cup", data.get("cup"))
    _set_if_better("waist", _parse_int(data.get("waist")))
    _set_if_better("hip", _parse_int(data.get("hip")))
    _set_if_better("height", _parse_int(data.get("height")))
    _set_if_better("birthday", _parse_birthday(data.get("birthday")))
    _set_if_better("blood_type", data.get("blood_type"))
    _set_if_better("hobby", data.get("hobby"))
    _set_if_better("prefectures", data.get("prefectures"))

    image = data.get("imageURL") or {}
    _set_if_better("image_url_small", image.get("small"))
    _set_if_better("image_url_large", image.get("large"))
    # thumbnail_url が無ければ image_url_small で補完
    if not actress.thumbnail_url and image.get("small"):
        actress.thumbnail_url = image.get("small")
        changed = True

    list_url = data.get("listURL") or {}
    digital_url = _swap_af_id(list_url.get("digital"), link_affiliate_id)
    _set_if_better("dmm_list_url", digital_url)

    return changed


async def update_actress(
    session: AsyncSession,
    client: httpx.AsyncClient,
    actress: Actress,
    *,
    api_id: str,
    api_affiliate_id: str,
    link_affiliate_id: str,
    dry_run: bool,
    counters: UpdateCounters,
) -> None:
    """1 件の女優について ActressSearch API を叩いて更新する。"""
    # content_id を優先キー、無ければ name で keyword 検索
    data: dict | None = None
    if actress.content_id:
        data = await fetch_actress(
            client,
            api_id=api_id,
            affiliate_id=api_affiliate_id,
            actress_id=actress.content_id,
        )
    if data is None and actress.name:
        data = await fetch_actress(
            client,
            api_id=api_id,
            affiliate_id=api_affiliate_id,
            keyword=actress.name,
        )

    if data is None:
        counters.not_found += 1
        print(f"  [not_found] {actress.name} (id={actress.id}, cid={actress.content_id})")
        return

    changed = _apply_profile(actress, data, link_affiliate_id)
    if changed:
        if not dry_run:
            await session.commit()
        counters.updated += 1
        print(f"  [updated] {actress.name} (id={actress.id})")
    else:
        counters.unchanged += 1


async def main(
    *,
    limit: int | None,
    only_missing: bool,
    dry_run: bool,
) -> None:
    api_id = os.getenv("DMM_API_ID")
    api_affiliate_id = os.getenv("DMM_AFFILIATE_ID")
    if not api_id or not api_affiliate_id:
        raise SystemExit("DMM_API_ID / DMM_AFFILIATE_ID が設定されていません")
    link_affiliate_id = os.getenv("DMM_LINK_AFFILIATE_ID") or api_affiliate_id

    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        raise SystemExit("DATABASE_URL が設定されていません")

    engine = create_async_engine(_get_async_url(db_url))
    Session = async_sessionmaker(engine, expire_on_commit=False)

    counters = UpdateCounters()

    print(
        f"[sync_actress_profiles] start: limit={limit} only_missing={only_missing} "
        f"dry_run={dry_run}"
    )

    async with httpx.AsyncClient() as client:
        async with Session() as session:
            stmt = select(Actress).order_by(Actress.id)
            if only_missing:
                # ruby / birthday / image_url_large のどれも無い女優を対象
                stmt = stmt.where(
                    or_(
                        Actress.ruby.is_(None),
                        Actress.birthday.is_(None),
                        Actress.image_url_large.is_(None),
                    )
                )
            if limit is not None:
                stmt = stmt.limit(limit)
            actresses = (await session.execute(stmt)).scalars().all()
            total = len(actresses)
            print(f"[sync_actress_profiles] {total} actresses to process")

            for i, actress in enumerate(actresses, 1):
                try:
                    await update_actress(
                        session,
                        client,
                        actress,
                        api_id=api_id,
                        api_affiliate_id=api_affiliate_id,
                        link_affiliate_id=link_affiliate_id,
                        dry_run=dry_run,
                        counters=counters,
                    )
                except Exception as e:  # noqa: BLE001
                    print(f"  [ERROR] {actress.name} (id={actress.id}): {e}")
                    counters.errors += 1
                    try:
                        await session.rollback()
                    except Exception:  # noqa: BLE001
                        pass

                # レート制限
                if i < total:
                    time.sleep(RATE_LIMIT_SLEEP_SEC)

    await engine.dispose()
    print(
        f"[sync_actress_profiles] done: updated={counters.updated} "
        f"unchanged={counters.unchanged} not_found={counters.not_found} "
        f"errors={counters.errors}"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--limit", type=int, default=None,
        help="処理する女優の最大件数 (デフォルト: 全件)",
    )
    parser.add_argument(
        "--only-missing", action="store_true",
        help="ruby / birthday / image_url_large のいずれかが空の女優だけを対象にする",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="DB に書き込まずにログだけ表示",
    )
    args = parser.parse_args()

    asyncio.run(main(
        limit=args.limit,
        only_missing=args.only_missing,
        dry_run=args.dry_run,
    ))
