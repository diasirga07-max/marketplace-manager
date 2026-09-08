const KASPI_BASE = String(process.env.KASPI_API_BASE_URL || 'https://kaspi.kz/shop/api/v2').replace(/\/$/, '');
const MAX_CODES = 20;
const CONCURRENCY = 3;

function getToken() {
  return String(
    process.env.KASPI_API_TOKEN ||
    process.env.KASPI_TOKEN ||
    process.env.KASPI_API_KEY ||
    ''
  ).trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanCode(value) {
  return String(value == null ? '' : value)
    .trim()
    .replace(/^['"`]+|['"`,;]+$/g, '')
    .replace(/\s+/g, '');
}

function codeCandidates(raw) {
  const value = cleanCode(raw);
  const values = [value];
  if (/-1$/i.test(value)) values.push(value.replace(/-1$/i, ''));
  return [...new Set(values.filter(Boolean))];
}

function normalizeWaybill(value) {
  const url = String(value || '').trim();
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/')) return `https://kaspi.kz${url}`;
  return url;
}

function publicError(error) {
  const text = error instanceof Error ? error.message : String(error || 'Неизвестная ошибка');
  return text.replace(/X-Auth-Token\s*[:=]\s*\S+/gi, 'X-Auth-Token: ***').slice(0, 700);
}

async function kaspiFetch(path, options = {}) {
  const token = getToken();
  if (!token) throw new Error('На Vercel не настроен KASPI_API_TOKEN');

  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${KASPI_BASE}${path}`, {
        method: options.method || 'GET',
        headers: {
          Accept: 'application/vnd.api+json',
          'Content-Type': 'application/vnd.api+json',
          'X-Auth-Token': token,
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        cache: 'no-store',
      });

      const text = await response.text();
      let payload = null;
      if (text) {
        try { payload = JSON.parse(text); } catch { payload = { raw: text.slice(0, 500) }; }
      }

      if (!response.ok) {
        const detail = payload && (
          payload.message ||
          payload.error ||
          (Array.isArray(payload.errors) && payload.errors[0] && (payload.errors[0].detail || payload.errors[0].title))
        );
        const err = new Error(`Kaspi API HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
        err.status = response.status;
        throw err;
      }
      return payload || {};
    } catch (error) {
      lastError = error;
      const status = Number(error && error.status) || 0;
      if (attempt >= 2 || (status && status !== 429 && status < 500)) break;
      await sleep(300 * (attempt + 1));
    }
  }
  throw lastError || new Error('Kaspi API недоступен');
}

async function findOrder(rawCode) {
  for (const code of codeCandidates(rawCode)) {
    const params = new URLSearchParams();
    params.set('filter[orders][code]', code);
    params.set('page[number]', '0');
    params.set('page[size]', '20');
    const payload = await kaspiFetch(`/orders?${params.toString()}`);
    const list = Array.isArray(payload && payload.data) ? payload.data : [];
    const exact = list.find((item) => cleanCode(item && item.attributes && item.attributes.code) === code) || list[0];
    if (exact) return exact;
  }
  return null;
}

async function changeOrder(id, attributes) {
  return kaspiFetch('/orders', {
    method: 'POST',
    body: {
      data: {
        type: 'orders',
        id: String(id),
        attributes,
      },
    },
  });
}

function snapshot(order) {
  const attrs = (order && order.attributes) || {};
  return {
    id: String((order && order.id) || ''),
    code: cleanCode(attrs.code),
    status: String(attrs.status || ''),
    state: String(attrs.state || ''),
    waybill: normalizeWaybill(attrs.waybill),
    waybillNumber: String(attrs.waybillNumber || ''),
    isKaspiDelivery: attrs.isKaspiDelivery,
    deliveryMode: String(attrs.deliveryMode || ''),
  };
}

async function refreshWaybill(code) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt) await sleep(650);
    const order = await findOrder(code);
    if (!order) return null;
    const snap = snapshot(order);
    if (snap.waybill) return snap;
    if (attempt === 2) return snap;
  }
  return null;
}

