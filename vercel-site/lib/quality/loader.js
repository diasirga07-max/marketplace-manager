'use strict';

// Loads Kaspi orders for «Показатели качества» (server only — the token never
// leaves the server and is never logged).
//   1. GET /orders per state in ≤14-day creationDate windows, all pages
//      (retries/backoff + concurrency limit live in kaspiGet).
//   2. GET /orders/{id}/entries for every order (+ product → SKU lookup),
//      resumable: work stops at the deadline and continues on the next run.
// Orders are stored compactly, without customer data.

const { internal, __test: dataTest } = require('../grants-data-service');
const store = require('./store');

const { kaspiGet, listOrders, mapLimit, SHEET_ID } = internal;
const DAY_MS = 86_400_000;
const SCHEMA = 1;
const RANGE_DAYS = 100; // 90-day metrics + 7-day week-ago comparison + margin
const WINDOW_MS = 14 * DAY_MS - 1; // Kaspi: creationDate filter spans at most 14 days
const STATES = ['NEW', 'SIGN_REQUIRED', 'PICKUP', 'DELIVERY', 'KASPI_DELIVERY', 'ARCHIVE'];
// On production the state=ARCHIVE filter returned fewer orders (1597) than the
// same window without a state filter (2112 archived, = cabinet 2111), so the
// unfiltered listing ('') is added and all lists are merged by order id.
const LIST_STATES = ['', ...STATES];
const LIST_TTL_MS = 10 * 60_000;
const DATASET_KEY = 'dataset';
const STATUS_KEY = 'refreshStatus';
const SAVE_EVERY_MS = 60_000;

const MEM = globalThis.__GB_QUALITY_LOADER || (globalThis.__GB_QUALITY_LOADER = { brands: null, brandsAt: 0, running: null, last: null });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function windows(from, to) {
  const out = [];
  for (let start = from; start <= to; start += WINDOW_MS + 1) out.push([start, Math.min(to, start + WINDOW_MS)]);
  return out;
}

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? x : 0;
}

// Only fields needed for metrics. No customer, address or phone.
function normalizeOrder(order) {
  const a = (order && order.attributes) || {};
  const kd = a.kaspiDelivery && typeof a.kaspiDelivery === 'object' ? a.kaspiDelivery : {};
  return {
    id: String(order && order.id || ''),
    code: String(a.code || ''),
    createdAt: n(a.creationDate),
    state: String(a.state || ''),
    status: String(a.status || ''),
    reason: String(a.cancellationReason || '').trim(),
    kd: a.isKaspiDelivery === true,
    planTransfer: n(kd.courierTransmissionPlanningDate || a.courierTransmissionPlanningDate),
    transfer: n(kd.courierTransmissionDate || a.courierTransmissionDate),
    plannedDelivery: n(a.plannedDeliveryDate),
    completedAt: n(a.completionDate),
    preOrder: a.preOrder === true,
    deliveryMode: String(a.deliveryMode || ''),
    total: n(a.totalPrice),
  };
}

// ---------- items (entries) ----------

async function productForEntry(entry, token, products) {
  const masterId = entry && entry.relationships && entry.relationships.product && entry.relationships.product.data
    ? String(entry.relationships.product.data.id || '') : '';
  if (masterId && products[masterId]) return products[masterId];
  let merchant = null;
  let master = null;
  if (masterId) {
    try { merchant = await kaspiGet(`/masterproducts/${encodeURIComponent(masterId)}/merchantProduct`, token); } catch { /* fallback below */ }
  }
  if (!merchant) {
    try { master = await kaspiGet(`/orderentries/${encodeURIComponent(entry.id)}/product`, token); } catch { /* keep entry data */ }
    const id = master && master.data && master.data.id;
    if (id) {
      try { merchant = await kaspiGet(`/masterproducts/${encodeURIComponent(id)}/merchantProduct`, token); } catch { /* no SKU */ }
    }
  }
  const ma = (merchant && merchant.data && merchant.data.attributes) || {};
  const pa = (master && master.data && master.data.attributes) || {};
  const result = { sku: String(ma.code || pa.code || '').trim(), name: String(ma.name || pa.name || '').trim() };
  if (masterId && result.sku) products[masterId] = result;
  return result;
}

