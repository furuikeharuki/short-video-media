FROM python:3.12-slim

WORKDIR /app

COPY pyproject.toml .
RUN pip install --no-cache-dir -e .

COPY . .

# alembic.ini が /app 直下にある状態で uvicorn を起動
# lifespan で alembic upgrade head が自動実行される
CMD uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}
