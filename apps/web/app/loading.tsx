export default function Loading() {
  return (
    <main style={{ padding: "24px", maxWidth: "960px", margin: "0 auto" }}>
      <h1>Loading...</h1>
      <p>フィードを読み込んでいます。</p>

      <ul
        style={{
          display: "grid",
          gap: "16px",
          padding: 0,
          listStyle: "none",
          marginTop: "24px",
        }}
      >
        {Array.from({ length: 3 }).map((_, index) => (
          <li
            key={index}
            style={{
              border: "1px solid #ddd",
              borderRadius: "12px",
              padding: "16px",
              display: "grid",
              gap: "12px",
            }}
          >
            <div
              style={{
                width: "100%",
                maxWidth: "280px",
                aspectRatio: "9 / 16",
                background: "#f1f1f1",
                borderRadius: "8px",
              }}
            />
            <div
              style={{
                width: "60%",
                height: "24px",
                background: "#f1f1f1",
                borderRadius: "6px",
              }}
            />
            <div
              style={{
                width: "80%",
                height: "16px",
                background: "#f5f5f5",
                borderRadius: "6px",
              }}
            />
            <div
              style={{
                width: "50%",
                height: "16px",
                background: "#f5f5f5",
                borderRadius: "6px",
              }}
            />
          </li>
        ))}
      </ul>
    </main>
  );
}