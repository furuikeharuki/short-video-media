import { NextResponse } from "next/server";

const ALLOWED_EVENTS = new Set([
  "page_view",
  "age_gate_pass",
  "detail_view",
  "affiliate_click",
  "video_play",
  "video_complete",
  "scroll_depth",
  "search",
]);

type EventPayload = {
  event: string;
  properties?: Record<string, unknown>;
};

async function sendToGA4(event: string, properties: Record<string, unknown>) {
  const GA_MEASUREMENT_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;
  const GA_API_SECRET = process.env.GA_API_SECRET;

  if (!GA_MEASUREMENT_ID || !GA_API_SECRET) return;

  await fetch(
    `https://www.google-analytics.com/mp/collect?measurement_id=${GA_MEASUREMENT_ID}&api_secret=${GA_API_SECRET}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: properties.client_id ?? "anonymous",
        events: [
          {
            name: event,
            params: {
              ...properties,
              engagement_time_msec: 100,
            },
          },
        ],
      }),
    }
  );
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as EventPayload;

    if (!body?.event || !ALLOWED_EVENTS.has(body.event)) {
      return NextResponse.json(
        { ok: false, error: "Invalid event name" },
        { status: 400 }
      );
    }

    const payload = {
      event: body.event,
      properties: body.properties ?? {},
      timestamp: new Date().toISOString(),
    };

    console.log("[analytics]", JSON.stringify(payload));

    // GA4に送信
    await sendToGA4(payload.event, payload.properties);

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid request body" },
      { status: 400 }
    );
  }
}
