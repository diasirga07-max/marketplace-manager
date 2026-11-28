'use strict';

// Flip business logic: pending orders (remembering when each unit was first
// seen), the site's new-order check, sales report and daily totals.
// New-order notifications are shown by the site itself (badge, sound, browser
// notification, tab title) — see public/gb-flip.js. The 5-minute cron keeps
// the record up to date while the site is closed, so nothing is lost.

const client = require('./client');
const store = require('./store');
const sales = require('./sales');
const { almatyDateIso } = require('../sales-core');
const periods = require('../analytics/periods');

const KEY_SEEN = 'orders-seen';      // { initializedAt, ids: { [preorderId]: firstSeenAt } }
const KEY_CURRENT = 'orders-current'; // last snapshot of pending orders, firstSeenAt attached
const KEY_DAILY = 'sales-daily';     // { days: { [YYYY-MM-DD]: { revenue, units, savedAt } }, supplierType }
const SEEN_TTL_MS = 60 * 86_400_000; // forget ids that left the queue 60+ days ago
const DAY_MS = 86_400_000;
const INITIAL_SEEN = 1;              // firstSeenAt of orders found by the very first sync (not "new")
const CHECK_MAX_AGE_MS = 55_000;     // the site checks once a minute; one Flip request per minute at most

function flatUnits(groups) {
  const units = [];
  for (const group of groups) {
    for (const item of group.items) units.push({ ...item, store: group.groupStoreName, groupName: group.groupName });
  }
  return units;
}

function attachSeen(snapshot, ids) {
  for (const group of snapshot.groups) {
    for (const item of group.items) item.firstSeenAt = item.preorderId && ids[item.preorderId] ? ids[item.preorderId] : null;
  }
  return snapshot;
}

// Pure core of the sync — decides what is new and what to remember.
// On the first run every current order is remembered as "already there".
function diffOrders(state, snapshot, now = Date.now()) {
  const units = flatUnits(snapshot.groups).filter((u) => u.preorderId);
  const firstRun = !state || !state.initializedAt;
  const ids = { ...((state && state.ids) || {}) };
  const fresh = units.filter((u) => !ids[u.preorderId]);
  for (const unit of fresh) ids[unit.preorderId] = firstRun ? INITIAL_SEEN : now;
  const current = new Set(units.map((u) => u.preorderId));
  for (const [id, seenAt] of Object.entries(ids)) {
    const age = Number(seenAt) === INITIAL_SEEN ? now - ((state && state.initializedAt) || now) : now - Number(seenAt);
    if (!current.has(id) && age > SEEN_TTL_MS) delete ids[id];
  }
  return { firstRun, fresh: firstRun ? [] : fresh, next: { initializedAt: (state && state.initializedAt) || now, ids } };
}

// Fetch every pending order from Flip, remember new preorderIds, save the snapshot.
async function syncOrders({ fetchImpl } = {}) {
  if (!store.durable()) throw new Error('Учёт заказов Flip требует постоянного хранилища (GOOGLE_SERVICE_ACCOUNT_JSON): без него каждый запуск считался бы первым');
  if (await store.hasLock('poll')) return { ok: true, skipped: 'Опрос уже выполняется' };
  await store.setLock('poll', 120_000);
  try {
    const state = await store.getValue(KEY_SEEN, null, { fresh: true });
    const snapshot = await client.fetchPendingOrders({ fetchImpl });
    const diff = diffOrders(state, snapshot);
    const saved = await store.set(KEY_SEEN, diff.next);
    if (!saved.persisted) throw new Error(`Не удалось сохранить виденные заказы: ${saved.reason}`);
    await store.set(KEY_CURRENT, attachSeen(snapshot, diff.next.ids));
    return { ok: true, firstRun: diff.firstRun, pending: snapshot.units, newOrders: diff.fresh.length };
  } finally {
    await store.releaseLock('poll');
  }
}

// Vercel Cron, every 5 minutes.
async function poll(options) {
  return syncOrders(options);
}

// Orders page: live=1 syncs with Flip right now; otherwise the last snapshot.
async function orders({ live = false, fetchImpl } = {}) {
  let warning = '';
  if (live) {
    if (store.durable()) await syncOrders({ fetchImpl });
    else warning = 'Нет постоянного хранилища — заказы показаны без отметки «новый»';
  }
  const state = await store.getValue(KEY_SEEN, null);
  const entry = await store.get(KEY_CURRENT);
  if (entry && entry.value && (live ? store.durable() : Date.now() - entry.savedAt < 30 * 60_000)) {
    return { ...entry.value, source: live ? 'live' : 'snapshot', initialized: Boolean(state), warning };
  }
  const snapshot = await client.fetchPendingOrders({ fetchImpl });
  return { ...attachSeen(snapshot, (state && state.ids) || {}), source: 'live', initialized: Boolean(state), warning };
}

