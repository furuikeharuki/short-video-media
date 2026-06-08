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

  // SSR で初期表示分のシードデータを取得し、
  // 作品カードを視覚的に表示する SSR グリッドとして出力する。
  // クライアント (ListClient) はその後の追加読み込みのみ担当する。
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
 * SSR で生成する作品グリッド。
 * Google を含むクローラーが山比でリクエストした際に HTML にコンテンツとして
 * 沿える。JS 期待なしでインデックス対象となる作品名・ canonical URL が提供される。
 * ListClient のハイドレーション時に一時的に重複するが、ListClient が
 * 初回データを取得した時点で自身のグリッドを描画するため、视覚的には即座に入れ替わる。
 * aria-hidden を付けることでスクリーンリーダー・ a11y ツリーからは除外する。
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
    <div
      aria-hidden="true"
      style={{
        position: "absolute",
        width: 1,
        height: 1,
        overflow: "hidden",
        clip: "rect(0 0 0 0)",
        whiteSpace: "nowrap",
      }}
    >
      <h1>{title}</h1>
      <ol>
        {seed.map((m, i) => (
          <li key={m.slug} value={ranked ? i + 1 : undefined}>
            <Link href={`/movies/${encodeURIComponent(m.slug)}`}>{m.title}</Link>
          </li>
        ))}
      </ol>
    </div>
  );
}
