'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const calc = require('../lib/consumables/calc');
const { aggregateSales, almatyDayStart } = require('../lib/sales-core');
const finance = require('../lib/analytics/finance');

const closeTo = (actual, expected, eps = 1e-6) => assert.ok(Math.abs(actual - expected) < eps, `${actual} ≈ ${expected}`);
const NOV = '2026-11-20';
const novOrders = () => ({ count: 1200, projected: false }); // 1 200 orders in November

// Prices from the «Расходники» sheet where they are unambiguous; label/bags — example values.
function sampleConfig(overrides = {}) {
  return calc.normalizeConfig({
    label: { packPrice: 1500, packQty: 500, mode: 'order' },
    bags: [
      { id: 'bag-a5', name: 'Пакет A5', width: 20, height: 40, packPrice: 1200, packQty: 100 },
      { id: 'bag-a4', name: 'Пакет A4', width: 30, height: 40, packPrice: 1500, packQty: 100 },
    ],
    defaultBag: 'bag-a5',
    bagBySku: {},
    bagRule: { minUnits: 3, bagId: 'bag-a4' },
    formats: [
      { id: 'A5', name: 'A5', bagId: 'bag-a5', cmPerUnit: 70 },
      { id: 'A4', name: 'A4', bagId: 'bag-a4', cmPerUnit: 170 },
    ],
    defaultFormat: 'A5',
    skuFormat: { 'ATLAS-A4': 'A4' },
    stretch: { packPrice: 800, lengthM: 300, widthCm: 30, cmPerUnit: 50, bySku: {} },
    tapes: [
      { id: 'tape-glass', name: 'Скотч «Осторожно стекло»', packPrice: 400, mode: 'month', rollsPerMonth: 1 },
      { id: 'tape-clear', name: 'Скотч прозрачный', packPrice: 500, mode: 'month', rollsPerMonth: 1 },
    ],
    ...overrides,
  }, { strict: true }).config;
}

function historyFor(config, from = '2026-01-01') {
  return calc.mergeHistory([], calc.priceChanges(config, [], { today: from }));
}

test('validation: prices ≥ 0, pack quantity > 0, known formats only', () => {
  assert.throws(() => calc.normalizeConfig({ label: { packPrice: -1, packQty: 500 } }, { strict: true }), /≥ 0/);
  assert.throws(() => calc.normalizeConfig({ label: { packPrice: 10, packQty: 0 } }, { strict: true }), /> 0/);
  assert.throws(() => calc.normalizeConfig({ stretch: { packPrice: 10, lengthM: 0 } }, { strict: true }), /> 0/);
  assert.throws(() => calc.normalizeConfig({ tapes: [{ name: 'X', mode: 'month', packPrice: 400, rollsPerMonth: -1 }] }, { strict: true }), /≥ 0/);
  assert.throws(() => calc.normalizeConfig({ skuFormat: { ABC: 'A3' } }, { strict: true }), /неизвестный формат/);
  const { config } = calc.normalizeConfig({ label: { packPrice: '1 500,5', packQty: '500' } }, { strict: true });
  assert.equal(config.label.packPrice, 1500.5);
});

test('defaults follow the sheet: A5/A4 formats, two monthly tapes 400 ₸ and 500 ₸', () => {
  const { config } = calc.normalizeConfig({});
  assert.equal(config.defaultFormat, 'A5');
  assert.deepEqual(config.formats.map((f) => [f.id, f.cmPerUnit]), [['A5', 70], ['A4', 170]]);
  assert.deepEqual(config.tapes.map((t) => [t.packPrice, t.mode, t.rollsPerMonth]), [[400, 'month', 1], [500, 'month', 1]]);
  const legacy = calc.normalizeConfig({ tape: { packPrice: 400, lengthM: 100, cmPerOrder: 50 } }).config;
  assert.equal(legacy.tapes.length, 1);
  assert.equal(legacy.tapes[0].mode, 'order');
});

