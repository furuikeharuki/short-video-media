"""女優プロフィールにダミーデータを投入するスクリプト。

DMM 女優検索 API の API_ID / AFFILIATE_ID が未取得のあいだ、
画面開発用にデータベースに入っているすべての女優にランダムなプロフィールを設定する。

使い方:
  cd apps/api
  python scripts/seed_actress_profiles.py

注意:
  - 既存の Actress 行のプロフィールカラムだけを更新する。
  - DMM 公式 API を叩いたとき (sync_actress_profiles.py) はこのスクリプトの値が上書きされる。
"""
import asyncio
import random
from datetime import date

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import settings
from app.db.models.actress import Actress


def _get_async_url(url: str) -> str:
    if url.startswith("postgresql://"):
        return url.replace("postgresql://", "postgresql+asyncpg://", 1)
    return url


PREFECTURES = [
    "東京都", "神奈川県", "千葉県", "埼玉県", "大阪府", "京都府", "兵庫県",
    "愛知県", "福岡県", "北海道", "宮城県", "広島県", "静岡県", "沖縄県",
]
BLOOD_TYPES = ["A", "B", "O", "AB"]
HOBBIES = [
    "読書", "映画鑑賞", "音楽鑑賞", "ダンス", "料理", "カフェ巡り",
    "旅行", "ヨガ", "写真撮影", "ファッション", "ゲーム", "アニメ鑑賞",
]
CUPS = ["B", "C", "D", "E", "F", "G", "H", "I", "J"]


def _dummy_profile(seed_value: int) -> dict:
    """女優 ID をシードに決定的なダミー値を返す。実行のたびに変わらないように。"""
    rng = random.Random(seed_value)

    cup = rng.choice(CUPS)
    # カップに応じてバストを大まかに割り当て
    cup_to_bust = {"B": 82, "C": 85, "D": 88, "E": 90, "F": 93, "G": 96, "H": 99, "I": 102, "J": 105}
    bust = cup_to_bust[cup] + rng.randint(-2, 3)
    waist = rng.randint(56, 62)
    hip   = rng.randint(82, 92)
    height = rng.randint(150, 172)

    year  = rng.randint(1988, 2003)
    month = rng.randint(1, 12)
    day   = rng.randint(1, 28)

    return {
        "bust":         bust,
        "cup":          cup,
        "waist":        waist,
        "hip":          hip,
        "height":       height,
        "birthday":     date(year, month, day),
        "blood_type":   rng.choice(BLOOD_TYPES),
        "hobby":        "、".join(rng.sample(HOBBIES, 2)),
        "prefectures":  rng.choice(PREFECTURES),
    }


async def main() -> None:
    url = _get_async_url(settings.DATABASE_URL)
    engine = create_async_engine(url)
    Session = async_sessionmaker(engine, expire_on_commit=False)

    async with Session() as session:  # type: AsyncSession
        result = await session.execute(select(Actress))
        actresses = list(result.scalars().all())
        print(f"対象女優数: {len(actresses)}")

        updated = 0
        for a in actresses:
            # 既にプロフィールが入っている女優はスキップ (本番同期データを尊重)
            if a.bust is not None or a.height is not None:
                continue

            profile = _dummy_profile(a.id)
            a.bust         = profile["bust"]
            a.cup          = profile["cup"]
            a.waist        = profile["waist"]
            a.hip          = profile["hip"]
            a.height       = profile["height"]
            a.birthday     = profile["birthday"]
            a.blood_type   = profile["blood_type"]
            a.hobby        = profile["hobby"]
            a.prefectures  = profile["prefectures"]
            # 画像は thumbnail_url を流用 (DMM の場合は image_url_small / large が独立して存在する)
            if a.thumbnail_url and not a.image_url_small:
                a.image_url_small = a.thumbnail_url
            if a.thumbnail_url and not a.image_url_large:
                a.image_url_large = a.thumbnail_url
            updated += 1

        await session.commit()
        print(f"プロフィール更新: {updated} 名")

    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
