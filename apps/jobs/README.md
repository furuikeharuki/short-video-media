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

## 定期実行が増えたら

- `sync_catalog`: 1 時間ごと (新着取得)
- `rebuild_cache`: 30 分ごと (Redis ランキング再構築)
- `recompute_rankings`: 日次 (DB 上の集計テーブル更新)
- `generate_related`: 日次 (関連作品ベクトル更新)