test('format selection: sku override → format of sku → default format → general values', () => {
  const config = sampleConfig({
    bagBySku: { 'SPECIAL-1': 'bag-a4' },
    stretch: { packPrice: 800, lengthM: 300, cmPerUnit: 50, bySku: { 'SPECIAL-1': 20 } },
    formats: [{ id: 'A5', name: 'A5', bagId: 'bag-a5', cmPerUnit: 70 }, { id: 'A4', name: 'A4', bagId: 'bag-a4', cmPerUnit: 170 }, { id: 'MINI', name: 'Мини', bagId: '', cmPerUnit: null }],
    skuFormat: { 'ATLAS-A4': 'A4', 'CARD-1': 'MINI' },
  });
  const one = (sku) => calc.orderUsage(config, [{ sku, qty: 1 }]);
  assert.equal(one('SPECIAL-1').bag.id, 'bag-a4');
  assert.equal(one('SPECIAL-1').stretchCm, 20, 'sku override wins over the format');
  assert.equal(one('ATLAS-A4').bag.id, 'bag-a4');
  assert.equal(one('ATLAS-A4').stretchCm, 170, 'format of the article');
  assert.equal(one('UNKNOWN').bag.id, 'bag-a5');
  assert.equal(one('UNKNOWN').stretchCm, 70, 'default format A5');
  assert.equal(one('CARD-1').bag.id, 'bag-a5', 'format without bag → default bag');
  assert.equal(one('CARD-1').stretchCm, 50, 'format without cm → general value');
  const noDefault = sampleConfig({ defaultFormat: '' });
  assert.equal(calc.orderUsage(noDefault, [{ sku: 'UNKNOWN', qty: 1 }]).stretchCm, 50);
});

test('mixed formats take the largest bag; the "> N units" rule is unchanged', () => {
  const config = sampleConfig();
  assert.equal(calc.orderUsage(config, [{ sku: 'BOOK', qty: 1 }, { sku: 'ATLAS-A4', qty: 1 }]).bag.id, 'bag-a4');
  assert.equal(calc.orderUsage(config, [{ sku: 'BOOK', qty: 3 }]).bag.id, 'bag-a5', '3 is not more than 3');
  const big = calc.orderUsage(config, [{ sku: 'BOOK', qty: 4 }]);
  assert.equal(big.bag.id, 'bag-a4');
  assert.equal(big.bagReason, 'rule');
});

test('example 1: one A5 textbook with monthly tapes', () => {
  const config = sampleConfig();
  const cost = calc.orderCost(config, calc.priceIndex(historyFor(config)), [{ sku: 'KITAPENT00082', qty: 1 }], NOV, { monthOrders: novOrders });
  closeTo(cost.label, 3);
  closeTo(cost.bag, 12);
  closeTo(cost.stretch, 70 * 800 / 30000);
  closeTo(cost.tapes[0].cost, 400 / 1200);
  closeTo(cost.tapes[1].cost, 500 / 1200);
  closeTo(cost.total, 3 + 12 + 56 / 30 + 0.75);
  assert.deepEqual(cost.missing, []);
});

test('example 2: two A5 books + one A4 atlas — A4 bag, stretch by format, shared split by quantity', () => {
  const config = sampleConfig();
  const index = calc.priceIndex(historyFor(config));
  const cost = calc.orderCost(config, index, [{ sku: 'KITAPENT00082', qty: 2 }, { sku: 'ATLAS-A4', qty: 1 }], NOV, { monthOrders: novOrders });
  assert.equal(cost.usage.bag.id, 'bag-a4');
  assert.equal(cost.usage.stretchCm, 2 * 70 + 170);
  const cmPrice = 800 / 30000;
  closeTo(cost.stretch, 310 * cmPrice);
  closeTo(cost.shared, 3 + 15 + 0.75);
  closeTo(cost.items[0].total, 140 * cmPrice + 18.75 * 2 / 3);
  closeTo(cost.items[1].total, 170 * cmPrice + 18.75 / 3);
  closeTo(cost.items[0].total + cost.items[1].total, cost.total);
});

