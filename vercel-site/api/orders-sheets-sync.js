const crypto = require('node:crypto');

const SPREADSHEET_ID = process.env.GOOGLE_ORDERS_SPREADSHEET_ID || '1543WyOY5gsP3i3rcxcmp1dtxYHy6uPUtdFj8Xs58Cr4';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const VERSION = 'GRANTS BOOK live orders sync v1';
const SHEETS = {
  'Курдай': 'Выгрузка Курдай',
  'WB': 'Выгрузка WB',
  'Алматы': 'Выгрузка Алматы',
};
const MAX_ROWS_PER_GROUP = 5000;
let tokenCache = null;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
}

function send(res, status, body) {
  cors(res);
  return res.status(status).json(body);
}

function b64url(value) {
  return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function getServiceAccount() {
  const raw = String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
  if (raw) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { throw new Error(`Некорректный GOOGLE_SERVICE_ACCOUNT_JSON: ${e.message}`); }
    if (!parsed.client_email || !parsed.private_key) throw new Error('Service Account JSON не содержит client_email/private_key');
    return { email: parsed.client_email, key: String(parsed.private_key).replace(/\\n/g, '\n') };
  }
  const email = String(process.env.GOOGLE_SHEETS_CLIENT_EMAIL || '').trim();
  const key = String(process.env.GOOGLE_SHEETS_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
  if (!email || !key) throw new Error('Не настроены GOOGLE_SERVICE_ACCOUNT_JSON или GOOGLE_SHEETS_CLIENT_EMAIL/GOOGLE_SHEETS_PRIVATE_KEY');
  return { email, key };
}

async function googleToken() {
  if (tokenCache && tokenCache.exp > Date.now() + 60000) return tokenCache.token;
  const sa = getServiceAccount();
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: sa.email, scope: GOOGLE_SCOPE, aud: GOOGLE_TOKEN_URL, iat: now, exp: now + 3600 }));
  const unsigned = `${head}.${claims}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned); signer.end();
  const assertion = `${unsigned}.${b64url(signer.sign(sa.key))}`;
  const r = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth-type:jwt-bearer', assertion }),
    cache: 'no-store',
  });
  let j = {};
  try { j = await r.json(); } catch {}
  if (!r.ok || !j.access_token) {
    // Retry with the canonical grant type. Kept separate so malformed proxies cannot alter the value above.
    const r2 = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      cache: 'no-store',
    });
    let j2 = {};
    try { j2 = await r2.json(); } catch {}
    if (!r2.ok || !j2.access_token) throw new Error(`Google OAuth ${r2.status}: ${j2.error_description || j2.error || 'token error'}`);
    tokenCache = { token: j2.access_token, exp: Date.now() + Number(j2.expires_in || 3600) * 1000 };
    return tokenCache.token;
  }
  tokenCache = { token: j.access_token, exp: Date.now() + Number(j.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

function qSheet(name) {
  return `'${String(name).replace(/'/g, "''")}'`;
}

