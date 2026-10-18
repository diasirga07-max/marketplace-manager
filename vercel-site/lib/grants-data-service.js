'use strict';

const {
  DAY_MS,
  DEFAULT_KASPI_RATE,
  DEFAULT_TAX_RATE,
  aggregateSales,
  buildCatalog,
  normalizeSku,
  salesRange,
} = require('./sales-core');

const KASPI_BASE = String(
  process.env.KASPI_API_BASE_URL || 'https://kaspi.kz/shop/api/v2',
).replace(/\/$/, '');
const SHEET_ID = String(
  process.env.KASPI_SHEET_ID ||
    process.env.GOOGLE_SHEET_ID ||
    '1dLU5KOi3WBLy3uNEiqGv5rf9ka0OwcEw_RjhDQW3H1E',
).trim();
const SHEET_NAME = 'Прайс KASPI';
const SERVICE_VERSION = '14.0.0';
const CACHE_SCHEMA = 1;

const TTL = {
  orders: 5_000,
  catalog: 5 * 60_000,
  entry: 5 * 60_000,
  product: 24 * 60 * 60_000,
  merchant: 24 * 60 * 60_000,
  orderDetail: 7 * DAY_MS,
};

const STATE = globalThis.__GRANTS_BOOK_DATA_V14 ||
  (globalThis.__GRANTS_BOOK_DATA_V14 = {
    orders: null,
    ordersAt: 0,
    ordersPromise: null,
    catalog: null,
    catalogAt: 0,
    entry: new Map(),
    product: new Map(),
    merchant: new Map(),
    orderDetail: new Map(),
    salesLocal: new Map(),
    salesPromises: new Map(),
    kaspiActive: 0,
    kaspiQueue: [],
    vercelFunctionsPromise: null,
  });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tokenFromRequest(req) {
  return process.env.KASPI_API_TOKEN || req.headers['x-kaspi-token'] || '';
}

function sendJson(res, status, data, cacheControl = 'no-store, max-age=0') {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cacheControl);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Kaspi-Token');
  res.end(JSON.stringify(data));
}

function queryString(values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  return `?${params.toString()}`;
}

async function mapLimit(items, limit, mapper) {
  const input = Array.isArray(items) ? items : [];
  if (input.length === 0) return [];
  const output = new Array(input.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= input.length) return;
      output[index] = await mapper(input[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, input.length) }, worker));
  return output;
}

function acquireKaspiSlot() {
  if (STATE.kaspiActive < 10) {
    STATE.kaspiActive += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => STATE.kaspiQueue.push(resolve));
}

function releaseKaspiSlot() {
  const next = STATE.kaspiQueue.shift();
  if (next) next();
  else STATE.kaspiActive = Math.max(0, STATE.kaspiActive - 1);
}

async function withKaspiSlot(task) {
  await acquireKaspiSlot();
  try {
    return await task();
  } finally {
    releaseKaspiSlot();
  }
}

function cacheGet(map, key, ttl) {
  const entry = map.get(key);
  return entry && Date.now() - entry.savedAt < ttl ? entry.value : null;
}

function cacheSet(map, key, value) {
  map.set(key, { savedAt: Date.now(), value });
  if (map.size > 5_000) {
    const firstKey = map.keys().next().value;
    if (firstKey !== undefined) map.delete(firstKey);
  }
  return value;
}

async function kaspiGet(path, kaspiToken, timeoutMs = 18_000) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await withKaspiSlot(async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(`${KASPI_BASE}${path}`, {
            headers: {
              Accept: 'application/vnd.api+json',
              'Content-Type': 'application/vnd.api+json',
              'X-Auth-Token': kaspiToken,
            },
            cache: 'no-store',
            signal: controller.signal,
          });
          const text = await response.text();
          let payload = {};
          try {
            payload = JSON.parse(text);
          } catch {
            // The status below remains the authoritative error when Kaspi returns HTML/text.
          }
          if (!response.ok) {
            const message =
              payload?.errors?.[0]?.title ||
              payload?.errors?.[0]?.detail ||
              `Kaspi HTTP ${response.status}`;
            const error = new Error(message);
            error.status = response.status;
            throw error;
          }
          return payload;
        } finally {
          clearTimeout(timeout);
        }
      });
    } catch (error) {
      lastError = error;
      const status = Number(error && error.status);
      const retryable = !status || status === 429 || status >= 500;
      if (!retryable || attempt === 2) throw error;
      await sleep(400 * (attempt + 1));
    }
  }
  throw lastError || new Error('Kaspi API error');
}

