# Xserver VPS への移行手順

Railway 上で稼働している `apps/api` と `apps/jobs` (worker) を Xserver VPS へ
移すための手順書。`apps/resolver` はすでに同じ VPS で動いている前提。
`apps/web` (Next.js) は Vercel 上のまま変更しない。

> 関連ファイル
> - `infra/xserver/docker-compose.yml`
> - `infra/xserver/.env.example`
> - `infra/xserver/Caddyfile`
> - `scripts/deploy-xserver.sh`
> - `scripts/backup-postgres.sh`
> - `.github/workflows/deploy-xserver.yml`

---

## 1. 全体構成

```
┌─────────────────────────────────────────────────────────┐
│                       Xserver VPS                       │
│                                                         │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ Caddy    │→ │ api (8000)   │  │ jobs-worker      │   │
│  │ (443/80) │  │ FastAPI      │  │ APScheduler 常駐 │   │
│  └──────────┘  └──────┬───────┘  └─────┬────────────┘   │
│                       │ TCP            │ TCP            │
│                       ▼                ▼                │
│                ┌────────────────────────────┐           │
│                │   db (Postgres 18)         │           │
│                └────────────────────────────┘           │
│                       │                                 │
│                       │ HTTP (内部 docker network)      │
│                       ▼                                 │
│           ┌─────────────────────────────┐               │
│           │ resolver (8080)             │               │
│           │ FastAPI + Playwright/Chrome │               │
│           │ (apps/api/Dockerfile.       │               │
│           │  resolver からビルド)       │               │
│           └─────────────────────────────┘               │
└─────────────────────────────────────────────────────────┘
       ▲
       │ HTTPS (Vercel から)
   apps/web (Vercel)
```

- api / resolver / jobs-worker / db は `infra/xserver/docker-compose.yml`
  で起動する単一 compose project (`short-video-media-xserver`)。
- resolver は以前 `apps/resolver` として独立した FastAPI サービスだったが、
  `apps/api` パッケージへ統合済み (`app.resolver`)。本 compose 内で
  `apps/api/Dockerfile.resolver` (Playwright base ~2GB) からビルドして
  起動する。
- api / jobs-worker → resolver の通信は同 docker network 内の
  `http://resolver:8080` で完結する (host.docker.internal は不要)。

---

## 1.1 Resolver の統合 / 切替手順

旧 `apps/resolver` を VPS 上で別 compose / 単体コンテナとして動かしていた
場合は、新 compose を `up -d` する前に止めること。新 compose の `resolver`
サービスは expose のみで host ポートを開けない (`8080` を bind しない)
ため、ポート競合自体はほぼ起きないが、Chromium プロセスとメモリの
重複を避けるため必ず停止する。

```bash
ssh deploy@<VPS-HOST>

# 1) 旧 resolver を停止
#    docker run で立てていた場合:
docker stop resolver && docker rm resolver
#    旧 compose で立てていた場合 (パスは環境による):
# cd /opt/old-resolver && docker compose down

# 2) 統合後のコードに更新
cd /opt/short-video-media
git pull --ff-only
# infra/xserver/.env の RESOLVER_BASE_URL は **必ず削除** すること。
# (docker-compose.yml の environment が http://resolver:8080 を強制する。
#  旧値が残っていると api コンテナの DNS 解決に失敗し /resolve-mp4 が
#  502 を返す不具合があったため、念のため `unset` も推奨。)
grep -v '^RESOLVER_BASE_URL=' infra/xserver/.env > infra/xserver/.env.tmp && mv infra/xserver/.env.tmp infra/xserver/.env || true

# 3) build & up
docker compose -f infra/xserver/docker-compose.yml build api resolver jobs-worker
docker compose -f infra/xserver/docker-compose.yml up -d

# 4) 動作確認
docker compose -f infra/xserver/docker-compose.yml ps
# resolver: healthy になるまで 30〜60 秒程度 (Chromium 起動分)
docker compose -f infra/xserver/docker-compose.yml exec api \
  python -c "import urllib.request,json; \
  print(urllib.request.urlopen('http://resolver:8080/health', timeout=5).read().decode())"
# → {"status":"ok","browser_running":true}

# (任意) 旧イメージのクリーンアップ
docker image prune -f
```

