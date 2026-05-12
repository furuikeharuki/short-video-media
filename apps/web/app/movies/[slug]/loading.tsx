export default function MovieDetailLoading() {
  return (
    <main style={styles.main}>
      {/* サムネイルヘッダースケルトン */}
      <div style={styles.heroWrap}>
        <div style={{ ...styles.skeleton, width: '100%', height: '100%' }} />
        {/* 戻るボタンスケルトン */}
        <div style={styles.backSkele} />
      </div>

      {/* コンテンツスケルトン */}
      <div style={styles.content}>
        {/* ジャンルバッジ */}
        <div style={styles.badgeRow}>
          <div style={{ ...styles.skeleton, width: '60px', height: '22px', borderRadius: '999px' }} />
          <div style={{ ...styles.skeleton, width: '48px', height: '22px', borderRadius: '999px' }} />
        </div>

        {/* タイトル */}
        <div style={{ ...styles.skeleton, width: '85%', height: '28px', marginBottom: '8px' }} />
        <div style={{ ...styles.skeleton, width: '60%', height: '28px', marginBottom: '12px' }} />

        {/* 女優 */}
        <div style={{ ...styles.skeleton, width: '40%', height: '16px', marginBottom: '24px', opacity: 0.5 }} />

        {/* 説明 */}
        <div style={styles.divider} />
        <div style={{ ...styles.skeleton, width: '100%', height: '14px', marginBottom: '8px' }} />
        <div style={{ ...styles.skeleton, width: '95%', height: '14px', marginBottom: '8px' }} />
        <div style={{ ...styles.skeleton, width: '80%', height: '14px', marginBottom: '28px' }} />

        {/* CTAボタン */}
        <div style={{ ...styles.skeleton, width: '100%', height: '52px', borderRadius: '12px' }} />
      </div>

      <style>{shimmerCSS}</style>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    minHeight: '100dvh',
    background: '#0a0a0a',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
  heroWrap: {
    position: 'relative',
    width: '100%',
    aspectRatio: '3 / 4',
    maxHeight: '70dvh',
    overflow: 'hidden',
    background: '#111',
  },
  backSkele: {
    position: 'absolute',
    top: '16px',
    left: '16px',
    width: '40px',
    height: '40px',
    borderRadius: '50%',
    background: 'rgba(255,255,255,0.08)',
    animation: 'shimmer 1.5s ease-in-out infinite',
  },
  content: {
    padding: '24px 20px 48px',
    maxWidth: '640px',
    margin: '0 auto',
  },
  badgeRow: {
    display: 'flex',
    gap: '6px',
    marginBottom: '14px',
  },
  divider: {
    height: '1px',
    background: 'rgba(255,255,255,0.08)',
    marginBottom: '16px',
  },
  skeleton: {
    background: 'rgba(255,255,255,0.08)',
    borderRadius: '6px',
    animation: 'shimmer 1.5s ease-in-out infinite',
    marginBottom: '0',
  },
};

const shimmerCSS = `
  @keyframes shimmer {
    0%   { opacity: 0.4; }
    50%  { opacity: 0.8; }
    100% { opacity: 0.4; }
  }
  @media (prefers-reduced-motion: reduce) {
    * { animation: none !important; }
  }
`;
