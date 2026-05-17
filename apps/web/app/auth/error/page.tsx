"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";

/**
 * NextAuth のエラーページ。
 *
 * NextAuth はログインキャンセル / OAuth エラー時に
 * /api/auth/error?error=... へリダイレクトしようとするが、
 * auth.ts の pages.error 設定で代わりにこのページへ送る。
 *
 * - access_denied (ユーザーがキャンセル) の場合は黙ってトップへ戻す
 * - それ以外はユーザーに再ログインを促す優しい UI を出す
 */
export default function AuthErrorPage() {
  return (
    <Suspense fallback={<Fallback />}>
      <AuthErrorInner />
    </Suspense>
  );
}

function Fallback() {
  return (
    <main className="ae-main">
      <div className="ae-card">
        <p className="ae-lead">読み込み中...</p>
      </div>
      <style>{styles}</style>
    </main>
  );
}

function AuthErrorInner() {
  const router = useRouter();
  const params = useSearchParams();
  const error = params.get("error") ?? "";

  // ユーザーが OAuth ダイアログでキャンセルした場合は静かにトップへ戻す
  const isCancel =
    error === "AccessDenied" ||
    error === "access_denied" ||
    error === "OAuthCallback" ||
    error === "OAuthSignin";

  useEffect(() => {
    if (isCancel) {
      const t = window.setTimeout(() => {
        router.replace("/");
      }, 50);
      return () => window.clearTimeout(t);
    }
  }, [isCancel, router]);

  if (isCancel) {
    return (
      <main className="ae-main">
        <div className="ae-card">
          <p className="ae-lead">トップへ戻ります...</p>
        </div>
        <style>{styles}</style>
      </main>
    );
  }

  return (
    <main className="ae-main">
      <div className="ae-card">
        <h1 className="ae-title">ログインに失敗しました</h1>
        <p className="ae-lead">
          通信エラーまたは認証側の設定エラーが発生したため、ログインを完了できませんでした。
          時間をおいてもう一度お試しください。
        </p>
        <button
          type="button"
          className="ae-btn ae-btn--twitter"
          onClick={() => signIn("twitter", { callbackUrl: "/" })}
        >
          X (Twitter) でもう一度ログイン
        </button>
        <button
          type="button"
          className="ae-btn ae-btn--discord"
          onClick={() => signIn("discord", { callbackUrl: "/" })}
        >
          Discord でもう一度ログイン
        </button>
        <button
          type="button"
          className="ae-btn ae-btn--ghost"
          onClick={() => router.replace("/")}
        >
          トップへ戻る
        </button>
        {error && <p className="ae-detail">エラーコード: {error}</p>}
      </div>
      <style>{styles}</style>
    </main>
  );
}

const styles = `
  html { background: #000; }
  body { background: #000; }
  .ae-main {
    min-height: 100dvh;
    background: #000;
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .ae-card {
    width: 100%;
    max-width: 380px;
    padding: 24px;
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 16px;
  }
  .ae-title {
    font-size: 20px;
    font-weight: 800;
    margin: 0 0 12px;
  }
  .ae-lead {
    font-size: 14px;
    color: rgba(255,255,255,0.7);
    line-height: 1.7;
    margin: 0 0 20px;
  }
  .ae-btn {
    display: block;
    width: 100%;
    padding: 12px;
    margin-bottom: 8px;
    font-size: 14px;
    font-weight: 700;
    border: none;
    border-radius: 10px;
    cursor: pointer;
    color: #fff;
  }
  .ae-btn--twitter { background: #000; border: 1px solid rgba(255,255,255,0.2); }
  .ae-btn--discord { background: #5865F2; }
  .ae-btn--ghost   { background: transparent; border: 1px solid rgba(255,255,255,0.2); color: rgba(255,255,255,0.7); }
  .ae-detail {
    margin-top: 16px;
    font-size: 11px;
    color: rgba(255,255,255,0.35);
  }
`;
