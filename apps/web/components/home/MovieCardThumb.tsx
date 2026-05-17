"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { MovieCard } from "@/lib/api/feed";
import { logEvent } from "@/lib/api/events";
import { savePlaylist, type Playlist } from "@/lib/feedPlaylist";

type Props = {
  movie: MovieCard;
  /** 縦長 (9:16) か横長 (16:9) か。デフォは縦長カード。 */
  aspect?: "portrait" | "landscape";
  /** ランキング順位 (1始まり)。指定時は左上にバッジ表示。 */
  rank?: number;
  /**
   * タップ時に「そのセクションのリスト順でフィード再生を開始」させるときに指定。
   * playlist があると href は無視され、sessionStorage にリストを保存してから /?playlist=<key> へ遷移する。
   */
  playlist?: Playlist;
  /** playlist 未指定時の遷移先 (デフォは詳細モーダル)。 */
  href?: string;
  /**
   * 親のグリッド/フレックスセルに合わせて幅 100% で伸ばすか。
   * デフォは false (140px フィックス = ホームの横スクロール用) 。
   */
  fluid?: boolean;
};

export default function MovieCardThumb({
  movie,
  aspect = "portrait",
  rank,
  playlist,
  href,
  fluid = false,
}: Props) {
  const router = useRouter();
  const imgSrc = movie.image_url_list ?? movie.image_url_large ?? "";
  const linkHref = href ?? `/movies/${encodeURIComponent(movie.slug)}`;

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (playlist) {
      e.preventDefault();
      logEvent({
        event_type: "play",
        slug: movie.slug,
        title: movie.title,
      });
      savePlaylist(playlist);
      router.push(`/feed?playlist=${encodeURIComponent(playlist.key)}`);
      return;
    }
    logEvent({
      event_type: "detail_click",
      slug: movie.slug,
      title: movie.title,
    });
  };

  return (
    <Link
      href={linkHref}
      onClick={handleClick}
      className={`mct mct--${aspect}${fluid ? " mct--fluid" : ""}`}
      aria-label={movie.title}
    >
      <div className="mct-thumb">
        {imgSrc ? (
          <>
            {/* 背景レイヤー: 同じ画像を blur+暗くして敷き、contain 時の余白を画像の延長で埋める
                (詳細ページの mdc-hero と同じ手法) */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imgSrc}
              alt=""
              aria-hidden="true"
              loading="lazy"
              decoding="async"
              className="mct-thumb-blur"
            />
            {/* 前景レイヤー: メイン画像。videoa(pl.jpg) は右端寄せでメインビジュアルを見せる */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imgSrc}
              alt=""
              loading="lazy"
              decoding="async"
              className="mct-thumb-img"
            />
          </>
        ) : (
          <div className="mct-thumb-fallback" aria-hidden="true" />
        )}
        {rank != null && (
          <span className={`mct-rank ${rank <= 3 ? "mct-rank--top" : ""}`}>
            {rank}
          </span>
        )}
      </div>

      <div className="mct-meta">
        <p className="mct-title" title={movie.title}>{movie.title}</p>
        {movie.actresses.length > 0 && (
          <p className="mct-sub">{movie.actresses.slice(0, 2).join(" / ")}</p>
        )}
      </div>

      <style>{styles}</style>
    </Link>
  );
}

const styles = `
  .mct {
    display: block;
    text-decoration: none;
    color: #fff;
    flex: 0 0 auto;
    -webkit-tap-highlight-color: transparent;
    /* グリッドセル内でのサブピクセル丸め誤差を抑える */
    min-width: 0;
    box-sizing: border-box;
  }
  .mct--portrait  { width: 140px; }
  .mct--landscape { width: 220px; }
  /* 親グリッドのセルいっぱいに伸ばすモード (視聴履歴 / ブックマーク / 検索結果)
     * 複数カードをグリッドに並べると React が同じ <style> をカード毎に崩し順で挿入するため、
     * カードによって .mct--portrait が後勝ちして 140px のままに見えることがある。
     * 必ず勝てるよう複合セレクタと !important を使う。 */
  .mct.mct--fluid { width: 100% !important; }

  .mct-thumb {
    position: relative;
    width: 100%;
    border-radius: 10px;
    overflow: hidden;
    background: #111;
    /* サブピクセルで 1px はみ出させないため明示的に min-width: 0 */
    min-width: 0;
  }
  .mct--portrait  .mct-thumb { aspect-ratio: 9 / 13; }
  .mct--landscape .mct-thumb { aspect-ratio: 16 / 10; }

  /* 背景レイヤー: 詳細ページ (mdc-hero-blur) と同じ手法で同じ画像を
     blur(24px) brightness(0.3) で敷き、contain 時の余白部分を画像の延長で埋める。 */
  .mct-thumb-blur {
    position: absolute; inset: 0;
    width: 100%; height: 100%;
    object-fit: cover;
    filter: blur(24px) brightness(0.3);
    transform: scale(1.1);
    display: block;
    z-index: 0;
  }

  /* 前景レイヤー: メイン画像。デフォは contain でカード枠内に全体を収める。
     videoa(pl.jpg) のみ右端領域 (約 380x538 相当) のメインビジュアル側を見せたいので、
     cover + right center に切替えてカード枠にフィットさせる。 */
  .mct-thumb-img {
    position: absolute;
    top: 0; left: 0;
    width: 100%; height: 100%;
    object-fit: contain;
    display: block;
    z-index: 1;
  }
  /* pl.jpg = 800x538 の見開きジャケット。右端から約半分の領域がメインビジュアルなので、
     cover + object-position: right center でその領域を縦長カード枠に切り出す。 */
  .mct-thumb-img[src$="pl.jpg"] {
    object-fit: cover;
    object-position: right center;
  }
  .mct-thumb-fallback {
    position: absolute; inset: 0;
    width: 100%; height: 100%;
    background: linear-gradient(135deg, #1a1a1a, #2a2a2a);
  }

  .mct-rank {
    position: absolute;
    z-index: 2;
    top: 6px; left: 6px;
    min-width: 24px; height: 24px;
    padding: 0 6px;
    display: inline-flex; align-items: center; justify-content: center;
    background: rgba(0,0,0,0.7);
    color: #fff;
    font-size: 13px;
    font-weight: 800;
    border-radius: 6px;
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
  }
  .mct-rank--top {
    background: linear-gradient(135deg, #e91e63, #ff5174);
  }

  .mct-meta {
    margin-top: 8px;
    padding: 0 2px;
  }
  .mct-title {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    line-height: 1.35;
    color: #fff;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    overflow: hidden;
    word-break: break-word;
  }
  .mct-sub {
    margin: 4px 0 0;
    font-size: 11px;
    color: rgba(255,255,255,0.55);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`;
