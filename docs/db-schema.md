# DB スキーマ概要

> **正本**: 各テーブルの全カラムは `apps/api/app/db/models/*.py` の SQLAlchemy 定義を参照。
> マイグレーション履歴は `apps/api/alembic/versions/` を参照。

## テーブル一覧

| テーブル | 主用途 | 主要カラム |
|---------|-------|----------|
| `movies` | 作品マスタ (DMM 由来) | `id` (DMM `content_id`), `slug`, `title`, `affiliate_url`, `sample_movie_url`, `price_list_json`, `release_date`, `review_count`, `review_average` |
| `actresses` | 女優マスタ | `id`, `name`, `slug`, `ruby`, `thumbnail_url`, `image_url_large`, `bust`, `cup`, `waist`, `hip`, `height`, `birthday`, `blood_type`, `hobby`, `prefectures`, `dmm_list_url` |
| `genres` | ジャンル / フロア擬似ジャンル | `id`, `name`, `slug` |
| `series` | シリーズ | `id`, `name`, `slug` |
| `movie_actresses` | 多対多 | `movie_id`, `actress_id` |
| `movie_genres` | 多対多 | `movie_id`, `genre_id` |
| `users` | ユーザー (Auth.js 連動) | `id`, `created_at` |
| `identities` | provider sub のハッシュ保持 | `user_id`, `provider`, `sub_hash` (SHA-256), `created_at` |
| `bookmarks` | お気に入り | `user_id`, `movie_id`, `created_at` |
| `view_histories` | 視聴履歴 | `user_id`, `movie_id`, `viewed_at` |
| `events` | 計測イベント (view/play/affiliate_click/search/share) | `event_type`, `slug`, `title`, `affiliate_url`, `next_path`, `search_query`, `created_at` |

## 重要な設計判断

### タイムスタンプ
- 全テーブル `TIMESTAMP WITHOUT TIME ZONE` (Railway Postgres デフォルト)
- アプリケーション側は **常に UTC** で `datetime.now(timezone.utc).replace(tzinfo=None)` を渡す

### 認証 (PII 非保持)
- `identities.sub_hash = SHA-256(provider:sub:APP_USER_SALT)`
- provider の email / name / image は **DB に一切保存しない**
- `APP_USER_SALT` のローテーション手順は [`environments.md`](./environments.md#app_user_salt-のローテーション) を参照

### アフィリエイト URL
- 旧来の `al.fanza.co.jp` リダイレクタは新規アカウントでは無効。
- `affiliate_url` は `dmm.co.jp` 直で `af_id=<id>&ch=link_tool&ch_id=link` クエリを付与する形に統一。

### MP4 URL の二系統
- 旧形式: `https://cc3001.dmm.co.jp/litevideo/freepv/...mp4` (sync_catalog のデフォルトプローブ)
- 新形式: `https://cc3001.dmm.co.jp/pv/<token>/...mp4` (Playwright 抽出)
- API の `sample-url` エンドポイントの正規表現は両形式を受け入れる

## マイグレーション運用

- 開発時: `alembic revision --autogenerate -m "..."` でドラフト生成 → 手動で整形
- 本番: デプロイ時に `scripts/deploy-xserver.sh` が (docker compose up の前に) `docker compose run --rm api alembic upgrade head` を実行する (専用の `migrate.yml` ワークフローは存在しない)
- ローカル: `pnpm --filter @short-video-media/api run db:migrate`
