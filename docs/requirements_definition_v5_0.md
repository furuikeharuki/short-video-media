# 要件定義書：TikTok風アダルト動画アフィリエイトメディア

**プロジェクト名**: short-video-media
**リポジトリ**: https://github.com/furuikeharuki/short-video-media
**作成日**: 2026-05-17
**最終更新**: 2026-05-18
**バージョン**: 5.2

**v5.1 → v5.2 の主な変更点**:
- Phase 4 の「サンプル動画 MP4 URL の動的解決サービス」を **2 段階構成** に再設計（v5.1 は AWS Tokyo 単独前提だった）
  - **Stage A（暫定運用 / 短期）**: Xserver VPS 2GB Tokyo（実質月額 ¥936 / 12 ヶ月、東京 DC で日本 IP 確保）に常駐 HTTP サービスとしてデプロイ
  - **Stage B（恒久運用 / 長期）**: AWS Tokyo（Lambda Function URL もしくは Fargate Spot）へ Dockerfile ごと移植
- 新規アプリ **`apps/resolver/`** を作成方針として明文化（`apps/jobs/` への同居案は破棄、責務分離を優先）
  - 既存バッチ `apps/jobs/src/extract_mp4_urls.py` のコア関数 `extract_mp4_url` をリクエスト駆動型 API として再構成
  - 起動時に Playwright Chromium を 1 度だけ立ち上げて再利用するプール方式（同時並列はコネクション数で制御）
- §3 に **§3.7 サンプル動画 MP4 動的解決サービス（apps/resolver）** を新設
- §5.2 本番デプロイ表に Resolver / Xserver VPS Tokyo の行を追加
- §5.3 環境変数に `apps/resolver` 用・`apps/api` 側呼び出し用の変数を追加
- §7 リスク表に「VPS 単一障害点 / Xserver から AWS への移行コスト」項目を追加

**v5.0 → v5.1 の主な変更点**:
- 実装とのズレを一斉に同期（2026-05-18 検証）
- Alembic マイグレーション 9 件 → 11 件に更新（複合 index 追加・`goods` / `actress_goods` テーブル追加）
- `goods` / `actress_goods` テーブルと `apps/api/app/db/models/goods.py` を §4 に追加
- `sync_actress_profiles.py` ジョブを §3.4 と §3.5 （`sync-catalog-full.yml` 連続実行）に反映
- CI ワークフロー（`api-ci.yml` / `jobs-ci.yml` / `web-ci.yml`）と `debug-dmm-api.yml` が実装済みであることを反映
- ホームのセクション一覧ページ `/list/[key]` と `GET /api/v1/home/section` を追記
- `/api/v1/me/*` のエンドポイント表を実装に合わせて修正（POST/DELETE bookmarks、bookmarks/ids、POST/GET views）
- `genres.py` / `performers.py` は「空ファイル」ではなく「コードベースに存在しない（廃止方針）」と訂正
- `apps/jobs/src/` の `backfill_slugs` / `generate_related` / `rebuild_cache` / `recompute_rankings` は「空ファイル」ではなく「未作成」と訂正
- `docs/` の補助ドキュメント群が「空ファイル」ではなく「簡易実装済み」であることを反映
- §6 Phase 4 に「サンプル動画 MP4 URL の動的解決サービス (BFF + ハイブリッド方式)」を新規 TODO として追加
- §7 リスク表の 「MP4 URL の署名失効」項を、実測結果（トークン 32 日以上有効、CORS 全開放）に基づいて訂正

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

## 2. 現状（2026 年 5 月 18 日時点）

### 2.1 完了したマイルストーン

