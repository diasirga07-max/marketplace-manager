'use strict';

// «Показатели качества» API. Served by api/data.js with module=quality
// (Vercel Hobby: max 12 functions); vercel.json rewrites /api/quality here.
//   GET  op=health                              public
//   GET  op=dashboard&days=30|90&brand&category&asOf=YYYY-MM-DD
//   GET  op=orders&metric=cancels|delays|returns&dim=brand|sku|category&key=…&days
//   POST op=refresh                             one resumable load step
//   GET  op=cron                                Vercel Cron (CRON_SECRET)
//   GET/POST op=settings
//   POST op=snapshot {date, rating, delays, returns, cancels, chats}  · op=snapshot-delete {id}
//   POST op=import {kind: returns|reviews, rows, mode: merge|replace} · op=import-clear {kind}

const crypto = require('node:crypto');
const { internal } = require('../grants-data-service');
const compute = require('./compute');
const loader = require('./loader');
const store = require('./store');

const VERSION = 'quality-1.0.0';
const STALE_MS = 60 * 60_000;
const DAY_MS = 86_400_000;

// Cabinet figures on 21.11.2026 given in the task (real numbers from the
// seller cabinet). Used as the reference snapshot until one is saved in the UI.
const REFERENCE_SNAPSHOT = Object.freeze({
  id: 'reference-2026-11-21',
  date: '2026-11-21',
  source: 'Цифры кабинета из постановки задачи (21.11)',
  reference: true,
  rating: { value: 4.9, count: 1342, from: '2026-08-24', to: '2026-11-21' },
  delays: { bad: 33, total: 1434 },
  returns: { bad: 9, total: 1356 },
  cancels: { bad: 40, total: 2111 },
  chats: { answered: 12, total: 244, avgMinutes: 16 },
});

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.end(JSON.stringify(data));
}

function body(req) {
  let value = req.body || {};
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { value = {}; }
  }
  return value && typeof value === 'object' ? value : {};
}

function isoDate(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '';
}

function numOrNull(v) {
  if (v === '' || v == null) return null;
  const x = Number(String(v).replace(',', '.').replace(/\s/g, ''));
  return Number.isFinite(x) ? x : null;
}

// ---------- persisted user data ----------

async function loadUserData() {
  const [settings, snapshots, returns, reviews, history] = await Promise.all([
    store.getValue('settings', {}),
    store.getValue('snapshots', []),
    store.getValue('returns', []),
    store.getValue('reviews', []),
    store.getValue('history', []),
  ]);
  return { settings, snapshots, returns, reviews, history };
}

function latestSnapshot(snapshots) {
  const list = (Array.isArray(snapshots) ? snapshots : []).filter((s) => s && s.date);
  list.sort((a, b) => String(b.date).localeCompare(String(a.date)) || (b.savedAt || 0) - (a.savedAt || 0));
  return list[0] || REFERENCE_SNAPSHOT;
}

function returnsMap(rows) {
  const map = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const code = String(r.code || '').replace(/\D/g, '');
    if (code) map.set(code, { reason: String(r.reason || ''), quality: typeof r.quality === 'boolean' ? r.quality : undefined });
  }
  return map;
}

function normalizeSnapshot(input) {
  const date = isoDate(input.date);
  if (!date) throw new Error('Укажите дату снимка в формате ГГГГ-ММ-ДД');
  const pair = (x) => {
    const bad = numOrNull(x && x.bad);
    const total = numOrNull(x && x.total);
    if (bad == null && total == null) return null;
    if (bad == null || total == null || bad < 0 || total <= 0 || bad > total) throw new Error('Проверьте «X из Y» в снимке: X ≤ Y, Y > 0');
    return { bad: Math.round(bad), total: Math.round(total) };
  };
  const ratingValue = numOrNull(input.rating && input.rating.value);
  const ratingCount = numOrNull(input.rating && input.rating.count);
  if (ratingValue != null && (ratingValue < 1 || ratingValue > 5)) throw new Error('Рейтинг должен быть от 1 до 5');
  const chatsAnswered = numOrNull(input.chats && input.chats.answered);
  const chatsTotal = numOrNull(input.chats && input.chats.total);
  return {
    id: crypto.randomUUID(),
    date,
    source: 'Снимок кабинета (ручной ввод)',
    savedAt: Date.now(),
    note: String(input.note || '').slice(0, 300),
    rating: ratingValue != null ? { value: ratingValue, count: Math.round(ratingCount || 0), from: isoDate(input.rating.from), to: isoDate(input.rating.to) || date } : null,
    delays: pair(input.delays),
    returns: pair(input.returns),
    cancels: pair(input.cancels),
    chats: chatsTotal ? { answered: Math.round(chatsAnswered || 0), total: Math.round(chatsTotal), avgMinutes: numOrNull(input.chats.avgMinutes) } : null,
  };
}

