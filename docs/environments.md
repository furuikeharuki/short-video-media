# 環境変数・運用手順

## 環境変数一覧

### apps/api (FastAPI / Railway)

| 変数 | 必須 | 用途 | 例 |
|-----|-----|------|-----|
| `APP_ENV` | 推奨 | `production` 指定時に `AUTH_SECRET` / `APP_USER_SALT` の検証を厳格化 | `development` / `production` |
| `DATABASE_URL` | ✓ | Postgres 接続文字列 (asyncpg ドライバに自動変換) | `postgresql://user:pass@host:5432/db` |
| `AUTH_SECRET` | ✓ | JWT HS256 署名鍵 (32 文字以上推奨) | `openssl rand -hex 32` |
| `APP_USER_SALT` | ✓ | provider sub のハッシュソルト | `openssl rand -hex 16` |
| `EVENTS_RATE_LIMIT_PER_SECOND` | 任意 | events API の 1 秒あたり上限 (IP ベース) | `10` |
| `EVENTS_RATE_LIMIT_PER_MINUTE` | 任意 | events API の 1 分あたり上限 (IP ベース) | `120` |
| `CORS_ALLOW_ORIGINS` | 任意 | カンマ区切りオリジン | `https://example.com,https://www.example.com` |

### apps/web (Next.js / Vercel)

| 変数 | 必須 | 用途 |
|-----|-----|------|
| `AUTH_SECRET` | ✓ | Auth.js v5 セッション暗号化鍵 (API と同一値) |
| `AUTH_TWITTER_ID` / `AUTH_TWITTER_SECRET` | ✓ | Twitter OAuth |
| `AUTH_DISCORD_ID` / `AUTH_DISCORD_SECRET` | ✓ | Discord OAuth |
| `API_BASE_URL` | ✓ | サーバー側から API を叩く際の URL |
| `NEXT_PUBLIC_API_BASE_URL` | ✓ | クライアント側から API を叩く際の URL |
| `NEXT_PUBLIC_GA_ID` | 任意 | GA4 測定 ID |

### apps/jobs (GitHub Actions)

| 変数 | 必須 | 用途 |
|-----|-----|------|
| `DATABASE_URL` | ✓ | API と同じ Railway Postgres |
| `DMM_API_ID` | ✓ | DMM Webservice API キー |
| `DMM_AFFILIATE_ID` | ✓ | アフィリエイト ID (`xxxxx-001`) |

## `APP_USER_SALT` のローテーション

salt を変更すると **全 `identities.sub_hash` の参照整合性が崩れる**ため、運用上の手順を厳守すること。

### 手順

1. **新 salt を生成**: `openssl rand -hex 16`
2. **メンテナンス通知**: ログイン状態が一時的にリセットされる旨を告知
3. **DB バックアップ**: Railway 管理画面から手動スナップショット取得
4. **環境変数更新**:
   - Railway: `APP_USER_SALT` を新値に更新
   - GitHub Actions secret も同名で更新 (再ハッシュジョブ用)
5. **(任意) 再ハッシュジョブ実行**: 旧 salt を `OLD_APP_USER_SALT` として一時環境変数に設定し、`identities` テーブルの `sub_hash` を `SHA-256(provider:sub_old:NEW_SALT)` の形で更新するスクリプトを実行
   - **provider sub が DB に残っていない**ため、原則として再ハッシュは不可能。salt ローテは「実質的に全ユーザーが再ログイン必要」になる前提で運用すること
6. **検証**: テストアカウントで再ログインし、新 `sub_hash` がレコードされることを確認
7. **旧 salt の安全な破棄**: secret manager から完全削除

### 注意

- 漏洩が疑われない限り、salt のローテはほぼ不要
- salt ローテをルーチン化する場合は、設計を見直して **provider sub を別カラムに暗号化保存** する案を検討

## ローカル開発

```bash
# 1. 環境変数を準備
cp .env.example .env
cp infra/docker/.env.example infra/docker/.env

# 2. Docker で DB を起動
docker compose -f infra/docker/docker-compose.yml up -d postgres

# 3. マイグレーション
pnpm --filter @short-video-media/api run db:migrate

# 4. 各アプリを起動
pnpm --filter @short-video-media/api dev    # http://localhost:8000
pnpm --filter @short-video-media/web dev    # http://localhost:3000
```

## 本番デプロイ

| アプリ | デプロイ先 | トリガ |
|--------|----------|-------|
| web | Vercel | main への push (自動) |
| api | Railway | main への push (自動) |
| jobs | GitHub Actions | cron / 手動 dispatch |

`.github/workflows/migrate.yml` が main 反映時に `alembic upgrade head` を実行。
