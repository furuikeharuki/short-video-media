# apps/resolver (廃止予定 / Deprecated)

> **このアプリは `apps/api` パッケージへ統合済みです。** 新規開発は
> `apps/api/app/resolver/` で行ってください。本ディレクトリは互換のため
> README のみを残しています。次回のクリーンアップ PR で完全削除予定。

---

## 経緯

`apps/resolver` はもともと、DMM litevideo iframe から MP4 直リンクを
Playwright で抽出する独立した FastAPI サービスでした。Railway に日本
リージョンが無く、resolver だけは日本 IP (Xserver VPS Tokyo) で動かす
必要があったため、`apps/api` とは別アプリ・別 Docker イメージとして
運用していました。

2026 年 5 月の Xserver VPS 移行で `apps/api` 自身も Xserver (Tokyo) で
動くようになったため、resolver を独立サービスとして維持する必然性は
無くなりました。コード重複と運用負荷を減らすため、resolver のロジックは
`apps/api/app/resolver/` に移植しています。

## 統合後の構成

| 旧 | 新 |
|---|---|
| `apps/resolver/src/main.py` | `apps/api/app/resolver/main.py` |
| `apps/resolver/src/resolver.py` | `apps/api/app/resolver/extractor.py` |
| `apps/resolver/src/browser_pool.py` | `apps/api/app/resolver/browser_pool.py` |
| `apps/resolver/src/config.py` | `apps/api/app/resolver/config.py` |
| `apps/resolver/Dockerfile` | `apps/api/Dockerfile.resolver` |
| `apps/resolver/tests/` | `apps/api/tests/test_resolver_service*.py` |

- 通常 API コンテナ (`apps/api/Dockerfile`, slim Python image) は Playwright を
  含みません。Browser を起動しないため起動時間も従来通り。
- resolver サービス (`apps/api/Dockerfile.resolver`,
  `mcr.microsoft.com/playwright/python` ベース) のみ Playwright + Chromium を
  含みます。`apps/api` パッケージを共有しているため、コード重複なし。
- API 互換性: HTTP エンドポイント (`POST /resolve`, `GET /health`) と
  Bearer 認証 / エラーマッピングは旧 resolver と完全に同じです。
- compose 経由でデプロイする場合、`infra/xserver/docker-compose.yml` の
  `resolver` サービスが自動で起動します。`RESOLVER_BASE_URL` は
  `http://resolver:8080` (docker network 内名前解決)。

## 既存 (旧) resolver の停止手順 (VPS 上)

Xserver VPS で旧 `apps/resolver` を別 compose / 単体コンテナで動かしている
場合、新 compose を起動する前に止めてください。ポート競合は基本的に
ありませんが (新 resolver は expose のみで host port を開けない)、
リソース重複を避けるためです。

```bash
# 旧 resolver を docker run で立てていた場合
docker stop resolver && docker rm resolver

# 旧 compose で立てていた場合 (compose ファイルパスは環境による)
cd ~/old-resolver
docker compose down

# (任意) 不要になったイメージを掃除
docker image prune -f
```

詳細は `docs/migration/xserver-vps.md` の「Resolver の統合 / 切替手順」
セクションを参照してください。
