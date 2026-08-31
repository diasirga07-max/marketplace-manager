import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    kaspiConfigured: Boolean(process.env.KASPI_API_KEY),
    databaseConfigured: Boolean(process.env.DATABASE_URL),
    baseUrl: process.env.KASPI_API_BASE_URL ?? "https://kaspi.kz/shop/api/v2"
  });
}
