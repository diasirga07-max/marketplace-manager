import { NextRequest, NextResponse } from "next/server";
import { kaspiControlRequest, type KaspiStats } from "@/lib/kaspi-control";

export const dynamic = "force-dynamic";

const allowedPeriods = new Set(["day", "week", "month", "halfyear", "year"]);

export async function GET(request: NextRequest) {
  const requested = request.nextUrl.searchParams.get("period") ?? "week";
  const period = allowedPeriods.has(requested) ? requested : "week";

  try {
    const data = await kaspiControlRequest<KaspiStats>(`/stats?period=${period}&t=${Date.now()}`);
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
