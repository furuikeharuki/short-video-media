export const SITE_NAME = "AV Shorts";

export const SITE_URL =
  (process.env.NEXT_PUBLIC_SITE_URL ?? "https://av-shorts.com").replace(/\/?$/, "/");

export const SITE_DESCRIPTION =
  "FANZAのAV作品をショート動画で試し見。気に入ったらそのまま購入できるアダルト動画メディア。";

// ホーム "/" の <meta description> と WebSite JSON-LD の description に使う、
// 「サイトが何であるか」を主語付きで明示した説明文。SITE_DESCRIPTION は
// OG/Twitter や他ページのフォールバックとして広く使われているため触らず、
// ホームの検索結果向け説明はこちらに分離して同期させる。
export const HOME_DESCRIPTION =
  "AV Shortsは、AV作品のショート動画を縦スクロールで探せる動画サイトです。作品詳細・ジャンル・女優名から好みの動画を探せます。新作やランキングもチェックできます。";

export const SITE_KEYWORDS = [
  "AV",
  "ショート動画",
  "FANZA",
  "アダルト動画",
  "サンプル動画",
  "ランキング",
  "新作",
  "アフィリエイト",
];

export const SITE_LOCALE = "ja_JP";
