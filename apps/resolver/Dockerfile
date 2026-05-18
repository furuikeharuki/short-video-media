# ============================================================================
# apps/resolver/Dockerfile
# ----------------------------------------------------------------------------
# DMM litevideo iframe から MP4 直リンクを抽出する FastAPI サービス。
#
# ベースイメージ:
#   mcr.microsoft.com/playwright/python:v1.45.0-jammy
#   - Chromium / Firefox / WebKit と Linux 依存ライブラリがプリインストール済み
#   - apt-get でフォント・X 関連ライブラリを並べる必要がなく Dockerfile が短い
#   - イメージサイズは ~2GB だが、Browser 起動の信頼性を優先
#
# ビルド例:
#   docker build -t shortvideo/resolver -f apps/resolver/Dockerfile apps/resolver
#
# 実行例 (ローカル):
#   docker run --rm -p 8080:8080 \
#     -e RESOLVER_API_KEY=devkey \
#     -e DMM_AFFILIATE_ID=xxxx-001 \
#     shortvideo/resolver
#
# 実行例 (Xserver VPS):
#   docker compose up -d  (Caddy + resolver のリバプロ構成)
# ============================================================================
# ベースイメージのバージョンは pyproject.toml の playwright と必ず一致させること。
# 不一致だと "BrowserType.launch: Executable doesn't exist" でクラッシュする。
FROM mcr.microsoft.com/playwright/python:v1.60.0-jammy

WORKDIR /app

# 依存だけ先にインストール (キャッシュ効かせ用)
COPY pyproject.toml /app/pyproject.toml
COPY src /app/src

RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -e .

# Playwright Chromium はベースイメージにインストール済み
# (mcr.microsoft.com/playwright が npx playwright install を済ませている)

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8080

EXPOSE 8080

# 起動: uvicorn 単一ワーカー (Browser を 1 つだけ起動するため複数ワーカー不可)
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
