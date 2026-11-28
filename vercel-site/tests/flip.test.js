'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const client = require('../lib/flip/client');
const service = require('../lib/flip/service');
const sales = require('../lib/flip/sales');
const telegram = require('../lib/flip/telegram');
const handler = require('../lib/flip/handler');

function fakeResponse(status, body, type = 'application/json') {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, headers: { get: () => type }, text: async () => text };
}

function withKey(fn) {
  return async () => {
    const before = process.env.FLIP_API_KEY;
    process.env.FLIP_API_KEY = 'test-key';
    try { await fn(); } finally { if (before === undefined) delete process.env.FLIP_API_KEY; else process.env.FLIP_API_KEY = before; }
  };
}

test('request sends the raw key (no Bearer) and reads body errors on HTTP 200', withKey(async () => {
  let seen = null;
  const fetchImpl = async (url, init) => { seen = { url: String(url), auth: init.headers.Authorization }; return fakeResponse(200, { error: { code: 422, message: 'dateFrom is required' } }); };
  await assert.rejects(client.request('/statistics/sales', { dateTo: '2026-11-27' }, { fetchImpl, retries: 0 }), /dateFrom is required/);
  assert.equal(seen.auth, 'test-key');
  assert.match(seen.url, /\/api\/v1\/statistics\/sales\?dateTo=2026-11-27$/);
}));

test('request reports errors[] arrays and field objects', withKey(async () => {
  const fetchImpl = async () => fakeResponse(200, { errors: [{ message: 'bad limit' }, 'bad page'] });
  await assert.rejects(client.request('/orders', {}, { fetchImpl, retries: 0 }), /bad limit; bad page/);
  const fetchImpl2 = async () => fakeResponse(200, { errors: { dateFrom: 'invalid' } });
  await assert.rejects(client.request('/orders', {}, { fetchImpl: fetchImpl2, retries: 0 }), /dateFrom: invalid/);
}));

test('request turns HTML 403/404 into readable errors by status', withKey(async () => {
  const html = '<html><head><title>403 Forbidden</title></head></html>';
  await assert.rejects(client.request('/orders', {}, { fetchImpl: async () => fakeResponse(403, html, 'text/html'), retries: 0 }), (e) => e.status === 403 && /доступ запрещён/.test(e.message));
  await assert.rejects(client.request('/x', {}, { fetchImpl: async () => fakeResponse(404, html, 'text/html'), retries: 0 }), (e) => e.status === 404 && /не найден/.test(e.message));
}));

test('request without FLIP_API_KEY fails before any network call', async () => {
  const before = process.env.FLIP_API_KEY;
  delete process.env.FLIP_API_KEY;
  let called = false;
  await assert.rejects(client.request('/orders', {}, { fetchImpl: async () => { called = true; } }), (e) => e.code === 'not_configured');
  assert.equal(called, false);
  if (before !== undefined) process.env.FLIP_API_KEY = before;
});

test('fetchPendingOrders walks all pages and merges a group split across pages', withKey(async () => {
  const pages = {
    1: { data: [{ groupId: 'G1', groupName: 'Заказ 1', groupStoreName: 'Алматы', items: [{ preorderId: 'p1', article: 'A-1', price: 1000, partnerCodes: ['GB-1'] }] }], meta: { pagination: { page: 1, pages: 2 } } },
    2: { data: [{ groupId: 'G1', items: [{ preorderId: 'p2', article: 'A-2', price: 500 }, { preorderId: 'p1', article: 'A-1', price: 1000 }] }, { groupId: 'G2', groupStoreName: 'Астана', items: [{ preorderId: 'p3', article: 'B-1' }] }], meta: { pagination: { page: 2, pages: 2 } } },
  };
  const requested = [];
  const fetchImpl = async (url) => { const page = Number(new URL(url).searchParams.get('page')); requested.push(page); return fakeResponse(200, pages[page]); };
  const result = await client.fetchPendingOrders({ fetchImpl });
  assert.deepEqual(requested, [1, 2]);
  assert.equal(result.groups.length, 2);
  const g1 = result.groups.find((g) => g.groupId === 'G1');
  assert.equal(g1.units, 2); // p1 repeated on page 2 is not counted twice
  assert.equal(g1.groupStoreName, 'Алматы');
  assert.equal(g1.total, 1500);
  const g2 = result.groups.find((g) => g.groupId === 'G2');
  assert.equal(g2.items[0].price, 0); // omitted price = no value
  assert.deepEqual(g2.items[0].partnerCodes, []);
  assert.equal(result.units, 3);
}));

test('flat unit rows carrying group fields are grouped too', () => {
  const groups = client.finishGroups(client.mergeOrderRows([
    { preorderId: 'a', groupId: 'G', groupStoreName: 'Склад', article: 'X', price: 10 },
    { preorderId: 'b', groupId: 'G', article: 'Y', price: 20 },
  ]));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].units, 2);
  assert.equal(groups[0].total, 30);
});

test('diffOrders: first run remembers everything without notifying', () => {
  const snapshot = { groups: [{ groupStoreName: 'Алматы', items: [{ preorderId: 'p1', price: 1 }, { preorderId: 'p2', price: 2 }] }] };
  const first = service.diffOrders(null, snapshot, 1000);
  assert.equal(first.firstRun, true);
  assert.equal(first.fresh.length, 0);
  assert.deepEqual(Object.keys(first.next.ids).sort(), ['p1', 'p2']);

  const later = { groups: [{ groupStoreName: 'Алматы', items: [{ preorderId: 'p1' }, { preorderId: 'p2' }, { preorderId: 'p3', article: 'N', price: 7 }] }] };
  const second = service.diffOrders(first.next, later, 2000);
  assert.equal(second.firstRun, false);
  assert.deepEqual(second.fresh.map((u) => u.preorderId), ['p3']);
  assert.equal(second.fresh[0].store, 'Алматы');
  assert.equal(second.next.ids.p1, 1000); // first-seen time is kept
});

