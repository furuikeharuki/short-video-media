# セキュリティ強化・改善メモ (2026-05-27)

本ドキュメントは外部レポートで指摘された改善項目について、
今回着手した内容・未着手のまま意図的に残した内容をまとめる。

---

## 完了 (P0)

| 項目 | 実装ファイル |
|------|--------------|
| `POST /api/v1/auth/sign-in` の IP ベースレート制限 | `apps/api/app/api/v1/endpoints/auth.py`, `apps/api/app/core/rate_limit.py` |
| `EventRateLimiter` のメモリ肥大化対策 (定期 sweep + 空バケット削除) | `apps/api/app/core/rate_limit.py` |
| CSP Report-Only ヘッダー追加 (Enforce ではなく観測のみ) | `apps/web/next.config.ts` |
| Identity UNIQUE 競合 (`provider, sub_hash`) 競合の安全化 (`IntegrityError` を catch して再 SELECT) | `apps/api/app/api/v1/endpoints/auth.py:_get_or_create_identity` |
| 認証・レートリミッタの API テスト | `apps/api/tests/test_auth_sign_in.py`, `apps/api/tests/test_rate_limit.py` |

## 完了 (P1)

| 項目 | 実装ファイル |
|------|--------------|
| `/feed` への保守的レート制限 | `apps/api/app/api/v1/endpoints/feed.py` |
| `/movies/{slug}/resolve-mp4` への保守的レート制限 | `apps/api/app/api/v1/endpoints/movies.py` |
| `REDIS_URL` / sign-in rate limit / Sentry DSN の `.env.example` 追記 | `.env.example`, `apps/api/app/core/config.py` |

## 完了 (第 2 バッチ: 低〜中リスクで実装可能だった項目)

| 項目 | 実装ファイル / 備考 |
|------|---------------------|
| Redis-backed resolver MP4 成功キャッシュ (in-process LRU を 2 段目フォールバックに) | `apps/api/app/services/resolver_client.py` — `_get_cached_redis/_put_cached_redis` を追加。Redis 未接続なら従来通り in-process LRU で動作。`get_redis()` (`app.core.cache`) を利用。 |
| optional Sentry hooks (`SENTRY_DSN` が設定された場合のみ有効) | `apps/api/app/core/sentry.py` (新規) + `apps/api/app/main.py` の import 時 `init_sentry()`。`sentry-sdk` 未インストール時は完全 no-op。 |
| Request ID logging middleware | `apps/api/app/core/request_id.py` (新規) + `apps/api/app/main.py`。受信 `X-Request-Id` を検証して採用、なければ UUID4 hex を生成し ASGI scope と response header に伝搬。CORS の `allow_headers` / `expose_headers` にも追加。 |
| `/resolve-mp4` retry storm 防止 (`force` リトライの 5 秒クールダウン) | `apps/api/app/services/resolver_client.py` の `should_throttle_force_retry/mark_force_retry` + `apps/api/app/api/v1/endpoints/movies.py` で `effective_force` に降格。`_FORCE_RETRY_MIN_INTERVAL_S = 5.0`。 |
| Job 単独実行アドバイザリロック | `apps/jobs/src/advisory_lock.py` (新規) + `apps/jobs/src/scheduler.py` の `_run_sync_catalog` / `_run_sync_actress_profiles`。`pg_try_advisory_lock` を取れなければ no-op スキップ。DB エラーなら安全側 (ロックなしで実行) にフォールバック。 |
| 詳細ページの JSON-LD 強化 (VideoObject, BreadcrumbList, Product) | `apps/web/app/movies/[slug]/page.tsx` — VideoObject / Breadcrumb は既存。Product JSON-LD を価格が取得できる場合のみ追加 (Offer, Brand, sku, aggregateRating)。 |
| SQLi 静的スキャン (補助スクリプト) | `scripts/sql-injection-scan.sh` (新規)。`text(f"...")` / `execute(f"...")` / `.format(...)` 等の文字列補間 SQL を grep。現状 0 件 hit。bandit/semgrep のコマンド例も script 内 docstring に記載。 |

---

## 未着手 / 意図的にスキップ (理由付き)

### 1. CSP を Enforce に切替
- 今は `Content-Security-Policy-Report-Only` のみ。
- 本番で違反 0 が一定期間続いてから `Content-Security-Policy` に昇格する。
- `Report-To` / `report-uri` エンドポイント (例: `/api/csp-report`) はまだ実装していない。
  違反は DevTools と Sentry (有効化された場合) で観測する想定。

### 2. Sentry SDK 依存追加
- `apps/api/app/core/sentry.py` は実装済みで、`SENTRY_DSN` が設定 + `sentry-sdk`
  がインストールされた場合のみ有効化される (それ以外は完全 no-op)。
- 実際に有効化するには `apps/api/pyproject.toml` の dependencies に
  `sentry-sdk>=2.0` を追加する必要がある。これは本番運用ポリシーの決定が必要なため
  別 PR にする (依存追加 = build 時間と attack surface の増加)。
- web 側 (`@sentry/nextjs`) も同様に未着手。

### 3. `Event.created_at` のタイムゾーン
- 現状 `TIMESTAMP WITHOUT TIME ZONE` で naive UTC を保存している (`event.py`)。
- `TIMESTAMP WITH TIME ZONE` に切替えるとマイグレーション + 既存データ変換が必要。
- 既存テストの想定 (naive datetime) も書き換えになるため、別 PR で扱う。