`RESOLVER_API_KEY` は旧 resolver と同じ値を `.env` に残しておけば、
キャッシュ済み MP4 URL も含めて挙動は完全互換になる。

---

## 2. 事前準備

### 2.1 VPS 側

1. **Docker / Docker Compose プラグイン**を導入。
   ```bash
   sudo apt-get update
   sudo apt-get install -y ca-certificates curl
   sudo install -m 0755 -d /etc/apt/keyrings
   curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
     | sudo tee /etc/apt/keyrings/docker.asc > /dev/null
   echo \
     "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
     https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
     | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
   sudo apt-get update
   sudo apt-get install -y docker-ce docker-ce-cli containerd.io \
     docker-buildx-plugin docker-compose-plugin
   sudo usermod -aG docker "$USER"     # 反映には再ログイン要
   ```

2. **デプロイ専用ユーザー**を作る (例: `deploy`)。`docker` グループに入れる。
   公開鍵を `~deploy/.ssh/authorized_keys` に登録。
   ```bash
   sudo useradd -m -s /bin/bash deploy
   sudo usermod -aG docker deploy
   sudo -u deploy mkdir -p ~deploy/.ssh
   sudo -u deploy tee ~deploy/.ssh/authorized_keys < deploy.pub
   sudo chmod 700 ~deploy/.ssh
   sudo chmod 600 ~deploy/.ssh/authorized_keys
   ```

3. **リポジトリを clone** (例: `/opt/short-video-media`)。
   ```bash
   sudo mkdir -p /opt/short-video-media
   sudo chown deploy:deploy /opt/short-video-media
   sudo -u deploy git clone https://github.com/furuikeharuki/short-video-media.git \
     /opt/short-video-media
   ```

4. `.env` を用意する。
   ```bash
   cd /opt/short-video-media/infra/xserver
   cp .env.example .env
   $EDITOR .env
   # AUTH_SECRET / APP_USER_SALT / POSTGRES_PASSWORD / DMM_* を埋める
   ```
   - `AUTH_SECRET` / `APP_USER_SALT` は Vercel (apps/web) と同一値にする。
   - `RESOLVER_API_KEY` は既存 resolver の `.env` と同じ値を使う。

5. **ファイアウォール**: VPS のファイアウォール / iptables で 22, 80, 443 のみ開放。
   Postgres (5432) は外向きに開けない。

### 2.2 GitHub Secrets

| Secret 名 | 必須 | 用途 |
|----------|-----|------|
| `XSERVER_SSH_HOST` | ✓ | VPS の IP / FQDN |
| `XSERVER_SSH_USER` | ✓ | デプロイ用 SSH ユーザー名 (例: `deploy`) |
| `XSERVER_SSH_PORT` | 任意 | SSH ポート (デフォルト 22) |
| `XSERVER_SSH_KEY` | ✓ | デプロイ用秘密鍵 (Ed25519 推奨。OpenSSH 形式そのまま全文を貼る) |
| `XSERVER_KNOWN_HOSTS` | ✓ | `ssh-keyscan -p <port> <host>` の出力 (最低 1 行) |
| `XSERVER_REPO_DIR` | ✓ | VPS 上のリポジトリパス (例: `/opt/short-video-media`) |
| `XSERVER_BUILD_OPTS` | 任意 | `--no-cache` などビルドオプション |

> 鍵生成例:
> ```bash
> ssh-keygen -t ed25519 -f xserver-deploy -C "github-actions@short-video-media" -N ""
> ssh-copy-id -i xserver-deploy.pub deploy@<HOST>
> ssh-keyscan -p 22 <HOST> > known_hosts.txt
> ```
> 秘密鍵 `xserver-deploy` の中身全文を `XSERVER_SSH_KEY` に、
> `known_hosts.txt` の中身を `XSERVER_KNOWN_HOSTS` に登録する。

---

## 3. 初回デプロイ

