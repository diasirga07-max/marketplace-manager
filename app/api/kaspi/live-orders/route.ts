import { NextResponse } from "next/server";
import { kaspiControlRequest, type KaspiLiveOrders } from "@/lib/kaspi-control";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await kaspiControlRequest<KaspiLiveOrders>(`/live-orders?t=${Date.now()}`);
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
