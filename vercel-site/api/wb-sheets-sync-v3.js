const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID || '1dLU5KOi3WBLy3uNEiqGv5rf9ka0OwcEw_RjhDQW3H1E';
const SHEET_NAME = process.env.GOOGLE_SHEET_NAME || 'Прайс KASPI';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const WB_URLS = [
  'https://card.wb.ru/cards/v4/detail',
  'https://card.wb.ru/cards/v2/detail'
];
const WB_SEARCH_URLS = [
  'https://search.wb.ru/exactmatch/ru/common/v18/search',
  'https://search.wb.ru/exactmatch/ru/common/v13/search'
];
const WB_DESTINATION = Number(process.env.WB_DESTINATION || 82);
const WB_CURRENCY = 'kzt';
const VERSION = 'Vercel WB→Sheets V3.5.1 Server KZT';
const WB_BATCH = 25;
const WB_PARALLEL = 2;
const WB_PAUSE_MS = 150;
const RUN_BUDGET_MS = 90000;
const RETRYABLE_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);
let tokenCache = null;
let impitPromise = null;

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
  const full = rangeName(range);
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const token = await googleToken();
    try {
      const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}/values/${encodeURIComponent(full)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`, {
        headers: { Authorization: `Bearer ${token}` }, cache: 'no-store'
      });
      const text = await r.text();
      if (r.ok) {
        const j = text ? JSON.parse(text) : {};
        return Array.isArray(j.values) ? j.values : [];
      }
      lastErr = new Error(`Google Sheets GET ${r.status}: ${text.slice(0, 400)}`);
      if (!RETRYABLE_HTTP.has(r.status)) throw lastErr;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (attempt === 3) throw lastErr;
    }
    await sleep(500 * (2 ** attempt) + Math.floor(Math.random() * 250));
  }
  throw lastErr || new Error('Google Sheets GET failed');
}

async function sheetsPut(range, values) {
  const full = rangeName(range);
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const token = await googleToken();
    try {
      const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}/values/${encodeURIComponent(full)}?valueInputOption=RAW`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ range: full, majorDimension: 'ROWS', values }),
        cache: 'no-store'
      });
      const text = await r.text();
      if (r.ok) return text ? JSON.parse(text) : {};
      lastErr = new Error(`Google Sheets PUT ${r.status}: ${text.slice(0, 400)}`);
      if (!RETRYABLE_HTTP.has(r.status)) throw lastErr;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (attempt === 3) throw lastErr;
    }
    await sleep(500 * (2 ** attempt) + Math.floor(Math.random() * 250));
  }
  throw lastErr || new Error('Google Sheets PUT failed');
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

function wbRequestUrl(ids, base) {
  const u = new URL(base);
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

async function impitGet(url) {
  if (!impitPromise) {
    impitPromise = import('impit').then(({ Impit }) => new Impit({ browser: 'chrome' }));
  }
  const client = await impitPromise;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await client.fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json, text/plain, */*',
          'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8',
          referer: 'https://www.wildberries.ru/',
          origin: 'https://www.wildberries.ru',
          'cache-control': 'no-cache',
          pragma: 'no-cache'
        },
        redirect: 'follow'
      });
      const text = await r.text();
      if (r.ok) return text;
      lastErr = new Error(`HTTP ${r.status}: ${text.slice(0, 160)}`);
      if (!RETRYABLE_HTTP.has(r.status) && r.status !== 403) throw lastErr;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (attempt === 2) break;
    }
    await sleep(700 * (2 ** attempt) + Math.floor(Math.random() * 350));
  }
  throw new Error(`impit WB: ${lastErr ? lastErr.message : 'request failed'}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function curlGet(url) {
  try {
    const { stdout } = await execFileAsync('curl', [
      '--silent', '--show-error', '--compressed', '--http1.1', '--max-time', '20',
      '--retry', '2', '--retry-delay', '1', '--retry-all-errors',
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

async function wbBatch(ids, fastMode = false) {
  const attempts=[];
  let j=null, products=null;
  for (const base of WB_URLS) {
    const url=wbRequestUrl(ids,base);
    try {
      let text='';
      try {
        const r=await fetch(url,{
          headers:{'user-agent':userAgent(),accept:'application/json, text/plain, */*','accept-language':'ru-RU,ru;q=0.9',referer:'https://www.wildberries.ru/',origin:'https://www.wildberries.ru'},
          cache:'no-store',
          signal: AbortSignal.timeout(fastMode ? 8000 : 15000)
        });
        text=await r.text();
        if(!r.ok) throw new Error('HTTP '+r.status+': '+text.slice(0,160));
      } catch (fetchErr) {
        attempts.push(base+': native '+String(fetchErr.message||fetchErr));
        if (fastMode) continue;
        try {
          text = await impitGet(url);
        } catch (impitErr) {
          attempts.push(base+': '+String(impitErr.message||impitErr));
          text = await curlGet(url);
        }
      }
      const trimmed=String(text||'').trim();
      if(!trimmed.startsWith('{')&&!trimmed.startsWith('[')) throw new Error('WB не JSON: '+trimmed.slice(0,180));
      j=JSON.parse(trimmed);
      products=Array.isArray(j.products)?j.products:(Array.isArray(j?.data?.products)?j.data.products:null);
      if(products) break;
      attempts.push(base+': products отсутствует');
    } catch(e) { attempts.push(base+': '+String(e.message||e)); }
  }
  if(!products && !fastMode){
    for(const base of WB_SEARCH_URLS){
      try{
        const u=new URL(base);
        u.searchParams.set('appType','1');u.searchParams.set('curr',WB_CURRENCY);u.searchParams.set('dest',String(WB_DESTINATION));u.searchParams.set('spp','30');u.searchParams.set('resultset','catalog');u.searchParams.set('query',ids.join(' '));
        const text=await impitGet(u.toString());
        const trimmed=String(text||'').trim();
        if(!trimmed.startsWith('{')&&!trimmed.startsWith('[')) throw new Error('WB search не JSON: '+trimmed.slice(0,180));
        j=JSON.parse(trimmed);
        products=Array.isArray(j.products)?j.products:(Array.isArray(j?.data?.products)?j.data.products:null);
        if(products) break;
        attempts.push(base+': products отсутствует');
      }catch(e){attempts.push(base+': '+String(e.message||e));}
    }
  }
  if (!products) throw new Error('WB API недоступен: '+attempts.slice(0,6).join(' | '));
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

