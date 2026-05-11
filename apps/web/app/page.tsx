import Link from "next/link";
import { getFeed } from "@/lib/api/feed";

export default async function HomePage() {
  const feed = await getFeed();

  return (
    <main style={{ padding: "24px" }}>
      <h1>Feed</h1>

      <ul style={{ display: "grid", gap: "16px", padding: 0, listStyle: "none" }}>
        {feed.items.map((item) => (
          <li
            key={item.id}
            style={{
              border: "1px solid #ddd",
              borderRadius: "12px",
              padding: "16px",
            }}
          >
            <h2 style={{ marginTop: 0 }}>
              <Link href={`/movies/${item.slug}`}>{item.title}</Link>
            </h2>
            <p>slug: {item.slug}</p>
            <p>actresses: {item.actresses.join(", ")}</p>
            <p>genres: {item.genres.join(", ")}</p>
          </li>
        ))}
      </ul>
    </main>
  );
}