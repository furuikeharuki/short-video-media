import { getFeed } from "@/lib/api/feed";
import FeedItem from "@/components/FeedItem";

export default async function HomePage() {
  const feed = await getFeed();

  if (feed.items.length === 0) {
    return (
      <main className="empty-state">
        <div className="empty-inner">
          <p className="empty-icon">🎦</p>
          <h2>まだ作品がありません</h2>
          <p>しばらくしてから再度ご確認ください。</p>
        </div>
      </main>
    );
  }

  return (
    <main className="feed-container">
      {feed.items.map((item, index) => (
        <FeedItem
          key={item.id}
          item={item}
          isFirst={index === 0}
          isSecond={index === 1}
        />
      ))}
    </main>
  );
}
