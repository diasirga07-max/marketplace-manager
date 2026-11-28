'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const client = require('../lib/flip/client');
const service = require('../lib/flip/service');
const sales = require('../lib/flip/sales');
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
  assert.equal(first.next.ids.p1, service.INITIAL_SEEN); // existed before tracking → never "new"

  const later = { groups: [{ groupStoreName: 'Алматы', items: [{ preorderId: 'p1' }, { preorderId: 'p2' }, { preorderId: 'p3', article: 'N', price: 7 }] }] };
  const second = service.diffOrders(first.next, later, 2000);
  assert.equal(second.firstRun, false);
  assert.deepEqual(second.fresh.map((u) => u.preorderId), ['p3']);
  assert.equal(second.fresh[0].store, 'Алматы');
  assert.equal(second.next.ids.p3, 2000);
  assert.equal(second.next.ids.p1, service.INITIAL_SEEN); // first-seen marker is kept
});

test('diffOrders forgets ids that left the queue long ago', () => {
  const day = 86_400_000;
  const state = { initializedAt: 1, ids: { old: 1, recent: 100 * day } };
  const next = service.diffOrders(state, { groups: [] }, 100 * day).next;
  assert.equal(next.ids.old, undefined);
  assert.equal(next.ids.recent, 100 * day);
});

// Synthetic body in the exact shape of the real /statistics/sales response (values made up).
function salesBody(overrides = {}) {
  return {
    errors: [], supplierType: 'fee', period: { from: '2026-11-22', to: '2026-11-28' },
    summary: {
      realization: { count: 10, price: 70000, sellingPrice: 100000, commission: 15000, total: 85000 },
      refunds: { count: 1, price: 7000, sellingPrice: 10000, commission: 1500, total: 8500 },
      net: { price: 63000, sellingPrice: 90000, commission: 13500, total: 76500 },
      deductions: {
        delivery: { rate: 500, count: 9, cost: 4500, caption: 'Доставка до покупателя', ratePerKg: true, bets: [{ rate: 500, kg: 1, count: 9, cost: 4500 }] },
        canceled: { rate: 200, count: 1, cost: 200 },
        refundProcessing: { rate: 300, count: 1, cost: 300 },
        returnsToSupplier: { bets: [] }, // empty values are omitted by the API
        storage: { rate: 10, count: 50, cost: 500 },
        total: 5500,
      },
      payout: 71000,
    },
    items: {
      rows: [
        { type: 'sale', date: '2026-11-27', name: 'Книга', supplierCodes: '1001', barcode: 'A123456', order: '555', cnt: 1, sellingPrice: 10000, commissionPercent: 15, commission: 1500, total: 8500, reason: null },
        { type: 'refund', date: '2026-11-28', name: 'Книга', supplierCodes: '1001', order: '556', cnt: 1, sellingPrice: 10000, commission: 1500, total: 8500, reason: 'Брак' },
      ],
      counts: { sale: 10, refund: 1 },
      pagination: { total: 11, limit: 100, pages: 1, currentPage: 1 },
    },
    ...overrides,
  };
}

test('sales summary is read from the real structure; daily totals = net selling price and net units', () => {
  const r = sales.normalizeSummary(salesBody());
  assert.equal(r.supplierType, 'fee');
  assert.equal(r.hasSummary, true);
  assert.equal(r.summary.net.sellingPrice, 90000);
  assert.equal(r.summary.net.count, 9); // 10 sold − 1 refunded
  assert.equal(r.summary.payout, 71000);
  assert.equal(r.summary.deductions.total, 5500);
  const delivery = r.summary.deductions.list.find((x) => x.key === 'delivery');
  assert.deepEqual([delivery.cost, delivery.count, delivery.ratePerKg, delivery.caption], [4500, 9, true, 'Доставка до покупателя']);
  assert.equal(r.summary.deductions.list.find((x) => x.key === 'returnsToSupplier').cost, 0);
  assert.deepEqual(sales.dailyTotals(r), { revenue: 90000, units: 9, commission: 13500, payout: 71000, refunds: 1 });
  assert.ok(r.fields.find((f) => f.key === 'realization.sellingPrice' && f.label === 'Реализация — по цене продажи'));
  assert.ok(r.fields.find((f) => f.key === 'deductions.delivery.caption' && f.kind === 'text'));
  assert.equal(r.fields.some((f) => f.key.includes('bets')), false);
});

