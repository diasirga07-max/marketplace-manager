'use strict';

// Kaspi API is stubbed: no network, no token.
const test = require('node:test');
const assert = require('node:assert/strict');
const { internal } = require('../lib/grants-data-service');

const calls = { list: 0, entries: 0 };
internal.listOrders = async (_token, { state, ge }) => {
  calls.list += 1;
  if (state !== 'ARCHIVE') return [];
  return [{ id: `o${ge}`, attributes: { code: String(ge).slice(-10), creationDate: ge + 1000, state: 'ARCHIVE', status: 'CANCELLED', cancellationReason: 'MERCHANT_OUT_OF_STOCK', customer: { cellPhone: '7700' } } }];
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

test('refresh lists all states in 14-day windows, loads items and persists dataset + status', async () => {
  const now = Date.parse('2026-11-22T10:00:00+05:00');
  const p = await loader.refresh({ token: 'stub', now, deadline: Date.now() + 10_000 });
  assert.equal(p.complete, true);
  assert.equal(calls.list, loader.STATES.length * loader.windows(now - loader.RANGE_DAYS * 86_400_000, now).length);
  assert.equal(p.orders, 8);
  assert.equal(calls.entries, 8);
  const ds = await loader.readDataset();
  assert.equal(ds.orders[0].items[0].sku, 'SKU-1');
  assert.equal(ds.orders[0].items[0].catTitle, 'Книги');
  assert.equal(JSON.stringify(ds).includes('7700'), false);
  const status = await store.getValue(loader.STATUS_KEY, null);
  assert.equal(status.phase, 'complete');
  // Second run reuses items (no new entries calls) and keeps the listing for 10 min.
  await loader.refresh({ token: 'stub', now: now + 60_000, deadline: Date.now() + 10_000 });
  assert.equal(calls.entries, 8);
});