### 3.1 Railway からのデータ移行 (DB)

> ⚠️ **Postgres バージョン整合 (重要)**
>
> Railway 側 Postgres は **18.3** で稼働中。pg_dump は server より古い
> メジャーでは `aborting because of server version mismatch` で失敗するため、
> 以下を **18 系に揃える** こと:
>
> - VPS 側 `db` サービス: `infra/xserver/docker-compose.yml` → `postgres:18-alpine` (本リポジトリで既に設定済み)
> - 移行スクリプト内の pg_dump/pg_restore イメージ: 既定で `postgres:18-alpine`。
>   別バージョンに切替が必要なら `POSTGRES_TOOLS_IMAGE=postgres:18-alpine` で上書き
>
> 既に `postgres:16-alpine` の VPS db で空の volume を作成していた場合は、
> PGDATA がメジャー間で非互換なため **ボリュームごと作り直し** が必要:
>
> ```bash
> # まだ本番データを入れていない前提 (中身を消してよい場合のみ)
> cd /opt/short-video-media
> docker compose -f infra/xserver/docker-compose.yml down -v
> # ↑ -v で postgres_data ボリュームも削除される
> git pull --ff-only
> docker compose -f infra/xserver/docker-compose.yml up -d db
> docker compose -f infra/xserver/docker-compose.yml exec db postgres -V
> # → "postgres (PostgreSQL) 18.x" であることを確認
> ```

VPS 上で **`scripts/migrate-from-railway.sh`** を実行すれば、
Railway Postgres から VPS の `db` コンテナへ pg_dump (custom format) →
pg_restore を一括で実施できる。Railway DATABASE_URL はコマンドライン引数では
受け取らず、環境変数 or 無エコー stdin で渡す設計になっている。

```bash
# VPS 上で
ssh deploy@<HOST>
cd /opt/short-video-media

# 事前に infra/xserver/.env を用意しておくこと (POSTGRES_* が必要)
ls infra/xserver/.env

# (推奨) 対話入力で実行: URL は画面に表示されない / シェル履歴に残らない
./scripts/migrate-from-railway.sh
# プロンプトで Railway DATABASE_URL を貼り付け Enter
# その後 "yes" で続行確認

# (非対話) 環境変数経由。CI / 自動化用。シェル履歴を別途消すこと。
# RAILWAY_DATABASE_URL=postgresql://... ./scripts/migrate-from-railway.sh
# ※ 非対話で動かすには ASSUME_YES=yes も指定が必要
```

スクリプトの主な挙動:

1. `infra/xserver/.env` から `POSTGRES_USER` / `POSTGRES_DB` /
   `POSTGRES_PASSWORD` を読み取り、不足していれば停止
2. Railway DATABASE_URL を環境変数 or 無エコー入力で受け取る
   (argv / log には残さない)
3. `~/db-migration/` (`DUMP_DIR` で上書き可) に
   `railway-<DB>-<UTC>.dump` を **custom format (`-Fc`)** で保存。
   ディレクトリ権限は `700`、ファイル権限は `600` に固定
4. compose の `db` サービスを起動 + healthcheck 待機
5. dump を `db` コンテナの `pg_restore` に流し込む。
   - デフォルトは `RESTORE_MODE=append` (`--no-owner --no-privileges --exit-on-error`)
   - 既存テーブルを削除して入れ替えたい時は `RESTORE_MODE=clean` を指定。
     `--clean --if-exists` が付くため、続行前に **二段階の "yes" 確認**を要求する

オプション環境変数:

| 変数 | 用途 | デフォルト |
|------|------|-----------|
| `DUMP_DIR` | dump 保存先 | `~/db-migration` |
| `DUMP_FILE` | 既存 dump を再利用 (相対なら DUMP_DIR 配下) | 新規生成 |
| `SKIP_DUMP` | `yes` で dump を取らず既存を再利用 | `no` |
| `RESTORE_MODE` | `append` or `clean` | `append` |
| `ASSUME_YES` | `yes` で対話確認を全スキップ (非対話 CI 用、推奨しない) | `no` |
| `POSTGRES_TOOLS_IMAGE` | pg_dump / pg_restore 用 docker イメージ。**Railway の Postgres メジャー (現在 18.3) に揃えること** | `postgres:18-alpine` |
| `PG_DUMP_IMAGE` | 旧変数名。`POSTGRES_TOOLS_IMAGE` 未設定時のフォールバックとして引き続き受理 | (未設定) |
| `COMPOSE_FILE` | compose ファイルパス | `infra/xserver/docker-compose.yml` |

