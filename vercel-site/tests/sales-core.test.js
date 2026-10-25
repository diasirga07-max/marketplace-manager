'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  aggregateSales,
  buildCatalog,
  normalizeSku,
  parseMoneyKz,
  resolveCatalogColumns,
  salesRange,
} = require('../lib/sales-core');

const COMPLETED_AT = Date.parse('2026-10-17T12:00:00+05:00');

function closeTo(actual, expected, epsilon = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}

function skuSamples(columnIndex, count = 6) {
  return Array.from({ length: count }, (_, index) => {
    const row = ['Товар', '1 500 ₸', ''];
    row[columnIndex] = `SKU-${index + 1}`;
    return row;
  });
}

test('normalizeSku normalizes surrounding whitespace, case, and numeric cell types', () => {
  assert.equal(normalizeSku('\u00a0 kitapent00082\t'), 'KITAPENT00082');
  assert.equal(normalizeSku(12345), '12345');
  assert.equal(normalizeSku('00123'), '00123');
  assert.equal(normalizeSku('  ab   12  '), 'AB 12');
  assert.equal(normalizeSku(null), '');
});

test('normalizeSku preserves meaningful separators so distinct SKUs are not merged', () => {
  assert.notEqual(normalizeSku('AB 12'), normalizeSku('AB12'));
  assert.notEqual(normalizeSku('AB-12'), normalizeSku('AB12'));
});

test('parseMoneyKz handles Kazakhstan and de_DE sheet formats without inventing zeroes', () => {
  assert.equal(parseMoneyKz('1.500'), 1500);
  assert.equal(parseMoneyKz('1 500'), 1500);
  assert.equal(parseMoneyKz('1500'), 1500);
  assert.equal(parseMoneyKz('1 500 ₸'), 1500);
  assert.equal(parseMoneyKz('1\u202f500,50 ₸'), 1500.5);
  assert.equal(parseMoneyKz('1.500,75'), 1500.75);
  assert.equal(parseMoneyKz('1500.5'), 1500.5);
  assert.equal(parseMoneyKz(0), 0);
  assert.equal(parseMoneyKz('0 ₸'), 0);
  assert.equal(parseMoneyKz(''), null);
  assert.equal(parseMoneyKz('   '), null);
  assert.equal(parseMoneyKz('Не найдено'), null);
  assert.equal(parseMoneyKz(null), null);
});

test('resolveCatalogColumns follows headers in any order and validates the live corrupt SKU header', () => {
  const headers = ['Название', 'Цена оптовая', 'ч', '_PHOTO_URL_FOR_PRINT', 'ВБ ссылка'];
  const rows = skuSamples(2);
  const schema = resolveCatalogColumns(headers, rows);

  assert.equal(schema.skuIndex, 2);
  assert.equal(schema.costIndex, 1);
  assert.equal(schema.nameIndex, 0);
  assert.equal(schema.photoIndex, 3);
  assert.equal(schema.wbUrlIndex, 4);
  assert.equal(schema.skuHeader, 'ч');
  assert.equal(schema.skuFallback, true);
  assert.ok(schema.warnings.some((warning) => warning.includes('повреждён')));

  assert.throws(
    () => resolveCatalogColumns(['Название', 'Цена оптовая', 'неизвестно'], rows),
    /заголовок артикула/i,
  );
  assert.throws(
    () => resolveCatalogColumns(['Артикул WB', 'Название'], rows),
    /Цена оптовая/i,
  );
});

