import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import ActressBackButton from "@/components/ActressBackButton";
import { getActressByName } from "@/lib/api/actresses";
import SearchGrid from "@/app/search/SearchGrid";

const SITE_NAME = "AV Shorts";
const SITE_URL = "https://av-shorts.com";
const NA = "----";

type PageProps = {
  params: Promise<{ name: string }>;
};

function formatBirthday(s: string | null): string {
  if (!s) return NA;
  const d = new Date(s);
  if (isNaN(d.getTime())) return NA;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function calcAge(s: string | null): number | null {
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - d.getFullYear();
  const m = today.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < d.getDate())) age--;
  return age >= 0 ? age : null;
}

function threeSize(bust: number | null, waist: number | null, hip: number | null): string {
  if (bust == null && waist == null && hip == null) return NA;
  const f = (v: number | null) => (v == null ? "?" : String(v));
  return `B${f(bust)} / W${f(waist)} / H${f(hip)}`;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  try {
    const { name } = await params;
    const decoded = decodeURIComponent(name);
    const detail = await getActressByName(decoded);
    const title = `${detail.profile.name} の出演作品一覧 | ${SITE_NAME}`;
    const description = `${detail.profile.name}の出演作品 ${detail.stats.movie_count}件。プロフィール、スリーサイズ、代表ジャンルをまとめています。`;
    const image = detail.profile.image_url_large ?? detail.profile.image_url_small ?? detail.profile.thumbnail_url ?? "";
    const canonical = `${SITE_URL}/actresses/${encodeURIComponent(detail.profile.name)}`;
    return {
      title,
      description,
      alternates: { canonical },
      openGraph: {
        type: "profile",
        url: canonical,
        title,
        description,
        images: image ? [{ url: image, alt: detail.profile.name }] : [],
        siteName: SITE_NAME,
        locale: "ja_JP",
      },
      twitter: {
        card: "summary_large_image",
        title,
        description,
        images: image ? [image] : [],
      },
    };
  } catch {
    return { title: SITE_NAME };
  }
}

