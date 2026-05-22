"""DMM litevideo iframe から MP4 直リンクを抽出する Playwright resolver。

以前は `apps/resolver` として独立した FastAPI サービスだったが、
Xserver VPS 移行に伴い `apps/api` パッケージへ統合した。

実行モード:
    1. ``apps.resolver.main:app``: Playwright Chromium を起動する FastAPI app
       (resolver 専用イメージ ``apps/api/Dockerfile.resolver`` でのみ使う)。
    2. ``apps.api.main:app`` (通常 API): ``app.resolver`` 配下のコードを import
       するが Playwright を起動しない。``app.resolver.client`` (旧
       ``app.services.resolver_client``) 経由で HTTP で resolver サービスを叩く。

Playwright 依存は遅延 import (``browser_pool.start`` 内) で隔離してあるため、
通常 API コンテナ (slim Python image) にこのパッケージを含めても起動には
影響しない。Playwright がインストールされていない環境では Browser を
起動しようとした時点で初めて ImportError になる。
"""