function normalizeImportRows(kind, rows) {
  if (!Array.isArray(rows)) throw new Error('Нет строк для импорта');
  if (rows.length > 20_000) throw new Error('Слишком много строк (максимум 20 000)');
  if (kind === 'returns') {
    return rows.map((r) => ({
      code: String(r.code || '').replace(/\D/g, ''),
      reason: String(r.reason || '').trim().slice(0, 200),
      date: String(r.date || '').slice(0, 30),
      sku: String(r.sku || '').trim().slice(0, 80),
      quality: typeof r.quality === 'boolean' ? r.quality : undefined,
    })).filter((r) => r.code);
  }
  if (kind === 'reviews') {
    return rows.map((r) => ({
      at: Number(r.at) || Date.parse(String(r.date || '')) || 0,
      rating: Number(String(r.rating || '').replace(',', '.')),
      sku: String(r.sku || '').trim().slice(0, 80),
    })).filter((r) => r.at > 0 && r.rating >= 1 && r.rating <= 5);
  }
  throw new Error('Неизвестный тип импорта');
}

// ---------- history (daily metric snapshots) ----------

function historyRow(dashboard) {
  const m = dashboard.metrics;
  const pick = (x) => ({ bad: x.bad, total: x.total, value: x.value });
  return { day: dashboard.window.toDay, at: Date.now(), cancels: pick(m.cancels), delays: pick(m.delays), returns: pick(m.returns) };
}

async function upsertHistory(dashboard) {
  const list = await store.getValue('history', []);
  const row = historyRow(dashboard);
  const next = (Array.isArray(list) ? list : []).filter((r) => r.day !== row.day);
  next.push(row);
  next.sort((a, b) => a.day.localeCompare(b.day));
  await store.set('history', next.slice(-400));
}

// ---------- refresh ----------

async function runRefresh(token, { deadlineMs = 230_000, forceList = false } = {}) {
  if (await store.hasLock('refresh')) return { ok: true, busy: true, message: 'Обновление уже выполняется' };
  await store.setLock('refresh', deadlineMs + 30_000);
  try {
    const progress = await loader.refresh({ token, deadline: Date.now() + deadlineMs, forceList });
    if (progress.complete) {
      try {
        const [dataset, user, brands] = await Promise.all([loader.readDataset(), loadUserData(), loader.sheetBrands()]);
        if (dataset) {
          await upsertHistory(compute.computeDashboard({
            orders: dataset.orders, config: user.settings, sheetBrands: brands, returnsByCode: returnsMap(user.returns), now: Date.now(), days: 30,
          }));
        }
      } catch (error) {
        console.warn('Quality: history snapshot failed', error.message);
      }
    }
    return progress;
  } catch (error) {
    const message = String(error && error.message || error).replace(/X-Auth-Token\S*/gi, '***');
    console.error('Quality refresh failed', message);
    await store.set(loader.STATUS_KEY, { phase: 'error', at: new Date().toISOString(), error: message, status: Number(error && error.status) || null });
    throw error;
  } finally {
    await store.releaseLock('refresh');
  }
}

