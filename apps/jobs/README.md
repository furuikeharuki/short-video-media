# apps/jobs

DMM (FANZA) API からカタログを定期取得して DB に同期するバッチジョブ群。

## 構成

```
apps/jobs/
├── pyproject.toml
├── README.md
├── src/
│   ├── __init__.py
│   ├── sync_catalog.py        # ★ DMM ItemList API から作品を取得
│   ├── sync_video_urls.py     # ★ サンプル動画 MP4 URL を DB に事前保存 (月次)
│   ├── backfill_slugs.py      # (将来) slug 欠落作品を埋める
│   ├── generate_related.py    # (将来) 関連作品を生成
│   ├── rebuild_cache.py       # (将来) Redis キャッシュを再構築
│   └── recompute_rankings.py  # (将来) ランキングを再計算
└── tests/
    └── test_smoke.py
```

## sync_catalog.py

1 時間ごとに DMM ItemList API から最新の作品データを取得し、DB に upsert する。

### 対象フロア

| site | service | floor | 内容 |
|------|---------|-------|------|
| FANZA | digital | videoa | ビデオ (単体女優物) |
| FANZA | digital | videoc | アマチュア |
| FANZA | mono    | goods  | 女優グッズ |

### 並び順

`sort=date` (配信開始日 desc) で常に最新を取りに行く。

### 環境変数

#### 必須

| 変数 | 説明 |
|------|------|
| `DMM_API_ID` | DMM アフィリエイト管理画面で発行する API ID |
| `DMM_AFFILIATE_ID` | DMM のアフィリエイト ID (`xxxxxx-990` の形式) |
| `DATABASE_URL` | Postgres 接続文字列 (Public URL) |

#### 定期実行 (cron) で取得対象を切り替える設定 (任意)

CLI フラグが指定されていないときに限り、以下の環境変数を見にいく。
未設定なら従来通りハードコードされたデフォルトを使う。
**CLI > 環境変数 > ハードコード default** の優先順位。

**設計方針**: cron は常に「最新を取り続ける」運用のため、固定日付 (`YYYY-MM-DD`)
を受け付ける env はあえて用意していない。古い日付に固定されたまま放置されると
新着取りこぼしの事故になるため。
固定日付の範囲指定取得 (full モード / `--gte-date` / `--lte-date`) は
ブートストラップ / 手動バックフィル時に **CLI フラグで明示的に** 指定する。
GitHub Actions の cron は workflow ファイル側で `--mode incremental` を固定で
渡しているため、env から偶発的に full モードへ切り替わる事故も起きない。

`sync_catalog` (`jobs-sync-catalog.yml` が cron で叩く):

| 変数 | 型 | デフォルト | 説明 |
|------|----|----------|------|
| `SYNC_CATALOG_HITS` | int (≥1) | `100` | 1 フロアあたり取得件数 |
| `SYNC_CATALOG_FLOORS` | カンマ区切り | `videoa,videoc` | 対象フロア (`videoa` / `videoc` / `goods`) |
| `SYNC_CATALOG_LOOKBACK_DAYS` | int (≥1) | (なし) | 起動時に「今日 - N 日」を `gte_date` として渡す相対値。固定日付ではなく毎回再計算されるため、cron で運用しても古い日付に固定されない。 |
| `SYNC_CATALOG_DRY_RUN` | `1` / `0` / `true` / `false` | `0` | 1 で DB に書かない |

`sync_actress_profiles` (`jobs-sync-actress.yml` が cron で叩く):

| 変数 | 型 | デフォルト | 説明 |
|------|----|----------|------|
| `SYNC_ACTRESS_LIMIT` | int (≥1) | (無制限) | 処理件数上限 |
| `SYNC_ACTRESS_ONLY_MISSING` | `1` / `0` / `true` / `false` | `0` | 1 で欠落フィールドだけ更新 |
| `SYNC_ACTRESS_DRY_RUN` | `1` / `0` / `true` / `false` | `0` | 1 で DB に書かない |

不正値 (int に変換できない / 未知の floor / 不正な日付フォーマット) は起動時に
`SystemExit` で停止し、cron が静かに失敗しないようにしている。値が解決された後は
`[sync_catalog] resolved config: ...` ログを出す。

##### 設定例

VPS の `infra/xserver/.env` に書く例:

```env
# cron で goods フロアも含めて 1 フロアあたり 200 件ずつ取る
SYNC_CATALOG_FLOORS=videoa,videoc,goods
SYNC_CATALOG_HITS=200

# 直近 7 日の発売作品は念のため毎回再取得する (相対値なので日付が固定化されない)
SYNC_CATALOG_LOOKBACK_DAYS=7

# 女優プロフィール更新は欠落フィールドのみ
SYNC_ACTRESS_ONLY_MISSING=1
```

