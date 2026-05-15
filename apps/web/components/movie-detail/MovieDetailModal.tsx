"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import type { MovieDetail } from "@/lib/api/movies";
import MovieDetailContent from "./MovieDetailContent";
import DetailViewTracker from "@/components/analytics/detail-view-tracker";

interface Props {
  slug: string;
  onClose: () => void;
}

type State = "idle" | "loading" | "ready" | "error";

export default function MovieDetailModal({ slug, onClose }: Props) {
  const [movie, setMovie] = useState<MovieDetail | null>(null);
  const [state, setState] = useState<State>("loading");
  const [visible, setVisible] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const startYRef = useRef(0);
  const currentYRef = useRef(0);
  const isDraggingRef = useRef(false);

  // マウント後アニメ開始
  useEffect(() => {
    const t = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(t);
  }, []);

  // データ取得
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

  // Esc キーで閉じる
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") handleClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // history pushState（URLをslugに変える）
  useEffect(() => {
    const prev = window.location.pathname + window.location.search;
    window.history.pushState({ modalSlug: slug }, "", `/movies/${slug}`);
    const onPop = () => handleClose();
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.history.replaceState(null, "", prev);
    };
  }, [slug]);

  // body scroll lock
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  const handleClose = useCallback(() => {
    setVisible(false);
    setTimeout(onClose, 300);
  }, [onClose]);

  // ドラッグ（下スワイプで閉じる）
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    startYRef.current = e.touches[0].clientY;
    isDraggingRef.current = true;
  }, []);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
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
      sheetRef.current.style.transform = "";
    }
    if (dy > 100) handleClose();
    currentYRef.current = 0;
  }, [handleClose]);

  return (
    <>
      {/* Backdrop */}
      <div
        className={`mdm-backdrop ${visible ? "mdm-backdrop--visible" : ""}`}
        onClick={handleClose}
        aria-hidden="true"
      />

      {/* Sheet */}
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
        {/* ドラッグハンドル */}
        <div className="mdm-handle-wrap">
          <div className="mdm-handle" />
        </div>

        {/* 閉じるボタン */}
        <button
          className="mdm-close"
          onClick={handleClose}
          aria-label="閉じる"
        >
          ✕
        </button>

        <div className="mdm-scroll">
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
              <MovieDetailContent movie={movie} />
            </>
          )}
        </div>
      </div>

      <style>{`
        .mdm-backdrop {
          position: fixed; inset: 0; z-index: 900;
          background: rgba(0,0,0,0);
          transition: background 0.3s ease;
        }
        .mdm-backdrop--visible { background: rgba(0,0,0,0.6); }

        .mdm-sheet {
          position: fixed;
          left: 0; right: 0; bottom: 0;
          z-index: 901;
          height: 92dvh;
          background: #0a0a0a;
          border-radius: 16px 16px 0 0;
          display: flex;
          flex-direction: column;
          transform: translateY(100%);
          transition: transform 0.35s cubic-bezier(0.32, 0.72, 0, 1);
          will-change: transform;
          touch-action: pan-y;
          overscroll-behavior: contain;
        }
        .mdm-sheet--visible { transform: translateY(0); }

        .mdm-handle-wrap {
          display: flex; align-items: center; justify-content: center;
          padding: 10px 0 4px;
          flex-shrink: 0;
          cursor: grab;
        }
        .mdm-handle {
          width: 36px; height: 4px;
          background: rgba(255,255,255,0.25);
          border-radius: 999px;
        }

        .mdm-close {
          position: absolute; top: 10px; right: 14px;
          background: rgba(255,255,255,0.1);
          border: none; color: #fff; font-size: 14px;
          width: 30px; height: 30px; border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          cursor: pointer; z-index: 10;
          transition: background 0.15s;
        }
        .mdm-close:hover { background: rgba(255,255,255,0.2); }

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
      `}</style>
    </>
  );
}
