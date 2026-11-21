'use strict';

// Pure financial calculations for the sales analytics dashboard.
// Input: compact raw Kaspi orders (see kaspi-raw.js), the «Прайс KASPI»
// catalog, analytics settings and manual monthly expenses.

const { normalizeSku } = require('../sales-core');
const {
  bucketKey,
  bucketList,
  daysBetween,
  daysInMonth,
  localIso,
  monthEnd,
  monthKey,
  monthStart,
  monthsBetween,
} = require('./periods');

const DEFAULT_SETTINGS = Object.freeze({
  commissionPct: 12.5,
  deliveryFallback: 'tariff', // 'tariff' = тариф Kaspi Доставки, 'percent' = % от выручки
  deliveryPct: 0,
  taxPct: 3,
  taxBase: 'revenue', // 'revenue' | 'profit'
  excludeTenTenge: true,
  expenseCategories: ['Реклама', 'Упаковка', 'Зарплата', 'Аренда', 'Прочее'],
  historyCompleteFrom: '', // manual override, YYYY-MM: Kaspi history is complete from this month
  detectedHistoryFrom: '', // detected automatically from order counts
});

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const WAREHOUSES = Object.freeze(['Курдай', 'WB', 'Алматы']);
const EXCLUDED_ORDER_TOTAL = 10;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function pos(value) {
  const n = num(value);
  return n > 0 ? n : 0;
}

function clampPct(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : fallback;
}

