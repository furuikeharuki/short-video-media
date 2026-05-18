"use client";
import { useRouter } from "next/navigation";

/**
 * 女優詳細ページ専用の戻るボタン。
 *
 * 動作:
 *   ActressBackHandler がマウント時に history.pushState でセンチネル履歴を 1 つ追加
 *   しているため、ボタンクリックでは router.back() を呼ぶだけでブラウザバックと
 *   同じ経路を走る (popstate ハンドラがセッションストレージの戻り先 URL を見て router.replace)。
 */
export default function ActressBackButton() {
  const router = useRouter();

  const handleClick = () => {
    // ActressBackHandler が popstate を拾って sessionStorage から戻り先 URL に遷移させる。
    // センチネルが無いケース (pushState がブロックされた等) はそのまま通常の戻ると同じになる。
    router.back();
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