test('buildCatalog reads KITAPENT00082 cost from Цена оптовая and tracks missing values', () => {
  const catalog = buildCatalog([
    ['Название', 'Моя чистая прибыль (₸) [расчет]', 'Цена оптовая', 'ч'],
    ['Бакынов физика', '999 999 ₸', '1 500 ₸', ' KITAPENT00082 '],
    ['Числовой SKU', '999 999 ₸', '2.000', 12345],
    ['С пробелом', '999 999 ₸', '100', 'AB 12'],
    ['Без пробела', '999 999 ₸', '200', 'AB12'],
    ['Без себестоимости', '999 999 ₸', '', 'MISSING-COST'],
    ['Некорректная себестоимость', '999 999 ₸', 'Не найдено', 'INVALID-COST'],
  ]);

  const kitapent = catalog.bySku.get('KITAPENT00082');
  assert.ok(kitapent);
  assert.equal(kitapent.cost, 1500);
  assert.equal(kitapent.wholesale, 1500);
  assert.notEqual(kitapent.cost, 999999, 'calculated profit column must not be used as cost');
  assert.equal(catalog.bySku.get('12345').cost, 2000);
  assert.equal(catalog.bySku.get('AB 12').cost, 100);
  assert.equal(catalog.bySku.get('AB12').cost, 200);
  assert.equal(catalog.bySku.get('MISSING-COST').cost, null);
  assert.equal(catalog.bySku.get('INVALID-COST').cost, null);
  assert.equal(catalog.missingCosts, 1);
  assert.equal(catalog.invalidCosts, 1);
  assert.equal(catalog.schema.skuFallback, true);
});

test('buildCatalog rejects ambiguous normalized duplicates instead of silently merging products', () => {
  const catalog = buildCatalog([
    ['Артикул WB', 'Название', 'Цена оптовая'],
    ['SKU-1', 'Первый', '1 000'],
    [' sku-1 ', 'Второй', '1 200'],
    ['AB 12', 'С пробелом', '100'],
    ['AB12', 'Без пробела', '200'],
  ]);

  assert.equal(catalog.duplicateCount, 1);
  assert.equal(catalog.duplicates.length, 1);
  assert.equal(catalog.duplicates[0].sku, 'SKU-1');
  assert.equal(catalog.duplicates[0].conflictingCost, true);
  assert.equal(catalog.bySku.has('SKU-1'), false);
  assert.equal(catalog.bySku.has('AB 12'), true);
  assert.equal(catalog.bySku.has('AB12'), true);
});

test('aggregateSales multiplies KITAPENT00082 cost by sold quantity', () => {
  const catalog = {
    bySku: new Map([
      ['KITAPENT00082', { sku: 'KITAPENT00082', name: 'Бакынов физика', cost: 1500, wholesale: 1500 }],
    ]),
  };
  const result = aggregateSales([
    {
      id: 'one-order',
      code: 'ORDER-1',
      status: 'COMPLETED',
      completionDate: COMPLETED_AT,
      totalPrice: 5000,
      delivery: 400,
      additionalExpenses: 100,
      items: [{ sku: ' kitapent00082 ', quantity: 2, totalPrice: 5000 }],
    },
  ], catalog);

  assert.equal(result.summary.orders, 1);
  assert.equal(result.summary.units, 2);
  assert.equal(result.summary.cogs, 3000);
  assert.equal(result.summary.knownCostUnits, 2);
  assert.equal(result.summary.missingCostUnits, 0);
  assert.equal(result.summary.sales, 5000);
  assert.equal(result.summary.delivery, 400);
  assert.equal(result.summary.extraExpenses, 100);
  assert.equal(result.summary.tax, 150);
  assert.equal(result.summary.kaspi, 625);
  assert.equal(result.summary.confirmedProfit, 725);
  assert.equal(result.summary.profit, 725);
  assert.equal(result.summary.profitComplete, true);
  assert.equal(result.top[0].cogs, 3000);
  assert.equal(result.top[0].profit, 725);
});