##### 手動バックフィル (cron 用ではない)

固定日付で過去ぶんを取り直す場合は、env ではなく CLI フラグを直接渡す:

```bash
# 2024 年だけ全件再取得
python -m src.sync_catalog --mode full --start-date 2024-01-01 --end-date 2024-12-31

# 2025-05-01 以降の incremental だけ
python -m src.sync_catalog --mode incremental --gte-date 2025-05-01
```

### 使い方

```bash
# 全フロア各 100 件 (デフォルト)
cd apps/jobs
python -m src.sync_catalog

# 1 フロア 50 件ずつ
python -m src.sync_catalog --hits 50

# 特定フロアだけ
python -m src.sync_catalog --floors videoa,goods

# DB に書かずに動作確認
python -m src.sync_catalog --dry-run
```

### 動作

- 1 リクエスト最大 100 件 (DMM 仕様)。`--hits` がそれより大きい場合は offset でページング。
- rate limit 配慮で 1 秒に 1 リクエスト。
- `content_id` をユニークキーとして UPSERT。
- 関連エンティティ (ジャンル / 女優 / シリーズ) も併せて登録。
- 既存カラムが空のときだけ補完して上書きしないため、女優プロフィール
  (`sync_actress_profiles.py` で入った情報) は壊さない。

### GitHub Actions cron

`.github/workflows/sync-catalog.yml` で 1 時間ごとに実行。

## sync_video_urls.py (サンプル動画 MP4 URL の DB キャッシュ)

サンプル動画の MP4 直リンク (低画質 / 高画質) を事前に抽出して DB に保存する
バッチ。`movies.sample_mp4_url` / `sample_low_mp4_url` / `sample_high_mp4_url` /
`sample_mp4_resolved_at` を埋める。

### なぜ必要か

- 再生時に毎回 resolver で抽出すると高画質再生までのレイテンシが大きい。
- そこで「低画質・高画質ともに DB に保存 → 再生時 (API `/resolve-mp4` / フィード)
  は DB 値を即返す。DB に無い / 再生できない (`force=true`) ときだけ resolver で
  抽出して DB を更新する」方式にした。
- DMM のサンプル URL は署名付き (トークン ~32 日有効)。月 1 で貼り直せば
  期限切れは実質起きない。

### 対象

- `is_visible=True` かつ `content_id` を持つ作品 (review_count 降順)。
- 既定 (`--only-missing`) は URL 未保存の作品だけ (差分 / 初回バックフィル)。
- `--force` で全作品を再抽出して貼り直す (月次フルリフレッシュ; `--only-missing` を無効化)。

### 環境変数

`sync_video_urls` (`jobs-sync-video-urls.yml` が月次で叩く):

| 変数 | 型 | デフォルト | 説明 |
| --- | --- | --- | --- |
| `SYNC_VIDEO_URLS_LIMIT` | int (≥1) | (無制限) | 処理件数上限 |
| `SYNC_VIDEO_URLS_ONLY_MISSING` | `1` / `0` / `true` / `false` | `true` | URL 未保存の作品だけ処理 |
| `SYNC_VIDEO_URLS_FORCE` | `1` / `0` / `true` / `false` | `false` | 全作品を再抽出して貼り直す (only_missing を無効化) |
| `SYNC_VIDEO_URLS_DRY_RUN` | `1` / `0` / `true` / `false` | `false` | 1 で DB に書かない |
| `SYNC_VIDEO_URLS_CONCURRENCY` | int (≥1) | `3` | 同時抽出数 (DMM 負荷を抑えるため低め) |

resolver が DMM を叩くため `DMM_AFFILIATE_ID` が必須。

### 使い方

```bash
# URL 未保存の作品を埋める (差分)
python -m src.sync_video_urls

# 全作品を再抽出して貼り直す (月次フルリフレッシュ)
python -m src.sync_video_urls --force

# 先頭 500 件だけ / DB に書かずログだけ
python -m src.sync_video_urls --limit 500
python -m src.sync_video_urls --dry-run
```

### GitHub Actions cron

`.github/workflows/jobs-sync-video-urls.yml` が毎月 1 日 18:00 UTC
(= 毎月 2 日 03:00 JST) に SSH → VPS で `docker compose run --rm jobs` として
`--force` 付きで実行する。他ジョブ (catalog / actress) と時間帯が重ならないよう
調整してある。

## post_to_x.py (X 自動投稿ボット)

