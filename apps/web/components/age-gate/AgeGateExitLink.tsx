"use client";

import { trackEvent } from "@/lib/analytics/analytics";

// 18歳未満 (= 退出) リンク。離脱を計測してから外部へ遷移させる。
// 計測失敗・解析未設定でも遷移は必ず行う (trackEvent は内部で握りつぶす)。
export default function AgeGateExitLink() {
  const handleClick = () => {
    void trackEvent("age_gate_exit");
  };

  return (
    <a
      href="https://www.google.com"
      target="_blank"
      rel="noopener noreferrer"
      onClick={handleClick}
      style={{
        display: "block",
        fontSize: "13px",
        color: "rgba(255,255,255,0.35)",
        textDecoration: "none",
        marginBottom: "20px",
      }}
    >
      18歳未満の方はこちら
    </a>
  );
}
