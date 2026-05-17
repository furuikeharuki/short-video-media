import type { Metadata } from "next";
import { getHome } from "@/lib/api/home";
import HorizontalCardRow from "@/components/home/HorizontalCardRow";
import MovieCardThumb from "@/components/home/MovieCardThumb";
import PullToRefresh from "@/components/home/PullToRefresh";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "ホーム",
  description: "本日配信開始の新作、日間/週間/月間ランキング、人気ジャンル別のショート動画を一覧でチェック。",
};

const RANKING_KEYS = new Set([
  "popular",
  "ranking_daily",
  "ranking_weekly",
  "ranking_monthly",
]);

/** 「もっと見る」のリンク先を section key (とジャンル名) から組み立てる。
 *  ジャンルは既存の /search?genre=... を再利用、それ以外は /list/<key> に飛ばす。 */
function buildMoreHref(section: { key: string; genre: string | null }): string {
  if (section.genre) {
    return `/search?genre=${encodeURIComponent(section.genre)}`;
  }
  return `/list/${encodeURIComponent(section.key)}`;
}

export default async function Page() {

  let data: Awaited<ReturnType<typeof getHome>>;
  try {
    data = await getHome(20);
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
    <PullToRefresh className="home-main">
      {sections.map((section) => {
        const isRanking = RANKING_KEYS.has(section.key);
        const action = {
          label: "もっと見る",
          href: buildMoreHref(section),
        };
        const playlistKey = `home_${section.key}`;
        // /feed 側で 20 件以降を取り直すための出所情報。
        // ジャンル系は key='genre' + genre名 で送り、それ以外はそのセクションkeyを送る。
        const playlistSource = section.genre
          ? { kind: "section" as const, key: "genre", genre: section.genre }
          : { kind: "section" as const, key: section.key };

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
                  source: playlistSource,
                }}
              />
            ))}
          </HorizontalCardRow>
        );
      })}

      <div className="home-footer-spacer" />

      <style>{pageStyles}</style>
    </PullToRefresh>
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
