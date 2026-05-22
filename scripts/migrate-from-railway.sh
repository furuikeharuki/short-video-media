#!/usr/bin/env bash
# ============================================================================
# scripts/migrate-from-railway.sh
# ----------------------------------------------------------------------------
# Railway Postgres から Xserver VPS の docker compose 内 db サービスへの
# DB 一括移行スクリプト。
#
# 安全設計:
#   - RAILWAY_DATABASE_URL はコマンドライン引数では受け取らない
#     (`ps` / シェル履歴 / GitHub Actions ログ等への漏出防止)。
#     1) 環境変数 RAILWAY_DATABASE_URL があればそれを使う
#     2) なければ stdin から無エコーで読み取る (read -s)
#   - dump 後に `chmod 600` し、所有者 (実行ユーザー) 以外読めない権限に固定
#   - dump は custom format (-Fc) で保存。テキストでなく psql で偶発 cat されにくい
#   - 既存 DB を破壊し得る `pg_restore --clean` は明示確認 (yes/Y) が無いと走らない
#   - set -euo pipefail。失敗箇所が無視されない
#   - スクリプト末尾で trap により dump ディレクトリのパーミッションを再確認
#
# 前提:
#   - VPS 上で実行する (Compose で db サービスが起動している、もしくは本スクリプトが
#     先に起動してくれる)。
#   - POSTGRES_TOOLS_IMAGE で指定する Postgres クライアント
#     (デフォルト postgres:18-alpine) を docker run できる。
#     Railway 側 Postgres のメジャーバージョンに合わせること
#     (現状 18.3 で稼働しているため 18 系)。
#   - infra/xserver/.env から POSTGRES_USER / POSTGRES_DB / POSTGRES_PASSWORD を読む。
#
# 使い方:
#   (a) 環境変数経由 (CI / 自動化):
#       export RAILWAY_DATABASE_URL='postgresql://...@...railway.app:5432/railway'
#       ./scripts/migrate-from-railway.sh
#
#   (b) 対話入力 (推奨, 履歴に残らない):
#       ./scripts/migrate-from-railway.sh
#       (プロンプトで URL を貼り付ける。表示はマスクされる)
#
# オプション環境変数:
#   DUMP_DIR        : dump 保存先 (デフォルト: ~/db-migration)
#   COMPOSE_FILE    : compose ファイル (デフォルト: infra/xserver/docker-compose.yml)
#   POSTGRES_TOOLS_IMAGE : pg_dump を実行する docker image
#                          (デフォルト: postgres:18-alpine)
#                          Railway Postgres は 18.3 で動いているため、16 系で
#                          dump すると "aborting because of server version
#                          mismatch" で失敗する。VPS 側 db (compose の db
#                          サービス) も同じ 18 系に揃える。
#                          後方互換のため旧名 PG_DUMP_IMAGE も尊重する。
#   ASSUME_YES      : "yes" なら確認プロンプトをスキップ (非対話 CI 用、推奨しない)
#   SKIP_DUMP       : "yes" なら既存 dump を再利用 (デバッグ用)
#   DUMP_FILE       : 既存 dump を指定 (相対パスなら DUMP_DIR 配下)
#   RESTORE_MODE    : append / clean (デフォルト: append)
#                       append : pg_restore --no-owner --no-privileges のみ
#                       clean  : 上記 + --clean --if-exists (既存テーブル削除)
#
# 注意:
#   - dump は機微情報 (ユーザーデータ含む) を含む。終了後に DUMP_DIR を
#     安全に削除する (`shred -u` 推奨) こと。スクリプトは消さない。
#   - migration 完了後は infra/xserver/.env の SCHEDULER_BOOTSTRAP=false に戻し、
#     Railway 側 DB の認証情報をローテーションすること (docs/migration/xserver-vps.md)。
# ============================================================================

set -euo pipefail

# ---- locate repo ----------------------------------------------------------
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

COMPOSE_FILE="${COMPOSE_FILE:-infra/xserver/docker-compose.yml}"
DUMP_DIR="${DUMP_DIR:-$HOME/db-migration}"
# POSTGRES_TOOLS_IMAGE が pg_dump/pg_restore 用の正式変数。
# 旧 PG_DUMP_IMAGE も後方互換で受け付ける (新規利用は POSTGRES_TOOLS_IMAGE 推奨)。
POSTGRES_TOOLS_IMAGE="${POSTGRES_TOOLS_IMAGE:-${PG_DUMP_IMAGE:-postgres:18-alpine}}"
ASSUME_YES="${ASSUME_YES:-no}"
SKIP_DUMP="${SKIP_DUMP:-no}"
RESTORE_MODE="${RESTORE_MODE:-append}"

