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
  'https://search.wb.ru/exactmatch/ru/common/v4/search',
  'https://search.wb.ru/exactmatch/ru/common/v9/search',
  'https://www.wildberries.ru/__internal/search/exactmatch/ru/common/v18/search',
  'https://search.wb.ru/exactmatch/ru/common/v18/search'
];
const WB_DESTINATION = 234; // Kazakhstan WB destination
const WB_CURRENCY = 'kzt';
const WB_PROXY_URLS = parseProxyList(process.env.WB_PROXY_URLS || process.env.WB_PROXY_URL || '');
const WB_UNBLOCKER_PROXY_URLS = parseProxyList(process.env.WB_UNBLOCKER_PROXY_URLS || process.env.WB_UNBLOCKER_PROXY_URL || '');
const VERSION = 'Vercel WB→Sheets V3.6.0 Server-only KZ dest=234 Financial Guard';
const WB_BATCH = 10;
const WB_PARALLEL = 2;
const WB_PAUSE_MS = 350;
const RUN_BUDGET_MS = 90000;
const MIN_PROVIDER_SUCCESS_RATIO = 0.30;
const PRICE_JUMP_UP_RATIO = 2.5;
const PRICE_JUMP_DOWN_RATIO = 0.85;
const CONFIRM_TOLERANCE = 0.02;
const MIN_WB_TO_KASPI_RATIO = 0.25;
const REQUIRED_DROP_CONFIRMATIONS = 3;
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

function normalizeProxyEntry(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (/^(?:https?|socks4|socks5):\/\//i.test(s)) return s;

  // Common provider export: host:port:username:password
  const four = s.match(/^([^:\s]+):(\d+):([^:\s]+):(.+)$/);
  if (four) {
    const [, host, port, username, password] = four;
    return `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
  }

  // Common proxy URL without an explicit scheme: username:password@host:port
  if (/^[^\s@]+@[^:\s]+:\d+$/.test(s)) return `http://${s}`;

  // Bare host:port
  if (/^[^:\s]+:\d+$/.test(s)) return `http://${s}`;

  return s;
}

function parseProxyList(value) {
  return String(value || '')
    .split(/[\n,;]+/)
    .map(normalizeProxyEntry)
    .filter(Boolean);
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
  for (let attempt = 0; attempt < 2; attempt++) {
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
        redirect: 'follow',
        signal: AbortSignal.timeout(8000)
      });
      const text = await r.text();
      if (r.ok) return text;
      lastErr = new Error(`HTTP ${r.status}: ${text.slice(0, 160)}`);
      if (!RETRYABLE_HTTP.has(r.status) && r.status !== 403) throw lastErr;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (attempt === 1) break;
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
      '--silent', '--show-error', '--fail-with-body', '--compressed', '--http1.1', '--max-time', '12',
      '--retry', '1', '--retry-delay', '1', '--retry-all-errors',
      '-A', userAgent(),
      '-H', 'Accept: application/json, text/plain, */*',
      '-H', 'Accept-Language: ru-RU,ru;q=0.9',
      url
    ], { maxBuffer: 12 * 1024 * 1024, timeout: 15000 });
    return stdout;
  } catch (e) {
    throw new Error(`curl WB: ${e.message}`);
  }
}

async function proxyCurlGet(url, pool = WB_PROXY_URLS, label = 'WB residential proxy') {
  if (!pool.length) throw new Error(`${label} не настроен`);

  const failures = [];
  for (let i = 0; i < pool.length; i++) {
    const proxy = pool[i];
    try {
      const { stdout } = await execFileAsync('curl', [
        '--silent', '--show-error', '--fail-with-body', '--compressed', '--http1.1',
        '--max-time', '12',
        '--connect-timeout', '5',
        '--retry', '1', '--retry-delay', '1', '--retry-all-errors',
        '--proxy', proxy,
        '-A', userAgent(),
        '-H', 'Accept: application/json, text/plain, */*',
        '-H', 'Accept-Language: ru-RU,ru;q=0.9',
        '-H', 'Referer: https://www.wildberries.ru/',
        url
      ], { maxBuffer: 12 * 1024 * 1024, timeout: 16000 });

      const text = String(stdout || '').trim();
      if (!text) throw new Error('пустой ответ');
      return text;
    } catch (_) {
      failures.push(`${label}#${i + 1}: request failed`);
    }
  }
  throw new Error(failures.join(' | '));
}


