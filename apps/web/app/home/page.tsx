import type { Metadata } from "next";
import { getHome } from "@/lib/api/home";
import HorizontalCardRow from "@/components/home/HorizontalCardRow";
import MovieCardThumb from "@/components/home/MovieCardThumb";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "ホーム",
  description: "本日配信開始の新作、月間/週間/デイリーランキング、人気ジャンル別のショート動画を一覧でチェック。",
};

const RANKING_KEYS = new Set([
  "ranking_daily",
  "ranking_weekly",
  "ranking_monthly",
]);

export default async function HomePage() {
  let data: Awaited<ReturnType<typeof getHome>>;
  try {
    data = await getHome(12);
  } catch {
    return (
      <main className="home-main">
        <div className="home-error">読み込みに失敗しました</div>
        <style>{pageStyles}</style>
      </main>
    );
  }

  const sections = data.sections.filter((s) => s.items.length > 0);

  if (sections.length === 0) {
    return (
      <main className="home-main">
        <div className="home-empty">表示できる作品がありません</div>
        <style>{pageStyles}</style>
      </main>
    );
  }

  return (
    <main className="home-main">
      {sections.map((section) => {
        const isRanking = RANKING_KEYS.has(section.key);
        const action = section.genre
          ? {
              label: "もっと見る",
              href: `/search?q=${encodeURIComponent(section.genre)}`,
            }
          : undefined;
        const playlistKey = `home_${section.key}`;

        return (
          <HorizontalCardRow
            key={section.key}
            title={section.title}
            subtitle={section.subtitle}
            action={action}
          >
            {section.items.map((m, i) => (
              <MovieCardThumb
                key={m.id}
                movie={m}
                aspect="portrait"
                rank={isRanking ? i + 1 : undefined}
                playlist={{
                  key: playlistKey,
                  title: section.title,
                  startIndex: i,
                  items: section.items,
                }}
              />
            ))}
          </HorizontalCardRow>
        );
      })}

      <div className="home-footer-spacer" />

      <style>{pageStyles}</style>
    </main>
  );
}

const pageStyles = `
  html { background: #000; }
  body { background: #000; }

  .home-main {
    position: fixed;
    top: var(--header-h, 52px);
    left: 0; right: 0;
    bottom: var(--bottom-nav-h, 56px);
    overflow-y: auto;
    overflow-x: hidden;
    -webkit-overflow-scrolling: touch;
    background: #000;
    color: #fff;
  }
  .home-footer-spacer { height: 24px; }
  .home-empty, .home-error {
    padding: 80px 20px;
    text-align: center;
    color: rgba(255,255,255,0.5);
    font-size: 14px;
  }
`;
