# AWS 移行設計メモ

Xserver VPS で稼働させたあとに将来 AWS へ持っていく際の設計指針。
実装の手順書ではなく「設計上どう分けておくと困らないか」をまとめたメモ。

> 関連: [`xserver-vps.md`](./xserver-vps.md)

---

## 1. 想定する AWS 構成 (最小)

```
  ┌──────────┐
  │  Route53 │ api.example.com
  └────┬─────┘
       ▼
  ┌──────────┐
  │   ALB    │ (HTTPS 443 → HTTP 8000)
  └────┬─────┘
       ▼
  ┌─────────────────────┐
  │ ECS on Fargate      │
  │   - api  (FastAPI)  │
  │   - jobs-worker     │
  └────┬────────────────┘
       │ プライベートサブネット内 TCP
       ▼
  ┌─────────────────────┐    ┌─────────────────┐
  │ RDS for PostgreSQL  │    │ ElastiCache     │
  │ (Multi-AZ)          │    │ (任意, Redis)   │
  └─────────────────────┘    └─────────────────┘

  Resolver: Fargate もしくは EC2 (Playwright 用に独立)
  Web: Vercel のまま、もしくは Amplify / CloudFront + S3
```

なるべく **マネージドサービスへ寄せる** 方針 (Fargate / RDS / CloudWatch /
Secrets Manager) で、運用負荷を Xserver VPS より下げることを狙う。

---

## 2. アプリケーション側の設計指針 (現状とのギャップ)

| 項目 | 現状 (Xserver VPS) | AWS 想定 | 必要な対応 |
|------|--------------------|----------|------------|
| 環境分岐 | `DEPLOY_TARGET=xserver` | `DEPLOY_TARGET=aws` | すでに `apps/api/app/core/config.py` と `apps/jobs/src/scheduler.py` で分岐済み |
| DB ホスト | Compose の `db` サービス名 | `*.rds.amazonaws.com` | DATABASE_URL を入れ替えるだけ |
| 秘密情報 | VPS 上 `.env` ファイル | AWS Secrets Manager / SSM Parameter Store | ECS task definition で `secrets:` 経由注入 |
| ログ | Docker logs → journald | CloudWatch Logs | Fargate task の awslogs ドライバ |
| メトリクス | (なし) | CloudWatch + (任意) X-Ray | uvicorn の access log を整形済みで吐く |
| バックアップ | `scripts/backup-postgres.sh` | RDS 自動スナップショット | スクリプトは不要に |
| デプロイ | SSH + docker compose | ECR push + ECS service update | 別 workflow が必要 |

### 2.1 アプリ側で「すでに OK」な点

- `DATABASE_URL` を `postgresql://...@...:5432/...` の文字列で受け取り、
  `async_database_url` が `asyncpg` ドライバへ正規化する → RDS でそのまま動く。
- `is_production` チェックは `localhost / 127.0.0.1` のみ拒否し、RDS の
  プライベートエンドポイントは無条件に許容する設計に修正済み。
- `apps/api/Dockerfile` は単純な `python:3.12-slim` ベース。multi-arch (arm64)
  も同じ Dockerfile で `buildx` で出せる。
- `apps/jobs/Dockerfile.worker` は HTTP ポート公開なしの常駐ワーカーで、
  Fargate の "essential": true タスクとして 1 タスクだけ常駐させればよい。

### 2.2 AWS 移行時に追加で必要になりそうな対応

- **ヘルスチェックエンドポイントの明示**: ALB は `/healthz` 的な GET 200 を
  期待する。現状の `/` は OK だが、`/healthz` を実装して "DB ping 含む shallow"
  と分けるとデプロイ時の段階制御がしやすい。
- **静的なアセット配信**: 現在は不要 (apps/web は Vercel)。将来 CloudFront +
  S3 に集約する場合に署名付き URL を考える。
