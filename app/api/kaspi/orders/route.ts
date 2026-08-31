import { NextResponse } from "next/server";
import { kaspiRequest } from "@/lib/kaspi";

export async function GET() {
  try {
    const data = await kaspiRequest<unknown>("/orders?page[number]=0&page[size]=20");
    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
