'use strict';

const { internal } = require('../grants-data-service');
const { normalizeSku } = require('../sales-core');
const periods = require('./periods');
const finance = require('./finance');
const store = require('./store');
const { fetchMonth, friendlyKaspiError } = require('./kaspi-raw');

const SERVICE_VERSION = 'analytics-1.0.1';
const CURRENT_FRESH_MS = 3 * 60_000;
const CLOSE_GRACE_MS = 2 * 86_400_000; // late completions are still accepted two days after month end
const FOREGROUND_BUDGET_MS = 150_000;

const STATE = globalThis.__GB_ANALYTICS_SERVICE || (globalThis.__GB_ANALYTICS_SERVICE = {
  inflight: new Map(),
  failures: new Map(),
});

function monthEndMs(key) {
  return periods.rangeBounds(periods.monthStart(key), periods.monthEnd(key)).le;
}

function monthState(key, entry, now) {
  if (!entry) return 'missing';
  const end = monthEndMs(key);
  if (entry.savedAt >= end + CLOSE_GRACE_MS) return 'closed';
  if (now - entry.savedAt < CURRENT_FRESH_MS) return 'fresh';
  return 'stale';
}

function loadMonth(token, key, previous = null) {
  if (STATE.inflight.has(key)) return STATE.inflight.get(key);
  const promise = (async () => {
    const data = await fetchMonth(token, key, Date.now(), previous && previous.data);
    const closed = Date.now() >= monthEndMs(key) + CLOSE_GRACE_MS;
    const entry = await store.writeMonth(key, data, { closed });
    STATE.failures.delete(key);
    return entry;
  })()
    .catch((error) => {
      const message = friendlyKaspiError(error);
      STATE.failures.set(key, { at: Date.now(), message });
      throw Object.assign(new Error(message), { status: error.status });
    })
    .finally(() => STATE.inflight.delete(key));
  STATE.inflight.set(key, promise);
  return promise;
}

async function ensureMonths({ token, groups, force, startedAt }) {
  const all = [...new Set(groups.flat())];
  const entries = await store.readMonths(all);
  const now = Date.now();
  const status = {};
  const foreground = [];
  const background = [];
  const forced = new Set(force ? groups[0] : []);

  for (const key of all) {
    const entry = entries.get(key);
    const state = forced.has(key) ? 'forced' : monthState(key, entry, now);
    status[key] = { state, savedAt: entry ? entry.savedAt : null, orders: entry ? entry.data.orders.length : 0 };
    if (state === 'missing' || state === 'forced') foreground.push(key);
    else if (state === 'stale') background.push(key);
  }

  // Priority: current period first (newest month first), then previous, then last year.
  const priority = (key) => groups.findIndex((group) => group.includes(key));
  foreground.sort((a, b) => priority(a) - priority(b) || b.localeCompare(a));

  const pending = [];
  const errors = [];
  let cursor = 0;
  async function worker() {
    while (cursor < foreground.length) {
      const key = foreground[cursor++];
      const failure = STATE.failures.get(key);
      if (!forced.has(key) && failure && Date.now() - failure.at < 5 * 60_000) {
        errors.push({ month: key, message: failure.message });
        status[key].state = 'error';
        continue;
      }
      if (Date.now() - startedAt > FOREGROUND_BUDGET_MS) {
        pending.push(key);
        status[key].state = 'pending';
        continue;
      }
      try {
        const entry = await loadMonth(token, key, forced.has(key) ? null : entries.get(key));
        entries.set(key, entry);
        status[key] = { state: 'fresh', savedAt: entry.savedAt, orders: entry.data.orders.length };
        for (const message of entry.data.errors || []) errors.push({ month: key, message });
      } catch (error) {
        errors.push({ month: key, message: error.message });
        status[key].state = entries.has(key) ? 'stale' : 'error';
      }
    }
  }
  await Promise.all([worker(), worker()]);

  for (const key of background) {
    status[key].refreshing = true;
    store.waitUntil(loadMonth(token, key, entries.get(key)));
  }
  return { entries, status, pending, errors };
}

function filterOptions(lines) {
  const categories = new Map();
  const products = new Map();
  for (const line of lines) {
    categories.set(line.category, (categories.get(line.category) || 0) + line.sales);
    if (!line.sku) continue;
    const key = normalizeSku(line.sku);
    const product = products.get(key) || { sku: line.sku, name: line.name, revenue: 0, warehouse: line.warehouse, category: line.category };
    product.revenue += line.sales;
    products.set(key, product);
  }
  return {
    warehouses: finance.WAREHOUSES,
    categories: [...categories.entries()].sort((a, b) => b[1] - a[1]).map(([name, revenue]) => ({ name, revenue })),
    products: [...products.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 2000),
  };
}