async function fetchAll(ids, fastMode = false) {
  const unique = [...new Set(ids)];
  const batches = chunks(unique, WB_BATCH);
  const products = new Map();
  const errors = new Map();
  const deadline = Date.now() + (fastMode ? 48000 : RUN_BUDGET_MS);

  for (let i = 0; i < batches.length; i += WB_PARALLEL) {
    if (Date.now() >= deadline) {
      for (const batch of batches.slice(i)) {
        for (const id of batch) errors.set(id, 'Не обработано в этом запуске: лимит времени');
      }
      break;
    }

    const group = batches.slice(i, i + WB_PARALLEL);
    const settled = await Promise.allSettled(group.map(batch => wbBatch(batch, fastMode)));
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
    if (i + WB_PARALLEL < batches.length) await sleep(WB_PAUSE_MS);
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
      return send(res, 200, { ok: true, version: VERSION, googleSheets: true, sampleRows: rows.length, destination: WB_DESTINATION, currency: 'KZT', serverSync: true, browserWrites: false });
    }
    if (mode === 'count') {
      const rows = await sheetsGet('T2:T');
      return send(res, 200, { ok: true, version: VERSION, rows: rows.length, destination: WB_DESTINATION, currency: 'KZT' });
    }
    if (mode === 'browser-source') {
      return send(res, 200, {
        ok: true,
        version: VERSION,
        destination: WB_DESTINATION,
        currency: 'KZT',
        ids: [],
        items: [],
        serverSync: true,
        message: 'WB prices are updated by Vercel server sync'
      });
    }
    if (mode === 'browser-report') {
      if (String(req.method || 'GET').toUpperCase() !== 'POST') return send(res, 405, { ok: false, error: 'POST required' });
      if (String(req.headers?.['x-grants-book-wb-bridge'] || '') !== '1') return send(res, 403, { ok: false, error: 'Chrome bridge required' });
      const report = req.body && typeof req.body === 'object' ? req.body : {};
      console.error('WB Chrome bridge report', JSON.stringify(report).slice(0, 8000));
      return send(res, 200, { ok: true, received: true, version: VERSION, at: stamp() });
    }
    if (mode === 'browser-ingest') {
      if (String(req.method || 'GET').toUpperCase() !== 'POST') return send(res, 405, { ok: false, error: 'POST required' });
      if (String(req.headers?.['x-grants-book-wb-bridge'] || '') !== '1') return send(res, 403, { ok: false, error: 'Chrome bridge required' });
      return send(res, 200, {
        ok: true,
        skipped: true,
        updated: 0,
        version: VERSION,
        message: 'Vercel server sync is authoritative; Chrome WB writes are disabled'
      });
      return send(res, 200, { ok: true, skipped: true, updated: 0, version: VERSION, serverSync: true, message: 'Chrome writes disabled; Vercel server sync is authoritative' });

      const incoming = Array.isArray(req.body?.snapshots) ? req.body.snapshots : [];
      const byId = new Map();
      for (const item of incoming) {
        const id = Number(item?.id);
        const price = Number(item?.price);
        if (!Number.isInteger(id) || id <= 0 || !Number.isFinite(price) || price <= 0 || price > 100000000) continue;
        byId.set(id, {
          id,
          price,
          seller: String(item?.seller || '').slice(0, 200),
          product: Math.max(0, Number(item?.product || 0)),
          logistics: Math.max(0, Number(item?.logistics || 0)),
          days: Number.isFinite(Number(item?.days)) && Number(item.days) > 0 ? Math.min(90, Math.ceil(Number(item.days))) : null
        });
      }
      if (!byId.size) return send(res, 400, { ok: false, error: 'Нет корректных цен WB' });

      const source = await sheetsGet('T2:Y');
      const rows = source.map(r => Array.from({ length: 6 }, (_, i) => r?.[i] ?? ''));
      const idsByRow = rows.map(r => nmId(r[0]));
      const allowed = new Set(idsByRow.filter(x => Number.isInteger(x) && x > 0));
      for (const id of [...byId.keys()]) if (!allowed.has(id)) byId.delete(id);
      if (!byId.size) return send(res, 400, { ok: false, error: 'Переданные товары отсутствуют в листе' });

      const ts = stamp();
      let updated = 0;
      const out = rows.map((r, idx) => {
        const [link, oldPrice, oldSeller, oldDays, oldDate, oldStatus] = r;
        if (!String(link || '').trim()) return [oldPrice, oldSeller, oldDays, oldDate, oldStatus];
        const id = idsByRow[idx];
        const p = byId.get(id);
        if (!p) {
          return [
            oldPrice,
            oldSeller,
            oldDays,
            oldDate,
            `Цена WB сейчас не найдена через Chrome; ${VERSION}; dest=${WB_DESTINATION}; ${ts}`
          ];
        }
        updated++;
        const days = p.days;
        return [
          p.price,
          p.seller || oldSeller,
          days ?? oldDays,
          days ? deliveryDate(days) : oldDate,
          `Обновлено через Chrome; ${VERSION}; валюта=KZT; товар=${p.product}; логистика=${p.logistics}; dest=${WB_DESTINATION}; ${ts}`
        ];
      });

      await sheetsPut(`U2:Y${out.length + 1}`, out);
      return send(res, 200, { ok: true, version: VERSION, updated, received: incoming.length, accepted: byId.size, updatedAt: ts });
    }
    if (mode === 'probe') {
      const id = Number(req.query?.nm || 598732175);
      const map = await wbBatch([id]);
      return send(res, 200, { ok: true, version: VERSION, destination: WB_DESTINATION, currency: 'KZT', nm: id, snapshot: map.get(id) || null });
    }

    const partCount = Number(req.query?.parts || 1);
    const partIndex = Number(req.query?.part || 0);
    if (!Number.isInteger(partCount) || partCount < 1 || partCount > 64 ||
        !Number.isInteger(partIndex) || partIndex < 0 || partIndex >= partCount) {
      return send(res, 400, { ok: false, version: VERSION, error: 'Некорректные part/parts' });
    }

    let source;
    let startIndex = 0;
    let endIndex = 0;
    let totalRows = 0;

    if (partCount > 1) {
      const suppliedRows = Number(req.query?.rows || 0);
      totalRows = Number.isInteger(suppliedRows) && suppliedRows > 0
        ? suppliedRows
        : (await sheetsGet('T2:T')).length;

      startIndex = Math.floor(totalRows * partIndex / partCount);
      endIndex = Math.floor(totalRows * (partIndex + 1) / partCount);

      if (endIndex <= startIndex) {
        return send(res, 200, { ok: true, version: VERSION, part: partIndex, parts: partCount, rows: 0, updated: 0 });
      }

      const sheetStart = startIndex + 2;
      const sheetEnd = endIndex + 1;
      source = await sheetsGet(`T${sheetStart}:Y${sheetEnd}`);
    } else {
      source = await sheetsGet('T2:Y');
      totalRows = source.length;
      endIndex = source.length;
    }

    const rows = source.map(r => Array.from({ length: 6 }, (_, i) => r?.[i] ?? ''));
    const idsByRow = rows.map(r => nmId(r[0]));
    const validIds = idsByRow.filter(x => Number.isInteger(x) && x > 0);
    if (!validIds.length) return send(res, 200, { ok: true, version: VERSION, updated: 0, message: 'WB ссылок нет' });

    const fastMode = String(req.query?.fast || '') === '1';
    const wb = await fetchAll(validIds, fastMode);
    if (!wb.products.size && wb.errors.size) {
      return send(res, 200, {
        ok: true,
        version: VERSION,
        temporaryUnavailable: true,
        preservedLastKnownPrices: true,
        fastMode,
        part: partIndex,
        parts: partCount,
        rowStart: startIndex + 2,
        rowEnd: startIndex + rows.length + 1,
        rows: rows.length,
        wbLinks: validIds.length,
        updated: 0,
        errors: [...new Set(wb.errors.values())].slice(0, 5),
        durationMs: Date.now() - started,
        message: 'WB временно не вернул товары для этой части; последние цены сохранены'
      });
    }
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
        return [
          oldPrice,
          oldSeller,
          oldDays,
          oldDate,
          `Vercel проверил WB, актуальная цена не получена; сохранена последняя цена; ${VERSION}; ${ts}`
        ];
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

    await sheetsPut(`U${startIndex + 2}:Y${startIndex + out.length + 1}`, out);
    return send(res, 200, {
      ok: true, version: VERSION, currency: 'KZT', destination: WB_DESTINATION,
      fastMode, part: partIndex, parts: partCount, rowStart: startIndex + 2, rowEnd: startIndex + rows.length + 1,
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
