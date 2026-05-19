"use client";

import { useEffect, useRef, useState } from "react";
import { AD_ZONES, isAdZoneEnabled, type AdZoneKey } from "@/lib/ads/config";
import { serveAd } from "./AdScriptLoader";

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
 * - <ins> は内側の <AdIns> コンポーネントに key を当てて分離する。
 *   戻る/復帰時に key を bump することで <ins> DOM 自体を作り直し、
 *   ad-provider.js に「未処理 <ins>」として再認識させる
 *   (既処理 <ins> は無視されるため、空 <ins> に再 push しても serve されない)。
 * - 一定時間 creative が入らなかった slot は display:none で畳む。
 *   黒い空枠だけが残る事故を避ける。
 * - 二重 serve を避けるため slot ごとに in-flight ガードとクールダウンを置く。
 */
export default function AdSlot({
  zone,
  className,
  style,
  label = "広告",
}: Props) {
  const cfg = AD_ZONES[zone];

  // 内側 <ins> を作り直すための世代 key。
  // 戻る/復帰時で creative が入らなかった場合に bump して新しい <ins> を mount する。
  const [insKey, setInsKey] = useState(0);
  const [hasContent, setHasContent] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  // 直近の serve 試行時刻 (クールダウン用)
  const lastServeAtRef = useRef(0);
  // 現在の世代で既に serve したか (StrictMode の二重実行対策)
  const servedThisGenRef = useRef(false);

  // bump 要求中フラグ。短時間に複数イベントが来ても 1 回だけ bump する。
  const bumpScheduledRef = useRef(false);

  const enabled = cfg.enabled;

  // 再 serve をトリガする中央関数。
  // - hasContent なら何もしない (既に creative が見えている)
  // - 直近 2 秒以内に同 slot を bump 済みなら何もしない
  // - それ以外: insKey++ → AdIns が remount → 新 <ins> で AdProvider.push({serve:{}})
  const requestRefresh = () => {
    if (!enabled) return;
    if (hasContent) return;
    if (bumpScheduledRef.current) return;
    const now = Date.now();
    if (now - lastServeAtRef.current < 2000) return;
    bumpScheduledRef.current = true;
    // 次フレームで bump (連続イベント吸収)
    requestAnimationFrame(() => {
      bumpScheduledRef.current = false;
      lastServeAtRef.current = Date.now();
      setCollapsed(false);
      servedThisGenRef.current = false;
      setInsKey((k) => k + 1);
    });
  };

  useEffect(() => {
    if (!enabled) return;
    const onPopState = () => requestRefresh();
    const onPageShow = (e: PageTransitionEvent) => {
      // bfcache 復帰でも、それ以外の表示でも空ならリフレッシュ。
      // persisted は記録だけして判定には使わない。
      void e.persisted;
      requestRefresh();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") requestRefresh();
    };
    window.addEventListener("popstate", onPopState);
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // hasContent をクロージャ経由で読むが、requestRefresh が再生成されるため
    // hasContent 依存は外す ( ref と setState の組み合わせで十分 )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  if (!isAdZoneEnabled(zone)) return null;

  // creative が入ったあとに予約サイズを当て CLS を抑える。
  // 畳んだら display:none で完全に消す。
  const wrapperStyle: React.CSSProperties = collapsed
    ? { display: "none" }
    : {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        width: "100%",
        boxSizing: "border-box",
        background: "transparent",
        ...(hasContent && cfg.reservedHeight != null
          ? { minHeight: `${cfg.reservedHeight}px` }
          : {}),
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
        lastServeAtRef={lastServeAtRef}
        onContent={() => setHasContent(true)}
        onCollapse={() => {
          setHasContent(false);
          setCollapsed(true);
        }}
      />
    </aside>
  );
}

/**
 * 単一の <ins data-zoneid> を render するだけのサブコンポーネント。
 *
 * mount 直後に AdProvider.push({serve:{}}) を 1 度だけ呼ぶ。
 * 親が key を bump すると React は <ins> DOM を作り直すため、
 * ad-provider.js から見ても「新しい未処理 <ins>」になり、再 serve できる。
 *
 * MutationObserver で creative 挿入を検知し、入ったら onContent を呼ぶ。
 * 4 秒経っても入らなければ onCollapse を呼んで枠ごと畳ませる。
 */
function AdIns({
  cfg,
  servedThisGenRef,
  lastServeAtRef,
  onContent,
  onCollapse,
}: {
  cfg: (typeof AD_ZONES)[AdZoneKey];
  servedThisGenRef: React.MutableRefObject<boolean>;
  lastServeAtRef: React.MutableRefObject<number>;
  onContent: () => void;
  onCollapse: () => void;
}) {
  const insRef = useRef<HTMLModElement | null>(null);

  useEffect(() => {
    const el = insRef.current;
    if (!el) return;

    let cancelled = false;

    const insHasAd = (): boolean => {
      // ins 内に iframe / img / video / a 等が入ったかで判定する。
      // creative iframe はクロスオリジンで中身を覗けないが、要素の有無は判る。
      if (el.querySelector("iframe, img, video, a, picture, canvas")) return true;
      // ins 自体にサイズが入っていれば creative が描画された可能性が高い。
      const r = el.getBoundingClientRect();
      if (r.width >= 50 && r.height >= 50) return true;
      return false;
    };

    // 既に creative が入っている (HMR / 二重 mount) なら状態反映だけ。
    if (insHasAd()) {
      onContent();
    } else if (!servedThisGenRef.current) {
      servedThisGenRef.current = true;
      lastServeAtRef.current = Date.now();
      serveAd(cfg.provider);
    }

    const observer = new MutationObserver(() => {
      if (cancelled) return;
      if (insHasAd()) {
        onContent();
        observer.disconnect();
      }
    });
    observer.observe(el, { childList: true, subtree: true, attributes: true });

    // 約 600ms 後にまだ ad-provider.js が間に合っていないなら 1 度だけ追加 serve
    // (この時点では同じ <ins> 上での再 push なので二重描画は起こらない。
    //  既処理になっていれば ad-provider.js が無視する)
    const retryTimer = window.setTimeout(() => {
      if (cancelled) return;
      if (!insHasAd()) {
        lastServeAtRef.current = Date.now();
        serveAd(cfg.provider);
      }
    }, 700);

    // 4 秒経っても何も入らない/サイズが付かないなら no-fill とみなして畳む。
    const collapseTimer = window.setTimeout(() => {
      if (cancelled) return;
      if (!insHasAd()) {
        observer.disconnect();
        onCollapse();
      }
    }, 4000);

    return () => {
      cancelled = true;
      observer.disconnect();
      window.clearTimeout(retryTimer);
      window.clearTimeout(collapseTimer);
    };
    // mount に対して 1 度実行すれば十分。
    // 親が key bump するとこの effect も再実行される。
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