> 🔐 **dump ファイルの取り扱い**
> dump はユーザーデータを含む機微情報。VPS 上で動作確認が済んだら必ず
> `shred -u ~/db-migration/railway-*.dump` で安全削除すること。
> `~/db-migration` 自体も用途を終えたら `rm -rf` で消す。

> ⚠️ **移行後に必ず実施すること**
> - `infra/xserver/.env` の `SCHEDULER_BOOTSTRAP=false` を確認 (true のままだと
>   jobs-worker 起動直後に 2008-2026 の full sync が走り、Railway 移行直後の
>   DB へ膨大な INSERT を行ってしまう)
> - **Railway 側のセキュリティ後処理** (詳細は §8)

### 3.2 API / jobs-worker をビルド・起動

```bash
cd /opt/short-video-media
./scripts/deploy-xserver.sh
```

これは以下と等価:
```bash
docker compose -f infra/xserver/docker-compose.yml build
docker compose -f infra/xserver/docker-compose.yml up -d --remove-orphans
```

api の lifespan で alembic upgrade head が走るため、明示的なマイグレーションは不要。
明示的に走らせたいときは:

```bash
docker compose -f infra/xserver/docker-compose.yml run --rm api alembic upgrade head
```

### 3.3 Caddy (リバプロ) の起動

既存 resolver が 80/443 を握っているかで分岐する。

- **resolver 側の Caddy / nginx に統合する場合 (推奨):**
  既存設定に `api.example.com → http://<docker-host>:8000` (もしくは
  `api:8000` で見える設定) を追記し、本 compose では caddy を起動しない。
- **本 compose の Caddy を使う場合:**
  ```bash
  docker compose -f infra/xserver/docker-compose.yml --profile proxy up -d caddy
  ```
  `API_DOMAIN` を `.env` でドメインに合わせて設定すること。

### 3.4 Vercel (apps/web) 側の API_BASE_URL を切替

Vercel プロジェクトの環境変数を Railway の旧ドメインから VPS の新ドメインへ:

| Env | 旧 | 新 |
|-----|-----|-----|
| `API_BASE_URL` | `https://<railway>.up.railway.app` | `https://api.example.com` |
| `NEXT_PUBLIC_API_BASE_URL` | 同上 | 同上 |

切替後に Vercel の "Redeploy" を実行。

---

## 4. 継続デプロイ (GitHub Actions)

`main` ブランチに以下が push されると `Deploy (Xserver VPS)` workflow が走る:

- `apps/api/**`
- `apps/jobs/**`
- `infra/xserver/**`
- `scripts/deploy-xserver.sh`
- `scripts/backup-postgres.sh`
- `.github/workflows/deploy-xserver.yml`

挙動:

1. ubuntu-latest runner で `actions/checkout@v4` (メタデータのみ)
2. `XSERVER_SSH_KEY` を `ssh-agent` に流し込む (ファイル化しない)
3. `ssh deploy@<HOST> bash -s` 経由で `scripts/deploy-xserver.sh` を実行
4. VPS 上で `git fetch && git checkout <sha> && docker compose build && up -d`

手動デプロイは Actions → "Deploy (Xserver VPS)" → "Run workflow" から
任意 ref を渡せる。

---

## 5. バックアップ

VPS 上で cron 登録:

```cron
# /etc/cron.d/short-video-media-backup
# JST 04:30 = UTC 19:30 (前日)
30 19 * * * deploy /opt/short-video-media/scripts/backup-postgres.sh \
  >> /var/log/short-video-media/backup.log 2>&1
```

