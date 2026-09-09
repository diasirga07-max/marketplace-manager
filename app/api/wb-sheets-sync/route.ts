import { NextRequest, NextResponse } from "next/server";
import { readSheetValues, writeSheetValues } from "@/lib/google-sheets";
import {
  fetchWildberriesSnapshots,
  resolveAstanaDestination,
} from "@/lib/wildberries-public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DEFAULT_SPREADSHEET_ID = "1dLU5KOi3WBLy3uNEiqGv5rf9ka0OwcEw_RjhDQW3H1E";
const DEFAULT_SHEET_NAME = "Прайс KASPI";
const WB_URL_COLUMN = "T";
const STATUS_VERSION = "Vercel WB→Sheets V1";

function authorize(request: NextRequest): boolean {
  const expected = (process.env.WB_SYNC_SECRET || process.env.CRON_SECRET || "").trim();
  if (!expected) return true;
  const auth = request.headers.get("authorization") || "";
  return auth === `Bearer ${expected}`;
}

function extractNmId(value: unknown): number | null {
  const text = String(value || "").trim();
  if (!text) return null;

  if (/^\d{5,15}$/.test(text)) return Number(text);

  const patterns = [
    /\/catalog\/(\d{5,15})(?:\/|\?|$)/i,
    /[?&](?:nm|card|article)=(\d{5,15})(?:&|$)/i,
    /\/product\/[^/]+\/(\d{5,15})(?:\/|\?|$)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1]);
  }

  return null;
}

function astanaTimestamp(): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Asia/Almaty",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .format(new Date())
    .replace(",", "");
}

function deliveryDate(days: number): string {
  const target = new Date(Date.now() + days * 86_400_000);
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Asia/Almaty",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(target);
}

function formatRub(value: number): string {
  return `${new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value)} ₽`;
}

function normalizeRow(row: unknown[]): unknown[] {
  return Array.from({ length: 6 }, (_, index) => row[index] ?? "");
}

async function runSync(request: NextRequest) {
  if (!authorize(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const spreadsheetId =
    process.env.GOOGLE_SPREADSHEET_ID?.trim() || DEFAULT_SPREADSHEET_ID;
  const sheetName = process.env.GOOGLE_SHEET_NAME?.trim() || DEFAULT_SHEET_NAME;
  const timestamp = astanaTimestamp();

  try {
    // Read T:Y once. All WB network work happens on Vercel; Sheets is updated in one write.
    const sourceRows = await readSheetValues(
      spreadsheetId,
      `'${sheetName.replace(/'/g, "''")}'!${WB_URL_COLUMN}2:Y`,
    );

    const rows = sourceRows.map(normalizeRow);
    const rowIds = rows.map((row) => extractNmId(row[0]));
    const nmIds = rowIds.filter((id): id is number => Boolean(id));

    if (!nmIds.length) {
      return NextResponse.json({
        ok: true,
        updated: 0,
        message: "В колонке T нет ссылок Wildberries",
        durationMs: Date.now() - startedAt,
      });
    }

    const destination = await resolveAstanaDestination();
    const { snapshots, failedIds, batchErrors } = await fetchWildberriesSnapshots(
      nmIds,
      destination,
    );

    let updated = 0;
    let missing = 0;
    let invalidLinks = 0;

    // U:Y output. Existing values are retained on transient WB errors.
    const output = rows.map((row, index) => {
      const oldPrice = row[1] ?? "";
      const oldSeller = row[2] ?? "";
      const oldDays = row[3] ?? "";
      const oldDate = row[4] ?? "";
      const oldStatus = row[5] ?? "";
      const link = String(row[0] || "").trim();

      if (!link) return [oldPrice, oldSeller, oldDays, oldDate, oldStatus];

      const nmId = rowIds[index];
      if (!nmId) {
        invalidLinks += 1;
        return [
          oldPrice,
          oldSeller,
          oldDays,
          oldDate,
          `Некорректная ссылка WB; ${STATUS_VERSION}; ${timestamp}`,
        ];
      }

      const snapshot = snapshots.get(nmId);
      if (!snapshot) {
        missing += 1;
        const reason = failedIds.has(nmId)
          ? "Цена не найдена / WB временно не ответил"
          : "Цена не найдена";
        return [
          oldPrice,
          oldSeller,
          oldDays,
          oldDate,
          `${reason}; ${STATUS_VERSION}; ${timestamp}`,
        ];
      }

      updated += 1;
      const days = snapshot.deliveryDays;
      const status = [
        `Обновлено ${STATUS_VERSION}`,
        "card.v4 batch",
        `товар=${snapshot.productPriceRub}`,
        `логистика=${snapshot.logisticsRub}`,
        `dest=${destination}`,
        timestamp,
      ].join("; ");

      return [
        formatRub(snapshot.finalPriceRub),
        snapshot.seller || oldSeller,
        days ?? oldDays,
        days ? deliveryDate(days) : oldDate,
        status,
      ];
    });

    if (output.length) {
      await writeSheetValues(
        spreadsheetId,
        `'${sheetName.replace(/'/g, "''")}'!U2:Y${output.length + 1}`,
        output,
      );
    }

    return NextResponse.json({
      ok: true,
      version: STATUS_VERSION,
      spreadsheetId,
      sheetName,
      destination,
      totalRows: rows.length,
      wbLinks: nmIds.length,
      updated,
      missing,
      invalidLinks,
      batchErrors: [...new Set(batchErrors)].slice(0, 10),
      durationMs: Date.now() - startedAt,
      updatedAt: timestamp,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("WB Sheets sync failed", error);
    return NextResponse.json(
      {
        ok: false,
        version: STATUS_VERSION,
        error: message,
        durationMs: Date.now() - startedAt,
      },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest) {
  return runSync(request);
}

export async function POST(request: NextRequest) {
  return runSync(request);
}
