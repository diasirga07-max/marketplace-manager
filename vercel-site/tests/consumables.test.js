'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const calc = require('../lib/consumables/calc');
const { aggregateSales, almatyDayStart } = require('../lib/sales-core');
const finance = require('../lib/analytics/finance');

const closeTo = (actual, expected, eps = 1e-6) => assert.ok(Math.abs(actual - expected) < eps, `${actual} ≈ ${expected}`);

function sampleConfig(overrides = {}) {
  return calc.normalizeConfig({
    label: { packPrice: 1500, packQty: 500, mode: 'order' },
    bags: [
      { id: 'bag-s', name: 'Пакет S', width: 17.5, height: 25, flap: 4, packPrice: 1200, packQty: 100 },
      { id: 'bag-m', name: 'Пакет M', width: 24, height: 32, flap: 4, packPrice: 1800, packQty: 100 },
      { id: 'bag-l', name: 'Пакет L', width: 30, height: 40, flap: 4, packPrice: 2500, packQty: 100 },
    ],
    defaultBag: 'bag-m',
    bagBySku: { 'BOOK-1': 'bag-s' },
    bagRule: { minUnits: 2, bagId: 'bag-l' },
    stretch: { packPrice: 3000, lengthM: 300, widthCm: 50, cmPerUnit: 30, bySku: { 'BIG-1': 60 } },
    tape: { packPrice: 400, lengthM: 100, cmPerOrder: 50 },
    ...overrides,
  }, { strict: true }).config;
}

function historyFor(config, from = '2026-01-01') {
  return calc.mergeHistory([], calc.priceChanges(config, [], { today: from }));
}

test('validation: prices ≥ 0, pack quantity > 0', () => {
  assert.throws(() => calc.normalizeConfig({ label: { packPrice: -1, packQty: 500 } }, { strict: true }), /≥ 0/);
  assert.throws(() => calc.normalizeConfig({ label: { packPrice: 10, packQty: 0 } }, { strict: true }), /> 0/);
  assert.throws(() => calc.normalizeConfig({ stretch: { packPrice: 10, lengthM: 0 } }, { strict: true }), /> 0/);
  assert.throws(() => calc.normalizeConfig({ bags: [{ id: 'x', name: 'X', packPrice: 5, packQty: -3 }] }, { strict: true }), /> 0/);
  const { config } = calc.normalizeConfig({ label: { packPrice: '1 500,5', packQty: '500' } }, { strict: true });
  assert.equal(config.label.packPrice, 1500.5);
});

test('unit prices: label per piece, stretch/tape per cm', () => {
  const prices = calc.currentPrices(sampleConfig());
  closeTo(prices.label.unitPrice, 3);
  closeTo(prices['bag:bag-m'].unitPrice, 18);
  closeTo(prices.stretch.unitPrice, 0.1);
  closeTo(prices.tape.unitPrice, 0.04);
});

test('one textbook: label + default bag + stretch + tape', () => {
  const config = sampleConfig();
  const cost = calc.orderCost(config, calc.priceIndex(historyFor(config)), [{ sku: 'KITAPENT00082', qty: 1 }], '2026-11-20');
  closeTo(cost.label, 3);
  closeTo(cost.bag, 18);
  closeTo(cost.stretch, 3);
  closeTo(cost.tape, 2);
  closeTo(cost.total, 26);
  assert.equal(cost.usage.bag.id, 'bag-m');
  assert.deepEqual(cost.missing, []);
});

test('three units: rule bag, stretch override, shared costs split by quantity', () => {
  const config = sampleConfig();
  const index = calc.priceIndex(historyFor(config));
  const cost = calc.orderCost(config, index, [{ sku: 'BOOK-1', qty: 2 }, { sku: 'BIG-1', qty: 1 }], '2026-11-20');
  assert.equal(cost.usage.bag.id, 'bag-l', 'more than 2 units → bag L even though BOOK-1 maps to S');
  closeTo(cost.stretch, 2 * 30 * 0.1 + 60 * 0.1);
  closeTo(cost.total, 3 + 25 + 12 + 2);
  closeTo(cost.items[0].total, 6 + 30 * 2 / 3);
  closeTo(cost.items[1].total, 6 + 30 / 3);
  closeTo(cost.items[0].total + cost.items[1].total, cost.total);
});

