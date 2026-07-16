FROM python:3.12-slim

WORKDIR /app

COPY pyproject.toml .
RUN pip install --no-cache-dir -e .

COPY . .

# alembic.ini が /app 直下にある状態で uvicorn を起動する。
# マイグレーションは lifespan では行わず、デプロイ時に scripts/deploy-xserver.sh が
# `docker compose run --rm api alembic upgrade head` (この CMD を上書き) で実行する。
CMD uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}