- 出力先: `/var/backups/short-video-media/<DB>-YYYYMMDDTHHMMSSZ.sql.gz`
- 14 日保持 (`RETENTION_DAYS=14`)
- 復元:
  ```bash
  gunzip < shortvideo-<TS>.sql.gz \
    | docker compose -f infra/xserver/docker-compose.yml exec -T db \
        psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
  ```

定期的に `scp` で別ホスト or S3 へ持ち出すことを強く推奨。

---

## 6. ロールバック

`scripts/deploy-xserver.sh` は実行のたびに `pre-deploy-<UTC timestamp>` の
ローカル tag を打つ。直前の状態に戻すには:

```bash
cd /opt/short-video-media
git tag | grep pre-deploy- | tail
# 例: pre-deploy-20260522T103045Z
git reset --hard pre-deploy-20260522T103045Z
docker compose -f infra/xserver/docker-compose.yml up -d --build
```

DB スキーマを巻き戻す必要があるなら別途 `alembic downgrade <rev>` を実行。

---

## 7. 既知の制約 / 注意

- **`apps/jobs/Dockerfile.worker` の egress 想定コメントは Railway 文脈のまま** で
  ある可能性が高いが、Xserver では `db` への接続は同 Docker network 内 TCP に
  なるため egress 課金問題自体は発生しない。
- **resolver 経由 MP4 抽出**を本 compose 内に同居させる選択肢もあるが、
  既存 resolver と Playwright プロセスを重複起動するメリットは小さいので
  当面は分離運用のままにする。
- **Caddy の自動証明書取得**は 80/443 が外部から到達できる必要がある。
  Cloudflare 等の前段プロキシを挟む場合は DNS-01 challenge を有効化すること。

---

## 8. Railway 後処理 (DB 移行が完了したら)

### 8.1 jobs-worker のブートストラップを止める

移行直後に `infra/xserver/.env` の `SCHEDULER_BOOTSTRAP=true` が残っていると、
jobs-worker 起動時に 2008-2026 年分の DMM 同期 + resolve + actress が走り、
**Railway から持ち込んだデータに対して大量の INSERT / UPDATE をかける**ため
DB に強い負荷がかかる。次の手順で確実に止める:

```bash
# VPS 上
cd /opt/short-video-media
grep -E '^SCHEDULER_BOOTSTRAP=' infra/xserver/.env
# → SCHEDULER_BOOTSTRAP=false であることを確認 (true なら書き換え)

# 必要なら jobs-worker を再起動して反映
docker compose -f infra/xserver/docker-compose.yml up -d jobs-worker
docker compose -f infra/xserver/docker-compose.yml logs --tail=50 jobs-worker
# "scheduler started. registered jobs:" の直後に bootstrap が起動して
# いないことをログで確認
```

通常運用は APScheduler の cron (`sync_catalog` 2 時間ごと等) に任せる。
過去全件再取得が必要な場合のみ、**意図的に** `SCHEDULER_BOOTSTRAP=true` に
戻して 1 度だけ走らせ、完了したらすぐ false に戻して redeploy する。

### 8.2 Railway 側 DB の認証情報をローテーション / 停止

移行スクリプトに渡した `RAILWAY_DATABASE_URL` には URL ベタ書きの
パスワードが含まれている。スクリプト側では argv / ログに出さない設計だが、
**この値が漏れた瞬間 Railway の DB に外部から接続可能**になるため、
動作確認が済んだら必ず以下を実施する:

1. **Railway DB のパスワードをローテーション**
   - Railway ダッシュボード → Project → Postgres サービス
   - "Variables" タブで `POSTGRES_PASSWORD` を再生成
   - もしくは Railway CLI: `railway variables --service postgres --set POSTGRES_PASSWORD=<new>`
   - 旧パスワードは即時無効化されるので、移行スクリプトを再実行する予定が
     あるなら**ローテ前に**もう一度走らせる
2. **Railway 側 api / jobs-worker サービスを停止または削除**
   - 旧 api が走っていると Vercel から切り替え漏れで二重書き込みが起きる
   - Railway の "Settings" → "Danger" → "Remove Service" もしくは "Pause"
