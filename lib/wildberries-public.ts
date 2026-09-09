export type WildberriesSnapshot = {
  nmId: number;
  seller: string;
  productPriceRub: number;
  logisticsRub: number;
  finalPriceRub: number;
  deliveryDays: number | null;
};

type WbStock = {
  qty?: number;
  time1?: number;
  time2?: number;
};

type WbSize = {
  price?: {
    product?: number;
    logistics?: number;
    basic?: number;
  };
  stocks?: WbStock[];
  time1?: number;
  time2?: number;
};

type WbProduct = {
  id?: number;
  supplier?: string;
  supplierId?: number;
  totalQuantity?: number;
  time1?: number;
  time2?: number;
  sizes?: WbSize[];
};

type WbPayload = {
  products?: WbProduct[];
  data?: { products?: WbProduct[] };
};

const WB_CARD_URL = "https://card.wb.ru/cards/v4/detail";
const WB_GEO_URL = "https://user-geo-data.wildberries.ru/get-geo-info";
const DEFAULT_ASTANA_LAT = 51.169392;
const DEFAULT_ASTANA_LON = 71.449074;
const MAX_BATCH = 25;

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : null;
}

function nonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0;
}

function extractDeliveryHours(size: WbSize, product: WbProduct): number | null {
  const sizeTime1 = nonNegativeInt(size.time1);
  const sizeTime2 = nonNegativeInt(size.time2);
  if (sizeTime1 || sizeTime2) return sizeTime1 + sizeTime2;

  const productTime1 = nonNegativeInt(product.time1);
  const productTime2 = nonNegativeInt(product.time2);
  if (productTime1 || productTime2) return productTime1 + productTime2;

  const stocks = Array.isArray(size.stocks) ? size.stocks : [];
  const available = stocks.filter((stock) => nonNegativeInt(stock.qty) > 0);
  const candidates = available.length ? available : stocks;
  const hours = candidates
    .map((stock) => nonNegativeInt(stock.time1) + nonNegativeInt(stock.time2))
    .filter((value) => value > 0);
  return hours.length ? Math.min(...hours) : null;
}

function parseProduct(product: WbProduct): WildberriesSnapshot | null {
  const nmId = positiveInt(product.id);
  if (!nmId) return null;

  const sizes = Array.isArray(product.sizes) ? product.sizes : [];
  const candidates = sizes
    .map((size) => {
      const productPrice = positiveInt(size.price?.product);
      if (!productPrice) return null;
      const logistics = nonNegativeInt(size.price?.logistics);
      const stockQty = (Array.isArray(size.stocks) ? size.stocks : []).reduce(
        (sum, stock) => sum + nonNegativeInt(stock.qty),
        0,
      );
      return {
        size,
        available: stockQty > 0,
        productPrice,
        logistics,
        total: productPrice + logistics,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  if (!candidates.length) return null;
  const available = candidates.filter((item) => item.available);
  const pool = available.length ? available : candidates;
  const selected = pool.reduce((best, item) =>
    item.total < best.total ? item : best,
  );

  const deliveryHours = extractDeliveryHours(selected.size, product);
  return {
    nmId,
    seller: String(product.supplier || "").trim(),
    productPriceRub: selected.productPrice / 100,
    logisticsRub: selected.logistics / 100,
    finalPriceRub: selected.total / 100,
    deliveryDays:
      deliveryHours && deliveryHours > 0
        ? Math.max(1, Math.ceil(deliveryHours / 24))
        : null,
  };
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    result.push(values.slice(i, i + size));
  }
  return result;
}

async function wbFetch(url: URL): Promise<Response> {
  return fetch(url, {
    headers: {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "ru-RU,ru;q=0.9",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    },
    cache: "no-store",
  });
}

export async function resolveAstanaDestination(): Promise<number> {
  const configured = Number(process.env.WB_DESTINATION || "");
  const fallback = Number.isInteger(configured) && configured !== 0 ? configured : null;

  const latitude = Number(process.env.WB_ASTANA_LAT || DEFAULT_ASTANA_LAT);
  const longitude = Number(process.env.WB_ASTANA_LON || DEFAULT_ASTANA_LON);
  const url = new URL(WB_GEO_URL);
  url.searchParams.set("latitude", latitude.toFixed(6));
  url.searchParams.set("longitude", longitude.toFixed(6));
  url.searchParams.set("address", "Astana, Kazakhstan");

  try {
    const response = await wbFetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = (await response.json()) as { xinfo?: string };
    if (!payload.xinfo) throw new Error("xinfo отсутствует");
    const params = new URLSearchParams(payload.xinfo);
    const destination = Number(params.get("dest"));
    if (!Number.isInteger(destination) || destination === 0) {
      throw new Error("dest отсутствует");
    }
    return destination;
  } catch (error) {
    if (fallback) return fallback;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Не удалось определить WB GEO для Астаны (${message}). Задайте WB_DESTINATION в Vercel.`,
    );
  }
}

async function fetchChunk(
  nmIds: number[],
  destination: number,
): Promise<Map<number, WildberriesSnapshot>> {
  const url = new URL(WB_CARD_URL);
  url.searchParams.set("appType", "1");
  url.searchParams.set("curr", "rub");
  url.searchParams.set("dest", String(destination));
  url.searchParams.set("spp", "30");
  url.searchParams.set("hide_vflags", "4294967296");
  url.searchParams.set("hide_dtype", "15");
  url.searchParams.set("mtype", "257");
  url.searchParams.set("lang", "ru");
  url.searchParams.set("ab_testing", "false");
  url.searchParams.set("nm", nmIds.join(";"));

  const response = await wbFetch(url);
  if (!response.ok) {
    throw new Error(`WB card API ${response.status}`);
  }

  const payload = (await response.json()) as WbPayload;
  const products = Array.isArray(payload.products)
    ? payload.products
    : Array.isArray(payload.data?.products)
      ? payload.data.products
      : null;
  if (!products) throw new Error("WB вернул неизвестный формат cards/v4");

  const result = new Map<number, WildberriesSnapshot>();
  for (const product of products) {
    const parsed = parseProduct(product);
    if (parsed) result.set(parsed.nmId, parsed);
  }
  return result;
}

export async function fetchWildberriesSnapshots(
  nmIds: number[],
  destination: number,
): Promise<{
  snapshots: Map<number, WildberriesSnapshot>;
  failedIds: Set<number>;
  batchErrors: string[];
}> {
  const unique = [...new Set(nmIds.filter((id) => Number.isInteger(id) && id > 0))];
  const batches = chunks(unique, MAX_BATCH);
  const snapshots = new Map<number, WildberriesSnapshot>();
  const failedIds = new Set<number>();
  const batchErrors: string[] = [];

  // Four parallel batches keeps the function fast without hammering WB.
  for (let i = 0; i < batches.length; i += 4) {
    const group = batches.slice(i, i + 4);
    const settled = await Promise.allSettled(
      group.map((batch) => fetchChunk(batch, destination)),
    );

    settled.forEach((entry, index) => {
      const batch = group[index];
      if (entry.status === "fulfilled") {
        for (const [id, snapshot] of entry.value) snapshots.set(id, snapshot);
        for (const id of batch) {
          if (!entry.value.has(id)) failedIds.add(id);
        }
      } else {
        batch.forEach((id) => failedIds.add(id));
        batchErrors.push(
          entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
        );
      }
    });
  }

  return { snapshots, failedIds, batchErrors };
}
