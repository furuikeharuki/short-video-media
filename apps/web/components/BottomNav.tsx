"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useCallback, useState } from "react";
import { markFeedStartUnmuted } from "@/lib/feedNav";
import { buildFeedHrefFromSavedPref } from "@/lib/savedSearchPrefs";

/**
 * /feed から /, /mypage 等にフルページ遷移するとき、ページ全体の取得が終わるまで
 * 古い <video> が再生継続して CPU / 帯域を食い、画面遷移が体感的に重く感じる。
 *
 * クリック直後に全 <video> を pause + src 解除して、デコード負荷をすぐ落とす。
 */
function stopFeedPlaybackImmediately() {
  if (typeof document === "undefined") return;
  try {
    const videos = document.querySelectorAll("video");
    videos.forEach((v) => {
      try {
        v.pause();
        // 大きな MP4 のデコード継続を確実に止めるため removeAttribute("src") + load()。
        // src を空にしておくとブラウザがバッファを解放する。
        v.removeAttribute("src");
        v.load();
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* ignore */
  }
}

// ショートボタンを押して /feed に遷移するときに、保存されているフィードのスナップショットを破棄して
// ランダム再生を保証する。FeedClient 側は sessionStorage が空なら getFeed を新しい seed で取り直す。
// さらに、このクリックをユーザージェスチャーとして採用し、次のフィード起動時に音声 ON で始まるようフラグを立てる
function resetFeedSession() {
  try {
    sessionStorage.removeItem("feed_seed");
    sessionStorage.removeItem("feed_index");
    sessionStorage.removeItem("feed_items");
    // 前回 /feed を抜けた時点での filter sig / cursor が残っていると、新規 /feed
    // (まだ URL に保存済みフィルターが注入される前) で誤って "sig 一致" を起こす
    // 経路は本来無いが、状態の混線を完全に防ぐためここで全部消す。
    sessionStorage.removeItem("feed_filter_sig");
    sessionStorage.removeItem("feed_next_cursor");
  } catch {
    /* ignore */
  }
  markFeedStartUnmuted();
}

// 保存済み詳細検索条件を /feed?... に展開する処理は @/lib/savedSearchPrefs に移動。
// FeedClient 側にも同じヘルパーを共有させて、URL 展開が間に合わない経路でも
// FeedClient が sessionStorage を直接読んで filter として fetch にフォールバックする
// 二重防衛にしてある。
const NAV_ITEMS = [
  {
    label: "ホーム",
    href: "/",
    extraActive: [] as string[],
    iconOutline: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.5z"/>
        <path d="M9 21V12h6v9"/>
      </svg>
    ),
    iconFilled: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="none">
        <path d="M12 2.5L2 9.2V21a1 1 0 0 0 1 1h6v-8h6v8h6a1 1 0 0 0 1-1V9.2L12 2.5z"/>
      </svg>
    ),
  },
  {
    label: "ショート",
    href: "/feed",
    // 動画再生中 (フィード + 動画詳細 + モーダル) はすべて「ショート」をアクティブ表示にする。
    // /movies/* は動画詳細ページ および モーダル経由でも同じ pathname になるため、ここで拾う。
    extraActive: ["/search/feed", "/movies/"],
    iconOutline: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="2" width="16" height="20" rx="2"/>
        <polygon points="10,8 16,12 10,16" fill="currentColor" stroke="none"/>
      </svg>
    ),
    iconFilled: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="none">
        <rect x="4" y="2" width="16" height="20" rx="2"/>
        <polygon points="10,8 16,12 10,16" fill="#000"/>
      </svg>
    ),
  },
  {
    label: "マイページ",
    href: "/mypage",
    extraActive: [] as string[],
    iconOutline: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="8" r="4"/>
        <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
      </svg>
    ),
    iconFilled: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="none">
        <circle cx="12" cy="8" r="4"/>
        <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
      </svg>
    ),
  },
];

declare global {
  interface WindowEventMap {
    "video-progress": CustomEvent<{ progress: number }>;
    "video-seek": CustomEvent<{ ratio: number }>;
  }
}

