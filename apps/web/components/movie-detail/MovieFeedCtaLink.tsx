"use client";

import { trackEvent } from "@/lib/analytics/analytics";

type MovieFeedCtaLinkProps = {
  slug: string;
  title: string;
  /** どの面から押されたか (full page / modal) を GA4 に残す。 */
  context: "detail_page" | "detail_modal";
};

/**
 * 作品詳細 → ショート動画フィード (/feed?v=<slug>) への送客 CTA。
 *
 * - 通常の <a href> なので JS 無効でも遷移でき、SEO/クロールにも優しい。
 * - 動画アセットは一切ロードしない (href の遷移のみ)。詳細ページの表示パフォーマンスに影響なし。
 * - 未認証ユーザは middleware が /feed?v=<slug> を age-gate へ 307 し、通過後に
 *   next=/feed?v=<slug> へ戻すため slug は保持される (middleware.ts 参照)。
 * - クリック計測は client gtag 経由 (trackEvent → ga4-client)。失敗しても遷移は妨げない。
 */
export default function MovieFeedCtaLink({
  slug,
  title,
  context,
}: MovieFeedCtaLinkProps) {
  const href = `/feed?v=${encodeURIComponent(slug)}`;
  return (
    <a
      href={href}
      className="movie-feed-cta"
      aria-label={`${title}をショート動画で見る`}
      onClick={() => {
        void trackEvent("movie_feed_cta_click", { slug, title, context });
      }}
    >
      <span className="movie-feed-cta__icon" aria-hidden="true">▶</span>
      <span className="movie-feed-cta__label">この作品をショート動画で見る</span>
    </a>
  );
}
