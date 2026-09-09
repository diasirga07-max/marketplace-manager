const crypto = require('node:crypto');

const DEFAULT_SPREADSHEET_ID = '1dLU5KOi3WBLy3uNEiqGv5rf9ka0OwcEw_RjhDQW3H1E';
const DEFAULT_SHEET_NAME = 'Прайс KASPI';
const WB_CARD_URL = 'https://card.wb.ru/cards/v4/detail';
const WB_GEO_URL = 'https://user-geo-data.wildberries.ru/get-geo-info';
const ASTANA_LAT = 51.169392;
const ASTANA_LON = 71.449074;
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const VERSION = 'Vercel WB→Sheets V1';
const MAX_WB_BATCH = 25;
const WB_PARALLEL_BATCHES = 4;

let tokenCache = null;

function json(res, status, payload) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  return res.status(status).json(payload);
}

function authorized(req) {
  const expected = String(process.env.WB_SYNC_SECRET || process.env.CRON_SECRET || '').trim();
  if (!expected) return true;
  return String(req.headers.authorization || '') === `Bearer ${expected}`;
}

function base64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function serviceAccount() {
  const rawB64 = String(process.env.GOOGLE_SERVICE_ACCOUNT_B64 || '').trim();
  const rawJson = rawB64
    ? Buffer.from(rawB64, 'base64').toString('utf8')
    : String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();

  if (rawJson) {
    let parsed;
    try {
      parsed = JSON.parse(rawJson);
    } catch (error) {
      throw new Error(`GOOGLE_SERVICE_ACCOUNT_JSON/B64: некорректный JSON (${error.message})`);
    }
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error('Google Service Account JSON не содержит client_email/private_key');
    }
    return {
      clientEmail: String(parsed.client_email).trim(),
      privateKey: String(parsed.private_key).replace(/\\n/g, '\n'),
    };
  }

  const clientEmail = String(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim();
  const privateKey = String(process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '')
    .trim()
    .replace(/\\n/g, '\n');
  if (!clientEmail || !privateKey) {
    throw new Error(
      'Не настроен Google Service Account. Добавьте GOOGLE_SERVICE_ACCOUNT_JSON (или B64) в Environment Variables Vercel.'
    );
  }
  return { clientEmail, privateKey };
}

async function fetchTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function googleAccessToken() {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now + 60_000) return tokenCache.token;

  const account = serviceAccount();
  const nowSec = Math.floor(now / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(
    JSON.stringify({
      iss: account.clientEmail,
      scope: GOOGLE_SHEETS_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat: nowSec,
      exp: nowSec + 3600,
    })
  );
  const unsigned = `${header}.${claims}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${base64Url(signer.sign(account.privateKey))}`;

  const response = await fetchTimeout(
    GOOGLE_TOKEN_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    },
    15000
  );

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    throw new Error(
      `Google OAuth HTTP ${response.status}: ${payload.error_description || payload.error || 'access_token не получен'}`
    );
  }

  tokenCache = {
    token: payload.access_token,
    expiresAt: now + Math.max(300, Number(payload.expires_in) || 3600) * 1000,
  };
  return tokenCache.token;
}

async function sheetsRequest(spreadsheetId, path, options = {}) {
  const token = await googleAccessToken();
  const response = await fetchTimeout(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}${path}`,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
      cache: 'no-store',
    },
    20000
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Google Sheets API HTTP ${response.status}: ${text.slice(0, 600)}`);
  }
  return text ? JSON.parse(text) : {};
}

async function readRows(spreadsheetId, sheetName) {
  const escapedSheet = `'${String(sheetName).replace(/'/g, "''")}'`;
  const range = `${escapedSheet}!T2:Y`;
  const payload = await sheetsRequest(
    spreadsheetId,
    `/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`
  );
  return Array.isArray(payload.values) ? payload.values : [];
}