async function listOrders(kaspiToken, { state, status, ge, le }) {
  const orders = [];
  for (let page = 0; page < 50; page += 1) {
    const payload = await kaspiGet(
      `/orders${queryString({
        'page[number]': page,
        'page[size]': 100,
        'filter[orders][state]': state,
        'filter[orders][status]': status,
        'filter[orders][creationDate][$ge]': ge,
        'filter[orders][creationDate][$le]': le,
      })}`,
      kaspiToken,
    );
    const pageOrders = Array.isArray(payload.data) ? payload.data : [];
    orders.push(...pageOrders);
    if (pageOrders.length < 100) break;
  }
  return orders;
}

async function orderEntries(orderId, kaspiToken) {
  const cached = cacheGet(STATE.entry, orderId, TTL.entry);
  if (cached) return cached;
  return cacheSet(
    STATE.entry,
    orderId,
    await kaspiGet(`/orders/${encodeURIComponent(orderId)}/entries`, kaspiToken),
  );
}

async function entryProduct(entryId, kaspiToken) {
  const cached = cacheGet(STATE.product, entryId, TTL.product);
  if (cached) return cached;
  return cacheSet(
    STATE.product,
    entryId,
    await kaspiGet(`/orderentries/${encodeURIComponent(entryId)}/product`, kaspiToken),
  );
}

async function merchantProduct(masterId, kaspiToken) {
  const cached = cacheGet(STATE.merchant, masterId, TTL.merchant);
  if (cached) return cached;
  return cacheSet(
    STATE.merchant,
    masterId,
    await kaspiGet(`/masterproducts/${encodeURIComponent(masterId)}/merchantProduct`, kaspiToken),
  );
}

async function orderDetail(orderId, kaspiToken) {
  const cached = cacheGet(STATE.orderDetail, orderId, TTL.orderDetail);
  if (cached) return cached;
  return cacheSet(
    STATE.orderDetail,
    orderId,
    await kaspiGet(`/orders/${encodeURIComponent(orderId)}`, kaspiToken),
  );
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"') quoted = true;
    else if (character === ',') {
      row.push(cell);
      cell = '';
    } else if (character === '\n') {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else cell += character;
  }

  if (cell || row.length) {
    row.push(cell.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows;
}

async function fetchTextWithRetry(url, label) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt === 0) await sleep(300);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error(`${label}: ошибка загрузки`);
}

async function loadCatalog(force = false) {
  if (!force && STATE.catalog && Date.now() - STATE.catalogAt < TTL.catalog) {
    return STATE.catalog;
  }

  const url =
    `https://docs.google.com/spreadsheets/d/${encodeURIComponent(SHEET_ID)}` +
    `/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(SHEET_NAME)}`;
  const csv = await fetchTextWithRetry(url, 'Не удалось прочитать Прайс KASPI');
  const catalog = buildCatalog(parseCsv(csv));
  STATE.catalog = catalog;
  STATE.catalogAt = Date.now();
  return catalog;
}

async function enrichEntry(entry, kaspiToken, catalog) {
  const attributes = entry.attributes || {};
  const entryId = entry.id;
  let productPayload = null;
  let merchantPayload = null;
  let masterId = entry?.relationships?.product?.data?.id || '';

  if (masterId) {
    try {
      merchantPayload = await merchantProduct(masterId, kaspiToken);
    } catch {
      // Some Kaspi entries point to a product instead of a master product.
    }
  }
  if (!merchantPayload) {
    try {
      productPayload = await entryProduct(entryId, kaspiToken);
    } catch {
      // The entry attributes below still keep the order visible if enrichment fails.
    }
    masterId = productPayload?.data?.id || masterId;
    if (masterId) {
      try {
        merchantPayload = await merchantProduct(masterId, kaspiToken);
      } catch {
        // The item will be marked as missing a cost if no SKU can be resolved.
      }
    }
  }

  const productAttributes = productPayload?.data?.attributes || {};
  const merchantAttributes = merchantPayload?.data?.attributes || {};
  const sku = String(
    merchantAttributes.code || productAttributes.code || attributes.code || '',
  ).trim();
  const catalogItem = catalog?.bySku?.get(normalizeSku(sku));
  const name = String(
    catalogItem?.name ||
      merchantAttributes.name ||
      productAttributes.name ||
      attributes.name ||
      'Товар',
  ).trim();

  return {
    sku: sku || catalogItem?.sku || '',
    name,
    quantity: Math.max(0, Number(attributes.quantity) || 0),
    photo: catalogItem?.photo || '',
    wholesale: catalogItem?.wholesale ?? null,
    wbUrl: catalogItem?.wbUrl || '',
    totalPrice: Math.max(0, Number(attributes.totalPrice) || 0),
    basePrice: Math.max(0, Number(attributes.basePrice) || 0),
    weight: Math.max(0, Number(attributes.weight) || 0),
    categoryTitle: String(attributes?.category?.title || ''),
    categoryCode: String(attributes?.category?.code || ''),
    entryId,
  };
}