test('tape "см на заказ" mode still works next to monthly tapes', () => {
  const config = sampleConfig({ tapes: [{ id: 'tape-cm', name: 'Скотч', packPrice: 400, lengthM: 100, mode: 'order', cmPerOrder: 50 }] });
  const cost = calc.orderCost(config, calc.priceIndex(historyFor(config)), [{ sku: 'A', qty: 1 }], NOV);
  closeTo(cost.tape, 2);
  assert.deepEqual(calc.usageByKey(cost.usage)['tape:tape-cm'], 50);
});

test('monthly tape: unknown month count gives 0 and a flag; current month is projected', () => {
  const config = sampleConfig();
  const cost = calc.orderCost(config, calc.priceIndex(historyFor(config)), [{ sku: 'A', qty: 1 }], NOV, {});
  assert.equal(cost.tape, 0);
  assert.ok(cost.missing.includes('tape:tape-glass:orders'));
  const provider = calc.monthOrdersProvider(new Map([['2026-11', 330], ['2026-10', 1200]]), '2026-11-22');
  assert.deepEqual(provider('2026-10'), { count: 1200, actual: 1200, projected: false });
  const nov = provider('2026-11');
  closeTo(nov.count, 330 / 22 * 30);
  assert.equal(nov.projected, true);
});

test('price history: past dates keep the old price, missing price is reported', () => {
  const config = sampleConfig();
  let history = historyFor(config, '2026-01-01');
  const raised = sampleConfig({ label: { packPrice: 3000, packQty: 500 } });
  const changes = calc.priceChanges(raised, history, { today: '2026-11-22' });
  assert.deepEqual(changes.map((c) => c.item), ['label']);
  history = calc.mergeHistory(history, changes);
  const index = calc.priceIndex(history);
  closeTo(calc.orderCost(raised, index, [{ sku: 'A', qty: 1 }], '2026-11-21', { monthOrders: novOrders }).label, 3);
  closeTo(calc.orderCost(raised, index, [{ sku: 'A', qty: 1 }], '2026-11-22', { monthOrders: novOrders }).label, 6);
  const before = calc.orderCost(raised, index, [{ sku: 'A', qty: 1 }], '2025-12-31', { monthOrders: novOrders });
  assert.equal(before.total, 0);
  assert.ok(before.missing.includes('label'));
});

test('sales report: consumables reduce profit, monthly tape divided by orders of the month', () => {
  const config = sampleConfig();
  const state = { config, history: historyFor(config) };
  const completionDate = almatyDayStart('2026-10-20') + 12 * 3600_000;
  const catalog = new Map([['KITAPENT00082', { wholesale: 1500 }], ['ATLAS-A4', { wholesale: 2000 }]]);
  const aggregate = aggregateSales([
    { code: '1', completionDate, totalPrice: 4000, delivery: 0, items: [{ sku: 'KITAPENT00082', quantity: 1, totalPrice: 4000 }] },
    { code: '2', completionDate, totalPrice: 9000, delivery: 0, items: [{ sku: 'KITAPENT00082', quantity: 2, totalPrice: 5000 }, { sku: 'ATLAS-A4', quantity: 1, totalPrice: 4000 }] },
  ], catalog);
  const report = { summary: aggregate.summary, top: aggregate.top, daily: aggregate.daily, consumableBasis: calc.salesBasis(aggregate.orders) };
  const profitBefore = report.summary.profit;
  const result = calc.applyToSales(report, state, { monthCounts: new Map([['2026-10', 900]]), today: '2026-11-22' });
  const cmPrice = 800 / 30000;
  const tapePerOrder = 900 / 900;
  const expected = (3 + 12 + 70 * cmPrice + tapePerOrder) + (3 + 15 + 310 * cmPrice + tapePerOrder);
  closeTo(result.summary.consumables, expected);
  closeTo(result.summary.profit, profitBefore - expected);
  closeTo(result.daily[0].consumables, expected);
  closeTo(result.top.reduce((sum, row) => sum + row.consumables, 0), expected);
  assert.equal(report.summary.profit, profitBefore, 'cached report must not be mutated');
  assert.equal(result.consumableBasis, undefined);
  assert.equal(result.consumables.monthOrders['2026-10'].count, 900);
  // Without an external count the month is counted from the report itself (2 orders).
  const fromBasis = calc.applyToSales(report, state, { today: '2026-11-22' });
  closeTo(fromBasis.summary.consumables, expected - 2 + 2 * (900 / 2));
});