async function writeRows(spreadsheetId, sheetName, values) {
  if (!values.length) return;
  const escapedSheet = `'${String(sheetName).replace(/'/g, "''")}'`;
  const range = `${escapedSheet}!U2:Y${values.length + 1}`;
  await sheetsRequest(
    spreadsheetId,
    `/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    {
      method: 'PUT',
      body: JSON.stringify({ range, majorDimension: 'ROWS', values }),
    }
  );
}

function wbHeaders() {
  return {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'ru-RU,ru;q=0.9',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  };
}

async function resolveAstanaDestination() {
  const configured = Number(process.env.WB_DESTINATION || '');
  const fallback = Number.isInteger(configured) && configured !== 0 ? configured : null;
  const lat = Number(process.env.WB_ASTANA_LAT || ASTANA_LAT);
  const lon = Number(process.env.WB_ASTANA_LON || ASTANA_LON);

  const url = new URL(WB_GEO_URL);
  url.searchParams.set('latitude', lat.toFixed(6));
  url.searchParams.set('longitude', lon.toFixed(6));
  url.searchParams.set('address', 'Astana, Kazakhstan');

  try {
    const response = await fetchTimeout(url, { headers: wbHeaders(), cache: 'no-store' }, 12000);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const xinfo = String(payload && payload.xinfo || '');
    const params = new URLSearchParams(xinfo);
    const dest = Number(params.get('dest'));
    if (!Number.isInteger(dest) || dest === 0) throw new Error('dest отсутствует');
    return dest;
  } catch (error) {
    if (fallback) return fallback;
    throw new Error(
      `Не удалось определить WB GEO Астана (${error.message}). Укажите WB_DESTINATION в Vercel.`
    );
  }
}

function positiveInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

function nonNegativeInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function sizeQty(size) {
  return (Array.isArray(size && size.stocks) ? size.stocks : []).reduce(
    (sum, stock) => sum + nonNegativeInt(stock && stock.qty),
    0
  );
}

function deliveryHours(product, size) {
  const sizeHours = nonNegativeInt(size && size.time1) + nonNegativeInt(size && size.time2);
  if (sizeHours > 0) return sizeHours;

  const productHours = nonNegativeInt(product && product.time1) + nonNegativeInt(product && product.time2);
  if (productHours > 0) return productHours;

  const stocks = Array.isArray(size && size.stocks) ? size.stocks : [];
  const available = stocks.filter((stock) => nonNegativeInt(stock && stock.qty) > 0);
  const pool = available.length ? available : stocks;
  const values = pool
    .map((stock) => nonNegativeInt(stock && stock.time1) + nonNegativeInt(stock && stock.time2))
    .filter((hours) => hours > 0);
  return values.length ? Math.min(...values) : null;
}

function parseProduct(product) {
  const nmId = positiveInt(product && product.id);
  if (!nmId) return null;

  const sizes = Array.isArray(product && product.sizes) ? product.sizes : [];
  const priced = [];
  for (const size of sizes) {
    const productPrice = positiveInt(size && size.price && size.price.product);
    if (!productPrice) continue;
    const logistics = nonNegativeInt(size && size.price && size.price.logistics);
    priced.push({
      size,
      productPrice,
      logistics,
      total: productPrice + logistics,
      available: sizeQty(size) > 0,
    });
  }
  if (!priced.length) return null;

  const available = priced.filter((item) => item.available);
  const pool = available.length ? available : priced;
  const selected = pool.reduce((best, item) => (item.total < best.total ? item : best));
  const hours = deliveryHours(product, selected.size);

  return {
    nmId,
    seller: String(product.supplier || '').trim(),
    productPriceRub: selected.productPrice / 100,
    logisticsRub: selected.logistics / 100,
    finalPriceRub: selected.total / 100,
    deliveryDays: hours && hours > 0 ? Math.max(1, Math.ceil(hours / 24)) : null,
  };
}

async function fetchWbBatch(ids, destination) {
  const url = new URL(WB_CARD_URL);
  url.searchParams.set('appType', '1');
  url.searchParams.set('curr', 'rub');
  url.searchParams.set('dest', String(destination));
  url.searchParams.set('spp', '30');
  url.searchParams.set('hide_vflags', '4294967296');
  url.searchParams.set('hide_dtype', '15');
  url.searchParams.set('mtype', '257');
  url.searchParams.set('lang', 'ru');
  url.searchParams.set('ab_testing', 'false');
  url.searchParams.set('nm', ids.join(';'));

  const response = await fetchTimeout(url, { headers: wbHeaders(), cache: 'no-store' }, 15000);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`WB cards/v4 HTTP ${response.status}: ${text.slice(0, 120)}`);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`WB cards/v4 вернул не JSON: ${text.slice(0, 120)}`);
  }
  const products = Array.isArray(payload && payload.products)
    ? payload.products
    : Array.isArray(payload && payload.data && payload.data.products)
      ? payload.data.products
      : null;
  if (!products) throw new Error('WB cards/v4: неизвестный формат ответа');

  const map = new Map();
  for (const product of products) {
    const parsed = parseProduct(product);
    if (parsed) map.set(parsed.nmId, parsed);
  }
  return map;
}

function chunks(values, size) {
  const result = [];
  for (let i = 0; i < values.length; i += size) result.push(values.slice(i, i + size));
  return result;
}

async function fetchAllWb(ids, destination) {
  const unique = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
  const batches = chunks(unique, MAX_WB_BATCH);
  const snapshots = new Map();
  const errorsById = new Map();

  for (let i = 0; i < batches.length; i += WB_PARALLEL_BATCHES) {
    const group = batches.slice(i, i + WB_PARALLEL_BATCHES);
    const settled = await Promise.allSettled(group.map((batch) => fetchWbBatch(batch, destination)));

    settled.forEach((entry, groupIndex) => {
      const batch = group[groupIndex];
      if (entry.status === 'fulfilled') {
        for (const [id, snapshot] of entry.value) snapshots.set(id, snapshot);
        for (const id of batch) {
          if (!entry.value.has(id)) errorsById.set(id, 'Цена не найдена');
        }
      } else {
        const reason = entry.reason instanceof Error ? entry.reason.message : String(entry.reason);
        for (const id of batch) errorsById.set(id, reason);
      }
    });
  }

  return { snapshots, errorsById };
}

function extractNmId(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (/^\d{5,15}$/.test(text)) return Number(text);
  const patterns = [
    /\/catalog\/(\d{5,15})(?:\/|\?|$)/i,
    /[?&](?:nm|card|article)=(\d{5,15})(?:&|$)/i,
    /\/product\/[^/]+\/(\d{5,15})(?:\/|\?|$)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

function timestampAlmaty() {
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Asia/Almaty',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}:${p.second}`;
}

function deliveryDate(days) {
  const date = new Date(Date.now() + Number(days) * 86400000);
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Asia/Almaty',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${p.day}.${p.month}.${p.year}`;
}

function formatRub(value) {
  return `${new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value)} ₽`;
}

function normalizeRow(row) {
  return Array.from({ length: 6 }, (_, index) => (row && row[index] != null ? row[index] : ''));
}

async function probe(req, res) {
  const nmId = positiveInt(req.query && req.query.nm) || 598732175;
  const destination = await resolveAstanaDestination();
  const map = await fetchWbBatch([nmId], destination);
  return json(res, 200, {
    ok: true,
    mode: 'probe',
    version: VERSION,
    nmId,
    destination,
    snapshot: map.get(nmId) || null,
    checkedAt: timestampAlmaty(),
  });
}

async function sync(req, res) {
  const startedAt = Date.now();
  const spreadsheetId = String(process.env.GOOGLE_SPREADSHEET_ID || DEFAULT_SPREADSHEET_ID).trim();
  const sheetName = String(process.env.GOOGLE_SHEET_NAME || DEFAULT_SHEET_NAME).trim();
  const timestamp = timestampAlmaty();

  const source = await readRows(spreadsheetId, sheetName);
  const rows = source.map(normalizeRow);
  const rowIds = rows.map((row) => extractNmId(row[0]));
  const ids = rowIds.filter((id) => Number.isInteger(id) && id > 0);

  if (!ids.length) {
    return json(res, 200, {
      ok: true,
      version: VERSION,
      updated: 0,
      message: 'В колонке T нет ссылок Wildberries',
      durationMs: Date.now() - startedAt,
    });
  }

  const destination = await resolveAstanaDestination();
  const { snapshots, errorsById } = await fetchAllWb(ids, destination);

  let updated = 0;
  let missing = 0;
  let invalidLinks = 0;
  const output = rows.map((row, index) => {
    const oldPrice = row[1] || '';
    const oldSeller = row[2] || '';
    const oldDays = row[3] || '';
    const oldDate = row[4] || '';
    const oldStatus = row[5] || '';
    const link = String(row[0] || '').trim();

    if (!link) return [oldPrice, oldSeller, oldDays, oldDate, oldStatus];

    const nmId = rowIds[index];
    if (!nmId) {
      invalidLinks += 1;
      return [
        oldPrice,
        oldSeller,
        oldDays,
        oldDate,
        `Некорректная ссылка WB; ${VERSION}; ${timestamp}`,
      ];
    }

    const snapshot = snapshots.get(nmId);
    if (!snapshot) {
      missing += 1;
      const reason = errorsById.get(nmId) || 'Цена не найдена';
      return [
        oldPrice,
        oldSeller,
        oldDays,
        oldDate,
        `${reason}; ${VERSION}; ${timestamp}`,
      ];
    }

    updated += 1;
    const days = snapshot.deliveryDays;
    return [
      formatRub(snapshot.finalPriceRub),
      snapshot.seller || oldSeller,
      days != null ? days : oldDays,
      days != null ? deliveryDate(days) : oldDate,
      [
        `Обновлено ${VERSION}`,
        'card.v4 batch',
        `товар=${snapshot.productPriceRub}`,
        `логистика=${snapshot.logisticsRub}`,
        `dest=${destination}`,
        timestamp,
      ].join('; '),
    ];
  });

  await writeRows(spreadsheetId, sheetName, output);

  const uniqueErrors = [...new Set(errorsById.values())];
  return json(res, 200, {
    ok: true,
    version: VERSION,
    spreadsheetId,
    sheetName,
    destination,
    rows: rows.length,
    wbLinks: ids.length,
    updated,
    missing,
    invalidLinks,
    errors: uniqueErrors.slice(0, 10),
    durationMs: Date.now() - startedAt,
    updatedAt: timestamp,
  });
}

module.exports = async function handler(req, res) {
  if (!authorized(req)) return json(res, 401, { ok: false, error: 'Unauthorized' });

  try {
    if (String(req.query && req.query.probe || '') === '1') {
      return await probe(req, res);
    }
    return await sync(req, res);
  } catch (error) {
    console.error('wb-sheets-sync failed', error);
    return json(res, 500, {
      ok: false,
      version: VERSION,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