test('empty day: omitted values read as zero, net is derived when absent', () => {
  const r = sales.normalizeSummary({ errors: [], supplierType: 'fee', summary: { realization: { count: 2, sellingPrice: 500 } } });
  assert.deepEqual(sales.dailyTotals(r), { revenue: 500, units: 2, commission: 0, payout: 0, refunds: 0 });
  const none = sales.normalizeSummary({ errors: [], supplierType: 'fee' });
  assert.equal(none.hasSummary, false);
  assert.deepEqual(sales.dailyTotals(none), { revenue: 0, units: 0, commission: 0, payout: 0, refunds: 0 });
});

test('sales items: rows, Russian type labels, counts and pagination', () => {
  const it = sales.normalizeItems(salesBody());
  assert.equal(it.rows.length, 2);
  assert.deepEqual(it.rows.map((r) => r.typeLabel), ['Продажа', 'Возврат']);
  assert.equal(it.rows[1].barcode, '');
  assert.equal(it.rows[1].reason, 'Брак');
  assert.deepEqual(it.counts, { sale: 10, refund: 1, cancel: 0 });
  assert.equal(it.pagination.total, 11);
});

test('salesReport makes one request without include and returns summary + items', withKey(async () => {
  const urls = [];
  const fetchImpl = async (url) => { urls.push(new URL(url)); return fakeResponse(200, salesBody()); };
  const report = await service.salesReport({ from: '2026-11-22', to: '2026-11-28', fetchImpl });
  assert.equal(urls.length, 1);
  assert.equal(urls[0].searchParams.get('include'), null);
  assert.equal(urls[0].searchParams.get('dateFrom'), '2026-11-22');
  assert.equal(report.summary.payout, 71000);
  assert.equal(report.items.rows.length, 2);
  const nonFee = await service.salesReport({ from: '2026-11-22', to: '2026-11-28', fetchImpl: async () => fakeResponse(200, { errors: [], supplierType: 'purchase', summary: salesBody().summary }) });
  assert.equal(nonFee.items, null);
}));

test('orders pagination is read from meta[0].pagination[0] (real shape)', withKey(async () => {
  const page = (n) => ({ errors: [], data: [{ groupId: `G${n}`, items: [{ preorderId: `p${n}` }] }], meta: [{ pagination: [{ total: 2, limit: 1, pages: 2, currentPage: String(n) }] }] });
  const requested = [];
  const result = await client.fetchPendingOrders({ fetchImpl: async (url) => { const n = Number(new URL(url).searchParams.get('page')); requested.push(n); return fakeResponse(200, page(n)); } });
  assert.deepEqual(requested, [1, 2]);
  assert.equal(result.units, 2);
  assert.deepEqual(client.pagination({ errors: [], data: [], meta: [{ pagination: [{ total: 0, limit: 100, pages: 0, currentPage: '1' }] }] }), { page: 1, pages: 1, total: 0 });
}));

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