function cronAuthorized(req) {
  const secret = String(process.env.CRON_SECRET || '').trim();
  const headers = req.headers || {};
  if (secret) {
    const given = String(headers.authorization || '');
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(`Bearer ${secret}`).digest();
    return crypto.timingSafeEqual(a, b);
  }
  return /vercel-cron/i.test(String(headers['user-agent'] || ''));
}

// ---------- dashboard ----------

async function dashboard(req, token) {
  const q = req.query || {};
  const days = [7, 14, 30, 90].includes(Number(q.days)) ? Number(q.days) : 30;
  const [dataset, user, brands] = await Promise.all([loader.readDataset(), loadUserData(), loader.sheetBrands()]);
  const snapshot = latestSnapshot(user.snapshots);
  const now = Date.now();
  const manual = compute.manualMetrics({ snapshot, reviews: user.reviews, now, config: user.settings });
  const base = {
    ok: true,
    version: VERSION,
    generatedAt: new Date(now).toISOString(),
    snapshot,
    snapshots: (user.snapshots || []).slice().sort((a, b) => String(b.date).localeCompare(String(a.date))),
    manual,
    history: user.history || [],
    imports: { returns: (user.returns || []).length, reviews: (user.reviews || []).length },
    storage: store.status(),
    lastRun: loader.lastRun(),
  };
  if (!dataset || !dataset.orders.length) {
    if (token && !(await store.hasLock('refresh'))) store.waitUntil(runRefresh(token, { deadlineMs: 200_000 }));
    return { ...base, empty: true, config: compute.mergeConfig(user.settings), hint: 'Данные из Kaspi ещё не загружены. Нажмите «Обновить из Kaspi» — первая загрузка 100 дней занимает несколько шагов по ~4 минуты.' };
  }
  const asOf = isoDate(q.asOf) ? Date.parse(`${q.asOf}T23:59:59.999+05:00`) : undefined;
  const filters = { brand: String(q.brand || '').trim(), category: String(q.category || '').trim() };
  const returnsByCode = returnsMap(user.returns);
  const result = compute.computeDashboard({ orders: dataset.orders, config: user.settings, sheetBrands: brands, returnsByCode, now, days, asOf, filters, limitRows: q.full === '1' ? 0 : 50 });
  const calib = compute.calibration({ orders: dataset.orders, config: user.settings, sheetBrands: brands, returnsByCode, now, snapshot });
  const age = now - (dataset.updatedAt || 0);
  let refreshing = false;
  if (token && (age > STALE_MS || !dataset.complete) && !(await store.hasLock('refresh'))) {
    refreshing = true;
    store.waitUntil(runRefresh(token, { deadlineMs: 200_000 }));
  }
  return {
    ...base,
    ...result,
    calibration: calib,
    dataset: {
      orders: dataset.orders.length,
      complete: dataset.complete,
      itemsRemaining: dataset.orders.filter((o) => !Array.isArray(o.items)).length,
      updatedAt: dataset.updatedAt,
      listedAt: dataset.listedAt,
      rangeFrom: dataset.rangeFrom,
      rangeTo: dataset.rangeTo,
      listErrors: dataset.listErrors || [],
      ageMs: age,
      refreshing,
      covers90: dataset.rangeFrom <= now - 97 * DAY_MS,
    },
  };
}

