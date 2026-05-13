"use client";

import { useRouter } from "next/navigation";
import { trackEvent } from "@/lib/analytics/analytics";

type AgeGateFormProps = {
  nextPath: string;
};

export default function AgeGateForm({ nextPath }: AgeGateFormProps) {
  const router = useRouter();

  const handleClick = () => {
    // 1. cookieを即座にセット
    document.cookie = "age_verified=true; path=/; max-age=31536000; SameSite=Lax";

    // 2. アナリティクスは fire-and-forget（待たない）
    void trackEvent("age_gate_pass", { next_path: nextPath });

    // 3. 即座に遷移
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