3. **Railway DATABASE_URL を含む手元シェル履歴 / クリップボードを破棄**
   - bash: `history -c && history -w` (RAILWAY_DATABASE_URL を export した
     セッションで実施)
   - zsh: `LC_ALL=C sed -i '' '/RAILWAY_DATABASE_URL/d' ~/.zsh_history`
   - VPS の `~/.bash_history` も一度 grep して該当行を削除
4. **dump ファイルの安全削除**
   ```bash
   shred -u ~/db-migration/railway-*.dump
   rmdir ~/db-migration   # 中身が空になったら
   ```
5. **GitHub / Vercel 側に Railway URL が残っていないか確認**
   - GitHub Repository Settings → Secrets で `DATABASE_URL` / `RAILWAY_*`
     系の Secret が残っていれば削除
   - Vercel プロジェクトの Environment Variables も同様に整理

> 補足: パスワードローテだけで Railway DB 本体を残すと、しばらく後に
> 古い URL が `.env` 等にコピペで残っていて誤接続する事故が起きやすい。
> **データ移行が完了し動作確認が済んだら Railway DB 自体を削除する**
> のが最も安全。

### 8.3 jobs-worker の定期実行ジョブを .env で調整する

`apps/jobs/src/scheduler.py` は APScheduler で 3 種類のジョブを内部 cron で
回している。何を、どのくらい、いつ取得するかは `SCHEDULE_*` 環境変数で
上書きできる。未設定なら従来挙動 (sync_catalog incremental / resolve 全件 /
actress only-missing、JST 08:00 から 2h ごと + 11:00 + 13:00) を維持する。

主な変数 (`infra/xserver/.env.example` にもコメント付きでテンプレあり):

| 変数 | デフォルト | 用途 |
| --- | --- | --- |
| `SCHEDULE_ENABLE_SYNC_CATALOG` | `true` | sync_catalog ジョブの登録有無 |
| `SCHEDULE_ENABLE_RESOLVE_SAMPLE_URLS` | `true` | resolve_sample_urls (NULL 差分埋め) の登録有無 |
| `SCHEDULE_ENABLE_RESOLVE_SAMPLE_URLS_FULL_REFRESH` | `false` | 月次フルリフレッシュ (全件再解決) の登録有無 |
| `SCHEDULE_ENABLE_ACTRESS_PROFILES` | `true` | sync_actress_profiles ジョブの登録有無 |
| `SCHEDULE_SYNC_CATALOG_MODE` | `incremental` | `incremental` / `full` |
| `SCHEDULE_SYNC_CATALOG_FLOORS` | (未設定) | カンマ区切り。空なら sync_catalog のデフォルトフロア |
| `SCHEDULE_SYNC_CATALOG_HITS_PER_FLOOR` | `100` | 1 floor あたり取得件数 |
| `SCHEDULE_RESOLVE_LIMIT` | (未設定) | 1 回の resolve で扱う件数上限 (差分埋め) |
| `SCHEDULE_RESOLVE_FULL_REFRESH_LIMIT` | (未設定) | 月次フルリフレッシュ時の件数上限 |
| `SCHEDULE_ACTRESS_ONLY_MISSING` | `true` | 欠損のある女優のみ更新 |
| `SCHEDULE_ACTRESS_LIMIT` | (未設定) | 1 回の actress 同期で扱う件数上限 |
| `SCHEDULE_SYNC_CATALOG_CRON_HOUR` | `8,10,12,14,16,18,20` | sync_catalog 時刻 (JST) |
| `SCHEDULE_SYNC_CATALOG_CRON_MINUTE` | `0` | sync_catalog 分 |
| `SCHEDULE_RESOLVE_CRON_HOUR` / `_MINUTE` | `11` / `0` | resolve_sample_urls 時刻 (JST) |
| `SCHEDULE_RESOLVE_FULL_REFRESH_CRON_DAY` / `_HOUR` / `_MINUTE` | `1` / `3` / `0` | 月次フルリフレッシュの cron (毎月 1 日 03:00 JST) |
| `SCHEDULE_ACTRESS_CRON_HOUR` / `_MINUTE` | `13` / `0` | sync_actress_profiles 時刻 (JST) |