const WB_BASKET_HOSTS = Array.from({length: 50}, (_, i) => `basket-${String(i + 1).padStart(2, '0')}.wbbasket.ru`);
const wbBasketHostCache = new Map();

async function resolveBasketHost(id, hintedHost = '') {
  const nm = Number(id);
  if (!Number.isInteger(nm) || nm <= 0) throw new Error('Некорректный nm для basket');
  const vol = Math.floor(nm / 100000);
  const part = Math.floor(nm / 1000);

  if (hintedHost && /(?:^|\.)basket-\d+\.wbbasket\.ru$/i.test(hintedHost)) {
    wbBasketHostCache.set(vol, hintedHost);
    return hintedHost;
  }
  if (wbBasketHostCache.has(vol)) return wbBasketHostCache.get(vol);

  const path = `/vol${vol}/part${part}/${nm}/info/ru/card.json`;
  for (let i = 0; i < WB_BASKET_HOSTS.length; i += 8) {
    const group = WB_BASKET_HOSTS.slice(i, i + 8);
    const results = await Promise.allSettled(group.map(async host => {
      const r = await fetch(`https://${host}${path}`, {
        method: 'HEAD',
        cache: 'no-store',
        signal: AbortSignal.timeout(4000)
      });
      return {host, ok:r.ok, status:r.status};
    }));
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.ok) {
        wbBasketHostCache.set(vol, r.value.host);
        return r.value.host;
      }
    }
  }
  throw new Error('Basket host не найден для '+nm);
}

function parseBasketPriceHistory(payload) {
  if (!Array.isArray(payload) || !payload.length) return null;
  const points = payload
    .filter(x => x && typeof x === 'object' && x.price && typeof x.price === 'object')
    .map(x => ({dt:x.dt || x.date || '', price:x.price}))
    .filter(x => Object.keys(x.price).length);
  if (!points.length) return null;
  const last = points[points.length - 1];
  return {last, points:points.slice(-5)};
}


function basketHostFromUrl(value) {
  try {
    const u = new URL(String(value || '').trim());
    return /(?:^|\.)basket-\d+\.wbbasket\.ru$/i.test(u.hostname) ? u.hostname : '';
  } catch (_) {
    return '';
  }
}

function median(values) {
  const xs = values.filter(Number.isFinite).sort((a,b)=>a-b);
  if (!xs.length) return null;
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : (xs[m-1] + xs[m]) / 2;
}

async function wbBasketPriceProbe(id, hintedHost = '') {
  const nm = Number(id);
  const vol = Math.floor(nm / 100000);
  const part = Math.floor(nm / 1000);
  const host = await resolveBasketHost(nm, hintedHost);
  const base = `https://${host}/vol${vol}/part${part}/${nm}/info`;

  const [cardResult, historyResult] = await Promise.allSettled([
    fetch(base + '/ru/card.json', {cache:'no-store', signal:AbortSignal.timeout(8000)})
      .then(async r => ({status:r.status, ok:r.ok, body:await r.json().catch(()=>null)})),
    fetch(base + '/price-history.json', {cache:'no-store', signal:AbortSignal.timeout(8000)})
      .then(async r => ({status:r.status, ok:r.ok, body:await r.json().catch(()=>null)}))
  ]);

  const card = cardResult.status === 'fulfilled' ? cardResult.value : null;
  const history = historyResult.status === 'fulfilled' ? historyResult.value : null;
  const parsed = history?.ok ? parseBasketPriceHistory(history.body) : null;

  return {
    ok:Boolean(parsed),
    id:nm,
    host,
    cardStatus:card?.status || 0,
    historyStatus:history?.status || 0,
    card:card?.body ? {
      nm_id: card.body.nm_id ?? card.body.nmId ?? card.body.id ?? null,
      imt_id: card.body.imt_id ?? card.body.imtId ?? null,
      name: card.body.imt_name ?? card.body.name ?? null
    } : null,
    priceHistory:parsed
  };
}

