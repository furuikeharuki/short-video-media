"""Playwright Chromium ブラウザを 1 度だけ起動して使い回すためのプール。

旧 ``apps/resolver/src/browser_pool.py`` を ``apps/api`` パッケージへ
移動したもの。Playwright は遅延 import しているため、本モジュール自体は
Playwright 未インストールの環境 (通常の apps/api コンテナ) でも import
可能。``start()`` を呼んだ瞬間に初めて Playwright を読み込む。

FastAPI の lifespan で ``start()`` / ``stop()`` を呼び、リクエストごとに
``get_browser()`` で同じインスタンスを返す。Browser の new_context() /
new_page() は軽量なので、リクエストごとに作って閉じる前提で OK
(Browser 自体の起動は重い)。

同時実行は asyncio.Semaphore で制御する (CPU/メモリリソースの保護)。
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

logger = logging.getLogger(__name__)


class BrowserPool:
    """Playwright Chromium を 1 つだけ起動して使い回す軽量プール。"""

    def __init__(self, *, concurrency: int = 2) -> None:
        self._playwright: Any | None = None
        self._browser: Any | None = None
        self._semaphore = asyncio.Semaphore(concurrency)
        self._lock = asyncio.Lock()

    async def start(self) -> None:
        """Playwright と Chromium を起動する。"""
        # 遅延 import: 通常 API コンテナでは Playwright を入れていないため、
        # モジュールロード時点で import するとそちらが落ちる。
        from playwright.async_api import async_playwright

        async with self._lock:
            if self._browser is not None:
                return
            logger.info("Starting Playwright Chromium...")
            self._playwright = await async_playwright().start()
            self._browser = await self._playwright.chromium.launch(
                headless=True,
                args=["--no-sandbox", "--disable-dev-shm-usage"],
            )
            logger.info("Playwright Chromium started.")

    async def stop(self) -> None:
        """Chromium と Playwright を停止する。"""
        async with self._lock:
            if self._browser is not None:
                try:
                    await self._browser.close()
                except Exception as e:  # pylint: disable=broad-except
                    logger.warning("Error closing browser: %s", e)
                self._browser = None
            if self._playwright is not None:
                try:
                    await self._playwright.stop()
                except Exception as e:  # pylint: disable=broad-except
                    logger.warning("Error stopping playwright: %s", e)
                self._playwright = None
            logger.info("Playwright Chromium stopped.")

    def get_browser(self) -> Any:
        """起動済みの Browser インスタンスを返す。未起動なら RuntimeError。"""
        if self._browser is None:
            raise RuntimeError("BrowserPool not started. Call start() first.")
        return self._browser

    @property
    def is_running(self) -> bool:
        return self._browser is not None

    def slot(self) -> asyncio.Semaphore:
        """同時実行制御用 Semaphore を返す (`async with pool.slot():` で使う)。"""
        return self._semaphore
