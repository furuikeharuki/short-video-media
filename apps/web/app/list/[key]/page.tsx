import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { type HomeSectionKey } from "@/lib/api/homeSection";
import ListClient from "./ListClient";

type Props = {
  params: Promise<{ key: string }>;
};

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** key → 画面のタイトル。ジャンルは別ルート (/search?genre=...) を使うのでここでは扱わない。 */
const KEY_TITLES: Record<string, string> = {
  popular: "人気動画",
  popular_products: "人気商品",
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
  // ランキング系は順位を出したい
  const ranked =
    key === "popular" ||
    key === "ranking_daily" ||
    key === "ranking_weekly" ||
    key === "ranking_monthly";

  // 初期表示分の取得はクライアントに任せる (画面幅から列数を確定したうえで
  // 列の倍数で取りにいくため)。
  return <ListClient sectionKey={key} title={title} ranked={ranked} />;
}