test('label per unit mode and sku bag override', () => {
  const config = sampleConfig({ label: { packPrice: 1500, packQty: 500, mode: 'unit' } });
  const cost = calc.orderCost(config, calc.priceIndex(historyFor(config)), [{ sku: 'book-1', qty: 2 }], '2026-11-20');
  assert.equal(cost.usage.labels, 2);
  assert.equal(cost.usage.bag.id, 'bag-s');
});

test('price history: past dates keep the old price, missing price is reported', () => {
  const config = sampleConfig();
  let history = historyFor(config, '2026-01-01');
  const raised = sampleConfig({ label: { packPrice: 3000, packQty: 500 } });
  const changes = calc.priceChanges(raised, history, { today: '2026-11-22' });
  assert.deepEqual(changes.map((c) => c.item), ['label']);
  history = calc.mergeHistory(history, changes);
  const index = calc.priceIndex(history);
  closeTo(calc.orderCost(raised, index, [{ sku: 'A', qty: 1 }], '2026-11-21').label, 3);
  closeTo(calc.orderCost(raised, index, [{ sku: 'A', qty: 1 }], '2026-11-22').label, 6);
  const before = calc.orderCost(raised, index, [{ sku: 'A', qty: 1 }], '2025-12-31');
  assert.equal(before.total, 0);
  assert.ok(before.missing.includes('label'));
});

test('sales report: consumables reduce profit, summary/top/daily stay consistent, input not mutated', () => {
  const config = sampleConfig();
  const state = { config, history: historyFor(config) };
  const completionDate = almatyDayStart('2026-11-20') + 12 * 3600_000;
  const catalog = new Map([['BOOK-1', { wholesale: 1000 }], ['BIG-1', { wholesale: 2000 }], ['KITAPENT00082', { wholesale: 1500 }]]);
  const aggregate = aggregateSales([
    { code: '1', completionDate, totalPrice: 4000, delivery: 0, items: [{ sku: 'KITAPENT00082', quantity: 1, totalPrice: 4000 }] },
    { code: '2', completionDate, totalPrice: 9000, delivery: 0, items: [{ sku: 'BOOK-1', quantity: 2, totalPrice: 5000 }, { sku: 'BIG-1', quantity: 1, totalPrice: 4000 }] },
  ], catalog);
  const report = { summary: aggregate.summary, top: aggregate.top, daily: aggregate.daily, consumableBasis: calc.salesBasis(aggregate.orders) };
  const profitBefore = report.summary.profit;
  const result = calc.applyToSales(report, state);
  closeTo(result.summary.consumables, 26 + 42);
  closeTo(result.summary.profit, profitBefore - 68);
  closeTo(result.daily[0].consumables, 68);
  closeTo(result.daily[0].profit, profitBefore - 68);
  const topSum = result.top.reduce((sum, row) => sum + row.consumables, 0);
  closeTo(topSum, 68);
  assert.equal(report.summary.profit, profitBefore, 'cached report must not be mutated');
  assert.equal(result.consumableBasis, undefined, 'basis is not sent to the browser');
  assert.equal(result.consumables.configured, true);
});

test('sales report: unconfigured consumables give zero and a flag', () => {
  const { config } = calc.normalizeConfig({});
  const result = calc.applyToSales({ summary: { profit: 100, confirmedProfit: 100, profitComplete: true }, top: [], daily: [], consumableBasis: [] }, { config, history: [] });
  assert.equal(result.summary.consumables, 0);
  assert.equal(result.summary.profit, 100);
  assert.equal(result.consumables.configured, false);
});

