# short-video-media 現状把握レポート (2026-05-19)

調査対象: 当リポジトリ `main` ブランチ HEAD (作業ツリー clean 時点)。本書は公開可能な粒度に整理した現状サマリです。運用上の詳細値 (IPアドレス、シークレット、課金実績、特定エンドポイントの脆弱点) は含めません。

---

## 要約

- TikTok 風縦スクロール UI を持つ **FANZA アフィリエイトメディア** のモノレポ。要件定義 v5.8 までドキュメントが更新されており、実装との同期率は高い。
- 4 つのアプリ (`apps/web` Next.js 15 / `apps/api` FastAPI / `apps/jobs` Python 定期処理 / `apps/resolver` Playwright で MP4 URL を抽出する別ホストサービス) と `packages/shared` で構成。
- Phase 1〜2 (FANZA 審査通過 / カタログ同期 / 認証・マイページ / ホーム / ランキング / 動的 MP4 解決) は稼働中。Phase 3 (推薦・ABテスト・SEO・PWA・可視化) は未着手。
- 主要パイプライン (`apps/api` テスト 73、`apps/jobs` 24、`apps/resolver` 14、`apps/web` typecheck + `next build`) はすべてローカルで通過。健全。
- 主要な運用課題: ① resolver サービスの単一ホスト依存と通信経路の改善余地、② シークレット管理のローテーションポリシー整備、③ マイグレーション実行経路に関するコードコメントと運用ドキュメントの食い違い、④ R18 メディアとしてのコンプライアンス運用継続。

---

## プロジェクトの目的と現状

### 目的
- TikTok 風縦スクロール UI で FANZA (DMM) のサンプル動画を再生し、購入リンク経由でアフィリエイト収益を得るメディアサービス (R18)。
- `README.md` 冒頭、`docs/requirements_definition_v5_8.md` がプロジェクトの正本。
- FANZA 審査 (R18 メディア用) は Phase 1 で通過済み。

