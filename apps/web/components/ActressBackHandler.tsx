"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ACTRESS_BACK_TO_KEY } from "./ActressLink";

/**
 * 女優詳細ページのブラウザバック (popstate) を捕捉して、
 * sessionStorage に保存された戻り先 URL (動画詳細など) に確実に戻すための副作用フック。
 *
 * 仕組み:
 *   1. マウント時に history.pushState でセンチネル履歴を 1 つ追加しておく
 *   2. ユーザーがブラウザバックすると popstate が発火する
 *      この時点でブラウザはすでに 1 つ前の状態に戻っているが、それはセンチネルの位置
 *   3. popstate ハンドラで sessionStorage を読み、戻り先があれば router.replace で
 *      その URL に置き換える (これにより女優ページ自体は履歴から消える)
 *   4. アンマウント時 (= ボタン経由で離脱した場合) はセンチネル分の履歴を消すため
 *      go(-1) は行わず、フラグでハンドラを無効化するだけ
 */
export default function ActressBackHandler() {
  const router = useRouter();

  useEffect(() => {
    if (typeof window === "undefined") return;

    // センチネル履歴を追加: state.actressSentinel = true を目印にする
    // これがあると、ブラウザバックされたとき popstate がここで発火する
    try {
      window.history.pushState(
        { actressSentinel: true },
        "",
        window.location.href,
      );
    } catch {
      // pushState がブロックされた場合は何もしない (router.back fallback に任せる)
      return;
    }

    let disabled = false;

    const handlePopState = () => {
      if (disabled) return;
      let target: string | null = null;
      try {
        target = sessionStorage.getItem(ACTRESS_BACK_TO_KEY);
        if (target) {
          sessionStorage.removeItem(ACTRESS_BACK_TO_KEY);
        }
      } catch {
        target = null;
      }
      // ハンドラの再入を防ぐ
      disabled = true;
      if (target) {
        // router.replace で女優ページ自体を履歴から消し、戻り先 URL に差し替え
        router.replace(target);
      }
      // target が無いときは、ブラウザバックそのままの挙動 (1 つ前のページ) に任せる
    };

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, [router]);

  return null;
}
