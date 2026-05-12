"use client";

import { trackEvent } from "@/lib/analytics/analytics";

type AgeGateFormProps = {
  nextPath: string;
};

export default function AgeGateForm({ nextPath }: AgeGateFormProps) {
  return (
    <form
      action="/age-gate/verify"
      method="post"
      onSubmit={() => {
        void trackEvent("age_gate_pass", {
          next_path: nextPath,
        });
      }}
    >
      <input type="hidden" name="nextPath" value={nextPath} />
      <button
        type="submit"
        style={{
          marginTop: "16px",
          padding: "10px 16px",
          border: "1px solid #ddd",
          borderRadius: "8px",
          background: "#fff",
          cursor: "pointer",
        }}
      >
        18歳以上です
      </button>
    </form>
  );
}