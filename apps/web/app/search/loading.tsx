export default function SearchLoading() {
  const skeletons = Array.from({ length: 18 });

  return (
    <main style={mainStyle}>
      <div style={metaStyle} />
      <div className="search-grid">
        {skeletons.map((_, i) => (
          <div key={i} className="skeleton-card">
            <div className="skeleton-inner" />
          </div>
        ))}
      </div>
      <style>{css}</style>
    </main>
  );
}

const mainStyle: React.CSSProperties = {
  position: "fixed",
  top: "52px",
  left: 0,
  right: 0,
  bottom: 0,
  overflowY: "auto",
  background: "#0a0a0a",
};

const metaStyle: React.CSSProperties = {
  height: "36px",
};

const css = `
  .search-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 2px;
    padding: 2px;
  }
  @media (min-width: 640px)  { .search-grid { grid-template-columns: repeat(5, 1fr); } }
  @media (min-width: 1024px) {
    .search-grid {
      grid-template-columns: repeat(7, 1fr);
      max-width: 1200px;
      margin: 0 auto;
    }
  }
  .skeleton-card {
    position: relative;
    aspect-ratio: 9 / 16;
    background: #1a1a1a;
    overflow: hidden;
  }
  .skeleton-inner {
    position: absolute;
    inset: 0;
    background: linear-gradient(
      105deg,
      transparent 40%,
      rgba(255,255,255,0.07) 50%,
      transparent 60%
    );
    background-size: 200% 100%;
    animation: shimmer 1.4s ease-in-out infinite;
  }
  @keyframes shimmer {
    0%   { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
`;
