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
│  - parallel routes   │         │  │ - in-process MP4 抽出  │  │
│                      │         │  │   (httpx → DMM)        │  │
└──────────┬───────────┘         │  └─────────┬──────────────┘  │
           │                     │            │                 │
           │                     │  ┌─────────▼──────────────┐  │
           │                     │  │ db (Postgres 18)       │  │
           │                     │  │ 127.0.0.1:5432 (bind)  │  │
           │                     │  └────────────────────────┘  │
           │                     └────────────▲─────────────────┘
           │                                  │ SSH
           │                     ┌────────────┴─────────────────┐
           │                     │ GitHub Actions (apps/jobs)   │
           │                     │  - jobs-sync-catalog (3x/d)  │
           │                     │  - jobs-sync-actress (1x/d)  │
           │                     │  - jobs-bootstrap (dispatch) │
           │                     │  → SSH で VPS 上 docker      │
           │                     │    compose run --rm jobs ... │
           │                     │  → bootstrap は Actions      │
           │                     │    runner で SSH トンネル     │
           │                     │    経由 (matrix 年並列)      │
           │                     └──────────────────────────────┘
           │
           └─ DMM / FANZA API (api / Actions runner / VPS jobs から outbound)
```

## モジュール責務

| モジュール | 責務 | デプロイ先 |
|-----------|------|-----------|
| `apps/web` | UI / SSR / Auth.js / 縦スクロール再生 / モーダル詳細 | Vercel |
| `apps/api` | REST API / DB アクセス / 計測イベント受付 / JWT 発行 / DMM MP4 URL 抽出 | Xserver VPS (旧 Railway) |
| `apps/api` (`app.resolver`) | DMM html5_player ページ → MP4 URL 抽出 (httpx, in-process) | apps/api と同じプロセスで動作 |
| `apps/jobs` | DMM API 取得 / DB upsert / sample URL 解決ジョブ | GitHub Actions cron + Xserver VPS 上で docker compose run --rm jobs (ハイブリッド構成) |
| `packages/shared` | TS 型・JSON Schema 共有 | (内部) |

### MP4 URL 抽出の位置づけ

以前は `apps/resolver` として Playwright + Chromium を載せた独立 FastAPI
サービスを Xserver VPS Tokyo で動かしていたが、DMM の html5_player
ページが `var args = {...}` の形で MP4 URL を直接埋めて返してくれることが
判明したため、ピュア httpx で apps/api 内で in-process 解決する方式に
切り替えた。Playwright / Chromium / 別コンテナはすべて不要。

- 通常 API コンテナ (slim Python image, ~150MB) だけで完結する
- `apps/api/app/resolver/extractor.py` が抽出ロジック本体
- `apps/api/app/services/resolver_client.py` が in-flight デデュープ + 短期成功キャッシュ
- jobs のバックフィルジョブ (`resolve_sample_urls.py`) も同じ extractor を再利用

## データフロー

1. **カタログ同期**: `sync_catalog.py` が 2 時間おきに DMM ItemList API を呼び、`movies / genres / actresses / series` を upsert
2. **MP4 抽出**: `extract_mp4_urls.py` が Playwright で `litevideo iframe` を開き、`/litevideo/freepv/...mp4` または `/pv/<token>/...mp4` を抽出して `Movie.sample_movie_url` に保存
3. **配信**: web → api → DB の標準フロー。`/api/v1/feed` は cursor ベースの無限スクロール、`/api/v1/home` はトップ画面集約
4. **計測**: ユーザー操作は web の `trackEvent()` 経由で GA4 と `/api/v1/events`(DB) の二系統に送信
5. **認証**: Auth.js (Twitter/Discord) → provider sub を ハッシュ化 → 60 秒有効の exchange JWT を `/auth/sign-in` で 30 日 JWT に交換

## 主要技術選定

- **Next.js 15.3 / React 18**: parallel routes による TikTok 風遷移
- **FastAPI + SQLAlchemy 2.x async + asyncpg**: 縦スクロールフィードの低レイテンシ実現
- **httpx**: DMM html5_player ページの `var args = {...}` から MP4 URL を直接抽出 (Playwright 不要)
- **Auth.js v5 + PyJWT**: フロント／バックの認証境界を JWT で分離、provider PII を DB に持たない

## 環境

開発・ステージング・本番の差分は [`environments.md`](./environments.md) を参照。
