import FeedClient from "@/app/FeedClient";

export default function HomePage() {
  return (
    <>
      <FeedClient />
      <style>{feedStyle}</style>
    </>
  );
}

const feedStyle = `
  html { background: #000; }
  body { background: #000; overflow: hidden; height: 100dvh; }

  .feed-container {
    position: fixed;
    top: var(--header-h, 52px);
    left: 0; right: 0;
    bottom: var(--bottom-nav-h, 56px);
    overflow: hidden;
  }

  .feed-slide {
    position: absolute;
    inset: 0;
    will-change: transform;
  }

  .feed-item {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: #000;
  }

  .video-bg { position: absolute; inset: 0; }
  .thumbnail-bg { position: absolute; inset: 0; }
  .thumbnail-img { width: 100%; height: 100%; object-fit: cover; display: block; }
`;