### 4. `package-lock.json` 削除 / lockfile 統一
- ルートに `package-lock.json` (npm, ~37KB) と `pnpm-workspace.yaml` (pnpm) が両方存在。
- 実際に CI (`.github/workflows/web-ci.yml`) で使われているのは **npm** (`npm ci`,
  `cache-dependency-path: package-lock.json`)。`package.json` も `workspaces: ["apps/*"]`
  で npm workspaces を宣言。
- 従って **canonical は npm**。`pnpm-workspace.yaml` は実際には未使用のミスリーディング
  なファイルだが、ローカルで pnpm を使っている開発者がいる可能性があり、即削除はせず別 PR で
  確認したうえで除去する。
- 今回の安全変更範囲外。

### 5. CSP report-uri エンドポイント実装
- 上記 1 と関連。`POST /api/v1/security/csp-report` を立てて違反を集計するのが理想。
  Sentry 有効化と並走するか個別実装するかは未定。

### 6. その他ドキュメント TODO
- DB バックアップ / PITR 方針
- JWT key rotation 手順 (`AUTH_SECRET` / `APP_USER_SALT`)
- materialized rankings (ranking_service の事前計算化)
- アクセシビリティ (キーボード操作 / ARIA)
- 検索: 日本語正規化 (NFKC, ひらがな⇄カタカナ)
- 広告 mediation (ExoClick 以外との a/b)
- resolver_metrics の Prometheus 化
- jobs の sync diff 検出 (取り込み差分のみ DB 更新)

---

## レート制限の設計メモ

`SlidingWindowRateLimiter` は IP ごとに過去 60 秒のタイムスタンプを deque で保持する。
**メモリ管理**:
- 新規 `check()` のたびに当該 IP の 60 秒超データを `popleft()`
- 1024 回の `check()` ごとに `_sweep_locked()` で空 deque を一括削除
- 429 を返す瞬間にも当該バケットが空なら削除

これにより、攻撃者が無数の異なる IP から 1 リクエストずつ送っても、定期 sweep で
window 外のバケットが必ず開放される。

**マルチインスタンス対応**: 現行は in-memory のため、Railway 複数インスタンス構成
や GitHub Actions など別プロセスでは独立に動く。本番でインスタンスをスケールする
場合は Redis ベースに置き換える前提。今回の sweep 改善はその移行コストには影響しない。

---

## resolver_client の force リトライ抑止

`/movies/{slug}/resolve-mp4?force=true` は本来 cache miss/staleness 検出時のフォールバックだが、
クライアント側の自動リトライで同一 `content_id` に対し force=true が 1 秒以内に複数回飛ぶと
extractor が DMM へ毎回ヒットし、上流レート枯渇の原因になる。

`should_throttle_force_retry(content_id)` は per-content_id で **5 秒** のクールダウンを持ち、
それ未満で再度 `force=true` が来たら `effective_force = False` に降格して通常キャッシュ経路で
返す。`mark_force_retry()` は `force=True` 経路に乗ったタイミングで記録。

これは「初回 force は必ず通す / 連打だけを潰す」シンプルな leaky bucket 相当の動作で、UX を
壊さずに extractor 負荷を抑える。`_reset_state_for_tests` で `_last_force_retry_at` もクリア
されるためテストには影響なし。

---

## advisory lock の設計メモ

- ジョブ名 (例 `sync_catalog`) を `"short-video-media:job:{name}"` で SHA-1 し先頭 8 byte を
  符号付き 64bit に変換、これを `pg_try_advisory_lock(bigint)` のキーにする。
- セッション保持 (`pg_try_advisory_lock` / `pg_advisory_unlock`) なので、
  万一ジョブが panic しても connection が close した時点で Postgres 側で解放される。
- `DATABASE_URL` 未設定 or DB 接続失敗時は **安全側にロックなしで実行を継続** する
  (DB 障害時にスケジューラが空回りしないことを優先)。

---

## SQLi スキャン

`bash scripts/sql-injection-scan.sh` で `apps/api/app` と `apps/jobs/src` を grep し、
`text(f"...")` / `execute(f"...")` / `(SELECT|...).format(...)` 等の文字列補間 SQL を検出。
2026-05-27 時点で **0 件 hit**。

より厳密な解析を行う場合の手順 (任意):
```
pip install bandit
bandit -r apps/api/app apps/jobs/src -lll

pip install semgrep
semgrep --config=p/sqlalchemy --config=p/python apps/api/app apps/jobs/src
```

---

## X-Request-Id middleware

- `apps/api/app/core/request_id.py` の `RequestIdMiddleware` が ASGI レベルで処理する。
- 受信 `X-Request-Id` ヘッダがあり、printable ASCII かつ ≤128 文字なら採用、
  それ以外は UUID4 hex を生成する。
- `scope["state"]["request_id"]` に格納し、レスポンスヘッダにも同じ値を返す。
- CORS の `allow_headers` / `expose_headers` にも `X-Request-Id` を追加済み (JS から取得可能)。

---

## Sentry (optional)

- `apps/api/app/core/sentry.py` の `init_sentry()` は import 時に依存をロードしない。
- `SENTRY_DSN` が設定された場合に限り `sentry-sdk` を try-import → `sentry_sdk.init()`。
- `traces_sample_rate` は `SENTRY_TRACES_SAMPLE_RATE` (default 0.0) で制御。
- `send_default_pii=False` で PII を送らない。
