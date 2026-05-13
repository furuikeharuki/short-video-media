export default function ModalLoading() {
  return (
    <>
      {/* backdrop */}
      <div aria-hidden="true" style={backdropStyle} />

      {/* modal shell */}
      <div role="dialog" aria-modal="true" aria-label="読み込み中" style={modalStyle}>
        <div style={scrollStyle}>

          {/* hero skeleton */}
          <div style={heroWrapStyle}>
            <div style={heroBgSkeletonStyle} />
            <div style={heroImgSkeletonStyle} />

            {/* back button placeholder */}
            <div style={backBtnSkeletonStyle} />
          </div>

          {/* content skeleton */}
          <div style={contentStyle}>
            {/* genre badges */}
            <div style={rowStyle}>
              <div style={badgeSkelStyle} />
              <div style={{ ...badgeSkelStyle, width: 56 }} />
              <div style={{ ...badgeSkelStyle, width: 72 }} />
            </div>

            {/* title */}
            <div style={{ ...barStyle, width: "90%", height: 26, marginBottom: 8 }} />
            <div style={{ ...barStyle, width: "65%", height: 26, marginBottom: 20 }} />

            {/* score / price */}
            <div style={rowStyle}>
              <div style={{ ...barStyle, width: 100, height: 16 }} />
              <div style={{ ...barStyle, width: 60, height: 18, marginLeft: 16 }} />
            </div>

            {/* meta rows */}
            <div style={metaBlockStyle}>
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} style={metaRowStyle}>
                  <div style={{ ...barStyle, width: 56, height: 13, flexShrink: 0 }} />
                  <div style={{ ...barStyle, width: `${50 + (i % 3) * 20}%`, height: 13 }} />
                </div>
              ))}
            </div>

            {/* description lines */}
            <div style={{ ...barStyle, width: "100%", height: 13, marginBottom: 8 }} />
            <div style={{ ...barStyle, width: "85%",  height: 13, marginBottom: 8 }} />
            <div style={{ ...barStyle, width: "70%",  height: 13, marginBottom: 28 }} />

            {/* CTA button */}
            <div style={ctaSkelStyle} />
          </div>
        </div>
      </div>

      <style>{shimmerCSS}</style>
    </>
  );
}

/* ── styles ── */
import type { CSSProperties } from "react";

const backdropStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.6)",
  zIndex: 100,
};

const modalStyle: CSSProperties = {
  position: "fixed",
  top: "52px",
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: 101,
  background: "#0a0a0a",
  display: "flex",
  flexDirection: "column",
  animation: "modal-slide-up 0.28s cubic-bezier(0.4,0,0.2,1) both",
};

const scrollStyle: CSSProperties = {
  flex: 1,
  overflowY: "auto",
};

const heroWrapStyle: CSSProperties = {
  position: "relative",
  width: "100%",
  height: "55svh",
  overflow: "hidden",
  background: "#111",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};

const heroBgSkeletonStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  background: "#1c1c1c",
};

const heroImgSkeletonStyle: CSSProperties = {
  position: "relative",
  zIndex: 1,
  width: "auto",
  height: "85%",
  maxWidth: "calc(100% - 60px)",
  aspectRatio: "9/16",
  borderRadius: 8,
  background: "#2a2a2a",
  animation: "shimmer 1.4s ease-in-out infinite",
};

const backBtnSkeletonStyle: CSSProperties = {
  position: "absolute",
  top: 16,
  left: 16,
  zIndex: 2,
  width: 40,
  height: 40,
  borderRadius: "50%",
  background: "rgba(255,255,255,0.08)",
};

const contentStyle: CSSProperties = {
  padding: "20px 16px 48px",
  width: "100%",
  boxSizing: "border-box",
};

const rowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
  marginBottom: 14,
  alignItems: "center",
};

const barStyle: CSSProperties = {
  borderRadius: 6,
  background: "#2a2a2a",
  animation: "shimmer 1.4s ease-in-out infinite",
};

const badgeSkelStyle: CSSProperties = {
  width: 44,
  height: 22,
  borderRadius: 999,
  background: "#2a2a2a",
  animation: "shimmer 1.4s ease-in-out infinite",
};

const metaBlockStyle: CSSProperties = {
  borderTop: "1px solid rgba(255,255,255,0.08)",
  marginBottom: 24,
};

const metaRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 0",
  borderBottom: "1px solid rgba(255,255,255,0.06)",
};

const ctaSkelStyle: CSSProperties = {
  width: "100%",
  height: 52,
  borderRadius: 12,
  background: "rgba(233,30,99,0.25)",
  animation: "shimmer 1.4s ease-in-out infinite",
};

const shimmerCSS = `
  @keyframes modal-slide-up {
    from { transform: translateY(100%); opacity: 0.6; }
    to   { transform: translateY(0);    opacity: 1; }
  }
  @keyframes shimmer {
    0%   { opacity: 1; }
    50%  { opacity: 0.45; }
    100% { opacity: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    * { animation-duration: 0.01ms !important; }
  }
`;