test('sales report: unconfigured consumables give zero and a flag', () => {
  const { config } = calc.normalizeConfig({ stretch: { packPrice: 0, lengthM: 300 }, tapes: [] });
  const result = calc.applyToSales({ summary: { profit: 100, confirmedProfit: 100, profitComplete: true }, top: [], daily: [], consumableBasis: [] }, { config, history: [] });
  assert.equal(result.summary.consumables, 0);
  assert.equal(result.summary.profit, 100);
  assert.equal(result.consumables.configured, false);
});

test('Динамика продаж: lines carry consumables and net profit is reduced', () => {
  const config = sampleConfig();
  const at = almatyDayStart(NOV) + 12 * 3600_000;
  const orders = [{ id: 'o1', kind: 'sale', at, total: 4000, delivery: 0, items: [{ sku: 'KITAPENT00082', qty: 1, price: 4000 }] }];
  const catalog = { bySku: new Map([['KITAPENT00082', { wholesale: 1500 }]]) };
  const without = finance.explodeLines(orders, catalog, {});
  const withC = finance.explodeLines(orders, catalog, {}, { config, history: historyFor(config), monthOrders: novOrders });
  const expected = 3 + 12 + 70 * 800 / 30000 + 0.75;
  closeTo(withC.lines[0].consumables, expected);
  assert.equal(without.lines[0].consumables, 0);
  const bounds = { ge: at - 1, le: at + 1 };
  const args = { cancelLines: [], expenses: [], settings: {}, bounds, from: NOV, to: NOV, filters: {} };
  const a = finance.summarize({ saleLines: without.lines, ...args });
  const b = finance.summarize({ saleLines: withC.lines, ...args });
  closeTo(b.summary.consumables, expected);
  closeTo(a.summary.netProfit - b.summary.netProfit, expected);
});

test('monthly tape stock: rolls used proportionally to days of each month', () => {
  const start = almatyDayStart('2026-10-17');
  const end = almatyDayStart('2026-11-16');
  closeTo(calc.monthlyRollsBetween(1, start, end), 15 / 31 + 15 / 30);
});