| 項目 | 状態 |
|------|------|
| **FANZA 審査通過** | ✅ 完了 |
| 独自ドメインでの本番公開 | ✅ 完了（Vercel） |
| `/privacy`・`/law`・`/contact` の本文実装 | ✅ 完了 |
| FANZA API 連携バッチ（`sync_catalog.py`） | ✅ 本実装済み（42KB） |
| MP4 直リンク抽出ジョブ（`extract_mp4_urls.py`） | ✅ 実装済み（15.7KB） |
| Alembic マイグレーション | ✅ 11 件適用済み |
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
| `packages/shared/*` の JSON Schema / TS 型 | DB スキーマと未同期。`movies` テーブルの新列（actress プロフィール等）が反映されていない | 🟡 中 |
| `apps/web/Dockerfile` | 未作成（Vercel で完結しているため後回し） | 🟢 低 |
| Redis キャッシュ | 未導入（Phase 3 以降） | 🟢 低 |
| `apps/jobs/src/generate_related.py` | 未実装（関連作品レコメンド。スクリプトファイル自体が無い） | 🟢 低 |
| `apps/jobs/src/rebuild_cache.py` | 未実装（Redis 導入時に使用予定） | 🟢 低 |
| `apps/jobs/src/recompute_rankings.py` | 未実装（現在は API リクエスト時に算出。バッチ化は将来検討） | 🟢 低 |
| `apps/jobs/src/backfill_slugs.py` | 未実装（旧データの slug 再生成。スクリプトファイル自体が無い） | 🟢 低 |
| `.github/workflows/api-ci.yml` | ✅ 実装済み（apps/api への push / PR で pytest を実行） | – |
| `.github/workflows/jobs-ci.yml` / `web-ci.yml` | ✅ 実装済み（CI 整備済み） | – |
| `docs/architecture.md`・`db-schema.md`・`api-contract.md`・`environments.md`・`roadmap.md` | 簡易実装済み（30〜85 行程度。継続加筆中） | 🟡 中 |
| `apps/resolver/` （サンプル動画 MP4 動的解決サービス） | 未作成。§3.7 と Phase 4 Stage A で新規設計済み（FastAPI + Playwright Chromium、Xserver VPS へデプロイ予定） | 🔴 高 |
| Xserver VPS 2GB Tokyo の契約 | 未契約。Phase 4 Stage A のホスト先。初回 ¥14,040（12 ヶ月一括）→ キャッシュバック後実質 ¥11,232 / 月均 ¥936 | 🔴 高 |
| AWS 移行（ECR / ECS / RDS / EventBridge） | 未着手（Phase 4 Stage B） | ⚪️ 後 |

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
| `/list/[key]` | ホーム画面の各セクション（`popular` / `new` / `recent` / `ranking_daily|weekly|monthly`）から遷移する一覧ページ |
| `/actresses/[name]` | 女優詳細（プロフィール＋出演作品＋関連グッズ） |
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
| GET | `/api/v1/home/section` | ホームの個別セクション一覧（`/list/[key]` の裏側、ページング対応） |
| POST | `/api/v1/auth/sign-in` | Next.js exchange JWT → 内部 User JWT 交換 |
| GET | `/api/v1/me/bookmarks` | ブックマーク一覧 |
| GET | `/api/v1/me/bookmarks/ids` | ブックマーク movie_id 一覧（state 復元用） |
| POST | `/api/v1/me/bookmarks` | ブックマーク追加 |
| DELETE | `/api/v1/me/bookmarks` | ブックマーク解除 |
| POST | `/api/v1/me/views` | 視聴履歴の記録（204 No Content） |
| GET | `/api/v1/me/views` | 視聴履歴一覧 |
| GET | `/api/v1/actresses/{name}` | 女優詳細（DMM 女優 API 由来プロフィール＋出演作品＋関連グッズ。`movie_limit` / `goods_limit` クエリで件数調整） |

#### 3.2.2 過去想定して廃止したエンドポイント

`genres.py` / `performers.py` は当初の設計では用意していたが、現状コードベースには存在しない（`api.py` にも未 include）。ジャンル一覧は `/api/v1/tags/popular` に集約し、女優一覧は `/api/v1/actresses/{name}` に集約しているため将来も新設不要の方針。

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
| `src/sync_actress_profiles.py` | ✅ 実装済み | DMM ActressSearch API で DB 内女優のプロフィール 13 列を更新（月 1 / `--only-missing` モードで差分実行可） |
| `src/extract_mp4_urls.py` | ✅ 実装済み（15.7KB） | Playwright で MP4 直リンク抽出 |
| `src/debug_extract.py` | ✅ 実装済み（6.0KB） | 抽出失敗の切り分け用 |
| `src/generate_related.py` | 未実装 | 関連作品レコメンド（スクリプトファイル自体が未作成） |
| `src/rebuild_cache.py` | 未実装 | Redis キャッシュ再構築（Phase 3 用） |
| `src/recompute_rankings.py` | 未実装 | ランキングのバッチ事前計算（現状は API 側で都度算出） |
| `src/backfill_slugs.py` | 未実装 | 旧データの slug 再生成（過去の DB マイグレ用途。当面不要） |

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
| `sync-catalog-full.yml` | cron `0 1 1 * *`（毎月 1 日 10:00 JST） / 手動 | 全期間フル取得＋ `sample_movie_url` 強制リフレッシュ＋ `sync_actress_profiles` 連続実行。最大 350 分タイムアウト |
| `migrate.yml` | main への push（`apps/api/alembic/**`・`apps/api/app/db/**`・`alembic.ini`・`pyproject.toml`・自身）／ 手動 | 本番 DB に `alembic upgrade head` を実行 |
| `debug-dmm-api.yml` | `workflow_dispatch` 手動 | 特定 content_id について DMM API の生レスポンスをダンプ（取得漏れフィールド調査用） |
| `api-ci.yml` | apps/api への push / PR | pytest（DB 接続不要のテストのみ） |
| `jobs-ci.yml` | apps/jobs への push / PR | jobs 側の lint / test |
| `web-ci.yml` | apps/web への push / PR | web 側の lint / test |

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

