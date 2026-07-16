FROM python:3.12-slim

WORKDIR /app

COPY pyproject.toml .
RUN pip install --no-cache-dir -e .

COPY . .

# alembic.ini が /app 直下にある状態で uvicorn を起動する。
# マイグレーションは lifespan ではなくデプロイスクリプト
# (scripts/deploy-xserver.sh の `run --rm api alembic upgrade head`) が
# コンテナ置換前に実行する。この CMD (uvicorn) は `run` 時に上書きされる。
CMD uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}
