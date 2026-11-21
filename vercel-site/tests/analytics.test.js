'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const periods = require('../lib/analytics/periods');
const finance = require('../lib/analytics/finance');
const { normalizeHeader, findColumn } = require('../lib/column-map');
const { maskCustomer } = require('../lib/analytics/kaspi-raw');

const NOW = Date.parse('2026-11-21T15:00:00+05:00'); // Saturday

function at(iso, hour = 12) {
  return Date.parse(`${iso}T${String(hour).padStart(2, '0')}:00:00+05:00`);
}

function close(actual, expected, eps = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} != ${expected}`);
}

test('column map normalizes headers', () => {
  assert.equal(normalizeHeader('  Цена  ОПТОВАЯ (₸) '), 'цена оптовая');
  assert.equal(normalizeHeader('﻿Артикул:'), 'артикул');
  assert.equal(findColumn(['x', 'Себестоимость, ₸'], 'catalog', 'cost'), 1);
  assert.equal(findColumn(['ч', 'Название'], 'catalog', 'sku'), -1);
});

test('period presets resolve in Asia/Almaty', () => {
  assert.deepEqual(
    (({ from, to, days, granularity }) => ({ from, to, days, granularity }))(periods.resolvePeriod({ preset: 'today' }, NOW)),
    { from: '2026-11-21', to: '2026-11-21', days: 1, granularity: 'hour' },
  );
  assert.equal(periods.resolvePeriod({ preset: 'yesterday' }, NOW).from, '2026-11-20');
  assert.equal(periods.resolvePeriod({ preset: '7d' }, NOW).from, '2026-11-15');
  assert.equal(periods.resolvePeriod({ preset: 'week' }, NOW).from, '2026-11-16'); // Monday
  const month = periods.resolvePeriod({ preset: 'month' }, NOW);
  assert.equal(month.from, '2026-11-01');
  assert.equal(month.granularity, 'day');
  assert.equal(periods.resolvePeriod({ preset: '3m' }, NOW).from, '2026-09-01');
  assert.equal(periods.resolvePeriod({ preset: '3m' }, NOW).granularity, 'week');
  assert.equal(periods.resolvePeriod({ preset: '6m' }, NOW).from, '2026-06-01');
  const year = periods.resolvePeriod({ preset: 'year' }, NOW);
  assert.equal(year.from, '2025-12-01');
  assert.equal(year.granularity, 'month');
  const custom = periods.resolvePeriod({ preset: 'custom', from: '2026-10-01', to: '2026-12-31' }, NOW);
  assert.equal(custom.to, '2026-11-21', 'future end date is clipped to today');
  assert.throws(() => periods.resolvePeriod({ preset: 'custom', from: '2026-11-10', to: '2026-11-01' }, NOW), /позже/);
});

test('comparison periods: calendar shift for month, length shift for rolling, YoY', () => {
  const month = periods.resolvePeriod({ preset: 'month' }, NOW);
  const cmp = periods.comparisonPeriods(month);
  assert.deepEqual(cmp.previous, { from: '2026-10-01', to: '2026-10-21' });
  assert.deepEqual(cmp.yoy, { from: '2025-11-01', to: '2025-11-21' });
  const rolling = periods.comparisonPeriods(periods.resolvePeriod({ preset: '7d' }, NOW));
  assert.deepEqual(rolling.previous, { from: '2026-11-08', to: '2026-11-14' });
  const mar = periods.comparisonPeriods({ preset: 'month', from: '2026-03-01', to: '2026-03-31', days: 31 });
  assert.equal(mar.previous.to, '2026-02-28', 'day is clamped to month length');
});

test('bucket lists for each granularity', () => {
  assert.equal(periods.bucketList('2026-11-21', '2026-11-21', 'hour').length, 24);
  assert.equal(periods.bucketList('2026-11-01', '2026-11-21', 'day').length, 21);
  const weeks = periods.bucketList('2026-09-01', '2026-11-21', 'week');
  assert.equal(weeks[0].key, '2026-08-31');
  assert.equal(weeks[0].label, '01.09–06.09');
  assert.equal(periods.bucketList('2025-12-01', '2026-11-21', 'month').length, 12);
  assert.equal(periods.bucketKey(at('2026-11-21', 0) + 30 * 60_000, 'hour'), '00');
  assert.equal(periods.bucketKey(Date.parse('2026-11-20T20:30:00Z'), 'day'), '2026-11-21', 'UTC evening is next Almaty day');
});

const catalog = {
  bySku: new Map([
    ['A1', { sku: 'A1', name: 'Книга А', wholesale: 1000 }],
    ['OPT-2', { sku: 'OPT-2', name: 'Опт товар', wholesale: 500 }],
  ]),
};

const orders = [
  {
    id: '1', kind: 'sale', at: at('2026-11-02'), total: 3000, delivery: 300, deliverySource: 'api', extra: 0,
    items: [
      { sku: 'A1', name: 'A', qty: 1, price: 2000, category: 'Книги' },
      { sku: 'OPT-2', name: 'B', qty: 2, price: 1000, category: 'Канцелярия' },
    ],
  },
  {
    id: '2', kind: 'sale', at: at('2026-11-03'), total: 1000, delivery: 149, deliverySource: 'tariff', extra: 0,
    items: [{ sku: 'NOCOST', name: 'Без себестоимости', qty: 1, price: 1000, category: 'Книги' }],
  },
  { id: '3', kind: 'sale', at: at('2026-11-03'), total: 10, delivery: 0, items: [{ sku: 'A1', qty: 1, price: 10 }] },
  { id: '4', kind: 'cancel', at: at('2026-11-04'), total: 2000, items: [{ sku: 'A1', qty: 1, price: 2000, category: 'Книги' }] },
];

const settings = finance.normalizeSettings({ commissionPct: 10, taxPct: 3, taxBase: 'revenue' });
const bounds = periods.rangeBounds('2026-11-01', '2026-11-30');

test('finance summary: revenue, costs, coverage, cancellations, tax on revenue', () => {
  const { lines, excluded } = finance.explodeLines(orders, catalog, settings);
  assert.equal(excluded, 1, '10 ₸ test orders are excluded');
  const saleLines = lines.filter((line) => line.kind === 'sale');
  const cancelLines = lines.filter((line) => line.kind !== 'sale');
  const expenses = [{ month: '2026-11', category: 'Реклама', amount: 3000 }];
  const { summary } = finance.summarize({
    saleLines, cancelLines, expenses, settings, bounds, from: '2026-11-01', to: '2026-11-30', filters: {},
  });
  assert.equal(summary.revenue, 4000);
  assert.equal(summary.orders, 2);
  assert.equal(summary.units, 4);
  assert.equal(summary.avgCheck, 2000);
  assert.equal(summary.cogs, 2000);
  close(summary.commission, 400);
  close(summary.delivery, 449);
  close(summary.tax, 120);
  close(summary.otherExpenses, 3000);
  assert.equal(summary.coverage, 75);
  assert.equal(summary.partial, true);
  // Covered part: revenue 3000, cogs 2000, commission 300, delivery 300, tax 90, other 3000.
  close(summary.grossProfit, 1000);
  close(summary.netProfit, 1000 - 300 - 300 - 3000 - 90);
  close(summary.roi, ((1000 - 300 - 300 - 3000 - 90) / 2000) * 100);
  assert.equal(summary.cancelOrders, 1);
  assert.equal(summary.cancelAmount, 2000);
  close(summary.cancelRate, (1 / 3) * 100);
});

test('finance: tax on profit, delivery fallback percent, warehouse filter share', () => {
  const custom = finance.normalizeSettings({ commissionPct: 0, taxPct: 10, taxBase: 'profit', deliveryFallback: 'percent', deliveryPct: 5 });
  const { lines } = finance.explodeLines(orders, catalog, custom);
  const saleLines = lines.filter((line) => line.kind === 'sale');
  const all = finance.summarize({ saleLines, cancelLines: [], expenses: [], settings: custom, bounds, from: '2026-11-01', to: '2026-11-30', filters: {} });
  close(all.summary.delivery, 300 + 50, 1e-9); // tariff order -> 5% of 1000
  close(all.summary.tax, (3000 - 2000 - 300) * 0.1);

  const expenses = [{ month: '2026-11', category: 'Аренда', amount: 4000 }];
  const unfiltered = finance.summarize({ saleLines, cancelLines: [], expenses, settings: custom, bounds, from: '2026-11-01', to: '2026-11-30', filters: {} });
  const kurdai = finance.summarize({
    saleLines, cancelLines: [], expenses, settings: custom, bounds, from: '2026-11-01', to: '2026-11-30',
    filters: { warehouse: 'Курдай' }, totalRevenueUnfiltered: unfiltered.summary.revenue,
  });
  assert.equal(kurdai.summary.revenue, 1000);
  close(kurdai.summary.otherExpenses, 1000, 1e-9); // 25% of revenue -> 25% of rent
});

test('expenses are prorated by days of the month', () => {
  const allocation = finance.allocateExpenses([{ month: '2026-11', category: 'Аренда', amount: 30000 }], '2026-11-01', '2026-11-21');
  close(allocation.total, 21000);
  assert.equal(finance.allocateExpenses([{ month: '2026-10', amount: 100 }], '2026-11-01', '2026-11-21').total, 0);
});

test('compare and P&L', () => {
  const delta = finance.compare({ revenue: 120, margin: 10 }, { revenue: 100, margin: 0 });
  assert.deepEqual(delta.revenue, { abs: 20, pct: 20, base: 100 });
  assert.equal(delta.margin.pct, null);

  const { lines } = finance.explodeLines(orders, catalog, settings);
  const sales = lines.filter((line) => line.kind === 'sale');
  const pnl = finance.profitAndLoss({
    sales,
    period: { from: '2026-10-15', to: '2026-11-21' },
    expenses: [{ month: '2026-11', category: 'Реклама', amount: 3000 }],
    settings,
  });
  assert.deepEqual(pnl.columns.map((c) => c.key), ['2026-10', '2026-11']);
  const revenue = pnl.rows.find((row) => row.key === 'revenue');
  assert.deepEqual(revenue.values, [0, 4000]);
  const ads = pnl.rows.find((row) => row.key === 'exp:Реклама');
  close(ads.values[1], -3000 * 21 / 30);
  assert.ok(pnl.rows.find((row) => row.key === 'netProfit'));
});

test('series sums to the summary', () => {
  const { lines } = finance.explodeLines(orders, catalog, settings);
  const sales = lines.filter((line) => line.kind === 'sale');
  const period = { from: '2026-11-01', to: '2026-11-21', granularity: 'day' };
  const rows = finance.series({ sales, cancels: [], period, settings, otherTotal: 0 });
  assert.equal(rows.length, 21);
  assert.equal(rows.reduce((sum, row) => sum + row.revenue, 0), 4000);
  assert.equal(rows[1].orders, 1);
});

test('customer data is masked', () => {
  const masked = maskCustomer({ id: '123', firstName: 'Айгерим', lastName: 'Секретная', cellPhone: '77011234567' });
  assert.equal(masked.label, 'Айгерим …4567');
  assert.equal(masked.id.length, 16);
  assert.ok(!JSON.stringify(masked).includes('Секретная'));
});
