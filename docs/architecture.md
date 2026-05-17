# アーキテクチャ概要

> **正本**: 詳細は [`requirements_definition_v5_0.md`](./requirements_definition_v5_0.md) を参照。
> このドキュメントは構成図と責務分担のサマリ。

## 全体構成

```
┌──────────────────────┐         ┌──────────────────────┐
│  apps/web (Next.js)  │  HTTPS  │  apps/api (FastAPI)  │
│  Vercel               │ ──────▶ │  Railway              │
│  - SSR + ISR          │         │  - REST /api/v1/*     │
│  - Auth.js v5         │         │  - PyJWT (exchange)   │
│  - parallel routes    │         │  - SQLAlchemy async   │
└──────────┬───────────┘         └──────────┬───────────┘
           │                                 │
           │                                 │
           │           ┌─────────────────────▼──────────┐
           │           │  Railway Postgres (managed)    │
           │           │  - movies / actresses / ...    │
           │           │  - events / bookmarks / ...    │
           │           └────────────────────────────────┘
           │                                 ▲
           │                                 │
           │                    ┌────────────┴─────────────┐
           │                    │  apps/jobs (Python)      │
           └─ DMM /          ◀──┤  GitHub Actions cron     │
              FANZA API         │  - sync_catalog.py       │
                                │  - extract_mp4_urls.py   │
                                │  - Playwright Chromium   │
                                └──────────────────────────┘
```

## モジュール責務

| モジュール | 責務 | デプロイ先 |
|-----------|------|-----------|
| `apps/web` | UI / SSR / Auth.js / 縦スクロール再生 / モーダル詳細 | Vercel |
| `apps/api` | REST API / DB アクセス / 計測イベント受付 / JWT 発行 | Railway |
| `apps/jobs` | DMM API 取得 / MP4 直リンク抽出 / DB upsert | GitHub Actions |
| `packages/shared` | TS 型・JSON Schema 共有 | (内部) |

## データフロー

1. **カタログ同期**: `sync_catalog.py` が 2 時間おきに DMM ItemList API を呼び、`movies / genres / actresses / series` を upsert
2. **MP4 抽出**: `extract_mp4_urls.py` が Playwright で `litevideo iframe` を開き、`/litevideo/freepv/...mp4` または `/pv/<token>/...mp4` を抽出して `Movie.sample_movie_url` に保存
3. **配信**: web → api → DB の標準フロー。`/api/v1/feed` は cursor ベースの無限スクロール、`/api/v1/home` はトップ画面集約
4. **計測**: ユーザー操作は web の `trackEvent()` 経由で GA4 と `/api/v1/events`(DB) の二系統に送信
5. **認証**: Auth.js (Twitter/Discord) → provider sub を ハッシュ化 → 60 秒有効の exchange JWT を `/auth/sign-in` で 30 日 JWT に交換

## 主要技術選定

- **Next.js 15.3 / React 18**: parallel routes による TikTok 風遷移
- **FastAPI + SQLAlchemy 2.x async + asyncpg**: 縦スクロールフィードの低レイテンシ実現
- **Playwright (Chromium)**: 静的 fetch では取れない `litevideo iframe` の MP4 URL を JS 評価で取得
- **Auth.js v5 + PyJWT**: フロント／バックの認証境界を JWT で分離、provider PII を DB に持たない

## 環境

開発・ステージング・本番の差分は [`environments.md`](./environments.md) を参照。
