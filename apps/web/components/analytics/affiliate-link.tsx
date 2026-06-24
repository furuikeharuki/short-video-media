"use client";

import { trackEvent } from "@/lib/analytics/analytics";
import { normalizeSafeExternalHref } from "@/lib/safe-url";

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
  // 空文字 / 不正値の affiliate_url が来たときに <a href=""> で同じページに
  // 戻ってしまうのを防ぐ。データ欠落時はクリック不能ボタン (disabled) を出す。
  const safeHref = normalizeSafeExternalHref(href);
  if (!safeHref) {
    return (
      <button
        type="button"
        disabled
        className="affiliate-btn"
        aria-disabled="true"
      >
        購入ページは現在ご利用いただけません
      </button>
    );
  }
  return (
    <a
      href={safeHref}
      target="_blank"
      // FANZA / DMM アフィリエイト遷移なので sponsored を付ける (Google ガイドライン)。
      // noopener noreferrer は target=_blank のセキュリティ対策で必須。
      rel="noopener noreferrer sponsored"
      className="affiliate-btn"
      onClick={() => {
        void trackEvent("affiliate_click", {
          slug,
          title,
          affiliate_url: safeHref,
        });
      }}
    >
      購入ページで詳細を見る →
    </a>
  );
}