// Units first seen after `since`, newest first.
function newSince(snapshot, since) {
  const after = Math.max(Number(since) || 0, INITIAL_SEEN);
  const list = [];
  let pending = 0;
  for (const group of (snapshot && snapshot.groups) || []) {
    for (const item of group.items || []) {
      pending += 1;
      if (item.firstSeenAt && item.firstSeenAt > after) {
        list.push({ preorderId: item.preorderId, article: item.article, price: item.price, partnerCodes: item.partnerCodes || [], store: group.groupStoreName || '', firstSeenAt: item.firstSeenAt });
      }
    }
  }
  list.sort((a, b) => b.firstSeenAt - a.firstSeenAt);
  return { count: list.length, pending, latestSeenAt: list.length ? list[0].firstSeenAt : 0, items: list.slice(0, 10), total: list.reduce((n, u) => n + (u.price || 0), 0) };
}

// The site's once-a-minute check (also the menu badge). Syncs with Flip when the
// snapshot is older than a minute, so new orders show up within ~1 minute.
async function check({ since = 0, fetchImpl } = {}) {
  let warning = '';
  let entry = await store.get(KEY_CURRENT);
  const stale = !entry || Date.now() - entry.savedAt > CHECK_MAX_AGE_MS;
  if (stale && client.configured() && store.durable()) {
    try {
      await syncOrders({ fetchImpl });
      entry = await store.get(KEY_CURRENT);
    } catch (error) {
      warning = error.message; // fall back to the last snapshot
    }
  } else if (!store.durable()) {
    warning = 'Нет постоянного хранилища (GOOGLE_SERVICE_ACCOUNT_JSON) — новые заказы не отслеживаются';
  }
  const value = entry && entry.value;
  return { ...newSince(value, since), fetchedAt: value ? value.fetchedAt || entry.savedAt : null, warning };
}

// ---------- sales ----------

async function salesReport({ from, to, page = 1, limit = 100, fetchImpl } = {}) {
  if (!periods.isIsoDate(from) || !periods.isIsoDate(to)) throw new Error('Даты в формате ГГГГ-ММ-ДД');
  if (from > to) throw new Error('Дата «С» не может быть позже даты «По»');
  if (periods.daysBetween(from, to) > 366) throw new Error('Максимальный период — 366 дней');
  const summaryBody = await client.fetchSales({ dateFrom: from, dateTo: to, include: 'summary', fetchImpl });
  const report = sales.normalizeSummary(summaryBody);
  let items = null;
  if (report.supplierType === 'fee') {
    const itemsBody = await client.fetchSales({ dateFrom: from, dateTo: to, include: 'items', page, limit, fetchImpl });
    items = sales.normalizeItems(itemsBody);
  }
  return { ok: true, range: { from, to }, ...report, items, generatedAt: Date.now() };
}

async function dailyState() {
  return store.getValue(KEY_DAILY, { days: {} });
}

async function fetchDay(iso, { fetchImpl } = {}) {
  const body = await client.fetchSales({ dateFrom: iso, dateTo: iso, include: 'summary', fetchImpl });
  const report = sales.normalizeSummary(body);
  return { ...sales.dailyTotals(report), supplierType: report.supplierType, savedAt: Date.now() };
}

function yesterdayAlmaty(now = Date.now()) {
  return periods.addDays(almatyDateIso(now), -1);
}

// Vercel Cron, 01:00 Asia/Almaty: yesterday's totals (plus the day before, in case a run was missed).
async function dailyCron({ fetchImpl } = {}) {
  const state = await store.getValue(KEY_DAILY, { days: {} }, { fresh: true });
  const yesterday = yesterdayAlmaty();
  const dates = [yesterday, periods.addDays(yesterday, -1)].filter((d, i) => i === 0 || !state.days[d]);
  const saved = [];
  for (const iso of dates) {
    const day = await fetchDay(iso, { fetchImpl });
    state.days[iso] = { revenue: day.revenue, units: day.units, savedAt: day.savedAt };
    state.supplierType = day.supplierType || state.supplierType;
    saved.push({ date: iso, ...state.days[iso] });
    if (dates.length > 1) await client.sleep(1000);
  }
  const result = await store.set(KEY_DAILY, state);
  if (!result.persisted) throw new Error(`Не удалось сохранить итоги дня: ${result.reason}`);
  return { ok: true, saved };
}

