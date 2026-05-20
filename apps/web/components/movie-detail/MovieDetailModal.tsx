"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { createPortal } from "react-dom";
import type { MovieDetail } from "@/lib/api/movies";
import MovieDetailContent from "./MovieDetailContent";
import DetailViewTracker from "@/components/analytics/detail-view-tracker";
import AdSlot from "@/components/ads/AdSlot";

interface Props {
  slug: string;
  onClose: () => void;
}

type State = "idle" | "loading" | "ready" | "error";

export default function MovieDetailModal({ slug, onClose }: Props) {
  const [movie, setMovie] = useState<MovieDetail | null>(null);
  const [state, setState] = useState<State>("loading");
  const [visible, setVisible] = useState(false);
  const [mounted, setMounted] = useState(false);
  const sheetRef    = useRef<HTMLDivElement>(null);
  const scrollRef   = useRef<HTMLDivElement>(null);
  const startYRef   = useRef(0);
  const currentYRef = useRef(0);
  const isDraggingRef = useRef(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    window.dispatchEvent(new Event("modal-open"));
    const t = requestAnimationFrame(() => setVisible(true));
    return () => {
      cancelAnimationFrame(t);
      window.dispatchEvent(new Event("modal-close"));
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    const base =
      process.env.NEXT_PUBLIC_API_BASE_URL ||
      (typeof window !== "undefined" ? window.location.origin : "");
    fetch(`${base}/api/v1/movies/${slug}`)
      .then((r) => {
        if (!r.ok) throw new Error("fetch error");
        return r.json() as Promise<MovieDetail>;
      })
      .then((data) => {
        if (!cancelled) { setMovie(data); setState("ready"); }
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => { cancelled = true; };
  }, [slug]);

  // 依存配列なしの useEffect は毎レンダー再実行されてイベントリスナの登録/解除を繰り返す。
  // ここでは Escape 押下時に handleClose を呼びたいだけなので、ref 経由で最新の handleClose
  // を参照し、リスナはマウント中 1 回だけ登録する。
  const handleCloseRef = useRef<() => void>(() => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") handleCloseRef.current(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const prev = window.location.pathname + window.location.search;
    window.history.pushState({ modalSlug: slug }, "", `/movies/${slug}`);
    const onPop = () => handleClose();
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      // cleanup で URL を元に戻すのは「ユーザーがモーダルを閉じてフィードに戻る」
      // ケースだけに限る。
      //
      // モーダル中の <Link> や router.push で他ページ (/search?maker=X 等) に
      // 遷移したときは、URL バーは既に /search に変わっている。
      // そこで replaceState(null, "", prev) で /feed... に巻き戻してしまうと、
      // Next.js の内部 path と URL バーが完全に乖離し、ブラウザ back を押した
      // ときに画面が真っ暗になる不具合を起こす。
      // pathname がまだ /movies/<slug> のときは「フィードに戻る」経路なので replaceState、
      // それ以外は URL をそのまま保ち、back で /movies/<slug> に戻れるようにする。
      try {
        if (window.location.pathname === `/movies/${slug}`) {
          window.history.replaceState(null, "", prev);
        }
      } catch {
        // history API が使えない環境は無視
      }
    };
  }, [slug]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  const handleClose = useCallback(() => {
    setVisible(false);
    setTimeout(onClose, 300);
  }, [onClose]);

  // keydown / popstate ハンドラから常に最新の handleClose を呼べるように ref を同期する。
  useEffect(() => {
    handleCloseRef.current = handleClose;
  }, [handleClose]);

  const onTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    const scroll = scrollRef.current;
    if (scroll && scroll.contains(e.target as Node)) {
      if (scroll.scrollTop === 0) {
        startYRef.current = e.touches[0].clientY;
        isDraggingRef.current = true;
      } else {
        isDraggingRef.current = false;
      }
    } else {
      startYRef.current = e.touches[0].clientY;
      isDraggingRef.current = true;
    }
    currentYRef.current = 0;
  }, []);

  const onTouchMove = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return;
    const dy = e.touches[0].clientY - startYRef.current;
    currentYRef.current = dy;
    if (dy > 0 && sheetRef.current) {
      sheetRef.current.style.transform = `translateY(${dy}px)`;
      sheetRef.current.style.transition = "none";
    }
  }, []);

  const onTouchEnd = useCallback(() => {
    isDraggingRef.current = false;
    const dy = currentYRef.current;
    if (sheetRef.current) {
      sheetRef.current.style.transition = "";
      sheetRef.current.style.transform  = "";
    }
    if (dy > 100) handleClose();
    currentYRef.current = 0;
  }, [handleClose]);

  // Portal で document.body 直下にレンダー。
  // 祖先要素 (.feed-slide など) に transform が掛かっていると、
  // position: fixed の包含ブロックがビューポートではなくその祖先になり、
  // ヘッダー直下にピッタリ寄らない問題が起きるため Portal で回避する。
  if (!mounted) return null;

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        className={`mdm-backdrop ${visible ? "mdm-backdrop--visible" : ""}`}
        onClick={handleClose}
        aria-hidden="true"
      />

      {/* Sheet: ヘッダー直下から下端まで、角丸なし・隙間なし */}
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="作品詳細"
        className={`mdm-sheet ${visible ? "mdm-sheet--visible" : ""}`}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <button
          className="mdm-back"
          onClick={handleClose}
          aria-label="フィードに戻る"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 5l-7 7 7 7" />
          </svg>
        </button>

        <div ref={scrollRef} className="mdm-scroll">
          {state === "loading" && (
            <div className="mdm-loading">
              <div className="mdm-spinner" />
            </div>
          )}
          {state === "error" && (
            <div className="mdm-error">読み込みに失敗しました</div>
          )}
          {state === "ready" && movie && (
            <>
              <DetailViewTracker slug={movie.slug} title={movie.title} />
              {/*
                フィード上で開かれる portal モーダル経路。背後のフィード DOM に
                FeedAdSlide の <ins> (同一 zoneid) が残っているため、AdSlot を
                priority モードで動かして provider がモーダル <ins> を確実に
                埋めるようにする。 AdSlot 自体は state に依存せずモーダルマウント
                直後にこの下で常に描画される (詳細 fetch が遅延・失敗しても
                provider への push が空振りしないようにするため)。
              */}
              <MovieDetailContent movie={movie} adPriority hideAd />
            </>
          )}

          {/*
            広告 <ins> はモーダルが開いた瞬間に常にマウントする。
            これにより MovieDetail の fetch が遅延 / 失敗しても、provider への
            最初の push 時点で <ins data-zoneid=5929910> が DOM に存在し、
            「ホーム側 5929930 だけが Request にバッチされ、5929910 が一度も
            push されない」という症状を防ぐ。

            さらに `key={slug}` で modal を開くごとに AdSlot を完全に remount する。
            provider 内部に前回 modal の `<ins>` 参照が残っていたり、serve 済み
            フラグが立っていても、新しい React tree + 新しい DOM ノードで毎回
            やり直しになるため、「初回モーダルは出るが 2 回目以降は出ない」
            (provider が 2 回目の `<ins>` に iframe を入れていても背後の古い
             ノードに入っていた等の) ケースを抑止する。

            視覚的位置は MovieDetailContent と同様にコンテンツ末尾 (CTA の前)
            を狙うが、ロード中でも幅 100% のスロットとして mdm-scroll の末尾に
            描画される。
          */}
          <div className="mdm-ad-bottom">
            <AdSlot
              key={`modal-ad-${slug}`}
              zone="mobileBanner300x250"
              context="modal"
              priority
            />
          </div>
        </div>
      </div>

      <style>{`
        .mdm-backdrop {
          position: fixed;
          inset: 0;
          z-index: 500;
          background: rgba(0,0,0,0);
          transition: background 0.3s ease;
          pointer-events: none;
        }
        .mdm-backdrop--visible {
          background: rgba(0,0,0,0.5);
          pointer-events: auto;
        }

        .mdm-sheet {
          position: fixed;
          /* ヘッダー直下にぴったり密着。角丸なし。 */
          top: var(--header-h, 52px);
          left: 0;
          right: 0;
          bottom: 0;
          z-index: 501;
          background: #0a0a0a;
          border-radius: 0;
          display: flex;
          flex-direction: column;
          transform: translateY(100%);
          transition: transform 0.35s cubic-bezier(0.32, 0.72, 0, 1);
          will-change: transform;
          overscroll-behavior: contain;
        }
        .mdm-sheet--visible { transform: translateY(0); }

        .mdm-back {
          position: absolute;
          top: 16px;
          left: 16px;
          z-index: 10;
          display: flex;
          align-items: center;
          justify-content: center;
          width: 40px;
          height: 40px;
          border-radius: 50%;
          background: rgba(0,0,0,0.5);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          color: #fff;
          border: 1px solid rgba(255,255,255,0.15);
          cursor: pointer;
          transition: background 0.15s;
        }
        .mdm-back:hover { background: rgba(0,0,0,0.7); }

        .mdm-scroll {
          flex: 1;
          overflow-y: auto;
          -webkit-overflow-scrolling: touch;
          overscroll-behavior: contain;
        }

        .mdm-loading {
          display: flex; align-items: center; justify-content: center;
          height: 200px;
        }
        .mdm-spinner {
          width: 32px; height: 32px;
          border: 3px solid rgba(255,255,255,0.15);
          border-top-color: #fff;
          border-radius: 50%;
          animation: mdm-spin 0.7s linear infinite;
        }
        @keyframes mdm-spin { to { transform: rotate(360deg); } }

        .mdm-error {
          display: flex; align-items: center; justify-content: center;
          height: 200px; color: rgba(255,255,255,0.5); font-size: 14px;
        }

        /* モーダル末尾の広告スロット位置。MovieDetailContent の .mdc-ad-bottom と
           同等のレイアウト (中央寄せ・上マージン) を維持する。
           detail fetch が ready になる前から DOM 上に <ins> を置いておくための
           「常駐」スロットなので、ロード中はスクロール末尾の余白として見える。 */
        .mdm-ad-bottom {
          width: 100%;
          display: flex;
          justify-content: center;
          margin-top: 24px;
          margin-bottom: 24px;
          padding: 0 16px;
          box-sizing: border-box;
        }
      `}</style>
    </>,
    document.body
  );
}
