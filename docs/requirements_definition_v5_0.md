# 要件定義書：TikTok風アダルト動画アフィリエイトメディア

**プロジェクト名**: short-video-media
**リポジトリ**: https://github.com/furuikeharuki/short-video-media
**作成日**: 2026-05-17
**バージョン**: 5.0

**v4.0からの主な変更点**:
- **FANZA審査が通過済み**であることを反映（Phase 1 完了）
- `apps/jobs/src/sync_catalog.py` が **42KB の本実装** となり、DMM ItemList API の全件取得・期間スライス・フロア別擬似ジャンル付与・goods フィルタ等まで完成していることを反映
- **新規ジョブ `extract_mp4_urls.py` (15.7KB)** を追加。Playwright (Chromium) で DMM litevideo iframe から MP4 直リンクを抽出する仕組みを記載
- 切り分け用デバッグスクリプト **`debug_extract.py`** を追加
- **GitHub Actions による定期実行を整備済み**：
  - `sync-catalog.yml`（2 時間ごとに増分取得、cron `0 */2 * * *`）
  - `sync-catalog-full.yml`（毎月 1 日 10:00 JST に全件＋ sample URL リフレッシュ）
  - `migrate.yml`（main への push 時に alembic upgrade head）
- **認証基盤を新設**：Auth.js v5 (Twitter / Discord OAuth) ＋ FastAPI 側 `/auth/sign-in` の exchange JWT 方式。provider 個人情報は一切 DB に保存せず、`Identity.sub_hash = SHA-256(provider:sub:APP_USER_SALT)` のみ保持
- **マイページ機能**：ブックマーク・視聴履歴（`/me/*` エンドポイント、`Bookmark` / `ViewHistory` テーブル）
- **女優詳細ページ**：`/api/v1/actresses/{name}` ＋ DMM 女優検索 API 由来のプロフィール 13 列を `actresses` テーブルに追加
- **ホーム画面集約 API**：`/api/v1/home`（本日配信開始・新着・人気・週/月/日ランキング・検索数の高いジャンル 3 セクション）
- **ランキング API**：`/api/v1/rankings?period=daily|weekly|monthly`
- **イベント計測 API 実装済み**：`POST /api/v1/events`（view / play / detail_click / affiliate_click / search）。`search_query` カラム＋インデックスを追加
- **作品詳細モーダル**：Next.js パラレルルート `@modal/(.)movies/[slug]` で TikTok 風遷移を実装
- **検索フィード**：`/search/feed` で検索結果も縦スクロール再生できるように
- **法務ページ実装完了**：`/privacy`・`/law`・`/contact` の本文と運営者情報を整備済み
- 性能改善：並列プローブによる初回再生高速化、サンプル動画 URL の学習キャッシュ、ランキング集計修正、未発売作品の取扱見直しなど多数
- `apps/api/Dockerfile`・`apps/jobs/Dockerfile`（Playwright + Chromium 同梱）整備済み
- マイグレーションは 9 件まで進行（最新: `8a3c1f2e9d04 add actress profile columns`）

---

## 1. プロジェクト概要

### 1.1 目的

FANZA アフィリエイトを収益源とした、TikTok 風縦スクロール UI のアダルト動画メディアサイトを構築する。単なるサイト制作ではなく、**データ取得から公開・運用までを自動化された基盤**として運用することが中期目標である。

最終的には AWS 上で全サービスを運用することを前提とし、各アプリはコンテナで動作する設計とする。

### 1.2 コアバリュー

- スマートフォンに最適化された TikTok 風 UX による高い滞在時間と CVR
- FANZA / DMM API を通じた大量コンテンツの自動取得・自動掲載
- 全アプリのコンテナ化によるクラウド非依存の移植性
- ローカル開発〜本番環境を Docker で統一し、CI/CD と接続しやすい構成

### 1.3 収益モデル

| 収益源 | 概要 |
|--------|------|
| FANZA アフィリエイト | 作品購入・動画視聴への誘導による成果報酬 |
| SSP 広告（AdMax 等） | アクセス増加後の補助収益として追加 |

---

## 2. 現状（2026 年 5 月 17 日時点）

### 2.1 完了したマイルストーン

