"use client";

import { useEffect, useRef } from "react";
import { trackEvent } from "@/lib/analytics/analytics";

type DetailViewTrackerProps = {
  slug: string;
  title: string;
};

export default function DetailViewTracker({
  slug,
  title,
}: DetailViewTrackerProps) {
  const sentRef = useRef(false);

  useEffect(() => {
    if (sentRef.current) return;
    sentRef.current = true;

    void trackEvent("detail_view", {
      slug,
      title,
    });
  }, [slug, title]);

  return null;
}