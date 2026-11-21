'use strict';

const { internal } = require('../grants-data-service');
const { normalizeSku } = require('../sales-core');
const periods = require('./periods');
const finance = require('./finance');
const store = require('./store');
const { fetchMonth, friendlyKaspiError } = require('./kaspi-raw');

const SERVICE_VERSION = 'analytics-1.1.0';
const CURRENT_FRESH_MS = 3 * 60_000;
const CLOSE_GRACE_MS = 2 * 86_400_000; // late completions are still accepted two days after month end
// A dashboard request waits at most this long for Kaspi; unfinished months keep
// loading in the background (waitUntil, bounded by the 300 s function limit)
// and the UI polls until they are cached.
const FOREGROUND_WAIT_MS = Number(process.env.GB_ANALYTICS_WAIT_MS) || 20_000;
const MAX_NEW_LOADS_PER_REQUEST = 3;
const LOCK_TTL_MS = 290_000;
// Stop starting new Kaspi order lookups this long after the invocation began,
// leaving time to save progress before the 300 s function limit.
const LOAD_DEADLINE_MS = Number(process.env.GB_ANALYTICS_DEADLINE_MS) || 230_000;

const STATE = globalThis.__GB_ANALYTICS_SERVICE || (globalThis.__GB_ANALYTICS_SERVICE = {
  inflight: new Map(),
  failures: new Map(),
  loadLog: [],
});

function monthEndMs(key) {
  return periods.rangeBounds(periods.monthStart(key), periods.monthEnd(key)).le;
}

function monthState(key, entry, now) {
  if (!entry) return 'missing';
  if (entry.data && entry.data.partial) return 'partial';
  const end = monthEndMs(key);
  if (entry.savedAt >= end + CLOSE_GRACE_MS) return 'closed';
  if (now - entry.savedAt < CURRENT_FRESH_MS) return 'fresh';
  return 'stale';
}

function logLoad(record) {
  STATE.loadLog.unshift({ ...record, at: new Date().toISOString() });
  STATE.loadLog.length = Math.min(STATE.loadLog.length, 30);
  const line = record.error ? console.warn : console.log;
  line('Analytics month load', JSON.stringify(record));
}

function loadMonth(token, key, previous = null, invocationStartedAt = Date.now()) {
  if (STATE.inflight.has(key)) return STATE.inflight.get(key);
  const startedAt = Date.now();
  const promise = (async () => {
    await store.setLock(`month:${key}`, LOCK_TTL_MS);
    const data = await fetchMonth(token, key, Date.now(), previous && previous.data, {
      deadline: invocationStartedAt + LOAD_DEADLINE_MS,
    });
    const closed = !data.partial && Date.now() >= monthEndMs(key) + CLOSE_GRACE_MS;
    const entry = await store.writeMonth(key, data, { closed });
    STATE.failures.delete(key);
    logLoad({
      month: key, ms: Date.now() - startedAt, orders: data.orders.length, reused: data.reused || 0,
      partial: Boolean(data.partial), skipped: data.skipped || 0, warnings: (data.errors || []).length,
    });
    return entry;
  })()
    .catch((error) => {
      const message = friendlyKaspiError(error);
      STATE.failures.set(key, { at: Date.now(), message });
      logLoad({ month: key, ms: Date.now() - startedAt, error: message });
      throw Object.assign(new Error(message), { status: error.status });
    })
    .finally(() => {
      STATE.inflight.delete(key);
      store.releaseLock(`month:${key}`);
    });
  STATE.inflight.set(key, promise);
  return promise;
}

function timeout(ms) {
  return new Promise((resolve) => setTimeout(() => resolve('timeout'), ms));
}

