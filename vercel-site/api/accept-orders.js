const KASPI_BASE = String(process.env.KASPI_API_BASE_URL || 'https://kaspi.kz/shop/api/v2').replace(/\/$/, '');
const MAX_CODES = 20;
const CONCURRENCY = 3;
const ALLOWED_ORIGINS = new Set([
  'https://grants-book-kaspi-assistant.vercel.app',
  'https://grants-book-kaspi-assistant-dias10.vercel.app',
]);

function token() {
  return String(process.env.KASPI_API_TOKEN || process.env.KASPI_TOKEN || process.env.KASPI_API_KEY || '').trim();
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function clean(v) { return String(v == null ? '' : v).trim().replace(/^[\'"`]+|[\'"`,;]+$/g, '').replace(/\s+/g, ''); }
function candidates(raw) { const v = clean(raw), a = [v]; if (/-1$/i.test(v)) a.push(v.replace(/-1$/i, '')); return [...new Set(a.filter(Boolean))]; }
function publicError(e) { return (e instanceof Error ? e.message : String(e || 'Ошибка')).replace(/X-Auth-Token\s*[:=]\s*\S+/gi, 'X-Auth-Token: ***').slice(0, 700); }
function normalizeUrl(v) { const u = String(v || '').trim(); if (!u) return ''; if (/^https?:\/\//i.test(u)) return u; if (u.startsWith('/')) return 'https://kaspi.kz' + u; return u; }

function cors(req, res) {
  const origin = String(req.headers?.origin || '');
  if (ALLOWED_ORIGINS.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return origin;
}

async function kfetch(path, opt = {}) {
  if (!token()) throw new Error('На Vercel не настроен KASPI_API_TOKEN');
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(KASPI_BASE + path, {
        method: opt.method || 'GET',
        headers: {
          Accept: 'application/vnd.api+json',
          'Content-Type': 'application/vnd.api+json',
          'X-Auth-Token': token(),
        },
        body: opt.body ? JSON.stringify(opt.body) : undefined,
        cache: 'no-store',
      });
      const text = await response.text();
      let payload = {};
      try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text.slice(0, 500) }; }
      if (!response.ok) {
        const detail = payload?.message || payload?.error || payload?.errors?.[0]?.detail || payload?.errors?.[0]?.title || '';
        const err = new Error(`Kaspi API HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
        err.status = response.status;
        throw err;
      }
      return payload;
    } catch (e) {
      last = e;
      const status = Number(e?.status) || 0;
      if (attempt >= 2 || (status && status !== 429 && status < 500)) break;
      await sleep(350 * (attempt + 1));
    }
  }
  throw last || new Error('Kaspi API недоступен');
}

async function findOrder(raw) {
  for (const c of candidates(raw)) {
    const q = new URLSearchParams();
    q.set('filter[orders][code]', c);
    q.set('page[number]', '0');
    q.set('page[size]', '20');
    const j = await kfetch('/orders?' + q.toString());
    const a = Array.isArray(j?.data) ? j.data : [];
    const exact = a.find(o => clean(o?.attributes?.code) === c) || a[0];
    if (exact) return exact;
  }
  return null;
}

async function change(id, attrs) {
  return kfetch('/orders', {
    method: 'POST',
    body: { data: { type: 'orders', id: String(id), attributes: attrs } },
  });
}

function snap(o) {
  const a = o?.attributes || {};
  const kd = a?.kaspiDelivery && typeof a.kaspiDelivery === 'object' ? a.kaspiDelivery : {};
  const status = String(a.status || '');
  return {
    id: String(o?.id || ''),
    code: clean(a.code),
    status,
    state: String(a.state || ''),
    preorder: a.preOrder === true,
    waybill: normalizeUrl(kd.waybill || a.waybill),
    waybillNumber: String(kd.waybillNumber || a.waybillNumber || ''),
    assembled: a.assembled === true || status === 'ASSEMBLE' || status === 'ASSEMBLED' || Boolean(kd.waybill || a.waybill),
  };
}

async function refresh(code, delay = 0) {
  if (delay) await sleep(delay);
  const o = await findOrder(code);
  return o ? snap(o) : null;
}

async function pollAfterTransfer(code, attempts = 7) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    if (i) await sleep(600 + i * 120);
    last = await refresh(code);
    if (!last) return null;
    if (last.waybill || last.assembled) return last;
  }
  return last;
}

async function transfer(s, spaces) {
  const j = await change(s.id, { status: 'ASSEMBLE', numberOfSpace: String(spaces) });
  return j?.data ? snap(j.data) : s;
}

async function processOrder(raw, spaces, formWaybill) {
  const r = {
    rawCode: clean(raw), code: '', id: '', statusBefore: '', stateBefore: '', preorder: false,
    accepted: false, assembled: false, deferred: false, waybill: '', waybillNumber: '', ok: false, message: '', error: '',
  };
  try {
    const o = await findOrder(raw);
    if (!o) { r.error = 'NOT_FOUND'; r.message = 'Заказ не найден в Kaspi'; return r; }
    let s = snap(o);
    Object.assign(r, { code: s.code || r.rawCode, id: s.id, statusBefore: s.status, stateBefore: s.state, preorder: s.preorder, waybill: s.waybill, waybillNumber: s.waybillNumber });

    if (s.waybill || s.assembled) {
      r.accepted = true; r.assembled = true;
      const latest = s.waybill ? s : await pollAfterTransfer(r.code, 4);
      if (latest) { r.waybill = latest.waybill || ''; r.waybillNumber = latest.waybillNumber || ''; }
      r.ok = true; r.deferred = !r.waybill;
      r.message = r.waybill ? 'Уже в «Передача», накладная сформирована' : 'Заказ уже в «Передача»; Kaspi готовит PDF накладной';
      return r;
    }

    const terminal = new Set(['COMPLETED', 'CANCELLED', 'CANCELLING', 'RETURNED', 'KASPI_DELIVERY_RETURN_REQUESTED']);
    if (terminal.has(s.status)) { r.error = 'INVALID_STATUS'; r.message = 'Нельзя обработать заказ со статусом ' + s.status; return r; }

    if (s.status === 'APPROVED_BY_BANK' || s.state === 'NEW') {
      const j = await change(s.id, { code: s.code || r.code, status: 'ACCEPTED_BY_MERCHANT' });
      if (j?.data) s = { ...s, ...snap(j.data) };
      r.accepted = true;
      const x = await refresh(r.code, 350); if (x) s = x;
    } else if (['ACCEPTED_BY_MERCHANT', 'ARRIVED'].includes(s.status) || s.state === 'KASPI_DELIVERY') {
      r.accepted = true;
    } else {
      r.error = 'INVALID_STATUS'; r.message = 'Текущий статус ' + (s.status || s.state || 'неизвестен') + ' не подходит для обработки'; return r;
    }

    if (!formWaybill) { r.ok = true; r.message = 'Заказ принят'; return r; }

    let immediate;
    try {
      immediate = await transfer(s, spaces);
    } catch (e) {
      r.error = publicError(e);
      r.message = 'Kaspi отклонил перевод в «Передача»: ' + r.error;
      return r;
    }

    const latest = await pollAfterTransfer(r.code, 7);
    if (latest?.waybill || latest?.assembled) {
      r.assembled = true;
      r.waybill = latest.waybill || immediate?.waybill || '';
      r.waybillNumber = latest.waybillNumber || immediate?.waybillNumber || '';
      r.ok = true;
      r.deferred = !r.waybill;
      r.message = r.waybill ? 'Принят → Передача → накладная сформирована' : 'Заказ переведён в «Передача»; Kaspi готовит PDF накладной';
      return r;
    }

    r.error = 'TRANSFER_NOT_PERSISTED';
    r.message = `Kaspi ответил на ASSEMBLE, но при повторной проверке заказ остался ${latest?.status || s.status || 'без нового статуса'}. Накладная не сформирована.`;
    return r;
  } catch (e) {
    r.error = publicError(e); r.message = r.error; return r;
  }
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length); let cursor = 0;
  async function run() { while (true) { const i = cursor++; if (i >= items.length) return; out[i] = await worker(items[i], i); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, run));
  return out;
}

module.exports = async function handler(req, res) {
  const origin = cors(req, res);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'GET') {
    const c = clean(req.query?.code);
    if (c && token()) {
      try { const o = await findOrder(c); return res.status(200).json({ ok: true, configured: true, order: o ? snap(o) : null }); }
      catch (e) { return res.status(502).json({ ok: false, configured: true, error: publicError(e) }); }
    }
    return res.status(200).json({ ok: true, configured: Boolean(token()), maxCodesPerRequest: MAX_CODES, provider: 'Kaspi Shop API v2', behavior: 'direct-assemble-verified-v2' });
  }

  if (req.method !== 'POST') { res.setHeader('Allow', 'GET,POST,OPTIONS'); return res.status(405).json({ ok: false, error: 'Method not allowed' }); }
  if (origin && !ALLOWED_ORIGINS.has(origin)) return res.status(403).json({ ok: false, error: 'Недопустимый источник запроса' });
  if (!token()) return res.status(503).json({ ok: false, error: 'На Vercel не настроен KASPI_API_TOKEN' });

  let b = req.body || {};
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
  const codes = [...new Set((Array.isArray(b.codes) ? b.codes : []).map(clean).filter(Boolean))].slice(0, MAX_CODES);
  if (!codes.length) return res.status(400).json({ ok: false, error: 'Не переданы номера заказов' });

  const spaces = Math.min(20, Math.max(1, parseInt(b.numberOfSpace, 10) || 1));
  const formWaybill = b.formWaybill !== false;
  const startedAt = Date.now();
  const results = await mapLimit(codes, CONCURRENCY, c => processOrder(c, spaces, formWaybill));
  const summary = {
    total: results.length,
    found: results.filter(x => x.id).length,
    accepted: results.filter(x => x.accepted).length,
    assembled: results.filter(x => x.assembled).length,
    waybills: results.filter(x => x.waybill).length,
    deferred: results.filter(x => x.deferred).length,
    failed: results.filter(x => !x.ok).length,
  };
  return res.status(200).json({ ok: summary.failed === 0, summary, results, durationMs: Date.now() - startedAt });
};
