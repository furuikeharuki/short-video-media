import type { Metadata } from "next";
import FeedClient from "@/app/FeedClient";

// /feed の HTML shell は client 専用ページだが、Next の prerender 対象になると
// Vercel/ブラウザ側に古い HTML が残り、再デプロイ後も古い `_next/static/chunks/*.js`
// を参照したままになる (チャンクは content-hash で immutable だが、それを参照する
// HTML が古いと意味がない)。`?vt=1` などクエリ付きで踏むとキャッシュバイパスされて
// 最新が降ってくるため「vt 付きだと速い/高画質」という症状になっていた。
// 常に最新の HTML を返すよう dynamic に固定する。
export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "ショートフィード",
  description:
    "縦スクロールで次々と試し見できるAVショート動画フィード。気に入った作品はFANZAでそのまま購入できます。",
  alternates: { canonical: "/feed" },
  openGraph: {
    title: "ショートフィード",
    description:
      "縦スクロールで次々と試し見できるAVショート動画フィード。",
    url: "/feed",
  },
};

export default function FeedPage() {
  return (
    <>
      <FeedClient />
      <style>{feedStyle}</style>
    </>
  );
}

const feedStyle = `
  html { background: #000; }
  body { background: #000; overflow: hidden; height: 100dvh; }

  .feed-container {
    position: fixed;
    top: var(--header-h, 52px);
    left: 0; right: 0;
    bottom: var(--bottom-nav-h, 56px);
    overflow: hidden;
  }

  .feed-slide {
    position: absolute;
    inset: 0;
    will-change: transform;
  }

  .feed-item {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: #000;
  }

  .video-bg { position: absolute; inset: 0; }
  /* .thumbnail-bg / .thumbnail-img のスタイルは feedItemStyle.ts で一元管理 */
`;
