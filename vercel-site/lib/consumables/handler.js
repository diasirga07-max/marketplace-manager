'use strict';

// «Расходники» API. Served by api/data.js with module=consumables
// (Vercel Hobby allows at most 12 functions).
//   GET  /api/data?module=consumables&op=state              справочник, история цен, журнал
//   POST /api/data?module=consumables&op=config             {config, priceFrom:{item:'YYYY-MM-DD'}}
//   POST /api/data?module=consumables&op=stock              {item, type:'receipt'|'inventory', qty, unit:'pack'|'base', comment}
//   GET  /api/data?module=consumables&op=now&force=1        блок «Сейчас» (нужен токен Kaspi)
//   POST /api/data?module=consumables&op=preview            {items:[{sku,qty}], date} → расшифровка стоимости заказа

const { internal } = require('../grants-data-service');
const { almatyDateIso } = require('../sales-core');
const calc = require('./calc');
const store = require('./store');
const service = require('./service');

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

function publicState(state) {
  const today = almatyDateIso();
  const index = calc.priceIndex(state.history);
  const inForce = Object.fromEntries(calc.itemKeys(state.config).map((key) => {
    const record = calc.priceAt(index, key, today);
    return [key, record ? { from: record.from, unitPrice: record.unitPrice, packPrice: record.packPrice, packUnits: record.packUnits } : null];
  }));
  return {
    config: state.config,
    history: state.history,
    journal: state.journal.slice(0, 300),
    prices: calc.currentPrices(state.config),
    inForce,
    titles: Object.fromEntries(calc.itemKeys(state.config).map((key) => [key, calc.itemTitle(state.config, key)])),
    status: calc.configStatus(state.config, state.history, today),
    version: state.version,
    today,
  };
}

// Orders of a calendar month from the «Динамика продаж» cache (no Kaspi calls).
async function monthCountFromCache(month) {
  try {
    const analyticsStore = require('../analytics/store');
    const entry = (await analyticsStore.readMonths([month])).get(month);
    return entry && !entry.data.partial ? calc.rawMonthCount(entry.data.orders) : 0;
  } catch {
    return 0;
  }
}

async function handler(req, res) {
  const op = String((req.query && req.query.op) || 'health');
  try {
    if (op === 'health') return send(res, 200, { ok: true, module: 'consumables', storage: store.storageStatus() });
    if (op === 'state') {
      const state = await store.getState(String(req.query.force || '') === '1');
      return send(res, 200, { ok: true, ...publicState(state), storage: store.storageStatus() });
    }
    if (op === 'config' && req.method === 'POST') {
      const { state, changes } = await store.saveConfig(body(req));
      return send(res, 200, { ok: true, ...publicState(state), priceChanges: changes });
    }
    if (op === 'stock' && req.method === 'POST') {
      const { state, entry } = await store.stockOperation(body(req));
      return send(res, 200, { ok: true, ...publicState(state), entry });
    }
    if (op === 'preview' && req.method === 'POST') {
      const input = body(req);
      const state = await store.getState();
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(input.date || '')) ? input.date : almatyDateIso();
      const items = (Array.isArray(input.items) ? input.items : []).slice(0, 50);
      const month = date.slice(0, 7);
      let monthCount = Number(input.monthOrders);
      let monthSource = 'input';
      if (!(monthCount > 0)) {
        monthCount = await monthCountFromCache(month);
        monthSource = monthCount > 0 ? 'cache' : '';
      }
      const counts = new Map(monthCount > 0 ? [[month, monthCount]] : []);
      // A number typed by the user is used as is (no projection for the current month).
      const monthOrders = monthSource === 'input' ? (key) => (key === month ? { count: monthCount, projected: false } : null) : calc.monthOrdersProvider(counts);
      const cost = calc.orderCost(state.config, calc.priceIndex(state.history), items, date, { monthOrders });
      return send(res, 200, { ok: true, date, cost: { ...cost, bagTitle: cost.usage.bag ? calc.itemTitle(state.config, `bag:${cost.usage.bag.id}`) : '' } });
    }
    if (op === 'now') {
      const token = internal.tokenFromRequest(req);
      if (!token) return send(res, 401, { ok: false, error: 'Kaspi API токен не настроен (KASPI_API_TOKEN в Vercel)' });
      const result = await service.now(token, { force: String(req.query.force || '') === '1' });
      return send(res, 200, result);
    }
    return send(res, 404, { ok: false, error: 'Неизвестная операция' });
  } catch (error) {
    console.error('Consumables API failed', { op, error: error && error.message });
    return send(res, Number(error && error.status) === 400 ? 400 : 500, { ok: false, error: (error && error.message) || 'Ошибка сервера' });
  }
}

function isPublic(req) {
  return !req.query || !req.query.op || req.query.op === 'health';
}

module.exports = { handler, isPublic };
