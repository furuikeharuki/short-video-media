import Link from "next/link";
import { notFound } from "next/navigation";

import AffiliateLink from "@/components/analytics/affiliate-link";
import DetailViewTracker from "@/components/analytics/detail-view-tracker";
import { getMovieBySlug } from "@/lib/api/movies";

type PageProps = {
  params: Promise<{
    slug: string;
  }>;
};

export default async function MovieDetailPage({ params }: PageProps) {
  const { slug } = await params;

  try {
    const movie = await getMovieBySlug(slug);

    return (
      <main style={{ padding: "24px" }}>
        <DetailViewTracker slug={movie.slug} title={movie.title} />

        <p>
          <Link href="/">← Feed に戻る</Link>
        </p>

        <h1>{movie.title}</h1>
        <p>slug: {movie.slug}</p>
        <p>{movie.description}</p>
        <p>actresses: {movie.actresses.join(", ")}</p>
        <p>genres: {movie.genres.join(", ")}</p>

        <p>
          <AffiliateLink
            href={movie.affiliate_url}
            slug={movie.slug}
            title={movie.title}
          />
        </p>
      </main>
    );
  } catch (error) {
    if (error instanceof Error && error.message === "NOT_FOUND") {
      notFound();
    }

    throw error;
  }
}