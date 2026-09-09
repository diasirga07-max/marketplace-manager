const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID || '1dLU5KOi3WBLy3uNEiqGv5rf9ka0OwcEw_RjhDQW3H1E';
const SHEET_NAME = process.env.GOOGLE_SHEET_NAME || 'Прайс KASPI';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const WB_URL = 'https://card.wb.ru/cards/v4/detail';
const WB_DESTINATION = Number(process.env.WB_DESTINATION || 82);
const WB_CURRENCY = 'kzt';
const VERSION = 'Vercel WB→Sheets V3 KZT';
const WB_BATCH = 100;
const WB_PARALLEL = 6;
let tokenCache = null;

function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json(body);
}

function b64url(value) {
  return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function getServiceAccount() {
  const raw = String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON не настроен');
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { throw new Error(`Некорректный GOOGLE_SERVICE_ACCOUNT_JSON: ${e.message}`); }
  if (!parsed.client_email || !parsed.private_key) throw new Error('Service Account JSON не содержит client_email/private_key');
  return { email: parsed.client_email, key: String(parsed.private_key).replace(/\\n/g, '\n') };
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
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Google OAuth ${r.status}: ${j.error_description || j.error || 'token error'}`);
  tokenCache = { token: j.access_token, exp: Date.now() + Number(j.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

function rangeName(range) {
  return `'${String(SHEET_NAME).replace(/'/g, "''")}'!${range}`;
}

async function sheetsGet(range) {
  const token = await googleToken();
  const full = rangeName(range);
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}/values/${encodeURIComponent(full)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`, {
    headers: { Authorization: `Bearer ${token}` }, cache: 'no-store'
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Google Sheets GET ${r.status}: ${text.slice(0, 400)}`);
  const j = text ? JSON.parse(text) : {};
  return Array.isArray(j.values) ? j.values : [];
}