test('aggregateSales totals multiple SKUs and excludes duplicate, cancelled, and unfinished orders', () => {
  const catalog = {
    bySku: new Map([
      ['SKU-A', { sku: 'SKU-A', name: 'A', cost: 1000, wholesale: 1000 }],
      ['SKU-B', { sku: 'SKU-B', name: 'B', cost: 2000, wholesale: 2000 }],
    ]),
  };
  const first = {
    id: 'id-1',
    code: 'ORDER-1',
    status: 'COMPLETED',
    completionDate: COMPLETED_AT,
    totalPrice: 5000,
    delivery: 500,
    items: [
      { sku: 'SKU-A', quantity: 2, totalPrice: 3000 },
      { sku: 'SKU-B', quantity: 1, totalPrice: 2000 },
    ],
  };
  const result = aggregateSales([
    first,
    { ...first, id: 'same-code-under-another-id' },
    { ...first },
    {
      id: 'id-cancelled',
      code: 'ORDER-CANCELLED',
      status: 'CANCELLED',
      completionDate: COMPLETED_AT,
      totalPrice: 50000,
      items: [{ sku: 'SKU-A', quantity: 50, totalPrice: 50000 }],
    },
    {
      id: 'id-unfinished',
      code: 'ORDER-ASSEMBLE',
      status: 'ASSEMBLE',
      completionDate: COMPLETED_AT,
      totalPrice: 50000,
      items: [{ sku: 'SKU-A', quantity: 50, totalPrice: 50000 }],
    },
    {
      id: 'id-2',
      code: 'ORDER-2',
      status: 'COMPLETED',
      completionDate: COMPLETED_AT,
      totalPrice: 6000,
      delivery: 300,
      extraExpenses: 200,
      items: [{ sku: 'SKU-B', quantity: 2, totalPrice: 6000 }],
    },
  ], catalog);

  assert.equal(result.summary.orders, 2);
  assert.equal(result.summary.duplicateOrders, 2);
  assert.equal(result.summary.excludedOrders, 2);
  assert.equal(result.summary.units, 5);
  assert.equal(result.summary.sales, 11000);
  assert.equal(result.summary.cogs, 8000);
  assert.equal(result.summary.delivery, 800);
  assert.equal(result.summary.extraExpenses, 200);
  assert.equal(result.summary.tax, 330);
  assert.equal(result.summary.kaspi, 1375);
  assert.equal(result.summary.profit, 295);
  assert.equal(result.summary.profitComplete, true);
});

test('aggregateSales reports partial profit explicitly when a cost is missing', () => {
  const catalog = {
    bySku: new Map([
      ['KNOWN', { sku: 'KNOWN', name: 'Known', cost: 1500, wholesale: 1500 }],
    ]),
  };
  const result = aggregateSales([
    {
      id: 'partial-order',
      code: 'PARTIAL-1',
      status: 'COMPLETED',
      completionDate: COMPLETED_AT,
      totalPrice: 10000,
      delivery: 1000,
      extraExpenses: 500,
      items: [
        { sku: 'KNOWN', quantity: 2, totalPrice: 6000 },
        { sku: 'MISSING', quantity: 1, totalPrice: 4000 },
      ],
    },
  ], catalog);

  assert.equal(result.summary.units, 3);
  assert.equal(result.summary.knownCostUnits, 2);
  assert.equal(result.summary.missingCostUnits, 1);
  assert.equal(result.summary.missingProfit, 1);
  assert.equal(result.summary.cogs, 3000);
  closeTo(result.summary.confirmedProfit, 1170);
  assert.equal(result.summary.profit, null);
  assert.equal(result.summary.profitComplete, false);

  const missing = result.top.find((row) => row.sku === 'MISSING');
  assert.ok(missing);
  assert.equal(missing.profit, null);
  assert.equal(missing.missingCostUnits, 1);
});

