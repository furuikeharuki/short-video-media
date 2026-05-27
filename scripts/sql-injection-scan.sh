#!/usr/bin/env bash
# SQL インジェクションの静的スキャン (軽量版)。
#
# 目的:
#   - apps/api と apps/jobs の Python コードから「文字列補間で SQL を組み立てている」
#     疑わしいパターンを grep ベースで検出する。
#   - 完全な解析ではなく、外部ツール (bandit / semgrep) を入れない最小コストでの
#     継続レビュー用。CI には組み込んでいない (false positive が多いため手動レビュー
#     用の補助ツールという位置付け)。
#
# 使い方:
#   bash scripts/sql-injection-scan.sh
#
# 終了コード:
#   0: 検出 0 件
#   1: 1 件以上検出 (要レビュー)
#
# 真の検出ツール (オプション):
#   pip install bandit
#   bandit -r apps/api/app apps/jobs/src -lll
#
#   pip install semgrep
#   semgrep --config=p/sqlalchemy --config=p/python apps/api/app apps/jobs/src

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARGETS=(
  "$ROOT_DIR/apps/api/app"
  "$ROOT_DIR/apps/jobs/src"
)

# パターン:
#   1) text(f"...")  / execute(f"...") / raw(f"...")  — SQLAlchemy 文字列補間
#   2) .format(...) で SQL/SELECT が含まれる
#   3) % 補間で SQL/SELECT が含まれる (古い書き方)
PATTERNS=(
  'text\(f["'\'']'
  'execute\(f["'\'']'
  'raw\(f["'\'']'
  'exec_driver_sql\(f["'\'']'
  '(SELECT|INSERT|UPDATE|DELETE)[^"'\'']*["'\''].format\('
  '(SELECT|INSERT|UPDATE|DELETE)[^"'\'']*["'\''] *%'
)

hits=0
for target in "${TARGETS[@]}"; do
  [[ -d "$target" ]] || continue
  for p in "${PATTERNS[@]}"; do
    out=$(grep -rEn --include='*.py' "$p" "$target" || true)
    if [[ -n "$out" ]]; then
      echo "## pattern: $p"
      echo "$out"
      echo
      hits=$((hits + $(echo "$out" | wc -l)))
    fi
  done
done

if [[ $hits -gt 0 ]]; then
  echo "SQLi suspicious patterns: $hits hit(s). レビューしてください。"
  exit 1
fi

echo "SQLi suspicious patterns: 0 hit."
exit 0