async function sheetsPut(range, values) {
  const token = await googleToken();
  const full = rangeName(range);
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}/values/${encodeURIComponent(full)}?valueInputOption=RAW`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ range: full, majorDimension: 'ROWS', values }),
    cache: 'no-store'
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Google Sheets PUT ${r.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

function nmId(value) {
  const s = String(value || '').trim();
  if (/^\d{5,15}$/.test(s)) return Number(s);
  const m = s.match(/\/catalog\/(\d{5,15})(?:\/|\?|$)/i) || s.match(/[?&](?:nm|card|article)=(\d{5,15})(?:&|$)/i);
  return m ? Number(m[1]) : null;
}

function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function userAgent() {
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
}

function wbRequestUrl(ids) {
  const u = new URL(WB_URL);
  u.searchParams.set('appType', '1');
  u.searchParams.set('curr', WB_CURRENCY);
  u.searchParams.set('dest', String(WB_DESTINATION));
  u.searchParams.set('spp', '30');
  u.searchParams.set('hide_vflags', '4294967296');
  u.searchParams.set('hide_dtype', '15');
  u.searchParams.set('mtype', '257');
  u.searchParams.set('lang', 'ru');
  u.searchParams.set('ab_testing', 'false');
  u.searchParams.set('nm', ids.join(';'));
  return u.toString();
}

async function curlGet(url) {
  try {
    const { stdout } = await execFileAsync('curl', [
      '--silent', '--show-error', '--compressed', '--http1.1', '--max-time', '20',
      '--retry', '2', '--retry-delay', '1',
      '-A', userAgent(),
      '-H', 'Accept: application/json, text/plain, */*',
      '-H', 'Accept-Language: ru-RU,ru;q=0.9',
      url
    ], { maxBuffer: 12 * 1024 * 1024, timeout: 25000 });
    return stdout;
  } catch (e) {
    throw new Error(`curl WB: ${e.message}`);
  }
}

async function wbBatch(ids) {
  const url = wbRequestUrl(ids);
  let text = '';
  try {
    text = await curlGet(url);
  } catch (curlError) {
    const r = await fetch(url, { headers: { 'user-agent': userAgent(), accept: 'application/json, text/plain, */*' }, cache: 'no-store' });
    text = await r.text();
    if (!r.ok) throw new Error(`${curlError.message}; fetch HTTP ${r.status}: ${text.slice(0, 100)}`);
  }
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`WB не JSON: ${text.slice(0, 120)}`); }
  const products = Array.isArray(j.products) ? j.products : (Array.isArray(j?.data?.products) ? j.data.products : null);
  if (!products) throw new Error('WB: products отсутствует');
  const map = new Map();
  for (const p of products) {
    const parsed = parseProduct(p);
    if (parsed) map.set(parsed.id, parsed);
  }
  return map;
}

function qty(size) {
  return (Array.isArray(size?.stocks) ? size.stocks : []).reduce((s, x) => s + Math.max(0, Number(x?.qty || 0)), 0);
}

function parseProduct(p) {
  const id = Number(p?.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  const variants = [];
  for (const size of Array.isArray(p?.sizes) ? p.sizes : []) {
    const product = Number(size?.price?.product || 0);
    const logistics = Math.max(0, Number(size?.price?.logistics || 0));
    if (product <= 0) continue;
    let hours = Math.max(0, Number(size?.time1 || 0)) + Math.max(0, Number(size?.time2 || 0));
    if (!hours) {
      const times = (Array.isArray(size?.stocks) ? size.stocks : [])
        .filter(x => Number(x?.qty || 0) > 0)
        .map(x => Math.max(0, Number(x?.time1 || 0)) + Math.max(0, Number(x?.time2 || 0)))
        .filter(Boolean);
      if (times.length) hours = Math.min(...times);
    }
    variants.push({ product, logistics, total: product + logistics, available: qty(size) > 0, hours });
  }
  if (!variants.length) return null;
  const available = variants.filter(v => v.available);
  const pool = available.length ? available : variants;
  const best = pool.reduce((a, b) => b.total < a.total ? b : a);
  return {
    id,
    seller: String(p?.supplier || '').trim(),
    product: best.product / 100,
    logistics: best.logistics / 100,
    price: best.total / 100,
    days: best.hours ? Math.max(1, Math.ceil(best.hours / 24)) : null
  };
}

async function fetchAll(ids) {
  const unique = [...new Set(ids)];
  const batches = chunks(unique, WB_BATCH);
  const products = new Map();
  const errors = new Map();
  for (let i = 0; i < batches.length; i += WB_PARALLEL) {
    const group = batches.slice(i, i + WB_PARALLEL);
    const settled = await Promise.allSettled(group.map(wbBatch));
    settled.forEach((r, idx) => {
      const batch = group[idx];
      if (r.status === 'fulfilled') {
        for (const [id, p] of r.value) products.set(id, p);
        for (const id of batch) if (!r.value.has(id)) errors.set(id, 'Цена не найдена');
      } else {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        for (const id of batch) errors.set(id, msg);
      }
    });
  }
  return { products, errors, batches: batches.length, unique: unique.length };
}

function stamp() {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Almaty', dateStyle: 'short', timeStyle: 'medium' }).format(new Date());
}

function deliveryDate(days) {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Almaty' }).format(new Date(Date.now() + days * 86400000));
}

module.exports = async function handler(req, res) {
  const started = Date.now();
  try {
    const mode = String(req.query?.mode || '').toLowerCase();
    if (mode === 'health') {
      const rows = await sheetsGet('T2:T3');
      return send(res, 200, { ok: true, version: VERSION, googleSheets: true, sampleRows: rows.length, destination: WB_DESTINATION, currency: 'KZT' });
    }
    if (mode === 'probe') {
      const id = Number(req.query?.nm || 598732175);
      const map = await wbBatch([id]);
      return send(res, 200, { ok: true, version: VERSION, destination: WB_DESTINATION, currency: 'KZT', nm: id, snapshot: map.get(id) || null });
    }

    const source = await sheetsGet('T2:Y');
    const rows = source.map(r => Array.from({ length: 6 }, (_, i) => r?.[i] ?? ''));
    const idsByRow = rows.map(r => nmId(r[0]));
    const validIds = idsByRow.filter(x => Number.isInteger(x) && x > 0);
    if (!validIds.length) return send(res, 200, { ok: true, version: VERSION, updated: 0, message: 'WB ссылок нет' });

    const wb = await fetchAll(validIds);
    const ts = stamp();
    let updated = 0, missing = 0, invalid = 0;
    const out = rows.map((r, idx) => {
      const [link, oldPrice, oldSeller, oldDays, oldDate, oldStatus] = r;
      if (!String(link || '').trim()) return [oldPrice, oldSeller, oldDays, oldDate, oldStatus];
      const id = idsByRow[idx];
      if (!id) {
        invalid++;
        return [oldPrice, oldSeller, oldDays, oldDate, `Некорректная ссылка WB; ${VERSION}; ${ts}`];
      }
      const p = wb.products.get(id);
      if (!p) {
        missing++;
        return [oldPrice, oldSeller, oldDays, oldDate, `${wb.errors.get(id) || 'Цена не найдена'}; ${VERSION}; ${ts}`];
      }
      updated++;
      const days = p.days;
      return [
        p.price,
        p.seller || oldSeller,
        days ?? oldDays,
        days ? deliveryDate(days) : oldDate,
        `Обновлено ${VERSION}; валюта=KZT; товар=${p.product}; логистика=${p.logistics}; dest=${WB_DESTINATION}; ${ts}`
      ];
    });

    await sheetsPut(`U2:Y${out.length + 1}`, out);
    return send(res, 200, {
      ok: true, version: VERSION, currency: 'KZT', destination: WB_DESTINATION,
      rows: rows.length, wbLinks: validIds.length, uniqueWb: wb.unique, wbBatches: wb.batches,
      updated, missing, invalidLinks: invalid,
      errors: [...new Set(wb.errors.values())].slice(0, 10),
      durationMs: Date.now() - started, updatedAt: ts
    });
  } catch (e) {
    console.error('wb-sheets-sync-v3 failed', e);
    return send(res, 500, { ok: false, version: VERSION, error: e instanceof Error ? e.message : String(e), durationMs: Date.now() - started });
  }
};
