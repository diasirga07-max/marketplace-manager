'use strict';

// Synthetic orders exist only in this test file (no mock data in production).
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/quality/compute');
const H = require('../lib/quality/handler');
const L = require('../lib/quality/loader');

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-21T18:00:00+05:00');

function order(i, extra = {}) {
  return {
    id: `id${i}`, code: String(1100000000 + i), createdAt: NOW - (i % 29) * DAY - 3_600_000,
    state: 'ARCHIVE', status: 'COMPLETED', reason: '', kd: false, planTransfer: 0, transfer: 0,
    items: [{ sku: i % 2 ? 'SKU-A' : 'SKU-B', name: i % 2 ? 'Alpha книга' : 'Beta тетрадь', qty: 1, catTitle: i % 2 ? 'Книги' : 'Канцтовары' }],
    ...extra,
  };
}

function dataset() {
  const list = [];
  for (let i = 0; i < 200; i += 1) list.push(order(i));
  // 4 seller-fault cancels on SKU-A, 2 buyer cancels, 1 multi-item cancel
  list[1] = order(1, { status: 'CANCELLED', reason: 'MERCHANT_OUT_OF_STOCK' });
  list[3] = order(3, { status: 'CANCELLED', reason: 'MERCHANT_OUT_OF_STOCK' });
  list[5] = order(5, { status: 'CANCELLED', reason: 'TIMEOUT_MERCHANT_DELIVERY' });
  list[7] = order(7, { status: 'CANCELLED', reason: 'BUYER_CANCELLATION_HIMSELF' });
  list[8] = order(8, { status: 'CANCELLED', reason: 'BUYER_CANCELLATION_HIMSELF' });
  list[10] = order(10, { status: 'CANCELLED', reason: 'PRODUCT_OUT_OF_STOCK', items: [
    { sku: 'SKU-A', name: 'Alpha книга', qty: 1, catTitle: 'Книги' },
    { sku: 'SKU-B', name: 'Beta тетрадь', qty: 1, catTitle: 'Канцтовары' },
  ] });
  // Kaspi delivery: 10 orders, 2 late, 1 not transferred and overdue, 1 future
  for (let k = 0; k < 10; k += 1) {
    const i = 20 + k;
    const plan = NOW - 2 * DAY - k * DAY;
    list[i] = order(i, { kd: true, planTransfer: plan, transfer: plan - 3_600_000, createdAt: plan - DAY });
  }
  list[20].transfer = list[20].planTransfer + 5 * 3_600_000;
  list[21].transfer = list[21].planTransfer + 1 * 3_600_000;
  list[22] = { ...list[22], status: 'ACCEPTED_BY_MERCHANT', state: 'KASPI_DELIVERY', transfer: 0 };
  list[23] = { ...list[23], planTransfer: NOW + DAY, transfer: 0, status: 'ACCEPTED_BY_MERCHANT', state: 'KASPI_DELIVERY' };
  // Returns: 3 returned, one with a quality reason from CSV, one other, one unknown
  list[40] = order(40, { status: 'RETURNED' });
  list[41] = order(41, { status: 'RETURNED' });
  list[42] = order(42, { status: 'RETURNED' });
  return list;
}

const returnsByCode = new Map([
  [String(1100000000 + 40), { reason: 'Брак: не работает' }],
  [String(1100000000 + 41), { reason: 'Передумал' }],
]);

test('computeDashboard: cancels by seller-fault reasons over finished orders', () => {
  const d = C.computeDashboard({ orders: dataset(), config: {}, sheetBrands: new Map(), returnsByCode, now: NOW, days: 30 });
  const m = d.metrics.cancels;
  assert.equal(m.bad, 4); // 2× MERCHANT_OUT_OF_STOCK + TIMEOUT_MERCHANT_DELIVERY + PRODUCT_OUT_OF_STOCK
  assert.equal(m.total, 198); // 200 minus 2 open KD orders (not ARCHIVE yet)
  assert.ok(Math.abs(m.value - 4 / 198) < 1e-12);
  assert.equal(m.calculator.cleanNeeded, Math.ceil(4 / 0.01 - 198));
  const raw = Object.fromEntries(d.cancellationReasons.map((r) => [r.code, r.count]));
  assert.equal(raw.BUYER_CANCELLATION_HIMSELF, 2);
  assert.equal(raw.MERCHANT_OUT_OF_STOCK, 2);
  assert.equal(d.cancellationReasons.find((r) => r.code === 'BUYER_CANCELLATION_HIMSELF').sellerFault, false);
});

test('seller-fault list is configurable', () => {
  const d = C.computeDashboard({ orders: dataset(), config: { sellerFaultReasons: ['BUYER_CANCELLATION_HIMSELF'] }, sheetBrands: new Map(), returnsByCode, now: NOW, days: 30 });
  assert.equal(d.metrics.cancels.bad, 2);
});

