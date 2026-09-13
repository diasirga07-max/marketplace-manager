const KASPI_BASE = String(process.env.KASPI_API_BASE_URL || 'https://kaspi.kz/shop/api/v2').replace(/\/$/, '');

function getToken() {
  return String(
    process.env.KASPI_API_TOKEN ||
    process.env.KASPI_TOKEN ||
    process.env.KASPI_API_KEY ||
    ''
  ).trim();
}

function clean(value) {
  return String(value == null ? '' : value).trim().replace(/^['"`]+|['"`,;]+$/g, '').replace(/\s+/g, '');
}

function candidates(raw) {
  const v = clean(raw);
  const out = [v];
  if (/-1$/i.test(v)) out.push(v.replace(/-1$/i, ''));
  return [...new Set(out.filter(Boolean))];
}

async function kaspi(path) {
  const token = getToken();
  if (!token) throw new Error('KASPI_API_TOKEN не настроен');
  const r = await fetch(`${KASPI_BASE}${path}`, {
    headers: {
      Accept: 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
      'X-Auth-Token': token,
    },
    cache: 'no-store',
  });
  const text = await r.text();
  let j = {};
  try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text.slice(0, 400) }; }
  if (!r.ok) {
    const detail = j?.message || j?.error || (Array.isArray(j?.errors) && (j.errors[0]?.detail || j.errors[0]?.title));
    const e = new Error(`Kaspi API ${r.status}${detail ? `: ${detail}` : ''}`);
    e.status = r.status;
    throw e;
  }
  return j;
}

async function findOrder(raw) {
  for (const code of candidates(raw)) {
    const q = new URLSearchParams();
    q.set('filter[orders][code]', code);
    q.set('page[number]', '0');
    q.set('page[size]', '20');
    const j = await kaspi(`/orders?${q.toString()}`);
    const list = Array.isArray(j?.data) ? j.data : [];
    const exact = list.find(x => clean(x?.attributes?.code) === code) || list[0];
    if (exact) return exact;
  }
  return null;
}

async function productForEntry(entry) {
  const entryId = String(entry?.id || '');
  const qty = Math.max(1, Number(entry?.attributes?.quantity) || 1);
  if (!entryId) return null;

  const p = await kaspi(`/orderentries/${encodeURIComponent(entryId)}/product`);
  const master = p?.data || null;
  if (!master) return null;
  const masterId = String(master.id || '');
  const ma = master.attributes || {};

  let merchant = null;
  if (masterId) {
    try {
      const m = await kaspi(`/masterproducts/${encodeURIComponent(masterId)}/merchantProduct`);
      merchant = m?.data || null;
    } catch (_) {}
  }
  const aa = merchant?.attributes || {};
  const sku = clean(aa.code || ma.code || masterId);
  const name = String(aa.name || ma.name || entry?.attributes?.category?.title || sku).trim();
  return { sku, name, quantity: qty, masterProductId: masterId };
}

async function scanInvoice(raw) {
  const order = await findOrder(raw);
  if (!order) return null;
  const attrs = order.attributes || {};
  const orderCode = clean(attrs.code || raw);
  const entriesJson = await kaspi(`/orders/${encodeURIComponent(String(order.id))}/entries`);
  const entries = Array.isArray(entriesJson?.data) ? entriesJson.data : [];
  const items = [];
  for (const entry of entries) {
    try {
      const x = await productForEntry(entry);
      if (x?.sku) items.push(x);
    } catch (_) {}
  }
  return {
    order: {
      id: String(order.id || ''),
      code: orderCode,
      status: String(attrs.status || ''),
      state: String(attrs.state || ''),
      creationDate: attrs.creationDate || null,
    },
    items,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!getToken()) return res.status(503).json({ ok: false, error: 'KASPI_API_TOKEN не настроен' });

  let body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const raw = clean((req.query && req.query.scan) || body.scan || body.code);
  if (!raw) return res.status(400).json({ ok: false, error: 'Не передан номер накладной' });

  try {
    const result = await scanInvoice(raw);
    if (!result) return res.status(404).json({ ok: false, error: 'Накладная не найдена в Kaspi' });
    if (!result.items.length) return res.status(404).json({ ok: false, order: result.order, error: 'Накладная найдена, но товары не получены' });
    return res.status(200).json({ ok: true, ...result, source: 'Kaspi Shop API v2' });
  } catch (e) {
    return res.status(Number(e?.status) || 502).json({ ok: false, error: String(e?.message || e).slice(0, 700) });
  }
};