test('api/data.js: every Flip op needs GB_ACCESS_CODE except the CRON_SECRET-protected cron ops', async () => {
  const dataApi = require('../api/data');
  const saved = { code: process.env.GB_ACCESS_CODE, cron: process.env.CRON_SECRET };
  process.env.GB_ACCESS_CODE = 'gb-code';
  process.env.CRON_SECRET = 'cron-secret';
  const call = async (query, headers = {}, method = 'GET') => {
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(body) { this.body = body ? JSON.parse(body) : null; } };
    await dataApi({ query: { module: 'flip', ...query }, headers, method, body: {} }, res);
    return res;
  };
  try {
    for (const query of [{}, { op: 'health' }, { op: 'orders' }, { op: 'orders', live: '1' }, { op: 'check' }, { op: 'badge' }, { op: 'sales', from: '2026-11-01', to: '2026-11-07' }, { op: 'dynamics' }, { op: 'probe' }, { op: 'unknown' }]) {
      const res = await call(query);
      assert.equal(res.statusCode, 401, JSON.stringify(query));
      assert.equal(res.body.code, 'access_required', JSON.stringify(query));
    }
    const backfill = await call({ op: 'backfill' }, {}, 'POST');
    assert.equal(backfill.body.code, 'access_required');
    // The code in a query string or the X-GB-Access header opens the API.
    assert.equal((await call({ op: 'health' }, { 'x-gb-access': 'gb-code' })).statusCode, 200);
    assert.equal((await call({ op: 'health', access: 'gb-code' })).statusCode, 200);
    // Cron ops skip the access code but still demand CRON_SECRET.
    for (const op of ['poll', 'daily']) {
      const denied = await call({ op });
      assert.equal(denied.statusCode, 401);
      assert.equal(denied.body.code, undefined);
      assert.equal((await call({ op }, { 'x-gb-access': 'gb-code' })).statusCode, 401, `${op}: access code must not replace CRON_SECRET`);
    }
  } finally {
    if (saved.code === undefined) delete process.env.GB_ACCESS_CODE; else process.env.GB_ACCESS_CODE = saved.code;
    if (saved.cron === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved.cron;
  }
});

test('probe shape hides values: numbers, names, phones become types', () => {
  const { shape } = require('../lib/flip/probe');
  const s = shape({ supplierType: 'fee', data: [{ name: 'Иван Петров', phone: '+77011234567', price: 12500, date: '2026-11-27' }, { extra: true }], meta: { pagination: { pages: 3 } } });
  const text = JSON.stringify(s);
  assert.match(text, /"supplierType":"string = \\"fee\\""/);
  for (const secret of ['Иван', '7011234567', '12500', '2026-11-27']) assert.equal(text.includes(secret), false, secret);
  assert.deepEqual(Object.keys(s.data), ['[2]']);
  assert.deepEqual(Object.keys(s.data['[2]']), ['name', 'phone', 'price', 'date', 'extra']);
  assert.equal(s.meta.pagination.pages, 'number');
});

test('newSince: only orders first seen after the last view, newest first; initial ones never count', () => {
  const snapshot = { groups: [
    { groupStoreName: 'Алматы', items: [
      { preorderId: 'old', article: 'O', price: 1, firstSeenAt: service.INITIAL_SEEN },
      { preorderId: 'a', article: 'A', price: 100, firstSeenAt: 5000 },
      { preorderId: 'b', article: 'B', price: 50, firstSeenAt: 9000 },
    ] },
    { groupStoreName: 'Астана', items: [{ preorderId: 'c', article: 'C', price: 7, firstSeenAt: 2000 }] },
  ] };
  const r = service.newSince(snapshot, 3000);
  assert.equal(r.count, 2);
  assert.equal(r.pending, 4);
  assert.deepEqual(r.items.map((u) => u.preorderId), ['b', 'a']);
  assert.equal(r.latestSeenAt, 9000);
  assert.equal(r.total, 150);
  assert.equal(r.items[0].store, 'Алматы');
  assert.equal(service.newSince(snapshot, 0).count, 3); // the INITIAL_SEEN order is still excluded
  assert.deepEqual(service.newSince(null, 0), { count: 0, pending: 0, latestSeenAt: 0, items: [], total: 0 });
});

test('no Telegram left in the Flip code', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '../lib/flip');
  for (const file of fs.readdirSync(dir)) assert.equal(/telegram/i.test(fs.readFileSync(path.join(dir, file), 'utf8')), false, file);
  assert.equal(/telegram/i.test(fs.readFileSync(path.join(__dirname, '../public/gb-flip.js'), 'utf8')), false);
});