test('delays: late transfer and overdue untransferred orders', () => {
  const d = C.computeDashboard({ orders: dataset(), config: {}, sheetBrands: new Map(), returnsByCode, now: NOW, days: 30 });
  const m = d.metrics.delays;
  assert.equal(m.total, 9); // 10 KD minus the one with a future plan date
  assert.equal(m.bad, 3); // 2 late + 1 overdue without transfer
  const grace = C.computeDashboard({ orders: dataset(), config: { delayGraceMinutes: 120 }, sheetBrands: new Map(), returnsByCode, now: NOW, days: 30 });
  assert.equal(grace.metrics.delays.bad, 2); // 1-hour lateness is within grace
});

test('returns: quality from CSV reasons, unknown counted separately', () => {
  const d = C.computeDashboard({ orders: dataset(), config: {}, sheetBrands: new Map(), returnsByCode, now: NOW, days: 30 });
  const m = d.metrics.returns;
  assert.equal(m.bad, 1);
  assert.equal(m.unknown, 1);
  assert.ok(m.upperBound > m.value);
});

test('breakdown: contribution, share, multi-item flag, top marks, sorted by contribution', () => {
  const d = C.computeDashboard({ orders: dataset(), config: {}, sheetBrands: new Map(), returnsByCode, now: NOW, days: 30 });
  const sku = d.details.cancels.sku;
  assert.equal(sku[0].key, 'SKU-A');
  assert.equal(sku[0].bad, 4); // 3 own + 1 multi-item order
  assert.equal(sku[0].multiBad, 1);
  const b = sku.find((r) => r.key === 'SKU-B');
  assert.equal(b.bad, 1); // multi-item cancel counted for every SKU in the order
  assert.ok(Math.abs(sku[0].contribution - 4 / 198) < 1e-12);
  assert.equal(sku[0].share, 1);
  assert.equal(sku[0].top, true);
  assert.ok(Math.abs(sku[0].whatIf - 0) < 1e-12);
  const brands = d.details.cancels.brand;
  assert.equal(brands[0].key, 'Alpha');
  assert.equal(brands[0].auto, true);
  assert.ok(d.details.cancels.category.some((r) => r.key === 'Книги'));
});

test('brand resolution: sheet → manual override → auto first word', () => {
  const resolve = C.brandResolver({ sheetBrands: new Map([['SKU-A', 'Издательство А']]), overrides: { 'SKU-B': 'Бренд Б' } });
  assert.deepEqual(resolve('sku-a', 'Alpha'), { brand: 'Издательство А', source: 'sheet' });
  assert.deepEqual(resolve('SKU-B', 'Beta'), { brand: 'Бренд Б', source: 'manual' });
  assert.deepEqual(resolve('SKU-C', 'гамма ручка'), { brand: 'Гамма', source: 'auto' });
});

test('filters by brand / category narrow the orders', () => {
  const d = C.computeDashboard({ orders: dataset(), config: {}, sheetBrands: new Map(), returnsByCode, now: NOW, days: 30, filters: { category: 'Канцтовары' } });
  assert.ok(d.metrics.cancels.total < 198);
  assert.equal(d.metrics.cancels.bad, 1);
});

test('computeOrders: drill-down list with reasons and links', () => {
  const r = C.computeOrders({ orders: dataset(), config: {}, sheetBrands: new Map(), returnsByCode, now: NOW, days: 30, metric: 'cancels', dim: 'sku', key: 'SKU-B' });
  assert.equal(r.orders.length, 1);
  assert.equal(r.orders[0].multi, true);
  assert.equal(r.orders[0].reason, 'PRODUCT_OUT_OF_STOCK');
  assert.match(r.orders[0].url, /1100000010/);
});

test('recommendations mention top SKU and reason', () => {
  const d = C.computeDashboard({ orders: dataset(), config: {}, sheetBrands: new Map(), returnsByCode, now: NOW, days: 30 });
  const rec = d.recommendations.find((x) => x.metric === 'cancels');
  assert.match(rec.text, /SKU SKU-A/);
  assert.match(rec.text, /из 4 отмен/);
  assert.ok(d.recommendations.some((x) => x.metric === 'returns'));
});

test('calibration against the 21.11 reference snapshot', () => {
  const c = C.calibration({ orders: dataset(), config: {}, sheetBrands: new Map(), returnsByCode, now: NOW, snapshot: H.REFERENCE_SNAPSHOT });
  assert.equal(c.window.toDay, '2026-11-21');
  assert.equal(c.window.fromDay, '2026-10-23');
  const cancels = c.rows.find((r) => r.key === 'cancels');
  assert.equal(cancels.cabinet.bad, 40);
  assert.equal(cancels.cabinet.total, 2111);
  assert.equal(cancels.diffBad, 4 - 40);
});