### 3.7 サンプル動画 MP4 動的解決サービス（apps/resolver）

> **ステータス**: 未作成 / 設計確定。Phase 4 Stage A として着手予定（2026-05-18 時点）。

#### 3.7.1 背景

`/feed` や作品詳細モーダルで「再生できない動画」が一部残る問題への恒久対策。現状の「suffix をクライアントであてずっぽうして学習キャッシュ」方式では、未知 suffix（例：`_sm_s`）を持つ作品は永久に再生不可となる。これを BFF 経由でヘッドレスブラウザに出させて動的に解決し、DB に書き戻して自動学習させる。

#### 3.7.2 責務

- DMM 作品の content_id を受け取り、Playwright Chromium で litevideo iframe を開いて `<video src>` を抽出して返す
- **状態を一切持たない**（DB アクセスしない、Redis も接続しない）。キャッシュと DB 書き戻しは `apps/api` 側責務
- 同時並列数を限定して DMM CDN への負荷を押さえる
- API キー認証により `apps/api` 以外からの呼び出しを拒否する

#### 3.7.3 エンドポイント

| メソッド | パス | 役割 |
|----------|------|------|
| GET | `/health` | 死活監視（認証なし、Xserver 監視もしくは外部 uptime サービス用） |
| POST | `/resolve` | content_id から MP4 URL を動的解決。認証ヘッダー `Authorization: Bearer <RESOLVER_API_KEY>` 必須 |

**`POST /resolve` リクエスト / レスポンス例**

```http
POST /resolve HTTP/1.1
Authorization: Bearer <RESOLVER_API_KEY>
Content-Type: application/json

{
  "content_id": "nhd19",
  "affiliate_id": "<DMM_AFFILIATE_ID>"
}
```

```json
{
  "content_id": "nhd19",
  "mp4_url": "https://cc3001.dmm.co.jp/pv/<token>/nhd19_sm_s.mp4",
  "resolved_at": "2026-05-18T19:38:00+09:00",
  "elapsed_ms": 4521
}
```

失敗時は HTTP 404（content_id が存在しない）・502（litevideo の DOM から `<video>` が見つけられない）・504（タイムアウト）を返し、`apps/api` 側でログとリトライを制御する。

#### 3.7.4 内部構造

```
apps/resolver/
├── Dockerfile               # mcr.microsoft.com/playwright:python-v1.x-jammy ベース
├── pyproject.toml           # FastAPI + uvicorn + playwright + httpx
├── src/
│   ├── main.py              # FastAPI エントリポイント、API キー認証ミドルウェア
│   ├── browser_pool.py      # Chromium を起動時に一度だけ立ち上げて保持、context を貯蔵
│   ├── resolver.py          # litevideo iframe を開いて <video src> を抽出
│   └── config.py            # Pydantic Settings で環境変数読み込み
├── tests/
│   └── test_resolver.py     # モック DMM サーバーを立てて e2e 近いテスト
└── README.md
```

**Playwright ブラウザのライフサイクル**:

- FastAPI lifespan で `browser = await playwright.chromium.launch(headless=True)` を 1 回だけ実行
- リクエスト毎に `browser.new_context()` → `context.new_page()` して iframe を開き、終わったら context を close
- シャットダウン時に `await browser.close()` して Playwright を clean shutdown
- 同時リクエスト数は `asyncio.Semaphore` で上限をつける（初期値 2、3〜5 に調整可能）