async function wbPageProbe(id, host = 'www.wildberries.ru') {
  const url = `https://${host}/catalog/${id}/detail.aspx`;
  const attempts = [];
  for (const method of ['fetch','impit']) {
    try {
      let text = '';
      let status = 0;
      if (method === 'fetch') {
        const r = await fetch(url, {
          headers: {
            'user-agent': userAgent(),
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8'
          },
          cache: 'no-store',
          redirect: 'follow',
          signal: AbortSignal.timeout(12000)
        });
        status = r.status;
        text = await r.text();
        if (!r.ok) throw new Error('HTTP '+r.status);
      } else {
        if (!impitPromise) impitPromise = import('impit').then(({ Impit }) => new Impit({ browser: 'chrome' }));
        const client = await impitPromise;
        const r = await client.fetch(url, {
          method: 'GET',
          headers: {
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8'
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(12000)
        });
        status = r.status;
        text = await r.text();
        if (!r.ok) throw new Error('HTTP '+r.status);
      }
      const sample = String(text || '').slice(0, 800);
      const kzt = [...String(text||'').matchAll(/([0-9][0-9\s\u00a0]{1,12})\s*(?:₸|KZT|тг)/gi)]
        .slice(0, 10).map(m => m[0]);
      const jsonPrice = [...String(text||'').matchAll(/"(?:price|salePriceU|priceU|finalPrice)"\s*:\s*"?([0-9]{2,12})/gi)]
        .slice(0, 20).map(m => m[0]);
      return { ok:true, url, method, status, length:String(text||'').length, kzt, jsonPrice, sample };
    } catch (e) {
      attempts.push(method+': '+String(e?.message||e));
    }
  }
  return { ok:false, url, attempts };
}

async function proxyHealthCheck() {
  const pools = [
    { name: 'residential', items: WB_PROXY_URLS },
    { name: 'unblocker', items: WB_UNBLOCKER_PROXY_URLS }
  ];
  const total = pools.reduce((sum, x) => sum + x.items.length, 0);
  if (!total) return { configured: false, ok: false, count: 0, connectivity: 0, wbWorking: 0, channels: [] };

  let connectivity = 0;
  let wbWorking = 0;
  const channels = [];
  const testUrl = wbRequestUrl([598732175], WB_URLS[0]);

  for (const pool of pools) {
    for (let i = 0; i < pool.items.length; i++) {
      const proxy = pool.items[i];
      let neutralOk = false;
      let wbOk = false;
      try {
        await execFileAsync('curl', [
          '--silent', '--show-error', '--fail-with-body',
          '--connect-timeout', '4', '--max-time', '8',
          '--proxy', proxy,
          'https://api.ipify.org?format=json'
        ], { maxBuffer: 256 * 1024, timeout: 10000 });
        neutralOk = true;
        connectivity++;
      } catch (_) {}

      if (neutralOk) {
        try {
          const text = await proxyCurlGet(testUrl, [proxy], pool.name);
          const json = JSON.parse(String(text || '').trim());
          const products = Array.isArray(json?.products) ? json.products : (Array.isArray(json?.data?.products) ? json.data.products : []);
          wbOk = products.some(p => Number(p?.id) === 598732175);
          if (wbOk) wbWorking++;
        } catch (_) {}
      }

      channels.push({ type: pool.name, index: i + 1, connectivity: neutralOk, wildberries: wbOk });
    }
  }

  return { configured: true, ok: wbWorking > 0, count: total, connectivity, wbWorking, channels };
}

async function wbBatch(ids, fastMode = false) {
  const attempts = [];
  let j = null, products = null;

  for (const base of WB_URLS) {
    const url = wbRequestUrl(ids, base);
    let text = '';

    try {
      // Production path is server-only. Prefer a residential/unblocker route because
      // Wildberries currently blocks Vercel datacenter egress with 403/498.
      if (WB_PROXY_URLS.length) {
        try {
          text = await proxyCurlGet(url, WB_PROXY_URLS, 'residential');
        } catch (e) {
          attempts.push(base + ': residential ' + String(e.message || e));
        }
      }

      if (!text && WB_UNBLOCKER_PROXY_URLS.length) {
        try {
          text = await proxyCurlGet(url, WB_UNBLOCKER_PROXY_URLS, 'unblocker');
        } catch (e) {
          attempts.push(base + ': unblocker ' + String(e.message || e));
        }
      }

      // Direct Vercel egress is kept only as a last-resort fallback/diagnostic.
      if (!text) {
        if (fastMode) {
          try {
            const r = await fetch(url, {
              headers: {
                'user-agent': userAgent(),
                accept: 'application/json, text/plain, */*',
                'accept-language': 'ru-RU,ru;q=0.9',
                referer: 'https://www.wildberries.ru/'
              },
              cache: 'no-store',
              signal: AbortSignal.timeout(5000)
            });
            text = await r.text();
            if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + text.slice(0, 160));
          } catch (e) {
            attempts.push(base + ': direct ' + String(e.message || e));
            text = '';
          }
        } else {
          try {
            text = await impitGet(url);
          } catch (e) {
            attempts.push(base + ': impit-direct ' + String(e.message || e));
            try {
              text = await curlGet(url);
            } catch (curlErr) {
              attempts.push(base + ': curl-direct ' + String(curlErr.message || curlErr));
              text = '';
            }
          }
        }
      }

      const trimmed = String(text || '').trim();
      if (!trimmed) continue;
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) throw new Error('WB не JSON: ' + trimmed.slice(0, 180));
      j = JSON.parse(trimmed);
      products = Array.isArray(j.products) ? j.products : (Array.isArray(j?.data?.products) ? j.data.products : null);
      if (products && products.length) break;
      attempts.push(base + ': products отсутствует');
    } catch (e) {
      attempts.push(base + ': ' + String(e.message || e));
    }
  }

  if ((!products || !products.length) && !fastMode) {
    for (const base of WB_SEARCH_URLS) {
      try {
        const u = new URL(base);
        u.searchParams.set('appType', '1');
        u.searchParams.set('curr', WB_CURRENCY);
        u.searchParams.set('dest', String(WB_DESTINATION));
        u.searchParams.set('spp', '30');
        u.searchParams.set('resultset', 'catalog');
        u.searchParams.set('query', ids.join(' '));

        let text = '';
        if (WB_PROXY_URLS.length) {
          try { text = await proxyCurlGet(u.toString(), WB_PROXY_URLS, 'residential'); } catch (e) { attempts.push(base + ': residential ' + String(e.message || e)); }
        }
        if (!text && WB_UNBLOCKER_PROXY_URLS.length) {
          try { text = await proxyCurlGet(u.toString(), WB_UNBLOCKER_PROXY_URLS, 'unblocker'); } catch (e) { attempts.push(base + ': unblocker ' + String(e.message || e)); }
        }
        if (!text) text = await impitGet(u.toString());

        const trimmed = String(text || '').trim();
        if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) throw new Error('WB search не JSON: ' + trimmed.slice(0, 180));
        j = JSON.parse(trimmed);
        products = Array.isArray(j.products) ? j.products : (Array.isArray(j?.data?.products) ? j.data.products : null);
        if (products && products.length) break;
        attempts.push(base + ': products отсутствует');
      } catch (e) {
        attempts.push(base + ': ' + String(e.message || e));
      }
    }
  }

  if (!products || !products.length) {
    throw new Error('WB API недоступен: ' + attempts.slice(0, 8).join(' | '));
  }

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
  const seller = String(p?.supplier || '').trim();
  if (/^Стать продавцом$/i.test(seller)) return null;
  return {
    id,
    seller,
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

  // Grouped WB responses sometimes silently omit individual cards.
  // Retry omitted cards one-by-one while there is still execution budget.
  if (!fastMode) {
    const missingIds = [...errors.entries()]
      .filter(([, msg]) => String(msg) === 'Цена не найдена')
      .map(([id]) => id)
      .filter(id => !products.has(id));

    for (let i = 0; i < missingIds.length && Date.now() < deadline - 5000; i += 4) {
      const group = missingIds.slice(i, i + 4);
      const settled = await Promise.allSettled(group.map(id => wbBatch([id], false)));
      settled.forEach((r, idx) => {
        const id = group[idx];
        if (r.status === 'fulfilled' && r.value.has(id)) {
          products.set(id, r.value.get(id));
          errors.delete(id);
        } else if (r.status === 'rejected') {
          errors.set(id, r.reason instanceof Error ? r.reason.message : String(r.reason));
        }
      });
    }
  }

  return { products, errors, batches: batches.length, unique: unique.length };
}

function stamp() {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Almaty', dateStyle: 'short', timeStyle: 'medium' }).format(new Date());
}

function deliveryDate(days) {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Almaty' }).format(new Date(Date.now() + days * 86400000));
}

function numberOrNull(value) {
  const n = Number(String(value ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function pendingCandidate(status) {
  const s = String(status || '');
  const m = s.match(/Кандидат WB=([0-9]+(?:[.,][0-9]+)?)/i);
  const c = s.match(/подтверждений=(\d+)/i);
  return {
    price: m ? numberOrNull(m[1]) : null,
    count: c ? Math.max(0, Number(c[1]) || 0) : 0
  };
}

function nearlySame(a, b) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= Math.max(1, Math.abs(b) * CONFIRM_TOLERANCE);
}

module.exports = async function handler(req, res) {
  const started = Date.now();
  try {
    const mode = String(req.query?.mode || '').toLowerCase();
    if (mode === 'health') {
      const rows = await sheetsGet('T2:T3');
      return send(res, 200, { ok: true, version: VERSION, googleSheets: true, sampleRows: rows.length, destination: WB_DESTINATION, currency: 'KZT', serverSync: true, serverOnly: true, browserFallback: false, browserWrites: false, proxyConfigured: (WB_PROXY_URLS.length + WB_UNBLOCKER_PROXY_URLS.length) > 0, proxyCount: WB_PROXY_URLS.length, unblockerCount: WB_UNBLOCKER_PROXY_URLS.length });
    }
    if (mode === 'proxy-health') {
      const result = await proxyHealthCheck();
      return send(res, result.ok ? 200 : 503, { ok: result.ok, version: VERSION, proxyConfigured: result.configured, proxyCount: result.count, connectivityCount: result.connectivity || 0, workingProxyCount: result.wbWorking || 0, channels: result.channels || [] });
    }
    if (mode === 'page-probe') {
      const id = Number(req.query?.nm || 482580841);
      const host = String(req.query?.host || 'www.wildberries.ru');
      const result = await wbPageProbe(id, host);
      return send(res, result.ok ? 200 : 502, { version: VERSION, ...result });
    }
    if (mode === 'cdn-probe') {
      const id = Number(req.query?.nm || 598732175);
      const hintedHost = String(req.query?.basket || '').trim();
      const result = await wbBasketPriceProbe(id, hintedHost);
      return send(res, result.ok ? 200 : 502, { version: VERSION, ...result });
    }
    if (mode === 'cdn-calibrate') {
      const source = await sheetsGet('T2:Z');
      const candidates = [];
      for (let i = 0; i < source.length; i++) {
        const r = source[i] || [];
        const id = nmId(r[0]);
        const kzt = numberOrNull(r[1]);
        const status = String(r[5] || '');
        const photo = String(r[6] || '');
        if (!id || !kzt) continue;
        if (!/Обновлено Vercel WB→Sheets V3\.5\.4/i.test(status)) continue;
        candidates.push({row:i+2,id,kzt,host:basketHostFromUrl(photo),status});
        if (candidates.length >= Math.max(4, Math.min(8, Number(req.query?.limit || 6)))) break;
      }

      const results = [];
      for (let i = 0; i < candidates.length; i += 4) {
        const group = candidates.slice(i,i+4);
        const settled = await Promise.allSettled(group.map(async x => {
          const p = await wbBasketPriceProbe(x.id, x.host);
          const rubRaw = p?.priceHistory?.last?.price?.RUB;
          const rub = Number(rubRaw) / 100;
          if (!p.ok || !Number.isFinite(rub) || rub <= 0) return {...x,ok:false};
          return {...x,ok:true,rub,ratio:x.kzt/rub,dt:p.priceHistory.last.dt,host:p.host};
        }));
        for (const s of settled) {
          if (s.status === 'fulfilled') results.push(s.value);
        }
      }
      const ratios = results.filter(x=>x.ok).map(x=>x.ratio);
      const med = median(ratios);
      const deviations = med ? ratios.map(x=>Math.abs(x-med)/med) : [];
      return send(res, 200, {
        ok:true,
        version:VERSION,
        samples:results.length,
        valid:ratios.length,
        medianKztPerRub:med,
        maxDeviation:deviations.length ? Math.max(...deviations) : null,
        within2pct:med ? ratios.filter(x=>Math.abs(x-med)/med <= .02).length : 0,
        rows:results
      });
    }
    if (mode === 'count') {
      const rows = await sheetsGet('T2:T');
      return send(res, 200, { ok: true, version: VERSION, rows: rows.length, destination: WB_DESTINATION, currency: 'KZT' });
    }
    if (mode === 'browser-source' || mode === 'browser-report' || mode === 'browser-ingest') {
      return send(res, 410, {
        ok: false,
        version: VERSION,
        serverOnly: true,
        browserFallback: false,
        message: 'Chrome-расширение отключено. Синхронизация WB выполняется только сервером Vercel.'
      });
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
      source = await sheetsGet(`T${sheetStart}:AB${sheetEnd}`);
    } else {
      source = await sheetsGet('T2:AB');
      totalRows = source.length;
      endIndex = source.length;
    }

    const rows = source.map(r => Array.from({ length: 9 }, (_, i) => r?.[i] ?? ''));
    const idsByRow = rows.map(r => nmId(r[0]));
    const validIds = idsByRow.filter(x => Number.isInteger(x) && x > 0);
    if (!validIds.length) return send(res, 200, { ok: true, version: VERSION, updated: 0, message: 'WB ссылок нет' });

    const fastMode = String(req.query?.fast || '') === '1';
    const wb = await fetchAll(validIds, fastMode);
    if (!wb.products.size && wb.errors.size) {
      return send(res, 503, {
        ok: false,
        protected: true,
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
        message: 'Защита: WB не вернул ни одного товара. Запись отменена, предыдущие цены сохранены.'
      });
    }
    const ts = stamp();
    const providerSuccessRatio = wb.unique > 0 ? wb.products.size / wb.unique : 0;
    const transportErrorCount = [...wb.errors.values()].filter(msg => String(msg) !== 'Цена не найдена').length;
    if (wb.unique >= 20 && providerSuccessRatio < MIN_PROVIDER_SUCCESS_RATIO && transportErrorCount > 0) {
      return send(res, 503, {
        ok: false,
        protected: true,
        version: VERSION,
        part: partIndex,
        parts: partCount,
        successRatio: Number(providerSuccessRatio.toFixed(3)),
        updated: 0,
        preservedLastKnownPrices: true,
        message: 'Защита: WB вернул подозрительно мало данных. Запись отменена, предыдущие цены сохранены.'
      });
    }

    let updated = 0, missing = 0, invalid = 0, protectedRows = 0, pendingPriceChecks = 0;
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
        protectedRows++;
        const oldNumericPrice = numberOrNull(oldPrice);
        const oldStatusText = String(oldStatus || '');
        if (/РУЧНАЯ ПРОВЕРКА|БЛОКИРОВКА/i.test(oldStatusText)) {
          return [oldPrice, oldSeller, oldDays, oldDate, oldStatus];
        }
        const fallbackStatus = oldNumericPrice
          ? `Сервер WB временно недоступен; последняя подтверждённая цена сохранена; ${VERSION}; ${ts}`
          : `Сервер WB не получил подтверждённую цену; запись не изменена; ${VERSION}; ${ts}`;
        return [oldPrice, oldSeller, oldDays, oldDate, fallbackStatus];
      }

      const oldNumericPrice = numberOrNull(oldPrice);
      const newNumericPrice = numberOrNull(p.price);
      const lowKaspi = numberOrNull(r[8]);

      if (newNumericPrice && lowKaspi && newNumericPrice < lowKaspi * MIN_WB_TO_KASPI_RATIO) {
        protectedRows++;
        pendingPriceChecks++;
        return [
          oldPrice,
          oldSeller,
          oldDays,
          oldDate,
          `БЛОКИРОВКА: WB=${newNumericPrice} ниже 25% низкой цены Kaspi=${lowKaspi}; требуется ручная проверка; ${VERSION}; ${ts}`
        ];
      }

      if (oldNumericPrice && newNumericPrice) {
        const ratio = newNumericPrice / oldNumericPrice;
        const suspiciousJump = ratio > PRICE_JUMP_UP_RATIO || ratio < PRICE_JUMP_DOWN_RATIO;
        if (suspiciousJump) {
          const prior = pendingCandidate(oldStatus);
          const sameCandidate = prior.price && nearlySame(prior.price, newNumericPrice);
          const confirmations = sameCandidate ? prior.count + 1 : 1;
          if (confirmations < REQUIRED_DROP_CONFIRMATIONS) {
            pendingPriceChecks++;
            protectedRows++;
            return [
              oldPrice,
              oldSeller,
              oldDays,
              oldDate,
              `Защита цены: изменение ${oldNumericPrice}→${newNumericPrice}; Кандидат WB=${newNumericPrice}; подтверждений=${confirmations}; нужно=${REQUIRED_DROP_CONFIRMATIONS}; ${VERSION}; ${ts}`
            ];
          }
        }
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
      updated, missing, invalidLinks: invalid, protectedRows, pendingPriceChecks,
      providerSuccessRatio: Number(providerSuccessRatio.toFixed(3)),
      errors: [...new Set(wb.errors.values())].slice(0, 10),
      durationMs: Date.now() - started, updatedAt: ts
    });
  } catch (e) {
    console.error('wb-sheets-sync-v3 failed', e);
    return send(res, 500, { ok: false, version: VERSION, error: e instanceof Error ? e.message : String(e), durationMs: Date.now() - started });
  }
};
