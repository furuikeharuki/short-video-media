# 要件定義書：TikTok風アダルト動画アフィリエイトメディア

**プロジェクト名**: short-video-media  
**リポジトリ**: https://github.com/furuikeharuki/short-video-media  
**作成日**: 2026-05-13  
**バージョン**: 4.0  

**v3.2からの主な変更点**:
- DBモデルの全フィールド名をコード実態（`movie.py`・`actress.py`・`genre.py`・`series.py`）に合わせて全面修正
- `performers` テーブルを実際のモデル名 `actresses` に修正
- `fanza_id` → `content_id` へのリネームを全体に反映
- `series` テーブルの独立したモデルとして追記
- `events` テーブルのDBモデルが実装済みであることを反映
- Pydantic スキーマ（`MovieCard`・`MovieDetail`）を `schemas/movie.py` の実際の定義に合わせて全面修正
- `FeedClient.tsx` の仮想スクロール実装（WINDOW_SIZE=2, PREFETCH_AHEAD=8）を反映
- `FeedItem.tsx` が `components/FeedItem.tsx` として実装済みであることを反映（22KB）
- `Header.tsx`・`HamburgerMenu.tsx`・`AffiliateNotice.tsx`・`BackButton.tsx` の実装済みコンポーネントを追記
- `components/analytics/` の計測コンポーネント群（`affiliate-link.tsx`・`detail-view-tracker.tsx`・`age-gate-form.tsx`）が実装済みであることを反映
- `lib/api/` のクライアント層（`feed.ts`・`movies.ts`・`search.ts`・`tags.ts`）が実装済みであることを反映
- `lib/feedOrder.ts`（seed管理・既読管理）が実装済みであることを反映
- `infra/docker/docker-compose.yml` が存在することを反映
- `apps/jobs/src/` の各スクリプトファイルが存在（中身は未実装）であることを反映
- API エンドポイントに `tags.py` が存在することを追記
- `apps/web/app/search/`・`contact/`・`api/` ディレクトリの存在を追記
- ロードマップのフェーズ分けをコードの実際の進捗に合わせて修正

---

## 1. プロジェクト概要

### 1.1 目的

FANZAアフィリエイトを収益源とした、TikTok風縦スクロールUIのアダルト動画メディアサイトを構築する。単なるサイト制作ではなく、**データ取得から公開・運用までを将来的に自動化できる基盤**を持つことが中期的な目標である。

最終的にはAWS上で全サービスを運用することを前提とし、各アプリはコンテナで動作する設計とする。

### 1.2 コアバリュー

- スマートフォンに最適化されたTikTok風UXによる高い滞在時間とCVR
- FANZA APIを通じた大量コンテンツの自動取得・掲載
- **全アプリのコンテナ化によるクラウド非依存の移植性**
- ローカル開発〜本番環境をDockerで統一し、CI/CDと接続しやすい構成

### 1.3 収益モデル

| 収益源 | 概要 |
|--------|------|
| FANZAアフィリエイト | 作品購入・動画視聴への誘導による成果報酬 |
| SSP広告（AdMax等） | アクセス増加後の補助収益として追加 |

---

## 2. 現状（2026年5月13日時点）

### 2.1 実装済み・確認済みの部分