async function loadItems(order, token, products) {
  const payload = await kaspiGet(`/orders/${encodeURIComponent(order.id)}/entries`, token);
  const entries = Array.isArray(payload && payload.data) ? payload.data : [];
  return mapLimit(entries, 3, async (entry) => {
    const a = entry.attributes || {};
    const offer = a.offer && typeof a.offer === 'object' ? a.offer : {};
    const product = await productForEntry(entry, token, products);
    return {
      sku: product.sku || String(offer.code || a.code || '').trim(),
      name: String(offer.name || product.name || a.name || 'Товар').trim().slice(0, 200),
      qty: Math.max(1, Number(a.quantity) || 1),
      price: n(a.totalPrice),
      catCode: String(a.category && a.category.code || ''),
      catTitle: String(a.category && a.category.title || ''),
    };
  });
}

// Bad-event candidates first (they drive the breakdown), then newest first.
function itemPriority(o, now) {
  if (['CANCELLED', 'CANCELLING', 'RETURNED', 'KASPI_DELIVERY_RETURN_REQUESTED'].includes(o.status)) return 0;
  if (o.kd && o.planTransfer && o.planTransfer < now && (!o.transfer || o.transfer > o.planTransfer)) return 0;
  return 1;
}

// ---------- brands from the warehouse Google Sheet ----------