test('diffOrders forgets ids that left the queue long ago', () => {
  const day = 86_400_000;
  const state = { initializedAt: 1, ids: { old: 1, recent: 100 * day } };
  const next = service.diffOrders(state, { groups: [] }, 100 * day).next;
  assert.equal(next.ids.old, undefined);
  assert.equal(next.ids.recent, 100 * day);
});

test('Telegram message: count, list, warehouse, total, HTML-escaped and length-limited', () => {
  const units = [
    { article: 'A<1>', partnerCodes: ['GB-1', 'GB-2'], price: 12500, store: 'Алматы' },
    { article: 'B-2', partnerCodes: [], price: 3000, store: '' },
  ];
  const text = telegram.formatMessage(units);
  assert.match(text, /🛒 <b>Flip: 2 новых заказа<\/b>/);
  assert.match(text, /A&lt;1&gt;/);
  assert.match(text, /коды: GB-1, GB-2/);
  assert.match(text, /склад не указан/);
  assert.match(text, /Итого: 15\s500 ₸/);
  const many = Array.from({ length: 400 }, (_, i) => ({ article: `ART-${i}`, partnerCodes: ['CODE'], price: 1000, store: 'Склад' }));
  const long = telegram.formatMessage(many);
  assert.ok(long.length <= 4096, `length ${long.length}`);
  assert.match(long, /400 новых заказов/);
  assert.match(long, /…и ещё \d+/);
  assert.match(long, /Итого: 400\s000 ₸/);
});

test('sales summary parsing is tolerant to where summary lives', () => {
  const a = sales.normalizeSummary({ data: { supplierType: 'fee', summary: { salesAmount: '15000', quantity: 3, act: { number: 'A-1' } } } });
  assert.equal(a.supplierType, 'fee');
  assert.deepEqual(sales.dailyTotals(a), { revenue: 15000, units: 3 });
  assert.ok(a.fields.find((f) => f.key === 'act.number' && f.kind === 'text'));
  const b = sales.normalizeSummary({ supplierType: 'purchase', summary: {} }); // empty values omitted
  assert.deepEqual(sales.dailyTotals(b), { revenue: 0, units: 0 });
  const items = sales.normalizeItems({ data: { items: [{ id: 1, amount: 5, product: { article: 'X' } }] }, meta: { pagination: { page: 1, pages: 3, total: 250 } } });
  assert.deepEqual(items.columns, ['id', 'amount', 'product.article']);
  assert.equal(items.pagination.pages, 3);
});

test('buildSeries groups stored days by week/month and counts missing days', () => {
  const days = { '2026-11-02': { revenue: 100, units: 1 }, '2026-11-03': { revenue: 50, units: 2 }, '2026-11-10': { revenue: 10, units: 1 } };
  const byDay = service.buildSeries(days, '2026-11-02', '2026-11-04', 'day');
  assert.deepEqual(byDay.map((b) => b.revenue), [100, 50, 0]);
  assert.equal(byDay[2].missing, 1);
  const byWeek = service.buildSeries(days, '2026-11-02', '2026-11-15', 'week');
  assert.deepEqual(byWeek.map((b) => [b.key, b.revenue, b.units]), [['2026-11-02', 150, 3], ['2026-11-09', 10, 1]]);
  const byMonth = service.buildSeries(days, '2026-10-30', '2026-11-15', 'month');
  assert.deepEqual(byMonth.map((b) => [b.key, b.revenue]), [['2026-10', 0], ['2026-11', 160]]);
});

test('yesterday is computed in Asia/Almaty (UTC+5)', () => {
  assert.equal(service.yesterdayAlmaty(Date.UTC(2026, 10, 27, 20, 0)), '2026-11-27'); // 01:00 on 28.11 in Almaty
  assert.equal(service.yesterdayAlmaty(Date.UTC(2026, 10, 27, 18, 0)), '2026-11-26');
});

test('cron endpoints require CRON_SECRET', () => {
  const { cronAuthorized } = handler.__test;
  const before = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  assert.equal(cronAuthorized({ headers: { 'user-agent': 'vercel-cron/1.0' } }), false);
  process.env.CRON_SECRET = 's3cret';
  assert.equal(cronAuthorized({ headers: { authorization: 'Bearer s3cret' } }), true);
  assert.equal(cronAuthorized({ headers: { authorization: 'Bearer wrong' } }), false);
  if (before === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = before;
});

test('handler: poll without secret is 401; unknown op is 404', async () => {
  const call = async (query) => {
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(body) { this.body = JSON.parse(body); } };
    await handler.handler({ query, headers: {}, method: 'GET' }, res);
    return res;
  };
  assert.equal((await call({ module: 'flip', op: 'poll' })).statusCode, 401);
  assert.equal((await call({ module: 'flip', op: 'nope' })).statusCode, 404);
  const health = await call({ module: 'flip', op: 'health' });
  assert.equal(health.statusCode, 200);
  assert.equal(JSON.stringify(health.body).includes('test-key'), false);
});