function normalizeSettings(input = {}) {
  const categories = Array.isArray(input.expenseCategories)
    ? [...new Set(input.expenseCategories.map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 30)
    : [];
  return {
    commissionPct: clampPct(input.commissionPct, DEFAULT_SETTINGS.commissionPct),
    deliveryFallback: input.deliveryFallback === 'percent' ? 'percent' : 'tariff',
    deliveryPct: clampPct(input.deliveryPct, DEFAULT_SETTINGS.deliveryPct),
    taxPct: clampPct(input.taxPct, DEFAULT_SETTINGS.taxPct),
    taxBase: input.taxBase === 'profit' ? 'profit' : 'revenue',
    excludeTenTenge: input.excludeTenTenge !== false,
    expenseCategories: categories.length ? categories : [...DEFAULT_SETTINGS.expenseCategories],
    historyCompleteFrom: MONTH_RE.test(String(input.historyCompleteFrom || '')) ? input.historyCompleteFrom : '',
    detectedHistoryFrom: MONTH_RE.test(String(input.detectedHistoryFrom || '')) ? input.detectedHistoryFrom : '',
  };
}

function warehouseOf(sku) {
  const normalized = normalizeSku(sku);
  if (normalized.startsWith('OPT')) return 'Курдай';
  if (normalized.startsWith('WB')) return 'WB';
  return 'Алматы';
}

function weightsOf(items) {
  const revenue = items.reduce((sum, item) => sum + pos(item.price), 0);
  if (revenue > 0) return items.map((item) => pos(item.price) / revenue);
  const qty = items.reduce((sum, item) => sum + pos(item.qty), 0);
  if (qty > 0) return items.map((item) => pos(item.qty) / qty);
  return items.map(() => (items.length ? 1 / items.length : 0));
}

function catalogItem(catalog, sku) {
  const map = catalog && catalog.bySku instanceof Map ? catalog.bySku : null;
  return map ? map.get(normalizeSku(sku)) || null : null;
}

// Splits orders into item lines; order-level money (total, delivery, extras,
// commission) is allocated to lines by their share of the order value.
function explodeLines(orders, catalog, rawSettings) {
  const settings = normalizeSettings(rawSettings);
  const commissionRate = settings.commissionPct / 100;
  const deliveryRate = settings.deliveryPct / 100;
  const lines = [];
  let excluded = 0;

  for (const order of Array.isArray(orders) ? orders : []) {
    const items = Array.isArray(order.items) && order.items.length
      ? order.items
      : [{ sku: '', name: 'Без позиций', qty: 0, price: order.total, category: '' }];
    const total = pos(order.total) || items.reduce((sum, item) => sum + pos(item.price), 0);
    if (order.kind === 'sale' && settings.excludeTenTenge && total === EXCLUDED_ORDER_TOTAL) {
      excluded += 1;
      continue;
    }
    const weights = weightsOf(items);
    items.forEach((item, index) => {
      const share = weights[index];
      const sales = total * share;
      const qty = pos(item.qty);
      const record = item.sku ? catalogItem(catalog, item.sku) : null;
      const wholesale = record && Number.isFinite(record.wholesale) ? record.wholesale : null;
      const deliverySource = order.deliverySource || 'api';
      const delivery = deliverySource === 'tariff' && settings.deliveryFallback === 'percent'
        ? sales * deliveryRate
        : pos(order.delivery) * share;
      lines.push({
        orderId: String(order.id || order.code || ''),
        kind: order.kind || 'sale',
        at: num(order.at),
        sku: String(item.sku || ''),
        name: String((record && record.name) || item.name || 'Товар'),
        category: String(item.category || (record && record.category) || 'Без категории'),
        warehouse: warehouseOf(item.sku),
        qty,
        sales,
        cost: wholesale == null || !item.sku ? null : wholesale * qty,
        commission: order.commission != null && Number.isFinite(Number(order.commission))
          ? pos(order.commission) * share
          : sales * commissionRate,
        commissionSource: order.commission != null ? 'api' : 'settings',
        delivery,
        deliverySource: deliverySource === 'tariff' && settings.deliveryFallback === 'percent' ? 'percent' : deliverySource,
        extra: pos(order.extra) * share,
      });
    });
  }
  return { lines, excluded };
}

function matchesFilters(line, filters = {}) {
  if (filters.warehouse && filters.warehouse !== 'all' && line.warehouse !== filters.warehouse) return false;
  if (filters.category && line.category !== filters.category) return false;
  if (filters.sku && normalizeSku(line.sku) !== normalizeSku(filters.sku)) return false;
  return true;
}

function filterActive(filters = {}) {
  return Boolean((filters.warehouse && filters.warehouse !== 'all') || filters.category || filters.sku);
}

// Manual monthly expenses spread evenly over the days of their month and
// clipped to [from, to].
function allocateExpenses(expenses, from, to) {
  const byCategory = {};
  let total = 0;
  for (const expense of Array.isArray(expenses) ? expenses : []) {
    const key = String(expense.month || '');
    if (!/^\d{4}-\d{2}$/.test(key)) continue;
    const start = monthStart(key) > from ? monthStart(key) : from;
    const end = monthEnd(key) < to ? monthEnd(key) : to;
    if (start > end) continue;
    const [y, m] = key.split('-').map(Number);
    const amount = num(expense.amount) * (daysBetween(start, end) / daysInMonth(y, m));
    const category = String(expense.category || 'Прочее');
    byCategory[category] = (byCategory[category] || 0) + amount;
    total += amount;
  }
  return { total, byCategory };
}

function emptyTotals() {
  return {
    revenue: 0,
    orders: 0,
    units: 0,
    cogs: 0,
    coveredRevenue: 0,
    coveredUnits: 0,
    commission: 0,
    coveredCommission: 0,
    delivery: 0,
    coveredDelivery: 0,
    kaspiExtra: 0,
    coveredKaspiExtra: 0,
    deliveryFromApi: 0,
    commissionFromApi: 0,
  };
}

function accumulate(lines) {
  const totals = emptyTotals();
  const orderIds = new Set();
  for (const line of lines) {
    orderIds.add(line.orderId);
    totals.revenue += line.sales;
    totals.units += line.qty;
    totals.commission += line.commission;
    totals.delivery += line.delivery;
    totals.kaspiExtra += line.extra;
    if (line.deliverySource === 'api') totals.deliveryFromApi += line.delivery;
    if (line.commissionSource === 'api') totals.commissionFromApi += line.commission;
    if (line.cost != null) {
      totals.cogs += line.cost;
      totals.coveredRevenue += line.sales;
      totals.coveredUnits += line.qty;
      totals.coveredCommission += line.commission;
      totals.coveredDelivery += line.delivery;
      totals.coveredKaspiExtra += line.extra;
    }
  }
  totals.orders = orderIds.size;
  return totals;
}

function finish(totals, otherExpenses, rawSettings, cancellations) {
  const settings = normalizeSettings(rawSettings);
  const rate = settings.taxPct / 100;
  const other = num(otherExpenses && otherExpenses.total);
  const gross = totals.coveredRevenue - totals.cogs;
  const beforeTax = gross - totals.coveredCommission - totals.coveredDelivery - totals.coveredKaspiExtra - other;
  let tax;
  let coveredTax;
  if (settings.taxBase === 'profit') {
    tax = Math.max(0, beforeTax) * rate;
    coveredTax = tax;
  } else {
    tax = totals.revenue * rate;
    coveredTax = totals.coveredRevenue * rate;
  }
  const net = beforeTax - coveredTax;
  const coverage = totals.units > 0
    ? (totals.coveredUnits / totals.units) * 100
    : totals.revenue > 0 ? (totals.coveredRevenue / totals.revenue) * 100 : 100;
  const partial = coverage < 99.999;
  const cancel = cancellations || { orders: 0, units: 0, amount: 0 };
  const allOrders = totals.orders + cancel.orders;
  return {
    revenue: totals.revenue,
    orders: totals.orders,
    units: totals.units,
    avgCheck: totals.orders ? totals.revenue / totals.orders : 0,
    cogs: totals.cogs,
    commission: totals.commission,
    delivery: totals.delivery,
    kaspiExtra: totals.kaspiExtra,
    otherExpenses: other,
    otherByCategory: (otherExpenses && otherExpenses.byCategory) || {},
    expenses: totals.kaspiExtra + other,
    tax,
    grossProfit: gross,
    netProfit: net,
    margin: totals.coveredRevenue ? (net / totals.coveredRevenue) * 100 : null,
    roi: totals.cogs ? (net / totals.cogs) * 100 : null,
    coverage,
    partial,
    coveredRevenue: totals.coveredRevenue,
    coveredUnits: totals.coveredUnits,
    missingUnits: Math.max(0, totals.units - totals.coveredUnits),
    deliveryFromApiPct: totals.delivery ? (totals.deliveryFromApi / totals.delivery) * 100 : 0,
    commissionFromApiPct: totals.commission ? (totals.commissionFromApi / totals.commission) * 100 : 0,
    cancelOrders: cancel.orders,
    cancelUnits: cancel.units,
    cancelAmount: cancel.amount,
    cancelRate: allOrders ? (cancel.orders / allOrders) * 100 : 0,
  };
}

function cancellationTotals(lines) {
  const ids = new Set();
  let units = 0;
  let amount = 0;
  let cancelled = 0;
  let returned = 0;
  const seenKind = new Set();
  for (const line of lines) {
    ids.add(line.orderId);
    units += line.qty;
    amount += line.sales;
    const key = `${line.kind}:${line.orderId}`;
    if (!seenKind.has(key)) {
      seenKind.add(key);
      if (line.kind === 'return') returned += 1;
      else cancelled += 1;
    }
  }
  return { orders: ids.size, units, amount, cancelled, returned };
}

function inRange(line, bounds) {
  return line.at >= bounds.ge && line.at <= bounds.le;
}

// Full summary for one period.
function summarize({ saleLines, cancelLines, expenses, settings, bounds, from, to, filters, totalRevenueUnfiltered }) {
  const sales = saleLines.filter((line) => inRange(line, bounds) && matchesFilters(line, filters));
  const cancels = cancelLines.filter((line) => inRange(line, bounds) && matchesFilters(line, filters));
  const totals = accumulate(sales);
  const allocation = allocateExpenses(expenses, from, to);
  let share = 1;
  if (filterActive(filters)) {
    share = totalRevenueUnfiltered > 0 ? totals.revenue / totalRevenueUnfiltered : 0;
  }
  const scaled = {
    total: allocation.total * share,
    byCategory: Object.fromEntries(Object.entries(allocation.byCategory).map(([key, value]) => [key, value * share])),
  };
  const cancellation = cancellationTotals(cancels);
  const summary = finish(totals, scaled, settings, cancellation);
  summary.cancelled = cancellation.cancelled;
  summary.returned = cancellation.returned;
  summary.expenseShare = share;
  return { summary, sales, cancels };
}

const COMPARABLE = [
  'revenue', 'orders', 'units', 'avgCheck', 'cogs', 'commission', 'delivery', 'expenses', 'otherExpenses',
  'tax', 'grossProfit', 'netProfit', 'margin', 'roi', 'cancelOrders', 'cancelAmount', 'cancelRate',
];

function compare(current, base) {
  const result = {};
  for (const key of COMPARABLE) {
    const a = current && current[key];
    const b = base && base[key];
    if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) {
      result[key] = null;
      continue;
    }
    result[key] = {
      abs: a - b,
      pct: b !== 0 ? ((a - b) / Math.abs(b)) * 100 : null,
      base: b,
    };
  }
  return result;
}