#### 3.7.5 apps/api 側の連携

新規エンドポイント **`GET /api/v1/movies/{slug}/resolve-mp4`** を `apps/api/app/api/v1/endpoints/movies.py` に追加し、以下の手順で動作させる。

1. `movies.sample_movie_url` がある場合はそれをそのまま返す（テスト用フラグでフォース解決可能）
2. キャッシュ HIT なら返す（Phase 3 で Redis 導入後、それまでは DB の `sample_movie_url` が事実上のキャッシュとして機能する）
3. キャッシュ MISS なら `RESOLVER_BASE_URL` + `/resolve` を `RESOLVER_API_KEY` 付きで呼ぶ
4. 取得した `mp4_url` を `movies.sample_movie_url` に更新（学習）
5. クライアントに返す

#### 3.7.6 apps/web 側の連携

- `apps/web/components/feed/FeedItemVideo.tsx`（または `FeedItem.tsx`）の `<video onError>` ハンドラに `GET /api/v1/movies/{slug}/resolve-mp4` を呼んで `src` を差し替えるロジックを追加
- 既存の `apps/web/lib/sampleUrlProbe.ts` の並列 `<video>` プローブと `buildSampleUrlCandidates` のあてずっぽうロジックは、Stage A 完了後に削除予定

#### 3.7.7 デプロイ先（Stage A）

- **Xserver VPS 2GB Tokyo**（1 インスタンス、Ubuntu 22.04 + Docker）
- ドメイン：必須ではないが Cloudflare 経由でサブドメイン（例：`resolver.<本番ドメイン>`）をプロキシさせると IP 隠蔽と TLS 終結を委譲できる
- ドメインを使わない場合は Xserver の VPS 生 IP を `RESOLVER_BASE_URL` に直接指定し、Let's Encrypt + Caddy / Traefik で TLS を終結する
- `apps/api`（Railway）の送信元 IP を Xserver の firewall でホワイトリスト化し、Bearer 認証と二重で防護（Railway の送信元 IP が可変の場合は Bearer だけで OK）

---

## 4. データモデル（現状コードに同期）

### 4.1 テーブル一覧

| テーブル | 概要 |
|----------|------|
| `movies` | 作品本体（FANZA 識別子 3 種、画像・動画 URL、価格、日付、レビュー、制作情報） |
| `actresses` | 女優（FANZA actress_id、slug、サムネ、＋ DMM 女優 API 由来プロフィール 13 列） |
| `genres` | ジャンル |
| `series` | シリーズ |
| `goods` | 女優グッズ（FANZA mono/goods フロア。動画固有カラム `sample_movie_url` / `sample_embed_url` / `series_id` 等は持たない） |
| `movie_actresses` | 多対多中間（`position` で並び順保持） |
| `movie_genres` | 多対多中間 |
| `actress_goods` | 女優×グッズの多対多中間 |
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
| `6c7d92a4f1b8` | 2026-05-18 | フィード／ランキング／イベント集計用の複合 index 追加（`is_visible × primary_date` 等） |
| `b2c3d4e5f6a7` | 2026-05-18 | `goods` / `actress_goods` テーブル追加（女優グッズを Movie とは別管理に分離） |

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
| Resolver （サンプル動画 MP4 動的解決） | **Xserver VPS 2GB Tokyo（未契約 / Phase 4 Stage A）** | 東京 DC で日本 IP 確保。`apps/resolver/Dockerfile` は `mcr.microsoft.com/playwright:python-v1.x-jammy` ベース。実質月額 ¥936（12 ヶ月一括キャッシュバック適用後）。将来的には Phase 4 Stage B で AWS Tokyo（Lambda Function URL or Fargate Spot）へ移植 |

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
| `RESOLVER_BASE_URL` | apps/api から apps/resolver を呼ぶためのベース URL（例：`https://resolver.<本番ドメイン>` または `https://<vps-ip>:<port>`） |
| `RESOLVER_API_KEY` | apps/api → apps/resolver の Bearer トークン。resolver 側と同じ値を設定 |
| `RESOLVER_TIMEOUT_MS` | resolve 呼び出しのタイムアウト（デフォルト 15000ms。Playwright コールドスタートを考慮して余裕を持たせる） |

#### apps/resolver