test('aggregateSales never reports false zero profit when completed order items are unavailable', () => {
  const result = aggregateSales([
    {
      id: 'completed-without-items',
      code: 'NO-ITEMS-1',
      status: 'COMPLETED',
      completionDate: COMPLETED_AT,
      totalPrice: 5000,
      delivery: 400,
      items: [],
    },
  ], { bySku: new Map() });

  assert.equal(result.summary.orders, 1, 'the completed order remains visible');
  assert.equal(result.summary.sales, 5000, 'known revenue remains visible');
  assert.equal(result.summary.delivery, 400);
  assert.equal(result.summary.tax, 150);
  assert.equal(result.summary.kaspi, 625);
  assert.equal(result.summary.unresolvedOrders, 1);
  assert.equal(result.summary.confirmedProfit, 0);
  assert.equal(result.summary.profit, null, 'unknown COGS must not become zero profit');
  assert.equal(result.summary.profitComplete, false);

  assert.equal(result.orders[0].unresolved, true);
  assert.equal(result.daily[0].unresolvedOrders, 1);
  assert.equal(result.daily[0].profit, null);
  assert.equal(result.daily[0].profitComplete, false);
});

test('salesRange uses Kazakhstan UTC+5 day boundaries and defaults to the local date', () => {
  const afterDay = Date.parse('2026-10-18T00:00:00Z');
  const range = salesRange('2026-10-17', '2026-10-17', afterDay);

  assert.equal(range.from, '2026-10-17');
  assert.equal(range.to, '2026-10-17');
  assert.equal(range.days, 1);
  assert.equal(range.ge, Date.parse('2026-10-16T19:00:00.000Z'));
  assert.equal(range.le, Date.parse('2026-10-17T18:59:59.999Z'));

  const beforeMidnight = salesRange('', '', Date.parse('2026-10-17T18:30:00.000Z'));
  assert.equal(beforeMidnight.from, '2026-10-17');
  assert.equal(beforeMidnight.to, '2026-10-17');

  const afterMidnight = salesRange('', '', Date.parse('2026-10-17T19:30:00.000Z'));
  assert.equal(afterMidnight.from, '2026-10-18');
  assert.equal(afterMidnight.to, '2026-10-18');
});

test('salesRange rejects invalid, reversed, and overlong ranges', () => {
  const now = Date.parse('2027-12-31T00:00:00Z');
  assert.throws(() => salesRange('2026-02-30', '2026-03-01', now), /Неверный формат даты/);
  assert.throws(() => salesRange('2026-10-18', '2026-10-17', now), /позже даты/);
  assert.throws(() => salesRange('2026-01-01', '2027-01-02', now), /366 дней/);
});

test('test purchases at 10 ₸ are excluded entirely, 11 ₸ stays and 0 ₸ keeps legacy handling', () => {
  const catalog = { bySku: new Map([['GOOD', { sku: 'GOOD', cost: 2, wholesale: 2 }]]) };
  const makeOrder = (id, amount, sku = 'GOOD') => ({
    id, code: id, status: 'COMPLETED', completionDate: COMPLETED_AT,
    totalPrice: amount, delivery: 3, extraExpenses: 1,
    items: [{ sku, quantity: 1, totalPrice: amount }],
  });
  const baseline = aggregateSales([makeOrder('eleven', 11), makeOrder('zero', 0)], catalog);
  const result = aggregateSales([
    makeOrder('ten', 10, 'MISSING'), makeOrder('eleven', 11), makeOrder('zero', 0),
    { ...makeOrder('cancelled', 10), status: 'CANCELLED' },
  ], catalog);
  assert.equal(result.summary.orders, baseline.summary.orders);
  assert.equal(result.summary.units, baseline.summary.units);
  assert.equal(result.summary.sales, baseline.summary.sales);
  assert.equal(result.summary.delivery, baseline.summary.delivery);
  assert.equal(result.summary.tax, baseline.summary.tax);
  assert.equal(result.summary.kaspi, baseline.summary.kaspi);
  assert.equal(result.summary.profit, baseline.summary.profit);
  assert.equal(result.summary.profitComplete, baseline.summary.profitComplete);
  assert.equal(result.summary.missingCostUnits, baseline.summary.missingCostUnits);
  assert.equal(result.summary.excludedTestOrders, 1);
  assert.equal(result.summary.excludedOrders, 1);
  assert.deepEqual(result.top, baseline.top);
  assert.deepEqual(result.daily, baseline.daily);
  assert.deepEqual(result.orders, baseline.orders);
});

