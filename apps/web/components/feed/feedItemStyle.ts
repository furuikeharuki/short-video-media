export const itemStyle = `
  .video-bg {
    position: absolute;
    inset: 0;
    overflow: hidden;
    background: #000;
    /* 長押しメニューをコンテナごと拒否 */
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
  }
  .feed-video {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    object-position: center center;
    border-radius: 8px;
    box-sizing: border-box;
    /* iOS/Android の長押しメニュー（保存・コピー・共有）を完全に抑止 */
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
    pointer-events: none;
  }
  /* サムネイル (非アクティブスライド または動画ロード中) は
     動画と同じサイズ・アスペクトで画面内に収まるよう contain させる。 */
  .thumbnail-bg {
    position: absolute;
    inset: 0;
    overflow: hidden;
    background: #000;
    /* 長押しメニューをコンテナごと拒否 */
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
  }
  .thumbnail-img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    object-position: center center;
    border-radius: 8px;
    box-sizing: border-box;
    display: block;
    /* サムネイル画像の長押し保存・ドラッグを抑止 */
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
    -webkit-user-drag: none;
    pointer-events: none;
  }
  .overlay-wrap {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 25;
    border-radius: 8px;
    overflow: hidden;
  }
  .shimmer {
    position: absolute;
    inset: 0;
    background: #000;
    z-index: 1;
    overflow: hidden;
    border-radius: 8px;
  }
  /* ロード中の背景サムネイル: 動画 (.feed-video) と完全に同じレイアウトで重ねる */
  .shimmer-thumb {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    object-position: center center;
    border-radius: 8px;
    box-sizing: border-box;
    display: block;
    /* 長押し保存・ドラッグを抑止 */
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
    -webkit-user-drag: none;
    pointer-events: none;
  }
  /* サムネイル上で中央をクルクル回るスピナー */
  .shimmer-spinner {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 48px;
    height: 48px;
    margin: -24px 0 0 -24px;
    border: 4px solid rgba(255, 255, 255, 0.25);
    border-top-color: #fff;
    border-radius: 50%;
    animation: shimmer-spin 0.9s linear infinite;
    pointer-events: none;
    z-index: 2;
  }
  @keyframes shimmer-spin {
    0%   { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }
  .video-bg--interactive {
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    tap-highlight-color: transparent;
    -webkit-touch-callout: none;
    user-select: none;
    touch-action: none;
  }
  .action-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    animation: overlay-pop 0.65s ease-out forwards;
  }
  .action-icon {
    align-items: center;
    justify-content: center;
    filter: drop-shadow(0 2px 8px rgba(0,0,0,0.7));
  }
  .action-overlay[data-type="pause"] .action-icon--pause { display: flex !important; }
  .action-overlay[data-type="play"]  .action-icon--play  { display: flex !important; }
  @keyframes overlay-pop {
    0%   { opacity: 1; transform: scale(0.7); }
    30%  { opacity: 1; transform: scale(1.1); }
    70%  { opacity: 0.8; transform: scale(1); }
    100% { opacity: 0; transform: scale(1); }
  }
  .fast-badge {
    position: absolute;
    top: 12px;
    right: 12px;
    background: rgba(255,255,255,0.18);
    color: #fff;
    font-size: 13px;
    font-weight: 800;
    letter-spacing: 0.05em;
    padding: 3px 10px;
    border-radius: 999px;
    pointer-events: none;
    z-index: 20;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    text-shadow: 0 1px 4px rgba(0,0,0,0.5);
  }
  .bottom-bar {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: end;
    z-index: 30;
    padding: 0 4px 15px 12px;
    box-sizing: border-box;
    pointer-events: none;
    background: linear-gradient(to top, rgba(0,0,0,0.7) 0%, transparent 100%);
  }
  .info-overlay {
    min-width: 0;
    overflow: hidden;
    pointer-events: auto;
    padding-right: 0;
  }
  .item-title {
    font-size: clamp(13px, 3.5vw, 16px);
    font-weight: 700;
    line-height: 1.35;
    color: #fff;
    text-shadow: 0 1px 6px rgba(0,0,0,0.8);
    margin: 0 0 4px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-all;
  }
  .item-actress {
    font-size: clamp(11px, 2.8vw, 13px);
    color: rgba(255,255,255,0.75);
    text-shadow: 0 1px 4px rgba(0,0,0,0.7);
    margin: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .genre-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 6px;
  }
  .genre-chip {
    padding: 3px 10px;
    border-radius: 999px;
    border: 1px solid rgba(255,255,255,0.35);
    background: rgba(255,255,255,0.12);
    color: rgba(255,255,255,0.9);
    font-size: clamp(10px, 2.5vw, 12px);
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    -webkit-tap-highlight-color: transparent;
    line-height: 1.5;
    transition: background 0.15s;
  }
  .genre-chip:active { background: rgba(255,255,255,0.25); }
  .side-actions {
    width: 60px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: clamp(8px, 1.4vh, 16px);
    pointer-events: auto;
    flex-shrink: 0;
  }
  .side-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    background: none;
    border: none;
    cursor: pointer;
    padding: 3px 0;
    width: 100%;
    -webkit-tap-highlight-color: transparent;
    touch-action: none;
    text-decoration: none;
    filter: drop-shadow(0 1px 4px rgba(0,0,0,0.8));
    transition: transform 0.1s ease, opacity 0.1s ease;
  }
  .side-btn:active { transform: scale(0.88); opacity: 0.7; }
  .side-btn--active svg { filter: drop-shadow(0 0 6px rgba(255,255,255,0.8)); }
  .side-btn--buy svg { stroke: #ff4d7d; }
  .side-btn-label {
    color: #fff;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-shadow: 0 1px 3px rgba(0,0,0,0.9);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }
  .skip-ripple {
    position: absolute;
    transform: translate(-50%, -50%);
    z-index: 20;
    pointer-events: none;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 90px;
    height: 90px;
    border-radius: 50%;
    background: rgba(255,255,255,0.2);
    backdrop-filter: blur(6px);
    animation: ripple-pop 0.65s ease-out forwards;
  }
  .skip-icon {
    color: #fff;
    font-size: 14px;
    font-weight: 700;
    letter-spacing: 0.02em;
    text-shadow: 0 1px 4px rgba(0,0,0,0.6);
    white-space: nowrap;
  }
  @keyframes ripple-pop {
    0%   { opacity: 1; transform: translate(-50%, -50%) scale(0.6); }
    40%  { opacity: 1; transform: translate(-50%, -50%) scale(1.1); }
    100% { opacity: 0; transform: translate(-50%, -50%) scale(1.35); }
  }
  @media (prefers-reduced-motion: reduce) {
    .shimmer-spinner { animation: none; }
    .skip-ripple     { animation: none; opacity: 0; }
    .action-overlay  { animation: none; opacity: 0; }
  }
  @media (max-width: 767px) {
    .feed-video,
    .thumbnail-img,
    .shimmer-thumb {
      padding-bottom: 60px;
    }
    .overlay-wrap {
      bottom: 60px;
    }
  }
  @media (min-width: 768px) {
    .bottom-bar {
      padding: 0 8px 20px 20px;
    }
    .side-actions {
      width: 68px;
      gap: 14px;
    }
    .side-btn svg { width: 28px; height: 28px; }
    .item-title   { font-size: 17px; }
    .item-actress { font-size: 14px; }
  }
`;