// History fill: one request per day, with a pause; resumable across calls
// (stops before the function time limit and reports what is left).
async function backfill({ days = 90, force = false, pauseMs = 1200, budgetMs = 240_000, fetchImpl } = {}) {
  const total = Math.max(1, Math.min(366, Number(days) || 90));
  if (await store.hasLock('backfill')) throw new Error('Заполнение истории уже выполняется — попробуйте позже');
  await store.setLock('backfill', budgetMs + 60_000);
  const started = Date.now();
  try {
    const state = await store.getValue(KEY_DAILY, { days: {} }, { fresh: true });
    const yesterday = yesterdayAlmaty();
    const dates = Array.from({ length: total }, (_, i) => periods.addDays(yesterday, -i));
    const todo = dates.filter((d) => force || !state.days[d]);
    const done = [];
    const errors = [];
    for (const iso of todo) {
      if (Date.now() - started > budgetMs) break;
      try {
        const day = await fetchDay(iso, { fetchImpl });
        state.days[iso] = { revenue: day.revenue, units: day.units, savedAt: day.savedAt };
        state.supplierType = day.supplierType || state.supplierType;
        done.push(iso);
      } catch (error) {
        errors.push({ date: iso, error: error.message });
        if (error.status === 403 || error.code === 'not_configured') break;
      }
      if (done.length % 10 === 0 && done.length) await store.set(KEY_DAILY, state);
      await client.sleep(pauseMs);
    }
    const saved = await store.set(KEY_DAILY, state);
    if (!saved.persisted) throw new Error(`Не удалось сохранить историю: ${saved.reason}`);
    const remaining = dates.filter((d) => !state.days[d]).length;
    return { ok: true, requested: total, loaded: done.length, remaining, errors: errors.slice(0, 10), finished: remaining === 0 || (!done.length && errors.length > 0) };
  } finally {
    await store.releaseLock('backfill');
  }
}

// Chart series by day / week / month from the stored daily totals.
function buildSeries(daysMap, from, to, granularity) {
  const g = ['day', 'week', 'month'].includes(granularity) ? granularity : 'day';
  const buckets = periods.bucketList(from, to, g);
  const index = new Map(buckets.map((b) => [b.key, { key: b.key, label: b.label, from: b.from, to: b.to, revenue: 0, units: 0, days: 0, missing: 0 }]));
  for (let d = from; d <= to; d = periods.addDays(d, 1)) {
    const key = periods.bucketKey(periods.rangeBounds(d, d).ge, g);
    const bucket = index.get(key);
    if (!bucket) continue;
    const day = daysMap[d];
    if (day) { bucket.revenue += Number(day.revenue) || 0; bucket.units += Number(day.units) || 0; bucket.days += 1; } else bucket.missing += 1;
  }
  return [...index.values()];
}

async function dynamics({ from, to, granularity = 'day' } = {}) {
  const today = almatyDateIso();
  const end = periods.isIsoDate(to) ? (to > today ? today : to) : today;
  const start = periods.isIsoDate(from) ? from : periods.addDays(end, -29);
  if (start > end) throw new Error('Дата «С» не может быть позже даты «По»');
  if (periods.daysBetween(start, end) > 366) throw new Error('Максимальный период — 366 дней');
  const state = await dailyState();
  const series = buildSeries(state.days || {}, start, end, granularity);
  const summary = series.reduce((acc, b) => ({ revenue: acc.revenue + b.revenue, units: acc.units + b.units, missing: acc.missing + b.missing }), { revenue: 0, units: 0, missing: 0 });
  const stored = Object.keys(state.days || {}).sort();
  return {
    ok: true,
    range: { from: start, to: end, granularity: ['day', 'week', 'month'].includes(granularity) ? granularity : 'day' },
    series,
    summary,
    history: { days: stored.length, first: stored[0] || null, last: stored[stored.length - 1] || null },
    supplierType: state.supplierType || null,
  };
}

module.exports = { backfill, buildSeries, check, dailyCron, diffOrders, dynamics, newSince, orders, poll, salesReport, yesterdayAlmaty, DAY_MS, INITIAL_SEEN };
