"use client";

import { ReactNode } from "react";

type Props = {
  title: string;
  subtitle?: string | null;
  /** 右上に表示するアクションリンク (例: もっと見る) */
  action?: { label: string; href: string };
  /** ランキング順位を表示するか */
  ranked?: boolean;
  children: ReactNode;
};

export default function HorizontalCardRow({
  title,
  subtitle,
  action,
  children,
}: Props) {
  return (
    <section className="hcr">
      <header className="hcr-header">
        <div className="hcr-titles">
          <h2 className="hcr-title">{title}</h2>
          {subtitle && <p className="hcr-subtitle">{subtitle}</p>}
        </div>
        {action && (
          <a className="hcr-action" href={action.href}>
            {action.label}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
              aria-hidden="true">
              <path d="M9 6l6 6-6 6" />
            </svg>
          </a>
        )}
      </header>

      <div className="hcr-scroller">
        <div className="hcr-track">{children}</div>
      </div>

      <style>{styles}</style>
    </section>
  );
}

const styles = `
  .hcr {
    padding: 18px 0 8px;
  }
  .hcr-header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    padding: 0 16px;
    margin-bottom: 10px;
    gap: 12px;
  }
  .hcr-titles { min-width: 0; }
  .hcr-title {
    margin: 0;
    font-size: 17px;
    font-weight: 800;
    color: #fff;
    letter-spacing: -0.01em;
    line-height: 1.2;
  }
  .hcr-subtitle {
    margin: 4px 0 0;
    font-size: 11px;
    color: rgba(255,255,255,0.45);
    line-height: 1.2;
  }
  .hcr-action {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 2px;
    font-size: 12px;
    color: rgba(255,255,255,0.7);
    text-decoration: none;
    white-space: nowrap;
    -webkit-tap-highlight-color: transparent;
  }
  .hcr-action:hover { color: #fff; }

  .hcr-scroller {
    overflow-x: auto;
    overflow-y: hidden;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior-x: contain;
    scrollbar-width: none;
  }
  .hcr-scroller::-webkit-scrollbar { display: none; }

  .hcr-track {
    display: flex;
    flex-wrap: nowrap;
    gap: 12px;
    padding: 0 16px;
  }
`;
