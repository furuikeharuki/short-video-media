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
      <button type="submit" className="age-gate-form-btn">
        18歳以上です、入場する
      </button>
    </form>
  );
}
