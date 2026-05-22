"""DMM litevideo iframe から MP4 直リンク URL を抽出するコアロジック。

旧 ``apps/resolver/src/resolver.py`` を ``apps/api`` パッケージへ移した
もの。モジュール名が ``app.resolver.resolver`` だと冗長なので
``extractor`` にリネームしている。

ResolveError サブクラスで HTTP ステータスコードへのマッピングを表現する:
    - ResolveNotFound  → HTTP 404 (MP4 URL がページから見つからない)
    - ResolveTimeout   → HTTP 504 (Playwright のタイムアウト)
    - ResolveUpstream  → HTTP 502 (DMM 側のエラー / リダイレクト等)

注意:
    - DMM は海外 IP に対して `not-available-in-your-region` にリダイレクトする。
      日本 IP の環境 (Xserver VPS Tokyo 等) で実行すること。
    - 年齢確認 Cookie (`age_check_done=1`, `ckcy=2`) が必須。
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 例外クラス
# ---------------------------------------------------------------------------


class ResolveError(Exception):
    """resolver 共通の基底例外。"""


class ResolveNotFound(ResolveError):
    """iframe ページに <video> 要素もネットワーク上の .mp4 も見つからなかった。"""


class ResolveTimeout(ResolveError):
    """Playwright の navigation / wait_for_event がタイムアウトした。"""


class ResolveUpstream(ResolveError):
    """DMM 側のエラー (リダイレクト・地域制限・5xx 等)。"""


# ---------------------------------------------------------------------------
# 結果データクラス
# ---------------------------------------------------------------------------


@dataclass
class ResolveResult:
    content_id: str
    mp4_url: str


# ---------------------------------------------------------------------------
# 抽出ロジック
# ---------------------------------------------------------------------------


async def extract_mp4_url(
    browser: Any,
    content_id: str,
    affiliate_id: str,
    *,
    nav_timeout_ms: int = 15000,
    wait_video_timeout_ms: int = 8000,
) -> ResolveResult:
    """Playwright Browser を渡して 1 つの content_id について MP4 URL を抽出する。

    手順:
        1. litevideo iframe ページを開く
        2. ページ上の <video> 要素 (もしくは <source>) の src を待つ
        3. 取れなければネットワーク上の cc3001.dmm.co.jp/*.mp4 を捕捉

    Raises:
        ResolveTimeout: ページ遷移がタイムアウト
        ResolveUpstream: DMM 側のエラーや想定外の例外
        ResolveNotFound: MP4 URL が見つからない
    """
    iframe_url = (
        f"https://www.dmm.co.jp/litevideo/-/part/=/cid={content_id}/"
        f"size=720_480/affi_id={affiliate_id}/"
    )

    context = await browser.new_context(
        locale="ja-JP",
        extra_http_headers={"Accept-Language": "ja-JP,ja;q=0.9"},
    )
    # 年齢確認 Cookie (これがないと R18 ページがロードされない)
    await context.add_cookies(
        [
            {
                "name": "age_check_done",
                "value": "1",
                "domain": ".dmm.co.jp",
                "path": "/",
            },
            {
                "name": "ckcy",
                "value": "2",
                "domain": ".dmm.co.jp",
                "path": "/",
            },
        ]
    )

    page = await context.new_page()
    captured_mp4: list[str] = []

    def on_request(request: Any) -> None:
        url = request.url
        if "cc3001.dmm.co.jp" in url and url.endswith(".mp4"):
            captured_mp4.append(url)

    page.on("request", on_request)

    try:
        try:
            await page.goto(
                iframe_url, wait_until="domcontentloaded", timeout=nav_timeout_ms
            )
        except Exception as e:  # pylint: disable=broad-except
            msg = str(e).lower()
            if "timeout" in msg:
                raise ResolveTimeout(f"navigation timeout: {e}") from e
            raise ResolveUpstream(f"navigation failed: {e}") from e

        # 地域制限リダイレクトの検知 (DMM は海外 IP を not-available-in-your-region に飛ばす)
        current_url = page.url
        if "not-available-in-your-region" in current_url:
            raise ResolveUpstream(
                f"DMM region block detected (current_url={current_url}). "
                "Resolver must run from a Japan IP."
            )

        # <video> src を評価で取得
        try:
            src = await page.evaluate(
                """async () => {
                    for (let i = 0; i < 80; i++) {
                        const video = document.querySelector('video');
                        if (video) {
                            const directSrc = video.getAttribute('src') || video.currentSrc;
                            if (directSrc) return directSrc;
                            const source = video.querySelector('source');
                            if (source) {
                                const s = source.getAttribute('src') || source.src;
                                if (s) return s;
                            }
                        }
                        await new Promise(r => setTimeout(r, 100));
                    }
                    return null;
                }"""
            )
        except Exception as e:  # pylint: disable=broad-except
            logger.debug("page.evaluate failed for %s: %s", content_id, e)
            src = None

        # ネットワークキャプチャからフォールバック
        if not src and captured_mp4:
            src = captured_mp4[0]
            logger.debug("Captured mp4 from network for %s: %s", content_id, src)

        # 追加で network capture を少し待つ
        if not src:
            try:
                await page.wait_for_event(
                    "request",
                    predicate=lambda r: (
                        "cc3001.dmm.co.jp" in r.url and r.url.endswith(".mp4")
                    ),
                    timeout=wait_video_timeout_ms,
                )
            except Exception:  # pylint: disable=broad-except
                pass
            if captured_mp4:
                src = captured_mp4[0]

        if not src:
            raise ResolveNotFound(
                f"mp4 url not found for content_id={content_id}"
            )

        # 相対 URL の絶対化
        if src.startswith("//"):
            src = f"https:{src}"

        return ResolveResult(content_id=content_id, mp4_url=src)

    except ResolveError:
        raise
    except Exception as e:  # pylint: disable=broad-except
        # その他は upstream エラー扱い
        raise ResolveUpstream(f"unexpected error: {e}") from e
    finally:
        await context.close()
