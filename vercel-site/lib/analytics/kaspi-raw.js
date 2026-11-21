'use strict';

// Loads one calendar month of Kaspi orders as compact "raw" records that are
// cached and later recalculated with the current catalog and settings.

const crypto = require('node:crypto');
const { internal } = require('../grants-data-service');
const { DAY_MS, monthEnd, monthStart, rangeBounds } = require('./periods');

const {
  enrichEntry,
  listOrders,
  mapLimit,
  orderAdditionalExpenses,
  orderDeliveryCost,
  orderDetail,
  orderEntries,
} = internal;

const RAW_SCHEMA = 1;
const LOOKBACK_DAYS = 45;
const EMPTY_CATALOG = { bySku: new Map() };

function friendlyKaspiError(error) {
  const status = Number(error && error.status);
  const message = String((error && error.message) || error || '');
  if (status === 401 || status === 403) return 'Kaspi API отклонил токен (401/403). Проверьте KASPI_API_TOKEN в настройках Vercel.';
  if (status === 429) return 'Kaspi API ограничил частоту запросов (429). Повторите через 1–2 минуты.';
  if (status >= 500) return `Kaspi API временно недоступен (HTTP ${status}). Повторите позже.`;
  if (/abort|timeout/i.test(message)) return 'Kaspi API не ответил вовремя. Повторите позже.';
  return `Ошибка Kaspi API: ${message || 'неизвестная ошибка'}`;
}

function windows(from, to, size = 7 * DAY_MS) {
  const result = [];
  for (let cursor = from; cursor <= to; cursor += size) result.push([cursor, Math.min(to, cursor + size - 1)]);
  return result;
}

async function listWindowed(token, { state, status, ge, le }) {
  const lists = await mapLimit(windows(ge, le), 3, ([from, to]) =>
    listOrders(token, { state, status, ge: from, le: to }),
  );
  const unique = new Map();
  for (const order of lists.flat()) unique.set(String(order.id), order);
  return [...unique.values()];
}

function maskCustomer(customer) {
  if (!customer || typeof customer !== 'object') return { id: '', label: '' };
  const rawId = String(customer.id || customer.cellPhone || '');
  const id = rawId ? crypto.createHash('sha256').update(rawId).digest('hex').slice(0, 16) : '';
  const first = String(customer.firstName || String(customer.name || '').split(/\s+/)[0] || '').trim();
  const digits = String(customer.cellPhone || '').replace(/\D/g, '');
  const label = [first, digits ? `…${digits.slice(-4)}` : ''].filter(Boolean).join(' ');
  return { id, label };
}

