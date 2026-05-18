# apps/resolver

DMM litevideo iframe から MP4 直リンク URL を抽出する FastAPI サービス。

要件定義書 v5.2 §3.7 / §6 (Phase 4 Stage A/B) に対応する Stage A の実装。

---

## 概要

- **入力**: `content_id` (+ optional `affiliate_id`)
- **出力**: `https://cc3001.dmm.co.jp/pv/<token>/<cid><suffix>.mp4`
- **方式**: Playwright (Chromium headless) で litevideo iframe を開き、`<video>` の `src` を取り出す。取れなければネットワーク監視 (`cc3001.dmm.co.jp/*.mp4`) からフォールバック。
- **制約**: DMM CDN は **日本 IP 必須**。海外 IP は `not-available-in-your-region` にリダイレクトされる。
- **状態**: 完全ステートレス。キャッシュと DB 書き戻しは `apps/api` 側の責務。

### Stage A / Stage B

| | Stage A (現在) | Stage B (将来) |
|---|---|---|
| ホスト | Xserver VPS 2GB Tokyo | AWS Tokyo (Lambda Function URL or Fargate Spot) |
| 月額 | ¥936 (12ヶ月一括 + 20%キャッシュバック) | 従量課金 |
| 切替条件 | リクエスト数増加 / 可用性要件アップ | - |

Dockerfile はポータブルに作っているため、Stage B では同じイメージを AWS にデプロイするだけで動く想定。

---

## エンドポイント

### `GET /health`
認証不要。Browser が起動しているか返す。

```json
{ "status": "ok", "browser_running": true }
```

### `POST /resolve`
Bearer 認証必須。

**Request:**
```json
{ "content_id": "1sun00052a", "affiliate_id": "xxxx-001" }
```
`affiliate_id` は省略可 (省略時は環境変数 `DMM_AFFILIATE_ID` を使用)。

**Response 200:**
```json
{
  "content_id": "1sun00052a",
  "mp4_url": "https://cc3001.dmm.co.jp/pv/<token>/1sun00052a_mhb_w.mp4"
}
```

**Error mapping:**
| HTTP | 原因 |
|---|---|
| 401 | Bearer トークン不正 |
| 404 | `<video>` も network 上の .mp4 も見つからない |
| 502 | DMM 側のエラー / 地域制限リダイレクト |
| 504 | Playwright のタイムアウト |

---

## 環境変数

`.env.example` をコピーして `.env` に設定する。

| 変数 | 必須 | デフォルト | 説明 |
|---|---|---|---|
| `RESOLVER_API_KEY` | ✅ | - | Bearer 認証キー (apps/api と共有) |
| `DMM_AFFILIATE_ID` | ✅ | - | DMM アフィリエイト ID |
| `RESOLVER_CONCURRENCY` | | 2 | 同時実行数 (Xserver 2GB なら 2) |
| `RESOLVER_NAV_TIMEOUT_MS` | | 15000 | iframe 遷移タイムアウト |
| `RESOLVER_WAIT_VIDEO_TIMEOUT_MS` | | 8000 | `<video>` 検出タイムアウト |
| `RESOLVER_LOG_LEVEL` | | INFO | ログレベル |

---

## ローカル開発

### セットアップ

```bash
cd apps/resolver
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
python -m playwright install chromium
cp .env.example .env
# .env を編集
```

### テスト

```bash
pytest -v
```

テストは Playwright をモック化しているため、Chromium が起動できない環境でも実行可能。

### サーバ起動

```bash
uvicorn src.main:app --host 0.0.0.0 --port 8080 --reload
```

ヘルスチェック:
```bash
curl http://localhost:8080/health
```

resolve 呼び出し:
```bash
curl -X POST http://localhost:8080/resolve \
  -H "Authorization: Bearer $RESOLVER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content_id":"1sun00052a"}'
```

**注**: ローカル (日本以外の IP) からは DMM CDN が地域制限で 502 を返す。実 URL の動作確認は Xserver VPS にデプロイしてから行う。

