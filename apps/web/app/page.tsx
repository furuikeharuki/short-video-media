import type { Metadata } from "next";
import { getHome } from "@/lib/api/home";
import HorizontalCardRow from "@/components/home/HorizontalCardRow";
import MovieCardThumb from "@/components/home/MovieCardThumb";
import PullToRefresh from "@/components/home/PullToRefresh";
import AdSlot from "@/components/ads/AdSlot";
import { isAdZoneEnabled } from "@/lib/ads/config";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// ホーム "/" の <title> は root layout の default (= "AV Shorts") をそのまま
// 使う (Google が検索結果でサイト名を自動付与するため "ホーム | AV Shorts |
// AV Shorts" のような重複表示にならないようにする)。
export const metadata: Metadata = {
  description:
    "本日配信開始の新作、日間/週間/月間ランキング、人気ジャンル別のAVショート動画を一覧でチェック。気に入った作品はFANZAでそのまま購入できます。",
  alternates: { canonical: "/" },
  openGraph: {
    description:
      "新作・ランキング・人気ジャンルのAVショート動画。気に入った作品はFANZAでそのまま購入できます。",
    url: "/",
  },
};

const RANKING_KEYS = new Set([
  "popular",
  "ranking_daily",
  "ranking_weekly",
  "ranking_monthly",
]);

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

  // セクション間広告は横長バナー（300x100）固定。
  // native（縦型カード）は横スクロール行間には不自然なので使わない。
  const bannerEnabled = isAdZoneEnabled("mobileBanner300x100");
  const SECTION_AD_EVERY = 3;

  return (
    <PullToRefresh className="home-main">
      <h1 className="home-h1-sr">AV Shorts｜AVショート動画メディア</h1>
      {sections.map((section, sectionIndex) => {
        const isRanking = RANKING_KEYS.has(section.key);
        const action = {
          label: "もっと見る",
          href: buildMoreHref(section),
        };
        const playlistKey = `home_${section.key}`;
        const playlistSource = section.genre
          ? { kind: "section" as const, key: "genre", genre: section.genre }
          : { kind: "section" as const, key: section.key };

        const showAdAfter =
          bannerEnabled &&
          sectionIndex < sections.length - 1 &&
          (sectionIndex + 1) % SECTION_AD_EVERY === 0;

        return (
          <div key={section.key}>
            <HorizontalCardRow
              title={section.title}
              subtitle={section.subtitle}
              action={action}
            >
              {section.items.map((m, i) => (
                <MovieCardThumb
                  key={m.id}
                  movie={m}
                  aspect="portrait"
                  rank={isRanking && i < 100 ? i + 1 : undefined}
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
            {showAdAfter && (
              <div className="home-section-ad">
                <AdSlot zone="mobileBanner300x100" />
              </div>
            )}
          </div>
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

  /* H1 はスクリーンリーダー/検索エンジン向けの視覚的非表示。
     UI のレイアウトは横スクロール行が主体なので画面上には表示しない。 */
  .home-h1-sr {
    position: absolute !important;
    width: 1px; height: 1px;
    padding: 0; margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

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
  /* セクション間広告。
     - AdSlot 自体は <ins> が空のあいだ min-height:1px なので、wrapper に固定の
       padding を与えると広告未充填時に「無意味な 16px 程度の空白」が残り、
       本日配信 / 新着 など上位セクションが空になったときにスペーシングが
       不自然に見える原因になる。
     - そのため wrapper は padding 0 にして、広告が充填されたときだけ
       高さを持つようにする。隣接セクションの間隔は既存の .hcr の
       padding (上 18px / 下 8px) でリズムが取れる。 */
  .home-section-ad {
    display: flex;
    justify-content: center;
    width: 100%;
    max-width: 100%;
    overflow: hidden;
    box-sizing: border-box;
  }
  .home-section-ad:empty { display: none; }
  .home-section-ad .ad-slot {
    width: 100% !important;
    max-width: 100% !important;
  }
  .home-empty, .home-error {
    padding: 80px 20px;
    text-align: center;
    color: rgba(255,255,255,0.5);
    font-size: 14px;
  }
`;
