# Railway 内 jobs-worker デプロイ手順

GitHub Actions cron から Railway Postgres へ Public URL 接続していたため、
SELECT/RETURNING の応答が全部 egress として計上され、2 日で 1.2 TB / $61.78
の課金が発生していた。

恒久対策として `apps/jobs/Dockerfile.worker` をベースにした
常駐 Worker サービスを Railway プロジェクト内に立て、Postgres と
**Private Network 経由** で通信させる。Private Network 通信は
egress カウントされないため、移行後の egress はほぼゼロになる。

## 1. Railway ダッシュボードでのサービス作成

1. Railway プロジェクト (short-video-media) を開く
2. `+ New` → `GitHub Repo` → `furuikeharuki/short-video-media` を選択
3. Service Name: `jobs-worker`
4. Settings → **Source** タブ:
   - Branch: `main`
   - Root Directory: 空 (リポジトリ ルート)
   - Build:
     - Builder: `Dockerfile`
     - Dockerfile Path: `apps/jobs/Dockerfile.worker`
   - Deploy:
     - Custom Start Command: 空 (Dockerfile の CMD を使う)
     - Healthcheck Path: 空 (ワーカーは HTTP 公開しない)
5. Settings → **Networking** タブ:
   - **Public Networking: OFF** にする (HTTP 公開不要、外部から叩かれる必要なし)
   - Private Networking: 自動的に ON (同プロジェクト内のサービス同士で通信可能)
6. Settings → **Resources** タブ:
   - Memory Limit: 512MB (推奨、sync 中に若干使う)
   - CPU Limit: 1 vCPU (default)

## 2. Variables の設定

`jobs-worker` サービスの **Variables** タブで以下を設定。

| Key | Value | 備考 |
|---|---|---|
| `DATABASE_URL` | `postgresql://<user>:<pass>@postgres.railway.internal:5432/<db>` | **必ず internal ホストにする** |
| `DMM_API_ID` | (既存と同じ) | |
| `DMM_AFFILIATE_ID` | (既存と同じ) | |
| `DMM_LINK_AFFILIATE_ID` | (既存と同じ) | |
| `RESOLVER_BASE_URL` | `http://162.43.24.128` | Xserver VPS の resolver |
| `RESOLVER_API_KEY` | (既存と同じ) | |
| `SCHEDULER_RUN_ON_START` | `false` | 起動直後の動作確認したい時だけ `true` に |
| `TZ` | `Asia/Tokyo` | ログ表示用 |

### DATABASE_URL の作り方

Postgres サービスの **Variables** タブを開き、`DATABASE_URL` の中身を確認する。
Railway は同プロジェクト内で
`postgres.railway.internal:5432` という DNS 名を提供しているので、
ホスト部分だけ差し替える:

```text
# Public (egress 課金される、これは NG)
postgresql://postgres:xxx@maglev.proxy.rlwy.net:54321/railway

# Private (egress ゼロ、これを使う)
postgresql://postgres:xxx@postgres.railway.internal:5432/railway
```

Railway の `Reference` 機能で `${{Postgres.DATABASE_PRIVATE_URL}}` (もし
public/private が分離されていれば) を使う方が安全。なければ手書きする。

## 3. デプロイ確認

1. Deployments タブで起動を確認
2. Logs を開き、以下のような行が出るのを確認:
   ```
   scheduler boot: now=2026-05-19T17:00:00+09:00 (Asia/Tokyo)
   scheduler started. registered jobs:
     - sync_catalog | next_run=2026-05-19 18:00:00+09:00
     - resolve_sample_urls | next_run=2026-05-20 03:00:00+09:00
     - sync_actress_profiles | next_run=2026-05-20 04:00:00+09:00
   ```
3. もし `DATABASE_URL does NOT use Railway internal network` の警告が出たら、
   `DATABASE_URL` のホストが `*.railway.internal` になっていない。修正する。

## 4. 動作確認 (任意)

実際にジョブを走らせて egress がゼロ近辺で安定するか確認したい場合:

1. Variables で `SCHEDULER_RUN_ON_START=true` をセットして redeploy
2. Logs で `[job] sync_catalog start (incremental)` → `done` が出るのを待つ
3. Postgres サービスの Metrics タブで Public Network Egress グラフを確認
   - Worker からのアクセスは Private Network なので Public Egress には乗らない
4. 確認できたら `SCHEDULER_RUN_ON_START=false` に戻して redeploy

## 5. 後始末

- [PR #75](https://github.com/furuikeharuki/short-video-media/pull/75) で
  既に sync-catalog.yml / sync-catalog-full.yml の cron を停止済み。
- 本 PR で `migrate.yml` / `sync-catalog.yml` / `sync-catalog-full.yml` /
  `sync-catalog-by-year.yml` / `post-bootstrap.yml` / `resolve-sample-urls.yml`
  を削除する。スキーマ変更時の Alembic migration は `apps/api` の
  lifespan で自動実行される (Dockerfile 参照)。
- 残るワークフローは CI 系 4 つ (api-ci / jobs-ci / web-ci / debug-dmm-api) のみ。

## 6. ワークフロー手動実行が必要になったら

GitHub Actions ではなく以下のいずれかで実行する:

- **Railway ダッシュボード → jobs-worker → Logs** で APScheduler の次回実行を待つ
- 緊急時は Railway dashboard から worker を **Restart** + `SCHEDULER_RUN_ON_START=true` で起動直後実行
- もしくは `railway run --service jobs-worker python -m src.sync_catalog --hits 50` のように
  Railway CLI から one-shot 実行 (この場合も内部接続なので egress なし)

## 7. もし問題発生時のロールバック

- worker サービスを Railway 上で停止 (Settings → Danger Zone → Remove Service)
- GitHub から `git revert <PR commit>` して旧 cron を復活させる (ただし egress 復活するので非推奨)
