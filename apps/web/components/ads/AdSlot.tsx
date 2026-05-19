"use client";

import { useEffect, useRef, useState } from "react";
import { AD_ZONES, isAdZoneEnabled, type AdZoneKey } from "@/lib/ads/config";
import { resetAndServeAd, serveAd } from "./AdScriptLoader";

type Props = {
  zone: AdZoneKey;
  className?: string;
  style?: React.CSSProperties;
  label?: string | null;
};

/**
 * ExoClick 広告枠を 1 つ描画するクライアントコンポーネント。
 *
 * 公式タグ:
 *   <ins class="..." data-zoneid="..."></ins>
 *   <script>(AdProvider=window.AdProvider||[]).push({serve:{}})</script>
 *
 * 設計ポイント:
 *
 * 1. <ins> は内側の <AdIns> に key を当てて分離する。
 *    再生成 (key bump) すると React は <ins> の DOM を作り直すため、
 *    ad-provider.js は「新しい未処理 <ins>」として再 serve できる。
 *
 * 2. **viewport に入ってから serve する**。
 *    オフスクリーンの枠を即 serve すると、ExoClick は viewport 外の枠を
 *    no-fill 扱いにしやすく、結果として「ホームをスクロールしているうちに
 *    広告がだんだん消える」症状を引き起こす。IntersectionObserver で
 *    最初に画面内に入ったタイミングを待ってから初回 serve する。
 *
 * 3. **空のまま終わった枠も DOM 上は残し、display:none で完全に消さない**。
 *    一度畳むと戻れなくなり「何回か表示しているうちに消える」症状になる。
 *    no-fill 判定後は枠を最小高さで保持し、次に viewport に再進入したり
 *    タブが復帰した時に key を bump してもう一度 serve を試す。
 *
 * 4. **複数枠が同居するページで provider を巻き添えで殺さない**。
 *    ad-provider.js のリセットは「ホーム復帰直後の最初の 1 回」のみ。
 *    クールダウンを AdScriptLoader 側に持たせ、複数 AdSlot から同時に
 *    要求が来ても 1 回しか効かないようにしてある。
 *
 * 5. ナビゲーション復帰 (popstate / pageshow / visibilitychange) を検知して、
 *    creative が入っていない (またはそもそも今までフィルされなかった) 枠を
 *    key bump で作り直し、合わせて provider を 1 度だけリセット要求する。
 *
 * 6. **hasContent は state と ref の両方で管理する**。
 *    useEffect 内のイベントリスナーは登録時点の state 値をクロージャーに
 *    閉じ込めるため、広告表示後に popstate / pageshow が来ると古い false を
 *    読んで誤って bump → 広告が消える。ref 経由で常に最新値を参照する。
 */
