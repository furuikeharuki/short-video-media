#!/usr/bin/env bash
# ============================================================================
# scripts/deploy-xserver.sh
# ----------------------------------------------------------------------------
# Xserver VPS 上で実行されるデプロイスクリプト。
# GitHub Actions の SSH 経由デプロイから呼ばれることを想定しているが、
# 手動で同じ流れを再現できるよう完全に自己完結している。
#
# 前提:
#   - VPS 上の <REPO_DIR> に既にリポジトリが clone 済み
#   - <REPO_DIR>/infra/xserver/.env が用意済み (値が埋まっている)
#   - docker / docker compose plugin が利用可能
#   - 実行ユーザーは docker グループ所属、もしくは sudo 不要設定済み
#
# 使い方:
#   REPO_DIR=/opt/short-video-media \
#   GIT_REF=main \
#   ./scripts/deploy-xserver.sh
#
#   または何も渡さず: scripts/deploy-xserver.sh を REPO 直下から実行
#
# 失敗時:
#   set -euo pipefail で即停止。途中の git fetch 失敗等は元のチェックアウトを
#   壊さないようにしてある。直前タグは git tag pre-deploy-<timestamp> として
#   残るので、ロールバックは `git reset --hard <tag> && docker compose ... up -d`。
# ============================================================================

set -euo pipefail

# ---- 設定 -----------------------------------------------------------------
REPO_DIR="${REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
GIT_REF="${GIT_REF:-main}"
COMPOSE_FILE="${COMPOSE_FILE:-infra/xserver/docker-compose.yml}"
# Compose の build / up に渡す追加引数 (例: "--no-cache" を BUILD_OPTS に)
BUILD_OPTS="${BUILD_OPTS:-}"
# 起動するサービスを限定したい場合 (デフォルトは compose ファイル全部)
SERVICES="${SERVICES:-}"

log()  { printf '[deploy-xserver] %s\n' "$*"; }
fail() { printf '[deploy-xserver][ERROR] %s\n' "$*" >&2; exit 1; }

# ---- 事前チェック ---------------------------------------------------------
[ -d "$REPO_DIR" ] || fail "REPO_DIR=$REPO_DIR が存在しません"
cd "$REPO_DIR"

[ -f "$COMPOSE_FILE" ] || fail "COMPOSE_FILE=$COMPOSE_FILE が見つかりません"
[ -f "infra/xserver/.env" ] || fail "infra/xserver/.env がありません (.env.example をコピーして値を埋めてください)"

command -v docker >/dev/null 2>&1 || fail "docker コマンドがありません"
docker compose version >/dev/null 2>&1 || fail "docker compose plugin が必要です"

# ---- 現在の HEAD を保存 (ロールバック用 tag) -------------------------------
PRE_DEPLOY_TAG="pre-deploy-$(date -u +%Y%m%dT%H%M%SZ)"
CURRENT_SHA="$(git rev-parse HEAD)"
log "current HEAD=$CURRENT_SHA, tagging as $PRE_DEPLOY_TAG (local only)"
git tag -f "$PRE_DEPLOY_TAG" "$CURRENT_SHA" >/dev/null

# ---- fetch & checkout -----------------------------------------------------
log "fetching origin..."
git fetch --tags --prune origin

log "checking out $GIT_REF..."
# ローカル変更があると checkout が失敗するので、安全な状態だけ進める。
if ! git diff --quiet || ! git diff --cached --quiet; then
  fail "ワークツリーに未コミットの変更があります。手動で確認してください。"
fi
git checkout "$GIT_REF"
# 同名ブランチを追いかける場合は fast-forward
if git symbolic-ref -q HEAD >/dev/null; then
  git pull --ff-only origin "$GIT_REF"
fi
NEW_SHA="$(git rev-parse HEAD)"
log "deploying $NEW_SHA"

# ---- build ----------------------------------------------------------------
log "docker compose build (services=${SERVICES:-all})..."
# shellcheck disable=SC2086
docker compose -f "$COMPOSE_FILE" build $BUILD_OPTS $SERVICES

# ---- migrate (api コンテナ内で alembic upgrade head) ----------------------
# api コンテナの lifespan で自動マイグレーションされる実装になっているが、
# データ破壊リスクを避けるため、ここでは「up する前に明示的に走らせる」運用は
# しない (失敗時に api が起動しないだけで、ロールバックが面倒)。
# 必要なら手動で:
#   docker compose -f infra/xserver/docker-compose.yml run --rm api alembic upgrade head
log "skipping explicit alembic upgrade (api lifespan が自動実行 / 手動運用したい場合は README 参照)"

# ---- up -------------------------------------------------------------------
log "docker compose up -d..."
# shellcheck disable=SC2086
docker compose -f "$COMPOSE_FILE" up -d --remove-orphans $SERVICES

# ---- ヘルスチェック --------------------------------------------------------
# api の healthcheck が healthy になるまで待つ。
wait_for_healthy() {
  local svc="$1"
  local max_iter="$2"
  log "waiting for ${svc} to become healthy (max $((max_iter * 5))s)..."
  for i in $(seq 1 "$max_iter"); do
    if docker compose -f "$COMPOSE_FILE" ps --format json "$svc" 2>/dev/null \
        | grep -q '"Health":"healthy"'; then
      log "${svc} healthy"
      return 0
    fi
    if [ "$i" -eq "$max_iter" ]; then
      log "${svc} did not become healthy in time. tailing logs:"
      docker compose -f "$COMPOSE_FILE" logs --tail=80 "$svc" || true
      return 1
    fi
    sleep 5
  done
}

wait_for_healthy api 30 || fail "api health check failed"

# ---- 古いイメージ掃除 -----------------------------------------------------
# ディスクが枯渇しがちな VPS では重要。dangling のみで安全。
log "pruning dangling images..."
docker image prune -f >/dev/null 2>&1 || true

log "deploy complete: $CURRENT_SHA -> $NEW_SHA"
log "rollback: git reset --hard $PRE_DEPLOY_TAG && docker compose -f $COMPOSE_FILE up -d --build"

# jobs サービスは profiles: ["cli"] のため docker compose up -d では起動せず、
# GitHub Actions (.github/workflows/jobs-sync-*.yml) から docker compose run --rm で
# 一発実行される。よってこのデプロイスクリプトで jobs コンテナを
# recreate してしまう心配はない。走行中の jobs 処理がある場合は Actions 側の
# concurrency グループ (jobs-sync-catalog 等) が二重起動を防ぐ。