async function ensureMonths({ token, groups, force, startedAt }) {
  const all = [...new Set(groups.flat())];
  const entries = await store.readMonths(all);
  const now = Date.now();
  const status = {};
  const missing = [];
  const background = [];
  const forced = new Set(force ? groups[0] : []);

  for (const key of all) {
    const entry = entries.get(key);
    const state = forced.has(key) ? 'forced' : monthState(key, entry, now);
    status[key] = { state, savedAt: entry ? entry.savedAt : null, orders: entry ? entry.data.orders.length : 0 };
    if (state === 'missing' || state === 'forced' || state === 'partial') missing.push(key);
    else if (state === 'stale') background.push(key);
  }

  // Priority: current period first (newest month first), then previous, then last year.
  const priority = (key) => groups.findIndex((group) => group.includes(key));
  missing.sort((a, b) => priority(a) - priority(b) || b.localeCompare(a));

  const errors = [];
  const started = [];
  for (const key of missing) {
    const failure = STATE.failures.get(key);
    if (!forced.has(key) && failure && Date.now() - failure.at < 5 * 60_000) {
      errors.push({ month: key, message: failure.message });
      status[key].state = 'error';
      continue;
    }
    // Another instance (or an earlier request) is already loading this month.
    if (!STATE.inflight.has(key) && !forced.has(key) && await store.hasLock(`month:${key}`)) {
      status[key].state = 'loading';
      continue;
    }
    if (!STATE.inflight.has(key) && started.length >= MAX_NEW_LOADS_PER_REQUEST) {
      status[key].state = 'pending';
      continue;
    }
    const previous = forced.has(key) ? null : entries.get(key);
    const promise = loadMonth(token, key, previous, startedAt).then(
      (entry) => {
        entries.set(key, entry);
        status[key] = {
          state: entry.data.partial ? 'pending' : 'fresh',
          savedAt: entry.savedAt,
          orders: entry.data.orders.length,
          candidates: entry.data.candidates,
        };
        for (const message of entry.data.errors || []) errors.push({ month: key, message });
      },
      (error) => {
        errors.push({ month: key, message: error.message });
        status[key].state = entries.has(key) ? 'stale' : 'error';
      },
    );
    status[key].state = 'loading';
    started.push(promise);
  }

  if (started.length) {
    const waitMs = Math.max(0, FOREGROUND_WAIT_MS - (Date.now() - startedAt));
    const allLoads = Promise.all(started);
    const result = await Promise.race([allLoads, timeout(waitMs)]);
    if (result === 'timeout') store.waitUntil(allLoads);
  }

  for (const key of background) {
    status[key].refreshing = true;
    store.waitUntil(loadMonth(token, key, entries.get(key), startedAt));
  }
  const pending = all.filter((key) => ['loading', 'pending'].includes(status[key].state));
  return { entries, status, pending, errors };
}

// Cache-only overview: orders per month (history depth) and the statuses /
// cancellation codes that really occur in one month. Never calls Kaspi.
async function history({ months, statusMonth }) {
  const keys = months && months.length ? months : periods.monthsBetween(
    periods.addMonths(periods.resolvePeriod({ preset: 'today' }).from, -24),
    periods.resolvePeriod({ preset: 'today' }).from,
  );
  const entries = await store.readMonths(keys);
  const perMonth = keys.map((key) => {
    const entry = entries.get(key);
    if (!entry) return { month: key, cached: false };
    const orders = entry.data.orders;
    const sales = orders.filter((order) => order.kind === 'sale');
    return {
      month: key,
      cached: true,
      savedAt: new Date(entry.savedAt).toISOString(),
      sales: sales.length,
      revenue: Math.round(sales.reduce((sum, order) => sum + (Number(order.total) || 0), 0)),
      cancelled: orders.filter((order) => order.kind === 'cancel').length,
      returned: orders.filter((order) => order.kind === 'return').length,
    };
  });
  let statuses = null;
  const target = statusMonth && entries.get(statusMonth) ? entries.get(statusMonth) : null;
  if (target) {
    const counts = new Map();
    for (const order of target.data.orders) {
      const info = order.cancelInfo ? Object.entries(order.cancelInfo).map(([k, v]) => `${k}=${v}`).sort().join(', ') : '';
      const key = [order.kind, order.status || '—', order.state || '—', info || (order.kind === 'sale' ? '' : 'без кода причины')].join(' | ');
      const row = counts.get(key) || { kind: order.kind, status: order.status, state: order.state || '', codes: info, orders: 0, amount: 0 };
      row.orders += 1;
      row.amount += Number(order.total) || 0;
      counts.set(key, row);
    }
    statuses = { month: statusMonth, rows: [...counts.values()].sort((a, b) => b.orders - a.orders) };
  }
  return { ok: true, months: perMonth, statuses };
}

