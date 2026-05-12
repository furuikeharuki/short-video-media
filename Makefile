COMPOSE = docker compose -f infra/docker/docker-compose.yml
ENV_SRC  = infra/docker/.env.example
ENV_DEST = infra/docker/.env

.PHONY: setup
setup: ## 初回セットアップ（.envコピー + pnpm install）
	@if [ ! -f $(ENV_DEST) ]; then \
		cp $(ENV_SRC) $(ENV_DEST); \
		echo "✅ $(ENV_DEST) を作成しました。FANZA_API_ID などを埋めてください。"; \
	else \
		echo "ℹ️  $(ENV_DEST) はすでに存在します。スキップします。"; \
	fi
	pnpm install

.PHONY: dev
dev: ## DB + API をローカル起動
	$(COMPOSE) up --build

.PHONY: dev-d
dev-d: ## バックグラウンドで起動
	$(COMPOSE) up --build -d

.PHONY: down
down: ## コンテナを停止
	$(COMPOSE) down

.PHONY: clean
clean: ## コンテナ＋ボリューム削除（DB初期化）
	$(COMPOSE) down -v

.PHONY: migrate
migrate: ## Alembicマイグレーション実行
	$(COMPOSE) exec api alembic upgrade head

.PHONY: makemigrations
makemigrations: ## マイグレーションファイル生成
	$(COMPOSE) exec api alembic revision --autogenerate -m "$(msg)"

.PHONY: db-shell
db-shell: ## PostgreSQLシェルに接続
	$(COMPOSE) exec db psql -U postgres -d short_video_media

.PHONY: fetch
fetch: ## FANZAデータ取得ジョブを手動実行
	$(COMPOSE) --profile jobs run --rm jobs python -m src.sync_catalog

.PHONY: logs
logs: ## 全サービスのログ
	$(COMPOSE) logs -f

.PHONY: logs-api
logs-api: ## APIログのみ
	$(COMPOSE) logs -f api

.PHONY: test-api
test-api: ## APIテスト実行
	$(COMPOSE) exec api python -m pytest tests/ -v

.PHONY: help
help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