async function loadCatalogSafe() {
  try {
    return { catalog: await internal.loadCatalog(), warning: '' };
  } catch (error) {
    return { catalog: { bySku: new Map(), rows: 0, schema: {} }, warning: `Прайс KASPI недоступен: ${error.message}` };
  }
}

async function dashboard({ token, query }) {
  const startedAt = Date.now();
  const period = periods.resolvePeriod({ preset: query.preset, from: query.from, to: query.to });
  const comparison = periods.comparisonPeriods(period);
  const filters = {
    warehouse: finance.WAREHOUSES.includes(query.warehouse) ? query.warehouse : 'all',
    category: String(query.category || '').trim(),
    sku: String(query.sku || '').trim(),
  };
  const groups = [
    periods.monthsBetween(period.from, period.to),
    periods.monthsBetween(comparison.previous.from, comparison.previous.to),
    periods.monthsBetween(comparison.yoy.from, comparison.yoy.to),
  ];

  const [months, settings, expenses, catalogResult] = await Promise.all([
    ensureMonths({ token, groups, force: String(query.force || '') === '1', startedAt }),
    store.getSettings(),
    store.getExpenses(),
    loadCatalogSafe(),
  ]);

  const orders = [...months.entries.values()].flatMap((entry) => entry.data.orders);
  const { lines, excluded } = finance.explodeLines(orders, catalogResult.catalog, settings);
  const saleLines = lines.filter((line) => line.kind === 'sale');
  const cancelLines = lines.filter((line) => line.kind !== 'sale');

  const summaryFor = (range, monthKeys) => {
    const bounds = periods.rangeBounds(range.from, range.to);
    const available = monthKeys.every((key) => months.entries.has(key));
    const unfiltered = finance.summarize({
      saleLines, cancelLines, expenses, settings, bounds, from: range.from, to: range.to, filters: {},
    });
    const result = finance.filterActive(filters)
      ? finance.summarize({
        saleLines, cancelLines, expenses, settings, bounds, from: range.from, to: range.to, filters,
        totalRevenueUnfiltered: unfiltered.summary.revenue,
      })
      : unfiltered;
    return { ...result, available, range };
  };

  const current = summaryFor(period, groups[0]);
  const previous = summaryFor(comparison.previous, groups[1]);
  const yoy = summaryFor(comparison.yoy, groups[2]);

  const response = {
    ok: true,
    version: SERVICE_VERSION,
    generatedAt: new Date().toISOString(),
    period,
    filters,
    comparison: {
      previous: { ...comparison.previous, available: previous.available },
      yoy: { ...comparison.yoy, available: yoy.available },
    },
    summary: current.summary,
    previous: previous.available ? previous.summary : null,
    yoy: yoy.available ? yoy.summary : null,
    deltas: {
      previous: previous.available ? finance.compare(current.summary, previous.summary) : null,
      yoy: yoy.available ? finance.compare(current.summary, yoy.summary) : null,
    },
    series: finance.series({
      sales: current.sales,
      cancels: current.cancels,
      period,
      settings,
      otherTotal: current.summary.otherExpenses,
    }),
    pnl: finance.profitAndLoss({
      sales: current.sales,
      period,
      expenses,
      settings,
      share: current.summary.expenseShare,
    }),
    options: filterOptions(saleLines.filter((line) => line.at >= periods.rangeBounds(period.from, period.to).ge
      && line.at <= periods.rangeBounds(period.from, period.to).le)),
    settings,
    catalog: {
      rows: catalogResult.catalog.rows || 0,
      skuHeader: catalogResult.catalog.schema?.skuHeader || '',
      skuDetectedBy: catalogResult.catalog.schema?.skuFallback ? 'content' : 'header',
      notes: catalogResult.catalog.schema?.notes || [],
      warning: catalogResult.warning,
    },
    months: months.status,
    pendingMonths: months.pending,
    complete: months.pending.length === 0 && groups[0].every((key) => months.entries.has(key)),
    errors: months.errors,
    diagnostics: { excludedTenTengeOrders: excluded, storage: store.storageStatus() },
    ms: Date.now() - startedAt,
  };
  return response;
}

module.exports = { SERVICE_VERSION, dashboard, __test: { monthState } };
