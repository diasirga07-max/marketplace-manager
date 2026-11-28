'use strict';

// Flip business logic: new-order polling + Telegram, sales report, daily totals.

const client = require('./client');
const store = require('./store');
const telegram = require('./telegram');
const sales = require('./sales');
const { almatyDateIso } = require('../sales-core');
const periods = require('../analytics/periods');

const KEY_SEEN = 'orders-seen';      // { initializedAt, ids: { [preorderId]: firstSeenAt } }
const KEY_CURRENT = 'orders-current'; // last snapshot of pending orders (from the poll)
const KEY_DAILY = 'sales-daily';     // { days: { [YYYY-MM-DD]: { revenue, units, savedAt } }, supplierType }
const SEEN_TTL_MS = 60 * 86_400_000; // forget ids that left the queue 60+ days ago
const DAY_MS = 86_400_000;

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

// Pure core of the poll — decides what is new and what to remember.
function diffOrders(state, snapshot, now = Date.now()) {
  const units = flatUnits(snapshot.groups).filter((u) => u.preorderId);
  const firstRun = !state || !state.initializedAt;
  const ids = { ...((state && state.ids) || {}) };
  const fresh = units.filter((u) => !ids[u.preorderId]);
  for (const unit of fresh) ids[unit.preorderId] = now;
  const current = new Set(units.map((u) => u.preorderId));
  for (const [id, seenAt] of Object.entries(ids)) {
    if (!current.has(id) && now - Number(seenAt) > SEEN_TTL_MS) delete ids[id];
  }
  return { firstRun, fresh: firstRun ? [] : fresh, remembered: fresh.length, next: { initializedAt: (state && state.initializedAt) || now, ids } };
}

async function poll({ fetchImpl } = {}) {
  if (!store.durable()) throw new Error('Опрос Flip требует постоянного хранилища (GOOGLE_SERVICE_ACCOUNT_JSON): без него каждый запуск считался бы первым');
  if (await store.hasLock('poll')) return { ok: true, skipped: 'Опрос уже выполняется' };
  await store.setLock('poll', 120_000);
  try {
    const state = await store.getValue(KEY_SEEN, null, { fresh: true });
    const snapshot = await client.fetchPendingOrders({ fetchImpl });
    const diff = diffOrders(state, snapshot);
    let notified = false;
    let warning = '';
    if (diff.fresh.length) {
      if (telegram.configured()) {
        await telegram.send(telegram.formatMessage(diff.fresh), { fetchImpl }); // on failure nothing is remembered → retried next run
        notified = true;
      } else {
        warning = 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID не настроены — уведомление не отправлено';
      }
    }
    const saved = await store.set(KEY_SEEN, diff.next);
    if (!saved.persisted) throw new Error(`Не удалось сохранить виденные заказы: ${saved.reason}`);
    await store.set(KEY_CURRENT, attachSeen(snapshot, diff.next.ids));
    return {
      ok: true,
      firstRun: diff.firstRun,
      pending: snapshot.units,
      newOrders: diff.fresh.length,
      remembered: diff.remembered,
      notified,
      warning,
    };
  } finally {
    await store.releaseLock('poll');
  }
}

// Orders page: live=1 asks Flip right now; otherwise the poll's snapshot (≤5 min old).
async function orders({ live = false, fetchImpl } = {}) {
  const state = await store.getValue(KEY_SEEN, null);
  const ids = (state && state.ids) || {};
  if (!live) {
    const entry = await store.get(KEY_CURRENT);
    if (entry && entry.value && Date.now() - entry.savedAt < 30 * 60_000) return { ...entry.value, source: 'snapshot', initialized: Boolean(state) };
  }
  const snapshot = await client.fetchPendingOrders({ fetchImpl });
  return { ...attachSeen(snapshot, ids), source: 'live', initialized: Boolean(state) };
}

// Menu badge: orders first seen after `since` (ms, kept by the browser).
async function badge({ since = 0 } = {}) {
  const entry = await store.get(KEY_CURRENT);
  if (!entry || !entry.value) return { count: 0, pending: 0, fetchedAt: null };
  let count = 0;
  let pending = 0;
  for (const group of entry.value.groups || []) {
    for (const item of group.items || []) {
      pending += 1;
      if (item.firstSeenAt && item.firstSeenAt > since) count += 1;
    }
  }
  return { count, pending, fetchedAt: entry.value.fetchedAt || entry.savedAt };
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

module.exports = { backfill, badge, buildSeries, dailyCron, diffOrders, dynamics, orders, poll, salesReport, yesterdayAlmaty, DAY_MS };