async function handler(req, res) {
  const op = String((req.query && req.query.op) || 'health');
  const token = internal.tokenFromRequest(req);
  try {
    if (op === 'health') {
      return send(res, 200, {
        ok: true, version: VERSION, storage: store.status(), lastRun: loader.lastRun(), tokenConfigured: Boolean(process.env.KASPI_API_TOKEN),
        refresh: await store.getValue(loader.STATUS_KEY, null), refreshLocked: await store.hasLock('refresh'),
      });
    }
    if (op === 'cron') {
      if (!cronAuthorized(req)) return send(res, 401, { ok: false, error: 'Unauthorized' });
      if (!token) return send(res, 503, { ok: false, error: 'KASPI_API_TOKEN не настроен' });
      return send(res, 200, await runRefresh(token, { deadlineMs: 250_000, forceList: true }));
    }
    if (op === 'dashboard') return send(res, 200, await dashboard(req, token));
    if (op === 'list-check') {
      // Diagnostics: one creationDate window listed two ways (counts only, no order data).
      const q = req.query || {};
      if (q.mode === 'loader') {
        const now = Date.now();
        const { lists, tasks, errors } = await loader.__test.listAll(token, now - loader.RANGE_DAYS * DAY_MS, now);
        const union = new Map();
        lists.forEach((l) => (l || []).forEach((o) => union.set(String(o.id), Number(o.attributes && o.attributes.creationDate) || 0)));
        const checkFrom = Date.parse('2026-11-15T00:00:00+05:00');
        const checkTo = Date.parse('2026-11-21T23:59:59.999+05:00');
        return send(res, 200, {
          ok: true, errors, unique: union.size,
          in_15_21_11: [...union.values()].filter((t) => t >= checkFrom && t <= checkTo).length,
          tasks: tasks.map((t, i) => ({ state: t.state || '', ge: new Date(t.ge).toISOString(), le: new Date(t.le).toISOString(), n: lists[i] ? lists[i].length : null })),
        });
      }
      const from = Date.parse(`${isoDate(q.from)}T00:00:00+05:00`);
      const to = Date.parse(`${isoDate(q.to)}T23:59:59.999+05:00`);
      if (!Number.isFinite(from) || !Number.isFinite(to) || to - from > 14 * DAY_MS) return send(res, 400, { ok: false, error: 'Укажите from/to (ГГГГ-ММ-ДД), не больше 14 дней' });
      const state = q.state ? String(q.state) : undefined;
      const shared = await internal.listOrders(token, { state, ge: from, le: to });
      const pages = [];
      const ids = new Set();
      let meta = null;
      for (let page = 0; page < 60; page += 1) {
        const params = new URLSearchParams({ 'page[number]': String(page), 'page[size]': String(Number(q.size) || 100), 'filter[orders][creationDate][$ge]': String(from), 'filter[orders][creationDate][$le]': String(to) });
        if (state) params.set('filter[orders][state]', state);
        const payload = await internal.kaspiGet(`/orders?${params.toString()}`, token);
        const data = Array.isArray(payload.data) ? payload.data : [];
        if (!meta) meta = payload.meta || null;
        data.forEach((o) => ids.add(String(o.id)));
        pages.push(data.length);
        if (data.length < (Number(q.size) || 100)) break;
      }
      // Which order date actually falls inside the requested window?
      const all = shared;
      const inWin = (t) => Number(t) >= from && Number(t) <= to;
      const dateKeys = {};
      const byStatus = {};
      for (const o of all) {
        const a = o.attributes || {};
        byStatus[a.status || '—'] = (byStatus[a.status || '—'] || 0) + 1;
        const flat = { ...a, ...(a.kaspiDelivery || {}) };
        for (const [k, v] of Object.entries(flat)) {
          if (typeof v === 'number' && v > 1.5e12 && v < 2e12) {
            dateKeys[k] = dateKeys[k] || { present: 0, inWindow: 0 };
            dateKeys[k].present += 1;
            if (inWin(v)) dateKeys[k].inWindow += 1;
          }
        }
      }
      return send(res, 200, { ok: true, byStatus, dateKeys, state: state || null, shared: { count: shared.length, unique: new Set(shared.map((o) => String(o.id))).size }, direct: { pages, count: pages.reduce((a, b) => a + b, 0), unique: ids.size, meta } });
    }
    if (op === 'orders') {
      const q = req.query || {};
      const [dataset, user, brands] = await Promise.all([loader.readDataset(), loadUserData(), loader.sheetBrands()]);
      if (!dataset) return send(res, 200, { ok: true, orders: [], empty: true });
      const days = [7, 14, 30, 90].includes(Number(q.days)) ? Number(q.days) : 30;
      const asOf = isoDate(q.asOf) ? Date.parse(`${q.asOf}T23:59:59.999+05:00`) : undefined;
      return send(res, 200, {
        ok: true,
        ...compute.computeOrders({
          orders: dataset.orders, config: user.settings, sheetBrands: brands, returnsByCode: returnsMap(user.returns), now: Date.now(), days, asOf,
          metric: String(q.metric || ''), dim: ['brand', 'sku', 'category'].includes(q.dim) ? q.dim : '', key: q.key == null ? null : String(q.key),
          filters: { brand: String(q.brand || '').trim(), category: String(q.category || '').trim() },
        }),
      });
    }
    if (op === 'refresh') {
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST' });
      if (!token) return send(res, 401, { ok: false, error: 'Kaspi API токен не настроен (KASPI_API_TOKEN в Vercel)' });
      return send(res, 200, await runRefresh(token, { deadlineMs: 230_000, forceList: body(req).forceList === true }));
    }
    if (op === 'settings') {
      if (req.method === 'POST') {
        const config = compute.mergeConfig(body(req));
        const saved = await store.set('settings', config);
        return send(res, 200, { ok: true, settings: config, persisted: saved.persisted, warning: saved.reason || '' });
      }
      return send(res, 200, { ok: true, settings: compute.mergeConfig(await store.getValue('settings', {})), defaults: compute.DEFAULT_CONFIG });
    }
    if (op === 'snapshot' && req.method === 'POST') {
      const snap = normalizeSnapshot(body(req));
      const list = (await store.getValue('snapshots', [])).filter((s) => s.date !== snap.date);
      list.push(snap);
      const saved = await store.set('snapshots', list.slice(-200));
      return send(res, 200, { ok: true, snapshot: snap, persisted: saved.persisted, warning: saved.reason || '' });
    }
    if (op === 'snapshot-delete' && req.method === 'POST') {
      const id = String(body(req).id || '');
      const list = (await store.getValue('snapshots', [])).filter((s) => s.id !== id);
      await store.set('snapshots', list);
      return send(res, 200, { ok: true, snapshots: list });
    }
    if (op === 'import' && req.method === 'POST') {
      const { kind, rows, mode } = body(req);
      const clean = normalizeImportRows(String(kind), rows);
      const key = kind === 'returns' ? 'returns' : 'reviews';
      const current = mode === 'replace' ? [] : await store.getValue(key, []);
      let merged;
      if (key === 'returns') {
        const map = new Map(current.map((r) => [r.code, r]));
        for (const r of clean) map.set(r.code, r);
        merged = [...map.values()];
      } else {
        const seen = new Set(current.map((r) => `${r.at}|${r.rating}|${r.sku}`));
        merged = [...current, ...clean.filter((r) => !seen.has(`${r.at}|${r.rating}|${r.sku}`))];
      }
      const saved = await store.set(key, merged);
      return send(res, 200, { ok: true, kind: key, imported: clean.length, total: merged.length, persisted: saved.persisted, warning: saved.reason || '' });
    }
    if (op === 'import-clear' && req.method === 'POST') {
      const key = body(req).kind === 'returns' ? 'returns' : 'reviews';
      await store.set(key, []);
      return send(res, 200, { ok: true, kind: key, total: 0 });
    }
    return send(res, 404, { ok: false, error: 'Неизвестная операция' });
  } catch (error) {
    const message = error && error.message ? error.message : 'Ошибка сервера';
    console.error('Quality API failed', { op, error: message.replace(/X-Auth-Token\S*/gi, '***') });
    const status = Number(error && error.status);
    if (status === 401 || status === 403) return send(res, 502, { ok: false, error: 'Kaspi API отклонил токен (401/403). Проверьте KASPI_API_TOKEN в Vercel.' });
    return send(res, /Укажите|Проверьте|должен|Нет строк|Слишком|Неизвестн/.test(message) ? 400 : 500, { ok: false, error: message });
  }
}

function isPublic(req) {
  const op = req.query && req.query.op;
  return !op || op === 'health' || op === 'cron'; // cron checks CRON_SECRET itself
}

module.exports = { handler, isPublic, REFERENCE_SNAPSHOT, __test: { normalizeSnapshot, normalizeImportRows, latestSnapshot, returnsMap, cronAuthorized } };
