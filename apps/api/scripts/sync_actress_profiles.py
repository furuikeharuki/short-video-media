"""DMM 女優検索 API から女優プロフィールを取得して DB に同期するバッチ。

GitHub Actions 等で定期実行する想定。
事前に環境変数を設定:
  - DMM_API_ID
  - DMM_AFFILIATE_ID
  - DATABASE_URL

仕様メモ:
  - https://affiliate.dmm.com/api/v3/actresssearch.html
  - keyword で女優名と完全一致するレコードを 1 件だけ拾う
  - rate limit に配慮して 1 秒に 1 リクエスト程度に絞る
  - DB に存在する女優だけを対象に同期 (DMM 側で見つからない女優はスキップ)

使い方:
  cd apps/api
  python scripts/sync_actress_profiles.py
  python scripts/sync_actress_profiles.py --only "橋本ありな"  # 特定の女優だけ
  python scripts/sync_actress_profiles.py --limit 100         # 最初の N 名だけ
"""
import argparse
import asyncio
import os
import time
from datetime import date, datetime

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import settings
from app.db.models.actress import Actress


DMM_ENDPOINT = "https://api.dmm.com/affiliate/v3/ActressSearch"
RATE_LIMIT_SLEEP_SEC = 1.0


def _get_async_url(url: str) -> str:
    if url.startswith("postgresql://"):
        return url.replace("postgresql://", "postgresql+asyncpg://", 1)
    return url


def _parse_int(value) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _parse_date(value: str | None) -> date | None:
    if not value:
        return None
    for fmt in ("%Y-%m-%d", "%Y/%m/%d"):
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            continue
    return None


async def fetch_actress(client: httpx.AsyncClient, name: str, api_id: str, affiliate_id: str) -> dict | None:
    params = {
        "api_id": api_id,
        "affiliate_id": affiliate_id,
        "keyword": name,
        "hits": 10,
        "output": "json",
    }
    try:
        res = await client.get(DMM_ENDPOINT, params=params, timeout=15)
        res.raise_for_status()
    except httpx.HTTPError as e:
        print(f"[ERROR] {name}: {e}")
        return None

    data = res.json()
    actresses = (data.get("result") or {}).get("actress") or []
    # 完全一致を優先、なければ先頭
    for a in actresses:
        if a.get("name") == name:
            return a
    return actresses[0] if actresses else None


def _apply_dmm_data(actress: Actress, dmm: dict) -> None:
    actress.ruby             = dmm.get("ruby") or actress.ruby
    actress.bust             = _parse_int(dmm.get("bust"))
    actress.cup              = dmm.get("cup") or actress.cup
    actress.waist            = _parse_int(dmm.get("waist"))
    actress.hip              = _parse_int(dmm.get("hip"))
    actress.height           = _parse_int(dmm.get("height"))
    actress.birthday         = _parse_date(dmm.get("birthday")) or actress.birthday
    actress.blood_type       = dmm.get("blood_type") or actress.blood_type
    actress.hobby            = dmm.get("hobby") or actress.hobby
    actress.prefectures      = dmm.get("prefectures") or actress.prefectures

    image_url = dmm.get("imageURL") or {}
    actress.image_url_small  = image_url.get("small") or actress.image_url_small
    actress.image_url_large  = image_url.get("large") or actress.image_url_large

    list_url = dmm.get("listURL") or {}
    actress.dmm_list_url     = list_url.get("digital") or actress.dmm_list_url


async def main(only: str | None, limit: int | None) -> None:
    api_id        = os.getenv("DMM_API_ID")
    affiliate_id  = os.getenv("DMM_AFFILIATE_ID")
    if not api_id or not affiliate_id:
        raise SystemExit("DMM_API_ID / DMM_AFFILIATE_ID が設定されていません")

    url = _get_async_url(settings.DATABASE_URL)
    engine = create_async_engine(url)
    Session = async_sessionmaker(engine, expire_on_commit=False)

    async with Session() as session:  # type: AsyncSession
        stmt = select(Actress).order_by(Actress.id)
        if only:
            stmt = stmt.where(Actress.name == only)
        if limit:
            stmt = stmt.limit(limit)
        result = await session.execute(stmt)
        actresses = list(result.scalars().all())
        print(f"対象女優数: {len(actresses)}")

        async with httpx.AsyncClient() as client:
            updated = 0
            for i, a in enumerate(actresses, start=1):
                dmm = await fetch_actress(client, a.name, api_id, affiliate_id)
                if dmm is None:
                    print(f"  [{i}/{len(actresses)}] {a.name}: not found")
                else:
                    _apply_dmm_data(a, dmm)
                    updated += 1
                    print(f"  [{i}/{len(actresses)}] {a.name}: synced")
                # まとめてコミットすると失敗時のロスが大きいので 50 件単位で
                if i % 50 == 0:
                    await session.commit()
                time.sleep(RATE_LIMIT_SLEEP_SEC)

            await session.commit()
            print(f"同期完了: {updated} / {len(actresses)} 名")

    await engine.dispose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", default=None, help="特定の女優名だけ同期")
    parser.add_argument("--limit", type=int, default=None, help="最大件数")
    args = parser.parse_args()
    asyncio.run(main(args.only, args.limit))