export default async function ActressDetailPage({ params }: PageProps) {
  const { name } = await params;
  const decoded = decodeURIComponent(name);

  let detail;
  try {
    detail = await getActressByName(decoded);
  } catch (e) {
    if (e instanceof Error && e.message === "NOT_FOUND") notFound();
    throw e;
  }

  const { profile, stats, movies, goods } = detail;
  const heroImg = profile.image_url_large ?? profile.image_url_small ?? profile.thumbnail_url ?? "";
  const age = calcAge(profile.birthday);

  const profileRows: { label: string; value: React.ReactNode }[] = [
    { label: "読み", value: profile.ruby ?? NA },
    {
      label: "生年月日",
      value: profile.birthday
        ? `${formatBirthday(profile.birthday)}${age != null ? ` (${age}歳)` : ""}`
        : NA,
    },
    { label: "出身地", value: profile.prefectures ?? NA },
    { label: "血液型", value: profile.blood_type ? `${profile.blood_type}型` : NA },
    { label: "身長", value: profile.height != null ? `${profile.height}cm` : NA },
    { label: "スリーサイズ", value: threeSize(profile.bust, profile.waist, profile.hip) },
    { label: "カップ", value: profile.cup ?? NA },
    { label: "趣味", value: profile.hobby ?? NA },
  ];

  return (
    <main style={styles.main}>
      <div style={styles.topBar}>
        <ActressBackButton />
      </div>

      <div style={styles.body}>
        <div style={styles.profileHeader}>
          {heroImg ? (
            <img
              src={heroImg}
              alt={profile.name}
              style={styles.avatar}
              loading="eager"
              width={108}
              height={108}
            />
          ) : (
            <div style={styles.avatarPlaceholder}>No Image</div>
          )}
          <h1 style={styles.name}>{profile.name}</h1>
          {profile.ruby && <p style={styles.ruby}>{profile.ruby}</p>}
        </div>

        <div style={styles.statsRow}>
          <div style={styles.statBox}>
            <div style={styles.statValue}>{stats.movie_count}</div>
            <div style={styles.statLabel}>出演本数</div>
          </div>
          {stats.average_review != null && (
            <div style={styles.statBox}>
              <div style={styles.statValue}>{stats.average_review.toFixed(1)}</div>
              <div style={styles.statLabel}>平均評価</div>
            </div>
          )}
          {stats.total_review_count > 0 && (
            <div style={styles.statBox}>
              <div style={styles.statValue}>{stats.total_review_count.toLocaleString()}</div>
              <div style={styles.statLabel}>累計レビュー</div>
            </div>
          )}
        </div>

        <section style={styles.section}>
          <h2 style={styles.sectionTitle}>プロフィール</h2>
          <div style={styles.profileTable}>
            {profileRows.map(({ label, value }) => (
              <div key={label} style={styles.profileRow}>
                <span style={styles.profileLabel}>{label}</span>
                <span style={styles.profileValue}>{value}</span>
              </div>
            ))}
          </div>
        </section>

        {(stats.top_genres.length > 0 || stats.top_makers.length > 0) && (
          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>傾向</h2>
            {stats.top_genres.length > 0 && (
              <div style={styles.tagBlock}>
                <span style={styles.tagBlockLabel}>よく出るジャンル</span>
                <div style={styles.tagList}>
                  {stats.top_genres.map((g) => (
                    <Link
                      key={g}
                      href={`/search?genre=${encodeURIComponent(g)}`}
                      style={styles.tag}
                      prefetch={false}
                    >
                      #{g}
                    </Link>
                  ))}
                </div>
              </div>
            )}
            {stats.top_makers.length > 0 && (
              <div style={styles.tagBlock}>
                <span style={styles.tagBlockLabel}>主なメーカー</span>
                <div style={styles.tagList}>
                  {stats.top_makers.map((m) => (
                    <Link
                      key={m}
                      href={`/search?maker=${encodeURIComponent(m)}`}
                      style={styles.tag}
                      prefetch={false}
                    >
                      {m}
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}

        {profile.dmm_list_url && (
          <section style={styles.section}>
            <a
              href={profile.dmm_list_url}
              target="_blank"
              rel="noopener noreferrer sponsored"
              style={styles.extLink}
            >
              FANZA で {profile.name} の作品をすべて見る
            </a>
          </section>
        )}

        <section style={styles.section}>
          <h2 style={styles.sectionTitle}>出演作品 ({movies.length})</h2>
          {movies.length === 0 ? (
            <p style={styles.empty}>出演作品が見つかりませんでした</p>
          ) : (
            <SearchGrid
              items={movies}
              playlistKey={`actress-${profile.id}`}
              playlistTitle={`${profile.name}の出演作品`}
            />
          )}
        </section>

        {goods.length > 0 && (
          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>関連商品 ({goods.length})</h2>
            <div className="goods-grid">
              {goods.map((g) => {
                const img = g.image_url_large ?? g.image_url_list ?? "";
                return (
                  <a
                    key={g.id}
                    href={g.affiliate_url}
                    target="_blank"
                    rel="noopener noreferrer sponsored"
                    style={styles.goodsCard}
                    title={g.title}
                  >
                    <div style={styles.goodsThumbWrap}>
                      {img ? (
                        <img
                          src={img}
                          alt={g.title}
                          loading="lazy"
                          style={styles.goodsThumb}
                        />
                      ) : (
                        <div style={styles.goodsThumbPlaceholder}>No Image</div>
                      )}
                    </div>
                    <div style={styles.goodsTitle}>{g.title}</div>
                    {g.price_min != null && (
                      <div style={styles.goodsPrice}>¥{g.price_min.toLocaleString()}</div>
                    )}
                  </a>
                );
              })}
            </div>
          </section>
        )}
      </div>
      <style>{pageCSS}</style>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    position: "fixed" as const,
    top: "52px",
    left: 0,
    right: 0,
    bottom: 0,
    overflowY: "auto" as const,
    background: "#0a0a0a",
    color: "#fff",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
  topBar: {
    position: "relative" as const,
    width: "100%",
    height: "56px",
    flexShrink: 0,
  },
  body: {
    padding: "4px 16px 80px",
  },
  profileHeader: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center" as const,
    gap: "10px",
    marginBottom: "20px",
    paddingTop: "4px",
  },
  avatar: {
    width: "108px",
    height: "108px",
    objectFit: "cover" as const,
    borderRadius: "50%",
    border: "2px solid rgba(255,255,255,0.12)",
    background: "#111",
    display: "block",
  },
  avatarPlaceholder: {
    width: "108px",
    height: "108px",
    borderRadius: "50%",
    background: "#1a1a1a",
    border: "2px solid rgba(255,255,255,0.08)",
    color: "rgba(255,255,255,0.35)",
    fontSize: "11px",
    display: "flex",
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  name: {
    fontSize: "clamp(20px, 5.5vw, 26px)",
    fontWeight: 700,
    lineHeight: 1.3,
    color: "#fff",
    textAlign: "center" as const,
    margin: 0,
  },
  ruby: {
    fontSize: "12px",
    color: "rgba(255,255,255,0.45)",
    textAlign: "center" as const,
    margin: 0,
  },
  statsRow: {
    display: "flex",
    gap: "12px",
    marginBottom: "24px",
    flexWrap: "wrap" as const,
  },
  statBox: {
    flex: "1 1 0",
    minWidth: "84px",
    padding: "12px 8px",
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: "10px",
    textAlign: "center" as const,
  },
  statValue: {
    fontSize: "20px",
    fontWeight: 700,
    color: "#fff",
    lineHeight: 1.2,
  },
  statLabel: {
    fontSize: "10px",
    color: "rgba(255,255,255,0.45)",
    marginTop: "4px",
    letterSpacing: "0.05em",
  },
  section: {
    marginBottom: "28px",
  },
  sectionTitle: {
    fontSize: "13px",
    fontWeight: 700,
    color: "rgba(255,255,255,0.5)",
    letterSpacing: "0.08em",
    marginBottom: "12px",
    textTransform: "uppercase" as const,
  },
  profileTable: {
    display: "flex",
    flexDirection: "column" as const,
    borderTop: "1px solid rgba(255,255,255,0.08)",
  },
  profileRow: {
    display: "flex",
    alignItems: "flex-start" as const,
    gap: "12px",
    padding: "10px 0",
    borderBottom: "1px solid rgba(255,255,255,0.06)",
  },
  profileLabel: {
    fontSize: "11px",
    fontWeight: 600,
    color: "rgba(255,255,255,0.35)",
    letterSpacing: "0.06em",
    minWidth: "84px",
    paddingTop: "1px",
    flexShrink: 0,
  },
  profileValue: {
    fontSize: "13px",
    color: "rgba(255,255,255,0.78)",
    lineHeight: 1.6,
  },
  tagBlock: {
    marginBottom: "14px",
  },
  tagBlockLabel: {
    display: "block",
    fontSize: "11px",
    color: "rgba(255,255,255,0.4)",
    marginBottom: "8px",
  },
  tagList: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: "6px",
  },
  tag: {
    display: "inline-block",
    background: "rgba(124,183,255,0.12)",
    border: "1px solid rgba(124,183,255,0.3)",
    color: "#7cb7ff",
    fontSize: "12px",
    fontWeight: 600,
    padding: "4px 10px",
    borderRadius: "999px",
    textDecoration: "none",
  },
  extLink: {
    display: "block",
    width: "100%",
    padding: "12px 16px",
    background: "rgba(233,30,99,0.12)",
    border: "1px solid rgba(233,30,99,0.4)",
    color: "#ff6b9a",
    fontSize: "13px",
    fontWeight: 600,
    borderRadius: "10px",
    textAlign: "center" as const,
    textDecoration: "none",
  },
  empty: {
    fontSize: "13px",
    color: "rgba(255,255,255,0.4)",
    textAlign: "center" as const,
    padding: "20px 0",
  },
  goodsCard: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "6px",
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: "10px",
    padding: "8px",
    textDecoration: "none",
    color: "#fff",
  },
  goodsThumbWrap: {
    width: "100%",
    aspectRatio: "1 / 1",
    overflow: "hidden",
    borderRadius: "6px",
    background: "#111",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  goodsThumb: {
    width: "100%",
    height: "100%",
    objectFit: "contain" as const,
    display: "block",
  },
  goodsThumbPlaceholder: {
    color: "rgba(255,255,255,0.3)",
    fontSize: "11px",
  },
  goodsTitle: {
    fontSize: "11px",
    lineHeight: 1.4,
    color: "rgba(255,255,255,0.85)",
    display: "-webkit-box",
    WebkitBoxOrient: "vertical" as const,
    WebkitLineClamp: 2,
    overflow: "hidden",
  },
  goodsPrice: {
    fontSize: "12px",
    fontWeight: 700,
    color: "#ff6b9a",
  },
};

const pageCSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: #0a0a0a !important; overflow: hidden !important; }
  .search-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
    padding: 8px 0 0;
  }
  .search-grid > .mct { width: 100%; min-width: 0; }
  @media (min-width: 640px) {
    .search-grid { grid-template-columns: repeat(5, minmax(0, 1fr)); }
  }
  @media (min-width: 1024px) {
    .search-grid {
      grid-template-columns: repeat(7, minmax(0, 1fr));
    }
  }
  .goods-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
    padding: 8px 0 0;
  }
  @media (min-width: 640px) {
    .goods-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  }
  @media (min-width: 1024px) {
    .goods-grid { grid-template-columns: repeat(6, minmax(0, 1fr)); }
  }
`;
