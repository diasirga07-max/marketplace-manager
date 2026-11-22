'use strict';

// Server-side storage for «Расходники», same approach as lib/analytics/store.js:
//   config        -> hidden tab GB_Расходники (key | value JSON | updatedAt)
//   price history -> hidden tab GB_Расходники_Цены (one row per price change)
//   journal       -> hidden tab GB_Расходники_Журнал (приходы и инвентаризации)
// Vercel Runtime Cache + memory are used as a fallback when the sheet is not writable.

const crypto = require('node:crypto');
const sheets = require('../google-sheets');
const { almatyDateIso } = require('../sales-core');
const calc = require('./calc');

const TAB_CONFIG = 'GB_Расходники';
const TAB_PRICES = 'GB_Расходники_Цены';
const TAB_JOURNAL = 'GB_Расходники_Журнал';
const PRICE_HEADER = ['id', 'item', 'from', 'packPrice', 'packUnits', 'unitPrice', 'createdAt'];
const JOURNAL_HEADER = ['id', 'at', 'item', 'type', 'qty', 'stockQty', 'comment'];
const CACHE_NAMESPACE = 'grants-book-consumables-v1';
const MEMORY_TTL_MS = 30_000;
const MAX_JOURNAL = 3000;

const STATE = globalThis.__GB_CONSUMABLES_STORE || (globalThis.__GB_CONSUMABLES_STORE = {
  value: null,
  at: 0,
  functionsPromise: null,
  lastError: '',
  listeners: new Set(),
});

function noteError(context, error) {
  STATE.lastError = `${context}: ${error && error.message ? error.message : String(error)}`;
  console.warn('Consumables storage', STATE.lastError);
}

async function vercelFunctions() {
  if (!STATE.functionsPromise) STATE.functionsPromise = import('@vercel/functions').catch(() => null);
  return STATE.functionsPromise;
}

async function runtimeCache() {
  const functions = await vercelFunctions();
  if (!functions || typeof functions.getCache !== 'function') return null;
  try { return functions.getCache({ namespace: CACHE_NAMESPACE }); } catch { return null; }
}

async function rcGet(key) {
  const cache = await runtimeCache();
  if (!cache) return null;
  try { return (await cache.get(key)) || null; } catch { return null; }
}

async function rcSet(key, value, ttlSeconds = 365 * 86_400) {
  const cache = await runtimeCache();
  if (!cache) return;
  try { await cache.set(key, value, { ttl: ttlSeconds, tags: ['grants-book-consumables'] }); } catch (error) { noteError('Runtime Cache', error); }
}

function storageStatus() {
  return {
    sheet: sheets.configured() ? 'google-sheets' : 'нет GOOGLE_SERVICE_ACCOUNT_JSON',
    spreadsheetId: sheets.SPREADSHEET_ID,
    tabs: [TAB_CONFIG, TAB_PRICES, TAB_JOURNAL],
    lastError: STATE.lastError,
  };
}

function version(value) {
  return crypto.createHash('sha1')
    .update(JSON.stringify([value.config, value.history]))
    .digest('hex')
    .slice(0, 12);
}

function finalize(raw) {
  const { config } = calc.normalizeConfig(raw.config || {});
  const value = {
    config,
    history: calc.normalizeHistory(raw.history),
    journal: (Array.isArray(raw.journal) ? raw.journal : []).slice(0, MAX_JOURNAL),
  };
  value.version = version(value);
  return value;
}

async function readSheets() {
  await Promise.all([
    sheets.ensureSheet(TAB_CONFIG, ['key', 'value', 'updatedAt']),
    sheets.ensureSheet(TAB_PRICES, PRICE_HEADER),
    sheets.ensureSheet(TAB_JOURNAL, JOURNAL_HEADER),
  ]);
  const [configRows, priceRows, journalRows] = await Promise.all([
    sheets.getValues(TAB_CONFIG, 'A2:C20'),
    sheets.getValues(TAB_PRICES, 'A2:G5000'),
    sheets.getValues(TAB_JOURNAL, `A2:G${MAX_JOURNAL + 1}`),
  ]);
  let config = {};
  for (const [key, value] of configRows) {
    if (key === 'config') {
      try { config = JSON.parse(value); } catch (error) { noteError('config parse', error); }
    }
  }
  const history = priceRows.filter((row) => row[1] && row[2]).map((row) => ({
    id: row[0], item: row[1], from: row[2], packPrice: Number(row[3]) || 0,
    packUnits: Number(row[4]) || 0, unitPrice: Number(row[5]) || 0, createdAt: row[6] || '',
  }));
  const journal = journalRows.filter((row) => row[0] && row[2]).map((row) => ({
    id: row[0], at: Number(row[1]) || Date.parse(row[1]) || 0, item: row[2], type: row[3],
    qty: Number(row[4]) || 0, stockQty: row[5] === '' || row[5] == null ? null : Number(row[5]), comment: row[6] || '',
  }));
  return { config, history, journal };
}

async function getState(force = false) {
  if (!force && STATE.value && Date.now() - STATE.at < MEMORY_TTL_MS) return STATE.value;
  let raw = null;
  if (sheets.configured()) {
    try { raw = await readSheets(); } catch (error) { noteError('read', error); }
  }
  if (!raw) raw = (await rcGet('state')) || STATE.value || {};
  STATE.value = finalize(raw);
  STATE.at = Date.now();
  return STATE.value;
}

