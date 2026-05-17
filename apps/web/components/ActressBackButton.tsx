"use client";
import { useRouter } from "next/navigation";
import { ACTRESS_BACK_TO_KEY } from "./ActressLink";

/**
 * 女優詳細ページ専用の戻るボタン。
 * ActressLink がクリック時に sessionStorage に保存した「戻り先URL」(動画詳細など) があれば
 * そこへ router.push() し、無ければ router.back() にフォールバックする。
 * これにより、動画詳細 → 女優詳細 → 戻る で確実に元の動画詳細ページに戻れる。
 */
export default function ActressBackButton() {
  const router = useRouter();

  const handleClick = () => {
    let target: string | null = null;
    try {
      if (typeof window !== "undefined") {
        target = sessionStorage.getItem(ACTRESS_BACK_TO_KEY);
        if (target) {
          sessionStorage.removeItem(ACTRESS_BACK_TO_KEY);
        }
      }
    } catch {
      target = null;
    }
    if (target) {
      router.push(target);
    } else {
      router.back();
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