| 項目 | 状態 |
|------|------|
| **FANZA 審査通過** | ✅ 完了 |
| 独自ドメインでの本番公開 | ✅ 完了（Vercel） |
| `/privacy`・`/law`・`/contact` の本文実装 | ✅ 完了 |
| FANZA API 連携バッチ（`sync_catalog.py`） | ✅ 本実装済み（42KB） |
| MP4 直リンク抽出ジョブ（`extract_mp4_urls.py`） | ✅ 実装済み（15.7KB） |
| Alembic マイグレーション | ✅ 9 件適用済み |
| 定期実行（GitHub Actions cron） | ✅ 増分 2h / 全件 月 1 を稼働中 |
| 認証 (Twitter / Discord OAuth) | ✅ 実装済み |
| マイページ（ブックマーク / 視聴履歴） | ✅ 実装済み |
| 作品詳細ページ＋モーダル | ✅ 実装済み |
| 検索ページ（一覧 / 縦フィード） | ✅ 実装済み |
| 女優詳細ページ | ✅ 実装済み |
| ホーム画面集約 API | ✅ 実装済み |
| イベント計測 API（view / play / detail_click / affiliate_click / search） | ✅ 実装済み |
| ランキング API（日 / 週 / 月） | ✅ 実装済み |

### 2.2 デプロイ構成（現状）

| アプリ | デプロイ先 | 状態 |
|--------|-----------|------|
| `apps/web`（Next.js 15.3 + React 18） | Vercel | 稼働中 |
| `apps/api`（FastAPI） | Railway | 稼働中（lifespan で `alembic upgrade head` 自動実行） |
| `apps/jobs`（Python + Playwright） | GitHub Actions（cron）／ Railway（手動・任意） | 稼働中 |
| DB | Railway Postgres（将来 AWS RDS へ移行予定） | 稼働中 |

### 2.3 未実装・継続課題

| 対象 | 状態 | 優先度 |
|------|------|--------|
| `genres.py` / `performers.py` API エンドポイント | 空ファイル（ルーティングは `api.py` で未 include） | 🟡 中 |
| `packages/shared/*` の JSON Schema / TS 型 | DB スキーマと未同期。`movies` テーブルの新列（actress プロフィール等）が反映されていない | 🟡 中 |
| `apps/web/Dockerfile` | 未作成（Vercel で完結しているため後回し） | 🟢 低 |
| Redis キャッシュ | 未導入（Phase 3 以降） | 🟢 低 |
| `apps/jobs/src/backfill_slugs.py` | 空ファイル | 🟢 低 |
| `apps/jobs/src/generate_related.py` | 空ファイル（関連作品レコメンド） | 🟢 低 |
| `apps/jobs/src/rebuild_cache.py` | 空ファイル（Redis 導入時に使用予定） | 🟢 低 |
| `apps/jobs/src/recompute_rankings.py` | 空ファイル（現在は API リクエスト時に算出。バッチ化は将来検討） | 🟢 低 |
| `.github/workflows/api-ci.yml`・`jobs-ci.yml`・`web-ci.yml` | 空ファイル（lint / test の CI 未整備） | 🟡 中 |
| `docs/architecture.md`・`db-schema.md`・`api-contract.md`・`environments.md`・`roadmap.md` | 空ファイル | 🟡 中 |
| `infra/docker/.env.example` | 空ファイル | 🟢 低 |
| AWS 移行（ECR / ECS / RDS / EventBridge） | 未着手（Phase 4） | ⚪️ 後 |

### 2.4 直近のオープン作業

- **PR #2**: `refactor: FeedItem.tsx を分割リファクタ（機能変更なし）` — `components/feed/` 配下に `FeedItemMeta`・`FeedItemSideActions`・`FeedItemVideo`・`feedItemStyle.ts`・`useFeedPlayback.ts` として分割中。`develop` から `main` へのマージ待ち。

---

## 3. 機能要件

### 3.1 フロントエンド（apps/web）

スタック: Next.js 15.3（App Router）＋ React 18 ＋ TypeScript 5.8 ＋ Auth.js v5 ＋ `jose`。

#### 3.1.1 実装済みページ

