FROM python:3.12-slim

WORKDIR /app

# Playwright (Chromium) を動かすためのシステム依存ライブラリ
# `playwright install-deps` が apt-get に依存するため build-essential 等は要らないが、
# Chromium が必要とする共有ライブラリは明示しておく (slim だと不足するため)
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        fonts-liberation \
        fonts-noto-cjk \
        libasound2 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libatspi2.0-0 \
        libcairo2 \
        libcups2 \
        libdbus-1-3 \
        libdrm2 \
        libgbm1 \
        libglib2.0-0 \
        libgtk-3-0 \
        libnspr4 \
        libnss3 \
        libpango-1.0-0 \
        libx11-6 \
        libxcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxext6 \
        libxfixes3 \
        libxkbcommon0 \
        libxrandr2 \
        wget \
        xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# モデルを共有するため apps/api と apps/jobs の両方をコピー
COPY apps/api /app/apps/api
COPY apps/jobs /app/apps/jobs

# Playwright を追加でインストール (jobs の依存とは別に明示)
RUN pip install --upgrade pip \
 && pip install -e /app/apps/api \
 && pip install -e /app/apps/jobs \
 && pip install "playwright>=1.45"

# Chromium 本体をダウンロード (システム依存は上で apt 経由でインストール済み)
RUN python -m playwright install chromium

WORKDIR /app/apps/jobs

# Custom Start Command や railway run から `python -m src.xxx` を実行しても
# モジュールを見つけられるよう PYTHONPATH を明示
# (Railway は Dockerfile の WORKDIR を Custom Start Command に引き継がないことがあるため)
ENV PYTHONPATH=/app/apps/jobs

# デフォルトでは sync_catalog を 1 回実行する
# MP4 URL 抽出ジョブを動かす場合は CMD を上書きして実行する:
#   railway run --service jobs python -m src.extract_mp4_urls --cid 1sun00052a --dry-run
CMD ["python", "-m", "src.sync_catalog"]