function commissionFromApi(attributes) {
  // Kaspi Shop API does not document a commission field; take one if it ever appears.
  for (const key of ['commission', 'kaspiCommission', 'sellerCommission', 'commissionAmount']) {
    const value = Number(attributes && attributes[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

async function rawOrder(order, token, kind) {
  let attributes = order.attributes || {};
  if (kind === 'sale' && (!attributes.completionDate || attributes.deliveryCostForSeller == null || attributes.deliveryMode == null)) {
    try {
      const detail = await orderDetail(order.id, token);
      const extra = detail?.data?.attributes || (Array.isArray(detail?.data) ? detail.data[0]?.attributes : null) || {};
      attributes = { ...attributes, ...extra };
    } catch (error) {
      console.warn('Analytics: order detail unavailable', { orderId: order.id, error: error.message });
    }
  }

  let entries = [];
  try {
    const payload = await orderEntries(order.id, token);
    entries = Array.isArray(payload.data) ? payload.data : [];
  } catch (error) {
    console.warn('Analytics: order entries unavailable', { orderId: order.id, error: error.message });
  }
  const items = await mapLimit(entries, 4, (entry) => enrichEntry(entry, token, EMPTY_CATALOG));
  const total = Math.max(0, Number(attributes.totalPrice) || 0) ||
    items.reduce((sum, item) => sum + (Number(item.totalPrice) || 0), 0);
  const delivery = kind === 'sale' ? orderDeliveryCost(attributes, total, items) : { value: 0, source: 'none' };
  const customer = maskCustomer(attributes.customer);
  const at = kind === 'sale' ? Number(attributes.completionDate) || 0 : Number(attributes.creationDate) || 0;

  return {
    id: String(order.id),
    code: String(attributes.code || ''),
    kind,
    status: String(attributes.status || ''),
    at,
    createdAt: Number(attributes.creationDate) || 0,
    total,
    delivery: delivery.value,
    deliverySource: delivery.source,
    extra: kind === 'sale' ? orderAdditionalExpenses(attributes) : 0,
    commission: commissionFromApi(attributes),
    city: String(attributes?.deliveryAddress?.town || attributes?.deliveryAddress?.city || '').trim(),
    payment: String(attributes.paymentMode || ''),
    deliveryMode: String(attributes.deliveryMode || ''),
    express: attributes.express === true,
    customer: customer.id,
    customerLabel: customer.label,
    reason: String(attributes.cancellationReason || attributes.cancellationComment || attributes.returnReason || ''),
    items: items.map((item) => ({
      sku: item.sku,
      name: item.name,
      qty: item.quantity,
      price: item.totalPrice,
      basePrice: item.basePrice,
      category: item.categoryTitle,
    })),
  };
}

// Returns { month, orders, errors, complete } for "YYYY-MM".
async function fetchMonth(token, month, now = Date.now(), previous = null) {
  const startedAt = Date.now();
  const { ge, le: monthLe } = rangeBounds(monthStart(month), monthEnd(month));
  const le = Math.min(monthLe, now);
  const errors = [];

  const completedCandidates = await listWindowed(token, {
    state: 'ARCHIVE',
    status: 'COMPLETED',
    ge: ge - LOOKBACK_DAYS * DAY_MS,
    le,
  });
  const relevant = completedCandidates.filter((order) => {
    const completion = Number(order?.attributes?.completionDate) || 0;
    return !completion || (completion >= ge && completion <= le);
  });

  const cancelledLists = await Promise.all(['CANCELLED', 'RETURNED'].map(async (status) => {
    try {
      return (await listWindowed(token, { state: 'ARCHIVE', status, ge, le })).map((order) => ({
        order,
        kind: status === 'RETURNED' ? 'return' : 'cancel',
      }));
    } catch (error) {
      errors.push(`${status === 'RETURNED' ? 'Возвраты' : 'Отмены'}: ${friendlyKaspiError(error)}`);
      return [];
    }
  }));

  // Incremental refresh: archived orders do not change, so reuse already loaded ones.
  const known = new Map(
    (previous && Array.isArray(previous.orders) ? previous.orders : [])
      .filter((order) => order.items && order.items.length)
      .map((order) => [`${order.kind}:${order.id}`, order]),
  );
  const reuse = (kind, order, load) => known.get(`${kind}:${order.id}`) || load();
  const sales = await mapLimit(relevant, 8, (order) => reuse('sale', order, () => rawOrder(order, token, 'sale')));
  const cancels = await mapLimit(cancelledLists.flat(), 8, ({ order, kind }) =>
    reuse(kind, order, () => rawOrder(order, token, kind)));
  const reused = [...sales, ...cancels].filter((order) => known.get(`${order.kind}:${order.id}`) === order).length;

  const orders = [
    ...sales.filter((order) => order.at >= ge && order.at <= le),
    ...cancels.filter((order) => order.at >= ge && order.at <= le),
  ];
  return {
    schema: RAW_SCHEMA,
    month,
    orders,
    errors,
    fetchedAt: Date.now(),
    coveredUntil: le,
    reused,
    ms: Date.now() - startedAt,
  };
}

module.exports = {
  RAW_SCHEMA,
  fetchMonth,
  friendlyKaspiError,
  maskCustomer,
};
