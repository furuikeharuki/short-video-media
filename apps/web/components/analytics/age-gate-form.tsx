"use client";

import { useRouter } from "next/navigation";
import { trackEvent } from "@/lib/analytics/analytics";

type AgeGateFormProps = {
  nextPath: string;
};

export default function AgeGateForm({ nextPath }: AgeGateFormProps) {
  const router = useRouter();

  const handleClick = async () => {
    // 1. クッキーをセット（ブラウザから直接書き込む）
    document.cookie = "age_verified=true; path=/; max-age=31536000; SameSite=Lax";

    // 2. アナリティクスイベント（失敗してもリダイレクトは進める）
    try {
      await trackEvent("age_gate_pass", { next_path: nextPath });
    } catch {
      // ignore
    }

    // 3. リダイレクト
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