test('Динамика продаж: lines carry consumables and net profit is reduced', () => {
  const config = sampleConfig();
  const at = almatyDayStart('2026-11-20') + 12 * 3600_000;
  const orders = [{ id: 'o1', kind: 'sale', at, total: 4000, delivery: 0, items: [{ sku: 'KITAPENT00082', qty: 1, price: 4000 }] }];
  const catalog = { bySku: new Map([['KITAPENT00082', { wholesale: 1500 }]]) };
  const without = finance.explodeLines(orders, catalog, {});
  const withC = finance.explodeLines(orders, catalog, {}, { config, history: historyFor(config) });
  closeTo(withC.lines[0].consumables, 26);
  assert.equal(without.lines[0].consumables, 0);
  const bounds = { ge: at - 1, le: at + 1 };
  const a = finance.summarize({ saleLines: without.lines, cancelLines: [], expenses: [], settings: {}, bounds, from: '2026-11-20', to: '2026-11-20', filters: {} });
  const b = finance.summarize({ saleLines: withC.lines, cancelLines: [], expenses: [], settings: {}, bounds, from: '2026-11-20', to: '2026-11-20', filters: {} });
  closeTo(b.summary.consumables, 26);
  closeTo(a.summary.netProfit - b.summary.netProfit, 26);
});

test('stock overview: balance = inventory + receipts − shipped, statuses and purchase advice', () => {
  const now = Date.UTC(2026, 10, 22, 6);
  const config = sampleConfig();
  config.stock = { label: { qty: 100, at: now - 10 * 86_400_000 }, tape: { qty: 500, at: now - 10 * 86_400_000 } };
  const shipped = Array.from({ length: 60 }, (_, i) => ({ at: now - (i + 0.5) * 86_400_000 / 2, items: [{ sku: 'A', qty: 1 }] }));
  const active = Array.from({ length: 5 }, () => ({ items: [{ sku: 'A', qty: 1 }] }));
  const receipts = [{ item: 'label', qty: 50, at: now - 86_400_000 }];
  const view = calc.stockOverview(config, { active, shipped, receipts, now });
  const label = view.rows.find((row) => row.key === 'label');
  assert.equal(label.usedSince, 20, '20 orders shipped during the last 10 days');
  assert.equal(label.current, 100 + 50 - 20);
  assert.equal(label.need, 5);
  assert.equal(label.status, 'green');
  closeTo(label.avgDaily, 2);
  assert.equal(label.buyPacks, 0);
  const tape = view.rows.find((row) => row.key === 'tape');
  assert.equal(tape.current, 500 - 20 * 50);
  assert.equal(tape.status, 'red');
  assert.equal(tape.short, 250 + 500);
  const stretch = view.rows.find((row) => row.key === 'stretch');
  assert.equal(stretch.status, 'unknown');
  assert.equal(view.activeOrders, 5);
  closeTo(view.avgOrdersPerDay, 2);
});

test('API module=consumables: save config with price date, stock operations, preview, validation', async () => {
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
    config: { label: { packPrice: 1500, packQty: 500 }, tape: { packPrice: 400, lengthM: 100, cmPerOrder: 50 } },
    priceFrom: { label: '2026-01-01', tape: '2026-01-01' },
  });
  assert.equal(saved.status, 200);
  assert.ok(saved.json.priceChanges.some((c) => c.item === 'label' && c.from === '2026-01-01'));
  closeTo(saved.json.prices.label.unitPrice, 3);
  const receipt = await call('POST', { op: 'stock' }, { item: 'tape', type: 'receipt', qty: 2, unit: 'pack' });
  assert.equal(receipt.json.config.stock.tape.qty, 20000, '2 rolls × 100 m = 20 000 cm');
  const inv = await call('POST', { op: 'stock' }, { item: 'label', type: 'inventory', qty: 320, unit: 'base' });
  assert.equal(inv.json.config.stock.label.qty, 320);
  assert.equal(inv.json.journal.length, 2);
  const negative = await call('POST', { op: 'stock' }, { item: 'label', type: 'receipt', qty: -1 });
  assert.equal(negative.status, 400);
  const preview = await call('POST', { op: 'preview' }, { items: [{ sku: 'A', qty: 1 }], date: '2026-11-20' });
  closeTo(preview.json.cost.label, 3);
  closeTo(preview.json.cost.tape, 2);
  const early = await call('POST', { op: 'preview' }, { items: [{ sku: 'A', qty: 1 }], date: '2025-12-31' });
  assert.equal(early.json.cost.total, 0, 'no price before its start date');
  const now = await call('GET', { op: 'now' });
  assert.equal(now.status, process.env.KASPI_API_TOKEN ? 200 : 401);
  store.__test.reset(null);
});
