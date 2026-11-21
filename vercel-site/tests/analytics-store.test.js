'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
  client_email: 'test@example.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
});

// In-memory fake of the Google Sheets values API.
const sheets = new Map();
function grid(name) {
  if (!sheets.has(name)) sheets.set(name, []);
  return sheets.get(name);
}
function parseA1(a1) {
  const m = decodeURIComponent(a1).match(/^'(.+)'!([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/);
  const col = (s) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  return { sheet: m[1].replace(/''/g, "'"), c0: col(m[2]), r0: m[3] ? Number(m[3]) - 1 : 0, c1: m[4] ? col(m[4]) : 25, r1: m[5] ? Number(m[5]) - 1 : 100000 };
}
function read(a1) {
  const r = parseA1(a1);
  const rows = grid(r.sheet).slice(r.r0, r.r1 + 1).map((row) => (row || []).slice(r.c0, r.c1 + 1));
  while (rows.length && !rows[rows.length - 1].some((v) => v !== '' && v != null)) rows.pop();
  return rows;
}
const json = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify(data), json: async () => data });
let sheetCalls = 0;
global.fetch = async (url, options = {}) => {
  const u = new URL(String(url));
  if (u.hostname === 'oauth2.googleapis.com') return json({ access_token: 'tok', expires_in: 3600 });
  if (u.hostname !== 'sheets.googleapis.com') throw new Error(`unexpected ${url}`);
  sheetCalls += 1;
  const path = decodeURIComponent(u.pathname.replace(/^\/v4\/spreadsheets\/[^/:]+/, ''));
  const body = options.body ? JSON.parse(options.body) : {};
  if (path === '' && u.searchParams.get('fields')) return json({ sheets: [...sheets.keys()].map((title) => ({ properties: { title } })) });
  if (path === ':batchUpdate') {
    grid(body.requests[0].addSheet.properties.title);
    return json({});
  }
  if (path === '/values:batchGet') {
    return json({ valueRanges: u.searchParams.getAll('ranges').map((range) => ({ values: read(range) })) });
  }
  let m;
  if ((m = path.match(/^\/values\/(.+):clear$/))) {
    const r = parseA1(m[1]);
    const g = grid(r.sheet);
    for (let i = r.r0; i <= Math.min(r.r1, g.length - 1); i += 1) g[i] = [];
    return json({});
  }
  if ((m = path.match(/^\/values\/(.+)$/))) {
    if ((options.method || 'GET') === 'GET') return json({ values: read(m[1]) });
    const r = parseA1(m[1]);
    const g = grid(r.sheet);
    body.values.forEach((row, i) => {
      g[r.r0 + i] = g[r.r0 + i] || [];
      row.forEach((v, j) => { g[r.r0 + i][r.c0 + j] = v; });
    });
    return json({});
  }
  throw new Error(`unhandled ${path}`);
};

const store = require('../lib/analytics/store');
const { RAW_SCHEMA } = require('../lib/analytics/kaspi-raw');

test('settings, expenses and month cache persist in Google Sheets tabs', async () => {
  const saved = await store.saveSettings({ commissionPct: 11.5, taxBase: 'profit' });
  assert.equal(saved.commissionPct, 11.5);
  assert.ok(sheets.has('GB_Аналитика_Настройки'));
  const reread = await store.getSettings(true);
  assert.equal(reread.taxBase, 'profit');

  const expense = await store.upsertExpense({ month: '2026-11', category: 'Аренда', amount: '200 000,50' });
  assert.equal(expense.amount, 200000.5);
  await store.upsertExpense({ id: expense.id, amount: 1000 });
  let list = await store.getExpenses(true);
  assert.equal(list.length, 1);
  assert.equal(list[0].amount, 1000);
  list = await store.deleteExpense(expense.id);
  assert.equal(list.length, 0);
  assert.throws(() => store.__test.normalizeExpense({ month: '2026-13', amount: 1 }), /ГГГГ-ММ/);

  // Large month -> several chunks; read back through a cold memory cache.
  const orders = Array.from({ length: 3000 }, (_, i) => ({
    id: `o${i}`, kind: 'sale', at: 1, total: i, items: [{ sku: crypto.randomBytes(12).toString('hex'), qty: 1, price: i }],
  }));
  await store.writeMonth('2026-10', { schema: RAW_SCHEMA, month: '2026-10', orders, coveredUntil: 5 }, { closed: true });
  await store.writeMonth('2026-09', { schema: RAW_SCHEMA, month: '2026-09', orders: orders.slice(0, 5), coveredUntil: 4 }, { closed: true });
  const row = grid('GB_Аналитика_Кэш')[1];
  assert.equal(row[0], '2026-10');
  assert.ok(row[3] > 1, `expected several chunks, got ${row[3]}`);

  globalThis.__GB_ANALYTICS_STORE.months.clear();
  globalThis.__GB_ANALYTICS_STORE.cacheIndex = null;
  const before = sheetCalls;
  const months = await store.readMonths(['2026-10', '2026-09', '2026-08']);
  assert.equal(months.get('2026-10').data.orders.length, 3000);
  assert.equal(months.get('2026-09').data.orders.length, 5);
  assert.equal(months.has('2026-08'), false);
  assert.ok(sheetCalls - before <= 2, 'index + one batchGet');

  // Rewriting a month keeps its row.
  await store.writeMonth('2026-10', { schema: RAW_SCHEMA, month: '2026-10', orders: orders.slice(0, 2), coveredUntil: 6 }, { closed: true });
  assert.equal(grid('GB_Аналитика_Кэш')[1][3], 1);
  assert.equal(grid('GB_Аналитика_Кэш')[1][5], '', 'old chunks are cleared');
  assert.equal(grid('GB_Аналитика_Кэш')[2][0], '2026-09');
});

test('a partial month in memory is replaced by a newer complete copy from the sheet', async () => {
  const S = globalThis.__GB_ANALYTICS_STORE;
  await store.writeMonth('2026-07', { schema: RAW_SCHEMA, month: '2026-07', orders: [{ id: 'a', kind: 'sale', at: 1, total: 1, items: [] }], coveredUntil: 1 }, { closed: true });
  // Simulate this instance still holding an older partial copy.
  S.months.set('2026-07', { savedAt: 1, data: { schema: RAW_SCHEMA, month: '2026-07', partial: true, orders: [] } });
  S.cacheIndex = null;
  const months = await store.readMonths(['2026-07']);
  assert.equal(months.get('2026-07').data.partial, undefined);
  assert.equal(months.get('2026-07').data.orders.length, 1);
});
