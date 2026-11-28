'use strict';

// Normalization of GET /statistics/sales. The schema is not described in Flip's
// Swagger, so parsing is deliberately tolerant: it finds supplierType, the
// summary object and the items array wherever they are, and keeps every
// numeric summary field. Field names known to mean revenue / quantity are
// listed in REVENUE_KEYS / UNITS_KEYS (refined against real responses).

const { num } = require('./client');

const REVENUE_KEYS = ['revenue', 'salesAmount', 'saleAmount', 'sales', 'amount', 'totalAmount', 'total', 'sum', 'turnover', 'realizationAmount', 'soldAmount'];
const UNITS_KEYS = ['units', 'quantity', 'count', 'soldCount', 'salesCount', 'itemsCount', 'qty'];

// Russian labels for summary fields (unknown keys are shown as is).
const LABELS = {
  revenue: 'Выручка', salesAmount: 'Сумма продаж', saleAmount: 'Сумма продаж', sales: 'Продажи', amount: 'Сумма', totalAmount: 'Итого',
  total: 'Итого', sum: 'Сумма', turnover: 'Оборот', realizationAmount: 'Сумма реализации', soldAmount: 'Продано на сумму',
  units: 'Единиц', quantity: 'Количество', count: 'Количество', soldCount: 'Продано, шт', salesCount: 'Продаж, шт', itemsCount: 'Позиций', qty: 'Количество',
  fee: 'Комиссия Flip', feeAmount: 'Комиссия Flip', commission: 'Комиссия', commissionAmount: 'Комиссия',
  returns: 'Возвраты', returnAmount: 'Сумма возвратов', returnsAmount: 'Сумма возвратов', returnCount: 'Возвратов, шт',
  payout: 'К выплате', payoutAmount: 'К выплате', toPay: 'К выплате', profit: 'Прибыль', purchaseAmount: 'Закупочная сумма',
};

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function root(body) {
  if (isObject(body && body.data)) return body.data;
  if (isObject(body && body.result)) return body.result;
  return isObject(body) ? body : {};
}

function findSupplierType(body) {
  const r = root(body);
  return String(r.supplierType || (body && body.supplierType) || (isObject(r.summary) && r.summary.supplierType) || '') || null;
}

function findSummary(body) {
  const r = root(body);
  if (isObject(r.summary)) return r.summary;
  if (isObject(body && body.summary)) return body.summary;
  if (Array.isArray(r.summary) && isObject(r.summary[0])) return r.summary[0];
  // No dedicated object: treat scalar fields of the root as the summary.
  const out = {};
  for (const [k, v] of Object.entries(r)) if (!isObject(v) && !Array.isArray(v)) out[k] = v;
  return out;
}

function findItems(body) {
  const r = root(body);
  for (const key of ['items', 'operations', 'rows']) {
    if (Array.isArray(r[key])) return r[key];
    if (Array.isArray(body && body[key])) return body[key];
  }
  if (Array.isArray(body && body.data)) return body.data;
  return [];
}

// Flattens nested objects one level: {a:{b:1}} → {'a.b':1}.
function flatten(object, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(object || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isObject(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

function fieldsOf(summary) {
  const flat = flatten(summary);
  return Object.entries(flat)
    .filter(([k]) => k !== 'supplierType')
    .map(([key, value]) => {
      const leaf = key.split('.').pop();
      const n = typeof value === 'number' ? value : (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : null);
      return { key, label: LABELS[leaf] || key, value: n == null ? value : n, kind: n == null ? 'text' : (UNITS_KEYS.includes(leaf) || /count|qty|quantity/i.test(leaf) ? 'count' : 'money') };
    });
}

function pick(flat, keys) {
  for (const key of keys) {
    const hit = Object.keys(flat).find((k) => k.split('.').pop() === key);
    if (hit !== undefined && flat[hit] !== undefined && flat[hit] !== null && flat[hit] !== '') return num(flat[hit]);
  }
  return null;
}

function normalizeSummary(body) {
  const summary = findSummary(body);
  return { supplierType: findSupplierType(body), summary, fields: fieldsOf(summary) };
}

// Revenue and units of one day (omitted fields mean 0).
function dailyTotals(report) {
  const flat = flatten(report.summary || {});
  return { revenue: pick(flat, REVENUE_KEYS) || 0, units: pick(flat, UNITS_KEYS) || 0 };
}

function normalizeItems(body) {
  const rows = findItems(body).filter(isObject).map((row) => flatten(row));
  const columns = [];
  for (const row of rows) for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  const p = (body && body.meta && body.meta.pagination) || {};
  return { rows, columns, pagination: { page: num(p.page) || 1, pages: num(p.pages) || 1, total: num(p.total) || rows.length } };
}

module.exports = { LABELS, dailyTotals, fieldsOf, flatten, normalizeItems, normalizeSummary };