test('stock overview: balance, statuses, monthly tape in rolls, articles without format', () => {
  const now = almatyDayStart('2026-11-22') + 6 * 3600_000;
  const config = sampleConfig();
  config.stock = {
    label: { qty: 100, at: now - 10 * 86_400_000 },
    'tape:tape-glass': { qty: 1, at: almatyDayStart('2026-11-01') },
    'tape:tape-clear': { qty: 0.5, at: almatyDayStart('2026-11-01') },
  };
  const shipped = Array.from({ length: 60 }, (_, i) => ({ at: now - (i + 0.5) * 86_400_000 / 2, items: [{ sku: 'A', qty: 1 }] }));
  const active = [
    ...Array.from({ length: 4 }, () => ({ items: [{ sku: 'ATLAS-A4', name: 'Атлас', qty: 1 }] })),
    { items: [{ sku: 'NEW-BOOK', name: 'Новая книга', qty: 2 }] },
  ];
  const receipts = [{ item: 'label', qty: 50, at: now - 86_400_000 }];
  const view = calc.stockOverview(config, { active, shipped, receipts, now });
  const label = view.rows.find((row) => row.key === 'label');
  assert.equal(label.current, 100 + 50 - 20);
  assert.equal(label.need, 5);
  assert.equal(label.status, 'green');
  const glass = view.rows.find((row) => row.key === 'tape:tape-glass');
  assert.equal(glass.unit, 'roll');
  closeTo(glass.usedSince, (21 + 6 / 24) / 30, 1e-9);
  closeTo(glass.current, 1 - (21.25 / 30), 1e-9);
  closeTo(glass.daysLeft, glass.current / (12 / 365), 1e-9);
  assert.equal(glass.status, 'green', '≈ 8.9 days left at 1 roll per month');
  const clear = view.rows.find((row) => row.key === 'tape:tape-clear');
  assert.equal(clear.status, 'red', 'used more than the stock');
  assert.ok(clear.buyPacks >= 1);
  assert.equal(view.rows.find((row) => row.key === 'stretch').status, 'unknown');
  assert.deepEqual(view.withoutFormat.map((r) => [r.sku, r.qty]), [['NEW-BOOK', 2]]);
  assert.equal(view.defaultFormat, 'A5');
});

test('API module=consumables: save config with price date, stock in rolls, preview with month orders, validation', async () => {
  const api = require('../api/data');
  const store = require('../lib/consumables/store');
  store.__test.reset({});
  const call = (method, query, body) => new Promise((resolve) => {
    const res = { statusCode: 200, setHeader() {}, end(text) { resolve({ status: this.statusCode, json: JSON.parse(text) }); } };
    api({ method, query: { module: 'consumables', ...query }, headers: {}, body }, res);
  });
  const bad = await call('POST', { op: 'config' }, { config: { label: { packPrice: 100, packQty: 0 } } });
  assert.equal(bad.status, 400);
  const saved = await call('POST', { op: 'config' }, {
    config: { label: { packPrice: 1500, packQty: 500 }, skuFormat: { 'atlas-a4': 'A4' } },
    priceFrom: { label: '2026-01-01', 'tape:tape-glass': '2026-01-01', 'tape:tape-clear': '2026-01-01', stretch: '2026-01-01' },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.config.skuFormat['ATLAS-A4'], 'A4', 'articles are normalized');
  assert.ok(saved.json.priceChanges.some((c) => c.item === 'tape:tape-glass' && c.packPrice === 400));
  const receipt = await call('POST', { op: 'stock' }, { item: 'tape:tape-glass', type: 'receipt', qty: 2, unit: 'pack' });
  assert.equal(receipt.json.config.stock['tape:tape-glass'].qty, 2, 'monthly tape stock is kept in rolls');
  // Switching the tape to «см на заказ» converts the stock: 2 rolls × 100 m = 20 000 cm.
  const tapes = saved.json.config.tapes.map((t) => (t.id === 'tape-glass' ? { ...t, mode: 'order', cmPerOrder: 50 } : t));
  const switched = await call('POST', { op: 'config' }, { config: { tapes } });
  assert.equal(switched.json.config.stock['tape:tape-glass'].qty, 20000);
  const negative = await call('POST', { op: 'stock' }, { item: 'label', type: 'receipt', qty: -1 });
  assert.equal(negative.status, 400);
  const preview = await call('POST', { op: 'preview' }, { items: [{ sku: 'A', qty: 1 }], date: '2026-11-20', monthOrders: 1000 });
  closeTo(preview.json.cost.label, 3);
  const clear = preview.json.cost.tapes.find((t) => t.key === 'tape:tape-clear');
  closeTo(clear.cost, 0.5);
  const now = await call('GET', { op: 'now' });
  assert.equal(now.status, process.env.KASPI_API_TOKEN ? 200 : 401);
  store.__test.reset(null);
});