| 変数 | 用途 |
|------|------|
| `RESOLVER_API_KEY` | Bearer 認証用の共有トークン（`apps/api` 側と同じ値） |
| `DMM_AFFILIATE_ID` | litevideo iframe を開く際に必要な affiliate_id（リクエスト body で上書き可能だがデフォルトとして使う） |
| `RESOLVER_CONCURRENCY` | `asyncio.Semaphore` の上限（デフォルト 2） |
| `RESOLVER_NAV_TIMEOUT_MS` | iframe へのナビゲーションタイムアウト（デフォルト 15000） |
| `RESOLVER_WAIT_VIDEO_TIMEOUT_MS` | `<video>` 要素出現待ちタイムアウト（デフォルト 8000） |

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
- [ ] `packages/shared/*` を最新スキーマに同期
- [ ] `apps/jobs` Dockerfile の検証と Railway での MP4 抽出ジョブ運用

### Phase 3：SEO・流入強化（1〜2 ヶ月後）

- [ ] OGP・メタタグの動的生成（作品ごと・女優ごと）
- [ ] `sitemap.xml` の作品・女優・ジャンルへの動的反映
- [ ] 関連作品レコメンド（`generate_related.py` 新規作成）
- [ ] Redis 導入＆ホーム / ランキング応答のキャッシュ（`rebuild_cache.py` 新規作成）
- [ ] `recompute_rankings.py` 新規作成によるランキング事前計算でレスポンス改善
- [ ] CI の拡充（既存 `api-ci.yml`・`jobs-ci.yml`・`web-ci.yml` への lint 追加・カバレッジ計測等）

### Phase 4：サンプル動画動的解決 ＋ AWS 移行・全自動化

#### Phase 4 Stage A：Xserver VPS Tokyo でサンプル動画動的解決を先行リリース（1〜2 ヶ月以内）

スコープ: 「再生できない動画」問題を AWS 移行より先に解消する。VPS 上で `apps/resolver/` を立ち上げ、`apps/api` ・`apps/web` を BFF 設計に追従させる。

- [ ] **`apps/resolver/`** を新規作成（FastAPI + Playwright Chromium、`POST /resolve` + `GET /health`）
  - [ ] `apps/jobs/src/extract_mp4_urls.py::extract_mp4_url` のコアロジックを `apps/resolver/src/resolver.py` にコピーし、リクエスト駆動型に最適化（ブラウザ起動コストを起動時に一回だけ払う）
  - [ ] Bearer 認証ミドルウェア（`RESOLVER_API_KEY`）
  - [ ] `Dockerfile`（`mcr.microsoft.com/playwright:python-v1.x-jammy` ベース）
  - [ ] `pyproject.toml` + `uv` or `pip` で依存をシングルソース化
  - [ ] ユニットテスト（resolver 関数の正常系 / 例外系 / Bearer 認証）
- [ ] **Xserver VPS 2GB Tokyo を契約**（12 ヶ月一括、初回 ¥14,040 → キャッシュバック後実質 ¥11,232 / 月均 ¥936）
  - [ ] Ubuntu 22.04 テンプレートでセットアップ
  - [ ] SSH 鍵認証のみ許可、root ログイン禁止、`ufw` で 22 / 80 / 443 / レゾルバーポートのみ開放
  - [ ] Docker / docker compose を導入
  - [ ] Cloudflare 経由のサブドメイン（例：`resolver.<本番ドメイン>`）を当て、TLS をオリジン証明書または Cloudflare Origin Certificate で終結
- [ ] **`apps/api`** に `GET /api/v1/movies/{slug}/resolve-mp4` を追加し、`movies.sample_movie_url` をキャッシュとして使い、ミス時に VPS へプロキシするロジックを実装（詳細は §3.7.5）
- [ ] **`apps/web`** の `<video onError>` ハンドラを `/api/v1/movies/{slug}/resolve-mp4` 呼び出しに置き換える
- [ ] ステージング / 本番で実際に `_sm_s` やその他未知 suffix の作品が再生できることを検証し、ステップごとの許容タイムを計測
- [ ] 検証完了後、`apps/jobs/src/sync_catalog.py::_build_sample_mp4_url`（旧形式 `/litevideo/freepv/` 決め打ち生成）と `apps/web/components/FeedItem.tsx::buildSampleUrlCandidates` / `switchSuffix` / `parseSampleUrl`、`apps/web/lib/sampleUrlProbe.ts::probeSampleUrls` の並列 `<video>` プローブロジックを削除
- [ ] `apps/api/app/api/v1/endpoints/movies.py::_SAMPLE_URL_RE` を suffix optional に緩和し、`reportSampleUrl` の互換性を確認
- [ ] モニタリング：UptimeRobot 等で `/health` を 1 分間隔で監視、エラー率・実行時間をログ集約

