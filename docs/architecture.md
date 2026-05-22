# アーキテクチャ概要

> **正本**: 詳細は [`requirements_definition_v5_0.md`](./requirements_definition_v5_0.md) を参照。
> このドキュメントは構成図と責務分担のサマリ。

## 全体構成

```
┌──────────────────────┐         ┌──────────────────────────────┐
│  apps/web (Next.js)  │  HTTPS  │ Xserver VPS (Tokyo)          │
│  Vercel              │ ──────▶ │  ┌────────────────────────┐  │
│  - SSR + ISR         │         │  │ api (apps/api)         │  │
│  - Auth.js v5        │         │  │ - REST /api/v1/*       │  │
│  - parallel routes   │         │  │ - PyJWT / SQLAlchemy   │  │
└──────────┬───────────┘         │  └─────────┬──────────────┘  │
           │                     │            │ HTTP            │
           │                     │            ▼                 │
           │                     │  ┌────────────────────────┐  │
           │                     │  │ resolver               │  │
           │                     │  │ (apps/api/app.resolver)│  │
           │                     │  │ Playwright + Chromium  │  │
           │                     │  └────────────────────────┘  │
           │                     │                              │
           │                     │  ┌────────────────────────┐  │
           │                     │  │ jobs-worker (apps/jobs)│  │
           │                     │  │ APScheduler 常駐       │  │
           │                     │  └─────────┬──────────────┘  │
           │                     │            │                 │
           │                     │  ┌─────────▼──────────────┐  │
           │                     │  │ db (Postgres 18)       │  │
           │                     │  └────────────────────────┘  │
           │                     └──────────────────────────────┘
           │
           └─ DMM / FANZA API (jobs-worker / resolver から outbound)
```

## モジュール責務

| モジュール | 責務 | デプロイ先 |
|-----------|------|-----------|
| `apps/web` | UI / SSR / Auth.js / 縦スクロール再生 / モーダル詳細 | Vercel |
| `apps/api` | REST API / DB アクセス / 計測イベント受付 / JWT 発行 | Xserver VPS (旧 Railway) |
| `apps/api` (`app.resolver`) | DMM litevideo iframe → MP4 URL 抽出 (Playwright) | Xserver VPS の resolver サービスとして起動 |
| `apps/jobs` | DMM API 取得 / DB upsert / sample URL 解決ジョブ | Xserver VPS の jobs-worker (旧 GitHub Actions cron) |
| `packages/shared` | TS 型・JSON Schema 共有 | (内部) |

### resolver の位置づけ

以前は `apps/resolver` として独立した FastAPI サービス (Xserver VPS Tokyo)
だったが、Xserver VPS への移行で `apps/api` 自身も日本リージョンで動く
ようになったため、コードを `apps/api/app/resolver/` に統合済み。

通常 API コンテナ (slim Python image, ~150MB) と resolver サービス
(`apps/api/Dockerfile.resolver`, Playwright base ~2GB) は **同じ
`apps/api` パッケージを共有しつつ別イメージで動く**。これにより:

- API メインの応答性 / 起動時間に Playwright/Chromium の影響が出ない
- resolver のロジックを 2 箇所で保守する必要がない
- `apps/api/app/services/resolver_client.py` (HTTP クライアント) → `app.resolver.main` への呼び出し境界はそのまま (HTTP 経由)
- compose 内では同 docker network 経由 (`http://resolver:8080`) で通信

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