export default function AdSlot({
  zone,
  className,
  style,
  label = "広告",
}: Props) {
  const cfg = AD_ZONES[zone];

  // 内側 <ins> を作り直すための世代 key。
  // 戻る/復帰/再可視化時に bump して新しい <ins> を mount する。
  const [insKey, setInsKey] = useState(0);
  // 現世代の <ins> に creative が入ったか。
  const [hasContent, setHasContent] = useState(false);
  // 現世代が no-fill で諦め済みか (display:none にはしない、最小高さで残す)。
  const [emptyGen, setEmptyGen] = useState(false);

  // hasContent の ref 版。useEffect クロージャーから最新値を安全に読むために使う。
  // state だけだと登録時点の値がクロージャーに閉じ込められ、広告表示後も false
  // のまま読まれて誤 bump が発生する (= ホームに戻ると広告が消える)。
  const hasContentRef = useRef(false);

  // 直近の世代 bump 時刻 (クールダウン用)。
  const lastBumpAtRef = useRef(0);
  // 現世代の <ins> が既に serve 試行されたか (StrictMode 二重実行対策)。
  const servedThisGenRef = useRef(false);

  // bump 要求中フラグ。短時間に複数イベントが来ても 1 回だけ bump する。
  const bumpScheduledRef = useRef(false);

  // 既に viewport に入って 1 度でも serve したか。初回 serve は IntersectionObserver
  // 経由で発火させ、それ以降の bump はイベント駆動。
  const hasEnteredViewportRef = useRef(false);

  const enabled = cfg.enabled;

  /**
   * 世代 bump を要求する。
   * - creative が既に入っているなら何もしない (張り替える必要がない)
   * - 直近 2 秒以内に bump 済みなら何もしない
   * - それ以外: 次フレームで insKey++ + emptyGen=false に戻す
   *
   * `withProviderReset=true` の場合は ad-provider.js を一度捨てて再注入する。
   * これは「ホームに戻った直後」など、ad-provider.js が後発 <ins> を
   * 取りこぼしている疑いが強い時にだけ使う。AdScriptLoader 側のクールダウンが
   * あるため、複数枠から同時に呼んでも 1 回しか効かない。
   *
   * ※ hasContent は ref 経由で読む。state をクロージャーで閉じ込めると
   *   広告表示後も古い false を参照して誤 bump してしまう。
   */
  const requestBump = (withProviderReset: boolean) => {
    if (!enabled) return;
    if (hasContentRef.current) return;   // ← ref で最新値を参照
    if (bumpScheduledRef.current) return;
    const now = Date.now();
    if (now - lastBumpAtRef.current < 2000) return;
    bumpScheduledRef.current = true;
    requestAnimationFrame(() => {
      bumpScheduledRef.current = false;
      lastBumpAtRef.current = Date.now();
      servedThisGenRef.current = false;
      setEmptyGen(false);
      setInsKey((k) => k + 1);
      if (withProviderReset) {
        // 1 度だけ provider を捨てて再ロード。ad-provider.js の初期スキャンで
        // 新しい <ins> (この後 React が mount する) も含めて拾い直す。
        resetAndServeAd(cfg.provider);
      }
    });
  };

  // ナビゲーション復帰系イベント。ホーム→/feed→ホームで戻ったときの拾い直しが目的。
  useEffect(() => {
    if (!enabled) return;
    const onPopState = () => requestBump(true);
    const onPageShow = (e: PageTransitionEvent) => {
      void e.persisted;
      requestBump(true);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") requestBump(false);
    };
    window.addEventListener("popstate", onPopState);
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // hasContentRef は ref なので依存不要。requestBump も enabled のみ依存。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  if (!isAdZoneEnabled(zone)) return null;

  // wrapper のスタイル。creative が入った時だけ予約高さを適用 (CLS 抑止)。
  // 空のままでも display:none にはしない (一度畳むと戻れなくなる)。
  const wrapperStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    boxSizing: "border-box",
    background: "transparent",
    // 空枠時は中身を持たないので 0 高さで実質非表示、ただし IntersectionObserver
    // の対象として DOM に残るようにする (1px の見えない高さで観測される)。
    minHeight:
      hasContent && cfg.reservedHeight != null
        ? `${cfg.reservedHeight}px`
        : emptyGen
          ? "1px"
          : "1px",
    ...style,
  };

  return (
    <aside
      className={`ad-slot ad-slot-${zone}${className ? ` ${className}` : ""}`}
      style={wrapperStyle}
      aria-label={label ?? undefined}
      role="complementary"
    >
      {label && hasContent && (
        <span
          style={{
            fontSize: 10,
            color: "rgba(255,255,255,0.35)",
            letterSpacing: "0.08em",
            marginBottom: 4,
            alignSelf: "center",
          }}
        >
          {label}
        </span>
      )}
      <AdIns
        key={insKey}
        cfg={cfg}
        servedThisGenRef={servedThisGenRef}
        hasEnteredViewportRef={hasEnteredViewportRef}
        onContent={() => {
          hasContentRef.current = true;   // ← ref も同時に更新
          setHasContent(true);
          setEmptyGen(false);
        }}
        onEmpty={() => {
          // 「この世代では入らなかった」状態に遷移。display:none にはしない。
          setEmptyGen(true);
        }}
        onBecameVisibleAgain={() => {
          // 空のまま画面外に出て、もう一度画面に入ってきたケース。
          // 世代を bump して serve をやり直す。
          requestBump(false);
        }}
      />
    </aside>
  );
}

/**
 * 単一の <ins data-zoneid> を render するだけのサブコンポーネント。
 *
 * 動作:
 *  - IntersectionObserver で viewport 進入を待つ
 *  - 初回進入で AdProvider.push({serve:{}}) を 1 度だけ呼ぶ
 *  - MutationObserver で creative の挿入を検知して onContent を呼ぶ
 *  - 4 秒で入らなかったら onEmpty を呼ぶ (枠は残す、display:none にしない)
 *  - 既に空になった枠が再び viewport に入ってきたら onBecameVisibleAgain を呼ぶ
 *    → 親が世代を bump し直してくれる
 */
function AdIns({
  cfg,
  servedThisGenRef,
  hasEnteredViewportRef,
  onContent,
  onEmpty,
  onBecameVisibleAgain,
}: {
  cfg: (typeof AD_ZONES)[AdZoneKey];
  servedThisGenRef: React.MutableRefObject<boolean>;
  hasEnteredViewportRef: React.MutableRefObject<boolean>;
  onContent: () => void;
  onEmpty: () => void;
  onBecameVisibleAgain: () => void;
}) {
  const insRef = useRef<HTMLModElement | null>(null);

  useEffect(() => {
    const el = insRef.current;
    if (!el) return;

    let cancelled = false;
    let contentSeen = false;
    let emptyEmitted = false;

    const insHasAd = (): boolean => {
      // creative iframe / img / video 等が <ins> 内に追加されたかで判定する。
      // サイズだけでの判定は ad-provider.js が ins に属性を付けただけの状態を
      // 誤検出することがあるためやめた。
      return !!el.querySelector("iframe, img, video, a, picture, canvas");
    };

    const tryServeOnce = () => {
      if (servedThisGenRef.current) return;
      servedThisGenRef.current = true;
      serveAd(cfg.provider);
    };

    // MutationObserver: creative 挿入の検知。
    const mo = new MutationObserver(() => {
      if (cancelled) return;
      if (!contentSeen && insHasAd()) {
        contentSeen = true;
        onContent();
        mo.disconnect();
      }
    });
    mo.observe(el, { childList: true, subtree: true });

    // IntersectionObserver: viewport 進入の検知 + 再進入の検知。
    // - 初回進入 → serve 開始
    // - 既に creative 持ちなら何もしない
    // - 空のまま画面外に出てから戻ってきた場合は親に世代 bump を依頼
    let serveStarted = false;
    let collapseTimer: number | null = null;
    let retryTimer: number | null = null;

    const beginServeFlow = () => {
      if (serveStarted) return;
      serveStarted = true;
      hasEnteredViewportRef.current = true;
      tryServeOnce();
      // 約 700ms 後にまだ入っていなければ追加 push (同じ <ins> 上の再 push)。
      // 既に処理済みなら ad-provider.js が無視するので副作用なし。
      retryTimer = window.setTimeout(() => {
        if (cancelled || contentSeen) return;
        if (!insHasAd()) {
          serveAd(cfg.provider);
        }
      }, 700);
      // 4 秒で入らなければ no-fill とみなし親に通知。
      // ただし枠は display:none にせず、最小高さで残す。
      collapseTimer = window.setTimeout(() => {
        if (cancelled || contentSeen) return;
        if (!insHasAd() && !emptyEmitted) {
          emptyEmitted = true;
          onEmpty();
        }
      }, 4000);
    };

    const io = new IntersectionObserver(
      (entries) => {
        if (cancelled) return;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          if (!serveStarted) {
            beginServeFlow();
          } else if (emptyEmitted && !contentSeen) {
            // 空のまま一度画面外に出て、戻ってきた。親に bump を依頼。
            onBecameVisibleAgain();
          }
        }
      },
      // 少し早めに発火させて creative ロードのリードタイムを稼ぐ。
      { rootMargin: "200px 0px", threshold: 0.01 },
    );
    io.observe(el);

    // 初期状態が既に creative 入り (HMR / 二重 mount) なら状態反映だけ。
    if (insHasAd()) {
      contentSeen = true;
      onContent();
      mo.disconnect();
    }

    return () => {
      cancelled = true;
      mo.disconnect();
      io.disconnect();
      if (retryTimer != null) window.clearTimeout(retryTimer);
      if (collapseTimer != null) window.clearTimeout(collapseTimer);
    };
    // mount に対して 1 度実行すれば十分。親が key bump するとこの effect も
    // 自動的に再実行される。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const insStyle: React.CSSProperties = {
    display: "inline-block",
    background: "transparent",
    ...(cfg.reservedWidth != null ? { width: `${cfg.reservedWidth}px` } : {}),
  };

  return (
    <ins
      ref={insRef as React.RefObject<HTMLModElement>}
      className={cfg.insClass}
      data-zoneid={cfg.zoneId}
      style={insStyle}
    />
  );
}