test('test order threshold uses item totals when order total is absent, but not when explicitly 0', () => {
  const catalog = { bySku: new Map([['GOOD', { sku: 'GOOD', cost: 1, wholesale: 1 }]]) };
  const base = { status: 'COMPLETED', completionDate: COMPLETED_AT, items: [{ sku: 'GOOD', quantity: 1, totalPrice: 10 }] };
  const result = aggregateSales([
    { ...base, id: 'missing', code: 'missing' },
    { ...base, id: 'explicit-zero', code: 'explicit-zero', totalPrice: 0 },
  ], catalog);
  assert.equal(result.summary.excludedTestOrders, 1);
  assert.equal(result.summary.orders, 1);
});

test('GB_TEST_ORDER_MAX_PRICE overrides the default, invalid values fall back to 10', () => {
  const previous = process.env.GB_TEST_ORDER_MAX_PRICE;
  const catalog = { bySku: new Map() };
  const orders = [
    { id: 'order-11', code: 'order-11', status: 'COMPLETED', completionDate: COMPLETED_AT, totalPrice: 11, items: [] },
    { id: 'order-12', code: 'order-12', status: 'COMPLETED', completionDate: COMPLETED_AT, totalPrice: 12, items: [] },
  ];
  try {
    process.env.GB_TEST_ORDER_MAX_PRICE = '11';
    assert.equal(aggregateSales(orders, catalog).summary.excludedTestOrders, 1);
    process.env.GB_TEST_ORDER_MAX_PRICE = 'invalid';
    assert.equal(aggregateSales(orders, catalog).summary.excludedTestOrders, 0);
    process.env.GB_TEST_ORDER_MAX_PRICE = '';
    assert.equal(aggregateSales(orders, catalog).summary.excludedTestOrders, 0);
  } finally {
    if (previous == null) delete process.env.GB_TEST_ORDER_MAX_PRICE;
    else process.env.GB_TEST_ORDER_MAX_PRICE = previous;
  }
});

test('fresh sales warning reports excluded test orders without changing profit completeness', () => {
  const { __test } = require('../lib/grants-data-service');
  const catalog = { bySku: new Map([['LIVE', { sku: 'LIVE', cost: 2, wholesale: 2 }]]) };
  const normal = {
    id: 'normal', code: 'normal', status: 'COMPLETED', completionDate: COMPLETED_AT,
    totalPrice: 11, items: [{ sku: 'LIVE', quantity: 1, totalPrice: 11 }],
  };
  const testPurchase = {
    id: 'test', code: 'test', status: 'COMPLETED', completionDate: COMPLETED_AT,
    totalPrice: 10, items: [{ sku: 'MISSING', quantity: 1, totalPrice: 10 }],
  };
  const baseline = aggregateSales([normal], catalog);
  const result = aggregateSales([normal, testPurchase], catalog);
  assert.equal(result.summary.excludedTestOrders, 1);
  assert.equal(result.summary.profitComplete, baseline.summary.profitComplete);
  assert.equal(result.summary.missingCostUnits, baseline.summary.missingCostUnits);
  assert.deepEqual(__test.salesWarnings([], result.summary), ['Исключено тестовых заказов (до 10 ₸): 1']);
});

test('orders photo diagnostics count missing photos without exposing customer information', () => {
  const { __test } = require('../lib/grants-data-service');
  assert.equal(__test.rowsWithoutPhotoCount([
    { sku: 'A', photo: '' },
    { sku: 'B', photo: 'https://cdn.example/photo.jpg' },
    { sku: 'C', photo: '  ' },
  ]), 2);
});