async function sheetsRequest(path, options = {}) {
  const token = await googleToken();
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}${path}`, {
    method: options.method || 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'content-type': 'application/json' } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: 'no-store',
  });
  const text = await r.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text.slice(0, 500) }; }
  if (!r.ok) throw new Error(`Google Sheets ${r.status}: ${payload?.error?.message || payload.raw || text.slice(0, 350)}`);
  return payload;
}

async function clearRange(sheetName, range = 'A2:F5000') {
  const full = `${qSheet(sheetName)}!${range}`;
  return sheetsRequest(`/values/${encodeURIComponent(full)}:clear`, { method: 'POST', body: {} });
}

async function writeValues(sheetName, startCell, values) {
  if (!values.length) return null;
  const full = `${qSheet(sheetName)}!${startCell}`;
  return sheetsRequest(`/values/${encodeURIComponent(full)}?valueInputOption=RAW`, {
    method: 'PUT',
    body: { range: full, majorDimension: 'ROWS', values },
  });
}

function cleanText(value, max = 500) {
  return String(value == null ? '' : value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}

function cleanOrders(value) {
  const arr = Array.isArray(value) ? value : [];
  const set = new Set(arr.map(x => cleanText(x, 40).replace(/-1$/, '')).filter(Boolean));
  return [...set].sort((a, b) => b.localeCompare(a, 'ru', { numeric: true }));
}

function normalizeRow(raw) {
  const sku = cleanText(raw && raw.sku, 160);
  if (!sku) return null;
  const qty = Math.max(0, Number.parseInt(raw && raw.qty, 10) || 0);
  const orders = cleanOrders(raw && raw.orders);
  if (!qty || !orders.length) return null;
  return {
    sku,
    name: cleanText(raw && raw.name, 500),
    qty,
    orders,
  };
}

function normalizeGroup(rows) {
  const source = Array.isArray(rows) ? rows : [];
  const bySku = new Map();
  for (const raw of source.slice(0, MAX_ROWS_PER_GROUP)) {
    const row = normalizeRow(raw);
    if (!row) continue;
    const key = row.sku.toUpperCase();
    const prev = bySku.get(key);
    if (!prev) {
      bySku.set(key, row);
      continue;
    }
    // Browser data are already grouped, but merge defensively if duplicate SKU is sent.
    prev.qty += row.qty;
    prev.orders = cleanOrders([...prev.orders, ...row.orders]);
    if (!prev.name && row.name) prev.name = row.name;
  }
  return [...bySku.values()].sort((a, b) => a.sku.localeCompare(b.sku, 'ru', { numeric: true, sensitivity: 'base' }));
}

function almatyNow() {
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Asia/Almaty', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}:${p.second}`;
}

async function health() {
  const range = `${qSheet(SHEETS['Алматы'])}!A1:F2`;
  await sheetsRequest(`/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`);
  return true;
}

async function syncGroups(groups, sourceGeneratedAt) {
  const updatedAt = almatyNow();
  const output = {};
  for (const groupName of ['Курдай', 'WB', 'Алматы']) {
    const sheetName = SHEETS[groupName];
    const rows = normalizeGroup(groups && groups[groupName]);
    const values = rows.map(row => [
      row.name,
      row.sku,
      row.qty,
      row.orders.join(', '),
      '✅ Актуальный',
      updatedAt,
    ]);
    // Critical rule: fully delete previous data rows before writing the current website snapshot.
    await clearRange(sheetName, 'A2:F5000');
    await writeValues(sheetName, 'A1:F1', [[
      'Название товара', 'Артикул', 'Количество', 'Номера заказов', 'Действие', 'Обновлено'
    ]]);
    if (values.length) await writeValues(sheetName, `A2:F${values.length + 1}`, values);
    output[groupName] = {
      sheet: sheetName,
      skuRows: rows.length,
      units: rows.reduce((s, x) => s + x.qty, 0),
      orders: new Set(rows.flatMap(x => x.orders)).size,
    };
  }
  return { updatedAt, sourceGeneratedAt: cleanText(sourceGeneratedAt, 80), groups: output };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET') {
    try {
      await health();
      return send(res, 200, { ok: true, version: VERSION, spreadsheetId: SPREADSHEET_ID, writable: true });
    } catch (error) {
      return send(res, 503, { ok: false, version: VERSION, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return send(res, 405, { ok: false, error: 'Method not allowed' });
  }
  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const groups = body && body.groups;
  if (!groups || typeof groups !== 'object') return send(res, 400, { ok: false, error: 'groups object is required' });
  try {
    const result = await syncGroups(groups, body.sourceGeneratedAt);
    return send(res, 200, { ok: true, version: VERSION, ...result });
  } catch (error) {
    console.error('orders-sheets-sync failed', error);
    return send(res, 500, { ok: false, version: VERSION, error: error instanceof Error ? error.message : String(error) });
  }
};
