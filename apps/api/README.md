# short-video-media API

FastAPI 製の API サーバー。Railway にデプロイされている。

## ローカル開発

```bash
cd apps/api
pip install -e .
export DATABASE_URL=postgresql://...
export REDIS_URL=redis://...
uvicorn app.main:app --reload
```

## DB マイグレーション運用

**本番 DB へのマイグレーションは GitHub Actions で実行する。**
API コンテナは起動時にマイグレーションを行わない (役割分離のため)。

### 仕組み

- ワークフロー: `.github/workflows/migrate.yml`
- トリガー: `main` ブランチへのマージで以下のパスに変更があったとき
  - `apps/api/alembic/**`
  - `apps/api/app/db/**`
  - `apps/api/alembic.ini`
  - `apps/api/pyproject.toml`
- 手動実行も可 (Actions タブ → DB Migrate → Run workflow)

### 必要な GitHub Secrets

リポジトリ Settings → Secrets and variables → Actions に登録:

| 名前 | 値 | 取得元 |
|---|---|---|
| `DATABASE_URL` | `postgresql://user:pass@host:port/db` | Railway の Variables からコピー |

### 新しいマイグレーションを追加する流れ

```bash
# 1. ローカルで生成 (DATABASE_URL は開発用 DB を指す)
cd apps/api
alembic revision --autogenerate -m "add some table"

# 2. 生成された apps/api/alembic/versions/*.py を確認・編集

# 3. ローカルで実行して検証
alembic upgrade head

# 4. 問題なければコミット & PR
git add apps/api/alembic/versions/
git commit -m "feat(db): add some table"
git push

# 5. main にマージされた瞬間に GitHub Actions が本番 DB に対して
#    alembic upgrade head を実行する
```

### 失敗したとき

- GitHub Actions の Run ログを確認
- 必要に応じてローカルから `alembic downgrade -1` 等を手動実行
- API コンテナ側は migration の成否に関わらず起動するので、
  古いスキーマで動き続けることに注意 (古いコードと新スキーマの組み合わせは概ね安全)

### AWS 移行時

このワークフローはそのまま流用できる:
- ECS/Fargate/EKS/App Runner いずれの場合も「CI/CD パイプラインでマイグレーション → アプリ起動」が標準
- `DATABASE_URL` Secret を RDS エンドポイントに差し替えるだけ
- デプロイ側のワークフロー (別途必要) で `migrate` ジョブの完了を待ってからアプリを更新するように依存関係を組む

## アーキテクチャ

- `app/main.py` — FastAPI エントリポイント
- `app/api/v1/` — エンドポイント定義
- `app/db/` — SQLAlchemy モデルとセッション
- `app/core/` — 設定・キャッシュなど横断的関心事
- `alembic/` — DB マイグレーション