// «Каспи для добавления»: A = SKU, B = name, C = brand (same sheet that the
// old quality-control screen used).
async function sheetBrands(force = false) {
  if (!force && MEM.brands && Date.now() - MEM.brandsAt < 10 * 60_000) return MEM.brands;
  const map = new Map();
  try {
    const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(SHEET_ID)}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('Каспи для добавления')}&tq=${encodeURIComponent('select A,C where A is not null')}`;
    const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    for (const [sku, brand] of dataTest.parseCsv(await res.text())) {
      const key = String(sku || '').replace(/\s+x\d+$/i, '').trim().toUpperCase();
      if (key && brand && !/АРТИКУЛ|MODEL|SKU/i.test(key)) map.set(key, String(brand).trim());
    }
    MEM.brands = map;
    MEM.brandsAt = Date.now();
  } catch (error) {
    console.warn('Quality: brand sheet unavailable', error.message);
    if (MEM.brands) return MEM.brands;
  }
  return map;
}

// ---------- dataset ----------

async function readDataset() {
  const entry = await store.get(DATASET_KEY, { maxMemoryAgeMs: 30_000 });
  const value = entry && entry.value;
  if (!value || value.schema !== SCHEMA || !Array.isArray(value.orders)) return null;
  return value;
}

async function listAll(token, from, to) {
  const tasks = [];
  for (const state of LIST_STATES) for (const [ge, le] of windows(from, to)) tasks.push({ state: state || undefined, ge, le });
  const errors = [];
  const lists = await mapLimit(tasks, 3, async (task, i) => {
    if (i) await sleep(120);
    try {
      return await listOrders(token, task);
    } catch (error) {
      errors.push(`${task.state || 'без state'}: ${error.status ? `HTTP ${error.status}` : error.message}`);
      return null;
    }
  });
  return { lists, errors };
}

// One refresh step. Returns progress; call again until complete.
async function refresh({ token, deadline = Date.now() + 230_000, forceList = false, now = Date.now() } = {}) {
  if (!token) throw new Error('Kaspi API токен не настроен (KASPI_API_TOKEN в Vercel)');
  const started = Date.now();
  const previous = (await readDataset()) || { schema: SCHEMA, orders: [], products: {}, listedAt: 0 };
  const products = { ...(previous.products || {}) };
  const byId = new Map(previous.orders.map((o) => [o.id, o]));
  const from = now - RANGE_DAYS * DAY_MS;
  let listErrors = [];
  let listedAt = previous.listedAt || 0;

  if (forceList || !listedAt || now - listedAt > LIST_TTL_MS) {
    const { lists, errors } = await listAll(token, from, now);
    listErrors = errors;
    const fresh = new Map();
    lists.forEach((list) => {
      if (!list) return;
      for (const raw of list) {
        const o = normalizeOrder(raw);
        if (!o.id) continue;
        const old = byId.get(o.id);
        // Kaspi moves courierTransmissionPlanningDate when a transfer is
        // rescheduled; keep the earliest plan ever seen as the original one.
        const seen = [old && old.planOrig, old && old.planTransfer, o.planTransfer].filter((x) => x > 0);
        fresh.set(o.id, { ...o, planOrig: seen.length ? Math.min(...seen) : 0, items: old && Array.isArray(old.items) ? old.items : null });
      }
    });
    // Keep previously known orders if a listing failed (do not lose data).
    if (errors.length) for (const [id, o] of byId) if (!fresh.has(id) && o.createdAt >= from) fresh.set(id, o);
    byId.clear();
    for (const [id, o] of fresh) if (o.createdAt >= from) byId.set(id, o);
    listedAt = now;
  }

  const snapshot = () => {
    const orders = [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
    const remaining = orders.filter((o) => !Array.isArray(o.items)).length;
    return { orders, remaining, dataset: { schema: SCHEMA, orders, products, listedAt, rangeFrom: from, rangeTo: now, complete: remaining === 0, listErrors, updatedAt: Date.now() } };
  };
  const status = async (phase, extra = {}) => {
    const { orders, remaining } = snapshot();
    const row = { phase, at: new Date().toISOString(), startedAt: new Date(started).toISOString(), orders: orders.length, itemsRemaining: remaining, listErrors, ...extra };
    console.log('Quality refresh', JSON.stringify(row));
    await store.set(STATUS_KEY, row);
  };

  // Save right after listing so the step is never lost to a timeout.
  if (listedAt === now) {
    await store.set(DATASET_KEY, snapshot().dataset);
    await status('listed');
  }

  const pending = [...byId.values()].filter((o) => !Array.isArray(o.items))
    .sort((a, b) => itemPriority(a, now) - itemPriority(b, now) || b.createdAt - a.createdAt);
  let loaded = 0;
  let itemErrors = 0;
  let lastSave = Date.now();
  let saving = null;
  await mapLimit(pending, 6, async (o) => {
    if (Date.now() > deadline) return;
    try {
      o.items = await loadItems(o, token, products);
      loaded += 1;
    } catch (error) {
      itemErrors += 1;
      if (error.status === 401 || error.status === 403) throw error;
    }
    if (!saving && Date.now() - lastSave > SAVE_EVERY_MS) {
      lastSave = Date.now();
      saving = store.set(DATASET_KEY, snapshot().dataset).then(() => status('items', { itemsLoaded: loaded, itemErrors })).finally(() => { saving = null; });
    }
  });
  if (saving) await saving;

  const { orders, remaining, dataset } = snapshot();
  const saved = await store.set(DATASET_KEY, dataset);
  const progress = {
    ok: true,
    complete: remaining === 0,
    orders: orders.length,
    itemsLoaded: loaded,
    itemsRemaining: remaining,
    itemErrors,
    listErrors,
    persisted: saved.persisted,
    persistError: saved.reason || '',
    ms: Date.now() - started,
  };
  await status(remaining === 0 ? 'complete' : 'step-done', { itemsLoaded: loaded, itemErrors, persisted: saved.persisted, persistError: saved.reason || '' });
  MEM.last = { ...progress, at: new Date().toISOString() };
  return progress;
}

module.exports = {
  DATASET_KEY,
  RANGE_DAYS,
  LIST_STATES,
  STATES,
  normalizeOrder,
  readDataset,
  refresh,
  sheetBrands,
  windows,
  STATUS_KEY,
  lastRun: () => MEM.last,
};