| 対象 | 状態 |
|------|------|
| フロントエンド（Next.js） | Vercelにデプロイ済み・表示動作確認済み |
| バックエンドAPI（FastAPI） | Railwayにデプロイ済み・`/api/v1/feed` レスポンス確認済み |
| フロント↔API疎通 | `NEXT_PUBLIC_API_BASE_URL` をVercel環境変数に設定・接続確認済み |
| 年齢確認 middleware | `apps/web/middleware.ts` で全ページ強制リダイレクト実装済み |
| 年齢確認ページ | `apps/web/app/age-gate/` 実装済み。確認後はcookieで記憶 |
| TikTok風フィードUI | `FeedClient.tsx` に仮想スクロール（translateY方式）実装済み |
| `FeedItem.tsx` | `apps/web/components/FeedItem.tsx` に実装済み（22KB） |
| Header・ハンバーガーメニュー | `Header.tsx`・`HamburgerMenu.tsx` 実装済み |
| アフィリエイト通知 | `AffiliateNotice.tsx` 実装済み |
| 計測コンポーネント | `components/analytics/affiliate-link.tsx`・`detail-view-tracker.tsx`・`age-gate-form.tsx` 実装済み |
| APIクライアント層 | `lib/api/feed.ts`・`movies.ts`・`search.ts`・`tags.ts` 実装済み |
| feedOrder管理 | `lib/feedOrder.ts`（seed生成・既読管理）実装済み |
| DBモデル（ORM） | `movies`・`actresses`・`genres`・`series`・`events` の SQLAlchemy モデル実装済み |
| Pydanticスキーマ | `MovieCard`・`MovieDetail`・`PriceList` 実装済み |
| APIエンドポイント | `health`・`feed`・`movies`・`search`・`tags` 実装済み（`genres`・`performers` は空ファイル） |
| `events` DBモデル | `view`・`detail_click`・`affiliate_click` の記録構造実装済み |
| Docker Compose | `infra/docker/docker-compose.yml` 存在 |
| モノレポ構成 | `apps/web`・`apps/api`・`apps/jobs` の3層分離済み |
| `.gitignore`・`.env.example` | 除外設定・環境変数テンプレート整備済み |
| `apps/web/app/privacy/` | ディレクトリ存在（`page.tsx` 未実装） |
| `apps/web/app/law/` | ディレクトリ存在（`page.tsx` 未実装） |
| `apps/web/app/movies/` | 作品詳細ページ ディレクトリ存在 |
| `apps/web/app/search/` | 検索ページ ディレクトリ存在 |
| `apps/web/app/contact/` | お問い合わせページ ディレクトリ存在 |
| `apps/jobs/Dockerfile` | 空ファイルで存在 |
| `apps/jobs/src/` | `sync_catalog.py`・`backfill_slugs.py`・`rebuild_cache.py`・`recompute_rankings.py`・`generate_related.py` が空ファイルで存在 |

### 2.2 未実装・課題

| 対象 | 状態 | 優先度 |
|------|------|--------|
| `/privacy` ページ本文 | ディレクトリのみ・`page.tsx` 未実装（FANZA審査必須） | 🔴 高 |
| `/law` ページ本文 | ディレクトリのみ・`page.tsx` 未実装（FANZA審査必須） | 🔴 高 |
| 独自ドメイン | `vercel.app` ドメイン（審査落ちリスク） | 🔴 高 |
| コンテンツ量 | 本物データ未投入。FANZA審査には不十分 | 🔴 高 |
| FANZA API連携バッチ | `apps/jobs/src/sync_catalog.py` が空ファイル | 🔴 高 |
| Alembicマイグレーション | `apps/api/` 内にマイグレーション管理が未整備 | 🟡 中 |
| `apps/api/Dockerfile` | 存在しない | 🟡 中 |
| `apps/jobs/Dockerfile` 中身 | 空ファイル | 🟡 中 |
| `infra/docker/.env.example` | 空ファイル | 🟡 中 |
| `genres`・`performers` エンドポイント | 空ファイル（ルーティング未定義） | 🟡 中 |
| `apps/web/app/search/` | ページ実装状況要確認 |🟡 中 |
| `apps/web/app/movies/` | 詳細ページ実装状況要確認 | 🟡 中 |
| イベント計測のAPI送信 | DBモデルはあるが、フロントからのPOST送信・APIエンドポイントが未確認 | 🟡 中 |
| Redis キャッシュ | Phase 3以降 | 🟢 低 |
| `apps/web/Dockerfile` | Phase 3以降 | 🟢 低 |

---

## 3. 機能要件

### 3.1 フロントエンド（apps/web）

#### 実装済み機能

