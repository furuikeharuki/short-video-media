import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getHomeSection, type HomeSectionKey } from "@/lib/api/homeSection";
import ListClient from "./ListClient";

type Props = {
  params: Promise<{ key: string }>;
};

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** key → 画面のタイトル & key='genre' 以外で使える "もっと見る" 先 */
const KEY_TITLES: Record<string, string> = {
  popular: "人気",
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
  return {
    title,
    description: `${title}の作品一覧。`,
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

  // SSR で 1 ページ目だけ取ってくる。続きはクライアントが /api/v1/home/section を直接叩く。
  let initialItems: Awaited<ReturnType<typeof getHomeSection>>["items"] = [];
  let initialNextCursor: string | null = null;
  try {
    const res = await getHomeSection(key, 0, 20);
    initialItems = res.items;
    initialNextCursor = res.next_cursor;
  } catch {
    // エラー時は空で続行
  }

  return (
    <ListClient
      sectionKey={key}
      title={title}
      ranked={ranked}
      initialItems={initialItems}
      initialNextCursor={initialNextCursor}
    />
  );
}
