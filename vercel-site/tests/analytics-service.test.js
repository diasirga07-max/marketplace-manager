'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

const CSV = [
  'Название,Цена оптовая,ч',
  'Книга А,"1 000",KITA0001',
  'Книга Б,500,KITA0002',
  'Книга В,700,KITA0003',
  'Книга Г,800,KITA0004',
  'Книга Д,900,KITA0005',
].join('\n');

function at(iso, hour = 12) {
  return Date.parse(`${iso}T${String(hour).padStart(2, '0')}:00:00+05:00`);
}

const ORDERS = [
  { id: 'o1', status: 'COMPLETED', code: '111', totalPrice: 3000, creationDate: at('2026-11-01'), completionDate: at('2026-11-03', 10), deliveryCostForSeller: 299, deliveryMode: 'DELIVERY_LOCAL', paymentMode: 'PAY_WITH_CREDIT', customer: { id: 'c1', firstName: 'Асель', cellPhone: '77010001122' }, deliveryAddress: { town: 'Алматы' } },
  { id: 'o2', status: 'COMPLETED', code: '222', totalPrice: 1000, creationDate: at('2026-10-05'), completionDate: at('2026-10-07'), deliveryCostForSeller: 149, deliveryMode: 'DELIVERY_REGIONAL_TODOOR' },
  { id: 'o3', status: 'CANCELLED', code: '333', totalPrice: 500, creationDate: at('2026-11-04') },
];
const ENTRIES = {
  o1: [{ id: 'e1', attributes: { quantity: 2, totalPrice: 2000, category: { title: 'Книги' } } }, { id: 'e2', attributes: { quantity: 1, totalPrice: 1000, category: { title: 'Книги' } } }],
  o2: [{ id: 'e3', attributes: { quantity: 1, totalPrice: 1000, category: { title: 'Книги' } } }],
  o3: [{ id: 'e4', attributes: { quantity: 1, totalPrice: 500, category: { title: 'Книги' } } }],
};
const SKU_BY_ENTRY = { e1: 'KITA0001', e2: 'KITA0002', e3: 'KITA0001', e4: 'KITA0003' };

let kaspiCalls = 0;
global.fetch = async (url) => {
  const u = new URL(String(url));
  const json = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify(data), json: async () => data });
  if (u.hostname === 'docs.google.com') return { ok: true, status: 200, text: async () => CSV };
  kaspiCalls += 1;
  let m;
  if (u.pathname.endsWith('/orders')) {
    const status = u.searchParams.get('filter[orders][status]');
    const ge = Number(u.searchParams.get('filter[orders][creationDate][$ge]'));
    const le = Number(u.searchParams.get('filter[orders][creationDate][$le]'));
    const data = ORDERS
      .filter((o) => o.status === status && o.creationDate >= ge && o.creationDate <= le)
      .map(({ id, ...attributes }) => ({ id, attributes }));
    return json({ data });
  }
  if ((m = u.pathname.match(/\/orders\/([^/]+)\/entries$/))) return json({ data: ENTRIES[m[1]] || [] });
  if ((m = u.pathname.match(/\/orderentries\/([^/]+)\/product$/))) return json({ data: { id: `mp-${m[1]}`, attributes: {} } });
  if ((m = u.pathname.match(/\/masterproducts\/mp-([^/]+)\/merchantProduct$/))) {
    return json({ data: { attributes: { code: SKU_BY_ENTRY[m[1]], name: `Kaspi ${m[1]}` } } });
  }
  if ((m = u.pathname.match(/\/orders\/([^/]+)$/))) return json({ data: { attributes: {} } });
  return { ok: false, status: 404, text: async () => '{}' };
};

const service = require('../lib/analytics/service');

test('dashboard end-to-end with mocked Kaspi: month preset, comparison, cache', async () => {
  const realNow = Date.now;
  Date.now = () => at('2026-11-21', 15);
  try {
    const first = await service.dashboard({ token: 't', query: { preset: 'month' } });
    assert.equal(first.ok, true);
    assert.equal(first.period.from, '2026-11-01');
    assert.equal(first.summary.revenue, 3000);
    assert.equal(first.summary.orders, 1);
    assert.equal(first.summary.units, 3);
    assert.equal(first.summary.cogs, 2 * 1000 + 500);
    assert.equal(first.summary.delivery, 299);
    assert.equal(first.summary.coverage, 100);
    assert.equal(first.summary.cancelOrders, 1);
    assert.equal(first.catalog.skuDetectedBy, 'content', 'damaged «ч» header resolved by content');
    assert.equal(first.previous.revenue, 1000, 'October 1–21 is the previous period');
    assert.equal(Math.round(first.deltas.previous.revenue.pct), 200);
    assert.equal(first.series.length, 21);
    assert.equal(first.series[2].revenue, 3000);
    assert.equal(first.pnl.columns.length, 1);
    assert.deepEqual(first.options.categories.map((c) => c.name), ['Книги']);
    assert.equal(first.complete, true);

    const calls = kaspiCalls;
    const second = await service.dashboard({ token: 't', query: { preset: 'month', warehouse: 'Алматы', sku: 'KITA0002' } });
    assert.equal(kaspiCalls, calls, 'second request is served from cache without Kaspi calls');
    assert.equal(second.summary.revenue, 1000);
    assert.equal(second.summary.units, 1);
  } finally {
    Date.now = realNow;
  }
});

test('incomplete history: no year-ago percentages, explicit flag instead', async () => {
  const store = require('../lib/analytics/store');
  const realNow = Date.now;
  Date.now = () => at('2026-11-21', 15);
  try {
    await store.saveSettings({ historyCompleteFrom: '2026-01' });
    const data = await service.dashboard({ token: 't', query: { preset: 'month' } });
    assert.equal(data.history.completeFrom, '2026-01');
    assert.equal(data.history.source, 'settings');
    assert.equal(data.comparison.yoy.available, false);
    assert.equal(data.comparison.yoy.incompleteHistory, true);
    assert.equal(data.deltas.yoy, null, 'no false year-ago percentages');
    assert.equal(data.yoy, null);
    assert.ok(data.deltas.previous, 'previous period (October 2026) is still compared');
    assert.equal(data.months['2025-11'].incompleteHistory, true);
    assert.equal(data.months['2026-10'].incompleteHistory, false);
  } finally {
    await store.saveSettings({ historyCompleteFrom: '' });
    Date.now = realNow;
  }
});
