"""extract_mp4_urls のデバッグ用スクリプト。

Railway 上で MP4 URL 抽出が失敗する原因を切り分けるため、以下を全部出力する:
  1. 実行ホストの外向き IP と地域 (Cloudflare cdn-cgi/trace)
  2. 対象 iframe ページの HTTP ステータスと最終 URL
  3. ページの HTML の一部 (地域ブロックメッセージが入っているか)
  4. ページ内の <video> 要素の有無と src 属性
  5. ネットワークで観測された .mp4 リクエスト一覧

使い方:
    python -m src.debug_extract --cid 1sun00052a
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys


async def check_ip() -> None:
    """このコンテナの外向き IP / 地域を確認する。"""
    try:
        import httpx
        async with httpx.AsyncClient(timeout=10.0) as client:
            # Cloudflare の trace は plain text で colo / loc などを返す
            resp = await client.get("https://1.1.1.1/cdn-cgi/trace")
            print("---- outbound IP / region (cloudflare cdn-cgi/trace) ----")
            print(resp.text)

            # ipinfo.io でも確認
            try:
                resp2 = await client.get("https://ipinfo.io/json")
                print("---- ipinfo.io ----")
                print(resp2.text)
            except Exception as e:  # pylint: disable=broad-except
                print(f"ipinfo.io fetch failed: {e}")
    except Exception as e:  # pylint: disable=broad-except
        print(f"IP check failed: {e}")


async def probe_iframe(content_id: str, affiliate_id: str) -> None:
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        print("Playwright not installed", file=sys.stderr)
        return

    iframe_url = (
        f"https://www.dmm.co.jp/litevideo/-/part/=/cid={content_id}/"
        f"size=720_480/affi_id={affiliate_id}/"
    )

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        try:
            ctx = await browser.new_context(
                locale="ja-JP",
                extra_http_headers={"Accept-Language": "ja-JP,ja;q=0.9"},
            )
            await ctx.add_cookies([
                {"name": "age_check_done", "value": "1", "domain": ".dmm.co.jp", "path": "/"},
                {"name": "ckcy", "value": "2", "domain": ".dmm.co.jp", "path": "/"},
            ])
            page = await ctx.new_page()

            mp4_requests: list[str] = []
            all_requests: list[str] = []

            def on_request(req):
                all_requests.append(req.url)
                if "cc3001.dmm.co.jp" in req.url and req.url.endswith(".mp4"):
                    mp4_requests.append(req.url)

            page.on("request", on_request)

            print(f"\n---- GET {iframe_url} ----")
            resp = await page.goto(iframe_url, wait_until="domcontentloaded", timeout=30000)
            print(f"HTTP status: {resp.status if resp else 'none'}")
            print(f"Final URL: {page.url}")
            print(f"Title: {await page.title()}")

            # 少し待ってネットワーク完了
            try:
                await page.wait_for_load_state("networkidle", timeout=10000)
            except Exception:  # pylint: disable=broad-except
                pass

            html = await page.content()
            print(f"\nHTML length: {len(html)}")

            # 地域ブロックの典型キーワードをチェック
            for kw in [
                "not available in your region",
                "お住まいの地域",
                "foreignError",
                "not-available-in-your-region",
            ]:
                if kw in html:
                    print(f"  ⚠️ HTML contains keyword: {kw!r}")

            # <video> 要素の有無
            video_info = await page.evaluate(
                """() => {
                    const v = document.querySelector('video');
                    if (!v) return {found: false};
                    return {
                        found: true,
                        src: v.getAttribute('src') || null,
                        currentSrc: v.currentSrc || null,
                        sourceCount: v.querySelectorAll('source').length,
                        sources: [...v.querySelectorAll('source')].map(s => s.getAttribute('src') || s.src),
                    };
                }"""
            )
            print(f"\n<video> info: {video_info}")

            print(f"\nObserved .mp4 requests ({len(mp4_requests)}):")
            for u in mp4_requests:
                print(f"  - {u}")

            print(f"\nTotal requests: {len(all_requests)} (showing first 30 unique hostnames)")
            seen_hosts = set()
            for u in all_requests:
                try:
                    host = u.split("/")[2]
                except Exception:  # pylint: disable=broad-except
                    host = u
                if host not in seen_hosts:
                    seen_hosts.add(host)
                    if len(seen_hosts) <= 30:
                        print(f"  - {host}")

            print("\n---- first 1500 chars of HTML ----")
            print(html[:1500])
            print("\n---- last 1500 chars of HTML ----")
            print(html[-1500:])
        finally:
            await browser.close()


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cid", default="1sun00052a")
    parser.add_argument("--affiliate-id", default=os.environ.get("DMM_AFFILIATE_ID", ""))
    args = parser.parse_args()

    if not args.affiliate_id:
        print("DMM_AFFILIATE_ID not set", file=sys.stderr)
        return 2

    await check_ip()
    await probe_iframe(args.cid, args.affiliate_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