log()  { printf '[migrate-from-railway] %s\n' "$*"; }
fail() { printf '[migrate-from-railway][ERROR] %s\n' "$*" >&2; exit 1; }

# ---- prerequisites --------------------------------------------------------
[ -f "$COMPOSE_FILE" ] || fail "COMPOSE_FILE=$COMPOSE_FILE が見つかりません"
[ -f "infra/xserver/.env" ] || fail "infra/xserver/.env が必要です (.env.example をコピーして埋めてください)"

command -v docker >/dev/null 2>&1 || fail "docker コマンドが必要です"
docker compose version >/dev/null 2>&1 || fail "docker compose plugin が必要です"

case "$RESTORE_MODE" in
  append|clean) ;;
  *) fail "RESTORE_MODE は append または clean のみ (指定値: $RESTORE_MODE)";;
esac

# ---- load .env (POSTGRES_*) -----------------------------------------------
# .env の値に空白や記号が含まれてもエクスポートできるよう set -a を使う。
# パスワードに $ や ` が含まれる場合は .env 側で引用必須 (Compose 仕様準拠)。
# shellcheck disable=SC1091
set -a
. "infra/xserver/.env"
set +a

: "${POSTGRES_USER:?POSTGRES_USER not set in infra/xserver/.env}"
: "${POSTGRES_DB:?POSTGRES_DB not set in infra/xserver/.env}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD not set in infra/xserver/.env}"

# ---- obtain RAILWAY_DATABASE_URL (never via argv) -------------------------
# 1) 既に環境変数で来ていればそれを使う
# 2) 来ていなければ tty から無エコーで読む
# どちらの経路でも set -x はしない (どこにも漏らさない)
if [ -z "${RAILWAY_DATABASE_URL:-}" ]; then
  if [ ! -t 0 ]; then
    fail "RAILWAY_DATABASE_URL を環境変数で渡してください (非対話実行)"
  fi
  printf '[migrate-from-railway] Railway DATABASE_URL を貼り付け (画面には表示されません, 末尾 Enter): '
  # IFS= で先頭末尾の空白を保持。-s で無エコー。-r でバックスラッシュ展開を無効化。
  IFS= read -rs RAILWAY_DATABASE_URL
  printf '\n'
  export RAILWAY_DATABASE_URL
fi

[ -n "${RAILWAY_DATABASE_URL:-}" ] || fail "RAILWAY_DATABASE_URL が空です"

# 軽い形式チェック (postgres:// or postgresql:// で始まること)。
# 値自体は echo しない。
case "$RAILWAY_DATABASE_URL" in
  postgres://*|postgresql://*) : ;;
  *) fail "RAILWAY_DATABASE_URL は postgres:// または postgresql:// で始まる必要があります" ;;
esac

# ---- prepare DUMP_DIR -----------------------------------------------------
# DUMP_DIR は所有者のみアクセスできる権限にする。
# 既に存在し permissive な権限ならその場で修正する。
mkdir -p "$DUMP_DIR"
chmod 700 "$DUMP_DIR"

# 過去に root 所有で作られた dump が残っていると、後段の chmod / mv が
# "許可されていない操作です" で失敗する。事前に検出して対処方法を案内する。
# (本スクリプト内では sudo を呼ばない。所有権変更はユーザーに明示させる)
if find "$DUMP_DIR" -maxdepth 1 -type f \
     \( -name "railway-*.dump" -o -name "railway-*.dump.partial" \) \
     ! -user "$(id -u)" -print 2>/dev/null | grep -q .; then
  printf '[migrate-from-railway][ERROR] %s に他ユーザー所有 (おそらく root) の\n' "$DUMP_DIR" >&2
  printf '  既存 dump があります。以前 --user 指定なしで docker run 経由で作られた\n' >&2
  printf '  ものです。次のコマンドで自分の所有に戻してください:\n\n' >&2
  printf '    sudo chown -R "$(id -u):$(id -g)" "%s"\n\n' "$DUMP_DIR" >&2
  printf '  もしくは中身を破棄して構わなければ:\n\n' >&2
  printf '    sudo rm -f "%s"/railway-*.dump "%s"/railway-*.dump.partial\n\n' "$DUMP_DIR" "$DUMP_DIR" >&2
  exit 1
