/*
 * Kaspi Shop API probe: берёт 5–10 реальных заказов за последние 30 дней,
 * печатает сырые JSON заказов и их entries (без персональных данных) и
 * сохраняет пример в docs/kaspi-sample.json.
 *
 * Запуск (Node 22.18+ выполняет .ts напрямую; на 22.6–22.17 добавьте
 * --experimental-strip-types):
 *   KASPI_API_TOKEN=… node scripts/kaspi-probe.ts [количество=8]
 *
 * Токен читается только из переменной окружения и никогда не печатается.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
type ApiList = { data?: JsonObject[]; meta?: JsonObject };

const BASE = String(process.env.KASPI_API_BASE_URL || 'https://kaspi.kz/shop/api/v2').replace(/\/$/, '');
const TOKEN = String(process.env.KASPI_API_TOKEN || '').trim();
const LIMIT = Math.max(5, Math.min(10, Number(process.argv[2]) || 8));
const DAY = 86_400_000;
const WINDOW = 14 * DAY - 1; // Kaspi: creationDate filter spans at most 14 days
const OUT = join(process.cwd(), 'docs', 'kaspi-sample.json');

// Keys that may contain personal data of buyers.
const PII_KEY = /customer|phone|cellphone|firstname|lastname|middlename|address|street|apartment|building|latitude|longitude|email|iin|passport|recipient|signature/i;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redact(value: Json, key = ''): Json {
  if (key && PII_KEY.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === 'object') {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, k);
    return out;
  }
  return value;
}

async function kaspi(path: string): Promise<JsonObject> {
  let last: unknown = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const res = await fetch(BASE + path, {
        headers: { Accept: 'application/vnd.api+json', 'Content-Type': 'application/vnd.api+json', 'X-Auth-Token': TOKEN },
        signal: AbortSignal.timeout(25_000),
      });
      const text = await res.text();
      if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`HTTP ${res.status}`), { retry: true });
      if (!res.ok) throw new Error(`HTTP ${res.status} на ${path.split('?')[0]}: ${text.slice(0, 200)}`);
      return text ? (JSON.parse(text) as JsonObject) : {};
    } catch (error) {
      last = error;
      const retry = (error as { retry?: boolean }).retry || (error as Error).name === 'TimeoutError';
      if (!retry || attempt === 3) break;
      await sleep(800 * (attempt + 1));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

async function listOrders(state: string, ge: number, le: number): Promise<JsonObject[]> {
  const out: JsonObject[] = [];
  for (let page = 0; page < 20; page += 1) {
    const q = new URLSearchParams({
      'page[number]': String(page),
      'page[size]': '100',
      'filter[orders][state]': state,
      'filter[orders][creationDate][$ge]': String(ge),
      'filter[orders][creationDate][$le]': String(le),
    });
    const payload = (await kaspi(`/orders?${q.toString()}`)) as ApiList;
    const data = Array.isArray(payload.data) ? payload.data : [];
    out.push(...data);
    if (data.length < 100) break;
    await sleep(200);
  }
  return out;
}

function attrs(o: JsonObject): JsonObject {
  const a = o.attributes;
  return a && typeof a === 'object' && !Array.isArray(a) ? (a as JsonObject) : {};
}

function fieldsOf(objects: JsonObject[]): string[] {
  const keys = new Set<string>();
  const walk = (v: Json, prefix: string): void => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, x] of Object.entries(v)) {
        const path = prefix ? `${prefix}.${k}` : k;
        keys.add(path);
        if (!PII_KEY.test(k)) walk(x, path);
      }
    }
  };
  objects.forEach((o) => walk(attrs(o), ''));
  return [...keys].sort();
}

async function main(): Promise<void> {
  if (!TOKEN) {
    console.error('Задайте KASPI_API_TOKEN в окружении (значение не печатается).');
    process.exit(2);
  }
  const now = Date.now();
  const from = now - 30 * DAY;
  const states = ['ARCHIVE', 'KASPI_DELIVERY', 'PICKUP', 'DELIVERY', 'NEW', 'SIGN_REQUIRED'];
  const all: JsonObject[] = [];
  const counts: Record<string, number> = {};
  for (const state of states) {
    for (let ge = from; ge <= now; ge += WINDOW + 1) {
      const list = await listOrders(state, ge, Math.min(now, ge + WINDOW));
      counts[state] = (counts[state] || 0) + list.length;
      all.push(...list);
      await sleep(150);
    }
  }
  console.log('Заказов за 30 дней по state:', counts);

  // Pick a varied sample: cancelled, returned, Kaspi Delivery (completed / active), completed.
  const by = (pred: (a: JsonObject) => boolean) => all.filter((o) => pred(attrs(o)));
  const buckets = [
    by((a) => a.status === 'CANCELLED' && Boolean(a.cancellationReason)),
    by((a) => a.status === 'RETURNED' || a.status === 'KASPI_DELIVERY_RETURN_REQUESTED'),
    by((a) => a.isKaspiDelivery === true && a.status === 'COMPLETED'),
    by((a) => a.isKaspiDelivery === true && a.state === 'KASPI_DELIVERY'),
    by((a) => a.status === 'COMPLETED'),
    all,
  ];
  const picked = new Map<string, JsonObject>();
  for (let round = 0; picked.size < LIMIT && round < 5; round += 1) {
    for (const bucket of buckets) {
      const candidate = bucket.find((o) => !picked.has(String(o.id)));
      if (candidate && picked.size < LIMIT) picked.set(String(candidate.id), candidate);
    }
  }

  const samples: JsonObject[] = [];
  for (const order of picked.values()) {
    const entries = ((await kaspi(`/orders/${encodeURIComponent(String(order.id))}/entries`)) as ApiList).data || [];
    const products: JsonObject[] = [];
    for (const entry of entries) {
      const rel = entry.relationships as JsonObject | undefined;
      const productRel = rel && (rel.product as JsonObject | undefined);
      const masterId = productRel && productRel.data && typeof productRel.data === 'object' && !Array.isArray(productRel.data)
        ? String((productRel.data as JsonObject).id || '') : '';
      let merchant: JsonObject | null = null;
      if (masterId) {
        try { merchant = await kaspi(`/masterproducts/${encodeURIComponent(masterId)}/merchantProduct`); } catch (error) { merchant = { error: (error as Error).message }; }
      }
      products.push({ entryId: String(entry.id), masterProductId: masterId, merchantProduct: merchant });
      await sleep(150);
    }
    const sample = redact({ order, entries, products } as unknown as Json) as JsonObject;
    console.log('\n===== Заказ', attrs(order).code, '=====');
    console.log(JSON.stringify(sample, null, 2));
    samples.push(sample);
  }

  const orderFields = fieldsOf(all.slice(0, 500));
  const entryFields = fieldsOf(samples.flatMap((s) => (Array.isArray(s.entries) ? (s.entries as JsonObject[]) : [])));
  const reasons: Record<string, number> = {};
  const statuses: Record<string, number> = {};
  for (const o of all) {
    const a = attrs(o);
    statuses[String(a.status || '—')] = (statuses[String(a.status || '—')] || 0) + 1;
    if (a.cancellationReason) reasons[String(a.cancellationReason)] = (reasons[String(a.cancellationReason)] || 0) + 1;
  }
  const kd = all.filter((o) => attrs(o).isKaspiDelivery === true);
  const kdField = (name: string) => kd.filter((o) => {
    const k = attrs(o).kaspiDelivery;
    return k && typeof k === 'object' && !Array.isArray(k) && (k as JsonObject)[name] != null;
  }).length;

  const report = {
    generatedAt: new Date().toISOString(),
    source: 'scripts/kaspi-probe.ts → Kaspi Shop API v2 (персональные данные покупателей удалены)',
    window: { from: new Date(from).toISOString(), to: new Date(now).toISOString() },
    countsByState: counts,
    statuses,
    cancellationReasons: reasons,
    kaspiDelivery: {
      orders: kd.length,
      withCourierTransmissionPlanningDate: kdField('courierTransmissionPlanningDate'),
      withCourierTransmissionDate: kdField('courierTransmissionDate'),
    },
    orderAttributeFields: orderFields,
    entryAttributeFields: entryFields,
    samples,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log('\nСтатусы:', statuses);
  console.log('Причины отмен:', reasons);
  console.log('Kaspi Доставка:', report.kaspiDelivery);
  console.log('Поля заказа:', orderFields.join(', '));
  console.log('Поля entry:', entryFields.join(', '));
  console.log(`\nСохранено: ${OUT}`);
}

main().catch((error: unknown) => {
  console.error('Probe failed:', String((error as Error).message || error).replace(/X-Auth-Token\S*/gi, '***'));
  process.exit(1);
});
