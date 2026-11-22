'use strict';

// Kaspi API is stubbed: no network, no token.
const test = require('node:test');
const assert = require('node:assert/strict');
const { internal } = require('../lib/grants-data-service');

const DAY = 86_400_000;
const calls = { list: 0, entries: 0 };
// One archived order created 3 days ago and completed today; the stub returns it
// for both days, like Kaspi's creationDate filter does.
let NOW = 0;
internal.listOrders = async (_token, { state, ge, le }) => {
  calls.list += 1;
  if (state) return [];
  const created = NOW - 3 * DAY;
  const completed = NOW - 1000;
  const hit = (t) => t >= ge && t <= le;
  if (!hit(created) && !hit(completed)) return [];
  return [{ id: 'o1', attributes: { code: '1100000001', creationDate: created, completionDate: completed, state: 'ARCHIVE', status: 'COMPLETED', customer: { cellPhone: '7700' } } }];
};
internal.kaspiGet = async (path) => {
  if (path.endsWith('/entries')) {
    calls.entries += 1;
    return { data: [{ id: 'e1', attributes: { quantity: 2, totalPrice: 500, category: { code: 'C1', title: 'Книги' } }, relationships: { product: { data: { id: 'm1' } } } }] };
  }
  if (path.includes('/merchantProduct')) return { data: { attributes: { code: 'SKU-1', name: 'Книга' } } };
  throw Object.assign(new Error('unexpected ' + path), { status: 404 });
};

const loader = require('../lib/quality/loader');
const store = require('../lib/quality/store');

test('refresh lists one Almaty day at a time and stores the days Kaspi returned each order', async () => {
  NOW = Date.parse('2026-11-22T10:00:00+05:00');
  const from = NOW - loader.RANGE_DAYS * DAY;
  const p = await loader.refresh({ token: 'stub', now: NOW, deadline: Date.now() + 10_000 });
  const expected = 2 * loader.__test.dayWindows(from, NOW).length + 4 * loader.windows(NOW - 28 * DAY, NOW).length;
  assert.equal(calls.list, expected);
  assert.equal(p.complete, true);
  assert.equal(p.orders, 1);
  assert.equal(calls.entries, 1);
  const ds = await loader.readDataset();
  const o = ds.orders[0];
  assert.deepEqual(o.days, [20261119, 20261122]);
  assert.equal(o.items[0].sku, 'SKU-1');
  assert.equal(JSON.stringify(ds).includes('7700'), false);
  assert.equal((await store.getValue(loader.STATUS_KEY, null)).phase, 'complete');
  // Within 10 minutes the listing is reused and items are not reloaded.
  const before = calls.list;
  await loader.refresh({ token: 'stub', now: NOW + 60_000, deadline: Date.now() + 10_000 });
  assert.equal(calls.list, before);
  assert.equal(calls.entries, 1);
});

test('dayWindows are Almaty calendar days', () => {
  const ws = loader.__test.dayWindows(Date.parse('2026-11-20T23:30:00+05:00'), Date.parse('2026-11-22T10:00:00+05:00'));
  assert.deepEqual(ws.map((w) => w.day), [20261120, 20261121, 20261122]);
  assert.equal(ws[0].ge, Date.parse('2026-11-20T00:00:00+05:00'));
  assert.equal(ws[1].le - ws[1].ge, DAY - 1);
});