| パス | 役割 |
|------|------|
| `/` | ホーム画面。`api/v1/home` のセクションを上から並べた縦カードロウ表示（`HorizontalCardRow.tsx` 利用） |
| `/feed` | TikTok 風縦スクロールフィード（メイン体験） |
| `/movies/[slug]` | 作品詳細ページ |
| `@modal/(.)movies/[slug]` | パラレルルートによる作品詳細モーダル（フィードからの遷移時に使用） |
| `/search` | 検索（グリッド表示） |
| `/search/feed` | 検索結果の縦スクロール再生 |
| `/actresses/[name]` | 女優詳細（プロフィール＋出演作品） |
| `/age-gate` | 年齢確認ページ（middleware で全ページから強制リダイレクト） |
| `/auth/error` | 認証エラー表示 |
| `/mypage` | マイページ（ブックマーク・視聴履歴） |
| `/privacy` | プライバシーポリシー（FANZA 審査済） |
| `/law` | 特定商取引法に基づく表記（FANZA 審査済） |
| `/contact` | お問い合わせ（`avshorts0512@gmail.com`） |
| `/robots.ts`・`/sitemap.ts` | SEO 用ファイル |

#### 3.1.2 主要コンポーネント

- **フィード**:
  - `app/FeedClient.tsx`: 仮想スクロール（`translateY` 方式、`WINDOW_SIZE = 2`, `PREFETCH_AHEAD = 8`）。`scroll-snap` は使用しない。
  - `components/FeedViewer.tsx`: 検索フィードや汎用利用向けのビューワ
  - `components/FeedItem.tsx`: フィード 1 件分（現在 PR #2 で分割中）
  - `components/feed/FeedItemMeta.tsx`・`FeedItemSideActions.tsx`・`FeedItemVideo.tsx`・`feedItemStyle.ts`・`useFeedPlayback.ts`: 分割後の責務別ファイル
- **ナビゲーション**: `Header.tsx`（固定ヘッダー、`--header-h: 52px`）、`HamburgerMenu.tsx`、`BottomNav.tsx`、`BackButton.tsx`
- **作品詳細**: `components/movie-detail/MovieDetailContent.tsx`・`MovieDetailModal.tsx`
- **ホーム**: `components/home/HorizontalCardRow.tsx`・`MovieCardThumb.tsx`・`PullToRefresh.tsx`
- **認証**:
  - `auth.ts`（Auth.js v5 設定。Twitter / Discord providers）
  - `components/SessionProvider.tsx`
  - `components/auth/BookmarksProvider.tsx`（クライアント側ブックマーク状態の共有）
- **計測**: `components/analytics/affiliate-link.tsx`・`detail-view-tracker.tsx`・`age-gate-form.tsx`

#### 3.1.3 API クライアント層（`apps/web/lib/api/`）

| ファイル | 役割 |
|----------|------|
| `feed.ts` | `getFeed(cursor, limit, seed)` |
| `home.ts` | ホームセクション取得 |
| `movies.ts` | 作品詳細取得 |
| `search.ts` | 検索 |
| `tags.ts` | ジャンル一覧 |
| `actresses.ts` | 女優詳細 |
| `events.ts` | イベント送信（POST `/api/v1/events`） |
| `me.ts` | マイページ（ブックマーク / 視聴履歴の取得・更新） |
| `sample-url.ts` | クライアントが発見した有効 MP4 URL を API に報告 |

#### 3.1.4 補助ロジック（`apps/web/lib/`）

- `feedOrder.ts`: seed 生成・既読管理
- `feedNav.ts` / `feedPlaylist.ts`: フィード内ナビゲーション
- `sampleUrlProbe.ts`: クライアント側で MP4 URL を並列プローブして最初に成功したものを採用＋学習キャッシュ
- `config/env.ts`: 環境変数アクセス
- `analytics/analytics.ts`: イベント送信ヘルパ

#### 3.1.5 API ルートハンドラ（`apps/web/app/api/`）

- `api/age-gate/route.ts`: 年齢確認 cookie 設定
- `api/auth/[...nextauth]/route.ts`: Auth.js のエンドポイント
- `api/events/route.ts`: フロントから FastAPI への計測イベント中継
- `api/proxy/me/[...path]/route.ts`: マイページ系 API のサーバーサイド転送（JWT を Authorization ヘッダに付与する）

#### 3.1.6 年齢確認フロー

- `middleware.ts` で全ページのアクセスを遮断
- `/age-gate` で同意 → cookie 記録 → `location.href` でフルナビゲーション

### 3.2 バックエンド API（apps/api）

スタック: FastAPI ＋ SQLAlchemy 2.x（async）＋ asyncpg ＋ Alembic ＋ Pydantic v2 ＋ PyJWT。

#### 3.2.1 実装済みエンドポイント