function transmissionDate(attributes) {
  return Number(
    attributes?.kaspiDelivery?.courierTransmissionDate ||
      attributes?.courierTransmissionDate ||
      0,
  );
}

function handedToKaspi(attributes) {
  return transmissionDate(attributes) > 0;
}

function stageOf(attributes) {
  if (
    attributes?.status === 'ASSEMBLE' ||
    attributes?.assembled ||
    attributes?.kaspiDelivery?.waybill ||
    attributes?.kaspiDelivery?.waybillNumber ||
    attributes?.waybill ||
    attributes?.waybillNumber
  ) {
    return 'Передача';
  }
  if (attributes?.status === 'ACCEPTED_BY_MERCHANT') return 'Упаковка';
  if (attributes?.preOrder) return 'Предзаказ';
  return attributes?.status || attributes?.state || 'Активный';
}

function groupOf(sku) {
  const normalized = normalizeSku(sku);
  if (normalized.startsWith('OPT')) return 'Курдай';
  if (normalized.startsWith('WB')) return 'WB';
  return 'Алматы';
}

async function freshOrders(kaspiToken) {
  const now = Date.now();
  const from = now - 13 * DAY_MS;
  const states = ['NEW', 'SIGN_REQUIRED', 'PICKUP', 'DELIVERY', 'KASPI_DELIVERY'];
  const lists = await mapLimit(states, 3, async (state) => {
    try {
      return await listOrders(kaspiToken, { state, ge: from, le: now });
    } catch (error) {
      console.warn('Kaspi active-order state failed', { state, error: error.message });
      return [];
    }
  });

  const unique = new Map();
  for (const order of lists.flat()) {
    const attributes = order.attributes || {};
    if (
      ['COMPLETED', 'CANCELLED', 'CANCELLING', 'KASPI_DELIVERY_RETURN_REQUESTED', 'RETURNED']
        .includes(attributes.status)
    ) {
      continue;
    }
    if (handedToKaspi(attributes)) continue;
    unique.set(order.id, order);
  }

  let catalog;
  try {
    catalog = await loadCatalog();
  } catch (error) {
    console.warn('Catalog unavailable for active orders', { error: error.message });
    catalog = { bySku: new Map() };
  }

  const orderRows = await mapLimit([...unique.values()], 8, async (order) => {
    const attributes = order.attributes || {};
    let payload = { data: [] };
    try {
      payload = await orderEntries(order.id, kaspiToken);
    } catch (error) {
      console.warn('Active-order entries unavailable', { orderId: order.id, error: error.message });
    }
    const entries = Array.isArray(payload.data) ? payload.data : [];
    const items = await mapLimit(entries, 4, (entry) => enrichEntry(entry, kaspiToken, catalog));
    return items.map((item) => ({
      orderCode: String(attributes.code || ''),
      sku: item.sku,
      name: item.name,
      quantity: item.quantity,
      stage: stageOf(attributes),
      group: groupOf(item.sku),
      photo: item.photo,
      wholesale: item.wholesale,
      wbUrl: item.wbUrl,
    }));
  });

  const rows = orderRows.flat().filter((row) => row.sku || row.name);
  rows.sort((a, b) =>
    String(a.sku).localeCompare(String(b.sku), 'ru', { numeric: true, sensitivity: 'base' }),
  );

  const counts = {
    all: 0,
    preorder: 0,
    packing: 0,
    transfer: 0,
    kurdai: 0,
    wb: 0,
    almaty: 0,
  };
  for (const row of rows) {
    counts.all += row.quantity;
    if (row.stage === 'Предзаказ') counts.preorder += row.quantity;
    else if (row.stage === 'Упаковка') counts.packing += row.quantity;
    else if (row.stage === 'Передача') counts.transfer += row.quantity;
    if (row.group === 'Курдай') counts.kurdai += row.quantity;
    else if (row.group === 'WB') counts.wb += row.quantity;
    else counts.almaty += row.quantity;
  }

  return { ok: true, generatedAt: new Date().toISOString(), counts, rows, orders: rows };
}