- **TikTok風縦スクロールUI**（`FeedClient.tsx` + `FeedItem.tsx`）
  - 仮想スクロール方式（`translateY` による位置制御）。`scroll-snap` は使用していない
  - 表示ウィンドウサイズ: 前後2件（`WINDOW_SIZE = 2`）。先読み: 8件先（`PREFETCH_AHEAD = 8`）
  - タッチ操作（スワイプ）・マウスホイール両対応
  - `sample_movie_url` が存在する場合は動画を全画面表示、ない場合はサムネイル（`image_url_large`）にフォールバック
  - 下部オーバーレイ: ジャンルバッジ・タイトル（2行クランプ）・女優名・CTAボタン
  - CTAボタン: 「詳細を見る」「購入する →」（`affiliate_url` 使用）
  - seedベースのランダム順表示 + 既読管理（`lib/feedOrder.ts`）
  - ページマウント時にclientサイドで seed を生成して即時フェッチ（SSRでの初期データ取得なし）

- **年齢確認フロー**
  - `middleware.ts` で全ページアクセスを遮断
  - `age-gate/` ページで確認 → cookie に記録 → フルナビゲーションで遷移（`location.href` 使用）

- **Header・ナビゲーション**
  - `Header.tsx`（固定ヘッダー、`--header-h: 52px`）
  - `HamburgerMenu.tsx`（ドロワーメニュー）

- **計測（analytics）**
  - `components/analytics/affiliate-link.tsx`: アフィリエイトリンクのクリック計測
  - `components/analytics/detail-view-tracker.tsx`: 詳細ページの閲覧計測
  - `components/analytics/age-gate-form.tsx`: 年齢確認ページの操作計測

- **APIクライアント層**（`lib/api/`）
  - `feed.ts`: フィード取得（`getFeed(cursor, limit, seed)`）
  - `movies.ts`: 作品詳細取得
  - `search.ts`: 検索
  - `tags.ts`: タグ（ジャンル・女優）一覧取得

#### 未実装・要実装機能

- **プライバシーポリシーページ** `/privacy/page.tsx`（FANZA審査必須）
  - 収集情報・利用目的・第三者提供・Cookieポリシーを記載
- **特定商取引法に基づく表記ページ** `/law/page.tsx`（法的必須・FANZA審査必須）
  - 運営者情報・所在地・連絡先・役務の対価等を記載
- **作品詳細ページ** `/movies/[slug]/page.tsx`（実装状況要確認）
- **検索ページ** `/search/page.tsx`（実装状況要確認）
- **お問い合わせページ** `/contact/page.tsx`（実装状況要確認）

#### Phase 2以降の拡張機能

- 女優別ページ `/actresses/[slug]`
- ジャンル別ページ `/genres/[slug]`
- 無限スクロール（現在は手動スワイプ送り）
- OGP・メタタグの動的生成
- `sitemap.xml` の自動生成

### 3.2 バックエンドAPI（apps/api）

#### 実装済みエンドポイント

| メソッド | パス | 状態 |
|----------|------|------|
| GET | `/api/v1/health` | 実装済み |
| GET | `/api/v1/feed` | 実装済み |
| GET | `/api/v1/movies/{slug}` | 実装済み |
| GET | `/api/v1/search` | 実装済み |
| GET/POST | `/api/v1/tags` | 実装済み |

#### 未実装エンドポイント（空ファイル）

| メソッド | パス | 備考 |
|----------|------|------|
| GET | `/api/v1/genres/{slug}` | `genres.py` 空ファイル |
| GET | `/api/v1/performers/{slug}` | `performers.py` 空ファイル |

#### イベント計測API（要確認・実装）

| メソッド | パス | 説明 |
|----------|------|------|
| POST | `/api/v1/events` | `view`・`detail_click`・`affiliate_click` を受け取りDBへ記録 |

> DBモデル（`events` テーブル）は実装済み。フロント→APIのPOST経路と、APIエンドポイント自体の実装が必要。

#### 設計上の重要原則

- DBフィールド・ORMモデル・Pydanticスキーマ・サービス層・レスポンスの5層は**必ず同時にレビュー・更新すること**
- `content_id`（FANZA商品ID）・`product_id`（品番）・`maker_product`（メーカー品番）の3種IDをすべてDBに保持する（将来のデータ突合のため）
- フィールド名の変更は過去に大量のbugを生んだ経緯があるため、命名前に必ずFANZA API実レスポンスと照合する

### 3.3 データ取得バッチ（apps/jobs）

#### スクリプト一覧（全て現時点では空ファイル）

