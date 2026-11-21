'use strict';

// Sales analytics API («Динамика продаж»). All calculations are server-side.
// Served by api/data.js (Hobby plan allows max 12 functions):
// vercel.json rewrites /api/analytics -> /api/data?module=analytics.
//   GET  /api/analytics?op=dashboard&preset=month|...&from&to&warehouse&category&sku&force=1
//   GET  /api/analytics?op=settings            POST op=settings  {commissionPct, ...}
//   GET  /api/analytics?op=expenses            POST op=expenses  {id?, month, category, amount, comment}
//   POST /api/analytics?op=expense-delete {id}

const { internal } = require('../grants-data-service');
const service = require('./service');
const store = require('./store');

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.end(JSON.stringify(data));
}

function body(req) {
  let value = req.body || {};
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { value = {}; }
  }
  return value && typeof value === 'object' ? value : {};
}

async function handler(req, res) {
  const op = String((req.query && req.query.op) || 'health');
  try {
    if (op === 'health') {
      const result = { ok: true, version: service.SERVICE_VERSION, storage: store.storageStatus(), ...service.diagnostics() };
      if (req.query && req.query.cache === '1') {
        try { result.cachedMonths = await store.cacheSummary(); } catch (error) { result.cachedMonthsError = error.message; }
      }
      return send(res, 200, result);
    }
    if (op === 'dashboard') {
      const token = internal.tokenFromRequest(req);
      if (!token) return send(res, 401, { ok: false, error: 'Kaspi API токен не настроен (KASPI_API_TOKEN в Vercel)' });
      return send(res, 200, await service.dashboard({ token, query: req.query || {} }));
    }
    if (op === 'settings') {
      if (req.method === 'POST') return send(res, 200, { ok: true, settings: await store.saveSettings(body(req)) });
      return send(res, 200, { ok: true, settings: await store.getSettings(true), storage: store.storageStatus() });
    }
    if (op === 'expenses') {
      if (req.method === 'POST') {
        const expense = await store.upsertExpense(body(req));
        return send(res, 200, { ok: true, expense, expenses: await store.getExpenses() });
      }
      return send(res, 200, { ok: true, expenses: await store.getExpenses(true) });
    }
    if (op === 'expense-delete' && req.method === 'POST') {
      const { id } = body(req);
      if (!id) return send(res, 400, { ok: false, error: 'Не указан id расхода' });
      return send(res, 200, { ok: true, expenses: await store.deleteExpense(id) });
    }
    return send(res, 404, { ok: false, error: 'Неизвестная операция' });
  } catch (error) {
    console.error('Analytics API failed', { op, error: error && error.message });
    const message = error && error.message ? error.message : 'Ошибка сервера';
    return send(res, /формате|числом|позже|Максимальный|Месяц/.test(message) ? 400 : 500, { ok: false, error: message });
  }
}

function isPublic(req) {
  return !req.query || !req.query.op || req.query.op === 'health';
}

module.exports = { handler, isPublic };