> 月次フルリフレッシュ (`SCHEDULE_ENABLE_RESOLVE_SAMPLE_URLS_FULL_REFRESH=true`)
> は、DMM 側 CDN の MP4 URL が数週間〜数カ月で期限切れになるケースに備えた
> 全件再解決ジョブ。通常の `resolve_sample_urls` (毎日 11:00) は
> `sample_movie_url IS NULL` のみ対象だが、こちらは content_id を持つ全 movies
> を対象に再解決する。Playwright を全件分回すため数時間〜数十時間かかり得る
> ので、深夜帯 (デフォルト 毎月 1 日 03:00 JST) に走らせる。

反映方法:

```bash
# VPS 上
cd /opt/short-video-media
vi infra/xserver/.env  # SCHEDULE_* を編集
# jobs-worker を作り直す (環境変数は再起動でなく recreate でしか反映されない)
docker compose -f infra/xserver/docker-compose.yml up -d jobs-worker
docker compose -f infra/xserver/docker-compose.yml logs --tail=50 jobs-worker
# "scheduler started. registered jobs:" に意図したジョブだけが並ぶことを確認
```

> ⚠️ `SCHEDULER_BOOTSTRAP=true` で Xserver VPS 上で全件再取得を回している
> 最中に jobs-worker を recreate する (`docker compose up -d jobs-worker`) と
> 走行中のブートストラップは強制終了する。SCHEDULE_* の変更を反映したい
> だけのときは、ブートストラップが落ち着いてから recreate するのが安全。

---

## 9. トラブルシュート

### 9.1 `pg_dump: error: aborting because of server version mismatch`

```
pg_dump: error: aborting because of server version mismatch
pg_dump: detail: server version: 18.3; pg_dump version: 16.x
```

pg_dump のメジャーが Railway 側より古い時に出る。原因と対処:

- 原因: `POSTGRES_TOOLS_IMAGE` (旧 `PG_DUMP_IMAGE`) が `postgres:16-alpine` のままになっている。
- 対処: 既定の `postgres:18-alpine` を使う (本リポジトリの既定)。
  既に環境変数で 16 を渡している場合は `unset PG_DUMP_IMAGE POSTGRES_TOOLS_IMAGE` するか
  `POSTGRES_TOOLS_IMAGE=postgres:18-alpine` を明示。

### 9.2 db コンテナが Postgres 16 のまま起動してしまう

`docker compose up -d db` 後に `postgres -V` で確認したらまだ 16 だった場合:

- 原因: 既存の `postgres_data` ボリュームが 16 系の PGDATA で初期化されている
  (PGDATA 内の `PG_VERSION` ファイルがメジャー一致しないと 18 のコンテナは起動しない)。
- 対処 (本番データ未投入の前提):
  ```bash
  cd /opt/short-video-media
  docker compose -f infra/xserver/docker-compose.yml down -v
  git pull --ff-only
  docker compose -f infra/xserver/docker-compose.yml up -d db
  docker compose -f infra/xserver/docker-compose.yml exec db postgres -V
  ```
- 既に本番データが入っているなら、`down -v` する前に必ず
  `scripts/backup-postgres.sh` で dump を取り、新ボリュームで `pg_restore` で戻す。

### 9.3 Railway 側のメジャーが将来上がった場合

- `infra/xserver/docker-compose.yml` の `db.image`
- 既定の `POSTGRES_TOOLS_IMAGE`
- `scripts/backup-postgres.sh` で使うクライアントメジャー (現状は db コンテナ内の pg_dump を使うため自動追随)

の 3 点を同じメジャーに揃える。pg_dump のクライアントは **server と同じか新しい** メジャーであれば動くため、サーバ側を先に上げてからクライアント側を追従させる順序が安全。

### 9.4 `chmod: ... 許可されていない操作です` (dump ファイルが root 所有)

```
chmod: '/home/deploy/db-migration/railway-shortvideo-...dump' のパーミッションを変更しています: 許可されていない操作です
```