| ファイル | 役割 |
|----------|------|
| `src/sync_catalog.py` | FANZA Web APIから作品データを取得・正規化・DB保存（最優先） |
| `src/backfill_slugs.py` | 既存データへのslug付与・バックフィル |
| `src/rebuild_cache.py` | キャッシュ再構築（Redis導入後） |
| `src/recompute_rankings.py` | ランキングスコア再計算 |
| `src/generate_related.py` | 関連作品データの生成 |

#### `sync_catalog.py` の実装要件

- FANZA Web APIからの作品データ取得
- データ正規化・DB保存
- 重複登録防止（`content_id` による冪等処理）
- `is_visible` フラグ管理（デフォルト `true`）
- 女優（`actresses`）・ジャンル（`genres`）・シリーズ（`series`）の中間テーブル更新
- FANZA APIのフィールド名（`image_url_large`・`sample_movie_url`・`content_id` 等）と直接対応させる

---

## 4. データ構造要件

### 4.1 DBテーブル設計（コード実態ベース）

> **重要**: 以下はコード（`apps/api/app/db/models/`）の実態を正確に反映した定義である。

```text
movies
├── id                  VARCHAR PK（UUID文字列）
├── content_id          VARCHAR UNIQUE nullable（FANZA商品ID）
├── product_id          VARCHAR nullable（品番・流通用）
├── maker_product       VARCHAR nullable（メーカー品番）
├── title               VARCHAR NOT NULL
├── slug                VARCHAR UNIQUE NOT NULL（URL用）
├── description         TEXT DEFAULT ""
├── volume              INTEGER nullable（収録時間・分）
├── image_url_list      VARCHAR nullable（一覧用サムネイル・小）
├── image_url_large     VARCHAR nullable（詳細用サムネイル・大）
├── sample_movie_url    VARCHAR nullable（サンプル動画URL）
├── sample_embed_url    VARCHAR nullable（埋め込み用・互換）
├── affiliate_url       VARCHAR DEFAULT ""
├── affiliate_url_en    VARCHAR nullable（英語向けURL）
├── price_list          JSONB nullable（全価格体系 → PriceList参照）
├── price_min           INTEGER nullable（最安値・ソート用）
├── release_date        DATE nullable（発売日）
├── delivery_date       DATE nullable（配信開始日）
├── rental_start_date   DATE nullable（貸出開始日）
├── primary_date        DATE nullable indexed（表示用日付）
├── review_count        INTEGER DEFAULT 0
├── review_average      NUMERIC(3,2) nullable
├── director_name       VARCHAR nullable
├── label_name          VARCHAR nullable
├── maker_name          VARCHAR nullable
├── series_id           FK → series.id nullable（SET NULL on delete）
├── is_visible          BOOLEAN DEFAULT true
└── （created_at は Base クラスで定義）

actresses
├── id                  INTEGER PK autoincrement
├── content_id          VARCHAR UNIQUE nullable indexed（FANZAのactress_id）
├── name                VARCHAR NOT NULL indexed
├── slug                VARCHAR UNIQUE nullable indexed
└── thumbnail_url       VARCHAR nullable

genres
├── id                  INTEGER PK autoincrement
└── name                VARCHAR UNIQUE NOT NULL indexed

series
├── id                  VARCHAR PK
├── content_id          VARCHAR UNIQUE nullable indexed（FANZAのseries_id）
├── name                VARCHAR NOT NULL
└── slug                VARCHAR UNIQUE NOT NULL indexed

movie_actresses（中間テーブル）
├── movie_id            FK → movies.id（CASCADE）PK
├── actress_id          FK → actresses.id（CASCADE）PK
└── position            INTEGER DEFAULT 0（出演順・0始まり）

movie_genres（中間テーブル）
├── movie_id            FK → movies.id（CASCADE）PK
└── genre_id            FK → genres.id（CASCADE）PK

events
├── id                  VARCHAR PK（UUID文字列）
├── event_type          VARCHAR indexed（"view" | "detail_click" | "affiliate_click"）
├── slug                VARCHAR nullable indexed
├── title               VARCHAR nullable
├── affiliate_url       VARCHAR nullable
├── next_path           VARCHAR nullable
└── created_at          TIMESTAMP WITH TIME ZONE（server_default: now()）
```

