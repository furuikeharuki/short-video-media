export type AnalyticsEventName =
  | "page_view"
  | "age_gate_pass"
  | "detail_view"
  | "affiliate_click";

export type AnalyticsProperties = Record<string, unknown>;

export async function trackEvent(
  event: AnalyticsEventName,
  properties: AnalyticsProperties = {}
) {
  try {
    await fetch("/api/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        event,
        properties,
      }),
      keepalive: true,
    });
  } catch (error) {
    console.error("Failed to track event", error);
  }
}