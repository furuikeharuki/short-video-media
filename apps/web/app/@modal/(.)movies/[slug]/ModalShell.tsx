"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import type { CSSProperties, ReactNode } from "react";

export default function ModalShell({ children }: { children: ReactNode }) {
  const router = useRouter();

  // フィードの動画を一時停止
  useEffect(() => {
    const videos = Array.from(
      document.querySelectorAll<HTMLVideoElement>(".feed-item video")
    );
    const wasPlaying = videos.map((v) => !v.paused);
    videos.forEach((v) => v.pause());
    return () => {
      videos.forEach((v, i) => {
        if (wasPlaying[i]) v.play().catch(() => {});
      });
    };
  }, []);

  // bodyスクロールロック
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Escapeで閉じる
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") router.back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  return (
    <>
      {/* バックドロップ: クリックで閉じる */}
      <div aria-hidden="true" onClick={() => router.back()} style={backdropStyle} />

      {/* モーダルシェル: データを待たず即時出現 */}
      <div role="dialog" aria-modal="true" style={modalStyle}>
        <div style={scrollStyle}>
          {children}
        </div>
      </div>

      <style>{animCSS}</style>
    </>
  );
}

const backdropStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.6)",
  zIndex: 100,
  cursor: "pointer",
};

const modalStyle: CSSProperties = {
  position: "fixed",
  top: "52px",
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: 101,
  background: "#0a0a0a",
  color: "#fff",
  display: "flex",
  flexDirection: "column",
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  animation: "modal-slide-up 0.25s cubic-bezier(0.4,0,0.2,1) both",
};

const scrollStyle: CSSProperties = {
  flex: 1,
  overflowY: "auto",
  WebkitOverflowScrolling: "touch" as never,
};

const animCSS = `
  @keyframes modal-slide-up {
    from { transform: translateY(60px); opacity: 0; }
    to   { transform: translateY(0);    opacity: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    * { animation-duration: 0.01ms !important; }
  }
`;