### 4.2 APIスキーマ（Pydantic・コード実態ベース）

**PriceList**（`price_list` JSONB カラムの型）
```python
class PriceList(BaseModel):
    list_price:     int | None = None   # 定価
    sale_price:     int | None = None   # セール価格
    rental_price:   int | None = None   # レンタル価格
    delivery_price: int | None = None   # 配信価格
```

**MovieCard**（フィード・一覧用・軽量）
```python
class MovieCard(BaseModel):
    id:               str
    content_id:       str | None = None
    title:            str
    slug:             str
    image_url_list:   str | None = None
    image_url_large:  str | None = None
    sample_movie_url: str | None = None
    affiliate_url:    str
    price_list:       PriceList | None = None
    price_min:        int | None = None
    review_count:     int = 0
    review_average:   float | None = None
    actresses:        list[str] = []
    genres:           list[str] = []
    series_name:      str | None = None
```

**MovieDetail**（作品詳細ページ用）
```python
class MovieDetail(BaseModel):
    id:                 str
    content_id:         str | None = None
    product_id:         str | None = None
    maker_product:      str | None = None
    title:              str
    slug:               str
    description:        str = ""
    volume:             int | None = None
    image_url_list:     str | None = None
    image_url_large:    str | None = None
    sample_movie_url:   str | None = None
    sample_embed_url:   str | None = None
    affiliate_url:      str
    price_list:         PriceList | None = None
    price_min:          int | None = None
    release_date:       str | None = None
    delivery_date:      str | None = None
    rental_start_date:  str | None = None
    primary_date:       str | None = None
    review_count:       int = 0
    review_average:     float | None = None
    director_name:      str | None = None
    label_name:         str | None = None
    maker_name:         str | None = None
    actresses:          list[str] = []
    genres:             list[str] = []
    series_name:        str | None = None
```

**FeedResponse**
```python
class FeedResponse(BaseModel):
    items:       list[MovieCard]
    next_cursor: str | None
```

> `actresses` と `genres` は当面 `list[str]`（名前のみ）で運用。女優・ジャンルページ実装時に `list[ActressCard]` / `list[GenreCard]` へ移行する。

---

## 5. 非機能要件

### 5.1 インフラ・コンテナ化方針

全アプリをDockerコンテナで動作させることを前提とする。ローカル開発・本番環境ともにDockerで統一し、AWS移行時の摩擦を最小化する。

#### コンテナ化方針

| アプリ | Dockerfile | ローカル実行 | 本番（現在） | 本番（最終目標） |
|--------|------------|--------------|--------------|-----------------|
| `apps/api` | **未作成（要対応）** | `infra/docker/docker-compose.yml` | Railway | AWS ECS Fargate |
| `apps/jobs` | 空ファイル（要実装） | `infra/docker/docker-compose.yml` | 手動実行 | AWS Batch / ECS Tasks |
| `apps/web` | Phase 3で作成 | `pnpm dev` | Vercel | AWS App Runner / ECS Fargate |
| `db`（PostgreSQL） | 公式イメージ使用 | `infra/docker/docker-compose.yml` | Railway PostgreSQL | AWS RDS Aurora |

#### ローカル開発構成

`infra/docker/docker-compose.yml` でAPIとDBをコンテナ起動。環境変数は `infra/docker/.env.example`（現在空ファイル）から `.env` を生成して注入する。

- Alembicマイグレーションもコンテナ内で実行（ホストPython環境への依存禁止）
- コードに環境変数を直書き禁止

### 5.2 AWS移行設計原則

| 現在 | 将来（AWS） | 役割 |
|------|------------|------|
| Railway | AWS ECS Fargate | `apps/api` |
| 手動実行 | AWS Batch / ECS Tasks | `apps/jobs` |
| Vercel | AWS App Runner / ECS Fargate | `apps/web` |
| Railway PostgreSQL | AWS RDS Aurora | DB |
| なし | AWS ElastiCache（Redis） | キャッシュ（Phase 3） |
| なし | AWS S3 | ストレージ |
| GitHub Actions | GitHub Actions | CI/CD |

### 5.3 パフォーマンス