- **scheduler の冗長化**: APScheduler は単一プロセスを前提に作っている。
  Fargate で 2 タスクに増やすと cron が重複発火する。冗長化したいなら:
    - 「scheduler だけは task count = 1」を維持する (現実的)
    - もしくは Amazon EventBridge Scheduler に置き換える (jobs/* を分割)
- **secrets ローテーション**: `AUTH_SECRET` / `APP_USER_SALT` を Secrets
  Manager で管理し、ECS task definition の secrets セクションから注入する。
  ローテーションは `docs/environments.md` の手順に従って実施。

---

## 3. AWS 移行のステップ案

実際の作業手順イメージ。MVP (small) 想定。

1. **ECR リポジトリ**を 3 つ作成: `short-video-media/api`, `.../jobs-worker`,
   `.../resolver`。
2. **RDS for PostgreSQL 16** をプライベートサブネットに作成 (db.t4g.small 程度から)。
   サブネットグループ + セキュリティグループは ECS タスク用 SG からのみ 5432 許可。
3. **Secrets Manager** に `AUTH_SECRET / APP_USER_SALT / POSTGRES_PASSWORD /
   DMM_API_ID / DMM_AFFILIATE_ID / DMM_LINK_AFFILIATE_ID / RESOLVER_API_KEY` を投入。
4. **ECS Cluster (Fargate)** を作成。VPC は既存があれば再利用。
5. **タスク定義** 3 つを定義:
   - `api`: image=ECR/api:latest, env={`APP_ENV`,`DEPLOY_TARGET=aws`,`ALLOWED_ORIGINS`...},
     secrets={`AUTH_SECRET`,`APP_USER_SALT`,`DATABASE_URL`...},
     port=8000, healthcheck=`curl -f http://localhost:8000/healthz`
   - `jobs-worker`: image=ECR/jobs-worker:latest, ポート無し, desiredCount=1,
     placementConstraints は不要 (1 タスクで一意)
   - `resolver`: image=ECR/resolver:latest, port=8080, ALB 配下に置かないことも検討
6. **ALB + Listener (HTTPS)** を 1 つ立て、Target Group は api タスクへ。
7. **Route53** で `api.example.com` を ALB の DNS に CNAME / Alias。
8. **データ移行**: Xserver の `pg_dump` を EC2 上で `pg_restore` するか、
   DMS (Database Migration Service) を使う。データ量が小さいので
   `pg_dump | psql` で十分。
9. **Vercel (apps/web)** の `API_BASE_URL` / `NEXT_PUBLIC_API_BASE_URL` を
   `https://api.example.com` (AWS 経由) に切替。短時間 503 が起きる前提で
   メンテナンス時間を決める。
10. **CI/CD**: 別 workflow `.github/workflows/deploy-aws.yml` を新設し、
    `docker buildx build --push` で ECR にイメージを上げ、
    `aws ecs update-service --force-new-deployment` を叩く。
    OIDC で IAM ロールを引き受ける形 (`aws-actions/configure-aws-credentials@v4`)
    を採用し、長期 AWS キーは GitHub Secrets に置かないこと。

---

## 4. 必要になる GitHub Secrets (AWS 移行時)

最小:

| Secret | 用途 |
|--------|------|
| `AWS_ROLE_ARN` | OIDC で AssumeRole する IAM ロール ARN |
| `AWS_REGION` | 例: `ap-northeast-1` |
| `AWS_ECR_REGISTRY` | 例: `123456789012.dkr.ecr.ap-northeast-1.amazonaws.com` |
| `AWS_ECS_CLUSTER` | クラスタ名 |
| `AWS_ECS_API_SERVICE` | api のサービス名 |
| `AWS_ECS_JOBS_SERVICE` | jobs-worker のサービス名 |

DB パスワード / アプリ秘密は GitHub には置かず Secrets Manager に閉じ込める。

---

## 5. Xserver と AWS の両運用フェーズ (Blue/Green)

切替直前に AWS で並行稼働させ、DNS で段階的に切り替えたい場合:

- **DB は片側を Primary**, もう片側を read-only レプリカにする (`pglogical` /
  `aws DMS`)。書込先は常に一意に保つ。
- Vercel 側は環境変数だけで API ベース URL を切替可能なので、Preview 環境を
  AWS 側に向け、Production を Xserver 側に向けたまま QA する。
- DMM 同期ジョブは「片方だけ動かす」運用にしないと重複 INSERT が起きる。
  片側の `jobs-worker` を `desiredCount=0` にすること。

---

## 6. やらないこと / 先送りすること

- Lambda 化: APScheduler の cron は Fargate "1 タスク常駐" の方が単純。
  EventBridge + Lambda に分解する設計はワーカー側が大きくなった時に検討。
- マルチリージョン: 当面不要。災害対策は RDS 自動スナップショット + S3 で十分。
- VPC ピアリングや PrivateLink: web を Vercel に置く限り api 側は public ALB
  でよい。Vercel から VPC 内に直接入る構成 (Vercel + AWS Functions) は別議論。