test('manualMetrics: rating calculator from snapshot, chats needed', () => {
  const m = C.manualMetrics({ snapshot: H.REFERENCE_SNAPSHOT, reviews: [], now: NOW, config: { customTargets: { chats: 0.5 } } });
  assert.equal(m.rating.zone, 'good');
  assert.equal(m.rating.calculator.reserveOnes, 111);
  assert.equal(m.chats.needed, 110);
  assert.equal(m.chats.avgMinutes, 16);
});

test('windowFor: 30 days inclusive in Asia/Almaty', () => {
  const w = C.windowFor(Date.parse('2026-11-21T10:00:00+05:00'), 30);
  assert.equal(w.fromDay, '2026-10-23');
  assert.equal(w.toDay, '2026-11-21');
  const w90 = C.windowFor(Date.parse('2026-11-21T10:00:00+05:00'), 90);
  assert.equal(w90.fromDay, '2026-08-24'); // cabinet rating window 24.08–21.11
});

test('normalizeOrder keeps metric fields and drops customer data', () => {
  const o = L.normalizeOrder({ id: 'X', attributes: {
    code: '1160088307', creationDate: 1795316550773, state: 'KASPI_DELIVERY', status: 'ACCEPTED_BY_MERCHANT',
    isKaspiDelivery: true, preOrder: true, plannedDeliveryDate: 1795802400000,
    kaspiDelivery: { courierTransmissionPlanningDate: 1795618800000 },
    customer: { firstName: 'Имя', cellPhone: '7700' }, deliveryAddress: { formattedAddress: 'адрес' },
  } });
  assert.equal(o.planTransfer, 1795618800000);
  assert.equal(o.transfer, 0);
  assert.equal(o.kd, true);
  assert.equal(JSON.stringify(o).includes('7700'), false);
  assert.equal(JSON.stringify(o).includes('адрес'), false);
});

test('loader windows are at most 14 days', () => {
  const ws = L.windows(0, 100 * DAY);
  assert.ok(ws.every(([a, b]) => b - a <= 14 * DAY - 1));
  assert.equal(ws[0][0], 0);
  assert.equal(ws.at(-1)[1], 100 * DAY);
});

test('snapshot / import validation', () => {
  assert.throws(() => H.__test.normalizeSnapshot({ date: '21.11.2026' }), /ГГГГ-ММ-ДД/);
  assert.throws(() => H.__test.normalizeSnapshot({ date: '2026-11-21', cancels: { bad: 50, total: 40 } }), /X ≤ Y/);
  const s = H.__test.normalizeSnapshot({ date: '2026-11-21', cancels: { bad: '40', total: '2 111' }, rating: { value: '4,9', count: 1342 } });
  assert.deepEqual(s.cancels, { bad: 40, total: 2111 });
  assert.equal(s.rating.value, 4.9);
  const rows = H.__test.normalizeImportRows('returns', [{ code: '№ 1100000040', reason: 'Брак' }, { code: '', reason: 'x' }]);
  assert.deepEqual(rows.map((r) => r.code), ['1100000040']);
  assert.equal(H.__test.latestSnapshot([]).id, 'reference-2026-11-21');
});

test('cron authorization uses CRON_SECRET when set', () => {
  const old = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 's3cret';
  assert.equal(H.__test.cronAuthorized({ headers: { authorization: 'Bearer s3cret' } }), true);
  assert.equal(H.__test.cronAuthorized({ headers: { authorization: 'Bearer nope', 'user-agent': 'vercel-cron/1.0' } }), false);
  if (old === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = old;
});

test('delays use the earliest plan seen when Kaspi moved courierTransmissionPlanningDate', () => {
  const H = 3_600_000;
  const base = { id: 'k', code: '1', createdAt: NOW - 5 * DAY, state: 'ARCHIVE', status: 'COMPLETED', kd: true, items: [] };
  const moved = { ...base, planTransfer: NOW - 2 * DAY, planOrig: NOW - 3 * DAY, transfer: NOW - 2 * DAY - H };
  const kept = { ...base, id: 'k2', code: '2', planTransfer: NOW - 2 * DAY, planOrig: NOW - 2 * DAY, transfer: NOW - 2 * DAY - H };
  const d = C.computeDashboard({ orders: [moved, kept], config: {}, sheetBrands: new Map(), now: NOW, days: 30 });
  assert.equal(d.metrics.delays.total, 2);
  assert.equal(d.metrics.delays.bad, 1);
  assert.equal(d.delayStats.planMoved, 1);
  assert.equal(d.delayStats.buckets.early0_24, 2);
});