#### Phase 4 Stage B：AWS 移行・全自動化（3 ヶ月後〜）

- [ ] ECR + ECS（または App Runner）に API を移行
- [ ] EventBridge Scheduler ＋ ECS Task で `sync_catalog` / `extract_mp4_urls` を実行
- [ ] RDS（Postgres）へ DB 移行
- [ ] CloudFront ＋ Vercel 切り替え判断
- [ ] Secrets Manager で `DMM_*` 系・`JWT_*` 系・`APP_USER_SALT`・`RESOLVER_API_KEY` を一元管理
- [ ] CloudWatch Logs / Alarms で 24/7 監視
- [ ] **【継続 TODO】`apps/resolver/` を Xserver VPS から AWS Tokyo へ移植**

  Stage A ではすでに `apps/resolver/` は完成して Xserver VPS Tokyo 上で稼働し、未知 suffix の作品も含めて「再生できない動画」問題は解消済み。Stage B では「ホストを AWS Tokyo に移す」フェーズに限定されるため、`apps/api` / `apps/web` 側は原則ノータッチ（`RESOLVER_BASE_URL` の差し替えのみ）。

  **背景と設計根拠（2026-05-18 検証で判明した事実）**

  - DMM Affiliate API の `sampleMovieURL.size_720_480` は HTML プレイヤー（iframe）の URL であり、`<video src>` には使えない。
  - 実 MP4 ファイルは `https://cc3001.dmm.co.jp/pv/<token>/<cid><suffix>.mp4` 形式で配信されている。
  - 取得には日本 IP が必須（DMM CDN は海外 IP に GeoIP 403）。Xserver VPS Tokyo でも AWS Tokyo でもこの要件は満たされる。
  - 当初「トークンは数時間で失効する署名 URL」と推測されていたが、実測により以下が確定:
    - 取得済みの `/pv/<token>/...mhb.mp4` URL は、少なくとも **32 日以上** 同一トークンで 200 OK を返す（CloudFront `age: 2796484` 秒で実測）。
    - `last-modified` は実体ファイルのもので 11 年前から不変、CORS は `Access-Control-Allow-Origin: *` で全開放。
    - つまり「動的署名」ではなく **長期キャッシュ可能なパス** に近い性質を持つ。
  - ファイル名 suffix のバリエーションが想定より多いため、クライアントで決め打ち生成・並列プローブする方式では未知 suffix（例: `_sm_s`）に追従できず、BFF ハイブリッド方式が適切と判断した。

  **ヘッドレスブラウザの実行位置以外は同一のアーキテクチャとして設計しているため、Stage B は Xserver VPS を AWS コンポーネントに置換するだけで達成できる:**

  ```
  ┌──────────────────────────────────────────────┐
  │ Vercel (web)                                  │
  │ ① <video src={DB.sample_movie_url}> で再生   │
  │ ② onError → GET /movies/{slug}/resolve-mp4   │
  │    で動的取得 → <video> 差し替え             │
  └───────────────┬───────────────────────────────┘
                  │ ②（再生失敗時のみ）
                  ▼
  ┌───────────────────────────────────────────────┐
  │ Railway api (FastAPI)                         │
  │ GET /movies/{slug}/resolve-mp4                │
  │ - movies.sample_movie_url をキャッシュとして使用 │
  │   （Phase 3 で Upstash Redis を上位キャッシュ追加） │
  │ - ミス時に RESOLVER_BASE_URL へプロキシ         │
  │ - 取得した URL を movies.sample_movie_url に    │
  │   書き戻して学習                              │
  └───────────────┬───────────────────────────────┘
                  │ HTTPS RPC（稀）
                  ▼
  ┌───────────────────────────────────────────────┐
  │ apps/resolver                                 │
  │   Stage A: Xserver VPS 2GB Tokyo               │
  │   Stage B: AWS Tokyo (Lambda Function URL      │
  │           or Fargate Spot)                    │
  │ - Playwright Chromium で litevideo iframe を   │
  │   開いて <video src> を取得して返すだけ        │
  │ - DB アクセス無し・状態なし（純粋な解決器）    │
  └───────────────────────────────────────────────┘
  ```

  **Stage B 固有のサブタスク（`apps/resolver/` の AWS 移植に限定）:**

  - [ ] AWS Tokyo 側のホスト形態を Lambda Function URL（`chrome-aws-lambda` / `@sparticuz/chromium`）と Fargate Spot 常駐のどちらにするか性能評価（コールドスタート 3〜8 秒 / 常駐 0 秒のトレードオフ・より低頻度なら Lambda がコスト有利）
  - [ ] Lambda 採用時: 既存 `apps/resolver/Dockerfile` を Lambda Container Image 形式に調整し、Function URL と IAM Resource Policy を Terraform / AWS CDK で IaC 化
  - [ ] Fargate 採用時: ECS Cluster 上で 1 タスク常駐、ALB or API Gateway HTTP API 越しで公開
  - [ ] Xserver VPS の `apps/resolver` を AWS へデプロイし、`apps/api` の `RESOLVER_BASE_URL` を差し替えてステージングで実際に動作検証
  - [ ] AWS Tokyo の出口 IP に対する DMM のレート制限挙動を観測（Playwright 同時実行数の上限決定）
  - [ ] AWS での安定動作を 1〜2 週間確認したら Xserver VPS を解約（またはフェイルオーバー用に依然保持）

  **未確定 / 継続調査事項:**

  - `/pv/<token>/...` の token 寿命の上限（現時点で 32 日以上は確定、年単位かどうかは未確認）
  - Stage A 運用中にログ集計した suffix 分布（`_sm_s` 以外にどういう suffix が出るか）をサンプリング
  - Lambda + Playwright の同時実行数とコールドスタート許容範囲のユーザー体験影響評価

