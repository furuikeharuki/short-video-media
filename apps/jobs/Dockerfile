FROM python:3.12-slim

WORKDIR /app

# モデルを共有するため apps/api と apps/jobs の両方をコピー
COPY apps/api /app/apps/api
COPY apps/jobs /app/apps/jobs

RUN pip install --upgrade pip \
 && pip install -e /app/apps/api \
 && pip install -e /app/apps/jobs

WORKDIR /app/apps/jobs

# デフォルトでは sync_catalog を 1 回実行する
CMD ["python", "-m", "src.sync_catalog"]
