"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { trackEvent } from "@/lib/analytics/analytics";
import { classifyNextPath } from "@/lib/age-gate/next-path";

const STORAGE_KEY = "av_shorts_age_verified";
const EXEMPT_PREFIXES = [
  "/age-gate",
  "/privacy",
  "/law",
  "/contact",
  "/auth",
];

const CTA_LABEL: Record<string, string> = {
  feed: "18歳以上なので動画を見る",
  movie: "18歳以上なので作品を見る",
  search: "18歳以上なので検索結果を見る",
  actress: "18歳以上なので一覧を見る",
  genre: "18歳以上なので一覧を見る",
  list: "18歳以上なので一覧を見る",
  home: "18歳以上なので動画を見る",
};

function isExemptPath(pathname: string): boolean {
  return EXEMPT_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function hasLocalVerification(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function rememberLocalVerification(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, "true");
  } catch {
    // localStorage が使えない環境では httpOnly cookie だけに任せる。
  }
}

export default function AgeGateOverlay() {
  const pathname = usePathname() || "/";
  const [visible, setVisible] = useState(false);
  const settledRef = useRef(false);

  const nextPath = useMemo(() => {
    if (typeof window === "undefined") return pathname;
    return `${pathname}${window.location.search}`;
  }, [pathname]);
  const nextKind = useMemo(() => classifyNextPath(nextPath), [nextPath]);

  useEffect(() => {
    settledRef.current = false;

    if (isExemptPath(pathname)) {
      setVisible(false);
      return;
    }

    if (hasLocalVerification()) {
      setVisible(false);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/age-gate", { cache: "no-store" });
        const data = (await res.json().catch(() => null)) as {
          verified?: boolean;
        } | null;
        if (cancelled) return;
        if (data?.verified) {
          rememberLocalVerification();
          setVisible(false);
          return;
        }
      } catch {
        // 状態確認に失敗した場合は安全側で確認を表示する。
      }

      if (!cancelled) {
        setVisible(true);
        void trackEvent("age_gate_view", {
          next_path: nextPath,
          next_kind: nextKind,
          mode: "overlay",
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [nextKind, nextPath, pathname]);

  useEffect(() => {
    if (!visible) return;

    const trackAbandon = () => {
      if (settledRef.current) return;
      settledRef.current = true;
      void trackEvent("age_gate_abandon", {
        next_path: nextPath,
        next_kind: nextKind,
        mode: "overlay",
      });
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") trackAbandon();
    };

    window.addEventListener("pagehide", trackAbandon);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", trackAbandon);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [nextKind, nextPath, visible]);

  const handlePass = async () => {
    settledRef.current = true;
    rememberLocalVerification();

    try {
      await fetch("/api/age-gate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nextPath }),
      });
    } catch {
      // Cookie 設定に失敗しても、同一タブ内では localStorage で閉じる。
    }

    void trackEvent("age_gate_pass", {
      next_path: nextPath,
      next_kind: nextKind,
      mode: "overlay",
    });
    setVisible(false);
  };

  const handleExit = () => {
    settledRef.current = true;
    void trackEvent("age_gate_exit", {
      next_path: nextPath,
      next_kind: nextKind,
      mode: "overlay",
    });
  };

  if (!visible) return null;

  const label = CTA_LABEL[nextKind] ?? CTA_LABEL.home;

  return (
    <div className="ago" role="dialog" aria-modal="true" aria-labelledby="ago-title">
      <div className="ago-bg" aria-hidden="true" />
      <div className="ago-card">
        <div className="ago-logo" aria-hidden="true">
          <span>AV</span> Shorts
        </div>
        <h2 id="ago-title">年齢確認</h2>
        <p className="ago-lead">
          このサイトは<strong>18歳以上対象</strong>のアダルトコンテンツを含みます。
        </p>
        <ul className="ago-list" aria-label="ご利用にあたって">
          <li>会員登録なし・無料でそのまま視聴できます</li>
          <li>確認後は現在のページで続けて閲覧できます</li>
        </ul>
        <button type="button" className="ago-primary" onClick={handlePass}>
          {label}
        </button>
        <a
          href="https://www.google.com"
          target="_blank"
          rel="noopener noreferrer"
          className="ago-exit"
          onClick={handleExit}
        >
          18歳未満の方はこちら
        </a>
        <p className="ago-note">
          ボタンを押すと、あなたが18歳以上であることを確認したものとみなします。
        </p>
      </div>
      <style>{styles}</style>
    </div>
  );
}

const styles = `
  .ago {
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px 16px;
    background: rgba(10, 10, 10, 0.86);
    color: #fff;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    box-sizing: border-box;
  }
  .ago-bg {
    position: absolute;
    inset: 0;
    background: radial-gradient(ellipse at 50% 0%, rgba(233,30,99,0.22), transparent 62%);
    pointer-events: none;
  }
  .ago-card {
    position: relative;
    width: 100%;
    max-width: 400px;
    padding: 34px 28px 28px;
    border-radius: 20px;
    border: 1px solid rgba(255,255,255,0.12);
    background: rgba(18,18,18,0.94);
    box-shadow: 0 18px 60px rgba(0,0,0,0.45);
    text-align: center;
    box-sizing: border-box;
  }
  .ago-logo {
    margin-bottom: 14px;
    font-size: 22px;
    font-weight: 800;
    letter-spacing: -0.02em;
  }
  .ago-logo span { color: #e91e63; }
  .ago-card h2 {
    margin: 0 0 10px;
    font-size: 24px;
    font-weight: 800;
  }
  .ago-lead {
    margin: 0 0 12px;
    color: rgba(255,255,255,0.75);
    font-size: 15px;
    line-height: 1.7;
  }
  .ago-lead strong { color: #fff; }
  .ago-list {
    margin: 0 0 22px;
    padding: 0;
    list-style: none;
    color: rgba(255,255,255,0.58);
    font-size: 12px;
    line-height: 1.8;
  }
  .ago-primary {
    width: 100%;
    min-height: 50px;
    border: 0;
    border-radius: 12px;
    background: linear-gradient(135deg, #e91e63, #ff4d8d);
    color: #fff;
    font-size: 15px;
    font-weight: 800;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .ago-primary:active { transform: translateY(1px); }
  .ago-exit {
    display: inline-block;
    margin-top: 18px;
    color: rgba(255,255,255,0.42);
    font-size: 13px;
    text-decoration: none;
  }
  .ago-note {
    margin: 16px 0 0;
    color: rgba(255,255,255,0.34);
    font-size: 11px;
    line-height: 1.6;
  }
`;
