import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  getHomeSectionSeed,
  type HomeSectionKey,
} from "@/lib/api/homeSection";
import ListClient from "./ListClient";
import GoodsListClient from "./GoodsListClient";
import ActressListClient from "./ActressListClient";

type Props = {
  params: Promise<{ key: string }>;
};

export const dynamic = "force-dynamic";
export const revalidate = 0;

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

  // 人気商品 (Goods) は商品テーブル由来で MovieCard と型が違うため専用クライアントを使う。
  if (key === "popular_products") {
    return <GoodsListClient title={title} />;
  }

  // 人気女優 (Actress) は ActressCard を返す専用クライアントを使う。
  if (key === "popular_actresses") {
    return <ActressListClient title={title} />;
  }

  // ランキング系は順位を出したい
  const ranked =
    key === "popular" ||
    key === "ranking_daily" ||
    key === "ranking_weekly" ||
    key === "ranking_monthly";

  // SSR でクロール用の内部リンク種を取得する。見た目には使わず、視覚的に隠した
  // <a href="/movies/[slug]"> として出力するだけ。これで force-dynamic + client
  // 取得主体のままでも作品詳細ページへの内部リンクが SSR HTML に乗る。
  // Next のデータキャッシュ (revalidate=300) に載るため毎リクエストの API
  // ラウンドトリップにはならず、失敗時は空配列で描画を妨げない。
  const seed = await getHomeSectionSeed(key);

  // 初期表示分の取得はクライアントに任せる (画面幅から列数を確定したうえで
  // 列の倍数で取りにいくため)。
  return (
    <>
      <CrawlLinks title={title} seed={seed} />
      <ListClient sectionKey={key} title={title} ranked={ranked} />
    </>
  );
}

/**
 * クローラ向けの内部リンクのみを持つ非表示ナビ。
 * 視覚的に隠す (display:none ではなく clip して a11y ツリーには残す) ことで
 * 既存 UI を一切変えずに、SSR HTML に作品詳細への内部リンクを供給する。
 */
function CrawlLinks({
  title,
  seed,
}: {
  title: string;
  seed: { slug: string; title: string }[];
}) {
  if (seed.length === 0) return null;
  return (
    <nav
      aria-label={`${title}の作品リンク`}
      style={{
        position: "absolute",
        width: 1,
        height: 1,
        padding: 0,
        margin: -1,
        overflow: "hidden",
        clip: "rect(0 0 0 0)",
        whiteSpace: "nowrap",
        border: 0,
      }}
    >
      <ul>
        {seed.map((m) => (
          <li key={m.slug}>
            <a href={`/movies/${encodeURIComponent(m.slug)}`}>{m.title}</a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
