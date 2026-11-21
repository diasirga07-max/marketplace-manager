'use strict';

// Server-side storage for the analytics dashboard.
//   * settings and manual expenses  -> hidden tabs in the existing Google Sheet
//   * raw Kaspi months (cache)      -> hidden tab (gzip+base64, chunked) + Vercel Runtime Cache + memory
// Everything degrades gracefully to Runtime Cache/memory if the sheet is not writable.

const zlib = require('node:zlib');
const crypto = require('node:crypto');
const sheets = require('../google-sheets');
const { DEFAULT_SETTINGS, normalizeSettings } = require('./finance');
const { RAW_SCHEMA } = require('./kaspi-raw');

const TAB_SETTINGS = 'GB_Аналитика_Настройки';
const TAB_EXPENSES = 'GB_Аналитика_Расходы';
const TAB_CACHE = 'GB_Аналитика_Кэш';
const CHUNK = 45_000; // a Google Sheets cell holds at most 50 000 characters
const MAX_PARTS = 22; // columns E..Z
const CACHE_NAMESPACE = 'grants-book-analytics-v1';

const STATE = globalThis.__GB_ANALYTICS_STORE || (globalThis.__GB_ANALYTICS_STORE = {
  months: new Map(),
  cacheIndex: null,
  cacheIndexAt: 0,
  settings: null,
  settingsAt: 0,
  expenses: null,
  expensesAt: 0,
  functionsPromise: null,
  lastError: '',
});

function noteError(context, error) {
  STATE.lastError = `${context}: ${error && error.message ? error.message : String(error)}`;
  console.warn('Analytics storage', STATE.lastError);
}

async function vercelFunctions() {
  if (!STATE.functionsPromise) {
    STATE.functionsPromise = import('@vercel/functions').catch(() => null);
  }
  return STATE.functionsPromise;
}

async function runtimeCache() {
  const functions = await vercelFunctions();
  if (!functions || typeof functions.getCache !== 'function') return null;
  try {
    return functions.getCache({ namespace: CACHE_NAMESPACE });
  } catch {
    return null;
  }
}

async function rcGet(key) {
  const cache = await runtimeCache();
  if (!cache) return null;
  try {
    return (await cache.get(key)) || null;
  } catch {
    return null;
  }
}

async function rcSet(key, value, ttlSeconds) {
  const cache = await runtimeCache();
  if (!cache) return;
  try {
    await cache.set(key, value, { ttl: ttlSeconds, tags: ['grants-book-analytics'] });
  } catch (error) {
    noteError('Runtime Cache', error);
  }
}

async function waitUntil(promise) {
  const functions = await vercelFunctions();
  const guarded = promise.catch((error) => noteError('background', error));
  if (functions && typeof functions.waitUntil === 'function') functions.waitUntil(guarded);
  return guarded;
}

function storageStatus() {
  return {
    sheet: sheets.configured() ? 'google-sheets' : 'нет GOOGLE_SERVICE_ACCOUNT_JSON',
    spreadsheetId: sheets.SPREADSHEET_ID,
    tabs: [TAB_SETTINGS, TAB_EXPENSES, TAB_CACHE],
    lastError: STATE.lastError,
  };
}

// ---------- settings ----------

async function getSettings(force = false) {
  if (!force && STATE.settings && Date.now() - STATE.settingsAt < 60_000) return STATE.settings;
  let stored = null;
  if (sheets.configured()) {
    try {
      await sheets.ensureSheet(TAB_SETTINGS, ['key', 'value', 'updatedAt']);
      const rows = await sheets.getValues(TAB_SETTINGS, 'A2:C200');
      stored = {};
      for (const [key, value] of rows) {
        if (!key) continue;
        try { stored[key] = JSON.parse(value); } catch { stored[key] = value; }
      }
    } catch (error) {
      noteError('settings read', error);
    }
  }
  if (!stored) stored = (await rcGet('settings')) || STATE.settings || {};
  STATE.settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...stored });
  STATE.settingsAt = Date.now();
  return STATE.settings;
}