| メソッド | パス | 役割 |
|----------|------|------|
| GET | `/api/v1/health` | 死活監視 |
| GET | `/api/v1/feed` | フィード一覧（`offset`・`limit`・`seed`・`genres[]`） |
| GET | `/api/v1/movies/{slug}` | 作品詳細 |
| POST | `/api/v1/movies/{slug}/sample-url` | クライアントが見つけた有効 MP4 URL を保存（URL 検証あり） |
| GET | `/api/v1/search` | キーワード検索（`q` 部分一致 ／ `director`・`maker`・`label` 完全一致） |
| GET | `/api/v1/tags/popular` | ジャンルランキング（`movie_genres` 集計） |
| POST | `/api/v1/events` | view / play / detail_click / affiliate_click / search を記録 |
| GET | `/api/v1/rankings?period=daily\|weekly\|monthly` | ランキング |
| GET | `/api/v1/home` | ホーム画面用集約レスポンス |
| POST | `/api/v1/auth/sign-in` | Next.js exchange JWT → 内部 User JWT 交換 |
| GET | `/api/v1/me/bookmarks` | ブックマーク一覧 |
| POST | `/api/v1/me/bookmarks/toggle` | ブックマークの追加・解除 |
| GET | `/api/v1/me/view-history` 等 | 視聴履歴系（`me.py` 内に複数定義、計 214 行） |
| GET | `/api/v1/actresses/{name}` | 女優詳細（DMM 女優 API 由来プロフィール＋出演作品） |

#### 3.2.2 未実装エンドポイント（空ファイル）

| メソッド | パス | 備考 |
|----------|------|------|
| GET | `/api/v1/genres/{slug}` | `genres.py` 空ファイル・ルーター未 include |
| GET | `/api/v1/performers/{slug}` | `performers.py` 空ファイル・ルーター未 include |

> 女優詳細は `actresses.py` で実装済みのため、`performers.py` のリネーム or 削除が必要。

#### 3.2.3 設計上の重要原則

- DB フィールド・ORM モデル・Pydantic スキーマ・サービス層・レスポンスの 5 層は**必ず同時にレビュー・更新する**
- `content_id`（FANZA 商品 ID）・`product_id`（品番）・`maker_product`（メーカー品番）の 3 種 ID を必ず DB に保持する
- DB の `created_at` 系は `TIMESTAMP WITHOUT TIME ZONE`（naive UTC）。tz-aware を渡すと asyncpg が `DataError` を投げるため、必ず `datetime.now(timezone.utc).replace(tzinfo=None)` を渡す
- フィールド名変更は過去に多数の bug を生んだので、命名前に DMM API 実レスポンスと照合する
- DMM Affiliate API が返す `al.fanza.co.jp` 形式のリンクは新規アカウントで「無効リンク」になるため、`af_id` を直接付けた本家 `dmm.co.jp` URL を `sync_catalog` 側で組み立てる

### 3.3 認証基盤（apps/web ＋ apps/api 横断）

#### 3.3.1 構成

```
[ユーザー]
   ↓ OAuth (Twitter / Discord)
[Auth.js v5 on Vercel]
   ↓ exchange JWT (purpose=signin, aud=short-video-media-signin, exp=60s)
[FastAPI /api/v1/auth/sign-in]
   ↓ Identity.sub_hash = SHA-256(provider:sub:APP_USER_SALT) で get_or_create
[内部 User]
   ↓ 内部 User JWT (sub=user.id, aud=settings.JWT_AUDIENCE, exp=30d) を発行
[Next.js セッションに格納 → 以後 /api/proxy/me/* で Authorization: Bearer ... を付与]
```

#### 3.3.2 個人情報非保存ポリシー

- provider 側のメール・名前・アバター・アクセストークンを **一切 DB に保存しない**
- `Identity` テーブルが保持するのは `provider` と `sub_hash`（64 文字 hex）のみ
- 同一 User に複数 Identity（Twitter ＋ Discord 等）を紐付け可能

#### 3.3.3 必要環境変数

| 変数 | 用途 |
|------|------|
| `AUTH_SECRET` | Auth.js 署名鍵。FastAPI 側で exchange JWT 検証にも使用 |
| `AUTH_TWITTER_ID` / `AUTH_TWITTER_SECRET` | Twitter OAuth |
| `AUTH_DISCORD_ID` / `AUTH_DISCORD_SECRET` | Discord OAuth |
| `JWT_SECRET` / `JWT_AUDIENCE` | 内部 User JWT |
| `APP_USER_SALT` | `sub_hash` の SALT。漏洩したら全 Identity を再構築する必要があるため絶対に変更しない |

