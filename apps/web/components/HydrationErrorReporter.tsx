"use client";

import { useEffect } from "react";

/**
 * React の hydration mismatch (Minified React error #418 / #423 / #425 系) が
 * 走った瞬間に、ブラウザ DOM の現在ツリーから「どこで mismatch したか」を絞り込む
 * ためのヒントを console に吐く診断コンポーネント。
 *
 * - 何が起きているか:
 *   #418 は `Hydration failed because the server rendered %s didn't match the
 *   client` を投げる。args[0]="HTML" のときは「期待していたタグ/構造と違う何か」
 *   が DOM に居る (= 構造ミスマッチ) ことを意味する。React 18/19 は失敗した
 *   サブツリーをクライアント再レンダリングして表示自体は復活させるが、本番
 *   minified ビルドだと「どの要素」「どの component」が原因かログから一切
 *   見えなくなる。
 *
 * - このレポーターがやること:
 *   1. window の "error" イベント (= キャッチされなかった例外) を購読し、
 *      Minified React error #418/#419/#421/#422/#423/#425 のいずれかにマッチ
 *      したときだけ動く。
 *   2. その時点での <body> 直下〜深さ 4 までのタグ + class/data 属性を簡易
 *      シリアライズして console.error に出す。"想定と違うノード" の特徴
 *      (例: <iframe data-src=ext-foo>, <ins data-mounted>) が出ていれば、
 *      第三者スクリプト / 拡張機能による先回り注入か、こちらの SSR 出力が
 *      ずれているのか判断しやすくなる。
 *   3. ?vt=1 か NEXT_PUBLIC_HYDRATION_DEBUG=1 のときだけ動く。ノイズを避ける
 *      ため通常ビルドでは何もしない。
 *
 * - 安全性:
 *   - 副作用は console 出力のみ (analytics / fetch を呼ばない)。
 *   - DOM をいじらない。SSR にも影響しない。
 *   - 1 回 mount につき最大 3 回まで出力 (連続発火対策)。
 *
 * SSR 出力には何も含まれない (`return null`)。
 */
export default function HydrationErrorReporter() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    const params = new URLSearchParams(window.location.search);
    const enabledByQuery = params.get("vt") === "1";
    const enabledByEnv =
      process.env.NEXT_PUBLIC_HYDRATION_DEBUG === "1" ||
      process.env.NEXT_PUBLIC_HYDRATION_DEBUG === "true";
    if (!enabledByQuery && !enabledByEnv) return;

    let fired = 0;
    const MAX_FIRES = 3;

    const HYDRATION_ERRORS = new Set([418, 419, 421, 422, 423, 425]);

    const summarize = (el: Element, depth: number): unknown => {
      if (depth < 0) return null;
      const tag = el.tagName.toLowerCase();
      const attrs: Record<string, string> = {};
      // id / class / data-* / aria-* だけ抽出。可読性のため value は 60 文字に切る。
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name;
        const value = attr.value.length > 60 ? attr.value.slice(0, 60) + "…" : attr.value;
        if (
          name === "id" ||
          name === "class" ||
          name.startsWith("data-") ||
          name.startsWith("aria-")
        ) {
          attrs[name] = value;
        }
      }
      const kids: unknown[] = [];
      // 多すぎる兄弟は最初の 8 件だけ。原因ノードは大抵冒頭にある。
      const children = Array.from(el.children).slice(0, 8);
      for (const c of children) {
        kids.push(summarize(c, depth - 1));
      }
      return {
        tag,
        attrs,
        childCount: el.children.length,
        children: kids.length > 0 ? kids : undefined,
      };
    };

    const onError = (event: ErrorEvent) => {
      if (fired >= MAX_FIRES) return;
      const msg = event.message || (event.error && String(event.error)) || "";
      // "Minified React error #418" など。コード番号を URL から抽出。
      const m = msg.match(/react\.dev\/errors\/(\d+)/);
      const code = m ? Number(m[1]) : NaN;
      if (!HYDRATION_ERRORS.has(code)) return;

      fired += 1;

      const snapshot = summarize(document.body, 4);
      const headChildren = Array.from(document.head.children).map((c) => ({
        tag: c.tagName.toLowerCase(),
        type: c.getAttribute("type") ?? undefined,
        src: c.getAttribute("src") ?? undefined,
        rel: c.getAttribute("rel") ?? undefined,
        id: c.id || undefined,
      }));
      const htmlAttrs: Record<string, string> = {};
      for (const attr of Array.from(document.documentElement.attributes)) {
        htmlAttrs[attr.name] = attr.value;
      }

      // 1 つの structured object として吐く。devtools の "Verbose" でも
      // 検索しやすいよう先頭に固有マーカーを入れる。
      // eslint-disable-next-line no-console
      console.error("[hydration-debug] React error #" + code, {
        message: msg,
        url: window.location.href,
        ua: navigator.userAgent,
        htmlAttrs,
        headChildren,
        bodyTree: snapshot,
        // 第三者拡張機能の典型的注入属性をフラグ表示
        suspects: {
          gramm:
            !!document.body.getAttribute("data-gramm") ||
            !!document.body.getAttribute("data-gramm_editor"),
          cz: Array.from(document.body.attributes).some((a) => a.name.startsWith("cz-")),
          translateGoogle:
            document.documentElement.classList.contains("translated-ltr") ||
            document.documentElement.classList.contains("translated-rtl"),
        },
      });
    };

    window.addEventListener("error", onError);
    return () => window.removeEventListener("error", onError);
  }, []);

  return null;
}
