export default function Loading() {
  return (
    <main style={styles.main}>
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} style={styles.item}>
          <div style={styles.thumb} />
          <div style={styles.overlay}>
            <div style={{ ...styles.bar, width: '60px', height: '20px', marginBottom: '10px', borderRadius: '999px' }} />
            <div style={{ ...styles.bar, width: '75%', height: '22px', marginBottom: '8px' }} />
            <div style={{ ...styles.bar, width: '45%', height: '16px', marginBottom: '20px', opacity: 0.5 }} />
            <div style={styles.buttons}>
              <div style={{ ...styles.bar, flex: 1, height: '44px', borderRadius: '10px' }} />
              <div style={{ ...styles.bar, flex: 1, height: '44px', borderRadius: '10px' }} />
            </div>
          </div>
        </div>
      ))}
      <style>{shimmerCSS}</style>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    height: '100dvh',
    overflowY: 'hidden',
    background: '#000',
    scrollbarWidth: 'none',
  },
  item: {
    position: 'relative',
    width: '100%',
    height: '100dvh',
    background: '#111',
    overflow: 'hidden',
  },
  thumb: {
    position: 'absolute',
    inset: 0,
    background: '#1a1a1a',
    animation: 'shimmer 1.5s ease-in-out infinite',
  },
  overlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: '0 16px 32px',
    background: 'linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.9) 60%)',
  },
  bar: {
    background: 'rgba(255,255,255,0.1)',
    borderRadius: '6px',
    animation: 'shimmer 1.5s ease-in-out infinite',
  },
  buttons: {
    display: 'flex',
    gap: '10px',
  },
};

const shimmerCSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: #000 !important; overflow: hidden !important; }

  @keyframes shimmer {
    0%   { opacity: 0.4; }
    50%  { opacity: 0.8; }
    100% { opacity: 0.4; }
  }
  @media (prefers-reduced-motion: reduce) {
    * { animation: none !important; }
  }
`;
