const KASPI_BASE = String(process.env.KASPI_API_BASE_URL || 'https://kaspi.kz/shop/api/v2').replace(/\/$/, '');

function token() {
  return String(process.env.KASPI_API_TOKEN || process.env.KASPI_TOKEN || process.env.KASPI_API_KEY || '').trim();
}
function clean(value) {
  return String(value == null ? '' : value).trim().replace(/-1$/i, '').replace(/\s+/g, '');
}
function publicError(error) {
  return String(error instanceof Error ? error.message : error || 'Ошибка').replace(/X-Auth-Token\s*[:=]\s*\S+/gi, 'X-Auth-Token: ***').slice(0, 700);
}
async function kaspi(path) {
  const t = token();
  if (!t) throw new Error('KASPI_API_TOKEN не настроен');
  const response = await fetch(KASPI_BASE + path, {
    headers: {
      Accept: 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
      'X-Auth-Token': t,
    },
    cache: 'no-store',
  });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text.slice(0, 500) }; }
  if (!response.ok) {
    const detail = payload?.errors?.[0]?.detail || payload?.errors?.[0]?.title || payload?.message || payload?.error || '';
    throw new Error(`Kaspi API ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  return payload;
}
async function findOrder(code) {
  const q = new URLSearchParams();
  q.set('filter[orders][code]', clean(code));
  q.set('page[number]', '0');
  q.set('page[size]', '20');
  const payload = await kaspi('/orders?' + q.toString());
  const list = Array.isArray(payload?.data) ? payload.data : [];
  return list.find(x => clean(x?.attributes?.code) === clean(code)) || list[0] || null;
}
async function masterProduct(entryId) {
  try {
    const payload = await kaspi('/orderentries/' + encodeURIComponent(entryId) + '/product');
    return payload?.data || null;
  } catch {
    return null;
  }
}
async function merchantProduct(masterId) {
  if (!masterId) return null;
  try {
    const payload = await kaspi('/masterproducts/' + encodeURIComponent(masterId) + '/merchantProduct');
    return payload?.data || null;
  } catch {
    return null;
  }
}
async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, run));
  return out;
}
function orderSnapshot(order) {
  const a = order?.attributes || {};
  const kd = a?.kaspiDelivery && typeof a.kaspiDelivery === 'object' ? a.kaspiDelivery : {};
  return {
    id: String(order?.id || ''),
    code: clean(a.code),
    status: String(a.status || ''),
    state: String(a.state || ''),
    preOrder: a.preOrder === true,
    assembled: a.assembled === true || String(a.status || '') === 'ASSEMBLE' || Boolean(kd.waybill || a.waybill),
    isKaspiDelivery: a.isKaspiDelivery === true,
    deliveryMode: String(a.deliveryMode || ''),
    totalPrice: Number(a.totalPrice) || 0,
    creationDate: Number(a.creationDate) || 0,
    plannedDeliveryDate: Number(a.plannedDeliveryDate) || 0,
    courierTransmissionPlanningDate: Number(kd.courierTransmissionPlanningDate || a.courierTransmissionPlanningDate) || 0,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  try {
    const code = clean(req.query?.code);
    if (!/^\d{6,14}$/.test(code)) return res.status(400).json({ ok: false, error: 'Укажите корректный номер заказа' });
    const order = await findOrder(code);
    if (!order) return res.status(404).json({ ok: false, error: 'Заказ не найден в Kaspi' });

    const entriesPayload = await kaspi('/orders/' + encodeURIComponent(order.id) + '/entries');
    const entries = Array.isArray(entriesPayload?.data) ? entriesPayload.data : [];
    const masters = await mapLimit(entries, 4, entry => masterProduct(entry.id));
    const merchants = await mapLimit(masters, 4, master => merchantProduct(master?.id));

    const rows = entries.map((entry, i) => {
      const ea = entry?.attributes || {};
      const master = masters[i] || {};
      const ma = master?.attributes || {};
      const merchant = merchants[i] || {};
      const mpa = merchant?.attributes || {};
      return {
        entryId: String(entry?.id || ''),
        quantity: Math.max(1, Number(ea.quantity) || 1),
        totalPrice: Number(ea.totalPrice) || 0,
        basePrice: Number(ea.basePrice) || 0,
        sku: String(mpa.code || ma.code || ''),
        productCode: String(ma.code || ''),
        name: String(mpa.name || ma.name || ma.title || ea.title || 'Товар Kaspi'),
        masterProductId: String(master?.id || ''),
        merchantProductId: String(merchant?.id || ''),
      };
    });

    return res.status(200).json({
      ok: true,
      source: 'Kaspi Shop API v2 direct order lookup',
      generatedAt: new Date().toISOString(),
      order: orderSnapshot(order),
      rows,
      count: rows.length,
    });
  } catch (error) {
    console.error('order-lookup', error);
    return res.status(502).json({ ok: false, error: publicError(error) });
  }
};