async function saveSettings(input) {
  const current = await getSettings(true);
  const next = normalizeSettings({ ...current, ...input });
  STATE.settings = next;
  STATE.settingsAt = Date.now();
  await rcSet('settings', next, 365 * 86_400);
  if (sheets.configured()) {
    try {
      await sheets.ensureSheet(TAB_SETTINGS, ['key', 'value', 'updatedAt']);
      const now = new Date().toISOString();
      const rows = Object.entries(next).map(([key, value]) => [key, JSON.stringify(value), now]);
      await sheets.clearValues(TAB_SETTINGS, 'A2:C200');
      await sheets.putValues(TAB_SETTINGS, `A2:C${rows.length + 1}`, rows);
    } catch (error) {
      noteError('settings write', error);
      throw new Error(`Настройки сохранены только во временный кэш: ${error.message}`);
    }
  }
  return next;
}

// ---------- expenses ----------

const EXPENSE_HEADER = ['id', 'month', 'category', 'amount', 'comment', 'createdAt', 'updatedAt'];

function normalizeExpense(input = {}) {
  const month = String(input.month || '').trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Месяц расхода должен быть в формате ГГГГ-ММ');
  const amount = Number(String(input.amount ?? '').replace(/[\s ₸]/g, '').replace(',', '.'));
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Сумма расхода должна быть неотрицательным числом');
  const category = String(input.category || '').trim() || 'Прочее';
  return {
    id: String(input.id || crypto.randomUUID()),
    month,
    category: category.slice(0, 60),
    amount: Math.round(amount * 100) / 100,
    comment: String(input.comment || '').trim().slice(0, 200),
    createdAt: String(input.createdAt || new Date().toISOString()),
    updatedAt: new Date().toISOString(),
  };
}

async function getExpenses(force = false) {
  if (!force && STATE.expenses && Date.now() - STATE.expensesAt < 60_000) return STATE.expenses;
  let list = null;
  if (sheets.configured()) {
    try {
      await sheets.ensureSheet(TAB_EXPENSES, EXPENSE_HEADER);
      const rows = await sheets.getValues(TAB_EXPENSES, 'A2:G5000');
      list = rows
        .filter((row) => row[0] && row[1])
        .map((row) => ({
          id: String(row[0]),
          month: String(row[1]),
          category: String(row[2] || 'Прочее'),
          amount: Number(row[3]) || 0,
          comment: String(row[4] || ''),
          createdAt: String(row[5] || ''),
          updatedAt: String(row[6] || ''),
        }));
    } catch (error) {
      noteError('expenses read', error);
    }
  }
  if (!list) list = (await rcGet('expenses')) || STATE.expenses || [];
  STATE.expenses = list;
  STATE.expensesAt = Date.now();
  return list;
}

async function writeExpenses(list) {
  STATE.expenses = list;
  STATE.expensesAt = Date.now();
  await rcSet('expenses', list, 365 * 86_400);
  if (!sheets.configured()) return;
  try {
    await sheets.ensureSheet(TAB_EXPENSES, EXPENSE_HEADER);
    await sheets.clearValues(TAB_EXPENSES, 'A2:G5000');
    if (list.length) {
      await sheets.putValues(
        TAB_EXPENSES,
        `A2:G${list.length + 1}`,
        list.map((e) => [e.id, e.month, e.category, e.amount, e.comment, e.createdAt, e.updatedAt]),
      );
    }
  } catch (error) {
    noteError('expenses write', error);
    throw new Error(`Расход сохранён только во временный кэш: ${error.message}`);
  }
}

async function upsertExpense(input) {
  const list = [...(await getExpenses(true))];
  const existing = input.id ? list.findIndex((item) => item.id === String(input.id)) : -1;
  const expense = normalizeExpense({ ...(existing >= 0 ? list[existing] : {}), ...input });
  if (existing >= 0) list[existing] = expense;
  else list.push(expense);
  list.sort((a, b) => b.month.localeCompare(a.month) || a.category.localeCompare(b.category, 'ru'));
  await writeExpenses(list);
  return expense;
}

async function deleteExpense(id) {
  const list = (await getExpenses(true)).filter((item) => item.id !== String(id));
  await writeExpenses(list);
  return list;
}

// ---------- raw month cache ----------

function pack(value) {
  return zlib.gzipSync(Buffer.from(JSON.stringify(value)), { level: 9 }).toString('base64');
}

function unpack(text) {
  return JSON.parse(zlib.gunzipSync(Buffer.from(text, 'base64')).toString('utf8'));
}