async function getOrders(kaspiToken, force = false) {
  if (!force && STATE.orders && Date.now() - STATE.ordersAt < TTL.orders) {
    return { ...STATE.orders, cached: true, stale: false, ms: 0 };
  }
  if (!force && STATE.ordersPromise) return STATE.ordersPromise;

  const startedAt = Date.now();
  const promise = freshOrders(kaspiToken)
    .then((payload) => {
      const result = { ...payload, cached: false, stale: false, ms: Date.now() - startedAt };
      STATE.orders = result;
      STATE.ordersAt = Date.now();
      return result;
    })
    .finally(() => {
      STATE.ordersPromise = null;
    });
  STATE.ordersPromise = promise;
  return promise;
}

async function completedCandidates(kaspiToken, from, to) {
  const windows = [];
  for (let cursor = from; cursor <= to; cursor += 7 * DAY_MS) {
    windows.push([cursor, Math.min(to, cursor + 7 * DAY_MS - 1)]);
  }

  const lists = await mapLimit(windows, 3, async ([ge, le]) => {
    try {
      return await listOrders(kaspiToken, {
        state: 'ARCHIVE',
        status: 'COMPLETED',
        ge,
        le,
      });
    } catch (error) {
      console.warn('Kaspi completed-order window failed', {
        from: new Date(ge).toISOString(),
        to: new Date(le).toISOString(),
        error: error.message,
      });
      throw error;
    }
  });

  const unique = new Map();
  for (const order of lists.flat()) {
    const key = String(order?.attributes?.code || order.id || '').trim();
    if (key) unique.set(key, order);
  }
  return [...unique.values()];
}

function deliveryZone(attributes) {
  if (attributes?.express === true) return 'express';
  const mode = String(attributes?.deliveryMode || '').toUpperCase();
  if (mode === 'DELIVERY_LOCAL') return 'city';
  return 'kz';
}

function deliveryTariff(total, weightGrams, zone = 'kz', categoryTitle = '') {
  const amount = Number(total) || 0;
  const normalizedZone = zone === 'city' ? 'city' : zone === 'express' ? 'express' : 'kz';
  if (amount <= 1_000) return 49;
  if (amount <= 3_000) return 149;
  if (amount <= 5_000) return 199;
  if (amount < 10_000) return normalizedZone === 'city' ? 699 : 799;

  let kilograms = (Number(weightGrams) || 0) / 1_000;
  if (/(?:легков|авто).*шин|шин/iu.test(String(categoryTitle)) && kilograms > 0 && kilograms <= 25) {
    if (normalizedZone === 'city') return 1_049;
    return normalizedZone === 'express' ? 1_349 : 1_649;
  }
  if (kilograms <= 0) kilograms = 5;
  if (kilograms <= 5) return normalizedZone === 'city' ? 1_099 : normalizedZone === 'express' ? 1_699 : 1_299;
  if (kilograms <= 15) return normalizedZone === 'city' ? 1_349 : normalizedZone === 'express' ? 1_849 : 1_699;
  if (kilograms <= 30) return normalizedZone === 'city' ? 2_299 : normalizedZone === 'express' ? 3_149 : 3_599;
  if (kilograms <= 60) return normalizedZone === 'city' ? 2_899 : normalizedZone === 'express' ? 3_599 : 5_649;
  if (kilograms <= 100) return normalizedZone === 'city' ? 4_149 : normalizedZone === 'express' ? 5_599 : 8_549;
  return normalizedZone === 'city' ? 6_449 : normalizedZone === 'express' ? 8_449 : 11_999;
}

