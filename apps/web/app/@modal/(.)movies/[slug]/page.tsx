import { notFound } from "next/navigation";
import { getMovieBySlug } from "@/lib/api/movies";
import MovieModal from "./MovieModal";

type PageProps = {
  params: Promise<{ slug: string }>;
};

export default async function InterceptedMoviePage({ params }: PageProps) {
  const { slug } = await params;

  try {
    const movie = await getMovieBySlug(slug);
    return <MovieModal movie={movie} />;
  } catch (error) {
    if (error instanceof Error && error.message === "NOT_FOUND") notFound();
    throw error;
  }
}
