#!/bin/bash
# === short-video-media DB 更新手順（1回コピペ用） ===
# 事前に書き換える: MIGRATION_MSG（マイグレーション名）

set -e

MIGRATION_MSG="${1:-migration}"

# 1. 最新化
cd ~/HTOK/short-video-media
git pull origin main

# 2. apps/api へ移動 & venv で依存更新
cd apps/api
.venv/bin/pip install -e .

# 3. .env を Railway Public URL で上書き
cat > .env <<'EOF'
DATABASE_URL=postgresql://postgres:ubGNfYWVeQzxFmOJURKyZrPMrjumKOtI@viaduct.proxy.rlwy.net:50723/railway
EOF

# 4. Alembic マイグレーション作成 & 適用（必ず .venv 経由）
.venv/bin/alembic revision --autogenerate -m "$MIGRATION_MSG"
.venv/bin/alembic upgrade head

# 5. seed を入れ直し（既存データを TRUNCATE してから seed）
.venv/bin/python -c "
import asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from app.core.config import settings

def _get_async_url(url: str) -> str:
    if url.startswith('postgresql://'):
        return url.replace('postgresql://', 'postgresql+asyncpg://', 1)
    return url

async def clean():
    engine = create_async_engine(_get_async_url(settings.DATABASE_URL))
    async with engine.begin() as conn:
        await conn.execute(text('TRUNCATE movie_genres, movie_actresses, movies, genres, actresses, series RESTART IDENTITY CASCADE'))
    await engine.dispose()
asyncio.run(clean())
"
.venv/bin/python scripts/seed.py

# 6. コミット & push（Railway 自動デプロイ）
cd ~/HTOK/short-video-media
git add apps/api/alembic/versions apps/api/app
git commit -m "feat: $MIGRATION_MSG" || echo "no changes to commit"
git push origin main

# 7. 反映確認（Railway デプロイ完了後に実行）
echo "Waiting 30s for Railway deploy..."
sleep 30
curl -s https://short-video-media-production.up.railway.app/api/v1/feed \
  | python3 -m json.tool | head -30

echo "Done! Migration: $MIGRATION_MSG"
