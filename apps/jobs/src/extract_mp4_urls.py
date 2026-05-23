"""DMM litevideo iframe から MP4 直リンク URL をヘッドレスブラウザで抽出するジョブ。

背景:
    DMM Affiliate API の `sampleMovieURL` は litevideo iframe ページ (HTML プレイヤー)
    の URL しか返さない。実際の MP4 ファイル URL は、そのページの JavaScript が
    動的に署名付き URL (`https://cc3001.dmm.co.jp/pv/<token>/<cid>mhb.mp4`) を生成して
    `<video src>` に埋め込んでいる。

    一般 CDN パス `https://cc3001.dmm.co.jp/litevideo/freepv/...` は古い作品にしか
    使われておらず、新しい作品 / 未発売作品はこちらのパスではアクセスできない。

    そのためヘッドレスブラウザで iframe ページを開き、生成された `<video src>` の
    値を取り出してDBに保存する必要がある。

実行要件:
    - Playwright (Chromium) がインストール済みであること
    - 実行環境が 日本 IP からアクセスできること
      (DMM は海外 IP に対して `not-available-in-your-region` にリダイレクトする)
    - DB に接続できること (DATABASE_URL 環境変数)

使い方:
    # 単体テスト: 特定の content_id 1 件だけ抽出して表示 (DB に書かない)
    python -m src.extract_mp4_urls --cid 1sun00052a --dry-run

    # バッチ実行: DB の全作品で sample_movie_url が 4xx になっているものだけ更新
    python -m src.extract_mp4_urls --only-broken

    # バッチ実行: DB の全作品で sample_movie_url を最新に更新
    python -m src.extract_mp4_urls --all

    # 同時並列数を指定 (デフォルト 4)
    python -m src.extract_mp4_urls --all --concurrency 4
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from dataclasses import dataclass
from typing import Any

# Playwright は遅延 import して、引数解析が失敗するときに不要な import エラーを避ける
PLAYWRIGHT_REQUIRED_HINT = (
    "Playwright がインストールされていません。`pip install playwright` と "
    "`python -m playwright install chromium` を実行してください。"
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 1 つの content_id について MP4 URL を抽出する
# ---------------------------------------------------------------------------

@dataclass
class ExtractResult:
    content_id: str
    mp4_url: str | None
    error: str | None = None


async def extract_mp4_url(
    browser: Any,
    content_id: str,
    affiliate_id: str,
    *,
    nav_timeout_ms: int = 15000,
    wait_video_timeout_ms: int = 8000,
) -> ExtractResult:
    """Playwright Browser を渡して 1 つの content_id について MP4 URL を抽出する。

    手順:
        1. litevideo iframe ページを開く
        2. ページ上の `<video>` 要素を待つ
        3. `<video>` の `src` 属性 (もしくは内側の `<source>`) を取り出す

    戻り値: ExtractResult。失敗時は mp4_url=None, error にエラー内容を入れる。
    """
    # 720x480 サイズの iframe を開く (一般的なプレイヤーサイズ)
    iframe_url = (
        f"https://www.dmm.co.jp/litevideo/-/part/=/cid={content_id}/"
        f"size=720_480/affi_id={affiliate_id}/"
    )

    context = await browser.new_context(
        # 日本ロケールを明示
        locale="ja-JP",
        # 年齢確認 Cookie を事前にセット (ckcy=2 で確認済み扱い)
        # ※ DMM 側の挙動が変わったときはここを更新する
        extra_http_headers={"Accept-Language": "ja-JP,ja;q=0.9"},
    )
    # 年齢確認 Cookie をセット (これがないと R18 ページがロードされない)
    await context.add_cookies([{
        "name": "age_check_done",
        "value": "1",
        "domain": ".dmm.co.jp",
        "path": "/",
    }, {
        "name": "ckcy",
        "value": "2",
        "domain": ".dmm.co.jp",
        "path": "/",
    }])

    page = await context.new_page()
    captured_mp4: list[str] = []

    # ネットワーク監視: cc3001.dmm.co.jp 配下の .mp4 リクエストを全部キャプチャ
    # クエリ・フラグメント付き URL (例: `...mp4?token=...`) も取りこぼさないように、
    # `.mp4` をパス部分で検査する。
    def _is_mp4_url(url: str) -> bool:
        if "cc3001.dmm.co.jp" not in url:
            return False
        path = url.split("?", 1)[0].split("#", 1)[0]
        return ".mp4" in path

    def on_request(request: Any) -> None:
        if _is_mp4_url(request.url):
            captured_mp4.append(request.url)

    page.on("request", on_request)

    try:
        await page.goto(iframe_url, wait_until="domcontentloaded", timeout=nav_timeout_ms)

        # <video> 要素の src を待つ。JS で動的にセットされるので waitFor が必要
        try:
            src = await page.evaluate(
                """async () => {
                    // 最大 8 秒間ポーリングして <video>.src または <source>.src を取得
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

        # ページ評価で取れなかった場合は network capture からフォールバック
        if not src and captured_mp4:
            src = captured_mp4[0]
            logger.debug("Captured mp4 from network for %s: %s", content_id, src)

        # 追加で network capture を少し待つ (動的読み込み対策)
        if not src:
            try:
                await page.wait_for_event(
                    "request",
                    predicate=lambda r: _is_mp4_url(r.url),
                    timeout=wait_video_timeout_ms,
                )
            except Exception:  # pylint: disable=broad-except
                pass
            if captured_mp4:
                src = captured_mp4[0]

        if not src:
            return ExtractResult(content_id=content_id, mp4_url=None, error="mp4 url not found")

        # 相対 URL の場合は絶対化
        if src.startswith("//"):
            src = f"https:{src}"

        return ExtractResult(content_id=content_id, mp4_url=src)

    except Exception as e:  # pylint: disable=broad-except
        return ExtractResult(content_id=content_id, mp4_url=None, error=str(e))
    finally:
        await context.close()


# ---------------------------------------------------------------------------
# バッチ処理: DB から対象を取得して並列実行
# ---------------------------------------------------------------------------

async def fetch_targets_from_db(
    *,
    only_broken: bool,
    limit: int | None,
) -> list[tuple[str, str]]:
    """DB から (slug, content_id) のリストを取得する。

    - only_broken=True: 過去に学習キャッシュが失敗している、もしくは sample_movie_url が
      標準 /litevideo/freepv/ パスのままになっている作品を対象にする。
      ※ 現状は「学習キャッシュ済みかどうか」をマーカーするカラムが無いので、
        簡易判定として `_mhb_w.mp4` で終わるもの (= sync_catalog 初期値のまま) を対象にする。
    - only_broken=False: sample_movie_url がセットされている全作品。
    """
    import asyncpg

    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        raise RuntimeError("DATABASE_URL is not set")

    # asyncpg は postgresql:// or postgres:// を受け付ける
    if db_url.startswith("postgres+asyncpg://"):
        db_url = db_url.replace("postgres+asyncpg://", "postgresql://", 1)
    if db_url.startswith("postgresql+asyncpg://"):
        db_url = db_url.replace("postgresql+asyncpg://", "postgresql://", 1)

    conn = await asyncpg.connect(db_url)
    try:
        if only_broken:
            # 末尾が _mhb_w.mp4 (sync_catalog のデフォルト) で固定されているもの
            # = まだクライアント学習キャッシュで上書きされていないもの
            sql = """
                SELECT slug, content_id
                FROM movies
                WHERE is_visible = true
                  AND content_id IS NOT NULL
                  AND sample_movie_url LIKE '%_mhb_w.mp4'
                ORDER BY release_date DESC NULLS LAST
            """
        else:
            sql = """
                SELECT slug, content_id
                FROM movies
                WHERE is_visible = true
                  AND content_id IS NOT NULL
                ORDER BY release_date DESC NULLS LAST
            """
        if limit is not None:
            sql += f" LIMIT {int(limit)}"
        rows = await conn.fetch(sql)
        return [(r["slug"], r["content_id"]) for r in rows]
    finally:
        await conn.close()


async def update_sample_movie_url(slug: str, mp4_url: str) -> None:
    """対象の movie の sample_movie_url を更新する。"""
    import asyncpg

    db_url = os.environ.get("DATABASE_URL", "")
    if db_url.startswith("postgres+asyncpg://"):
        db_url = db_url.replace("postgres+asyncpg://", "postgresql://", 1)
    if db_url.startswith("postgresql+asyncpg://"):
        db_url = db_url.replace("postgresql+asyncpg://", "postgresql://", 1)

    conn = await asyncpg.connect(db_url)
    try:
        await conn.execute(
            "UPDATE movies SET sample_movie_url = $1 WHERE slug = $2",
            mp4_url, slug,
        )
    finally:
        await conn.close()


async def run_batch(
    *,
    targets: list[tuple[str, str]],
    affiliate_id: str,
    concurrency: int,
    dry_run: bool,
) -> tuple[int, int, int]:
    """対象作品を並列で抽出し、DB を更新する。

    Returns: (success, failed, total)
    """
    try:
        from playwright.async_api import async_playwright
    except ImportError as e:
        raise RuntimeError(PLAYWRIGHT_REQUIRED_HINT) from e

    sem = asyncio.Semaphore(concurrency)
    success = 0
    failed = 0
    total = len(targets)

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        try:
            async def worker(slug: str, content_id: str) -> None:
                nonlocal success, failed
                async with sem:
                    result = await extract_mp4_url(browser, content_id, affiliate_id)
                    if result.mp4_url:
                        if dry_run:
                            logger.info("[DRY] %s (%s) -> %s", slug, content_id, result.mp4_url)
                        else:
                            try:
                                await update_sample_movie_url(slug, result.mp4_url)
                                logger.info("OK   %s (%s) -> %s", slug, content_id, result.mp4_url)
                            except Exception as e:  # pylint: disable=broad-except
                                logger.error("DB update failed for %s: %s", slug, e)
                                failed += 1
                                return
                        success += 1
                    else:
                        logger.warning("MISS %s (%s): %s", slug, content_id, result.error)
                        failed += 1

            await asyncio.gather(*[worker(s, c) for s, c in targets])
        finally:
            await browser.close()

    return success, failed, total


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cid", help="単一の content_id だけ抽出 (DB 更新しない)")
    parser.add_argument("--all", action="store_true", help="DB 全作品を対象に抽出")
    parser.add_argument("--only-broken", action="store_true",
                        help="sample_movie_url が初期値 (_mhb_w.mp4) のままの作品だけ対象")
    parser.add_argument("--limit", type=int, default=None, help="対象件数の上限")
    parser.add_argument("--concurrency", type=int, default=4,
                        help="同時並列数 (デフォルト 4)")
    parser.add_argument("--dry-run", action="store_true", help="DB に書き込まない")
    parser.add_argument(
        "--affiliate-id",
        default=os.environ.get("DMM_AFFILIATE_ID", ""),
        help="DMM Affiliate ID (環境変数 DMM_AFFILIATE_ID でも指定可)",
    )
    parser.add_argument("--verbose", action="store_true", help="DEBUG ログを出力")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    if not args.affiliate_id:
        logger.error("DMM_AFFILIATE_ID 環境変数が未設定です (または --affiliate-id を指定)")
        return 2

    # モード分岐
    if args.cid:
        # 単一作品テストモード
        async def _run_single() -> int:
            try:
                from playwright.async_api import async_playwright
            except ImportError as e:
                logger.error("%s", PLAYWRIGHT_REQUIRED_HINT)
                logger.error("%s", e)
                return 2
            async with async_playwright() as pw:
                browser = await pw.chromium.launch(
                    headless=True,
                    args=["--no-sandbox", "--disable-dev-shm-usage"],
                )
                try:
                    result = await extract_mp4_url(browser, args.cid, args.affiliate_id)
                finally:
                    await browser.close()
            if result.mp4_url:
                print(f"OK: {args.cid} -> {result.mp4_url}")
                return 0
            print(f"MISS: {args.cid}: {result.error}", file=sys.stderr)
            return 1

        return asyncio.run(_run_single())

    if not (args.all or args.only_broken):
        parser.error("--cid / --all / --only-broken のいずれかを指定してください")
        return 2

    # バッチモード
    async def _run_batch() -> int:
        targets = await fetch_targets_from_db(
            only_broken=args.only_broken and not args.all,
            limit=args.limit,
        )
        logger.info("対象作品: %d 件 (concurrency=%d, dry_run=%s)",
                    len(targets), args.concurrency, args.dry_run)
        if not targets:
            logger.info("対象なし。終了。")
            return 0
        success, failed, total = await run_batch(
            targets=targets,
            affiliate_id=args.affiliate_id,
            concurrency=args.concurrency,
            dry_run=args.dry_run,
        )
        logger.info("完了: success=%d failed=%d total=%d", success, failed, total)
        return 0 if failed == 0 else 1

    return asyncio.run(_run_batch())


if __name__ == "__main__":
    raise SystemExit(main())