// Chart series. Manual expenses are spread over buckets by revenue share so
// that the series always sums to the period totals.
function series({ sales, cancels, period, settings, otherTotal }) {
  const buckets = bucketList(period.from, period.to, period.granularity);
  const salesBy = new Map(buckets.map((bucket) => [bucket.key, []]));
  const cancelsBy = new Map(buckets.map((bucket) => [bucket.key, []]));
  for (const line of sales) {
    const list = salesBy.get(bucketKey(line.at, period.granularity));
    if (list) list.push(line);
  }
  for (const line of cancels) {
    const list = cancelsBy.get(bucketKey(line.at, period.granularity));
    if (list) list.push(line);
  }
  const totalRevenue = sales.reduce((sum, line) => sum + line.sales, 0);
  return buckets.map((bucket) => {
    const totals = accumulate(salesBy.get(bucket.key));
    const other = totalRevenue > 0 ? (otherTotal * totals.revenue) / totalRevenue : 0;
    const summary = finish(totals, { total: other, byCategory: {} }, settings, cancellationTotals(cancelsBy.get(bucket.key)));
    return {
      key: bucket.key,
      label: bucket.label,
      revenue: summary.revenue,
      orders: summary.orders,
      units: summary.units,
      cogs: summary.cogs,
      commission: summary.commission,
      delivery: summary.delivery,
      tax: summary.tax,
      expenses: summary.expenses,
      grossProfit: summary.grossProfit,
      netProfit: summary.netProfit,
      avgCheck: summary.avgCheck,
      cancelOrders: summary.cancelOrders,
      partial: summary.partial,
    };
  });
}

