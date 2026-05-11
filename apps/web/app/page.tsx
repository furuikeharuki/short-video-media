import Link from "next/link";
import { getFeed } from "@/lib/api/feed";

export default async function HomePage() {
  const feed = await getFeed();

  if (feed.items.length === 0) {
    return (
      <main style={{ padding: "24px", maxWidth: "960px", margin: "0 auto" }}>
        <header style={{ marginBottom: "24px" }}>
          <h1>Feed</h1>
          <p>
            <Link href="/age-gate">年齢確認ページへ</Link>
          </p>
        </header>

        <section
          style={{
            border: "1px solid #ddd",
            borderRadius: "12px",
            padding: "24px",
            textAlign: "center",
          }}
        >
          <h2 style={{ marginTop: 0 }}>まだ作品がありません</h2>
          <p style={{ color: "#666" }}>
            現在表示できる作品がありません。しばらくしてから再度ご確認ください。
          </p>
        </section>
      </main>
    );
  }

  return (
    <main style={{ padding: "24px", maxWidth: "960px", margin: "0 auto" }}>
      <header style={{ marginBottom: "24px" }}>
        <h1>Feed</h1>
        <p>
          <Link href="/age-gate">年齢確認ページへ</Link>
        </p>
      </header>

      <ul
        style={{
          display: "grid",
          gap: "16px",
          padding: 0,
          listStyle: "none",
        }}
      >
        {feed.items.map((item) => (
          <li
            key={item.id}
            style={{
              border: "1px solid #ddd",
              borderRadius: "12px",
              padding: "16px",
              display: "grid",
              gap: "12px",
            }}
          >
            <img
              src={item.thumbnail_url}
              alt={item.title}
              width={360}
              height={640}
              style={{
                width: "100%",
                maxWidth: "280px",
                height: "auto",
                borderRadius: "8px",
                objectFit: "cover",
              }}
            />

            <div>
              <h2 style={{ marginTop: 0, marginBottom: "8px" }}>{item.title}</h2>
              <p>slug: {item.slug}</p>
              <p>actresses: {item.actresses.join(", ")}</p>
              <p>genres: {item.genres.join(", ")}</p>

              <p style={{ marginTop: "12px" }}>
                <Link href={`/movies/${item.slug}`}>詳細を見る</Link>
              </p>
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}