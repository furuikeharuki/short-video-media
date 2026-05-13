"use client";

import { trackEvent } from "@/lib/analytics/analytics";

type AgeGateFormProps = {
  nextPath: string;
};

export default function AgeGateForm({ nextPath }: AgeGateFormProps) {
  const handleClick = async () => {
    try {
      await fetch("/api/age-gate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nextPath }),
      });
    } catch {
      // ネットワークエラーでも遷移させる
    }

    void trackEvent("age_gate_pass", { next_path: nextPath });

    // フルナビゲーションでmiddlewareに新しいcookieを確実に送る
    window.location.href = nextPath || "/";
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
