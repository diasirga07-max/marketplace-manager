'use strict';

// Pure computation of quality metrics from normalized Kaspi orders.
// Input orders come from lib/quality/loader.js (normalizeOrder), see the
// field list there. Nothing here talks to Kaspi or storage.

const F = require('./formulas');

const { DAY_MS } = F;

const CANCEL_STATUSES = ['CANCELLED', 'CANCELLING'];
const FINISHED_STATUSES = ['COMPLETED', 'CANCELLED', 'CANCELLING', 'RETURNED', 'KASPI_DELIVERY_RETURN_REQUESTED'];

// Real cancellationReason values seen in this shop (probe 23.10–21.11):
// BUYER_CANCELLATION_HIMSELF, GLOBAL_TIMEOUT, TIMEOUT_MERCHANT_DELIVERY,
// TIMEOUT_BUYER_PICKUP, PRODUCT_OUT_OF_STOCK, MERCHANT_OUT_OF_STOCK,
// RFO_REJECTED, TECHNICAL_PROBLEM_CANCELLATION.
// Default «seller fault» list — editable in the UI (settings).
const DEFAULT_CONFIG = Object.freeze({
  thresholds: F.DEFAULT_THRESHOLDS,
  customTargets: {},
  sellerFaultReasons: ['MERCHANT_OUT_OF_STOCK', 'PRODUCT_OUT_OF_STOCK', 'TIMEOUT_MERCHANT_DELIVERY'],
  // finished = only closed orders (ARCHIVE). Matches the cabinet denominator
  // (2111 vs 2112 archived orders for 23.10–21.11); all = every created order.
  cancelDenominator: 'finished',
  delayGraceMinutes: 0,
  returnStatuses: ['RETURNED', 'KASPI_DELIVERY_RETURN_REQUESTED'],
  // Substrings (case-insensitive) of return reasons from the cabinet export
  // that count as «по качеству».
  qualityReturnReasons: ['брак', 'дефект', 'качеств', 'поврежд', 'не соответств', 'не работает', 'некомплект', 'defect', 'damaged', 'quality'],
  brandOverrides: {},
  orderUrlTemplate: 'https://kaspi.kz/mc/#/orders/{code}',
});

const DIMENSIONS = ['brand', 'sku', 'category'];
const UNKNOWN_ITEMS = '(состав заказа ещё не загружен)';

function upper(v) {
  return String(v == null ? '' : v).trim().toUpperCase();
}

function mergeConfig(input = {}) {
  const thresholds = {};
  for (const [key, base] of Object.entries(F.DEFAULT_THRESHOLDS)) {
    const given = (input.thresholds && input.thresholds[key]) || {};
    thresholds[key] = { ...base };
    for (const field of ['good', 'bad']) {
      const n = Number(given[field]);
      if (given[field] !== undefined && given[field] !== null && given[field] !== '' && Number.isFinite(n)) thresholds[key][field] = n;
    }
  }
  const list = (value, fallback) => (Array.isArray(value) ? value.map((x) => String(x).trim()).filter(Boolean) : fallback);
  const overrides = {};
  for (const [sku, brand] of Object.entries(input.brandOverrides || {})) {
    if (upper(sku) && String(brand || '').trim()) overrides[upper(sku)] = String(brand).trim().slice(0, 80);
  }
  const custom = {};
  for (const [key, value] of Object.entries(input.customTargets || {})) {
    const n = Number(value);
    if (value !== null && value !== '' && Number.isFinite(n) && n > 0) custom[key] = n;
  }
  return {
    ...DEFAULT_CONFIG,
    thresholds,
    customTargets: custom,
    sellerFaultReasons: list(input.sellerFaultReasons, DEFAULT_CONFIG.sellerFaultReasons).map(upper),
    cancelDenominator: input.cancelDenominator === 'all' ? 'all' : 'finished',
    delayGraceMinutes: Math.max(0, Math.min(24 * 60, Number(input.delayGraceMinutes) || 0)),
    returnStatuses: list(input.returnStatuses, DEFAULT_CONFIG.returnStatuses).map(upper),
    qualityReturnReasons: list(input.qualityReturnReasons, DEFAULT_CONFIG.qualityReturnReasons).map((x) => x.toLowerCase()),
    brandOverrides: overrides,
    orderUrlTemplate: String(input.orderUrlTemplate || DEFAULT_CONFIG.orderUrlTemplate).slice(0, 300),
  };
}

