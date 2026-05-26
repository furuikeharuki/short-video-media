"use client";

import { useEffect } from "react";

/**
 * 起動時に 1 行だけ build-id を console.info に出す。
 *
 * - "?vt=1" を付けずに収集したログでも、走っていた deploy bundle が特定できる
 *   ようにするのが目的 (stale-cache 切り分け用)。
 * - 1 セッション 1 行で十分なので、useEffect の空依存で 1 度だけ呼ぶ。
 * - prod でも出すが、1 行 + info レベルでありノイズにはならない。
 */
export default function BuildIdLogger({ buildId }: { buildId: string }) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.info(`build-id ${buildId}`);
  }, [buildId]);
  return null;
}