- フィードのレスポンスタイム: 500ms 以内（キャッシュなし）
- 画像: 先頭アイテムは `loading="eager"`、それ以外は `loading="lazy"`
- ページネーション: カーソルベース（オフセットページングは禁止）
- 動画: 先頭アイテムのみ `preload="auto"`。それ以外は `preload="none"`（帯域節約）
- 仮想スクロール: DOMに保持するのは現在位置の前後2件のみ

### 5.4 セキュリティ・法的要件

- 年齢確認: 全ページで `middleware.ts` によるリダイレクト必須（**実装済み**）
- **プライバシーポリシー**: `/privacy` ページとして公開必須（**未完成・最優先**）
- **特定商取引法に基づく表記**: `/law` ページとして公開必須（**未完成・最優先**）
- FANZAアフィリエイト規約の遵守（広告表記・リンク形式）
- `is_visible` フラグによる即時非表示機能（違反コンテンツへの対応）
- APIキー・シークレットはAWS Secrets Manager（本番）または環境変数（ローカル）で管理
- コンテナイメージはrootレスユーザーで実行

### 5.5 SEO

- Next.js SSRによるページレンダリング（SPAでのSSR省略禁止）
- 女優名・ジャンル名をURLに含める（`/actresses/[slug]`・`/genres/[slug]`）
- OGP・メタタグの動的生成（Phase 2以降）
- `sitemap.xml` の自動生成（Phase 2以降）

---

## 6. 計測要件

### フロント計測（実装済みコンポーネント）

| イベント名 | コンポーネント | 発火タイミング |
|------------|----------------|----------------|
| `affiliate_click` | `components/analytics/affiliate-link.tsx` | アフィリエイトリンクをクリックした時 |
| `detail_click` | `components/analytics/detail-view-tracker.tsx` | 詳細ページを閲覧した時 |
| 年齢確認操作 | `components/analytics/age-gate-form.tsx` | 年齢確認ページで操作した時 |

### DB記録（`events` テーブル）

`event_type`・`slug`・`title`・`affiliate_url`・`next_path`・`created_at` を記録する。フロントから `/api/v1/events` へ POST して記録する経路の実装が必要。

### Phase 2以降の計測拡張

| イベント名 | 発火タイミング |
|------------|----------------|
| `view` | 作品がスクロールで画面内に表示された時 |
| `video_start` | `sample_movie_url` の再生開始時 |
| `video_complete` | 一定視聴率または再生完了時 |

---

## 7. 開発ロードマップ

### Phase 1：FANZA審査通過（最優先・現在進行中）

| タスク | 内容 | 状態 |
|--------|------|------|
| TikTok風フィードUI | `FeedClient.tsx` + `FeedItem.tsx` | ✅ 完了 |
| フロント↔API疎通 | `NEXT_PUBLIC_API_BASE_URL` 設定・接続確認 | ✅ 完了 |
| 年齢確認 middleware | 全ページリダイレクト | ✅ 完了 |
| DBモデル実装 | `movies`・`actresses`・`genres`・`series`・`events` | ✅ 完了 |
| Pydanticスキーマ実装 | `MovieCard`・`MovieDetail`・`PriceList` | ✅ 完了 |
| 計測コンポーネント | `analytics/` ディレクトリ | ✅ 完了 |
| `/privacy` ページ実装 | `privacy/page.tsx` の中身を実装・公開 | ⬜ 未着手 |
| `/law` ページ実装 | `law/page.tsx` の中身を実装・公開 | ⬜ 未着手 |
| 独自ドメイン取得 | `vercel.app` からカスタムドメインへ切り替え | ⬜ 未着手 |
| コンテンツ投入 | `sync_catalog.py` 実装 → 実データをDBに保存 | ⬜ 未着手 |
| `apps/api/Dockerfile` 作成 | Dockerfileとcompose整備 | ⬜ 未着手 |
| イベント計測APIエンドポイント | `POST /api/v1/events` 実装 | ⬜ 未着手 |
| Alembicマイグレーション整備 | マイグレーション管理・初期DDL適用 | ⬜ 未着手 |
| FANZA審査申請 | 上記完了後に申請 | ⬜ 未着手 |

### Phase 2：コンテンツ量の確保と品質向上（審査通過後）