// ナビゲーションを非表示にするパス。
// - /age-gate: 年齢確認を通さずにショート/ホーム等へ遷移されないように
// - /actresses, /movies: 詳細ページは没入型レイアウトのためボトムナビを隠す
//
// 注意: Next.js 15 では window.history.pushState を usePathname が拾うため、
// /feed 上で MovieDetailModal を開く (pushState で URL を /movies/<slug> に書き換える) と、
// 上の "/movies" にヒットして BottomNav が一緒に消えてしまう。
// それを防ぐため、MovieDetailModal が dispatch する "modal-open" / "modal-close" イベントを
// 監視し、フィード上モーダル中は強制的に「/feed と同じ表示状態」を保つ。
const NAV_HIDDEN_PATHS = ["/age-gate", "/actresses", "/movies"];

export default function BottomNav() {
  const pathname    = usePathname();
  // /feed 上で MovieDetailModal を開いている間 true。
  // pushState によって pathname が /movies/<slug> に変わっても、BottomNav は
  // フィード視聴中と同じ振る舞い (表示 + シークバー + ショートアクティブ) を維持する。
  const [isFeedModalOpen, setIsFeedModalOpen] = useState(false);

  useEffect(() => {
    // 同値の setState は React がスケジューラ段階で bail-out するが、
    // 「modal-open / modal-close が連続で来る」シーンを明示的に no-op にしておく
    // (StrictMode 二重実行や、親側でモーダルを再 mount したときの安全弁)。
    const onOpen  = () => setIsFeedModalOpen((prev) => (prev ? prev : true));
    const onClose = () => setIsFeedModalOpen((prev) => (prev ? false : prev));
    window.addEventListener("modal-open",  onOpen);
    window.addEventListener("modal-close", onClose);
    return () => {
      window.removeEventListener("modal-open",  onOpen);
      window.removeEventListener("modal-close", onClose);
    };
  }, []);

  const isShortPage = pathname === "/feed" || pathname.startsWith("/search/feed") || isFeedModalOpen;
  // フィード上モーダル中は pathname が /movies/<slug> でも「非表示パス」とは扱わない。
  const isHidden    = !isFeedModalOpen && NAV_HIDDEN_PATHS.some((p) => pathname.startsWith(p));

  const trackRef   = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const [progress, setProgress] = useState(0);
  // フィードに「入る」フルページ遷移 (home / mypage → /feed) で、新ページの初回
  // ペイントに seekbar (top:-14px の 3px レール) が突然現れると、ナビが 5–6px だけ
  // 高くなったように知覚される。#249/#250 で opacity fade-in を入れて緩和したが、
  // それでも「レールが現れる視覚イベント」が残るため、引き続き「ナビが一瞬高くなる」
  // チラつきとして見える。
  //
  // 対策はレイヤを分ける:
  //   1. seekbar-track 自体は ::before のレール/fill/thumb を持たない素の box として
  //      非フィードルートでも常時 DOM に置く。これによりナビの「視覚的フットプリント」
  //      (DOM 構造としてナビが占める領域) はルート間で同一になる。
  //   2. ::before のレール、fill、thumb は seekbar-track--active が付いたときだけ
  //      描画する。--active は「フィードにいる && 実際に再生中 (= video-progress が
  //      届いた)」を満たしたタイミングで付与する。これにより /feed の初回ペイント
  //      では何も描画されず、動画再生開始と一緒に seekbar が自然に現れる。
  //      ユーザーには「動画と一緒に再生 UI が出てきた」と感じられ、ナビ高さの
  //      ポップとして知覚されない。
  //   3. bfcache 復帰のように既に再生済み状態が残っているケースでは hasProgress が
  //      true のまま戻るので即 visible (チラつかない)。
  //   4. 非アクティブ時は pointer-events:none。タップ吸い込みも起きない。
  const [hasProgress, setHasProgress] = useState(false);
  // /feed を抜けて home/mypage に着いたとき、レール表示状態 (hasProgress=true) を
  // 即落としておく。次回 /feed に入ったときの「初回 progress 到着で fade-in」挙動
  // を毎回成立させるため。
  useEffect(() => {
    if (!isShortPage) {
      setHasProgress(false);
      setProgress(0);
    }
  }, [isShortPage]);

  // 「ショートページにいるかどうか」を ref にミラーして、video-progress リスナを
  // useEffect の依存に乗せずに済むようにする。依存に isShortPage を載せていた以前の
  // 実装では、modal-open/close で isFeedModalOpen が変化するたびに effect cleanup →
  // setup が走り、video-progress (60fps) との組合せで稀に React の更新スタック
  // (Maximum update depth exceeded) を踏むケースがあった。リスナはマウント中
  // 1 度だけ登録し、ハンドラ内で ref を見て setState するか判断する。
  const isShortPageRef = useRef(isShortPage);
  useEffect(() => {
    isShortPageRef.current = isShortPage;
  }, [isShortPage]);

  useEffect(() => {
    const handler = (e: CustomEvent<{ progress: number }>) => {
      if (!isShortPageRef.current) return;
      if (isDragging.current) return;
      const next = e.detail.progress;
      // 同値で setState すると React は bail-out するが、念のため明示的にガードして
      // 不要な再レンダーを完全に避ける。
      setProgress((prev) => (prev === next ? prev : next));
      // 初回 progress 到着で seekbar の見た目 (レール/fill/thumb) を解禁する。
      // ナビ高さ変化を伴うチラつきの原因 = /feed 初回ペイントでのレール出現、を
      // 動画再生開始タイミングまで遅らせるため。
      setHasProgress((prev) => (prev ? prev : true));
    };
    window.addEventListener("video-progress", handler);
    return () => window.removeEventListener("video-progress", handler);
  }, []);

  const seek = useCallback((clientX: number) => {
    const track = trackRef.current;
    if (!track) return;
    const rect  = track.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    setProgress(ratio);
    window.dispatchEvent(new CustomEvent("video-seek", { detail: { ratio } }));
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!isShortPage) return;
    isDragging.current = true;
    seek(e.clientX);
    const onMove = (ev: MouseEvent) => seek(ev.clientX);
    const onUp   = () => { isDragging.current = false; window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [isShortPage, seek]);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (!isShortPage) return;
    e.stopPropagation();
    isDragging.current = true;
    seek(e.touches[0].clientX);
  }, [isShortPage, seek]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!isDragging.current) return;
    e.stopPropagation();
    seek(e.touches[0].clientX);
  }, [seek]);

  const handleTouchEnd = useCallback(() => {
    isDragging.current = false;
  }, []);

  // ナビを非表示にするパス (年齢確認ページなど) では何もレンダリングしない。
  // フックの起動順序を守るため、早期 return はフック定義の後に置く。
  if (isHidden) {
    return null;
  }

  return (
    <nav className="bottom-nav" aria-label="メインナビゲーション">

      {/*
        seekbar-track はフィード/非フィードを問わず常に DOM に置く。
        これによりナビの「視覚的フットプリント」(ナビ上端から 14px 上のレール領域)
        がルート間で同一になり、フィードに入る瞬間に「ナビが急に高くなった」と
        知覚されない。--active が付くまでレール/fill/thumb は描画されず、
        pointer-events も無効。
        isShortPage=false のときは aria-hidden で支援技術からも隠す。
      */}
      <div
        ref={trackRef}
        className={`seekbar-track${
          isShortPage && hasProgress ? " seekbar-track--active" : ""
        }`}
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        aria-hidden={!isShortPage || undefined}
        aria-label={isShortPage ? "再生位置" : undefined}
        role={isShortPage ? "slider" : undefined}
        aria-valuemin={isShortPage ? 0 : undefined}
        aria-valuemax={isShortPage ? 100 : undefined}
        aria-valuenow={isShortPage ? Math.round(progress * 100) : undefined}
      >
        <div className="seekbar-fill" style={{ width: `${progress * 100}%` }} />
        <div className="seekbar-thumb" style={{ left: `${progress * 100}%` }} />
      </div>


      {NAV_ITEMS.map((item) => {
        const isActive =
          (item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)) ||
          item.extraActive.some((p) => pathname.startsWith(p)) ||
          (item.href === "/feed" && pathname === "/feed");
        const icon = isActive ? item.iconFilled : item.iconOutline;

        if (isActive) {
          return (
            <span key={item.href} className="bottom-nav-item bottom-nav-item--active" aria-current="page">
              <span className="bottom-nav-icon">{icon}</span>
              <span className="bottom-nav-label">{item.label}</span>
            </span>
          );
        }
        const handleNavClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
          if (item.href === "/feed") {
            resetFeedSession();
          }
          if (
            e.defaultPrevented ||
            e.button !== 0 ||
            e.metaKey ||
            e.ctrlKey ||
            e.shiftKey ||
            e.altKey
          ) {
            return;
          }
          // /feed (ショート動画画面) との出入りはどちら向きも常にフルページ遷移にする。
          //
          // フィード画面は以下が複雑に絡んでおり、SPA 遷移 (router.push / <Link>) では
          // 確実に動かない:
          //   1. MovieDetailModal が window.history.pushState で URL を /movies/<slug> に
          //      書き換え、unmount 時に replaceState で戻す。Next.js 15 のパッチ済 history
          //      API はこれを usePathname に反映するが、cleanup のタイミングで router.push が
          //      打ち消されることがある。
          //   2. @modal 並列ルート (/(.)movies/[slug]) のスロット状態が、フィード上での
          //      pushState/replaceState によって不整合を起こし、SPA 遷移が止まることがある。
          //   3. FeedClient は <video>・sessionStorage・IntersectionObserver・useFeedPlayback
          //      の自動再生 effect 等の副作用を多数持ち、SPA mount だと初回再生のための
          //      ユーザージェスチャー context が失われて <video> が play() できず黒画面のまま
          //      止まるケースがある (リロードなら直る = サーバ HTML から正規ロードされるため)。
          //
          // window.location.assign に統一すれば、ブラウザが新しい URL をフェッチして
          // クリーンに遷移するため、上記いずれの状態にも左右されず確実に動く。
          // フィードを出入りする時点でフィードの全状態は再構築されるので、SPA 遷移に
          // こだわる必要は薄い。
          const onShortFeed =
            pathname === "/feed" ||
            pathname.startsWith("/search/feed") ||
            pathname.startsWith("/movies/") ||
            isFeedModalOpen;
          const goingToFeed = item.href === "/feed";
          if ((onShortFeed && item.href !== "/feed") || goingToFeed) {
            e.preventDefault();
            // フィードからの離脱 (= ホーム / マイページへ向かう) では、
            // <video> のデコードを直ちに止めてからフルページ遷移を発行する。
            // 旧フィードの <video> がページ取得中も走り続けて CPU/帯域を奪う
            // "遷移が重い" 感覚を解消する。
            if (!goingToFeed) {
              stopFeedPlaybackImmediately();
            }
            // /feed へ向かうときだけ、保存済み詳細検索条件を href に展開してから
            // フルページ遷移する。これにより新しい /feed は初回マウントから
            // URL に詳細条件を持った状態になり、FeedClient の hasAnyFilter が
            // 確定 → 0 件で「該当する作品が見つかりませんでした」表示が確実に出る。
            // 保存済みが何もないときは "/feed" のままで従来挙動。
            const targetHref = goingToFeed
              ? buildFeedHrefFromSavedPref()
              : item.href;
            // ヘッダーとボトムナビの間だけ黒 + スピナーで即座に覆って、
            // ブラウザが次ページの HTML を取得する数百ms～数秒の間も
            // 「タップが効いた」感を返す。フルページ遷移なので明示的な
            // hide は不要 (DOM ごと差し替わる)。
            try {
              window.dispatchEvent(new Event("nav-loading-show"));
            } catch {
              /* ignore: 古いブラウザでも本処理は致命的ではない */
            }
            window.location.assign(targetHref);
          }
          // それ以外は <Link> のデフォルト挙動 (Next の SPA 遷移) に任せる。
        };
        return (
          <Link
            key={item.href}
            href={item.href}
            className="bottom-nav-item"
            onClick={handleNavClick}
          >
            <span className="bottom-nav-icon">{icon}</span>
            <span className="bottom-nav-label">{item.label}</span>
          </Link>
        );
      })}

      <style>{navStyle}</style>
    </nav>
  );
}