---

## 7. リスクと制約

| リスク | 内容 | 対応 |
|--------|------|------|
| GeoIP ブロック | DMM CDN は海外 IP に `not-available-in-your-region` を返すため、AWS リージョン選定・NAT Gateway の出口 IP に注意 | 日本リージョン（ap-northeast-1）固定 |
| アフィリエイト無効リンク | DMM API が返す `al.fanza.co.jp` URL は新規アカウントで無効 | `sync_catalog` 側で `af_id` 付き `dmm.co.jp` URL を組み立て |
| MP4 URL のトークン失効 | 当初「数時間で失効する署名 URL」と推測していたが、2026-05-18 の実測により少なくとも 32 日は同一 URL で 200 OK を返すことが確認できた（CloudFront `age: 2796484` 秒で実測、CORS 全開放）。一方で suffix（`_sm_s` 等）には未知のバリエーションがあり、決め打ち URL 生成では未対応の動画が永続的に再生不可となる構造的問題が残る | Phase 4 Stage A で `apps/resolver/` を Xserver VPS Tokyo に立ち上げ、BFF + クライアント onError フォールバックで未知 suffix も含めて動的に解決。Stage B で AWS Tokyo へ移植（§6 Phase 4 参照） |
| Resolver （VPS）の単一障害点 | Stage A で `apps/resolver/` は Xserver VPS 1 台のみで稼働し、これが落ちると「未知 suffix の作品」が再び再生不可になる（既知 URL の作品は DB キャッシュで引き続き再生可能） | （1）`apps/api` 側で resolver 呼び出し失敗時はクライアントに 503 を返し、`<video>` はその作品をスキップして次へ進むようフォールバック実装。（2）UptimeRobot で 1 分間隔ヘルスチェック、ダウン検知時に通知。（3）Stage B の AWS 移行で恒久的に解決（Lambda ならマルチ AZ 冗長、Fargate も multi-AZ 可） |
| Xserver VPS から AWS への移行コスト | 契約は 12 ヶ月一括（初回 ¥14,040，キャッシュバック後実質 ¥11,232）のため、Phase 4 Stage B の AWS 移行が見込みより早く進んだ場合に長期契約分が無駄になる可能性 | `apps/resolver/Dockerfile` を Lambda Container Image 互換に設計しておき、Stage B では「デプロイ先を差し替えるだけ」に収める。また、Stage B で AWS の安定動作を 1〜2 週間確認した後に VPS を解約するという二重運用期間を見込んでおく |
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
