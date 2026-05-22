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
│                │   db (Postgres 16)         │           │
│                └────────────────────────────┘           │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │ apps/resolver  (既存 / 別 compose)               │   │
│  │ http://host.docker.internal:8080                 │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
       ▲
       │ HTTPS (Vercel から)
   apps/web (Vercel)
```

- api / jobs-worker / db は `infra/xserver/docker-compose.yml` で起動する
  別 compose project (`short-video-media-xserver`)。
- 既存 resolver の compose とはネットワーク的に隔離されているため、
  api → resolver は `host.docker.internal` (Linux では明示的に
  `extra_hosts` 設定が必要) もしくは VPS の外向き IP 経由で叩く。

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

Railway 側で DB がある状態を前提に、VPS の新しい Postgres にデータを移す。

```bash
# (a) Railway 側で論理ダンプを取得 (PC や Railway CLI 経由)
railway run -- pg_dump $RAILWAY_DATABASE_URL \
  --no-owner --clean --if-exists \
  > shortvideo-from-railway.sql

# (b) VPS にコピー
scp shortvideo-from-railway.sql deploy@<HOST>:/tmp/

# (c) VPS 上で db コンテナだけ先に起動
ssh deploy@<HOST>
cd /opt/short-video-media
docker compose -f infra/xserver/docker-compose.yml up -d db

# (d) ダンプを流し込む
docker compose -f infra/xserver/docker-compose.yml exec -T db \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" < /tmp/shortvideo-from-railway.sql
```

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
