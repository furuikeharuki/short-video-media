import type { Metadata } from "next";
import { getHome } from "@/lib/api/home";
import { HOME_DESCRIPTION } from "@/lib/config/seo";
import HorizontalCardRow from "@/components/home/HorizontalCardRow";
import MovieCardThumb from "@/components/home/MovieCardThumb";
import ActressCardThumb from "@/components/home/ActressCardThumb";
import GoodsCardThumb from "@/components/home/GoodsCardThumb";
import PullToRefresh from "@/components/home/PullToRefresh";
import AdSlot from "@/components/ads/AdSlot";
import { isAdZoneEnabled } from "@/lib/ads/config";

// 30 秒間の ISR。ホーム "/" は BottomNav の "ホーム" タブから連発で踏まれる導線で、
// `force-dynamic` + `revalidate=0` だと毎回 API ラウンドトリップが入り
// フィード → ホーム遷移の TTFB がそのまま体感ラグになっていた。
// 30 秒なら新着 / ランキングの鮮度は十分担保しつつ、連続アクセス時には
// プリレンダ済み HTML を即時返せる。
export const revalidate = 30;

// ホーム "/" の <title> は "AV Shorts" を明示する。
// root layout には title.default = "AV Shorts" / template = "%s" が設定済みで
// あり、page 側で title を省略しても同じ結果になるはずだが、Search Console で
// 観測された "年齢確認 | AV Shorts | AV Shorts" のような事故を二度と起こさない
// ために、ホームの <title> はページ側で直接固定する (子の title はそのまま
// template "%s" を通って <title>AV Shorts</title> として描画される)。
export const metadata: Metadata = {
  title: "AV Shorts",
  description: HOME_DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: {
    title: "AV Shorts",
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
    // index 対象のジャンル集約ページへ誘導 (/search?genre=... は noindex のフィルタ用途)。
    return `/genres/${encodeURIComponent(section.genre)}`;
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
  const actressSections = (data.actress_sections ?? []).filter(
    (s) => s.items.length > 0,
  );
  const goodsSections = (data.goods_sections ?? []).filter(
    (s) => s.items.length > 0,
  );
  // ホームの「人気女優」セクション: 人気動画 (popular) の直後、
  // かつ 人気商品 の直前に差し込む。該当キーが見つからない場合は挿入しない。
  const popularActresses = actressSections.find(
    (s) => s.key === "popular_actresses",
  );
  // 「人気商品」(Goods) セクション。popular の直後、人気女優の下に差し込む。
  const popularProducts = goodsSections.find(
    (s) => s.key === "popular_products",
  );

  if (
    sections.length === 0 &&
    actressSections.length === 0 &&
    goodsSections.length === 0
  ) {
    return (
      <main className="home-main">
        <div className="home-empty">表示できる作品がありません</div>
        <style>{pageStyles}</style>
      </main>
    );
  }

  // セクション間広告は横長バナー（300x100）固定。
  // native（縦型カード）は横スクロール行間には不自然なので使わない。
  //
  // 広告の挿入位置は「特定セクションの直下」で固定する (= section.key で判定する)。
  // - "popular"          : 人気動画 → 人気女優 → 人気商品 と並べた末尾の直下
  //                        (人気女優・人気商品は popular の直後にインラインで差し込む)
  // - "ranking_monthly"  : 月間ランキングの直下
  //
  // 過去はフィルタ後の配列 index に対する `(i+1) % 3 === 0` で判定していたが、
  // 「本日配信 (new)」「新着 (recent)」が空でフィルタされると挿入位置が後ろの
  // セクションに玉突きで動いてしまい、本来 人気 / 月間ランキング の下にあった
  // 広告が別の場所に出てしまっていた。key 固定にすることで、上位セクションが
  // 表示されなくても人気カテゴリ群 / 月間ランキング の下に必ず広告が並ぶようにする。
  const bannerEnabled = isAdZoneEnabled("mobileBanner300x100");
  const AD_AFTER_KEYS = new Set(["popular", "ranking_monthly"]);

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

        // ad は section.key で固定。最終セクション直下には出さない (フッターが
        // すぐ続くので見栄えが悪いため)。
        const showAdAfter =
          bannerEnabled &&
          sectionIndex < sections.length - 1 &&
          AD_AFTER_KEYS.has(section.key);

        // 「人気動画」(popular) の直後に「人気女優」「人気商品」セクションを
        // インライン挿入する。popular 自体が空でも、後段で同じ位置に出したい
        // ので popular の直下にまとめて差し込む形にする。
        const showInlineAfterPopular = section.key === "popular";

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
            {showInlineAfterPopular && popularActresses && (
              <HorizontalCardRow
                title={popularActresses.title}
                action={{
                  label: "もっと見る",
                  href: "/list/popular_actresses",
                }}
              >
                {popularActresses.items.map((a, i) => (
                  <ActressCardThumb
                    key={a.id}
                    actress={a}
                    rank={i < 100 ? i + 1 : undefined}
                  />
                ))}
              </HorizontalCardRow>
            )}
            {showInlineAfterPopular && popularProducts && (
              <HorizontalCardRow
                title={popularProducts.title}
                action={{
                  label: "もっと見る",
                  href: "/list/popular_products",
                }}
              >
                {popularProducts.items.map((g, i) => (
                  <GoodsCardThumb
                    key={g.id}
                    goods={g}
                    rank={i < 100 ? i + 1 : undefined}
                  />
                ))}
              </HorizontalCardRow>
            )}
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
  /* セクション間広告。広告が充填されたときに上下に 8px の余白を取って隣接
     セクションと視覚的に分離する。AdSlot が isAdZoneEnabled=false で null を
     返したケースでもラッパーが空になるだけで害はないが、念のため :empty では
     非表示にしておく (page.tsx 側でも showAdAfter で出し分けているので普段は
     ここまで来ない)。 */
  .home-section-ad {
    padding: 8px 0;
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
