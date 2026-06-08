import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import {
  getHomeSectionSeed,
  type HomeSectionKey,
} from "@/lib/api/homeSection";
import ListClient from "./ListClient";
import GoodsListClient from "./GoodsListClient";
import ActressListClient from "./ActressListClient";
import { SITE_URL } from "@/lib/config/seo";

type Props = {
  params: Promise<{ key: string }>;
};

// ISR: force-dynamic を廃止し 300 秒キャッシュに変更。
// 初回生成後はキャッシュ済み HTML を返すことでクローラーへの応答を安定させる。
export const revalidate = 300;

/** key → 画面のタイトル。ジャンルは別ルート (/search?genre=...) を使うのでここでは扱わない。 */
const KEY_TITLES: Record<string, string> = {
  popular: "人気動画",
  popular_products: "人気商品",
  popular_actresses: "人気女優",
  new: "本日配信開始",
  recent: "新着",
  ranking_daily: "日間ランキング",
  ranking_weekly: "週間ランキング",
  ranking_monthly: "月間ランキング",
};

function isAllowedKey(key: string): key is Exclude<HomeSectionKey, "genre"> {
  return key in KEY_TITLES;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { key } = await params;
  const title = KEY_TITLES[key] ?? "一覧";
  const known = key in KEY_TITLES;
  return {
    title,
    description: `${title}のAVショート動画作品一覧。FANZAで配信中の人気・新着・ランキング作品をまとめてチェックできます。`,
    alternates: known ? { canonical: `/list/${key}` } : undefined,
    openGraph: {
      title,
      description: `${title}のAVショート動画作品一覧。`,
      url: known ? `/list/${key}` : undefined,
    },
    robots: known ? undefined : { index: false, follow: true },
  };
}

export default async function ListPage({ params }: Props) {
  const { key } = await params;
  if (!isAllowedKey(key)) {
    notFound();
  }

  const title = KEY_TITLES[key];

  if (key === "popular_products") {
    return <GoodsListClient title={title} />;
  }

  if (key === "popular_actresses") {
    return <ActressListClient title={title} />;
  }

  const ranked =
    key === "popular" ||
    key === "ranking_daily" ||
    key === "ranking_weekly" ||
    key === "ranking_monthly";

  // SSR で初期表示分のシードデータを取得し、可視コンテンツとして出力する。
  // クローラーには <h1> と <ol> の作品リンクが HTML に乗り、インデックス対象となる。
  // クライアント (ListClient) はマウント後に同じデータを取得してグリッド描画に切り替わる。
  const seed = await getHomeSectionSeed(key);

  return (
    <>
      {seed.length > 0 && (
        <SsrMovieGrid title={title} seed={seed} ranked={ranked} />
      )}
      <ListClient sectionKey={key} title={title} ranked={ranked} />
    </>
  );
}

/**
 * SSR で生成する可視コンテンツ。
 * Google を含むクローラーがリクエストした際に、<h1> と作品リンクのリストを
 * HTML に乗せてインデックス対象とする。
 * ListClient がハイドレーション後に独自のグリッドを描画するため、
 * このグリッドは position:absolute で ListClient の背後に隠れ視覚的に重ならない。
 * aria-hidden は付けず、スクリーンリーダーからも読めるようにする。
 */
function SsrMovieGrid({
  title,
  seed,
  ranked,
}: {
  title: string;
  seed: { slug: string; title: string }[];
  ranked: boolean;
}) {
  return (
    <div className="ssr-movie-grid">
      <h1 className="ssr-movie-grid__title">{title}</h1>
      <ol className="ssr-movie-grid__list">
        {seed.map((m, i) => (
          <li key={m.slug} value={ranked ? i + 1 : undefined}>
            <Link href={`/movies/${encodeURIComponent(m.slug)}`}>
              {ranked ? `${i + 1}. ` : ""}{m.title}
            </Link>
          </li>
        ))}
      </ol>
      <style>{ssrGridCSS}</style>
    </div>
  );
}

/**
 * SSR グリッドのスタイル。
 * ListClient が上に重なって表示されるため、このグリッドは
 * 視覚的に隠れる（position: absolute + z-index: -1）。
 * ただし clip や visibility: hidden / display: none は使わず、
 * Google が「隠しコンテンツ」と判断しないようにする。
 * テキストカラーも通常色を維持し、背景に溶け込むだけにとどめる。
 */
const ssrGridCSS = `
  .ssr-movie-grid {
    position: absolute;
    top: 52px;
    left: 0;
    right: 0;
    z-index: 0;
    padding: 12px 16px 16px;
    background: #0a0a0a;
    color: #fff;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  .ssr-movie-grid__title {
    font-size: 18px;
    font-weight: 700;
    line-height: 1.4;
    margin-bottom: 12px;
    color: #fff;
  }
  .ssr-movie-grid__list {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px 12px;
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .ssr-movie-grid__list li a {
    color: rgba(255,255,255,0.82);
    font-size: 12px;
    line-height: 1.45;
    text-decoration: none;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  @media (min-width: 640px) {
    .ssr-movie-grid__list { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  }
  @media (min-width: 1024px) {
    .ssr-movie-grid {
      max-width: 1200px;
      margin: 0 auto;
      left: 50%;
      transform: translateX(-50%);
    }
    .ssr-movie-grid__list { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  }
`;
