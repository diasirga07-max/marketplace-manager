const controlBaseUrl = process.env.KASPI_CONTROL_URL ?? "https://grants-book-kaspi-assistant.vercel.app/api";

export type KaspiLiveOrderRow = {
  orderCode: string;
  name: string;
  sku?: string | null;
  productCode?: string | null;
  photo?: string | null;
  stage: string;
  quantity: number;
};

export type KaspiLiveOrders = {
  counts: {
    all: number;
    preorder: number;
    packing: number;
    transfer: number;
  };
  rows: KaspiLiveOrderRow[];
  generatedAt: string;
  cached?: boolean;
};

export type KaspiStats = {
  range: {
    fromDate: string;
    toDate: string;
  };
  summary: {
    sales: number;
    delivery: number;
  };
  orders: Array<{ id: string | number }>;
};

function getToken() {
  return process.env.KASPI_API_TOKEN ?? process.env.KASPI_API_KEY;
}

export function isKaspiConfigured() {
  return Boolean(getToken());
}

export async function kaspiControlRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  if (!token) throw new Error("KASPI_API_TOKEN is not configured");

  const response = await fetch(`${controlBaseUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      "X-Access-Key": token,
      "X-Sync-Key": token,
      ...init?.headers,
    },
    cache: "no-store",
  });

  const payload = await response.json().catch(() => null) as ({ error?: string; ok?: boolean } & T) | null;
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || `Kaspi Control error: ${response.status}`);
  }

  if (!payload) throw new Error("Kaspi Control returned an empty response");
  return payload as T;
}