### 3.4 データ取得バッチ（apps/jobs）

#### 3.4.1 スクリプト一覧

| ファイル | 状態 | 役割 |
|----------|------|------|
| `src/sync_catalog.py` | ✅ 実装済み（42KB） | DMM ItemList API から取得・正規化・upsert |
| `src/extract_mp4_urls.py` | ✅ 実装済み（15.7KB） | Playwright で MP4 直リンク抽出 |
| `src/debug_extract.py` | ✅ 実装済み（6.0KB） | 抽出失敗の切り分け用 |
| `src/backfill_slugs.py` | ❌ 空 | 旧データの slug 再生成 |
| `src/generate_related.py` | ❌ 空 | 関連作品レコメンド |
| `src/rebuild_cache.py` | ❌ 空 | Redis キャッシュ再構築（Phase 3 用） |
| `src/recompute_rankings.py` | ❌ 空 | ランキングのバッチ事前計算（現状は API 側で都度算出） |

#### 3.4.2 `sync_catalog.py` の仕様

- 対象フロア:
  - `FANZA / digital / videoa`（単体女優物）
  - `FANZA / digital / videoc`（アマチュア）
  - `FANZA / mono / goods`（女優グッズ。cron では取得せず、月 1 の全件取得時のみ）
- 並び順 `sort=date`（配信開始日 desc）、1 リクエスト最大 100 件、rate limit 1 req/sec
- 既存 `content_id` があれば UPDATE、無ければ INSERT
- ジャンル / 女優 / シリーズ / メーカー / レーベル / 監督も同時に upsert
- フロア別の擬似ジャンル（`videoc → アマチュア`、`videoa → プロ女優`）を同期時に自動付与
- `--mode full` で期間スライス（gte_date / lte_date 月単位）を回し offset 50000 上限を回避
- `--refresh-sample-url` で `sample_movie_url` の強制上書き（月 1 のフルジョブで自動有効化）
- 環境変数: `DMM_API_ID`・`DMM_AFFILIATE_ID`（末尾 -990〜-999）・`DMM_LINK_AFFILIATE_ID`（末尾 -001 等。未設定なら `DMM_AFFILIATE_ID` をフォールバック）・`DATABASE_URL`
- `goods` フロアは、DB に既に存在する女優に紐付くもののみ保存

#### 3.4.3 `extract_mp4_urls.py` の仕様

- DMM litevideo iframe ページ（HTML プレイヤー）を Playwright (Chromium) で開き、JS が動的に生成する `<video src>`（`https://cc3001.dmm.co.jp/pv/<token>/<cid>mhb.mp4`）を取得して DB に保存
- 一般 CDN パス `cc3001.dmm.co.jp/litevideo/freepv/...` は古い作品にしか使われないため、新作・未発売作品はヘッドレスブラウザでの抽出が必須
- 実行要件:
  - Playwright (Chromium) インストール済み
  - **日本 IP からアクセスできること**（海外 IP には DMM が `not-available-in-your-region` リダイレクトを返す）
  - DB へのアクセス（`DATABASE_URL`）
- 使い方:
  - `python -m src.extract_mp4_urls --cid 1sun00052a --dry-run`（単体テスト）
  - `python -m src.extract_mp4_urls --only-broken`（4xx になっているものだけ更新）
  - `python -m src.extract_mp4_urls --all --concurrency 4`（全件、並列 4）

#### 3.4.4 `debug_extract.py`

MP4 抽出に失敗した CID について、リクエスト・レスポンス・iframe HTML・JS console をすべて吐き出し、`not-available-in-your-region` リダイレクトや GeoIP ブロック・SPA レンダリング不全などを切り分ける。

### 3.5 GitHub Actions（定期実行）