// Accounting-style P&L: one column per calendar month of the period.
function profitAndLoss({ sales, period, expenses, settings, share = 1 }) {
  const normalized = normalizeSettings(settings);
  const months = monthsBetween(period.from, period.to);
  const byMonth = new Map(months.map((key) => [key, []]));
  for (const line of sales) {
    const list = byMonth.get(monthKey(localIso(line.at)));
    if (list) list.push(line);
  }
  const columns = months.map((key) => {
    const from = monthStart(key) < period.from ? period.from : monthStart(key);
    const to = monthEnd(key) > period.to ? period.to : monthEnd(key);
    const allocation = allocateExpenses(expenses, from, to);
    const scaled = {
      total: allocation.total * share,
      byCategory: Object.fromEntries(Object.entries(allocation.byCategory).map(([k, v]) => [k, v * share])),
    };
    return { key, from, to, summary: finish(accumulate(byMonth.get(key)), scaled, normalized) };
  });

  const categories = [...new Set([
    ...normalized.expenseCategories,
    ...columns.flatMap((column) => Object.keys(column.summary.otherByCategory)),
  ])];

  const row = (key, label, get, kind = 'money') => {
    const values = columns.map((column) => get(column.summary));
    return { key, label, kind, values, total: values.reduce((sum, value) => sum + (value || 0), 0) };
  };

  const rows = [
    row('revenue', 'Выручка', (s) => s.revenue, 'total'),
    row('cogs', 'Себестоимость', (s) => -s.cogs),
    row('grossProfit', 'Валовая прибыль', (s) => s.grossProfit, 'subtotal'),
    row('commission', 'Комиссия Kaspi', (s) => -s.commission),
    row('delivery', 'Доставка', (s) => -s.delivery),
    row('kaspiExtra', 'Доп. расходы Kaspi', (s) => -s.kaspiExtra),
    ...categories.map((category) => row(`exp:${category}`, category, (s) => -(s.otherByCategory[category] || 0), 'expense')),
    row('tax', `Налог (${normalized.taxPct}% от ${normalized.taxBase === 'profit' ? 'прибыли' : 'выручки'})`, (s) => -s.tax),
    row('netProfit', 'Чистая прибыль', (s) => s.netProfit, 'result'),
  ];
  const revenueRow = rows[0];
  const netRow = rows[rows.length - 1];
  rows.push({
    key: 'margin',
    label: 'Маржа %',
    kind: 'percent',
    values: columns.map((column) => column.summary.margin),
    total: null,
  });
  // Margin total is computed on covered revenue to stay consistent with the cards.
  const coveredTotal = columns.reduce((sum, column) => sum + column.summary.coveredRevenue, 0);
  rows[rows.length - 1].total = coveredTotal ? (netRow.total / coveredTotal) * 100 : null;

  return {
    columns: columns.map((column) => ({
      key: column.key,
      from: column.from,
      to: column.to,
      partial: column.summary.partial,
      coverage: column.summary.coverage,
    })),
    rows,
    revenueTotal: revenueRow.total,
    note: 'Валовая и чистая прибыль считаются по товарам с известной себестоимостью; ручные расходы распределены по дням месяца.',
  };
}

function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Kaspi API returns little or nothing for old months. Walking back from the
// newest closed month, the first month whose completed orders or revenue fall
// below 20 % of the recent median marks the edge: history is complete from the
// month after it. Needs at least 6 closed months; returns '' when unsure.
function detectHistoryStart(stats, threshold = 0.2) {
  const months = [...stats].sort((a, b) => a.month.localeCompare(b.month));
  if (months.length < 6) return '';
  const recent = months.slice(-12);
  const medSales = median(recent.map((m) => m.sales));
  const medRevenue = median(recent.map((m) => m.revenue));
  if (!medSales || !medRevenue) return '';
  for (let i = months.length - 1; i >= 0; i -= 1) {
    const m = months[i];
    if (m.sales < medSales * threshold || m.revenue < medRevenue * threshold) {
      return i + 1 < months.length ? months[i + 1].month : '';
    }
  }
  return '';
}

module.exports = {
  DEFAULT_SETTINGS,
  detectHistoryStart,
  WAREHOUSES,
  allocateExpenses,
  compare,
  explodeLines,
  filterActive,
  matchesFilters,
  normalizeSettings,
  profitAndLoss,
  series,
  summarize,
  warehouseOf,
};
