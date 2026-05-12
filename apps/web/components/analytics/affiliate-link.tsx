"use client";

import { trackEvent } from "@/lib/analytics/analytics";

type AffiliateLinkProps = {
  href: string;
  slug: string;
  title: string;
};

export default function AffiliateLink({
  href,
  slug,
  title,
}: AffiliateLinkProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="affiliate-btn"
      onClick={() => {
        void trackEvent("affiliate_click", {
          slug,
          title,
          affiliate_url: href,
        });
      }}
    >
      購入ページで詳細を見る →
    </a>
  );
}
