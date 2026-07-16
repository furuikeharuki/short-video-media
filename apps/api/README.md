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

**本番 DB へのマイグレーションはデプロイスクリプトが実行する。**
API コンテナは起動時 (lifespan) にマイグレーションを行わない (役割分離のため)。

### 仕組み

- `scripts/deploy-xserver.sh` が、新しい api イメージを build した後・api コンテナを
  置き換える *前* に、`docker compose -f infra/xserver/docker-compose.yml run --rm api alembic upgrade head`
  を実行する。
- migration が失敗した場合は `set -euo pipefail` によりデプロイを即中断し、
  旧 api コンテナはそのまま起動状態で残る (=無停止・安全なロールフォワード)。
- 手動で本番に流したい場合も同じコマンドを VPS 上で実行すればよい。

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

# 5. main にマージされ、デプロイが走ると deploy-xserver.sh が
#    api コンテナ置換前に本番 DB へ alembic upgrade head を実行する
```

### 失敗したとき

- デプロイのログ (GitHub Actions → deploy-xserver) を確認
- migration 失敗時はデプロイが中断し旧 api が残るため、原因を直して再デプロイする
- 必要に応じて VPS 上から `docker compose ... run --rm api alembic downgrade -1` 等を手動実行

### AWS 移行時

同じ考え方をそのまま流用できる:
- ECS/Fargate/EKS/App Runner いずれの場合も「デプロイパイプラインでマイグレーション → アプリ起動」が標準
- `DATABASE_URL` を RDS エンドポイントに差し替えるだけ
- デプロイ側のパイプラインで migration ステップの完了を待ってからアプリを更新するよう依存関係を組む

## アーキテクチャ

- `app/main.py` — FastAPI エントリポイント
- `app/api/v1/` — エンドポイント定義
- `app/db/` — SQLAlchemy モデルとセッション
- `app/core/` — 設定・キャッシュなど横断的関心事
- `alembic/` — DB マイグレーション
