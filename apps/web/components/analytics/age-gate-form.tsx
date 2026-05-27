"use client";

import { trackEvent } from "@/lib/analytics/analytics";

type AgeGateFormProps = {
  nextPath: string;
};

// オープンリダイレクト防止: server 側でも sanitize しているが、念のため
// クライアントでも同一オリジン相対パスに正規化してから遷移する。
function safeNextPath(raw: string | undefined | null): string {
  if (!raw) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}

export default function AgeGateForm({ nextPath }: AgeGateFormProps) {
  const handleClick = async () => {
    const target = safeNextPath(nextPath);

    try {
      await fetch("/api/age-gate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nextPath: target }),
      });
    } catch {
      // ネットワークエラーでも遷移させる
    }

    void trackEvent("age_gate_pass", { next_path: target });

    // フルナビゲーションでmiddlewareに新しいcookieを確実に送る。
    // target は query string を含む完全な相対 URL (例: "/feed?q=巨乳") なので、
    // ここで pathname だけに切り詰めないこと。
    window.location.href = target;
  };

  return (
    <button
      type="button"
      className="age-gate-form-btn"
      onClick={handleClick}
    >
      18歳以上です、入場する
    </button>
  );
}