---

## Docker

```bash
# ビルド (apps/resolver/ で実行)
docker build -t shortvideo/resolver .

# 実行
docker run --rm -p 8080:8080 \
  -e RESOLVER_API_KEY=devkey \
  -e DMM_AFFILIATE_ID=xxxx-001 \
  shortvideo/resolver
```

ベースイメージは `mcr.microsoft.com/playwright/python:v1.45.0-jammy` (Chromium 同梱)。イメージサイズは ~2GB。

---

## Xserver VPS デプロイ手順 (Stage A)

### 0. 前提
- Xserver VPS 2GB Tokyo 契約済み (Ubuntu 22.04, 12ヶ月一括)
- root / 一般ユーザのログイン情報を取得済み
- ドメイン (任意): `resolver.example.com` を Xserver の IP に DNS 設定済み

### 1. サーバ初期セットアップ

```bash
# SSH
ssh ubuntu@<vps-ip>

# 基本更新
sudo apt-get update && sudo apt-get upgrade -y

# Docker インストール
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
# 一度ログアウトして再ログイン
```

### 2. リポジトリ clone とビルド

```bash
git clone https://github.com/furuikeharuki/short-video-media.git
cd short-video-media/apps/resolver

# .env 作成
cp .env.example .env
nano .env  # RESOLVER_API_KEY と DMM_AFFILIATE_ID を設定

# ビルド (5-10 分)
docker build -t shortvideo/resolver .
```

### 3. 起動

```bash
docker run -d \
  --name resolver \
  --restart unless-stopped \
  --env-file .env \
  -p 127.0.0.1:8080:8080 \
  shortvideo/resolver

# 確認
docker logs -f resolver
curl http://127.0.0.1:8080/health
```

### 4. リバプロ + HTTPS (Caddy)

```bash
sudo apt-get install -y caddy

sudo tee /etc/caddy/Caddyfile > /dev/null <<EOF
resolver.example.com {
    reverse_proxy 127.0.0.1:8080
}
EOF

sudo systemctl reload caddy
```

Caddy が Let's Encrypt で HTTPS 証明書を自動取得する。

### 5. ファイアウォール

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

### 6. apps/api 側の設定

Railway の環境変数に以下を追加:

```
RESOLVER_BASE_URL=https://resolver.example.com
RESOLVER_API_KEY=<同じキー>
RESOLVER_TIMEOUT_MS=15000
```

### 7. 更新手順

```bash
cd ~/short-video-media
git pull
cd apps/resolver
docker build -t shortvideo/resolver .
docker stop resolver && docker rm resolver
docker run -d --name resolver --restart unless-stopped --env-file .env -p 127.0.0.1:8080:8080 shortvideo/resolver
```

---

## 監視

最低限:
- Caddy の access log
- Railway 側 (`apps/api`) で resolver への 5xx 率を監視
- 月 1 回手動で `curl /health` を確認

将来 (任意):
- UptimeRobot / Healthchecks.io で `/health` を 5 分間隔監視
- Sentry を resolver にも入れる

---

## 既知の制約 / 注意点

- **単一インスタンス**: Stage A はサーバ 1 台運用。VPS 落ちると即停止 → apps/api 側はキャッシュ優先でフォールバックする設計 (要件定義 §7)。
- **Chromium 1 つ / プロセス 1 つ**: `--workers 1` 固定。複数ワーカーを使うと Browser が複数立ち上がってメモリが足りなくなる。
- **同時実行 2 まで**: それ以上は `asyncio.Semaphore` で待たされる。バースト時は `apps/api` 側で適切にタイムアウト・リトライすること。
- **ローカルテスト不能**: 日本以外の IP からは DMM CDN が 403/302 になるため、本番動作確認は VPS デプロイ後に行う。
- **シークレット管理**: `RESOLVER_API_KEY` は Railway と VPS で同じ値を共有する。漏れたら両方で更新する。
