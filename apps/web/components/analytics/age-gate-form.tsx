"use client";

import { useRouter } from "next/navigation";
import { trackEvent } from "@/lib/analytics/analytics";

type AgeGateFormProps = {
  nextPath: string;
};

export default function AgeGateForm({ nextPath }: AgeGateFormProps) {
  const router = useRouter();

  const handleClick = async () => {
    // 1. APIルート経由で httpOnly cookie をセットする
    //    → 次のリクエストから middleware が認証済みと判定できる
    try {
      await fetch("/api/age-gate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nextPath }),
      });
    } catch {
      // ネットワークエラーでも遷移させる
    }

    // 2. アナリティクス fire-and-forget
    void trackEvent("age_gate_pass", { next_path: nextPath });

    // 3. 遷移
    router.push(nextPath || "/");
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