const navStyle = `
  /*
    Chrome では .bottom-nav に backdrop-filter を直接かけると、フルページ遷移
    (home → /feed) で新ページが最初の数フレームを描画する間に「ナビの compositing
    レイヤが作り直される」ことがあり、その時間差で:
      - 1～2 フレーム間だけナビの背景が「下のフィード <video> をブラーした色」に
        振れて見える
      - bottom:-3px の sub-pixel 配置が GPU レイヤ再生成のタイミングで微妙に
        ズレ、ナビが上下方向にチラついて見える
    という Chrome 限定のチラつきが残っていた。

    対策:
      1. ナビ root の背景は完全不透明 (#000) にして、compositing がまだ整って
         いない初回フレームでも「ナビ表示中の見た目」と完全一致させる。
         (フィード <video> は基本暗色 + ナビ越しに 8% 透過していた程度なので
          見た目の差はほぼ無い)
      2. 元々の rgba(0,0,0,0.92) + backdrop-filter:blur の表現は ::before に
         移し、ナビ root とは別レイヤで持つ。これで blur の合成タイミングが
         ずれてもナビの輪郭・geometry は揺れない。
      3. transform:translateZ(0) + backface-visibility:hidden + will-change で
         ナビ自身を恒久的な GPU レイヤに昇格させ、ルート切替で Chrome がレイヤ
         破棄/再生成をしない (= bottom:-3px の sub-pixel が安定する)。
      4. contain:layout style を入れて子要素 (seekbar-track の top:-14px) は
         はみ出させたまま、レイアウト/スタイル計算の波及を局所化する。
  */
  .bottom-nav {
    position: fixed;
    bottom: -3px;
    left: 0;
    right: 0;
    z-index: 200;
    height: var(--bottom-nav-h, 56px);
    display: flex;
    align-items: stretch;
    background: #000;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    padding-bottom: 5px;
    transform: translateZ(0);
    -webkit-transform: translateZ(0);
    backface-visibility: hidden;
    -webkit-backface-visibility: hidden;
    will-change: transform;
    contain: layout style;
  }

  /*
    半透明 + backdrop-filter:blur の見た目は ::before で再現する。
    - ナビ root とは別レイヤなので、Chrome がこの blur レイヤの合成準備に
      手間取っても、ナビの輪郭/位置/不透明背景はそのまま見え続ける。
    - 下の <video> が見えるための半透明感はフィード視聴中の質感として残す。
    - 遷移オーバーレイ表示中 (html[data-nav-loading="1"]) はこの ::before を
      非表示にして、ナビが「完全に solid #000」になり、オーバーレイの黒と
      色味がぴったり同期する。
  */
  .bottom-nav::before {
    content: '';
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.92);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    pointer-events: none;
    z-index: 0;
  }
  .bottom-nav > .bottom-nav-item {
    position: relative;
    z-index: 1;
  }

  /*
    遷移オーバーレイ表示中はナビを「視覚的に凍結」する。
    - ::before の半透明 + blur レイヤを消すことで、ナビ越しに見えていた
      <video> がオーバーレイで黒に置き換わるタイミングと、ナビ背景が
      solid #000 に切り替わるタイミングをぴたっと同期させる。
    - シークバー (top:-14px でナビの外に飛び出して描画される 3px の白いレール) は、
      /feed 表示中はずっと出ている要素。タップ直後にこれを display:none で消すと、
      その瞬間ナビの「視覚的な高さ」が 14px だけ縮んで見え、ユーザーには
      「ナビが一瞬チラついた」と知覚される (= 旧 #248 で混入した症状)。
      遷移オーバーレイ中もシークバーは見た目を保ったまま残し、stopFeedPlaybackImmediately
      で video を止めて video-progress が来なくなることで自動的に値が凍結される。
      タップ吸い込みだけ pointer-events:none で殺して連打誤動作だけ防ぐ。
    高さや bottom 位置自体は変えないので、bfcache 復帰時のレイアウトも壊れない。
  */
  html[data-nav-loading="1"] .bottom-nav::before {
    display: none;
  }
  html[data-nav-loading="1"] .seekbar-track,
  html[data-nav-loading="1"] .seekbar-track.seekbar-track--active {
    pointer-events: none;
  }

  /*
    seekbar-track は全ルートで常にレンダーする (フックの hooks 依存ではなく、
    isHidden=false の全ナビ表示ルートで DOM 上に存在する)。
    これによりナビの上端から 14px 上に伸びる「視覚的フットプリント」が
    home / mypage / feed のいずれでも同一になり、ルート切替でナビの「高さ」が
    変動して見える錯覚を完全に消す。
    非アクティブ時:
      - 自身は opacity:0 (見えない)
      - ::before / fill / thumb は描画されない (CSS 側で seekbar-track--active が
        付いたときだけ描画)
      - pointer-events:none で touch hit も発生しない
    アクティブ時 (= /feed にいて video-progress が一度でも来た):
      - opacity:1 (フェード in)
      - レール、fill、thumb が出現
      - 操作可能
    /feed 初回ペイントでは hasProgress=false なので何も描画されない。動画再生
    開始 (= 最初の video-progress) で初めてレールが出現するため、ユーザーには
    「動画と一緒に再生 UI が現れた」と感じられ、ナビ高さのポップとして
    知覚されない。
  */
  .seekbar-track {
    position: absolute;
    top: -14px;
    left: 0;
    right: 0;
    height: 20px;
    -webkit-tap-highlight-color: transparent;
    touch-action: none;
    user-select: none;
    z-index: 10;
    display: flex;
    align-items: center;
    opacity: 0;
    pointer-events: none;
    cursor: default;
    transition: opacity 220ms ease;
  }
  .seekbar-track.seekbar-track--active {
    opacity: 1;
    pointer-events: auto;
    cursor: pointer;
  }
  @media (prefers-reduced-motion: reduce) {
    .seekbar-track { transition: none; }
  }

  /* レール (::before) / fill / thumb は --active のときだけ描画する。
     非フィードルートで余計な視覚要素が漏れて出ないようにする防衛線。 */
  .seekbar-track.seekbar-track--active::before {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 50%;
    transform: translateY(-50%);
    height: 3px;
    background: rgba(255, 255, 255, 0.2);
    border-radius: 999px;
  }

  .seekbar-fill {
    display: none;
    position: absolute;
    left: 0;
    top: 50%;
    transform: translateY(-50%);
    height: 3px;
    background: #fff;
    border-radius: 999px;
    pointer-events: none;
    transition: width 0.1s linear;
  }
  .seekbar-track.seekbar-track--active .seekbar-fill {
    display: block;
  }

  .seekbar-thumb {
    display: none;
    position: absolute;
    top: 50%;
    transform: translate(-50%, -50%) scale(0);
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #fff;
    pointer-events: none;
    transition: transform 0.15s ease, left 0.1s linear;
    box-shadow: 0 1px 4px rgba(0,0,0,0.5);
  }
  .seekbar-track.seekbar-track--active .seekbar-thumb {
    display: block;
  }

  .seekbar-track.seekbar-track--active:hover .seekbar-fill,
  .seekbar-track.seekbar-track--active:active .seekbar-fill {
    height: 5px;
  }
  .seekbar-track.seekbar-track--active:hover .seekbar-thumb,
  .seekbar-track.seekbar-track--active:active .seekbar-thumb {
    transform: translate(-50%, -50%) scale(1);
  }
  .seekbar-track.seekbar-track--active:hover::before,
  .seekbar-track.seekbar-track--active:active::before {
    height: 5px;
  }

  .bottom-nav-item {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    text-decoration: none;
    color: rgba(255, 255, 255, 0.45);
    -webkit-tap-highlight-color: transparent;
    transition: color 0.15s ease;
    padding-bottom: 2px;
    cursor: pointer;
  }

  .bottom-nav-item--active {
    color: #fff;
    cursor: default;
  }

  .bottom-nav-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
  }

  .bottom-nav-label {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.02em;
    white-space: nowrap;
  }
`;