| タスク | 内容 |
|--------|------|
| `sync_catalog.py` の定期実行化 | FANZA APIバッチの定期自動実行 |
| `apps/jobs/Dockerfile` 実装 | Dockerfileの中身を実装 |
| `/movies/[slug]` 詳細ページ | 実装状況確認・完成 |
| `/search` 検索ページ | 実装状況確認・完成 |
| `genres`・`performers` エンドポイント | 空ファイルへの実装 |
| 女優・ジャンル別ページ | `/actresses/[slug]`・`/genres/[slug]` |
| OGP・メタタグ動的生成 | SNSシェア最適化 |
| `sitemap.xml` 自動生成 | 作品・女優・ジャンルページ対象 |

### Phase 3：SEOと流入の強化（1〜2ヶ月後）

| タスク | 内容 |
|--------|------|
| Redisキャッシュ | フィードAPIのレスポンス高速化 |
| `apps/web/Dockerfile` 整備 | AWS App Runner向け検証 |
| `infra/docker/.env.example` 整備 | 空ファイルに実際の変数を追記 |
| 計測拡張 | `view`・`video_start`・`video_complete` イベント追加 |

### Phase 4：AWS移行と自動化（3ヶ月後以降）

| タスク | 内容 |
|--------|------|
| AWS移行 | ECS Fargate（api・web）・AWS Batch（jobs）・RDS Aurora（DB） |
| Terraform整備 | `infra/terraform/` にIaCコード管理 |
| データ取得の自動スケジューリング | AWS EventBridge + Batch |
| ABテスト | CTAボタン文言・UI配置の最適化 |
| AIによる説明文生成 | 作品説明文の自動生成・SEO強化 |

---

## 8. 技術スタック

| レイヤー | 技術 | 備考 |
|----------|------|------|
| フロントエンド | Next.js（TypeScript） | SSR必須・Vercel（現在）→ AWS App Runner（最終） |
| 公開API | FastAPI（Python） | Railway（現在）→ AWS ECS Fargate（最終） |
| バッチ | Python | 手動実行（現在）→ AWS Batch（最終） |
| DB | PostgreSQL | Docker（開発）→ Railway（中期）→ AWS RDS Aurora（最終） |
| キャッシュ | Redis | Phase 3以降 → AWS ElastiCache（最終） |
| コンテナ管理 | Docker + Docker Compose | `infra/docker/docker-compose.yml` |
| IaC | Terraform | Phase 4以降（`infra/terraform/`） |
| CI/CD | GitHub Actions | `.github/` ディレクトリ |
| パッケージ管理 | pnpm workspace（モノレポ） | |

---

## 9. ディレクトリ構成（コード実態ベース）

