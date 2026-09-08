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
      await sleep(350 * (attempt + 1));
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
    deliveryType: String(attrs.deliveryType || ''),
    reservationDate: attrs.reservationDate || null,
    plannedDeliveryDate: attrs.plannedDeliveryDate || null,
    courierTransmissionPlanningDate: attrs.courierTransmissionPlanningDate || null,
    preOrder: attrs.preOrder === true,
    preorder: attrs.preOrder === true,
  };
}

async function refreshOrder(code, delay = 0) {
  if (delay) await sleep(delay);
  const order = await findOrder(code);
  return order ? snapshot(order) : null;
}

async function refreshWaybill(code) {
  let last = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (attempt) await sleep(800);
    last = await refreshOrder(code);
    if (!last) return null;
    if (last.waybill) return last;
  }
  return last;
}

async function assembleWithRetry(snap, numberOfSpace, result) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const payload = await changeOrder(snap.id, {
        status: 'ASSEMBLE',
        numberOfSpace: String(numberOfSpace),
      });
      const changed = payload && payload.data ? snapshot(payload.data) : null;
      result.assembled = true;
      if (changed) {
        result.waybill = changed.waybill || result.waybill;
        result.waybillNumber = changed.waybillNumber || result.waybillNumber;
      }
      return changed || snap;
    } catch (error) {
      lastError = error;
      if (attempt >= 2) break;
      const refreshed = await refreshOrder(result.code, 900 + attempt * 500);
      if (refreshed) snap = refreshed;
    }
  }
  throw lastError || new Error('Kaspi не перевёл заказ в «Передача»');
}

async function processOrder(rawCode, numberOfSpace, formWaybill) {
  const result = {
    rawCode: cleanCode(rawCode),
    code: '',
    id: '',
    statusBefore: '',
    stateBefore: '',
    preorder: false,
    accepted: false,
    arrived: false,
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
    result.preorder = snap.preorder;
    result.waybill = snap.waybill;
    result.waybillNumber = snap.waybillNumber;

    if (snap.waybill) {
      result.accepted = true;
      result.arrived = snap.preorder || snap.status === 'ARRIVED';
      result.assembled = true;
      result.ok = true;
      result.message = 'Накладная уже сформирована';
      return result;
    }

    const terminal = new Set(['COMPLETED', 'CANCELLED', 'CANCELLING', 'RETURNED', 'KASPI_DELIVERY_RETURN_REQUESTED']);
    if (terminal.has(snap.status)) {
      result.message = `Нельзя обработать заказ со статусом ${snap.status}`;
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
      const refreshed = await refreshOrder(result.code, 500);
      if (refreshed) snap = refreshed;
    } else if (['ACCEPTED_BY_MERCHANT', 'ARRIVED', 'ASSEMBLE'].includes(snap.status) || snap.state === 'KASPI_DELIVERY') {
      result.accepted = true;
    } else {
      result.message = `Текущий статус ${snap.status || snap.state || 'неизвестен'} не подходит для автоматической обработки`;
      result.error = 'INVALID_STATUS';
      return result;
    }

    result.preorder = result.preorder || snap.preorder;

    // For Kaspi preorders the cabinet button «Прибыл» is status ARRIVED.
    if (result.preorder && snap.status === 'ACCEPTED_BY_MERCHANT') {
      const arrivedPayload = await changeOrder(snap.id, {
        code: snap.code || result.code,
        status: 'ARRIVED',
      });
      const arrivedOrder = arrivedPayload && arrivedPayload.data;
      if (arrivedOrder) snap = { ...snap, ...snapshot(arrivedOrder) };
      result.arrived = true;

      const refreshed = await refreshOrder(result.code, 900);
      if (refreshed) snap = refreshed;
    } else if (snap.status === 'ARRIVED') {
      result.arrived = true;
    }

    if (!formWaybill) {
      result.ok = true;
      result.message = result.arrived ? 'Заказ отмечен «Прибыл»' : 'Заказ принят';
      return result;
    }

    try {
      snap = await assembleWithRetry(snap, numberOfSpace, result);
    } catch (assembleError) {
      result.ok = false;
      result.error = publicError(assembleError);
      result.message = result.arrived
        ? `Статус «Прибыл» установлен, но накладная пока не сформирована: ${result.error}`
        : `Kaspi не сформировал накладную: ${result.error}`;
      return result;
    }

    if (!result.waybill) {
      const refreshed = await refreshWaybill(result.code);
      if (refreshed) {
        result.waybill = refreshed.waybill || '';
        result.waybillNumber = refreshed.waybillNumber || '';
      }
    }

    result.ok = Boolean(result.assembled);
    if (result.waybill) {
      result.message = result.arrived
        ? 'Прибыл → Передача → накладная сформирована'
        : 'Принят → Передача → накладная сформирована';
    } else {
      result.message = result.arrived
        ? '«Прибыл» установлен и заказ переведён в «Передача»; Kaspi ещё готовит ссылку на накладную'
        : 'Заказ переведён в «Передача»; Kaspi ещё готовит ссылку на накладную';
    }
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
    const code = cleanCode(req.query && req.query.code);
    if (code && getToken()) {
      try {
        const order = await findOrder(code);
        return res.status(200).json({ ok: true, configured: true, order: order ? snapshot(order) : null });
      } catch (error) {
        return res.status(502).json({ ok: false, configured: true, error: publicError(error) });
      }
    }
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
    arrived: results.filter((x) => x.arrived).length,
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
