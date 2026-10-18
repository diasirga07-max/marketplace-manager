'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const ALMATY_OFFSET_MS = 5 * 60 * 60 * 1000;
const DEFAULT_TAX_RATE = 0.03;
const DEFAULT_KASPI_RATE = 0.125;

const SKU_HEADER_ALIASES = new Set([
  'артикул',
  'артикул wb',
  'артикул kaspi',
  'sku',
  'код товара',
  // The live sheet currently contains this verified, corrupted header in A1.
  // Keeping it explicit is safer than silently falling back to a column index.
  'ч',
]);

const NAME_HEADER_ALIASES = new Set(['название', 'наименование', 'товар']);
const COST_HEADER_ALIASES = new Set([
  'цена оптовая',
  'оптовая цена',
  'закупочная цена',
  'себестоимость',
]);

function normalizeHeader(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u0009-\u000d]/g, ' ')
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f\u200b-\u200f\u2060\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('ru-RU');
}

function normalizeSku(value) {
  if (value == null) return '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value) ? String(value) : String(value).toUpperCase();
  }

  return String(value)
    .normalize('NFKC')
    .replace(/[\u0009-\u000d]/g, ' ')
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f\u200b-\u200f\u2060\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function parseMoneyKz(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;

  let text = String(value)
    .normalize('NFKC')
    .trim()
    .replace(/[\s\u00a0\u202f']/g, '')
    .replace(/(?:KZT|₸|ТГ)/giu, '')
    .replace(/[^0-9.,+\-]/g, '');

  if (!text || !/[0-9]/.test(text)) return null;

  const sign = text.startsWith('-') ? '-' : '';
  text = text.replace(/[+\-]/g, '');
  if (!text) return null;

  const comma = text.lastIndexOf(',');
  const dot = text.lastIndexOf('.');

  if (comma >= 0 && dot >= 0) {
    const decimalSeparator = comma > dot ? ',' : '.';
    const groupingSeparator = decimalSeparator === ',' ? '.' : ',';
    text = text.split(groupingSeparator).join('');
    const decimalIndex = text.lastIndexOf(decimalSeparator);
    text = `${text.slice(0, decimalIndex).split(decimalSeparator).join('')}.${text.slice(decimalIndex + 1)}`;
  } else if (comma >= 0) {
    if (/^\d{1,3}(,\d{3})+$/.test(text)) text = text.replace(/,/g, '');
    else {
      const decimalIndex = text.lastIndexOf(',');
      text = `${text.slice(0, decimalIndex).replace(/,/g, '')}.${text.slice(decimalIndex + 1)}`;
    }
  } else if (dot >= 0) {
    // In the Kazakhstan/de_DE-formatted sheet, 1.500 means 1 500.
    if (/^\d{1,3}(\.\d{3})+$/.test(text)) text = text.replace(/\./g, '');
    else {
      const decimalIndex = text.lastIndexOf('.');
      text = `${text.slice(0, decimalIndex).replace(/\./g, '')}.${text.slice(decimalIndex + 1)}`;
    }
  }

  const number = Number(sign + text);
  return Number.isFinite(number) ? number : null;
}

function findHeaderIndex(normalizedHeaders, aliases) {
  return normalizedHeaders.findIndex((header) => aliases.has(header));
}

function looksLikeSkuColumn(sampleRows, index) {
  if (!Array.isArray(sampleRows) || index < 0) return false;
  const samples = sampleRows
    .slice(0, 100)
    .map((row) => normalizeSku(Array.isArray(row) ? row[index] : ''))
    .filter(Boolean);
  if (samples.length < 5) return false;
  const uniqueRatio = new Set(samples).size / samples.length;
  const skuLikeRatio = samples.filter((value) => /[A-ZА-ЯЁ0-9]/u.test(value)).length / samples.length;
  return uniqueRatio >= 0.8 && skuLikeRatio >= 0.9;
}

function resolveCatalogColumns(headers, sampleRows = []) {
  const originalHeaders = Array.isArray(headers) ? headers.map((value) => String(value ?? '').trim()) : [];
  const normalizedHeaders = originalHeaders.map(normalizeHeader);
  const warnings = [];

  const skuIndex = findHeaderIndex(normalizedHeaders, SKU_HEADER_ALIASES);
  const costIndex = findHeaderIndex(normalizedHeaders, COST_HEADER_ALIASES);
  const nameIndex = findHeaderIndex(normalizedHeaders, NAME_HEADER_ALIASES);
  const photoIndex = normalizedHeaders.findIndex((header) =>
    ['_photo_url_for_print', 'фото', 'ссылка на фото'].includes(header),
  );
  const wbUrlIndex = normalizedHeaders.findIndex((header) =>
    ['вб ссылка', 'wb ссылка', 'ссылка wb', 'wildberries ссылка'].includes(header),
  );

  if (skuIndex < 0) {
    throw new Error('В листе «Прайс KASPI» не найден заголовок артикула');
  }
  if (costIndex < 0) {
    throw new Error('В листе «Прайс KASPI» не найден заголовок «Цена оптовая»');
  }

  const skuHeader = originalHeaders[skuIndex] || '';
  const skuFallback = normalizeHeader(skuHeader) === 'ч';
  if (skuFallback) {
    if (!looksLikeSkuColumn(sampleRows, skuIndex)) {
      throw new Error('Повреждённый заголовок артикула «ч» найден, но содержимое столбца не похоже на SKU');
    }
    warnings.push('Заголовок SKU в Прайс KASPI повреждён («ч»); применена проверенная схема этого листа');
  }

  return {
    skuIndex,
    costIndex,
    nameIndex,
    photoIndex,
    wbUrlIndex,
    skuHeader,
    costHeader: originalHeaders[costIndex] || '',
    skuFallback,
    warnings,
  };
}

function buildCatalog(inputRows) {
  if (!Array.isArray(inputRows) || inputRows.length === 0) {
    throw new Error('Лист «Прайс KASPI» пуст');
  }

  const [headers, ...rows] = inputRows;
  const schema = resolveCatalogColumns(headers, rows);
  const bySku = new Map();
  const duplicateKeys = new Set();
  const duplicates = [];
  let missingCosts = 0;
  let invalidCosts = 0;
  let sourceRows = 0;

  rows.forEach((row, offset) => {
    if (!Array.isArray(row)) return;
    const rawSku = row[schema.skuIndex];
    const normalizedSku = normalizeSku(rawSku);
    if (!normalizedSku) return;
    sourceRows += 1;

    const rawCost = row[schema.costIndex];
    const cost = parseMoneyKz(rawCost);
    if (rawCost == null || String(rawCost).trim() === '') missingCosts += 1;
    else if (cost == null || cost < 0) invalidCosts += 1;

    const record = {
      sku: String(rawSku ?? '').trim(),
      normalizedSku,
      name: schema.nameIndex >= 0 ? String(row[schema.nameIndex] ?? '').trim() : '',
      wholesale: cost != null && cost >= 0 ? cost : null,
      cost: cost != null && cost >= 0 ? cost : null,
      photo: schema.photoIndex >= 0 ? String(row[schema.photoIndex] ?? '').trim() : '',
      wbUrl: schema.wbUrlIndex >= 0 ? String(row[schema.wbUrlIndex] ?? '').trim() : '',
      sourceRow: offset + 2,
    };

    if (bySku.has(normalizedSku)) {
      const first = bySku.get(normalizedSku);
      duplicateKeys.add(normalizedSku);
      duplicates.push({
        sku: normalizedSku,
        rows: [first.sourceRow, record.sourceRow],
        conflictingCost: first.wholesale !== record.wholesale,
      });
      return;
    }
    bySku.set(normalizedSku, record);
  });

  // A normalized duplicate is ambiguous even if both rows currently have the same cost.
  // Excluding it avoids silently combining distinct products after normalization.
  for (const key of duplicateKeys) bySku.delete(key);

  return {
    bySku,
    rows: bySku.size,
    sourceRows,
    duplicates,
    duplicateCount: duplicateKeys.size,
    missingCosts,
    invalidCosts,
    schema,
    warnings: [...schema.warnings],
  };
}

function datePartsInAlmaty(ms) {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Almaty',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date(ms))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
}

function almatyDateIso(ms = Date.now()) {
  const parts = datePartsInAlmaty(ms);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function almatyDayStart(iso) {
  const match = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const localUtc = Date.UTC(year, month - 1, day);
  const check = new Date(localUtc);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return localUtc - ALMATY_OFFSET_MS;
}

function salesRange(from = '', to = '', now = Date.now()) {
  const today = almatyDateIso(now);
  const normalizedFrom = from || today;
  const normalizedTo = to || normalizedFrom;
  const start = almatyDayStart(normalizedFrom);
  const endStart = almatyDayStart(normalizedTo);
  if (start == null || endStart == null) throw new Error('Неверный формат даты');
  if (endStart < start) throw new Error('Дата «С» не может быть позже даты «По»');

  const days = Math.floor((endStart - start) / DAY_MS) + 1;
  if (days > 366) throw new Error('Максимальный период — 366 дней');

  return {
    from: normalizedFrom,
    to: normalizedTo,
    days,
    ge: start,
    le: Math.min(endStart + DAY_MS - 1, now),
    queryFrom: start - 45 * DAY_MS,
    queryTo: Math.min(endStart + DAY_MS - 1, now),
  };
}

function clampNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function allocationWeights(items) {
  const revenueTotal = items.reduce((sum, item) => sum + clampNonNegative(item.totalPrice), 0);
  if (revenueTotal > 0) {
    return items.map((item) => clampNonNegative(item.totalPrice) / revenueTotal);
  }
  const quantityTotal = items.reduce((sum, item) => sum + clampNonNegative(item.quantity), 0);
  if (quantityTotal > 0) {
    return items.map((item) => clampNonNegative(item.quantity) / quantityTotal);
  }
  return items.map(() => (items.length ? 1 / items.length : 0));
}

function catalogLookup(catalog, sku) {
  const map = catalog instanceof Map ? catalog : catalog && catalog.bySku;
  if (!(map instanceof Map)) return null;
  return map.get(normalizeSku(sku)) || null;
}

function completionDateIso(ms) {
  return almatyDateIso(ms);
}

function aggregateSales(orders, catalog, options = {}) {
  const taxRate = Number.isFinite(options.taxRate) ? options.taxRate : DEFAULT_TAX_RATE;
  const kaspiRate = Number.isFinite(options.kaspiRate) ? options.kaspiRate : DEFAULT_KASPI_RATE;
  const uniqueOrders = new Map();
  let duplicateOrders = 0;
  let excludedOrders = 0;
  let unresolvedOrders = 0;

  for (const order of Array.isArray(orders) ? orders : []) {
    const status = String(order && order.status ? order.status : 'COMPLETED').toUpperCase();
    if (status !== 'COMPLETED') {
      excludedOrders += 1;
      continue;
    }
    const completionDate = Number(order && order.completionDate);
    if (!Number.isFinite(completionDate) || completionDate <= 0) {
      unresolvedOrders += 1;
      continue;
    }
    const code = String(order.code || '').trim();
    const id = String(order.id || '').trim();
    const key = code ? `code:${code}` : id ? `id:${id}` : '';
    if (!key) {
      unresolvedOrders += 1;
      continue;
    }
    if (uniqueOrders.has(key)) {
      duplicateOrders += 1;
      continue;
    }
    uniqueOrders.set(key, order);
  }

  const summary = {
    orders: 0,
    units: 0,
    sales: 0,
    cogs: 0,
    knownCostUnits: 0,
    missingCostUnits: 0,
    missingProfit: 0,
    delivery: 0,
    tax: 0,
    kaspi: 0,
    extraExpenses: 0,
    confirmedProfit: 0,
    profit: null,
    profitComplete: false,
    taxRate,
    kaspiRate,
    duplicateOrders,
    excludedOrders,
    unresolvedOrders,
  };

  const topMap = new Map();
  const dailyMap = new Map();
  const processedOrders = [];

  for (const order of uniqueOrders.values()) {
    const sourceItems = Array.isArray(order.items) ? order.items : [];
    const weights = allocationWeights(sourceItems);
    const orderSales = clampNonNegative(order.totalPrice) ||
      sourceItems.reduce((sum, item) => sum + clampNonNegative(item.totalPrice), 0);
    const delivery = clampNonNegative(order.delivery);
    const extraExpenses = clampNonNegative(
      order.extraExpenses == null ? order.additionalExpenses : order.extraExpenses,
    );
    const processedItems = [];

    if (sourceItems.length === 0) {
      const date = completionDateIso(Number(order.completionDate));
      const tax = orderSales * taxRate;
      const kaspi = orderSales * kaspiRate;
      summary.orders += 1;
      summary.sales += orderSales;
      summary.delivery += delivery;
      summary.tax += tax;
      summary.kaspi += kaspi;
      summary.extraExpenses += extraExpenses;
      summary.unresolvedOrders += 1;

      const daily = dailyMap.get(date) || {
        date,
        orders: 0,
        units: 0,
        sales: 0,
        cogs: 0,
        delivery: 0,
        tax: 0,
        kaspi: 0,
        extraExpenses: 0,
        knownCostUnits: 0,
        missingCostUnits: 0,
        missingProfit: 0,
        confirmedProfit: 0,
        profit: null,
        profitComplete: false,
        unresolvedOrders: 0,
      };
      daily.orders += 1;
      daily.sales += orderSales;
      daily.delivery += delivery;
      daily.tax += tax;
      daily.kaspi += kaspi;
      daily.extraExpenses += extraExpenses;
      daily.unresolvedOrders = (daily.unresolvedOrders || 0) + 1;
      daily.profit = null;
      daily.profitComplete = false;
      dailyMap.set(date, daily);
      processedOrders.push({
        ...order,
        status: 'COMPLETED',
        totalPrice: orderSales,
        delivery,
        extraExpenses,
        items: [],
        unresolved: true,
      });
      continue;
    }

    sourceItems.forEach((item, index) => {
      const quantity = clampNonNegative(item.quantity);
      const rawLineSales = clampNonNegative(item.totalPrice);
      const lineSales = orderSales > 0 ? orderSales * weights[index] : rawLineSales;
      const record = catalogLookup(catalog, item.sku);
      const wholesale = record && Number.isFinite(record.wholesale) ? record.wholesale : null;
      const cogs = wholesale == null ? null : wholesale * quantity;
      const itemDelivery = delivery * weights[index];
      const itemExtraExpenses = extraExpenses * weights[index];
      const tax = lineSales * taxRate;
      const kaspi = lineSales * kaspiRate;
      const profit = cogs == null
        ? null
        : lineSales - cogs - itemDelivery - kaspi - tax - itemExtraExpenses;

      const normalizedSku = normalizeSku(item.sku);
      const outputItem = {
        ...item,
        sku: String(item.sku || record?.sku || '').trim(),
        name: record?.name || String(item.name || '').trim(),
        quantity,
        totalPrice: lineSales,
        wholesale,
        cogs,
        delivery: itemDelivery,
        tax,
        kaspi,
        extraExpenses: itemExtraExpenses,
        profit,
        confirmedProfit: profit == null ? 0 : profit,
        missingCostUnits: profit == null ? quantity : 0,
        missingProfit: profit == null ? quantity : 0,
      };
      processedItems.push(outputItem);

      summary.units += quantity;
      summary.tax += tax;
      summary.kaspi += kaspi;
      if (cogs == null) {
        summary.missingCostUnits += quantity;
      } else {
        summary.cogs += cogs;
        summary.knownCostUnits += quantity;
        summary.confirmedProfit += profit;
      }

      const topKey = normalizedSku || `name:${String(outputItem.name).toUpperCase()}`;
      const top = topMap.get(topKey) || {
        sku: outputItem.sku,
        name: outputItem.name,
        quantity: 0,
        sales: 0,
        cogs: 0,
        delivery: 0,
        tax: 0,
        kaspi: 0,
        extraExpenses: 0,
        confirmedProfit: 0,
        profit: null,
        missingCostUnits: 0,
        missingProfit: 0,
      };
      top.quantity += quantity;
      top.sales += lineSales;
      top.delivery += itemDelivery;
      top.tax += tax;
      top.kaspi += kaspi;
      top.extraExpenses += itemExtraExpenses;
      if (cogs == null) {
        top.missingCostUnits += quantity;
        top.missingProfit += quantity;
      } else {
        top.cogs += cogs;
        top.confirmedProfit += profit;
      }
      top.profit = top.missingCostUnits > 0 ? null : top.confirmedProfit;
      topMap.set(topKey, top);
    });

    summary.orders += 1;
    summary.sales += orderSales;
    summary.delivery += delivery;
    summary.extraExpenses += extraExpenses;

    const date = completionDateIso(Number(order.completionDate));
    const daily = dailyMap.get(date) || {
      date,
      orders: 0,
      units: 0,
      sales: 0,
      cogs: 0,
      delivery: 0,
      tax: 0,
      kaspi: 0,
      extraExpenses: 0,
      knownCostUnits: 0,
      missingCostUnits: 0,
      missingProfit: 0,
      confirmedProfit: 0,
      profit: null,
      profitComplete: false,
      unresolvedOrders: 0,
    };
    daily.orders += 1;
    daily.sales += orderSales;
    daily.delivery += delivery;
    daily.extraExpenses += extraExpenses;
    for (const item of processedItems) {
      daily.units += item.quantity;
      daily.tax += item.tax;
      daily.kaspi += item.kaspi;
      if (item.cogs == null) {
        daily.missingCostUnits += item.quantity;
        daily.missingProfit += item.quantity;
      } else {
        daily.cogs += item.cogs;
        daily.knownCostUnits += item.quantity;
        daily.confirmedProfit += item.profit;
      }
    }
    daily.profitComplete = daily.missingCostUnits === 0 && (daily.unresolvedOrders || 0) === 0;
    daily.profit = daily.profitComplete ? daily.confirmedProfit : null;
    dailyMap.set(date, daily);

    processedOrders.push({
      ...order,
      status: 'COMPLETED',
      totalPrice: orderSales,
      delivery,
      extraExpenses,
      items: processedItems,
    });
  }

  summary.missingProfit = summary.missingCostUnits;
  summary.profitComplete = summary.missingCostUnits === 0 && summary.unresolvedOrders === 0;
  summary.profit = summary.profitComplete ? summary.confirmedProfit : null;

  return {
    summary,
    top: [...topMap.values()]
      .sort((a, b) => b.quantity - a.quantity || b.sales - a.sales)
      .slice(0, 100),
    daily: [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
    orders: processedOrders,
  };
}

module.exports = {
  ALMATY_OFFSET_MS,
  DAY_MS,
  DEFAULT_KASPI_RATE,
  DEFAULT_TAX_RATE,
  aggregateSales,
  almatyDateIso,
  almatyDayStart,
  buildCatalog,
  normalizeHeader,
  normalizeSku,
  parseMoneyKz,
  resolveCatalogColumns,
  salesRange,
};