| ワークフロー | トリガー | 役割 |
|-------------|---------|------|
| `sync-catalog.yml` | cron `0 */2 * * *`（2 時間ごと） / 手動 | DMM ItemList から増分取得（videoa, videoc。各 100 件） |
| `sync-catalog-full.yml` | cron `0 1 1 * *`（毎月 1 日 10:00 JST） / 手動 | 全期間フル取得＋ `sample_movie_url` 強制リフレッシュ。最大 350 分タイムアウト |
| `migrate.yml` | main への push（`apps/api/alembic/**`・`apps/api/app/db/**`・`alembic.ini`・`pyproject.toml`・自身）／ 手動 | 本番 DB に `alembic upgrade head` を実行 |
| `api-ci.yml` / `jobs-ci.yml` / `web-ci.yml` | （未実装） | lint / test を将来実装する枠 |

排他制御は `concurrency.group` で実現:

- `sync-catalog-prod`（増分）
- `sync-catalog-full-prod`（フル）
- `db-migrate-prod`（マイグレーション）

将来 AWS (RDS) 移行時も Secrets の `DATABASE_URL` を差し替えるだけでそのまま再利用可能。

### 3.6 イベント計測

| event_type | 必須フィールド | 用途 |
|------------|---------------|------|
| `view` | `slug` | 作品が画面に表示された |
| `play` | `slug` | 動画再生開始 |
| `detail_click` | `slug` | 詳細ボタンクリック |
| `affiliate_click` | `slug`, `affiliate_url` | 「購入する」ボタンクリック（収益核） |
| `search` | `search_query` | 検索ボックスへの入力確定 |

- `next_path` も任意で記録し、CTA の遷移先別 CVR 分析に使える
- `events` テーブルは `event_type`・`slug`・`search_query`・`created_at` にインデックス（マイグレーション `027a75b9c90d`）

---

## 4. データモデル（現状コードに同期）

### 4.1 テーブル一覧

| テーブル | 概要 |
|----------|------|
| `movies` | 作品本体（FANZA 識別子 3 種、画像・動画 URL、価格、日付、レビュー、制作情報） |
| `actresses` | 女優（FANZA actress_id、slug、サムネ、＋ DMM 女優 API 由来プロフィール 13 列） |
| `genres` | ジャンル |
| `series` | シリーズ |
| `movie_actresses` | 多対多中間（`position` で並び順保持） |
| `movie_genres` | 多対多中間 |
| `events` | 計測イベント |
| `users` | 内部 User（個人情報なし。`id`・`created_at`・`last_seen_at` のみ） |
| `identities` | provider × sub_hash の認証情報 |
| `bookmarks` | ユーザーのブックマーク（複合 PK: user_id × movie_id） |
| `view_histories` | 視聴履歴（user_id × movie_id × view_count × last_viewed_at） |

### 4.2 `movies` テーブル（抜粋）

| 列 | 型 | 備考 |
|----|----|------|
| `id` | uuid (str PK) | |
| `content_id` | str, unique, indexed | FANZA 商品 ID |
| `product_id` | str, indexed | 品番 |
| `maker_product` | str | メーカー品番 |
| `title` | str, not null | |
| `slug` | str, unique, indexed, not null | |
| `description` | text | |
| `volume` | int | |
| `image_url_list` / `image_url_large` | str | |
| `sample_movie_url` | str | MP4 直リンク（`<video src>`） |
| `sample_embed_url` | str | 埋め込みプレイヤー URL（`<iframe src>`） |
| `affiliate_url` / `affiliate_url_en` | str | |
| `price_list` | JSONB | `list_price`・`sale_price`・`rental_price`・`delivery_price` |
| `price_min` | int | |
| `release_date` / `delivery_date` / `rental_start_date` / `primary_date` | date | `primary_date` は indexed、フィード・ランキングのソートキー |
| `review_count` / `review_average` | int / Numeric(3,2) | |
| `director_name` / `label_name` / `maker_name` | str | |
| `series_id` | FK → series.id | `ondelete=SET NULL` |
| `is_visible` | bool | 運用フラグ |

リレーション:

- `series`: `lazy="joined"`（1 本の JOIN で取れるため）
- `genres` / `actresses`: `lazy="selectin"`（多対多は IN 句で一括取得）

> フィード用途では `series` のみ joined、`genres` / `actresses` は selectin の方針で統一。

### 4.3 `actresses` テーブル

DMM 女優検索 API のレスポンスを保持するため、以下のプロフィール列を追加済み（すべて nullable）:

`ruby`・`bust`・`cup`・`waist`・`hip`・`height`・`birthday`・`blood_type`・`hobby`・`prefectures`・`image_url_small`・`image_url_large`・`dmm_list_url`