async function processOrder(rawCode, numberOfSpace, formWaybill) {
  const result = {
    rawCode: cleanCode(rawCode),
    code: '',
    id: '',
    statusBefore: '',
    stateBefore: '',
    accepted: false,
    assembled: false,
    waybill: '',
    waybillNumber: '',
    ok: false,
    message: '',
  };

  try {
    const order = await findOrder(rawCode);
    if (!order) {
      result.message = 'Заказ не найден в Kaspi';
      result.error = 'NOT_FOUND';
      return result;
    }

    let snap = snapshot(order);
    result.code = snap.code || result.rawCode;
    result.id = snap.id;
    result.statusBefore = snap.status;
    result.stateBefore = snap.state;
    result.waybill = snap.waybill;
    result.waybillNumber = snap.waybillNumber;

    if (snap.waybill) {
      result.accepted = true;
      result.assembled = true;
      result.ok = true;
      result.message = 'Накладная уже сформирована';
      return result;
    }

    const terminal = new Set(['COMPLETED', 'CANCELLED', 'CANCELLING', 'RETURNED', 'KASPI_DELIVERY_RETURN_REQUESTED']);
    if (terminal.has(snap.status)) {
      result.message = `Нельзя принять заказ со статусом ${snap.status}`;
      result.error = 'INVALID_STATUS';
      return result;
    }

    if (snap.status === 'APPROVED_BY_BANK' || snap.state === 'NEW') {
      const acceptedPayload = await changeOrder(snap.id, {
        code: snap.code || result.code,
        status: 'ACCEPTED_BY_MERCHANT',
      });
      const acceptedOrder = acceptedPayload && acceptedPayload.data;
      if (acceptedOrder) snap = { ...snap, ...snapshot(acceptedOrder) };
      result.accepted = true;
    } else if (snap.status === 'ACCEPTED_BY_MERCHANT' || snap.status === 'ASSEMBLE' || snap.state === 'KASPI_DELIVERY') {
      result.accepted = true;
    } else {
      result.message = `Текущий статус ${snap.status || snap.state || 'неизвестен'} не подходит для автоматического принятия`;
      result.error = 'INVALID_STATUS';
      return result;
    }

    if (!formWaybill) {
      result.ok = true;
      result.message = 'Заказ принят';
      return result;
    }

    try {
      const assembledPayload = await changeOrder(snap.id, {
        status: 'ASSEMBLE',
        numberOfSpace: String(numberOfSpace),
      });
      const assembledOrder = assembledPayload && assembledPayload.data;
      if (assembledOrder) {
        const assembledSnap = snapshot(assembledOrder);
        result.waybill = assembledSnap.waybill || result.waybill;
        result.waybillNumber = assembledSnap.waybillNumber || result.waybillNumber;
      }
      result.assembled = true;
    } catch (assembleError) {
      result.ok = result.accepted;
      result.message = `Заказ принят, но Kaspi не сформировал накладную: ${publicError(assembleError)}`;
      result.waybillError = publicError(assembleError);
      return result;
    }

    if (!result.waybill) {
      const refreshed = await refreshWaybill(result.code);
      if (refreshed) {
        result.waybill = refreshed.waybill || '';
        result.waybillNumber = refreshed.waybillNumber || '';
      }
    }

    result.ok = true;
    result.message = result.waybill ? 'Принят, накладная сформирована' : 'Принят и переведён в «Передача»; ссылка на накладную ещё не появилась';
    return result;
  } catch (error) {
    result.error = publicError(error);
    result.message = result.error;
    return result;
  }
}

async function mapLimit(items, limit, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      output[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return output;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');

  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      configured: Boolean(getToken()),
      maxCodesPerRequest: MAX_CODES,
      provider: 'Kaspi Shop API v2',
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  if (!getToken()) {
    return res.status(503).json({ ok: false, error: 'На Vercel не настроен KASPI_API_TOKEN' });
  }

  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }

  const rawCodes = Array.isArray(body.codes) ? body.codes : [];
  const codes = [...new Set(rawCodes.map(cleanCode).filter(Boolean))].slice(0, MAX_CODES);
  if (!codes.length) return res.status(400).json({ ok: false, error: 'Не переданы номера заказов' });

  const numberOfSpace = Math.min(20, Math.max(1, Number.parseInt(body.numberOfSpace, 10) || 1));
  const formWaybill = body.formWaybill !== false;

  const startedAt = Date.now();
  const results = await mapLimit(codes, CONCURRENCY, (code) => processOrder(code, numberOfSpace, formWaybill));
  const summary = {
    total: results.length,
    found: results.filter((x) => x.id).length,
    accepted: results.filter((x) => x.accepted).length,
    assembled: results.filter((x) => x.assembled).length,
    waybills: results.filter((x) => x.waybill).length,
    failed: results.filter((x) => !x.ok).length,
  };

  return res.status(200).json({
    ok: summary.failed === 0,
    summary,
    results,
    durationMs: Date.now() - startedAt,
  });
};
