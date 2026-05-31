/**
 * age-gate 通過後のリダイレクト先 (next) を検証・正規化する純粋ロジック。
 *
 * middleware は `?next=<pathname+search>` で元の URL を引き継ぐが、これは
 * クライアントから自由に書き換えられるため、そのまま `window.location.href` に
 * 渡すとオープンリダイレクト (例: `//evil.com`, `https://evil.com`,
 * `javascript:...`) の踏み台になりうる。ここで「同一オリジンの内部パスのみ」に
 * 制限する。
 *
 * 許可するのは:
 *   - 単一の "/" から始まる相対パス (例: "/feed?v=abc", "/movies/foo#x")
 * 拒否するのは:
 *   - 空文字 / undefined
 *   - "//" や "/\" で始まる protocol-relative URL
 *   - "http:", "javascript:", "data:" などスキームを含むもの
 *   - 制御文字 (改行・タブ等) を含むもの
 *
 * 検証ロジックは Edge (middleware) / Node (route) / browser (form) の
 * いずれからも import できるよう、Web 標準 API のみで実装する。
 */

const DEFAULT_NEXT = "/";

// 制御文字 (NUL〜US, DEL) を検出する。改行・タブ・NUL でのヘッダ/URL 分割を防ぐ。
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function sanitizeNextPath(
  raw: string | null | undefined,
  fallback: string = DEFAULT_NEXT,
): string {
  if (typeof raw !== "string") return fallback;

  const value = raw.trim();
  if (value === "") return fallback;

  // 制御文字 (改行・タブ・NUL 等) を含むものは即拒否。
  if (CONTROL_CHARS.test(value)) return fallback;

  // 必ず単一の "/" 始まりであること。
  if (value[0] !== "/") return fallback;

  // protocol-relative ("//host" / "/\host") を拒否。
  if (value[1] === "/" || value[1] === "\\") return fallback;

  // バックスラッシュは一部ブラウザで "/" に正規化されるため保守的に拒否。
  if (value.includes("\\")) return fallback;

  // スキーム (例: "javascript:", "http:") の混入を拒否。
  // path 内に出現する legitimate な ":" は query / fragment 以降のみ許容する。
  const pathPart = value.split(/[?#]/, 1)[0];
  if (pathPart.includes(":")) return fallback;

  return value;
}

/** next パスの遷移先タイプ。プレビューの出し分けに使う。 */
export type NextDestinationKind =
  | "feed"
  | "movie"
  | "actress"
  | "genre"
  | "search"
  | "list"
  | "home";

/**
 * 正規化済み (sanitizeNextPath を通した) パスから遷移先タイプを判定する。
 * 中身 (作品の詳細) を読み込まず、URL の形だけで判定するため安全。
 */
export function classifyNextPath(safePath: string): NextDestinationKind {
  // pathname のみで判定する (query / fragment は無視)。
  const pathname = safePath.split(/[?#]/, 1)[0];

  if (pathname === "/" || pathname === "") return "home";
  if (pathname === "/feed" || pathname.startsWith("/feed/")) return "feed";
  if (pathname.startsWith("/movies/")) return "movie";
  if (pathname.startsWith("/actresses/")) return "actress";
  if (pathname.startsWith("/genres/")) return "genre";
  if (pathname.startsWith("/search")) return "search";
  if (pathname.startsWith("/list")) return "list";
  return "home";
}
