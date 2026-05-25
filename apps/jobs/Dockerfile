# ============================================================================
# apps/jobs/Dockerfile (デフォルト、軽量 sync ジョブ用)
# ----------------------------------------------------------------------------
# DMM API を叩いて DB upsert するだけなので Chromium / Playwright は不要。
# 詳細は Dockerfile.sync を参照 (本ファイルは同内容)。
#
# ※ サンプル動画 MP4 URL の DB キャッシュは廃止された (apps/api 内で都度抽出する
#    設計に変更)。そのため Playwright 同梱版 (旧 Dockerfile.playwright) は不要に
#    なり削除済み。常駐の scheduler は Dockerfile.worker を使うこと。
# ============================================================================
FROM python:3.12-slim

WORKDIR /app

# モデルを共有するため apps/api と apps/jobs の両方をコピー
COPY apps/api /app/apps/api
COPY apps/jobs /app/apps/jobs

RUN pip install --upgrade pip \
 && pip install -e /app/apps/api \
 && pip install -e /app/apps/jobs

WORKDIR /app/apps/jobs

# Railway は Dockerfile の WORKDIR を Custom Start Command に引き継がないことが
# あるため PYTHONPATH を明示。
ENV PYTHONPATH=/app/apps/jobs

# デフォルトでは sync_catalog を 1 回実行する
CMD ["python", "-m", "src.sync_catalog"]
