/**
 * 「プロ女優」(= sync_catalog で videoa フロアの作品全部に付与される擬似ジャンル)
 * の判定と先頭スキップ秒数の単一ソース。
 *
 * 仕様:
 *   - DMM の videoa (素人ではない、プロ作品) フロアからの作品には
 *     apps/jobs/src/sync_catalog._floor_genre_label() が "プロ女優" を付与する。
 *   - フロント側はこのジャンル名を見て、先頭 5 秒スキップ仕様を適用する。
 *   - 検索 / 女優ページ / ブックマーク等どこから来ても、最終的には FeedItem 経由で
 *     <video> が描画されるため、ここでの判定が全アクセス経路に効く。
 *
 * 旧実装では FeedItem / useFeedPlayback / useLowFirstVideoSrc にそれぞれ
 * 同じ判定ロジック・同じ定数 (PRO_ACTRESS_HEAD_SKIP_SEC=5) が点在しており、
 * 一箇所変更し忘れると判定がズレるリスクがあった。ここに集約することで:
 *   - 文字列リテラルの typo / 全角半角差異が原因の取りこぼしを防ぐ
 *   - 将来別フロア (videoc 等) にも独自スキップを追加するときの拡張点になる
 *   - dev (?vt=1) 計測でスキップ判定の結果を 1 行ログに残せる
 * という効果がある。
 */

import { isVideoTimingEnabled } from "@/lib/videoTiming";

/** sync_catalog で videoa フロアに付与される擬似ジャンル名。 */
export const PRO_ACTRESS_GENRE = "プロ女優";

/** プロ女優作品の先頭スキップ秒数 (= シークバー下限・初期再生位置)。 */
export const PRO_ACTRESS_HEAD_SKIP_SEC = 5;

/**
 * 「プロ女優」作品の先頭スキップが有効になるための最小 duration (秒)。
 * 極端に短いサンプル動画 (= 5 秒スキップしたら 0 秒しか残らない) では
 * スキップを無効化する。
 */
export const PRO_ACTRESS_MIN_DURATION_SEC = 10;

/**
 * カードに付与されたジャンル配列を見て「プロ女優」作品かどうかを判定する。
 *
 * - 引数 `genres` は `MovieCard.genres` (= API の MovieCard.genres = DB Genre.name 配列)
 *   をそのまま渡す。
 * - undefined / null / 空配列なら false (= 非プロ女優扱い)。
 * - 文字列比較は完全一致。sync_catalog が "プロ女優" 固定で書き込んでいるため、
 *   normalize は不要。
 */
export function isProActressMovie(genres: readonly string[] | null | undefined): boolean {
  if (!genres || genres.length === 0) return false;
  return genres.includes(PRO_ACTRESS_GENRE);
}

/**
 * 作品の先頭スキップ秒数 (= 再生最低開始秒数) を返す。
 * 非プロ女優は 0。
 */
export function getMinStartTime(genres: readonly string[] | null | undefined): number {
  return isProActressMovie(genres) ? PRO_ACTRESS_HEAD_SKIP_SEC : 0;
}

/**
 * ?vt=1 / localStorage.video_timing=1 / NODE_ENV!==production のとき
 * console.debug にスキップ判定結果を出す。本番では何もしない。
 *
 * フロントで「5 秒スキップが効いていない」とユーザー報告が来たとき、
 * ?vt=1 を付けてフィードを開くと該当作品でこのログが出るので、
 * `isProActress=true / minStart=5` になっているかをコンソールで一目で確認できる。
 */
export function logProActressDecision(slug: string, genres: readonly string[] | null | undefined): void {
  if (!isVideoTimingEnabled()) return;
  const isPro = isProActressMovie(genres);
  const minStart = getMinStartTime(genres);
  // eslint-disable-next-line no-console
  console.debug(
    `vt ${slug}: pro-actress decision isPro=${isPro} minStart=${minStart} genres=${JSON.stringify(genres ?? [])}`,
  );
}
