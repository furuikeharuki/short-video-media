import { Suspense } from "react";
import SearchFeedPage from "./SearchFeedPage";

export default function Page() {
  return (
    <Suspense fallback={
      <div style={{
        position: "fixed", inset: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "#000",
      }}>
        <span style={{
          width: 36, height: 36,
          border: "3px solid rgba(255,255,255,0.15)",
          borderTop: "3px solid #fff",
          borderRadius: "50%",
          display: "inline-block",
          animation: "spin 0.8s linear infinite",
        }} />
      </div>
    }>
      <SearchFeedPage />
    </Suspense>
  );
}
