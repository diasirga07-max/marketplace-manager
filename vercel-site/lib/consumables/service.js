'use strict';

// «Расходники → Сейчас»: active orders, consumption since the last
// inventory and the 30-day average. Reads Kaspi only through the shared
// helpers of grants-data-service (same token, same caches, same limits).

const { internal } = require('../grants-data-service');
const { DAY_MS } = require('../sales-core');
const calc = require('./calc');
const store = require('./store');

const AVG_WINDOW_DAYS = 30;
const MAX_LOOKBACK_DAYS = 120;
const WINDOW_MS = 7 * DAY_MS; // Kaspi limits creationDate filters; same window as completed sales
const FOREGROUND_MS = Number(process.env.GB_CONSUMABLES_WAIT_MS) || 45_000;
const RESULT_TTL_MS = 2 * 60_000;
const EMPTY_CATALOG = { bySku: new Map() };
const SHIPPED_STATES = ['KASPI_DELIVERY', 'DELIVERY', 'PICKUP', 'ARCHIVE'];

const STATE = globalThis.__GB_CONSUMABLES_SERVICE || (globalThis.__GB_CONSUMABLES_SERVICE = {
  items: new Map(), // order id -> { t, items: [[sku, qty]] }
  itemsLoaded: false,
  result: null,
  resultKey: '',
  resultAt: 0,
  inflight: null,
  functionsPromise: null,
});

async function vercelFunctions() {
  if (!STATE.functionsPromise) STATE.functionsPromise = import('@vercel/functions').catch(() => null);
  return STATE.functionsPromise;
}

async function runtimeCache() {
  const functions = await vercelFunctions();
  if (!functions || typeof functions.getCache !== 'function') return null;
  try { return functions.getCache({ namespace: 'grants-book-consumables-v1' }); } catch { return null; }
}

async function waitUntil(promise) {
  const functions = await vercelFunctions();
  const guarded = promise.catch((error) => console.warn('Consumables background', error && error.message));
  if (functions && typeof functions.waitUntil === 'function') functions.waitUntil(guarded);
  return guarded;
}

async function loadItemMemo() {
  if (STATE.itemsLoaded) return;
  STATE.itemsLoaded = true;
  const cache = await runtimeCache();
  if (!cache) return;
  try {
    const saved = await cache.get('order-items');
    if (saved && typeof saved === 'object') {
      for (const [id, value] of Object.entries(saved)) if (!STATE.items.has(id)) STATE.items.set(id, value);
    }
  } catch { /* memo is only an optimisation */ }
}

async function saveItemMemo() {
  const cutoff = Date.now() - (MAX_LOOKBACK_DAYS + 10) * DAY_MS;
  for (const [id, value] of STATE.items) if (!value || value.t < cutoff) STATE.items.delete(id);
  const cache = await runtimeCache();
  if (!cache) return;
  try {
    await cache.set('order-items', Object.fromEntries(STATE.items), { ttl: 60 * 86_400, tags: ['grants-book-consumables'] });
  } catch { /* ignore */ }
}

function transmissionDate(attributes) {
  return Number(attributes?.kaspiDelivery?.courierTransmissionDate || attributes?.courierTransmissionDate || 0);
}

// When an order physically left the warehouse: courier transmission, or —
// for orders without Kaspi Delivery data — completion.
function shippedAt(attributes) {
  const transmitted = transmissionDate(attributes);
  if (transmitted > 0) return transmitted;
  const status = String(attributes?.status || '').toUpperCase();
  if (status === 'COMPLETED' || status === 'RETURNED') return Number(attributes?.completionDate) || 0;
  return 0;
}

// Active orders = exactly the source of the «Новые заказы» counter.
function groupActive(rows) {
  const byCode = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const code = String(row.orderCode || '').trim();
    if (!code) continue;
    const order = byCode.get(code) || { code, stage: row.stage, items: [] };
    order.items.push({ sku: row.sku, qty: Number(row.quantity) || 0 });
    byCode.set(code, order);
  }
  return [...byCode.values()];
}

async function listShippedCandidates(token, fromMs, now) {
  const windows = [];
  for (let cursor = fromMs - 14 * DAY_MS; cursor <= now; cursor += WINDOW_MS) windows.push([cursor, Math.min(now, cursor + WINDOW_MS - 1)]);
  const tasks = SHIPPED_STATES.flatMap((state) => windows.map(([ge, le]) => ({ state, ge, le })));
  const errors = [];
  const lists = await internal.mapLimit(tasks, 3, async ({ state, ge, le }) => {
    try {
      return await internal.listOrders(token, { state, ge, le });
    } catch (error) {
      errors.push(`${state}: ${error.message}`);
      return [];
    }
  });
  const unique = new Map();
  for (const order of lists.flat()) {
    const at = shippedAt(order.attributes || {});
    if (at >= fromMs && at <= now) unique.set(String(order.id), { id: String(order.id), at });
  }
  return { orders: [...unique.values()], errors };
}

async function loadOrderItems(token, order) {
  const payload = await internal.orderEntries(order.id, token);
  const entries = Array.isArray(payload.data) ? payload.data : [];
  const items = await internal.mapLimit(entries, 4, (entry) => internal.enrichEntry(entry, token, EMPTY_CATALOG));
  const value = { t: order.at, items: items.map((item) => [String(item.sku || ''), Number(item.quantity) || 0]) };
  STATE.items.set(order.id, value);
  return value;
}