fi

TS="$(date -u +%Y%m%dT%H%M%SZ)"
DEFAULT_DUMP_NAME="railway-${POSTGRES_DB}-${TS}.dump"
DUMP_PATH=""

if [ -n "${DUMP_FILE:-}" ]; then
  # 絶対パスならそのまま、それ以外なら DUMP_DIR 配下とみなす
  case "$DUMP_FILE" in
    /*) DUMP_PATH="$DUMP_FILE" ;;
    *)  DUMP_PATH="$DUMP_DIR/$DUMP_FILE" ;;
  esac
else
  DUMP_PATH="$DUMP_DIR/$DEFAULT_DUMP_NAME"
fi

# ---- confirm ---------------------------------------------------------------
log "==== 移行サマリ ===="
log "  source           : Railway DB (URL は表示しません)"
log "  target compose   : $COMPOSE_FILE"
log "  target DB        : ${POSTGRES_DB}  (user=${POSTGRES_USER})"
log "  dump file        : $DUMP_PATH  (custom format / -Fc)"
log "  dump dir mode    : 700 (所有者のみ)"
log "  restore mode     : $RESTORE_MODE"
case "$RESTORE_MODE" in
  clean)
    log "  ⚠ 注意: 既存 db の同名テーブルは pg_restore --clean --if-exists で削除されます。"
    ;;
  append)
    log "  ※ 既存テーブルは保持。新規データのみ INSERT (重複は失敗)"
    ;;
esac
log "===================="

if [ "$ASSUME_YES" != "yes" ]; then
  if [ ! -t 0 ]; then
    fail "ASSUME_YES=yes を指定しない限り、非対話モードでは続行できません"
  fi
  printf '[migrate-from-railway] 続行しますか? (yes と入力) > '
  IFS= read -r confirm
  if [ "$confirm" != "yes" ]; then
    fail "ユーザーが中止しました"
  fi
fi

# ---- step 1: dump from Railway --------------------------------------------
# pg_dump を Docker 経由で実行する (ホスト OS に pg_dump を入れずに済む)。
# パスワードは PGPASSWORD ではなく Railway URL に埋まる前提なので、URL 全体を
# `-e ARG_URL` で渡し、コマンドラインの argv からは隠す。
if [ "$SKIP_DUMP" = "yes" ]; then
  log "SKIP_DUMP=yes: 既存 dump を再利用 ($DUMP_PATH)"
  [ -f "$DUMP_PATH" ] || fail "再利用しようとした dump が見つかりません: $DUMP_PATH"
else
  log "[1/2] Railway から pg_dump (custom format)..."

  # 出力先ディレクトリだけマウントし、URL は env で渡す。
  # script 内変数を直接埋め込まないため -e=name で値だけ転送する。
  # 出力ファイル名はコンテナ内パス /dump/<name> で固定。
  DUMP_BASENAME="$(basename "$DUMP_PATH")"
  DUMP_PARENT="$(dirname "$DUMP_PATH")"
  mkdir -p "$DUMP_PARENT"
  chmod 700 "$DUMP_PARENT"

  # コンテナの postgres ユーザー (UID 70 等) ではなく、ホスト実行ユーザーで
  # 書き出させる。--user を渡さないと dump がホスト側で root 所有になり、
  # 後段の chmod / mv / shred が "Operation not permitted" で失敗する。
  # /etc/passwd に該当 UID が無いコンテナでも pg_dump は問題なく動く
  # (HOME 未解決の warning が出るだけ)。
  HOST_UID="$(id -u)"
  HOST_GID="$(id -g)"

  # 一時 .partial に書き出して atomic に rename
  if ! docker run --rm \
      --user "${HOST_UID}:${HOST_GID}" \
      -v "$DUMP_PARENT":/dump \
      -e PG_SOURCE_URL="$RAILWAY_DATABASE_URL" \
      -e HOME=/tmp \
      "$POSTGRES_TOOLS_IMAGE" \
      sh -c 'pg_dump -Fc --no-owner --no-privileges --verbose \
               -f "/dump/'"$DUMP_BASENAME"'.partial" \
               "$PG_SOURCE_URL"' 2>&1 \
      | sed -E 's#(postgres(ql)?://)[^@[:space:]]+@#\1***REDACTED***@#g'; then
    # 失敗時に partial を残しておくと取り違えのリスクがあるので消す
    rm -f "${DUMP_PATH}.partial"
    fail "pg_dump に失敗しました"
  fi

  # partial が空 / 存在しないなら失敗扱い (pipefail を sed が握ってしまうケースの保険)
  if [ ! -s "${DUMP_PATH}.partial" ]; then
    rm -f "${DUMP_PATH}.partial"
    fail "pg_dump 出力が空です。ログを確認してください"
  fi

  mv "${DUMP_PATH}.partial" "$DUMP_PATH"
  chmod 600 "$DUMP_PATH"
  log "[1/2] dump 完了: $DUMP_PATH ($(du -h "$DUMP_PATH" | cut -f1))"
fi

# ---- step 2: ensure db service is up --------------------------------------
log "db サービスを起動 (既に up なら何もしない)..."
docker compose -f "$COMPOSE_FILE" up -d db

# healthcheck が green になるまで待つ (compose 側に healthcheck 定義あり)
log "db のヘルスチェック待機..."
for i in $(seq 1 30); do
  status="$(docker compose -f "$COMPOSE_FILE" ps --format json db 2>/dev/null \
              | grep -o '"Health":"healthy"' || true)"
  if [ -n "$status" ]; then
    log "db healthy"
    break
  fi
  if [ "$i" -eq 30 ]; then
    fail "db が 30 * 5s 経っても healthy になりません。logs を確認してください。"
  fi
  sleep 5
done

# ---- step 2b: restore into db service -------------------------------------
log "[2/2] pg_restore を db コンテナへ..."

RESTORE_FLAGS="--no-owner --no-privileges --exit-on-error"
if [ "$RESTORE_MODE" = "clean" ]; then
  # 二重確認: clean は破壊的
  if [ "$ASSUME_YES" != "yes" ]; then
    printf '[migrate-from-railway] RESTORE_MODE=clean は既存テーブルを削除します。続行しますか? (yes と入力) > '
    IFS= read -r confirm2
    if [ "$confirm2" != "yes" ]; then
      fail "ユーザーが中止しました (clean 二重確認)"
    fi
  fi
  RESTORE_FLAGS="$RESTORE_FLAGS --clean --if-exists"
fi

# pg_restore は db コンテナ内で実行 (network reach も認証も最短)。
# dump を stdin で流し込む → ファイルマウント不要。
# pg_restore は stdin から custom format を読める。
# パスワードは PGPASSWORD で渡し、argv には出さない。
# shellcheck disable=SC2086
if ! docker compose -f "$COMPOSE_FILE" exec -T \
    -e PGPASSWORD="$POSTGRES_PASSWORD" \
    db \
    pg_restore $RESTORE_FLAGS \
      -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    < "$DUMP_PATH"; then
  fail "pg_restore に失敗しました。dump は残っています: $DUMP_PATH"
fi

log "[2/2] restore 完了"

# ---- 後処理 / 注意喚起 -----------------------------------------------------
chmod 700 "$DUMP_DIR" || true
chmod 600 "$DUMP_PATH" || true

cat <<'POSTMSG'

[migrate-from-railway] ========== 完了 ==========
次に必ず実施してください:

  1. apps/api の動作確認
       docker compose -f infra/xserver/docker-compose.yml up -d api
       curl -sf http://127.0.0.1:8000/ >/dev/null && echo "api up"

  2. infra/xserver/.env の SCHEDULER_BOOTSTRAP を false に戻す
       (もしデータ取り込みのため true にしていた場合のみ)
     → docker compose -f infra/xserver/docker-compose.yml up -d jobs-worker

  3. Railway 側のセキュリティ後処理
       - DATABASE_URL のパスワードをローテーション
       - Railway プロジェクトの公開 Postgres を停止 / 削除
       - Vercel 側の API_BASE_URL を VPS のドメインへ切替

  4. dump ファイルの取り扱い
       - $DUMP_DIR の中身は機微情報を含みます。動作確認が済んだら
         `shred -u "$DUMP_DIR"/railway-*.dump` で安全に削除してください。

POSTMSG
