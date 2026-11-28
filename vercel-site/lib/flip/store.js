'use strict';

// Key-value storage for the «Flip» section, on top of the storage the project
// already uses (same design as lib/quality/store.js):
//   memory → Vercel Runtime Cache → hidden Google Sheet tab «GB_Flip»
// Values are JSON, gzip+base64, split into ≤45 000-char cells (D..Z).
// The Google Sheet is the durable copy; Runtime Cache and memory only speed up reads.

const zlib = require('node:zlib');
const sheets = require('../google-sheets');

const TAB = 'GB_Flip';
const HEADER = ['key', 'savedAt', 'parts', 'data…'];
const CHUNK = 45_000;
const MAX_PARTS = 23; // columns D..Z
const MAX_ROWS = 8;
const NAMESPACE = 'grants-book-flip-v1';

const STATE = globalThis.__GB_FLIP_STORE || (globalThis.__GB_FLIP_STORE = {
  memory: new Map(),
  index: null,
  indexAt: 0,
  functionsPromise: null,
  lastError: '',
});

function noteError(context, error) {
  STATE.lastError = `${context}: ${error && error.message ? error.message : String(error)}`;
  console.warn('Flip storage', STATE.lastError);
}

async function vercelFunctions() {
  if (!STATE.functionsPromise) STATE.functionsPromise = import('@vercel/functions').catch(() => null);
  return STATE.functionsPromise;
}

async function runtimeCache() {
  const fns = await vercelFunctions();
  if (!fns || typeof fns.getCache !== 'function') return null;
  try { return fns.getCache({ namespace: NAMESPACE }); } catch { return null; }
}

async function rcGet(key) {
  const cache = await runtimeCache();
  if (!cache) return null;
  try { return (await cache.get(key)) || null; } catch { return null; }
}

async function rcSet(key, value, ttl) {
  const cache = await runtimeCache();
  if (!cache) return;
  try { await cache.set(key, value, { ttl, tags: ['grants-book-flip'] }); } catch (error) { noteError('Runtime Cache', error); }
}

function pack(value) {
  return zlib.gzipSync(Buffer.from(JSON.stringify(value)), { level: 9 }).toString('base64');
}

function unpack(text) {
  return JSON.parse(zlib.gunzipSync(Buffer.from(text, 'base64')).toString('utf8'));
}

function durable() {
  return sheets.configured();
}

async function sheetIndex(force = false) {
  if (!sheets.configured()) return new Map();
  if (!force && STATE.index && Date.now() - STATE.indexAt < 20_000) return STATE.index;
  await sheets.ensureSheet(TAB, HEADER);
  const rows = await sheets.getValues(TAB, 'A2:C200');
  const index = new Map();
  rows.forEach((row, i) => {
    if (row[0]) index.set(String(row[0]), { row: i + 2, savedAt: Number(row[1]) || 0, parts: Number(row[2]) || 0 });
  });
  STATE.index = index;
  STATE.indexAt = Date.now();
  return index;
}

function rowKey(key, i) {
  return i ? `${key}~${i}` : key;
}

// get(key) → { value, savedAt } | null. `fresh` skips memory (used by cron jobs).
async function get(key, { fresh = false } = {}) {
  const mem = STATE.memory.get(key);
  if (!fresh && mem && Date.now() - mem.readAt < 15_000) return mem.entry;
  const cached = fresh ? null : await rcGet(`kv:${key}`);
  let entry = cached && cached.savedAt ? cached : null;
  if (sheets.configured()) {
    try {
      const index = await sheetIndex(fresh);
      const meta = index.get(key);
      if (meta && meta.parts > 0 && (!entry || meta.savedAt > entry.savedAt)) {
        const rowsNeeded = Math.ceil(meta.parts / MAX_PARTS);
        const metas = Array.from({ length: rowsNeeded }, (_, i) => index.get(rowKey(key, i)));
        if (metas.every(Boolean)) {
          const values = await sheets.batchGetValues(TAB, metas.map((m) => `A${m.row}:Z${m.row}`));
          let text = '';
          values.forEach((rows, i) => {
            const row = (rows && rows[0]) || [];
            const take = Math.min(MAX_PARTS, meta.parts - i * MAX_PARTS);
            text += row.slice(3, 3 + take).join('');
          });
          entry = { savedAt: meta.savedAt, value: unpack(text) };
          rcSet(`kv:${key}`, entry, 7 * 86_400);
        }
      }
    } catch (error) {
      noteError(`read ${key}`, error);
      if (fresh) throw error; // cron jobs must not act on a state they could not read
    }
  }
  if (!entry && mem) entry = mem.entry;
  if (entry) STATE.memory.set(key, { entry, readAt: Date.now() });
  return entry;
}

async function getValue(key, fallback, options) {
  const entry = await get(key, options);
  return entry ? entry.value : fallback;
}

async function set(key, value) {
  const entry = { savedAt: Date.now(), value };
  STATE.memory.set(key, { entry, readAt: Date.now() });
  await rcSet(`kv:${key}`, entry, 7 * 86_400);
  if (!sheets.configured()) return { entry, persisted: false, reason: 'GOOGLE_SERVICE_ACCOUNT_JSON не настроен — сохранено только во временный кэш' };
  try {
    const text = pack(value);
    const parts = [];
    for (let i = 0; i < text.length; i += CHUNK) parts.push(text.slice(i, i + CHUNK));
    const rowsNeeded = Math.max(1, Math.ceil(parts.length / MAX_PARTS));
    if (rowsNeeded > MAX_ROWS) throw new Error(`значение ${key} слишком большое (${parts.length} частей)`);
    const index = await sheetIndex(true);
    let next = Math.max(1, ...[...index.values()].map((m) => m.row)) + 1;
    // Continuation rows first, the head row (with savedAt) last.
    for (let i = rowsNeeded - 1; i >= 0; i -= 1) {
      const k = rowKey(key, i);
      const meta = index.get(k);
      const row = meta ? meta.row : next++;
      const chunk = parts.slice(i * MAX_PARTS, (i + 1) * MAX_PARTS);
      const cells = [k, entry.savedAt, i ? chunk.length : parts.length, ...chunk];
      while (cells.length < 3 + MAX_PARTS) cells.push('');
      await sheets.putValues(TAB, `A${row}:Z${row}`, [cells]);
      index.set(k, { row, savedAt: entry.savedAt, parts: i ? chunk.length : parts.length });
    }
    return { entry, persisted: true, parts: parts.length };
  } catch (error) {
    noteError(`write ${key}`, error);
    return { entry, persisted: false, reason: error.message };
  }
}

async function setLock(name, ttlMs) {
  await rcSet(`lock:${name}`, { until: Date.now() + ttlMs }, Math.ceil(ttlMs / 1000));
}

async function hasLock(name) {
  const lock = await rcGet(`lock:${name}`);
  return Boolean(lock && Number(lock.until) > Date.now());
}

async function releaseLock(name) {
  await rcSet(`lock:${name}`, { until: 0 }, 1);
}

function status() {
  return { storage: sheets.configured() ? 'google-sheets + runtime-cache' : 'runtime-cache (нет GOOGLE_SERVICE_ACCOUNT_JSON)', tab: TAB, lastError: STATE.lastError };
}

module.exports = { durable, get, getValue, hasLock, releaseLock, set, setLock, status, __test: { pack, unpack } };