// Items of completed orders are often already in the «Динамика продаж» month cache.
async function itemsFromAnalytics(orders) {
  const missing = orders.filter((order) => !STATE.items.has(order.id));
  if (!missing.length) return;
  try {
    const analyticsStore = require('../analytics/store');
    const { monthKey, localIso } = require('../analytics/periods');
    const months = [...new Set(missing.map((order) => monthKey(localIso(order.at))))];
    // completion can be a few days after transmission -> also read the next month
    const extended = new Set(months);
    for (const key of months) {
      const [y, m] = key.split('-').map(Number);
      const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
      extended.add(next);
    }
    const entries = await analyticsStore.readMonths([...extended]);
    const byId = new Map();
    for (const entry of entries.values()) {
      for (const raw of entry.data.orders || []) if (raw.kind === 'sale') byId.set(String(raw.id), raw);
    }
    for (const order of missing) {
      const raw = byId.get(order.id);
      if (raw && Array.isArray(raw.items) && raw.items.length) {
        STATE.items.set(order.id, { t: order.at, items: raw.items.map((item) => [String(item.sku || ''), Number(item.qty) || 0]) });
      }
    }
  } catch (error) {
    console.warn('Consumables: analytics cache unavailable', error && error.message);
  }
}

async function shippedOrders(token, fromMs, now, startedAt) {
  await loadItemMemo();
  const { orders, errors } = await listShippedCandidates(token, fromMs, now);
  await itemsFromAnalytics(orders);
  const missing = orders.filter((order) => !STATE.items.has(order.id));
  const deadline = startedAt + FOREGROUND_MS;
  const leftovers = [];
  await internal.mapLimit(missing, 8, async (order) => {
    if (Date.now() > deadline) {
      leftovers.push(order);
      return;
    }
    try { await loadOrderItems(token, order); } catch (error) { errors.push(`Заказ ${order.id}: ${error.message}`); }
  });
  if (leftovers.length) {
    waitUntil(internal.mapLimit(leftovers, 6, (order) => loadOrderItems(token, order).catch(() => null)).then(saveItemMemo));
  } else if (missing.length) {
    waitUntil(saveItemMemo());
  }
  const shipped = orders
    .filter((order) => STATE.items.has(order.id))
    .map((order) => ({ at: order.at, items: STATE.items.get(order.id).items.map(([sku, qty]) => ({ sku, qty })) }));
  return { shipped, total: orders.length, pending: leftovers.length, errors };
}

function receiptsFrom(journal) {
  return (journal || [])
    .filter((entry) => entry.type === 'receipt')
    .map((entry) => ({ item: entry.item, qty: Number(entry.qty) || 0, at: Number(entry.at) || 0 }));
}

async function computeNow(token, state, now) {
  const startedAt = Date.now();
  const warnings = [];
  const ordersPayload = await internal.getOrders(token, false);
  const active = groupActive(ordersPayload.rows);
  const stockDates = Object.values(state.config.stock).map((s) => s.at).filter((at) => at > 0);
  const earliest = Math.min(now - AVG_WINDOW_DAYS * DAY_MS, ...stockDates);
  const limit = now - MAX_LOOKBACK_DAYS * DAY_MS;
  if (earliest < limit) warnings.push(`Инвентаризация старше ${MAX_LOOKBACK_DAYS} дней: расход до ${new Date(limit).toISOString().slice(0, 10)} не учтён — проведите новую инвентаризацию.`);
  const fromMs = Math.max(earliest, limit);
  const shipped = await shippedOrders(token, fromMs, now, startedAt);
  if (shipped.pending) warnings.push(`Состав ${shipped.pending} из ${shipped.total} отправленных заказов ещё загружается из Kaspi — остаток уточнится через 1–2 минуты.`);
  if (shipped.errors.length) warnings.push(`Kaspi вернул ошибки (${shipped.errors.length}): ${shipped.errors.slice(0, 2).join('; ')}`);
  const overview = calc.stockOverview(state.config, {
    active,
    shipped: shipped.shipped,
    receipts: receiptsFrom(state.journal),
    now,
    avgWindowDays: AVG_WINDOW_DAYS,
  });
  return {
    ok: true,
    generatedAt: new Date(now).toISOString(),
    ordersGeneratedAt: ordersPayload.generatedAt,
    version: state.version,
    ...overview,
    activeByStage: active.reduce((acc, order) => { acc[order.stage || '—'] = (acc[order.stage || '—'] || 0) + 1; return acc; }, {}),
    shippedCounted: shipped.shipped.length,
    partial: shipped.pending > 0,
    warnings,
    ms: Date.now() - startedAt,
  };
}

async function now(token, { force = false } = {}) {
  const state = await store.getState(force);
  const key = state.version;
  if (!force && STATE.result && STATE.resultKey === key && !STATE.result.partial && Date.now() - STATE.resultAt < RESULT_TTL_MS) {
    return { ...STATE.result, cached: true };
  }
  if (!force && STATE.inflight) return STATE.inflight;
  const promise = computeNow(token, state, Date.now())
    .then((result) => {
      STATE.result = result;
      STATE.resultKey = key;
      STATE.resultAt = Date.now();
      return result;
    })
    .finally(() => { STATE.inflight = null; });
  STATE.inflight = promise;
  return promise;
}

store.onChange(() => { STATE.result = null; });

module.exports = { now, __test: { groupActive, shippedAt, receiptsFrom } };
