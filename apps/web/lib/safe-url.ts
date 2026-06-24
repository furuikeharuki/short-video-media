export function normalizeSafeExternalHref(href: unknown): string {
  if (typeof href !== "string") return "";
  const trimmed = href.trim();
  if (!trimmed) return "";

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return url.toString();
  } catch {
    return "";
  }
}
