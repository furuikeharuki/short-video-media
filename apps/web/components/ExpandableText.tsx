"use client";

import { useState } from "react";

interface Props {
  text: string;
  /** 折りたたみ時に表示する行数。 */
  clampLines?: number;
  /** これを超える長さ (または改行数) のときだけ「続きを見る」を出す。 */
  collapseThreshold?: number;
}

/**
 * 長文を指定行数でクランプし、「続きを見る」/「閉じる」で開閉するテキスト。
 * 作品紹介 (DMM 由来の説明文など) を詳細ページ・モーダル双方で共通利用する。
 * 短いテキストのときはトグルを出さずそのまま表示する。
 */
export default function ExpandableText({
  text,
  clampLines = 5,
  collapseThreshold = 140,
}: Props) {
  const [expanded, setExpanded] = useState(false);

  const newlineCount = (text.match(/\n/g) ?? []).length;
  const collapsible =
    text.length > collapseThreshold || newlineCount >= clampLines;

  if (!collapsible) {
    return <p className="expandable-text">{text}</p>;
  }

  return (
    <div>
      <p
        className={`expandable-text${expanded ? "" : " expandable-text--clamped"}`}
        style={{ ["--clamp-lines" as string]: String(clampLines) } as React.CSSProperties}
      >
        {text}
      </p>
      <button
        type="button"
        className="expandable-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? "閉じる" : "続きを見る"}
      </button>

      <style>{`
        .expandable-text {
          font-size: 14px; line-height: 1.85; color: rgba(255,255,255,0.78);
          white-space: pre-wrap; margin: 0;
        }
        .expandable-text--clamped {
          display: -webkit-box;
          -webkit-box-orient: vertical;
          -webkit-line-clamp: var(--clamp-lines, 5);
          overflow: hidden;
        }
        .expandable-toggle {
          margin-top: 8px; padding: 0;
          background: none; border: none;
          color: #7cb7ff; font-size: 13px; font-weight: 600;
          cursor: pointer;
        }
        .expandable-toggle:active { opacity: 0.7; }
      `}</style>
    </div>
  );
}
