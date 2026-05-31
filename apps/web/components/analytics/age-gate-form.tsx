"use client";

import { useEffect, useRef } from "react";
import { trackEvent } from "@/lib/analytics/analytics";
import { sanitizeNextPath } from "@/lib/age-gate/next-path";

type AgeGateFormProps = {
  nextPath: string;
  nextKind?: string;
};

// 遷移先タイプごとに CTA 文言を出し分けて「次に何が起きるか」を具体化し、
// 心理的ハードルを下げる。いずれも 18 歳以上であることの確認である点は不変。
const CTA_LABEL: Record<string, string> = {
  feed: "18歳以上なので動画を見る",
  movie: "18歳以上なので作品を見る",
  search: "18歳以上なので検索結果を見る",
  actress: "18歳以上なので一覧を見る",
  genre: "18歳以上なので一覧を見る",
  list: "18歳以上なので一覧を見る",
  home: "18歳以上なので動画を見る",
};

export default function AgeGateForm({ nextPath, nextKind }: AgeGateFormProps) {
  const btnRef = useRef<HTMLButtonElement>(null);

  // 表示計測 (ファネルの母数)。マウント時に 1 回だけ送る。
  useEffect(() => {
    void trackEvent("age_gate_view", {
      next_path: nextPath,
      next_kind: nextKind,
    });
    // モバイルで誤タップを誘発しないよう preventScroll でフォーカスのみ移す。
    btnRef.current?.focus({ preventScroll: true });
    // nextPath / nextKind はページ単位で固定なので初回のみで十分。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleClick = async () => {
    // クライアント側でも再度サニタイズする (props 改ざん・将来の呼び出し対策)。
    const target = sanitizeNextPath(nextPath);

    try {
      await fetch("/api/age-gate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nextPath: target }),
      });
    } catch {
      // ネットワークエラーでも遷移させる
    }

    void trackEvent("age_gate_pass", {
      next_path: target,
      next_kind: nextKind,
    });

    // フルナビゲーションでmiddlewareに新しいcookieを確実に送る
    window.location.href = target;
  };

  const label = CTA_LABEL[nextKind ?? "home"] ?? CTA_LABEL.home;

  return (
    <button
      ref={btnRef}
      type="button"
      className="age-gate-form-btn"
      onClick={handleClick}
    >
      {label}
    </button>
  );
}
