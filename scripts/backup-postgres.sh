#!/usr/bin/env bash
# ============================================================================
# scripts/backup-postgres.sh
# ----------------------------------------------------------------------------
# Xserver VPS 上の db コンテナを pg_dump で論理バックアップする。
# cron で 1 日 1 回回す前提。
#
# 例 (毎日 04:30 JST):
#   30 19 * * *  /opt/short-video-media/scripts/backup-postgres.sh \
#                  >> /var/log/short-video-media/backup.log 2>&1
#   (cron は UTC で動く環境前提なので、JST 04:30 = UTC 前日 19:30)
#
# 環境変数:
#   REPO_DIR        : リポジトリのパス (デフォルト: スクリプトの ../)
#   COMPOSE_FILE    : compose ファイル (デフォルト: infra/xserver/docker-compose.yml)
#   BACKUP_DIR      : 保存先ディレクトリ (デフォルト: /var/backups/short-video-media)
#   RETENTION_DAYS  : 何日分保持するか (デフォルト: 14)
#   POSTGRES_USER   : .env から自動読み込み
#   POSTGRES_DB     : .env から自動読み込み
#   GZIP            : true で gzip 圧縮 (デフォルト: true)
#
# 出力:
#   $BACKUP_DIR/<DB>-YYYYMMDDTHHMMSSZ.sql[.gz]
#
# 復元:
#   gunzip < <DB>-YYYY.sql.gz | docker compose ... exec -T db psql -U $POSTGRES_USER -d $POSTGRES_DB
# ============================================================================

set -euo pipefail

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
COMPOSE_FILE="${COMPOSE_FILE:-infra/xserver/docker-compose.yml}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/short-video-media}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
GZIP="${GZIP:-true}"

log()  { printf '[backup-postgres] %s\n' "$*"; }
fail() { printf '[backup-postgres][ERROR] %s\n' "$*" >&2; exit 1; }

cd "$REPO_DIR"

[ -f "$COMPOSE_FILE" ] || fail "COMPOSE_FILE=$COMPOSE_FILE が見つかりません"
[ -f "infra/xserver/.env" ] || fail "infra/xserver/.env がありません"

# .env から POSTGRES_USER / POSTGRES_DB を読む (空白許容)
# shellcheck disable=SC1091
set -a
. "infra/xserver/.env"
set +a

: "${POSTGRES_USER:?POSTGRES_USER not set in infra/xserver/.env}"
: "${POSTGRES_DB:?POSTGRES_DB not set in infra/xserver/.env}"

mkdir -p "$BACKUP_DIR"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/${POSTGRES_DB}-${TS}.sql"

log "dumping $POSTGRES_DB to $OUT"
# pg_dump の終了コードが非0なら set -e で全体が失敗するため、中途半端な
# ファイルを残さないよう一旦 .partial に書いて mv する。
docker compose -f "$COMPOSE_FILE" exec -T db \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --clean --if-exists \
  > "${OUT}.partial"

if [ "$GZIP" = "true" ]; then
  gzip "${OUT}.partial"
  mv "${OUT}.partial.gz" "${OUT}.gz"
  log "wrote ${OUT}.gz ($(du -h "${OUT}.gz" | cut -f1))"
else
  mv "${OUT}.partial" "$OUT"
  log "wrote $OUT ($(du -h "$OUT" | cut -f1))"
fi

# 古いバックアップ削除 (atime ではなく mtime)
log "pruning backups older than ${RETENTION_DAYS} days from $BACKUP_DIR"
find "$BACKUP_DIR" -maxdepth 1 -type f \
  \( -name "${POSTGRES_DB}-*.sql" -o -name "${POSTGRES_DB}-*.sql.gz" \) \
  -mtime "+${RETENTION_DAYS}" -print -delete || true

log "done"