// ---------- brand ----------

// Order of brand resolution (spec): (a) warehouse sheet SKU→brand,
// (b) manual brand_overrides, (c) first word of the product name («авто»).
function brandResolver({ sheetBrands = new Map(), overrides = {} } = {}) {
  return function resolve(sku, name) {
    const key = upper(sku);
    const fromSheet = key && sheetBrands.get(key);
    if (fromSheet) return { brand: fromSheet, source: 'sheet' };
    if (key && overrides[key]) return { brand: overrides[key], source: 'manual' };
    const word = String(name || '').trim().split(/[\s,.:;«»"()/]+/).find((w) => w && w.length > 1);
    return word ? { brand: word.charAt(0).toUpperCase() + word.slice(1), source: 'auto' } : { brand: 'Без бренда', source: 'auto' };
  };
}

// ---------- classification of a single order ----------

function returnInfo(order, returnsByCode, config) {
  const rec = returnsByCode && returnsByCode.get(String(order.code));
  if (!rec || !String(rec.reason || '').trim()) return { reason: '', kind: 'unknown' };
  if (rec.quality === true) return { reason: rec.reason, kind: 'quality' };
  if (rec.quality === false) return { reason: rec.reason, kind: 'other' };
  const text = String(rec.reason).toLowerCase();
  const quality = config.qualityReturnReasons.some((p) => p && text.includes(p));
  return { reason: rec.reason, kind: quality ? 'quality' : 'other' };
}

function isReturned(order, config, returnsByCode) {
  if (config.returnStatuses.includes(upper(order.status))) return true;
  // A return from the cabinet export also counts if the API status lags.
  return Boolean(returnsByCode && returnsByCode.has(String(order.code)) && upper(order.status) === 'COMPLETED');
}

// Each metric: inDenominator(order) and bad(order) → false | { reason }.
function metricDefs(config, { now, returnsByCode }) {
  const grace = config.delayGraceMinutes * 60_000;
  return {
    cancels: {
      label: 'Отмены по вине продавца',
      inDenominator: (o) => (config.cancelDenominator === 'all' ? true : FINISHED_STATUSES.includes(upper(o.status)) || upper(o.state) === 'ARCHIVE'),
      bad: (o) => (CANCEL_STATUSES.includes(upper(o.status)) && config.sellerFaultReasons.includes(upper(o.reason))
        ? { reason: upper(o.reason) } : false),
      eventAt: (o) => o.createdAt,
    },
    delays: {
      label: 'Задержки передачи в Kaspi Доставку',
      inDenominator: (o) => {
        if (!o.kd || !o.planTransfer || o.planTransfer > now) return false;
        // Cancelled before the courier took it: no transfer was owed.
        if (!o.transfer && CANCEL_STATUSES.includes(upper(o.status))) return false;
        // Delivered, but the API did not return the transfer date: unknown.
        if (!o.transfer && ['COMPLETED', 'RETURNED', 'KASPI_DELIVERY_RETURN_REQUESTED'].includes(upper(o.status))) return false;
        return true;
      },
      bad: (o) => {
        const plan = o.planOrig && o.planOrig < o.planTransfer ? o.planOrig : o.planTransfer;
        if (o.transfer) {
          return o.transfer > plan + grace
            ? { reason: `передано позже ${plan < o.planTransfer ? 'первоначального плана' : 'плана'} на ${Math.max(1, Math.round((o.transfer - plan) / 3_600_000))} ч` } : false;
        }
        return now > plan + grace ? { reason: 'не передано, плановая дата прошла' } : false;
      },
      eventAt: (o) => o.createdAt,
    },
    returns: {
      label: 'Возвраты по качеству',
      inDenominator: (o) => upper(o.status) === 'COMPLETED' || config.returnStatuses.includes(upper(o.status)),
      bad: (o) => {
        if (!isReturned(o, config, returnsByCode)) return false;
        const info = returnInfo(o, returnsByCode, config);
        return info.kind === 'quality' ? { reason: info.reason || 'качество' } : false;
      },
      // Returns with no known reason are counted separately (upper bound).
      unknown: (o) => isReturned(o, config, returnsByCode) && returnInfo(o, returnsByCode, config).kind === 'unknown',
      eventAt: (o) => o.createdAt,
    },
  };
}

// ---------- window helpers ----------

function inWindow(order, from, to) {
  return order.createdAt >= from && order.createdAt <= to;
}

function orderGroups(order, dim, resolveBrand) {
  const items = Array.isArray(order.items) ? order.items : null;
  if (!items || !items.length) return [{ key: UNKNOWN_ITEMS, label: UNKNOWN_ITEMS, auto: false, missing: true }];
  const map = new Map();
  for (const item of items) {
    if (dim === 'sku') {
      const key = upper(item.sku) || UNKNOWN_ITEMS;
      if (!map.has(key)) map.set(key, { key, label: item.name || key, auto: false, sku: item.sku });
    } else if (dim === 'category') {
      const key = String(item.catTitle || item.catCode || 'Без категории');
      if (!map.has(key)) map.set(key, { key, label: key, auto: false });
    } else {
      const b = resolveBrand(item.sku, item.name);
      if (!map.has(b.brand)) map.set(b.brand, { key: b.brand, label: b.brand, auto: b.source === 'auto', source: b.source });
    }
  }
  return [...map.values()];
}

function distinctSkus(order) {
  return new Set((order.items || []).map((i) => upper(i.sku)).filter(Boolean)).size;
}

function filterOrders(orders, { brand, category } = {}, resolveBrand) {
  if (!brand && !category) return orders;
  return orders.filter((o) => {
    const items = o.items || [];
    if (brand && !items.some((i) => resolveBrand(i.sku, i.name).brand === brand)) return false;
    if (category && !items.some((i) => String(i.catTitle || i.catCode || 'Без категории') === category)) return false;
    return true;
  });
}

// One metric value for a window.
function evaluate(def, orders, from, to) {
  let total = 0;
  let bad = 0;
  let unknown = 0;
  const events = [];
  const counted = [];
  for (const o of orders) {
    if (!inWindow(o, from, to) || !def.inDenominator(o)) continue;
    total += 1;
    counted.push(def.eventAt(o));
    if (def.bad(o)) {
      bad += 1;
      events.push(def.eventAt(o));
    } else if (def.unknown && def.unknown(o)) unknown += 1;
  }
  return { bad, total, unknown, value: F.rate(bad, total), events, counted };
}

function breakdown(def, orders, { from, to, totals, resolveBrand }) {
  const weekAgo = to - 7 * DAY_MS;
  const twoWeeks = to - 14 * DAY_MS;
  const dims = {};
  for (const dim of DIMENSIONS) {
    const groups = new Map();
    for (const o of orders) {
      if (!inWindow(o, from, to) || !def.inDenominator(o)) continue;
      const badInfo = def.bad(o);
      const multi = distinctSkus(o) > 1;
      for (const g of orderGroups(o, dim, resolveBrand)) {
        let row = groups.get(g.key);
        if (!row) {
          row = { key: g.key, label: g.label, auto: g.auto, source: g.source, sku: g.sku, orders: 0, bad: 0, multiBad: 0, reasons: {}, last7: { orders: 0, bad: 0 }, prev7: { orders: 0, bad: 0 } };
          groups.set(g.key, row);
        }
        row.orders += 1;
        const bucket = o.createdAt > weekAgo ? row.last7 : o.createdAt > twoWeeks ? row.prev7 : null;
        if (bucket) bucket.orders += 1;
        if (badInfo) {
          row.bad += 1;
          if (multi) row.multiBad += 1;
          const reason = badInfo.reason || '—';
          row.reasons[reason] = (row.reasons[reason] || 0) + 1;
          if (bucket) bucket.bad += 1;
        }
      }
    }
    const rows = [...groups.values()].map((row) => ({
      ...row,
      rate: F.rate(row.bad, row.orders),
      contribution: totals.total ? row.bad / totals.total : 0, // share of all store orders (×100 = п.п.)
      share: totals.bad ? row.bad / totals.bad : 0,
      whatIf: F.whatIfWithout({ bad: totals.bad, total: totals.total, groupBad: row.bad }),
      trend: {
        last7: F.rate(row.last7.bad, row.last7.orders),
        prev7: F.rate(row.prev7.bad, row.prev7.orders),
        last7Bad: row.last7.bad,
        prev7Bad: row.prev7.bad,
      },
    }));
    rows.sort((a, b) => b.contribution - a.contribution || b.bad - a.bad || b.orders - a.orders);
    rows.forEach((row, i) => { row.top = i < 5 && row.bad > 0; });
    dims[dim] = rows;
  }
  return dims;
}

function orderList(def, orders, { from, to, dim, key, resolveBrand, onlyBad = true, config }) {
  const out = [];
  for (const o of orders) {
    if (!inWindow(o, from, to) || !def.inDenominator(o)) continue;
    const badInfo = def.bad(o);
    const isUnknown = !badInfo && def.unknown && def.unknown(o);
    if (onlyBad && !badInfo && !isUnknown) continue;
    if (dim && key != null && !orderGroups(o, dim, resolveBrand).some((g) => g.key === key)) continue;
    out.push({
      code: o.code,
      createdAt: o.createdAt,
      status: o.status,
      state: o.state,
      reason: badInfo ? badInfo.reason : isUnknown ? 'причина неизвестна' : o.reason || '',
      bad: Boolean(badInfo),
      unknown: Boolean(isUnknown),
      multi: distinctSkus(o) > 1,
      planTransfer: o.planTransfer || 0,
      transfer: o.transfer || 0,
      items: (o.items || []).map((i) => ({ sku: i.sku, name: i.name, qty: i.qty })),
      url: config.orderUrlTemplate.replace('{code}', encodeURIComponent(o.code)),
    });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

// ---------- recommendations ----------

const REASON_ADVICE = {
  MERCHANT_OUT_OF_STOCK: 'проверь остаток на складе / переведи в предзаказ или сними с продажи',
  PRODUCT_OUT_OF_STOCK: 'проверь остаток на складе / переведи в предзаказ или сними с продажи',
  TIMEOUT_MERCHANT_DELIVERY: 'не успеваете передать вовремя: увеличь срок предзаказа или ускорь сборку',
  TECHNICAL_PROBLEM_CANCELLATION: 'проверь заказ в кабинете — техническая отмена',
};
const REASON_LABEL = {
  MERCHANT_OUT_OF_STOCK: 'нет в наличии (продавец)',
  PRODUCT_OUT_OF_STOCK: 'нет в наличии',
  TIMEOUT_MERCHANT_DELIVERY: 'истёк срок передачи продавцом',
  BUYER_CANCELLATION_HIMSELF: 'покупатель отменил сам',
  GLOBAL_TIMEOUT: 'общий таймаут',
  TIMEOUT_BUYER_PICKUP: 'покупатель не забрал',
  RFO_REJECTED: 'отказ в рассрочке/кредите',
  TECHNICAL_PROBLEM_CANCELLATION: 'техническая проблема',
};

function recommendations(metrics, details) {
  const out = [];
  const cancelSku = details.cancels && details.cancels.sku;
  if (metrics.cancels.bad > 0 && cancelSku) {
    for (const row of cancelSku.filter((r) => r.bad > 0).slice(0, 3)) {
      const [reason, count] = Object.entries(row.reasons).sort((a, b) => b[1] - a[1])[0] || ['', 0];
      const all = count === row.bad ? 'все' : `${count} из ${row.bad}`;
      const advice = REASON_ADVICE[reason] || 'разбери заказы и причины';
      out.push({
        metric: 'cancels',
        severity: row.share >= 0.2 ? 'high' : 'medium',
        text: `SKU ${row.key} («${row.label}») дал ${row.bad} из ${metrics.cancels.bad} отмен, ${all} по причине «${REASON_LABEL[reason] || reason}»: ${advice}.`,
        key: row.key,
      });
    }
  }
  const delaySku = details.delays && details.delays.sku;
  if (metrics.delays.bad > 0 && delaySku) {
    const row = delaySku.find((r) => r.bad > 0);
    if (row) out.push({ metric: 'delays', severity: row.share >= 0.2 ? 'high' : 'medium', text: `Больше всего задержек передачи у SKU ${row.key} («${row.label}»): ${row.bad} из ${metrics.delays.bad}. Проверь наличие и срок сборки для этого товара.`, key: row.key });
  }
  if (metrics.returns.unknown > 0) {
    out.push({ metric: 'returns', severity: 'medium', text: `${metrics.returns.unknown} возврат(ов) без причины: API Kaspi не отдаёт причину возврата. Выгрузи возвраты из кабинета и загрузи CSV/XLSX, чтобы отделить возвраты по качеству.` });
  }
  for (const key of ['cancels', 'delays', 'returns']) {
    const m = metrics[key];
    if (m.weekDelta != null && m.weekDelta > 0.001 && m.value != null) {
      out.push({ metric: key, severity: 'medium', text: `${m.label}: показатель ухудшился за неделю на ${(m.weekDelta * 100).toFixed(2).replace('.', ',')} п.п.` });
    }
  }
  return out;
}

// Distribution of (courierTransmissionDate − plan) for Kaspi Delivery orders:
// shows whether the API plan date is ever earlier than the actual transfer.
function delayDiagnostics(orders, win, now) {
  const buckets = { early24: 0, early0_24: 0, onTime: 0, late0_1: 0, late1_24: 0, late24: 0 };
  let withTransfer = 0;
  let planMoved = 0;
  let overdueNoTransfer = 0;
  let futurePlan = 0;
  const H = 3_600_000;
  for (const o of orders) {
    if (!o.kd || !inWindow(o, win.from, win.to)) continue;
    if (o.planOrig && o.planTransfer && o.planOrig < o.planTransfer) planMoved += 1;
    if (!o.planTransfer) continue;
    if (o.planTransfer > now) { futurePlan += 1; continue; }
    if (!o.transfer) {
      if (!CANCEL_STATUSES.includes(upper(o.status)) && !['COMPLETED', 'RETURNED'].includes(upper(o.status))) overdueNoTransfer += 1;
      continue;
    }
    withTransfer += 1;
    const d = o.transfer - o.planTransfer;
    if (d < -24 * H) buckets.early24 += 1;
    else if (d < 0) buckets.early0_24 += 1;
    else if (d === 0) buckets.onTime += 1;
    else if (d <= H) buckets.late0_1 += 1;
    else if (d <= 24 * H) buckets.late1_24 += 1;
    else buckets.late24 += 1;
  }
  return { withTransfer, buckets, planMoved, overdueNoTransfer, futurePlan };
}

// ---------- main ----------

function isoDay(ms) {
  return new Date(ms + 5 * 3_600_000).toISOString().slice(0, 10); // Asia/Almaty, UTC+5
}

// Window [from, to] in ms for N days ending on the Almaty day of `asOf`.
function windowFor(asOfMs, days) {
  const day = isoDay(asOfMs);
  const to = Date.parse(`${day}T23:59:59.999+05:00`);
  const from = to - days * DAY_MS + 1;
  return { from, to, fromDay: isoDay(from), toDay: day };
}

function computeDashboard({ orders, config: rawConfig, sheetBrands, returnsByCode, now, days = 30, asOf, filters = {} }) {
  const config = mergeConfig(rawConfig);
  const resolveBrand = brandResolver({ sheetBrands, overrides: config.brandOverrides });
  const end = asOf != null ? Math.min(asOf, now) : now;
  const win = windowFor(end, days);
  const evalNow = Math.min(now, win.to);
  const defs = metricDefs(config, { now: evalNow, returnsByCode });
  const scoped = filterOrders(orders, filters, resolveBrand);
  const prevWin = { from: win.from - 7 * DAY_MS, to: win.to - 7 * DAY_MS };
  const prevDefs = metricDefs(config, { now: evalNow - 7 * DAY_MS, returnsByCode });

  const metrics = {};
  const details = {};
  for (const [key, def] of Object.entries(defs)) {
    const cur = evaluate(def, scoped, win.from, win.to);
    const prev = evaluate(prevDefs[key], scoped, prevWin.from, prevWin.to);
    const threshold = config.thresholds[key];
    const target = config.customTargets[key] || threshold.good;
    const dailyOrders = F.perDay(cur.total, days);
    metrics[key] = {
      key,
      label: def.label,
      bad: cur.bad,
      total: cur.total,
      unknown: cur.unknown,
      value: cur.value,
      upperBound: cur.unknown ? F.rate(cur.bad + cur.unknown, cur.total) : undefined,
      prevValue: prev.value,
      weekDelta: cur.value != null && prev.value != null ? cur.value - prev.value : null,
      zone: F.zone(cur.value, threshold),
      threshold,
      target,
      calculator: F.rateCalculator({ bad: cur.bad, total: cur.total, target, windowDays: days }),
      forecast: F.forecast({ events: cur.events, orders: cur.counted, dailyOrders, now: evalNow, windowDays: days, target, horizonDays: 30 }),
    };
    details[key] = breakdown(def, scoped, { from: win.from, to: win.to, totals: cur, resolveBrand });
  }

  // Raw cancellation reasons for manual labelling (all cancelled orders).
  const reasons = {};
  const statuses = {};
  let missingItems = 0;
  let kdWithoutPlan = 0;
  let kdWithTransfer = 0;
  let kdTotal = 0;
  for (const o of scoped) {
    if (!inWindow(o, win.from, win.to)) continue;
    statuses[o.status || '—'] = (statuses[o.status || '—'] || 0) + 1;
    if (CANCEL_STATUSES.includes(upper(o.status))) {
      const r = upper(o.reason) || '—';
      reasons[r] = reasons[r] || { count: 0, sellerFault: config.sellerFaultReasons.includes(r), label: REASON_LABEL[r] || '' };
      reasons[r].count += 1;
    }
    if (!Array.isArray(o.items)) missingItems += 1;
    if (o.kd) {
      kdTotal += 1;
      if (!o.planTransfer) kdWithoutPlan += 1;
      if (o.transfer) kdWithTransfer += 1;
    }
  }

  const delayStats = delayDiagnostics(scoped, win, evalNow);
  const facets = { brands: new Map(), categories: new Map() };
  for (const o of orders) {
    if (!inWindow(o, win.from, win.to)) continue;
    for (const i of o.items || []) {
      const b = resolveBrand(i.sku, i.name).brand;
      facets.brands.set(b, (facets.brands.get(b) || 0) + 1);
      const c = String(i.catTitle || i.catCode || 'Без категории');
      facets.categories.set(c, (facets.categories.get(c) || 0) + 1);
    }
  }

  return {
    window: { ...win, days, now: evalNow },
    config,
    metrics,
    details,
    recommendations: recommendations(metrics, details),
    cancellationReasons: Object.entries(reasons).map(([code, v]) => ({ code, ...v })).sort((a, b) => b.count - a.count),
    statuses,
    delayStats,
    coverage: { orders: scoped.filter((o) => inWindow(o, win.from, win.to)).length, missingItems, kdTotal, kdWithoutPlan, kdWithTransfer },
    facets: {
      brands: [...facets.brands.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
      categories: [...facets.categories.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    },
  };
}

function computeOrders({ orders, config: rawConfig, sheetBrands, returnsByCode, now, days = 30, asOf, metric, dim, key, filters = {} }) {
  const config = mergeConfig(rawConfig);
  const resolveBrand = brandResolver({ sheetBrands, overrides: config.brandOverrides });
  const win = windowFor(asOf != null ? Math.min(asOf, now) : now, days);
  const defs = metricDefs(config, { now: Math.min(now, win.to), returnsByCode });
  const def = defs[metric];
  if (!def) throw new Error('Неизвестная метрика');
  const scoped = filterOrders(orders, filters, resolveBrand);
  return { window: win, metric, dim: dim || null, key: key ?? null, orders: orderList(def, scoped, { from: win.from, to: win.to, dim, key, resolveBrand, config }) };
}

// Rating / chats from the latest cabinet snapshot and imported reviews.
function manualMetrics({ snapshot, reviews = [], now, config: rawConfig }) {
  const config = mergeConfig(rawConfig);
  const t = config.thresholds;
  const win90 = windowFor(now, 90);
  const inWin = reviews.filter((r) => r.at >= win90.from && r.at <= win90.to && Number(r.rating) >= 1 && Number(r.rating) <= 5);
  const importedSum = inWin.reduce((s, r) => s + Number(r.rating), 0);
  const rating = snapshot && snapshot.rating && Number(snapshot.rating.count) > 0
    ? { source: 'snapshot', average: Number(snapshot.rating.value), count: Number(snapshot.rating.count), from: snapshot.rating.from, to: snapshot.rating.to, sum: null }
    : inWin.length ? { source: 'import', average: importedSum / inWin.length, count: inWin.length, sum: importedSum, from: win90.fromDay, to: win90.toDay } : null;
  const ratingTarget = config.customTargets.rating || t.rating.good;
  const chats = snapshot && snapshot.chats && Number(snapshot.chats.total) > 0 ? snapshot.chats : null;
  const chatTarget = config.customTargets.chats || null;
  return {
    rating: rating ? {
      ...rating,
      zone: F.zone(rating.average, t.rating),
      target: ratingTarget,
      calculator: F.ratingCalculator({ average: rating.average, count: rating.count, sum: rating.sum, target: ratingTarget }),
      importedInWindow: inWin.length,
    } : null,
    chats: chats ? {
      answered: Number(chats.answered) || 0,
      total: Number(chats.total) || 0,
      value: F.rate(chats.answered, chats.total),
      avgMinutes: chats.avgMinutes == null || chats.avgMinutes === '' ? null : Number(chats.avgMinutes),
      target: chatTarget,
      needed: chatTarget ? F.chatsNeeded({ answered: chats.answered, total: chats.total, target: chatTarget }) : null,
      from: chats.from || snapshot.from || '',
      to: chats.to || snapshot.date || '',
    } : null,
  };
}

// «Расхождение с кабинетом»: our numbers for the snapshot window vs the cabinet.
function calibration({ orders, config, sheetBrands, returnsByCode, now, snapshot }) {
  if (!snapshot || !snapshot.date) return null;
  const asOf = Date.parse(`${snapshot.date}T23:59:59.999+05:00`);
  if (!Number.isFinite(asOf)) return null;
  const ours = computeDashboard({ orders, config, sheetBrands, returnsByCode, now, days: 30, asOf });
  const rows = [];
  for (const key of ['cancels', 'delays', 'returns']) {
    const cab = snapshot[key];
    if (!cab || !Number(cab.total)) continue;
    const m = ours.metrics[key];
    const cabValue = F.rate(cab.bad, cab.total);
    rows.push({
      key,
      label: m.label,
      ours: { bad: m.bad, total: m.total, value: m.value, unknown: m.unknown, upperBound: m.upperBound },
      cabinet: { bad: Number(cab.bad), total: Number(cab.total), value: cabValue },
      diff: m.value != null && cabValue != null ? m.value - cabValue : null,
      diffBad: m.bad - Number(cab.bad),
      diffTotal: m.total - Number(cab.total),
    });
  }
  return { date: snapshot.date, window: ours.window, rows, coverage: ours.coverage, statuses: ours.statuses, cancellationReasons: ours.cancellationReasons };
}

module.exports = {
  CANCEL_STATUSES,
  DEFAULT_CONFIG,
  REASON_LABEL,
  brandResolver,
  calibration,
  computeDashboard,
  computeOrders,
  isoDay,
  manualMetrics,
  mergeConfig,
  windowFor,
};