async function cacheIndex(force = false) {
  if (!sheets.configured()) return new Map();
  if (!force && STATE.cacheIndex && Date.now() - STATE.cacheIndexAt < 30_000) return STATE.cacheIndex;
  try {
    await sheets.ensureSheet(TAB_CACHE, ['month', 'savedAt', 'coveredUntil', 'parts', 'data…']);
    const rows = await sheets.getValues(TAB_CACHE, 'A2:D400');
    const index = new Map();
    rows.forEach((row, offset) => {
      if (/^\d{4}-\d{2}$/.test(String(row[0] || ''))) {
        index.set(String(row[0]), {
          row: offset + 2,
          savedAt: Number(row[1]) || 0,
          coveredUntil: Number(row[2]) || 0,
          parts: Number(row[3]) || 0,
        });
      }
    });
    STATE.cacheIndex = index;
    STATE.cacheIndexAt = Date.now();
    return index;
  } catch (error) {
    noteError('cache index', error);
    return STATE.cacheIndex || new Map();
  }
}

function validEntry(entry) {
  return entry && entry.data && entry.data.schema === RAW_SCHEMA && Array.isArray(entry.data.orders);
}

// Reads many months at once: memory -> Runtime Cache -> Google Sheet (one batchGet).
async function readMonths(keys) {
  const result = new Map();
  const missing = [];
  for (const key of keys) {
    const memory = STATE.months.get(key);
    if (validEntry(memory)) result.set(key, memory);
    else missing.push(key);
  }
  const stillMissing = [];
  await Promise.all(missing.map(async (key) => {
    const entry = await rcGet(`month:${key}`);
    if (validEntry(entry)) {
      STATE.months.set(key, entry);
      result.set(key, entry);
    } else stillMissing.push(key);
  }));
  if (!stillMissing.length || !sheets.configured()) return result;

  const index = await cacheIndex();
  const wanted = stillMissing.filter((key) => index.has(key) && index.get(key).parts > 0);
  if (!wanted.length) return result;
  try {
    const ranges = wanted.map((key) => `A${index.get(key).row}:Z${index.get(key).row}`);
    const values = await sheets.batchGetValues(TAB_CACHE, ranges);
    values.forEach((rows, i) => {
      const row = rows[0] || [];
      const meta = index.get(wanted[i]);
      const text = row.slice(4, 4 + meta.parts).join('');
      try {
        const entry = { savedAt: Number(row[1]) || 0, coveredUntil: Number(row[2]) || 0, data: unpack(text) };
        if (validEntry(entry)) {
          STATE.months.set(wanted[i], entry);
          result.set(wanted[i], entry);
          rcSet(`month:${wanted[i]}`, entry, 30 * 86_400);
        }
      } catch (error) {
        noteError(`cache decode ${wanted[i]}`, error);
      }
    });
  } catch (error) {
    noteError('cache read', error);
  }
  return result;
}

async function writeMonth(key, data, { closed }) {
  const entry = { savedAt: Date.now(), coveredUntil: data.coveredUntil, data };
  STATE.months.set(key, entry);
  if (STATE.months.size > 40) STATE.months.delete(STATE.months.keys().next().value);
  await rcSet(`month:${key}`, entry, closed ? 60 * 86_400 : 2 * 86_400);
  if (!sheets.configured()) return entry;

  try {
    const text = pack(data);
    const parts = [];
    for (let i = 0; i < text.length; i += CHUNK) parts.push(text.slice(i, i + CHUNK));
    if (parts.length > MAX_PARTS) {
      noteError('cache write', new Error(`месяц ${key} слишком большой для листа (${parts.length} частей)`));
      return entry;
    }
    const index = await cacheIndex(true);
    const existing = index.get(key);
    const row = existing ? existing.row : Math.max(1, ...[...index.values()].map((item) => item.row)) + 1;
    const cells = [key, entry.savedAt, entry.coveredUntil || 0, parts.length, ...parts];
    while (cells.length < 4 + MAX_PARTS) cells.push('');
    await sheets.putValues(TAB_CACHE, `A${row}:Z${row}`, [cells]);
    index.set(key, { row, savedAt: entry.savedAt, coveredUntil: entry.coveredUntil, parts: parts.length });
  } catch (error) {
    noteError('cache write', error);
  }
  return entry;
}

module.exports = {
  deleteExpense,
  getExpenses,
  getSettings,
  readMonths,
  saveSettings,
  storageStatus,
  upsertExpense,
  waitUntil,
  writeMonth,
  __test: { normalizeExpense, pack, unpack },
};
