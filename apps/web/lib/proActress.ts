/**
 * 「プロ女優」(= sync_catalog で videoa フロアの作品全部に付与される擬似ジャンル)
 * の判定と「末尾スキップ」秒数の単一ソース。
 *
 * 仕様:
 *   - DMM の videoa (素人ではない、プロ作品) フロアからの作品には
 *     apps/jobs/src/sync_catalog._floor_genre_label() が "プロ女優" を付与する。
 *   - フロント側はこのジャンル名を見て、「後ろ (末尾) から 1 分半だけ残して
 *     手前を全部スキップする」仕様を適用する。
 *     つまり再生開始位置 = duration - PRO_ACTRESS_TAIL_KEEP_SEC。
 *   - 検索 / 女優ページ / ブックマーク等どこから来ても、最終的には FeedItem 経由で
 *     <video> が描画されるため、ここでの判定が全アクセス経路に効く。
 *
 * 旧実装 (先頭 5 秒スキップ) との違い:
 *   - 旧: 開始位置は固定値 5 秒。duration を知らなくても先読み seek できた。
 *   - 新: 開始位置は duration に依存する (= duration - 90)。duration が確定
 *     (loadedmetadata / readyState>=1) するまで実際の開始秒数は計算できない。
 *     このためスキップ下限は metadata 到達後に確定させる。
 *
 * ここに集約することで:
 *   - 文字列リテラルの typo / 全角半角差異が原因の取りこぼしを防ぐ
 *   - 「末尾に残す秒数」を 1 箇所変えれば全経路に反映される
 *   - dev (?vt=1) 計測でスキップ判定の結果を 1 行ログに残せる
 * という効果がある。
 */

import { isVideoTimingEnabled } from "@/lib/videoTiming";

/** sync_catalog で videoa フロアに付与される擬似ジャンル名。 */
export const PRO_ACTRESS_GENRE = "プロ女優";

/**
 * プロ女優作品で「末尾に残す」秒数 (= 1 分半 = 90 秒)。
 * この長さだけ残して手前を全部スキップする (再生開始位置 = duration - この値)。
 */
export const PRO_ACTRESS_TAIL_KEEP_SEC = 90;

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
 * 作品の「末尾に残す秒数」を返す (= duration に依存しない静的な intent)。
 * - プロ女優: PRO_ACTRESS_TAIL_KEEP_SEC (90)
 * - 非プロ女優: 0 (末尾スキップ無し)
 *
 * この値は duration が未確定でも決まるため、先読み <video> の登録などに使える。
 * 実際の再生開始秒数は `tailStartForDuration(duration, tailKeepSec)` で計算する。
 */
export function getTailKeepSec(genres: readonly string[] | null | undefined): number {
  return isProActressMovie(genres) ? PRO_ACTRESS_TAIL_KEEP_SEC : 0;
}

/**
 * duration と「末尾に残す秒数」から、実際の再生開始秒数 (= スキップ下限) を計算する。
 *
 * - tailKeepSec <= 0: 0 (末尾スキップ無し)。
 * - duration 未確定 (NaN / 0 / Infinity): 0。metadata 到達後に再計算する。
 * - duration <= tailKeepSec: 0 (残す尺の方が長い = 丸ごと再生する)。
 * - それ以外: duration - tailKeepSec。
 */
export function tailStartForDuration(durationSec: number, tailKeepSec: number): number {
  if (!Number.isFinite(tailKeepSec) || tailKeepSec <= 0) return 0;
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  if (durationSec <= tailKeepSec) return 0;
  return durationSec - tailKeepSec;
}

/**
 * ?vt=1 / localStorage.video_timing=1 / NODE_ENV!==production のとき
 * console.debug にスキップ判定結果を出す。本番では何もしない。
 *
 * フロントで「末尾スキップが効いていない」とユーザー報告が来たとき、
 * ?vt=1 を付けてフィードを開くと該当作品でこのログが出るので、
 * `isProActress=true / tailKeep=90` になっているかをコンソールで一目で確認できる。
 * (実際の開始秒数 = duration-90 は duration 確定後にしか決まらないため、
 *  ここでは intent である tailKeep を出す。)
 */
export function logProActressDecision(slug: string, genres: readonly string[] | null | undefined): void {
  if (!isVideoTimingEnabled()) return;
  const isPro = isProActressMovie(genres);
  const tailKeep = getTailKeepSec(genres);
  // eslint-disable-next-line no-console
  console.debug(
    `vt ${slug}: pro-actress decision isPro=${isPro} tailKeep=${tailKeep} genres=${JSON.stringify(genres ?? [])}`,
  );
}