```text
short-video-media/
├── apps/
│   ├── api/
│   │   ├── Dockerfile                    ← 未作成（Phase 1で作成）
│   │   └── app/
│   │       ├── main.py
│   │       ├── api/v1/
│   │       │   ├── api.py
│   │       │   └── endpoints/
│   │       │       ├── health.py         ← 実装済み
│   │       │       ├── feed.py           ← 実装済み
│   │       │       ├── movies.py         ← 実装済み
│   │       │       ├── search.py         ← 実装済み
│   │       │       ├── tags.py           ← 実装済み
│   │       │       ├── genres.py         ← 空ファイル
│   │       │       └── performers.py     ← 空ファイル
│   │       ├── db/
│   │       │   ├── base.py
│   │       │   ├── session.py
│   │       │   └── models/
│   │       │       ├── movie.py          ← 実装済み（MovieCard, MovieActress, MovieGenre）
│   │       │       ├── actress.py        ← 実装済み
│   │       │       ├── genre.py          ← 実装済み
│   │       │       ├── series.py         ← 実装済み
│   │       │       └── event.py          ← 実装済み
│   │       ├── schemas/
│   │       │   ├── movie.py              ← 実装済み（PriceList・MovieCard・MovieDetail）
│   │       │   ├── feed.py               ← 実装済み（FeedResponse）
│   │       │   ├── search.py             ← 実装済み
│   │       │   ├── genre.py              ← 空ファイル
│   │       │   └── performer.py          ← 空ファイル
│   │       ├── services/
│   │       ├── repositories/
│   │       ├── dependencies/
│   │       ├── core/
│   │       └── mock_data/
│   ├── jobs/
│   │   ├── Dockerfile                    ← 空ファイル（Phase 1で実装）
│   │   ├── pyproject.toml                ← 空ファイル
│   │   ├── src/
│   │   │   ├── sync_catalog.py           ← 空ファイル（Phase 1・最優先）
│   │   │   ├── backfill_slugs.py         ← 空ファイル
│   │   │   ├── rebuild_cache.py          ← 空ファイル
│   │   │   ├── recompute_rankings.py     ← 空ファイル
│   │   │   └── generate_related.py       ← 空ファイル
│   │   └── tests/
│   └── web/
│       ├── middleware.ts                  ← 実装済み（年齢確認リダイレクト）
│       ├── next.config.ts
│       ├── .env.local.example
│       ├── app/
│       │   ├── page.tsx                  ← 実装済み（FeedClientを呼び出すのみ）
│       │   ├── FeedClient.tsx            ← 実装済み（仮想スクロール・メイン実装）
│       │   ├── globals.css               ← ベーススタイル
│       │   ├── layout.tsx
│       │   ├── error.tsx
│       │   ├── not-found.tsx
│       │   ├── loading.tsx
│       │   ├── age-gate/                 ← 実装済み
│       │   ├── movies/                   ← 実装状況要確認
│       │   ├── search/                   ← 実装状況要確認
│       │   ├── contact/                  ← 実装状況要確認
│       │   ├── api/                      ← Route Handler
│       │   ├── privacy/                  ← ディレクトリのみ（page.tsx 未実装）
│       │   └── law/                      ← ディレクトリのみ（page.tsx 未実装）
│       ├── components/
│       │   ├── FeedItem.tsx              ← 実装済み（22KB）
│       │   ├── Header.tsx                ← 実装済み
│       │   ├── HamburgerMenu.tsx         ← 実装済み
│       │   ├── AffiliateNotice.tsx       ← 実装済み
│       │   ├── BackButton.tsx            ← 実装済み
│       │   └── analytics/
│       │       ├── affiliate-link.tsx    ← 実装済み
│       │       ├── detail-view-tracker.tsx ← 実装済み
│       │       └── age-gate-form.tsx     ← 実装済み
│       └── lib/
│           ├── feedOrder.ts              ← 実装済み（seed・既読管理）
│           ├── api/
│           │   ├── feed.ts               ← 実装済み
│           │   ├── movies.ts             ← 実装済み
│           │   ├── search.ts             ← 実装済み
│           │   └── tags.ts               ← 実装済み
│           ├── analytics/
│           └── config/
├── infra/
│   └── docker/
│       ├── docker-compose.yml            ← 存在（中身要確認）
│       └── .env.example                  ← 空ファイル（Phase 1で整備）
├── docs/
│   └── requirements_definition_v4_0.md  ← 本ファイル
├── scripts/
├── packages/
├── Makefile
├── pnpm-workspace.yaml
├── package.json
└── .github/
    └── workflows/
```

---

## 10. 制約・前提条件

- FANZAアフィリエイト審査が通過していない間は本物のアフィリエイトリンクを使用できない
- FANZA Web APIの利用にはアフィリエイト審査通過が必要
- アダルトコンテンツのため、Google AdSenseは利用不可（SSP広告はAdMax等を使用）
- 18歳未満へのアクセスを防ぐ年齢確認機能は法的要件として必須
- **プライバシーポリシー・特定商取引法表記はFANZA審査前に必ず公開すること**
- **独自ドメイン取得を審査申請前に完了すること（`vercel.app` での申請は審査落ちリスクあり）**
- **全ての環境変数・シークレットはコードに直書き禁止。`.env` または Secrets Manager経由で管理する**
- **コンテナはrootレスユーザーで実行する（セキュリティ要件）**
- **DBフィールド名は必ずFANZA API実レスポンスのキー名と照合してから確定すること。命名ミスは過去に大量のbugを生んだ**
- **DBモデル・ORM・Pydanticスキーマ・サービス層・APIレスポンスの5層は必ず同時にレビュー・更新すること**