過去のバージョンの `scripts/migrate-from-railway.sh` で `docker run` に
`--user` 指定を入れていなかったため、コンテナ内 root で dump が書き出され、
ホスト側 `deploy` ユーザーから `chmod` / `mv` できなくなる事象。

- **修正済み**: 現行スクリプトは `docker run --user "$(id -u):$(id -g)"` を
  渡すため、新しい dump はホスト実行ユーザー所有で作られる。
- **既に root 所有 dump が `~/db-migration/` に残っている場合**: スクリプト
  冒頭の検出ロジックが停止して案内するが、手動でも以下で解消できる:

  ```bash
  # 自分の所有に戻す (中身を保持したい場合)
  sudo chown -R "$(id -u):$(id -g)" ~/db-migration

  # もしくは中身を破棄して再取得する場合
  sudo rm -f ~/db-migration/railway-*.dump ~/db-migration/railway-*.dump.partial
  ```

  どちらかを実施したあと、再度 `./scripts/migrate-from-railway.sh` を実行する。

### 9.5 db コンテナが再起動ループ (Postgres 18 で volume mount 先が古い)

ログに以下のような行が見える場合:

```
This PostgreSQL data directory contains a lost+found directory ...
... /var/lib/postgresql/data ... (unused mount/volume) ...
```

Postgres 18 公式イメージは **VOLUME を `/var/lib/postgresql` に変更** し、
PGDATA を `/var/lib/postgresql/18/docker` 既定にした (将来の `pg_upgrade --link`
を効かせるための再配置)。従来通り `/var/lib/postgresql/data` に mount すると
v18 では「期待されない場所にデータがある」とみなされ起動失敗 / 再起動ループに
入る。

- **修正済み**: `infra/xserver/docker-compose.yml` の db.volumes は
  `postgres_data:/var/lib/postgresql` (v18 公式推奨) に変更済み。
- **既に旧パスで空の volume を作って失敗している場合** は、新規データ未投入の
  前提でボリュームごと作り直す:

  ```bash
  cd /opt/short-video-media
  git pull --ff-only origin main
  docker compose -f infra/xserver/docker-compose.yml down -v
  docker compose -f infra/xserver/docker-compose.yml up -d db
  docker compose -f infra/xserver/docker-compose.yml logs --tail=30 db
  # "database system is ready to accept connections" が出れば OK
  docker compose -f infra/xserver/docker-compose.yml exec db postgres -V
  # "postgres (PostgreSQL) 18.x" を確認
  ```

- 既に本番データが入っていてどうしても残したい場合は、`pg_dump` を取得して
  `down -v` → 新ボリュームで `pg_restore` する。`docker run` で旧 mount 先
  (`/var/lib/postgresql/data`) と新 mount 先 (`/var/lib/postgresql/18/docker`)
  を両方マウントして `mv` で移動する手もあるが、空 volume なら作り直しが最も
  確実。

### 9.6 `api` build で `COPY pyproject.toml: not found`

`docker compose -f infra/xserver/docker-compose.yml build api` が以下で失敗する場合:

```
ERROR [api 3/4] COPY pyproject.toml .
... "/pyproject.toml": not found
```

原因: 旧 compose 定義で api の `build.context` が repo root (`../..`) になっており、
`apps/api/Dockerfile` の `COPY pyproject.toml .` (context ルート直下を期待) と
噛み合っていなかった。

- **修正済み**: `infra/xserver/docker-compose.yml` の api を
  `context: ../../apps/api` + `dockerfile: Dockerfile` に変更済み
  (worker 側は逆に repo root context が必要なため `context: ../..` のまま)。
- **VPS 側対応**:

  ```bash
  cd /opt/short-video-media
  git pull --ff-only origin main
  docker compose -f infra/xserver/docker-compose.yml build api jobs-worker
  docker compose -f infra/xserver/docker-compose.yml up -d api jobs-worker
  ```

- 既に古い compose 定義でビルドキャッシュが汚れている場合は
  `docker compose -f infra/xserver/docker-compose.yml build --no-cache api` で
  再ビルドする。