function diagnostics() {
  return { inflight: [...STATE.inflight.keys()], recentLoads: STATE.loadLog.slice(0, 15) };
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

  const usable = (key) => months.entries.has(key) && !months.entries.get(key).data.partial;
  const orders = [...months.entries.entries()]
    .filter(([key]) => usable(key))
    .flatMap(([, entry]) => entry.data.orders);
  const { lines, excluded } = finance.explodeLines(orders, catalogResult.catalog, settings);
  const saleLines = lines.filter((line) => line.kind === 'sale');
  const cancelLines = lines.filter((line) => line.kind !== 'sale');

  // History completeness: months before historyFrom have incomplete Kaspi data.
  const currentMonth = periods.monthKey(period.today);
  const closedStats = [...months.entries.entries()]
    .filter(([key, entry]) => usable(key) && key < currentMonth && entry.data.orders.length >= 0)
    .map(([key, entry]) => {
      const sales = entry.data.orders.filter((order) => order.kind === 'sale');
      return { month: key, sales: sales.length, revenue: sales.reduce((sum, order) => sum + (Number(order.total) || 0), 0) };
    });
  const detected = finance.detectHistoryStart(closedStats);
  if (detected && detected !== settings.detectedHistoryFrom) {
    store.waitUntil(store.saveSettings({ detectedHistoryFrom: detected }).catch(() => null));
  }
  const historyFrom = settings.historyCompleteFrom || detected || settings.detectedHistoryFrom || '';
  const incompleteMonth = (key) => Boolean(historyFrom) && key < historyFrom;

  const summaryFor = (range, monthKeys) => {
    const bounds = periods.rangeBounds(range.from, range.to);
    const incomplete = monthKeys.some(incompleteMonth);
    const available = monthKeys.every(usable) && !incomplete;
    const unfiltered = finance.summarize({
      saleLines, cancelLines, expenses, settings, bounds, from: range.from, to: range.to, filters: {},
    });
    const result = finance.filterActive(filters)
      ? finance.summarize({
        saleLines, cancelLines, expenses, settings, bounds, from: range.from, to: range.to, filters,
        totalRevenueUnfiltered: unfiltered.summary.revenue,
      })
      : unfiltered;
    return { ...result, available, incomplete, range };
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
      previous: { ...comparison.previous, available: previous.available, incompleteHistory: previous.incomplete },
      yoy: { ...comparison.yoy, available: yoy.available, incompleteHistory: yoy.incomplete },
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
    months: Object.fromEntries(Object.entries(months.status).map(([key, value]) => [
      key, { ...value, incompleteHistory: incompleteMonth(key) },
    ])),
    history: {
      completeFrom: historyFrom,
      source: settings.historyCompleteFrom ? 'settings' : historyFrom ? 'auto' : '',
      currentIncomplete: groups[0].some(incompleteMonth),
    },
    pendingMonths: months.pending,
    complete: groups[0].every((key) => usable(key) && !months.pending.includes(key)),
    errors: months.errors,
    diagnostics: { excludedTenTengeOrders: excluded, storage: store.storageStatus() },
    ms: Date.now() - startedAt,
  };
  return response;
}

module.exports = { SERVICE_VERSION, dashboard, diagnostics, history, __test: { monthState } };
