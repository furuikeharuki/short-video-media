import { notFound } from "next/navigation";
import { getMovieBySlug } from "@/lib/api/movies";
import MovieDetail from "./MovieDetail";

export default async function MovieDetailContent({ slug }: { slug: string }) {
  let movie;
  try {
    movie = await getMovieBySlug(slug);
  } catch (error) {
    if (error instanceof Error && error.message === "NOT_FOUND") notFound();
    throw error;
  }
  return <MovieDetail movie={movie} />;
}