function orderDeliveryCost(attributes, total, items) {
  const apiValue = Number(
    attributes?.deliveryCostForSeller ?? attributes?.sellerDeliveryCost,
  );
  if (Number.isFinite(apiValue) && apiValue > 0) return { value: apiValue, source: 'api' };
  if (attributes?.isKaspiDelivery === false) {
    return { value: Number.isFinite(apiValue) ? apiValue : 0, source: 'api' };
  }

  const weight = items.reduce((sum, item) => sum + (Number(item.weight) || 0), 0);
  const title = items.map((item) => item.categoryTitle || '').join(' ');
  const zone = deliveryZone(attributes);
  return {
    value: deliveryTariff(total, weight, zone, title),
    source: 'tariff',
    zone,
    weight,
  };
}

function orderAdditionalExpenses(attributes) {
  const candidates = [
    attributes?.additionalExpensesForSeller,
    attributes?.sellerAdditionalExpenses,
    attributes?.sellerExtraExpenses,
  ];
  for (const value of candidates) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

async function rawSaleOrder(order, kaspiToken, catalog) {
  let attributes = order.attributes || {};
  if (
    !attributes.completionDate ||
    attributes.deliveryCostForSeller == null ||
    attributes.deliveryMode == null
  ) {
    try {
      const detail = await orderDetail(order.id, kaspiToken);
      const detailAttributes =
        detail?.data?.attributes ||
        (Array.isArray(detail?.data) ? detail.data[0]?.attributes : null) ||
        {};
      attributes = { ...attributes, ...detailAttributes };
    } catch (error) {
      console.warn('Kaspi order detail unavailable', { orderId: order.id, error: error.message });
    }
  }

  let entryPayload = { data: [] };
  try {
    entryPayload = await orderEntries(order.id, kaspiToken);
  } catch (error) {
    console.warn('Completed-order entries unavailable', { orderId: order.id, error: error.message });
  }
  const entryRows = Array.isArray(entryPayload.data) ? entryPayload.data : [];
  const items = await mapLimit(entryRows, 4, (entry) => enrichEntry(entry, kaspiToken, catalog));
  const totalPrice =
    Math.max(0, Number(attributes.totalPrice) || 0) ||
    items.reduce((sum, item) => sum + (Number(item.totalPrice) || 0), 0);
  const delivery = orderDeliveryCost(attributes, totalPrice, items);

  return {
    id: order.id,
    code: String(attributes.code || ''),
    status: String(attributes.status || '').toUpperCase(),
    completionDate: Number(attributes.completionDate) || 0,
    creationDate: Number(attributes.creationDate) || 0,
    totalPrice,
    delivery: delivery.value,
    deliverySource: delivery.source,
    deliveryZone: delivery.zone || deliveryZone(attributes),
    weight: delivery.weight || items.reduce((sum, item) => sum + (Number(item.weight) || 0), 0),
    extraExpenses: orderAdditionalExpenses(attributes),
    items: items.map((item) => ({
      sku: item.sku,
      name: item.name,
      quantity: item.quantity,
      totalPrice: item.totalPrice,
      photo: item.photo,
      weight: item.weight,
      categoryTitle: item.categoryTitle,
    })),
  };
}

async function freshSales(kaspiToken, from, to) {
  const startedAt = Date.now();
  const range = salesRange(from, to);
  const catalog = await loadCatalog(true);
  const candidates = await completedCandidates(kaspiToken, range.queryFrom, range.queryTo);

  const likelyRelevant = candidates.filter((order) => {
    const completionDate = Number(order?.attributes?.completionDate) || 0;
    return !completionDate || (completionDate >= range.ge && completionDate <= range.le);
  });
  const rawOrders = await mapLimit(likelyRelevant, 8, (order) =>
    rawSaleOrder(order, kaspiToken, catalog),
  );
  const inRange = rawOrders.filter(
    (order) => order.completionDate >= range.ge && order.completionDate <= range.le,
  );
  const aggregate = aggregateSales(inRange, catalog, {
    taxRate: DEFAULT_TAX_RATE,
    kaspiRate: DEFAULT_KASPI_RATE,
  });
  const generatedAt = new Date().toISOString();
  const calculationCandidates = aggregate.orders.flatMap((order) =>
    order.items
      .filter((item) => item.cogs != null && item.profit != null)
      .map((item) => ({
        orderCodeSuffix: order.code ? `…${String(order.code).slice(-4)}` : '',
        completionDate: order.completionDate,
        sku: item.sku,
        quantity: item.quantity,
        revenue: item.totalPrice,
        wholesale: item.wholesale,
        cogs: item.cogs,
        delivery: item.delivery,
        tax: item.tax,
        kaspi: item.kaspi,
        extraExpenses: item.extraExpenses,
        profit: item.profit,
      })),
  );
  const preferredSample = calculationCandidates.find(
    (item) => normalizeSku(item.sku) === 'KITAPENT00082',
  );
  const calculationSamples = [];
  if (preferredSample) calculationSamples.push(preferredSample);
  for (const sample of calculationCandidates) {
    if (calculationSamples.length >= 5) break;
    if (sample === preferredSample) continue;
    if (calculationSamples.some((current) => normalizeSku(current.sku) === normalizeSku(sample.sku))) {
      continue;
    }
    calculationSamples.push(sample);
  }

  return {
    ok: true,
    generatedAt,
    lastSuccessfulAt: generatedAt,
    range: { from: range.from, to: range.to, days: range.days },
    summary: aggregate.summary,
    top: aggregate.top,
    daily: aggregate.daily,
    calculationSamples,
    catalogRows: catalog.rows,
    catalog: {
      sheetId: SHEET_ID,
      sheet: SHEET_NAME,
      rows: catalog.rows,
      sourceRows: catalog.sourceRows,
      duplicateSkus: catalog.duplicateCount,
      missingCosts: catalog.missingCosts,
      invalidCosts: catalog.invalidCosts,
      skuHeader: catalog.schema.skuHeader,
      costHeader: catalog.schema.costHeader,
      skuFallback: catalog.schema.skuFallback,
      warnings: catalog.warnings,
      matchedUnits: aggregate.summary.knownCostUnits,
      missingUnits: aggregate.summary.missingCostUnits,
    },
    diagnostics: {
      candidateOrders: candidates.length,
      detailedOrders: likelyRelevant.length,
      completedOrdersInRange: inRange.length,
      duplicateOrders: aggregate.summary.duplicateOrders,
      excludedOrders: aggregate.summary.excludedOrders,
      unresolvedOrders: aggregate.summary.unresolvedOrders,
    },
    cached: false,
    stale: false,
    refreshing: false,
    ms: Date.now() - startedAt,
  };
}

async function vercelFunctions() {
  if (!STATE.vercelFunctionsPromise) {
    STATE.vercelFunctionsPromise = import('@vercel/functions').catch((error) => {
      console.warn('Vercel Runtime Cache unavailable', { error: error.message });
      return null;
    });
  }
  return STATE.vercelFunctionsPromise;
}

async function runtimeCache() {
  const functions = await vercelFunctions();
  if (!functions || typeof functions.getCache !== 'function') return null;
  try {
    return functions.getCache({ namespace: 'grants-book-kaspi-data-v14' });
  } catch (error) {
    console.warn('Vercel Runtime Cache initialization failed', { error: error.message });
    return null;
  }
}

function salesCachePolicy(range) {
  const today = salesRange().from;
  const current = range.to >= today;
  return current
    ? { freshMs: 2 * 60_000, ttlSeconds: 6 * 60 * 60 }
    : { freshMs: 6 * 60 * 60_000, ttlSeconds: 7 * 24 * 60 * 60 };
}

async function readSalesCache(key) {
  const local = STATE.salesLocal.get(key);
  if (local && local.schema === CACHE_SCHEMA && Date.now() <= local.freshUntil) return local;

  const cache = await runtimeCache();
  if (!cache) return local && local.schema === CACHE_SCHEMA ? local : null;
  try {
    const entry = await cache.get(key);
    if (entry && entry.schema === CACHE_SCHEMA && entry.value) {
      if (!local || Number(entry.savedAt) >= Number(local.savedAt)) {
        STATE.salesLocal.set(key, entry);
        return entry;
      }
    }
  } catch (error) {
    console.warn('Vercel Runtime Cache read failed', { key, error: error.message });
  }
  return local && local.schema === CACHE_SCHEMA ? local : null;
}

async function writeSalesCache(key, value, policy) {
  const savedAt = Date.now();
  const entry = {
    schema: CACHE_SCHEMA,
    savedAt,
    freshUntil: savedAt + policy.freshMs,
    value: { ...value, lastSuccessfulAt: value.generatedAt },
  };
  STATE.salesLocal.set(key, entry);
  if (STATE.salesLocal.size > 200) {
    const firstKey = STATE.salesLocal.keys().next().value;
    if (firstKey !== undefined && firstKey !== key) STATE.salesLocal.delete(firstKey);
  }

  const cache = await runtimeCache();
  if (cache) {
    try {
      await cache.set(key, entry, {
        ttl: policy.ttlSeconds,
        tags: ['grants-book-sales'],
        name: 'Kaspi completed sales range',
      });
    } catch (error) {
      console.warn('Vercel Runtime Cache write failed', { key, error: error.message });
    }
  }
  return value;
}

function decorateCached(entry, { stale, refreshing }) {
  return {
    ...entry.value,
    cached: true,
    stale,
    refreshing,
    cacheAgeMs: Math.max(0, Date.now() - entry.savedAt),
    ms: 0,
  };
}

function startSalesRefresh(key, kaspiToken, range, policy) {
  if (STATE.salesPromises.has(key)) return STATE.salesPromises.get(key);
  const promise = freshSales(kaspiToken, range.from, range.to)
    .then((value) => writeSalesCache(key, value, policy))
    .finally(() => STATE.salesPromises.delete(key));
  STATE.salesPromises.set(key, promise);
  return promise;
}

async function scheduleBackground(promise) {
  const functions = await vercelFunctions();
  if (functions && typeof functions.waitUntil === 'function') {
    functions.waitUntil(
      promise.catch((error) => {
        console.error('Background sales refresh failed', { error: error.message });
      }),
    );
  } else {
    promise.catch((error) => {
      console.error('Background sales refresh failed', { error: error.message });
    });
  }
}

async function getSales(kaspiToken, force = false, from = '', to = '') {
  const range = salesRange(from, to);
  const key = `sales:${range.from}:${range.to}`;
  const policy = salesCachePolicy(range);

  if (!force) {
    const cached = await readSalesCache(key);
    if (cached) {
      if (Date.now() <= cached.freshUntil) {
        return decorateCached(cached, { stale: false, refreshing: false });
      }
      const refresh = startSalesRefresh(key, kaspiToken, range, policy);
      await scheduleBackground(refresh);
      return decorateCached(cached, { stale: true, refreshing: true });
    }
  }

  if (STATE.salesPromises.has(key)) return STATE.salesPromises.get(key);
  return startSalesRefresh(key, kaspiToken, range, policy);
}

async function scanOrder(kaspiToken, code) {
  const payload = await kaspiGet(
    `/orders${queryString({
      'filter[orders][code]': code,
      'page[number]': 0,
      'page[size]': 20,
    })}`,
    kaspiToken,
  );
  const order = Array.isArray(payload.data) ? payload.data[0] : null;
  if (!order) throw new Error('Заказ не найден');
  const attributes = order.attributes || {};
  let catalog;
  try {
    catalog = await loadCatalog();
  } catch (error) {
    console.warn('Catalog unavailable for scanner', { error: error.message });
    catalog = { bySku: new Map() };
  }
  const entryPayload = await orderEntries(order.id, kaspiToken);
  const items = await mapLimit(
    Array.isArray(entryPayload.data) ? entryPayload.data : [],
    4,
    (entry) => enrichEntry(entry, kaspiToken, catalog),
  );
  return {
    ok: true,
    order: { id: order.id, code: String(attributes.code || code), status: stageOf(attributes) },
    items,
  };
}

function normalizeGroup(value) {
  const normalized = String(value || '').trim().toLocaleLowerCase('ru-RU');
  if (normalized === 'almaty' || normalized === 'алматы') return 'almaty';
  if (['kurdai', 'kordai', 'курдай', 'кордай'].includes(normalized)) return 'kurdai';
  if (['wb', 'wildberries', 'вайлберис', 'валберис'].includes(normalized)) return 'wb';
  return '';
}

function csvCell(value) {
  return `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
}

function formatAlmatyTime(value) {
  const input = value ? new Date(value) : new Date();
  const date = Number.isNaN(input.getTime()) ? new Date() : input;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Asia/Almaty',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.day}.${parts.month}.${parts.year} ${parts.hour}:${parts.minute}:${parts.second}`;
}

async function sendOrdersExport(req, res, kaspiToken) {
  const requestedGroup = normalizeGroup(req.query && req.query.group);
  if (!requestedGroup) {
    return sendJson(res, 400, { ok: false, error: 'group must be almaty, kurdai or wb' });
  }

  const payload = await getOrders(kaspiToken, String(req.query?.force || '') === '1');
  const uniqueOrderSku = new Map();
  for (const raw of Array.isArray(payload.rows) ? payload.rows : []) {
    if (normalizeGroup(raw.group) !== requestedGroup) continue;
    const orderCode = String(raw.orderCode || '').trim();
    const sku = String(raw.sku || '').trim();
    const quantity = Math.max(0, Number(raw.quantity) || 0);
    if (!orderCode || !sku || quantity <= 0) continue;
    const key = `${requestedGroup}\u0001${orderCode}\u0001${normalizeSku(sku)}`;
    const previous = uniqueOrderSku.get(key);
    if (!previous || quantity > previous.quantity) {
      uniqueOrderSku.set(key, {
        orderCode,
        sku,
        quantity,
        name: String(raw.name || '').trim(),
      });
    }
  }

  const grouped = new Map();
  for (const row of uniqueOrderSku.values()) {
    const key = `${requestedGroup}\u0001${normalizeSku(row.sku)}`;
    const item = grouped.get(key) || {
      sku: row.sku,
      name: row.name,
      quantity: 0,
      orders: new Set(),
    };
    item.quantity += row.quantity;
    item.orders.add(row.orderCode);
    if (!item.name && row.name) item.name = row.name;
    grouped.set(key, item);
  }

  const updatedAt = formatAlmatyTime(payload.generatedAt);
  const rows = [...grouped.values()].sort((a, b) =>
    a.sku.localeCompare(b.sku, 'ru', { numeric: true, sensitivity: 'base' }),
  );
  const csv = rows
    .map((row) => {
      const orderNumbers = [...row.orders]
        .sort((a, b) => b.localeCompare(a, 'ru', { numeric: true }))
        .join(', ');
      return [row.name, row.sku, row.quantity, orderNumbers, '✅ Принят', updatedAt]
        .map(csvCell)
        .join(',');
    })
    .join('\n');

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Source-Generated-At', String(payload.generatedAt || ''));
  res.setHeader('X-Unique-Order-Sku-Count', String(uniqueOrderSku.size));
  res.setHeader('X-Grouped-Sku-Count', String(rows.length));
  return res.end(csv);
}

async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Kaspi-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    return res.end();
  }

  const operation = String(req.query?.op || 'health');
  const kaspiToken = tokenFromRequest(req);
  try {
    if (operation === 'health') {
      return sendJson(res, 200, {
        ok: true,
        version: SERVICE_VERSION,
        serverTokenConfigured: Boolean(process.env.KASPI_API_TOKEN),
        sheetConfigured: Boolean(SHEET_ID),
        cache: 'vercel-runtime-cache',
      });
    }
    if (!kaspiToken) {
      return sendJson(res, 401, { ok: false, error: 'Kaspi API token не настроен' });
    }
    if (operation === 'orders') {
      return sendJson(
        res,
        200,
        await getOrders(kaspiToken, String(req.query?.force || '') === '1'),
      );
    }
    if (operation === 'sales') {
      return sendJson(
        res,
        200,
        await getSales(
          kaspiToken,
          String(req.query?.force || '') === '1',
          String(req.query?.from || ''),
          String(req.query?.to || ''),
        ),
      );
    }
    if (operation === 'scan') {
      let body = req.body || {};
      if (typeof body === 'string') {
        try {
          body = JSON.parse(body);
        } catch {
          body = {};
        }
      }
      const code = String(body.scan || '').replace(/\D/g, '');
      if (!code) return sendJson(res, 400, { ok: false, error: 'Введите номер заказа' });
      return sendJson(res, 200, await scanOrder(kaspiToken, code));
    }
    if (operation === 'orders-export') {
      return sendOrdersExport(req, res, kaspiToken);
    }
    return sendJson(res, 404, { ok: false, error: 'Неизвестная операция' });
  } catch (error) {
    console.error('GRANTS BOOK data operation failed', {
      operation,
      error: error && error.message ? error.message : String(error),
    });
    return sendJson(res, 500, {
      ok: false,
      error: error && error.message ? error.message : 'Ошибка сервера',
    });
  }
}

module.exports = {
  handler,
  __test: {
    deliveryTariff,
    orderDeliveryCost,
    parseCsv,
  },
};