AV Shorts の流入施策として、自分の X (旧 Twitter) アカウントへ定期的に
誘導ポストを投稿する。`.github/workflows/x-post-bot.yml` が cron で叩く。

### 何を投稿するか

公開 API (`GET /api/v1/home`) からサイト内の人気・新着コンテンツを取得し、
以下のいずれかへの誘導ポストを 1 回の実行で **1 件だけ** 投稿する:

| 種別 | 誘導先 (canonical URL) |
|------|------------------------|
| **フィード (feed)** ★最多 | `https://av-shorts.com/feed?v={slug}` |
| 作品 (movie)   | `https://av-shorts.com/movies/{slug}` |
| 女優 (actress) | `https://av-shorts.com/actresses/{name}` |
| ジャンル (genre) | `https://av-shorts.com/genres/{name}` |

種別は日付 + スロット番号で決定的にローテーションする (`post_candidates.rotate_kind`)。
流入施策の主役である **縦スクロール試し見フィード (`/feed?v=<slug>`) を最多 (約 70%)** に
投稿し、残りを作品詳細・女優・ジャンルへ振り分ける (`_ROTATION_PATTERN`、10 スロット中
7 枠が feed)。feed の `v` パラメータは作品 slug (= content_id、例 `miaa00574`) で、
フロントは `getMovieBySlug` で解決してその動画を先頭に差し込む。`?v=` を先に置き、
UTM はその後ろに付ける (`?v=<slug>&utm_source=x&utm_medium=social&utm_campaign=bot`)。
本文テンプレートも種別ごとに複数用意し、決定的に選ぶことで同一文面・同一 URL の連投を
避ける (永続ストレージ不要。feed が連続するスロットでもリスト内 offset で別動画になる)。

### 安全策

- **自アカウントへの通常ポストのみ**。リプライ / メンション / DM / フォロー等、
  他人に作用する操作は実装していない (`x_client.py` は `POST /2/tweets` だけ)。
- 本文に半角 `@` を入れない。女優名等に `@` が含まれても全角 `＠` に置換する
  (`post_templates.sanitize_text`)。
- ハッシュタグは乱用しない (初期実装では一切付けない)。
- URL は必ず canonical な `https://av-shorts.com/...`。軽量 UTM
  (`utm_source=x&utm_medium=social&utm_campaign=bot`) のみ付与。
- 末尾に `※18歳未満閲覧禁止` を付ける。
- 280 文字を超える本文は投稿前に弾く。

### 環境変数 (GitHub Secrets)

本番投稿時は以下 4 点を設定する。**1 つでも欠けていれば自動で dry-run** に
切り替わり、本文だけログ出力する (静かな失敗ではなく明示ログを出す)。

| 変数 | 説明 |
|------|------|
| `X_API_KEY` | X Developer Portal の API Key (Consumer Key) |
| `X_API_SECRET` | API Key Secret (Consumer Secret) |
| `X_ACCESS_TOKEN` | Access Token (自アカウントに Read and Write 権限で発行) |
| `X_ACCESS_TOKEN_SECRET` | Access Token Secret |

任意:

| 変数 | デフォルト | 説明 |
|------|----------|------|
| `X_BOT_API_BASE_URL` | `https://av-shorts-api.com` | 公開 API のベース URL |
| `X_BOT_DRY_RUN` | `0` | `1`/`true` で投稿せず本文だけ出力 |
| `X_BOT_SLOT` | `0` | その日の投稿スロット番号 (ローテーション用) |

### スケジュール

`x-post-bot.yml` の cron は控えめに 1 日 2 回:

- `10 3 * * *`  = 12:10 JST (昼、slot=0)
- `10 12 * * *` = 21:10 JST (夜、slot=1)

`workflow_dispatch` から手動実行でき、`dry_run` 入力 (デフォルト `true`) で
投稿せず本文だけ確認できる。

### 使い方

```bash
cd apps/jobs
python -m src.post_to_x --dry-run           # 投稿せず本文だけ表示
python -m src.post_to_x --slot 1 --dry-run  # スロット 1 の候補を確認
python -m src.post_to_x                       # Secrets が揃っていれば実投稿
```

## 定期実行が増えたら

- `sync_catalog`: 1 時間ごと (新着取得)
- `sync_video_urls`: 月 1 (サンプル動画 MP4 URL を DB に貼り直す)
- `rebuild_cache`: 30 分ごと (Redis ランキング再構築)
- `recompute_rankings`: 日次 (DB 上の集計テーブル更新)
- `generate_related`: 日次 (関連作品ベクトル更新)
