'use strict';

// Key-value storage for «Показатели качества», on top of the storage the
// project already uses (see lib/analytics/store.js):
//   memory → Vercel Runtime Cache → hidden Google Sheet tab «GB_Качество»
// Values are JSON, gzip+base64, split into ≤45 000-char cells (D..Z).

const zlib = require('node:zlib');
const sheets = require('../google-sheets');

const TAB = 'GB_Качество';
const HEADER = ['key', 'savedAt', 'parts', 'data…'];
const CHUNK = 45_000;
const MAX_PARTS = 23; // columns D..Z
const NAMESPACE = 'grants-book-quality-v1';

const STATE = globalThis.__GB_QUALITY_STORE || (globalThis.__GB_QUALITY_STORE = {
  memory: new Map(),
  index: null,
  indexAt: 0,
  functionsPromise: null,
  lastError: '',
});

function noteError(context, error) {
  STATE.lastError = `${context}: ${error && error.message ? error.message : String(error)}`;
  console.warn('Quality storage', STATE.lastError);
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
  try { await cache.set(key, value, { ttl, tags: ['grants-book-quality'] }); } catch (error) { noteError('Runtime Cache', error); }
}

async function waitUntil(promise) {
  const fns = await vercelFunctions();
  const guarded = Promise.resolve(promise).catch((error) => noteError('background', error));
  if (fns && typeof fns.waitUntil === 'function') fns.waitUntil(guarded);
  return guarded;
}

function pack(value) {
  return zlib.gzipSync(Buffer.from(JSON.stringify(value)), { level: 9 }).toString('base64');
}

function unpack(text) {
  return JSON.parse(zlib.gunzipSync(Buffer.from(text, 'base64')).toString('utf8'));
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

// get(key) → { value, savedAt } | null
async function get(key, { maxMemoryAgeMs = 15_000 } = {}) {
  const mem = STATE.memory.get(key);
  if (mem && Date.now() - mem.readAt < maxMemoryAgeMs) return mem.entry;
  const cached = await rcGet(`kv:${key}`);
  let entry = cached && cached.savedAt ? cached : null;
  if (sheets.configured()) {
    try {
      const index = await sheetIndex();
      const meta = index.get(key);
      if (meta && meta.parts > 0 && (!entry || meta.savedAt > entry.savedAt)) {
        const [rows] = await sheets.batchGetValues(TAB, [`A${meta.row}:Z${meta.row}`]);
        const row = (rows && rows[0]) || [];
        entry = { savedAt: Number(row[1]) || meta.savedAt, value: unpack(row.slice(3, 3 + meta.parts).join('')) };
        rcSet(`kv:${key}`, entry, 7 * 86_400);
      }
    } catch (error) {
      noteError(`read ${key}`, error);
    }
  }
  if (!entry && mem) entry = mem.entry;
  if (entry) STATE.memory.set(key, { entry, readAt: Date.now() });
  return entry;
}

async function getValue(key, fallback) {
  const entry = await get(key);
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
    if (parts.length > MAX_PARTS) throw new Error(`значение ${key} слишком большое (${parts.length} частей)`);
    const index = await sheetIndex(true);
    const meta = index.get(key);
    const row = meta ? meta.row : Math.max(1, ...[...index.values()].map((m) => m.row)) + 1;
    const cells = [key, entry.savedAt, parts.length, ...parts];
    while (cells.length < 3 + MAX_PARTS) cells.push('');
    await sheets.putValues(TAB, `A${row}:Z${row}`, [cells]);
    index.set(key, { row, savedAt: entry.savedAt, parts: parts.length });
    return { entry, persisted: true };
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

module.exports = { get, getValue, hasLock, releaseLock, set, setLock, status, waitUntil, __test: { pack, unpack } };