`sync_catalog` は新しい女優を作品から見つけたら、ジョブ内で DMM 女優検索 API を叩いて上記列を埋める。

### 4.4 認証関連テーブル

```text
users
  id (uuid)
  created_at
  last_seen_at

identities
  id (uuid)
  user_id (FK → users.id, CASCADE)
  provider ("twitter" | "discord")
  sub_hash (SHA-256(provider:sub:APP_USER_SALT) の hex 64 文字)
  UNIQUE (provider, sub_hash)

bookmarks
  PK (user_id, movie_id)
  created_at (indexed DESC)

view_histories
  PK (user_id, movie_id)
  last_viewed_at (indexed DESC)
  view_count (default 1)
```

### 4.5 Alembic マイグレーション一覧

| revision | 日付 | 内容 |
|----------|------|------|
| `8965394ad436` | 2026-05-12 | init |
| `a1b2c3d4e5f6` | 2026-05-12 | add `sample_video_url` to movies |
| `fanza_schema_v2` | 2026-05-13 | FANZA スキーマ第 2 版 |
| `add_missing_columns` | 2026-05-13 | 不足カラム補充 |
| `sync_models_to_db` | 2026-05-13 | コード/DB の差分解消 |
| `e9d2e36472ae` | 2026-05-13 | `fanza_id` → `content_id` リネーム |
| `027a75b9c90d` | 2026-05-17 | events に `search_query`・`created_at` インデックス |
| `4f81a2b95c0e` | 2026-05-17 | users / identities / bookmarks / view_histories 追加 |
| `8a3c1f2e9d04` | 2026-05-17 | actresses にプロフィール列 13 種追加 |

---

## 5. インフラ・運用

### 5.1 ローカル開発

```bash
make setup        # .env コピー + pnpm install
make dev          # DB + API を docker compose up
make migrate      # alembic upgrade head
make fetch        # sync_catalog を 1 回手動実行
make test-api     # pytest
make db-shell     # psql 起動
```

`infra/docker/docker-compose.yml` には `db` と `api` の 2 サービス。`apps/jobs` は `--profile jobs` で `make fetch` から起動。

### 5.2 本番

| 役割 | サービス | 備考 |
|------|---------|------|
| Web | Vercel | Next.js 15.3 |
| API | Railway | `apps/api/Dockerfile` で `uvicorn app.main:app`。lifespan で `alembic upgrade head` 自動実行 |
| DB | Railway Postgres | 将来 AWS RDS へ移行予定 |
| Jobs | GitHub Actions（cron）／ Railway（手動） | `apps/jobs/Dockerfile` は Playwright + Chromium 同梱（130MB+） |

### 5.3 環境変数

#### apps/web

| 変数 | 用途 |
|------|------|
| `NEXT_PUBLIC_SITE_URL` | 自サイト URL（SEO・絶対 URL 生成用） |
| `NEXT_PUBLIC_API_BASE_URL` | FastAPI のパブリック URL |
| `NEXT_PUBLIC_VERCEL_ENV` | `development` / `preview` / `production` |
| `INTERNAL_API_TOKEN` | サーバー間通信用トークン（必要に応じて） |
| `INTERNAL_API_BASE_URL` | 内部から API を叩く場合の URL（プライベートネットワーク移行時に使用） |
| `AUTH_SECRET` | Auth.js 署名鍵 |
| `AUTH_TWITTER_ID` / `AUTH_TWITTER_SECRET` | Twitter OAuth |
| `AUTH_DISCORD_ID` / `AUTH_DISCORD_SECRET` | Discord OAuth |

#### apps/api / apps/jobs

| 変数 | 用途 |
|------|------|
| `DATABASE_URL` | Postgres 接続文字列 |
| `DMM_API_ID` | DMM Webservice の API ID |
| `DMM_AFFILIATE_ID` | DMM API 呼び出し用 ID（末尾 -990〜-999） |
| `DMM_LINK_AFFILIATE_ID` | 購入ページに付ける af_id（末尾 -001 等） |
| `AUTH_SECRET` | exchange JWT 検証用 |
| `JWT_SECRET` / `JWT_AUDIENCE` | 内部 User JWT |
| `APP_USER_SALT` | sub_hash 用 SALT（**絶対に変更しない**） |

---

## 6. ロードマップ

### Phase 1：FANZA 審査通過 ✅ 完了

