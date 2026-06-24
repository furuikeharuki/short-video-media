import type { Metadata } from "next";
import FeedClient from "@/app/FeedClient";
import { getMovieBySlug } from "@/lib/api/movies";
import { SITE_NAME, SITE_URL, SITE_LOCALE } from "@/lib/config/seo";

// /feed の HTML shell は client 専用ページだが、Next の prerender 対象になると
// Vercel/ブラウザ側に古い HTML が残り、再デプロイ後も古い `_next/static/chunks/*.js`
// を参照したままになる (チャンクは content-hash で immutable だが、それを参照する
// HTML が古いと意味がない)。`?vt=1` などクエリ付きで踏むとキャッシュバイパスされて
// 最新が降ってくるため「vt 付きだと速い/高画質」という症状になっていた。
// 常に最新の HTML を返すよう dynamic に固定する。
export const dynamic = "force-dynamic";
export const revalidate = 0;

type FeedPageProps = {
  searchParams: Promise<{ v?: string | string[] }>;
};

// /feed は force-dynamic な client 専用ページで SSR HTML に作品リンク・本文が出ず、
// クローラからは実質「空の薄いページ」に見える。個別作品は /movies/[slug]、
// 一覧導線は / や /list/* が index 対象なので、/feed 自体は noindex にして
// 薄いページ評価を避ける (follow は維持してリンクは辿らせる)。UI/挙動は不変。
// index 可否と OGP プレビュー画像は別物: noindex のままでも共有先 (X/LINE/Slack 等)
// のクローラは OGP を取得するので、共有プレビューには作品サムネを出す。
const noindexRobots = { index: false, follow: true } as const;

const defaultMetadata: Metadata = {
  title: "ショートフィード",
  description:
    "縦スクロールで次々と試し見できるAVショート動画フィード。気に入った作品はFANZAでそのまま購入できます。",
  alternates: { canonical: `${SITE_URL}/feed` },
  robots: noindexRobots,
  openGraph: {
    title: "ショートフィード",
    description: "縦スクロールで次々と試し見できるAVショート動画フィード。",
    url: "/feed",
  },
};

// 共有された /feed?v=<slug> は該当作品のサムネ・タイトルでプレビューさせる。
// ?v が無い / 取得失敗時は従来どおりの汎用フィードメタにフォールバックする。
export async function generateMetadata({
  searchParams,
}: FeedPageProps): Promise<Metadata> {
  const sp = await searchParams;
  const rawV = Array.isArray(sp.v) ? sp.v[0] : sp.v;
  const slug = rawV?.trim();
  if (!slug) return defaultMetadata;

  try {
    const movie = await getMovieBySlug(slug);
    const title = `${movie.title} | ${SITE_NAME}`;
    const description = movie.description
      ? movie.description.length > 120
        ? `${movie.description.slice(0, 119)}…`
        : movie.description
      : `${movie.actresses.join("・")}出演。${SITE_NAME}で試し見できるショート動画。`;
    const imageUrl = movie.image_url_large ?? movie.image_url_list ?? "";
    // 共有URLとしての ?v= は維持しつつ、SEO評価は動画をサーバー描画する作品詳細へ集約する。
    const shareUrl = `${SITE_URL}/feed?v=${encodeURIComponent(slug)}`;
    const canonical = `${SITE_URL}/movies/${encodeURIComponent(slug)}`;

    return {
      title,
      description,
      alternates: { canonical },
      robots: noindexRobots,
      openGraph: {
        type: "video.other",
        url: shareUrl,
        title,
        description,
        images: imageUrl
          ? [{ url: imageUrl, width: 720, height: 1280, alt: movie.title }]
          : [],
        siteName: SITE_NAME,
        locale: SITE_LOCALE,
      },
      twitter: {
        card: "summary_large_image",
        title,
        description,
        images: imageUrl ? [imageUrl] : [],
      },
    };
  } catch {
    return defaultMetadata;
  }
}

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
