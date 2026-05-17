# short-video-media

TikTok 風縦スクロール UI を持つ FANZA アフィリエイトメディアのモノレポ。

## クイックスタート

```bash
# 1. 環境変数を準備
cp .env.example .env
cp infra/docker/.env.example infra/docker/.env
#   .env を編集して AUTH_SECRET / APP_USER_SALT 等を入れる

# 2. 依存関係インストール
pnpm install

# 3. DB 起動
docker compose -f infra/docker/docker-compose.yml up -d db

# 4. マイグレーション
cd apps/api && alembic upgrade head && cd ../..

# 5. 開発サーバー起動
pnpm --filter @short-video-media/api dev   # http://localhost:8000
pnpm --filter @short-video-media/web dev   # http://localhost:3000
```

## 構成

```
short-video-media/
├── apps/
│   ├── web/      Next.js 15 (Vercel)
│   ├── api/      FastAPI (Railway)
│   └── jobs/     Python / Playwright (GitHub Actions cron)
├── packages/
│   └── shared/   TS 型・JSON Schema 共有
├── infra/
│   └── docker/   docker-compose
└── docs/         設計ドキュメント
```

## ドキュメント

| ファイル | 概要 |
|---------|------|
| [`docs/requirements_definition_v5_0.md`](./docs/requirements_definition_v5_0.md) | 最新版要件定義書 (正本) |
| [`docs/architecture.md`](./docs/architecture.md) | アーキテクチャ概要 |
| [`docs/api-contract.md`](./docs/api-contract.md) | API 契約 |
| [`docs/db-schema.md`](./docs/db-schema.md) | DB スキーマ |
| [`docs/environments.md`](./docs/environments.md) | 環境変数・運用手順 |
| [`docs/roadmap.md`](./docs/roadmap.md) | ロードマップ |

## テスト

```bash
# Python (api + jobs)
python -m pytest apps/api/tests/ apps/jobs/tests/ -v

# Next.js (web)
pnpm --filter web run typecheck
pnpm --filter web run build
```

CI は `.github/workflows/{api,jobs,web}-ci.yml` で自動実行される。

## ライセンス

Private (社内利用のみ)
