import { Suspense } from "react";
import ModalShell from "./ModalShell";
import MovieDetailContent from "./MovieDetailContent";
import ModalContentSkeleton from "./ModalContentSkeleton";

type PageProps = {
  params: Promise<{ slug: string }>;
};

export default async function InterceptedMoviePage({ params }: PageProps) {
  const { slug } = await params;

  return (
    <ModalShell>
      <Suspense fallback={<ModalContentSkeleton />}>
        <MovieDetailContent slug={slug} />
      </Suspense>
    </ModalShell>
  );
}
