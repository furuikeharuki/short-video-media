import { NextResponse } from "next/server";

const ALLOWED_EVENTS = new Set([
  "page_view",
  "age_gate_pass",
  "detail_view",
  "affiliate_click",
]);

type EventPayload = {
  event: string;
  properties?: Record<string, unknown>;
};

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

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid request body" },
      { status: 400 }
    );
  }
}