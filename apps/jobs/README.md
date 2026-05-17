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

| 変数 | 説明 |
|------|------|
| `DMM_API_ID` | DMM アフィリエイト管理画面で発行する API ID |
| `DMM_AFFILIATE_ID` | DMM のアフィリエイト ID (`xxxxxx-990` の形式) |
| `DATABASE_URL` | Postgres 接続文字列 (Public URL) |

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
