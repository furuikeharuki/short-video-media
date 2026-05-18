"use client";
import { useRouter } from "next/navigation";

/**
 * 女優詳細ページ専用の戻るボタン。
 *
 * 動作:
 *   router.back() でブラウザ履歴の 1 つ前に戻る。
 *   元の動画詳細ページ (インターセプトモーダル含む) や検索結果ページに自然に戻る。
 *   ブラウザバックでも同じ挙動になる。
 *
 *   ※ 直接 URL アクセス等で履歴がない場合は何も起きないため、その時はフィードへ fallback する。
 */
export default function ActressBackButton() {
  const router = useRouter();

  const handleClick = () => {
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
    } else {
      router.replace("/");
    }
  };

  return (
    <button
      onClick={handleClick}
      aria-label="前のページに戻る"
      style={{
        position: "absolute",
        top: "16px",
        left: "16px",
        zIndex: 2,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: "40px",
        height: "40px",
        borderRadius: "50%",
        background: "rgba(0,0,0,0.5)",
        backdropFilter: "blur(8px)",
        color: "#fff",
        border: "1px solid rgba(255,255,255,0.15)",
        cursor: "pointer",
      }}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M19 12H5M12 5l-7 7 7 7" />
      </svg>
    </button>
  );
}