- [x] 独自ドメイン取得・Vercel 設定
- [x] TikTok 風縦スクロール UI 完成
- [x] `/privacy` ページ作成
- [x] `/law` ページ作成
- [x] `/contact` ページ作成
- [x] モックコンテンツ 10〜20 件追加 → DMM 実データに置換
- [x] FANZA 審査申請・**通過**

### Phase 2：コンテンツ量確保＆品質向上（進行中）

- [x] `sync_catalog.py` 本実装（DMM ItemList API 全件取得）
- [x] GitHub Actions による 2h 増分 / 月 1 フル取得の cron 稼働
- [x] `extract_mp4_urls.py`（Playwright で MP4 直リンク抽出）
- [x] フロア別擬似ジャンル（アマチュア / プロ女優）自動付与
- [x] サンプル動画 URL の学習キャッシュ・並列プローブ
- [x] 認証 / マイページ（ブックマーク・視聴履歴）
- [x] 女優詳細ページ＋ DMM 女優プロフィール統合
- [x] ホーム画面集約 API・ランキング・検索数の高いジャンル
- [ ] PR #2（FeedItem 分割リファクタ）のマージ
- [ ] `genres.py` / `performers.py` の整理（実装 or 削除）
- [ ] `packages/shared/*` を最新スキーマに同期
- [ ] `apps/jobs` Dockerfile の検証と Railway での MP4 抽出ジョブ運用

### Phase 3：SEO・流入強化（1〜2 ヶ月後）

- [ ] OGP・メタタグの動的生成（作品ごと・女優ごと）
- [ ] `sitemap.xml` の作品・女優・ジャンルへの動的反映
- [ ] 関連作品レコメンド（`generate_related.py`）
- [ ] Redis 導入＆ホーム / ランキング応答のキャッシュ（`rebuild_cache.py`）
- [ ] CI 整備（`api-ci.yml`・`jobs-ci.yml`・`web-ci.yml`）
- [ ] `recompute_rankings.py` でランキングを事前計算しレスポンス改善

### Phase 4：AWS 移行・全自動化（3 ヶ月後〜）

- [ ] ECR + ECS（または App Runner）に API を移行
- [ ] EventBridge Scheduler ＋ ECS Task で `sync_catalog` / `extract_mp4_urls` を実行
- [ ] RDS（Postgres）へ DB 移行
- [ ] CloudFront ＋ Vercel 切り替え判断
- [ ] Secrets Manager で `DMM_*` 系・`JWT_*` 系・`APP_USER_SALT` を一元管理
- [ ] CloudWatch Logs / Alarms で 24/7 監視

---

## 7. リスクと制約

| リスク | 内容 | 対応 |
|--------|------|------|
| GeoIP ブロック | DMM CDN は海外 IP に `not-available-in-your-region` を返すため、AWS リージョン選定・NAT Gateway の出口 IP に注意 | 日本リージョン（ap-northeast-1）固定 |
| アフィリエイト無効リンク | DMM API が返す `al.fanza.co.jp` URL は新規アカウントで無効 | `sync_catalog` 側で `af_id` 付き `dmm.co.jp` URL を組み立て |
| MP4 URL の署名失効 | 動的署名のため有効期限がある | 月 1 のフルジョブで `--refresh-sample-url` を強制実行＋ クライアント学習キャッシュも月 1 でリセット |
| Provider 個人情報 | OAuth 経由でメール・名前等を取得できるが、規約・GDPR 観点で保持しない方針 | `sub_hash` のみ保持。`APP_USER_SALT` は絶対に変更しない |
| ランキング負荷 | 現在は API リクエスト時に都度算出 | Phase 3 で `recompute_rankings.py` ＋ Redis にバッチ化 |
| asyncpg の tz-aware エラー | `TIMESTAMP WITHOUT TIME ZONE` に tz-aware datetime を渡すと `DataError` | モデル側で `replace(tzinfo=None)` を統一 |

---

## 8. 関係ドキュメント

- `docs/minutes.md`: 開発議事録
- `docs/architecture.md`（要記述）: システム構成図、データフロー
- `docs/db-schema.md`（要記述）: ER 図、列定義
- `docs/api-contract.md`（要記述）: OpenAPI 由来のエンドポイント仕様
- `docs/environments.md`（要記述）: 環境変数一覧・Secrets 管理ポリシー
- `docs/roadmap.md`（要記述）: 本書 §6 と連動させた中長期ロードマップ
