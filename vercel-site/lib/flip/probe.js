'use strict';

// Diagnostics: calls every Flip method once and returns only the SHAPE of each
// response — keys, value types, array lengths — never the values themselves
// (no names, phones, prices or the key). Used to fit the parser to real data.
// GET /api/flip?op=probe (requires GB_ACCESS_CODE like every non-cron op).

const client = require('./client');
const { almatyDateIso } = require('../sales-core');
const periods = require('../analytics/periods');

const SAFE_STRING_KEYS = new Set(['supplierType', 'type', 'status', 'currency', 'kind', 'operationType']);

function shape(value, key = '', depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (!value.length) return '[] (пусто)';
    // Union of the first few elements' shapes, so optional fields show up.
    const merged = {};
    for (const item of value.slice(0, 20)) {
      const s = shape(item, key, depth + 1);
      if (s && typeof s === 'object') for (const [k, v] of Object.entries(s)) if (!(k in merged)) merged[k] = v;
      else if (!merged['*']) merged['*'] = s;
    }
    return { [`[${value.length}]`]: merged };
  }
  if (typeof value === 'object') {
    if (depth > 6) return 'object (глубже не показано)';
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = shape(v, k, depth + 1);
    return out;
  }
  if (typeof value === 'string') {
    if (SAFE_STRING_KEYS.has(key)) return `string = ${JSON.stringify(value.slice(0, 40))}`;
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return 'string (дата)';
    if (/^-?\d+(\.\d+)?$/.test(value)) return 'string (число)';
    return `string (${value.length} симв.)`;
  }
  return typeof value; // number / boolean: the value itself is not shown
}

async function call(label, fn) {
  const started = Date.now();
  try {
    const body = await fn();
    return { label, ok: true, ms: Date.now() - started, shape: shape(body) };
  } catch (error) {
    return { label, ok: false, ms: Date.now() - started, status: error.status || null, error: error.message };
  }
}

async function probe({ fetchImpl } = {}) {
  const today = almatyDateIso();
  const from = periods.addDays(today, -6);
  const results = [];
  results.push(await call('GET /orders?page=1&limit=100', () => client.request('/orders', { page: 1, limit: 100 }, { fetchImpl })));
  results.push(await call(`GET /statistics/sales ${from}..${today} (без include)`, () => client.fetchSales({ dateFrom: from, dateTo: today, fetchImpl })));
  results.push(await call('… include=summary', () => client.fetchSales({ dateFrom: from, dateTo: today, include: 'summary', fetchImpl })));
  results.push(await call('… include=items&page=1&limit=20', () => client.fetchSales({ dateFrom: from, dateTo: today, include: 'items', page: 1, limit: 20, fetchImpl })));
  const yesterday = periods.addDays(today, -1);
  results.push(await call(`… один день ${yesterday}, include=summary`, () => client.fetchSales({ dateFrom: yesterday, dateTo: yesterday, include: 'summary', fetchImpl })));
  return { ok: true, configured: client.configured(), range: { from, to: today }, results };
}

module.exports = { probe, shape };