### 現状 (`docs/roadmap.md` および `docs/requirements_definition_v5_8.md` §2.1 より)
- **Phase 1 完了**: FANZA 審査通過、カタログ同期、MP4 抽出ジョブ。
- **Phase 2 完了**: Auth.js + マイページ (ブックマーク・履歴)、女優詳細、ホーム集約、ランキング、保存済みフィルター。
- **Phase 3 進行中**: 計測ダッシュボード / 推薦 / SEO / PWA / A/B / Redis — いずれも未着手または検討中。
- **Phase 4 Stage A 完了**: `apps/resolver` を国内 VPS 上に常駐させ、動的 MP4 URL を解決。Stage B (クラウド冗長化) は未着手。
- 直近の PR (#83〜#102) はほぼフィード動画再生体験の磨き込み (黒画面回避、prefetch デバウンス、サムネのチラつき除去、自動再生バグ修正) に集中。

---

## 技術スタックと構成

### モノレポ構成
```
short-video-media/
├─ apps/
│  ├─ web/        Next.js 15.3 + React 18 + Auth.js v5 + jose  (Vercel)
│  ├─ api/        FastAPI + SQLAlchemy 2.x async + asyncpg + PyJWT  (Railway)
│  ├─ jobs/       Python 3.12 + httpx + APScheduler  (Railway worker)
│  └─ resolver/   FastAPI + Playwright Chromium  (国内 VPS)
├─ packages/shared/   TS 型 + JSON Schema 共有 (DB スキーマと未同期。v5.8 §2.3 で 🟡 中)
├─ infra/docker/      ローカル開発用 docker-compose (db + api + jobs プロファイル)
├─ docs/              要件定義 v4.0〜v5.8, architecture, db-schema, api-contract, environments, roadmap
└─ scripts/           db_update.sh
```

### 主要ファイル件数 (抜粋)
| 領域 | ファイル例 | 規模 |
|------|-----------|------|
| FastAPI router | `apps/api/app/api/v1/endpoints/*` 11 ファイル | 200〜352 行 (`me.py` が最大) |
| FastAPI service | `apps/api/app/services/*` 5 ファイル | `resolver_client.py` 253 行ほか |
| Alembic versions | `apps/api/alembic/versions/*` 13 ファイル | init から user_search_prefs まで |
| Next.js コンポーネント | `apps/web/components/*` + `feed,home,movie-detail,auth,analytics` 配下 | `FeedClient.tsx` 578, `AdvancedSearchPanel.tsx` 813, `GlobalFilterButton.tsx` 442 など |
| jobs スクリプト | `apps/jobs/src/*` | `sync_catalog.py`, `resolve_sample_urls.py`, `scheduler.py`, `extract_mp4_urls.py`, `sync_actress_profiles.py`, `debug_extract.py` |
| resolver | `apps/resolver/src/*` | `main.py`, `resolver.py`, `browser_pool.py`, `config.py` |

### 言語・ランタイム
- Node 20 (web CI), Python 3.12 (api/jobs/resolver)。
- web: `npm` ワークスペース (`package.json` の `workspaces: ["apps/*"]`)。`pnpm-workspace.yaml` も併存しているが、README は `pnpm install`、CI と実態は `npm ci`。
- DB: PostgreSQL 16 (`infra/docker/docker-compose.yml`)、本番は Railway Postgres。`asyncpg` ドライバ。

### CI / デプロイ
- `.github/workflows/` に 4 本: `api-ci.yml`, `jobs-ci.yml`, `web-ci.yml`, `debug-dmm-api.yml`。
- 旧 `migrate.yml` / `sync-catalog*.yml` / `resolve-sample-urls.yml` は削除済 (`apps/jobs/RAILWAY_WORKER_DEPLOY.md` §5)。マイグレーションは「API lifespan で自動実行する」運用に変更されたと運用ドキュメントにあるが、コード上 (`apps/api/app/main.py:11-19`) の lifespan コメントは旧運用方針のままになっており、ドキュメントとコードコメントが食い違っている。
- 定期ジョブは GitHub Actions cron から Railway 内常駐 worker (`apps/jobs/src/scheduler.py` + `Dockerfile.worker`) へ移行済み。Railway Private Network 経由で DB へ接続して egress 課金を抑える構成。

---

## 主要な処理フロー

### 1. カタログ同期 (`apps/jobs/src/sync_catalog.py`)
- DMM Webservice ItemList API を呼び、`movies / genres / actresses / series / goods / actress_goods` を upsert。
- 対象フロア: FANZA digital videoa (単体女優物), videoc (アマチュア), mono goods (グッズ)。`sort=date` で配信日降順。
- レートリミット 1 req/sec、UPSERT は `content_id` 一意。
- 既存カラム空のときだけ補完して上書きしない (女優プロフィールを壊さない設計)。
- スケジュール: 2 時間ごと (`scheduler.py` の `CronTrigger(hour="8,10,12,14,16,18,20", minute=0, timezone=JST)`)。
- ブートストラップ機能あり: `SCHEDULER_BOOTSTRAP=true` で広い期間 / videoa,videoc を一括取得 → resolve → actress → goods の一連を実行。

### 2. MP4 URL 動的解決 (`apps/resolver` + `apps/api/app/services/resolver_client.py`)
- `apps/api` 側 `GET /api/v1/movies/{slug}/resolve-mp4` がフロントから呼ばれる (`apps/api/app/api/v1/endpoints/movies.py:46`)。
- DB の `movies.sample_movie_url` をキャッシュとして使い、空 / `force=true` のとき `apps/resolver` (`/resolve`) を Bearer 認証付きで HTTP 呼び出し。
- resolver は Playwright で FANZA のサンプル再生ページを開き、`<video>` の src またはネットワーク上の `*.mp4` を捕捉して返す (`apps/resolver/src/resolver.py:62`)。
- `resolver_client.py` は in-flight デデュープ (`_inflight` + asyncio.Lock) と 60s 短期成功キャッシュ (`_success_cache`) を持つ。
- 失敗時マッピング: 404 / 502 / 504 / 401 / その他 5xx → `ResolverNotFound/UpstreamError/Timeout/Unavailable` → エンドポイントで HTTP 透過。
- `DELETE /api/v1/movies/{slug}/sample-url` で web 側からの自己治癒 (再生失敗時に DB を NULL に戻す)。

### 3. フィード配信
- `GET /api/v1/feed` (`apps/api/app/api/v1/endpoints/feed.py`) が cursor (offset/limit) + advanced 検索パラメータ (`q`, `genres`, `actresses`, `series_list`, `directors`, `makers`, `labels`, `ng_words`, `date_from/to`, `sort`) を受ける。
- `apps/api/app/services/feed_service.py`:
  - advanced 経路: `_get_advanced_shuffled_ids` で `search_repository.get_advanced_movie_ids` を呼び、`sort` 未指定なら seed で shuffle、指定ありなら ORDER BY をそのまま使う。
  - 通常経路: `get_movies_paginated` または `_get_shuffled_ids` (seed あり)。
  - Redis があれば `feed:shuffle:*` (TTL 1h) と `movies:data:*` (TTL 30min) にキャッシュ。Redis 無しでも動作。
- `apps/web/components/FeedViewer.tsx`: 中央 1 枚 (`WINDOW_SIZE=1`) のみ `<video>` をマウントし、前後は `PrefetchVideoBuffer` (画面外 100×100 / opacity 0) で先読み。`usePrefetchResolveMp4` と `usePrefetchVideoBytes` が 400ms デバウンスで `currentIndex+1..+3` の resolve / バイト先読みを行う。

### 4. 認証 (Auth.js v5 + FastAPI exchange JWT)
- web (`apps/web/auth.ts`): Twitter / Discord OAuth → provider+sub を 60 秒有効の exchange JWT に詰めて `POST /api/v1/auth/sign-in` へ送信 → 30 日 JWT (`apiToken`) を受け取り `session.apiToken` に格納。provider 側の name/email/picture は token / session のいずれからも削除。
- api (`apps/api/app/api/v1/endpoints/auth.py`): exchange JWT を検証 → `compute_sub_hash(provider, sub) = SHA-256(provider:sub:APP_USER_SALT)` で hash → `Identity` を get_or_create → 30 日 JWT 発行。`Identity.sub_hash` 以外の PII は DB に持たない設計 (`docs/db-schema.md` §認証)。
- フロントから API のユーザー固有エンドポイントへは `apps/web/app/api/proxy/me/[...path]/route.ts` がプロキシして `Authorization: Bearer` を付与し、`apiToken` をブラウザに露出させない。

### 5. 計測イベント
- `POST /api/v1/events` (`apps/api/app/api/v1/endpoints/events.py`): IP ベースのレートリミット (`EVENTS_RATE_LIMIT_PER_SECOND=10 / PER_MINUTE=120`)、event_type ホワイトリスト (`view/play/detail_click/affiliate_click/search`)、search は `search_query` 必須、その他は `slug` 必須。
- `events` テーブル + 複合 index `ix_events_type_created` (`apps/api/app/db/models/event.py:14`)。`apps/api/app/services/ranking_service.py` が view 集計でランキングを生成し、データ不足時は review_count フォールバック。

### 6. マイページ (`/me` endpoints `apps/api/app/api/v1/endpoints/me.py` 352 行)
- ブックマーク (GET/POST/DELETE/`bookmarks/ids`)、視聴履歴 (POST `/views`, GET `/views`)、NG ワード (GET/PUT `/ng-words`)、保存済み検索条件 (GET/PUT `/search-prefs`)。全て `require_user` 依存。

---

## 実装済みのもの

| 領域 | 実装内容 |
|------|---------|
| **FastAPI ルーター** | `health, feed, movies (+resolve-mp4 / sample-url DELETE), search (+suggest), tags, events, rankings, home, auth, me, actresses` 全 11 種 |
| **DB モデル** | `movies, actresses, genres, series, movie_genres, movie_actresses, users, identities, bookmarks, view_histories, events, goods, actress_goods, user_ng_words, user_search_prefs` |
| **Alembic** | 13 リビジョン (init → user_search_prefs)。複合 index `ix_movies_visible_primary_date / ix_movies_visible_review_count` を含む |
| **DMM 同期** | フロア別 sync_catalog (videoa/videoc/goods)、女優プロフィール sync、ブートストラップ全件取得 |
| **MP4 解決** | resolver サービス本体 (Playwright)、in-flight デデュープ + 60s キャッシュ、自己治癒 DELETE エンドポイント、resolve_sample_urls.py バックフィルジョブ |
| **認証** | Twitter/Discord OAuth、exchange JWT、`Identity.sub_hash`、`/auth/sign-in` |
| **web ページ** | `/`, `/feed`, `/movies/[slug]` (+ パラレルモーダル `@modal/(.)movies/[slug]`), `/search`, `/search/feed`, `/list/[key]`, `/actresses/[name]`, `/mypage`, `/age-gate`, `/auth/error`, `/contact`, `/privacy`, `/law`, `/robots.ts`, `/sitemap.ts` |
| **共通 UI** | Header, BottomNav, HamburgerMenu, GlobalFilterButton + AdvancedSearchPanel, SavedFilterContext/Enforcer, BackButton 系 |
| **フィード再生最適化** | WINDOW_SIZE=1, prefetch hooks 2 本, 400ms デバウンス, 25s ハードタイムアウト, force リトライ最大 3 回 + 指数バックオフ, サムネ poster オーバーレイ, MediaError reset |
| **CI** | api / jobs / web の 3 本 + DMM API デバッグ |
| **年齢確認** | `middleware.ts` で `age_verified` cookie が無い全リクエストを `/age-gate` にリダイレクト |

---

## 未完成 / 改善余地

### v5.8 §2.3 に挙げられている未実装 (優先度: 🟢 低)
- `apps/jobs/src/generate_related.py` (関連作品レコメンド) — ファイル自体が無い。
- `apps/jobs/src/rebuild_cache.py` (Redis 再構築) — Redis 未導入。
- `apps/jobs/src/recompute_rankings.py` (ランキングのバッチ化) — 現状は API 都度算出。
- `apps/jobs/src/backfill_slugs.py` — 旧データ slug 再生成、未作成。
- `packages/shared/*` JSON Schema / TS 型が DB と未同期 (🟡 中)。
- `apps/web/Dockerfile` 未作成 (Vercel 完結のため放置)。
- 死活監視 (`/health` への定期 ping) 未着手 (🟡 中)。

### ドキュメントとコードの食い違い
- `apps/api/app/main.py:11-19` の lifespan コメントは旧マイグレーション運用 (GitHub Actions) を前提とした記述だが、運用ドキュメント (`apps/jobs/RAILWAY_WORKER_DEPLOY.md` §5) は別経路での自動実行を前提としている。実態 (Railway 側の Dockerfile / ENTRYPOINT) との整合確認が必要。
- `Makefile` の `fetch` ターゲットが `docker compose --profile jobs run jobs python -m src.sync_catalog` を期待するが、`docker-compose.yml` の `jobs` サービスの default command は print のみで、scheduler 化された運用と乖離している。

### 設定・運用
- resolver サービスが単一ホスト構成のため、可用性向上 (HTTPS 化を含む通信経路の整備、冗長化、もしくはマネージドサービス併用) が望ましい。
- シークレット類 (`RESOLVER_API_KEY` 等) のローテーション運用ルール・記録の整備が望ましい。要件定義 v5.8 §2.3 でも 🟡 中課題として残っている。
- `apps/api/app/core/config.py:37` の `ALLOWED_ORIGINS` デフォルトはローカル開発向け (`http://localhost:3000,http://localhost:3001`)。本番は環境変数で必ず上書きする運用。`_validate_production_settings` は `DATABASE_URL` の localhost / 弱いデフォルトを弾くが、`ALLOWED_ORIGINS` 自体の検査はない。

### コード上の小さなリスク
- `resolver_client._inflight` / `_success_cache` はプロセスローカルの dict + asyncio.Lock。API を多インスタンス化すると重複呼び出しが起きうる前提のコード。スケールアウト時に効果が消える点に留意。
- `feed_service._get_shuffled_ids` は全 movie_id を Redis に JSON で持つ。Redis 未導入時は毎回 SELECT。movies 数が増えると重くなる。
- 一部の負荷誘発につながりうる操作 (例: 視聴履歴記録、サンプル URL の無効化など) に対するレートリミット適用が不足している箇所がある。匿名連打で resolver / DB を消耗させない対策を追加するのが望ましい。
- `apps/web/middleware.ts` の `age-gate` cookie 名は `age_verified=true`。クライアント side で改変可能な自己申告ベース。R18 サイトとしての十分性は法的観点で継続確認。

### テスト
- `docs/roadmap.md` 末尾「単体テストカバレッジ 60% 達成 (現状: smoke のみ)」「e2e (Playwright) シナリオ整備」が未着手とされているが、実態は `apps/api/tests/` 73 件、`apps/jobs/tests/` 24 件、`apps/resolver/tests/` 14 件と、smoke のみという表現は過小評価。
- 一方で DB を立てた結合テストは無い (`api-ci.yml` は `services.postgres` を起動していない)。ここは継続課題。

---

## 実行・検証結果

ローカル (Linux, Python 3.12.8, Node 20.20.1) で破壊的操作なし・外部送信なしの範囲で確認。

### 静的解析
- `apps/api/app` / `apps/api/tests` / `apps/jobs/src` / `apps/jobs/tests` / `apps/resolver/src` / `apps/resolver/tests` / `apps/api/scripts` の全 `.py` を `ast.parse` で構文検証 → 全てパース可。

### Python テスト
| 対象 | コマンド | 結果 |
|------|----------|------|
| apps/api | `APP_ENV=development DATABASE_URL=postgresql+asyncpg://test:test@localhost:5432/test python -m pytest -v` (`apps/api` 下) | **73 passed in 1.50s** |
| apps/jobs | `DATABASE_URL=postgresql+asyncpg://test:test@localhost:5432/test python -m pytest -v` (`apps/jobs` 下) | **24 passed in 0.45s** |
| apps/resolver | `python -m pytest -v` (`apps/resolver` 下) | **14 passed in 0.43s** |

依存インストールは `pip install -e ".[dev]"` (api / resolver) / `pip install -e .` (jobs)。Playwright Chromium は resolver テストでモックされているので未インストールでも通る。

### Web typecheck + build
| コマンド | 結果 |
|----------|------|
| `npm ci` (リポジトリルート) | 成功 |
| `npm run typecheck -w apps/web` | **PASS** (tsc --noEmit がエラーなし) |
| `NEXT_PUBLIC_API_BASE_URL=https://example.com NEXT_PUBLIC_SITE_URL=https://example.com AUTH_SECRET=<dummy> npm run build -w apps/web` | **PASS** (16 ページ生成、Dynamic/Static 区分確認) |

ビルド出力では `/, /(.)movies/[slug], /actresses/[name], /age-gate, /api/*, /list/[key], /movies/[slug], /search` などが Dynamic、`/auth/error, /contact, /feed, /law, /mypage, /privacy, /robots.txt, /search/feed, /sitemap.xml` が Static。Middleware バンドル 34.3 kB。

### 起動・本番接続検証は実施せず
- DB / Redis / DMM API / resolver への接続検証は副作用・課金が発生するためスキップ。
- 環境変数群 (`AUTH_SECRET`, `APP_USER_SALT`, `DMM_API_ID`, `DMM_AFFILIATE_ID`, `DMM_LINK_AFFILIATE_ID`, `RESOLVER_BASE_URL`, `RESOLVER_API_KEY`, `AUTH_TWITTER_ID/SECRET`, `AUTH_DISCORD_ID/SECRET`, `DATABASE_URL`, `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_GA_ID`) のリストと役割は `.env.example` / `apps/resolver/.env.example` / `infra/docker/.env.example` / `apps/jobs/RAILWAY_WORKER_DEPLOY.md` §2 に整理済み。

---

## 運用上の改善項目 (高レベル)

1. **resolver サービスの可用性と通信経路の改善**
   - 単一ホスト依存と HTTP 経路を脱却し、HTTPS 化 + 必要に応じた冗長化または代替経路 (マネージド) を整備する。
   - 通信経路の構成変更に合わせて、関連ドキュメント側の手順・URL も併せて更新する。
2. **シークレット管理ポリシーの整備**
   - `RESOLVER_API_KEY` をはじめとする運用シークレットのローテーション周期と手順をドキュメント化し、定期的に実施。
   - 設定値そのものをドキュメント本文に書き込まない運用に統一する。
3. **マイグレーション運用の単一情報源化**
   - `apps/api/app/main.py` の lifespan コメントを実態に合わせて修正し、`apps/api/Dockerfile` / Railway 側 ENTRYPOINT との整合を確認する。
4. **匿名で叩ける高コスト操作のレートリミット適用**
   - 既存 `EventRateLimiter` を流用し、resolver / DB を消耗させうる操作 (サンプル URL 無効化、視聴履歴記録など) に上限を設定する。
5. **死活監視 (`/health`) の常設**
   - 1 分間隔程度の外形監視を立て、resolver / api / web の状態を継続的に観察する。
6. **観測性 (Sentry / メトリクス / ログ) の導入**
   - エラー追跡 (Sentry) と最低限のメトリクス可視化を Phase 3 の最初のステップとして着手。
7. **`packages/shared` の実用化**
   - Pydantic v2 モデルから JSON Schema を生成し、`apps/web/lib/api` の手書き型と整合させる。
8. **ランキングの事前計算化 (`recompute_rankings.py`)**
   - 月間ランキング等は events SELECT の都度実行ではなくバッチ計算に移行。
9. **`Makefile` / `docker-compose.yml` の実態合わせ**
   - Railway worker 中心の運用に合わせて整理する。
10. **e2e テスト (Playwright) の整備**
    - 直近の PR (#83〜#102) がフィード再生まわりに集中しており、リグレッションが起きやすい領域。スワイプ + 自動再生 + サムネ表示のゴールデンパスを最低 1 本固める。

### 推奨着手順 (実装再開なら)
1. マイグレーション実行経路の実態確認とコード/ドキュメントの一致化
2. シークレット運用ポリシー整備 (ローテーション含む)
3. resolver の通信経路改善 (HTTPS 化、必要なら冗長化)
4. 高コスト操作へのレートリミット追加
5. `/health` の死活監視
6. Sentry 導入
7. `packages/shared` 実用化、観測ダッシュボード、ランキングバッチ化の順