async function writeAll(value, parts = { config: true, prices: true, journal: true }) {
  const next = finalize(value);
  STATE.value = next;
  STATE.at = Date.now();
  await rcSet('state', { config: next.config, history: next.history, journal: next.journal });
  for (const listener of STATE.listeners) {
    try { listener(next); } catch { /* listeners must not break saving */ }
  }
  if (!sheets.configured()) return next;
  try {
    const now = new Date().toISOString();
    if (parts.config) {
      await sheets.ensureSheet(TAB_CONFIG, ['key', 'value', 'updatedAt']);
      await sheets.putValues(TAB_CONFIG, 'A2:C2', [['config', JSON.stringify(next.config), now]]);
    }
    if (parts.prices) {
      await sheets.ensureSheet(TAB_PRICES, PRICE_HEADER);
      await sheets.clearValues(TAB_PRICES, 'A2:G5000');
      if (next.history.length) {
        await sheets.putValues(TAB_PRICES, `A2:G${next.history.length + 1}`,
          next.history.map((r) => [r.id, r.item, r.from, r.packPrice, r.packUnits, r.unitPrice, r.createdAt]));
      }
    }
    if (parts.journal) {
      await sheets.ensureSheet(TAB_JOURNAL, JOURNAL_HEADER);
      await sheets.clearValues(TAB_JOURNAL, `A2:G${MAX_JOURNAL + 1}`);
      if (next.journal.length) {
        await sheets.putValues(TAB_JOURNAL, `A2:G${next.journal.length + 1}`,
          next.journal.map((r) => [r.id, r.at, r.item, r.type, r.qty, r.stockQty == null ? '' : r.stockQty, r.comment]));
      }
    }
  } catch (error) {
    noteError('write', error);
    throw new Error(`Расходники сохранены только во временный кэш: ${error.message}`);
  }
  return next;
}

// Saves the reference book. Price changes are appended to the history with
// their start date (default: today), so past reports keep their old prices.
async function saveConfig(input = {}) {
  const current = await getState(true);
  const merged = { ...current.config, ...(input.config || {}) };
  merged.stock = current.config.stock; // stock is changed only through receipt/inventory
  const { config } = calc.normalizeConfig(merged, { strict: true });
  config.updatedAt = new Date().toISOString();
  const today = almatyDateIso();
  const effectiveFrom = input.priceFrom && typeof input.priceFrom === 'object' ? input.priceFrom : {};
  for (const [key, from] of Object.entries(effectiveFrom)) {
    if (from && (!/^\d{4}-\d{2}-\d{2}$/.test(String(from)) || from > today)) {
      const error = new Error(`Дата начала цены «${calc.itemTitle(config, key)}» должна быть в формате ГГГГ-ММ-ДД и не позже сегодняшней`);
      error.status = 400;
      throw error;
    }
  }
  const changes = calc.priceChanges(config, current.history, { today, effectiveFrom });
  const history = calc.mergeHistory(current.history, changes);
  const next = await writeAll({ config, history, journal: current.journal }, { config: true, prices: changes.length > 0, journal: false });
  return { state: next, changes };
}

function toBaseUnits(config, item, qty, unit) {
  const n = Number(String(qty ?? '').replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) {
    const error = new Error('Количество должно быть числом ≥ 0');
    error.status = 400;
    throw error;
  }
  if (unit === 'pack') return n * calc.packUnits(config, item);
  // Stretch and tape are entered in metres, stored in centimetres.
  return item === 'stretch' || item === 'tape' ? n * 100 : n;
}

// type: 'receipt' (приход, добавить количество) | 'inventory' (фактический остаток).
async function stockOperation(input = {}) {
  const current = await getState(true);
  const config = { ...current.config, stock: { ...current.config.stock } };
  const item = String(input.item || '');
  if (!calc.itemKeys(config).includes(item)) {
    const error = new Error('Неизвестная позиция расходников');
    error.status = 400;
    throw error;
  }
  const type = input.type === 'inventory' ? 'inventory' : 'receipt';
  const qty = toBaseUnits(config, item, input.qty, input.unit);
  if (type === 'receipt' && !(qty > 0)) {
    const error = new Error('Количество прихода должно быть больше 0');
    error.status = 400;
    throw error;
  }
  const at = Date.now();
  if (type === 'inventory' || !config.stock[item]) config.stock[item] = { qty, at };
  const entry = {
    id: crypto.randomUUID(),
    at,
    item,
    type,
    qty,
    stockQty: type === 'inventory' ? qty : null,
    comment: String(input.comment || '').trim().slice(0, 200),
  };
  const journal = [entry, ...current.journal].slice(0, MAX_JOURNAL);
  const next = await writeAll({ config, history: current.history, journal }, { config: true, prices: false, journal: true });
  return { state: next, entry };
}

function onChange(listener) {
  STATE.listeners.add(listener);
  return () => STATE.listeners.delete(listener);
}

function __reset(value = null) {
  STATE.value = value ? finalize(value) : null;
  STATE.at = value ? Date.now() : 0;
}

module.exports = {
  getState,
  onChange,
  saveConfig,
  stockOperation,
  storageStatus,
  __test: { finalize, toBaseUnits, reset: __reset },
};
