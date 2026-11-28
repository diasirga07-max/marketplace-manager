/**
 * Flip.gs — общий склад Kaspi + Flip.kz.
 *
 * Заказ Flip — ещё один источник событий того же ledger `_KASPI_ORDER_EVENTS`:
 *  - связанный товар («Flip map» Активен=TRUE): события строит существующая
 *    state machine `klPlanLineSnapshot_`, пишет `klLedgerAppendBatch_`,
 *    остаток F пересчитывает существующий `SKLAD_recalc`;
 *  - несвязанный товар: идемпотентное двухфазное списание колонки C «Прайс Flip»;
 *  - первый запуск: текущие заказы только регистрируются (FLIP_REGISTERED).
 *
 * Существующие файлы не меняются, кроме ветки `?feed=flip` в doGet.
 * Боевые записи только при Script Property FLIP_DRY_RUN=FALSE.
 * Ключ API — только Script Property FLIP_API_KEY, в логи не попадает.
 *
 * Точки входа:
 *   KL_FLIP_ORDERS_RUN   — триггер 5 мин: новые заказы GET /orders.
 *   KL_FLIP_STATUS_RUN   — триггер 1 ч: statusGoods по незакрытым единицам.
 *   FLIP_XML_RUN         — триггер 15 мин: Flip XML в Drive (doGet?feed=flip).
 *   FLIP_TRANSFER_DRY_RUN / FLIP_TRANSFER_RUN — перенос «Flip перенос» → СКЛАД_НАЛИЧИЕ.
 *   FLIP_INSTALL_TRIGGERS — создаёт только недостающие Flip-триггеры.
 *   FLIP_SELF_TEST       — чистые проверки без записи.
 */

var FLIP = Object.freeze({
  BASE_URL: 'https://partner.flip.kz/api/v1',
  SOURCE: 'FLIP_API',
  ORDER_PREFIX: 'flip:',
  C_SKU_PREFIX: 'FLIPC_',
  UNMAPPED_SKU_PREFIX: 'FLIPU_',
  PAGE_LIMIT: 100,
  MAX_PAGES: 200,
  STATUS_BATCH: 50,
  RUNTIME_MS: 240000,
  XML_FILE_NAME: 'flip-catalog.xml',
  XML_MIN_OFFERS_DEFAULT: 200,
  PRICE_FIRST_ROW: 5,
  PROPS: Object.freeze({
    API_KEY: 'FLIP_API_KEY',
    DRY_RUN: 'FLIP_DRY_RUN',
    BUFFER: 'FLIP_SAFETY_BUFFER',
    INITIALIZED: 'FLIP_INITIALIZED',
    XML_FILE_ID: 'FLIP_XML_FILE_ID',
    XML_MIN_OFFERS: 'FLIP_XML_MIN_OFFERS',
    XML_LAST: 'FLIP_XML_LAST_RESULT',
    ORDERS_LAST: 'FLIP_ORDERS_LAST_RESULT',
    STATUS_LAST: 'FLIP_STATUS_LAST_RESULT',
    TRANSFER_ALLOWED: 'FLIP_TRANSFER_ALLOWED',
    DRY_SIMULATE: 'FLIP_DRY_SIMULATE_INITIALIZED'
  }),
  SHEETS: Object.freeze({
    MAP: 'Flip map',
    ERRORS: 'Flip ошибки',
    DRY: 'Flip dry-run',
    TRANSFER: 'Flip перенос',
    PRICE: 'Прайс Flip',
    SKLAD: 'СКЛАД_НАЛИЧИЕ',
    KASPI_PRICE: 'Прайс KASPI'
  }),
  EVENT: Object.freeze({
    REGISTERED: 'FLIP_REGISTERED',
    UNMAPPED: 'FLIP_UNMAPPED',
    C_DEBIT: 'FLIP_C_DEBIT',
    C_CREDIT: 'FLIP_C_CREDIT',
    C_APPLIED: 'FLIP_C_APPLIED',
    CLOSED: 'FLIP_CLOSED'
  }),
  // Коды statusGoods, после которых единица точно уехала от нас.
  SHIPPED_CODES: Object.freeze({3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 10: 1, 11: 1, 12: 1})
});

/* ======================================================================
   ЧИСТЫЕ ФУНКЦИИ (без сервисов Apps Script; проверяются FLIP_SELF_TEST и Node)
   ====================================================================== */

function flipText_(v) {
  return v === null || v === undefined ? '' : String(v).replace(/ /g, ' ').trim();
}

/** Код товара Flip: без пробелов, регистр верхний, ведущие нули сохраняются. */
function flipNormCode_(v) {
  return flipText_(v).replace(/\s+/g, '').toUpperCase();
}

function flipInt_(v, fallback) {
  if (typeof v === 'number') return isFinite(v) ? Math.floor(v) : fallback;
  var t = flipText_(v).replace(/\s+/g, '').replace(/₸|тг|тенге/gi, '').replace(',', '.');
  if (!/^-?\d+(?:\.\d+)?$/.test(t)) return fallback;
  return Math.floor(Number(t));
}

function flipTruthy_(v) {
  if (v === true) return true;
  var t = flipText_(v).toUpperCase();
  return t === 'TRUE' || t === 'ДА' || t === 'YES' || t === '1';
}

function flipOrderId_(preorderId) { return FLIP.ORDER_PREFIX + flipText_(preorderId); }

function flipIsFlipOrderId_(orderId) {
  return flipText_(orderId).indexOf(FLIP.ORDER_PREFIX) === 0;
}

/** partnerCodes: массив, строка «a,b» или одиночное значение → массив кодов. */
function flipPartnerCodes_(raw) {
  var list = Array.isArray(raw) ? raw : flipText_(raw).split(/[,;\s]+/);
  var out = [];
  list.forEach(function (item) {
    var code = flipNormCode_(item && typeof item === 'object' ? (item.code || item.value) : item);
    if (code && out.indexOf(code) < 0) out.push(code);
  });
  return out;
}

/** Ответ GET /orders → строки и число страниц. Ошибки с HTTP 200 → throw. */
function flipParseOrdersPage_(payload) {
  flipAssertNoApiError_(payload);
  var rows = Array.isArray(payload) ? payload
    : (payload && (payload.data || payload.items || payload.orders || payload.result)) || [];
  if (!Array.isArray(rows)) rows = [];
  var pagination = payload && payload.meta && payload.meta.pagination || {};
  var pages = flipInt_(pagination.pages, 1);
  return {
    rows: rows.map(function (r) {
      return {
        preorderId: flipText_(r.preorderId),
        produceId: flipText_(r.produceId),
        article: flipText_(r.article),
        price: r.price,
        partnerCodes: flipPartnerCodes_(r.partnerCodes),
        groupId: flipText_(r.groupId),
        groupStoreName: flipText_(r.groupStoreName)
      };
    }).filter(function (r) { return Boolean(r.preorderId); }),
    pages: Math.max(1, pages || 1)
  };
}

function flipAssertNoApiError_(payload) {
  if (!payload || typeof payload !== 'object') return;
  var err = payload.error || payload.errors || payload.errorMessage;
  if (payload.success === false || payload.ok === false || flipText_(payload.status).toLowerCase() === 'error' || err) {
    var msg = typeof err === 'string' ? err : JSON.stringify(err || payload.message || payload).slice(0, 500);
    throw new Error('Flip API вернул ошибку: ' + msg);
  }
}

/**
 * Ответ statusGoods → {id: {code, text, history:[codes]}}.
 * Формат допускается как массив объектов, так и объект {id: {...}};
 * код без значения → code=null (перезапросить позже).
 */
function flipParseStatusResponse_(payload) {
  flipAssertNoApiError_(payload);
  var body = payload && (payload.data || payload.items || payload.goods || payload.result) || payload;
  var entries = [];
  if (Array.isArray(body)) entries = body.map(function (x) { return [null, x]; });
  else if (body && typeof body === 'object') {
    Object.keys(body).forEach(function (k) {
      if (k === 'meta') return;
      entries.push([k, body[k]]);
    });
  }
  var out = Object.create(null);
  entries.forEach(function (pair) {
    var item = pair[1];
    if (!item || typeof item !== 'object') return;
    var id = flipText_(item.preorderId || item.id || item.goodsId || item.goods_id || pair[0]);
    if (!id) return;
    var rawCode = item.status_code !== undefined ? item.status_code
      : (item.statusCode !== undefined ? item.statusCode : (item.status && item.status.code));
    var code = flipInt_(rawCode, null);
    var hist = item.history || item.statusHistory || [];
    var history = (Array.isArray(hist) ? hist : []).map(function (h) {
      return flipInt_(h && typeof h === 'object'
        ? (h.status_code !== undefined ? h.status_code : (h.statusCode !== undefined ? h.statusCode : h.code))
        : h, null);
    }).filter(function (c) { return c !== null; });
    out[id] = {
      code: code,
      text: flipText_(item.status_text || item.statusText || (item.status && item.status.text)),
      history: history
    };
  });
  return out;
}

/** Была ли единица отгружена: SHIP в ledger или код 3+ (кроме 8/9) в текущем/истории. */
function flipWasShipped_(statusInfo, shippedInLedger) {
  if (shippedInLedger) return true;
  var codes = [];
  if (statusInfo) {
    if (statusInfo.code !== null && statusInfo.code !== undefined) codes.push(statusInfo.code);
    codes = codes.concat(statusInfo.history || []);
  }
  return codes.some(function (c) { return Boolean(FLIP.SHIPPED_CODES[c]); });
}

/**
 * Решение по коду статуса (правила владельца):
 *  1,2 → WAIT; 3,4 → SHIP; 5,6,7 → COMPLETE; 9 → RELEASE (если отгрузки не было,
 *  иначе MANUAL); 8 → RELEASE без отгрузки / COMPLETE с отгрузкой;
 *  10 → RETURN (ручное подтверждение); 11,12,нет кода → WAIT; прочее → UNKNOWN.
 */
function flipStatusDecision_(statusInfo, shippedInLedger) {
  var code = statusInfo ? statusInfo.code : null;
  var shipped = flipWasShipped_(statusInfo, shippedInLedger);
  if (code === null || code === undefined) return {action: 'WAIT', reason: 'NO_STATUS_CODE'};
  if (code === 1 || code === 2) return {action: 'WAIT', reason: 'PENDING_' + code};
  if (code === 3 || code === 4) return {action: 'SHIP', reason: 'IN_TRANSIT_' + code};
  if (code === 5 || code === 6 || code === 7) return {action: 'COMPLETE', reason: 'DONE_' + code};
  if (code === 9) {
    return shipped ? {action: 'MANUAL', reason: 'CANCELLED_BY_SUPPLIER_AFTER_SHIP'}
      : {action: 'RELEASE', reason: 'CANCELLED_BY_SUPPLIER'};
  }
  if (code === 8) {
    return shipped ? {action: 'COMPLETE', reason: 'CANCELLED_BY_BUYER_AT_FLIP_WAREHOUSE'}
      : {action: 'RELEASE', reason: 'CANCELLED_BY_BUYER_NOT_SHIPPED'};
  }
  if (code === 10) return {action: 'RETURN', reason: 'RETURNED_TO_SUPPLIER'};
  if (code === 11 || code === 12) return {action: 'WAIT', reason: 'RETURNING_' + code};
  return {action: 'UNKNOWN', reason: 'UNKNOWN_CODE_' + code};
}

/** Snapshot для существующей state machine по решению статуса. */
function flipSnapshotFor_(line, action, observedAtMs, statusText) {
  var status = 'ACCEPTED_BY_MERCHANT';
  var handoff = false;
  var handoffKnown = false;
  if (action === 'SHIP') { handoff = true; handoffKnown = true; }
  if (action === 'COMPLETE') { status = 'COMPLETED'; handoff = true; handoffKnown = true; }
  if (action === 'RELEASE') { status = 'CANCELLED'; handoff = false; handoffKnown = true; }
  if (action === 'RETURN') { status = 'RETURNED'; handoff = true; handoffKnown = true; }
  return {
    orderId: line.orderId,
    lineId: line.lineId,
    code: line.preorderId,
    sku: line.sku,
    qty: 1,
    state: '',
    status: status,
    handoff: handoff,
    handoffKnown: handoffKnown,
    flipStatusText: statusText || '',
    eventAt: observedAtMs,
    eventAtMs: observedAtMs,
    source: FLIP.SOURCE
  };
}

/** События, которые понимает state machine (служебные маркеры Flip отбрасываются). */
function flipPlannerEvents_(events) {
  var known = {RESERVE: 1, RELEASE: 1, SHIP: 1, RETURN_PENDING: 1, RETURN_RESTOCK: 1, COMPLETE: 1, CANCEL_NO_RESERVE: 1};
  return (events || []).filter(function (e) { return known[flipText_(e.eventType).toUpperCase()]; });
}

/**
 * Режим строки по первому событию:
 *  MAPPED (RESERVE), C (FLIP_C_DEBIT), REGISTERED, UNMAPPED.
 */
function flipLineMode_(events) {
  var types = (events || []).map(function (e) { return flipText_(e.eventType).toUpperCase(); });
  if (types.indexOf(FLIP.EVENT.REGISTERED) >= 0) return 'REGISTERED';
  if (types.indexOf(FLIP.EVENT.C_DEBIT) >= 0) return 'C';
  if (types.indexOf(FLIP.EVENT.UNMAPPED) >= 0) return 'UNMAPPED';
  if (types.indexOf('RESERVE') >= 0) return 'MAPPED';
  return '';
}

function flipLineClosed_(events) {
  return (events || []).some(function (e) {
    return flipText_(e.eventType).toUpperCase() === FLIP.EVENT.CLOSED;
  });
}

/**
 * Индекс «Flip map»: rows = [[sku, code, barcode, priceFlip, active, comment], ...].
 * Активная строка без SKU или с конфликтом кода → в errors, в индекс не попадает.
 */
function flipBuildMapIndex_(rows) {
  var byCode = Object.create(null);
  var all = Object.create(null);
  var errors = [];
  (rows || []).forEach(function (r, i) {
    var code = flipNormCode_(r[1]);
    if (!code) return;
    var sku = flipText_(r[0]).replace(/\s+/g, '');
    var price = flipInt_(r[3], null);
    var entry = {
      code: code, sku: sku, barcode: flipText_(r[2]),
      price: price !== null && price > 0 ? price : null,
      active: flipTruthy_(r[4]), row: i + 2
    };
    all[code] = entry;
    if (!entry.active) return;
    if (!sku) { errors.push({row: entry.row, code: code, error: 'Активна строка без SKU'}); return; }
    if (byCode[code] && byCode[code].sku !== sku) {
      errors.push({row: entry.row, code: code, error: 'Код активен с разными SKU: ' + byCode[code].sku + ' / ' + sku});
      byCode[code].conflict = true;
      return;
    }
    byCode[code] = entry;
  });
  Object.keys(byCode).forEach(function (c) { if (byCode[c].conflict) delete byCode[c]; });
  return {byCode: byCode, all: all, errors: errors};
}

/** «Прайс Flip» A:L начиная со строки 5 → {code: {row, name, qtyC, price, barcode}}. */
function flipBuildPriceIndex_(rows, firstRow) {
  var byCode = Object.create(null);
  var order = [];
  var errors = [];
  (rows || []).forEach(function (r, i) {
    var raw = flipText_(r[0]);
    if (!raw || /^https?:/i.test(raw) || raw.length >= 20) return;
    var code = flipNormCode_(raw);
    if (!/^[A-Z0-9_-]+$/.test(code)) return;
    if (byCode[code]) { errors.push({row: firstRow + i, code: code, error: 'Повтор кода в «Прайс Flip»'}); return; }
    var price = flipInt_(r[8], null);
    byCode[code] = {
      code: raw.replace(/\s+/g, ''), row: firstRow + i,
      name: flipText_(r[1]).replace(/\s+/g, ' '),
      qtyC: flipInt_(r[2], 0),
      price: price !== null && price > 0 ? price : null,
      barcode: flipText_(r[11])
    };
    order.push(code);
  });
  return {byCode: byCode, order: order, errors: errors};
}

/** Выбор товара по partnerCodes: активная пара → MAPPED; код в «Прайс Flip» → C; иначе UNMAPPED. */
function flipResolveOrder_(order, mapIndex, priceIndex) {
  var codes = order.partnerCodes || [];
  for (var i = 0; i < codes.length; i++) {
    if (mapIndex.byCode[codes[i]]) return {mode: 'MAPPED', code: codes[i], sku: mapIndex.byCode[codes[i]].sku};
  }
  for (var j = 0; j < codes.length; j++) {
    if (priceIndex.byCode[codes[j]]) return {mode: 'C', code: codes[j], sku: FLIP.C_SKU_PREFIX + codes[j]};
  }
  var key = codes[0] || flipNormCode_(order.produceId) || flipNormCode_(order.article) || 'NOCODE';
  return {mode: 'UNMAPPED', code: codes.join(','), sku: FLIP.UNMAPPED_SKU_PREFIX + key};
}

/**
 * Офферы Flip XML.
 * Связанный: count = max(0, F − buffer), цена «Цена Flip»; нет цены → count 0.
 * Несвязанный: count = max(0, C), цена I; нет цены → count 0.
 * skladMap — {SKU: F>0} как SKLAD_getAvailableMap().
 */
function flipBuildOffers_(priceIndex, mapIndex, skladMap, buffer) {
  var buf = Math.max(0, flipInt_(buffer, 0) || 0);
  var offers = [];
  var report = [];
  priceIndex.order.forEach(function (key) {
    var p = priceIndex.byCode[key];
    var m = mapIndex.byCode[key];
    var count, price, mode, note = '', stock;
    if (m) {
      mode = 'MAPPED';
      stock = Object.prototype.hasOwnProperty.call(skladMap, m.sku) ? Math.max(0, flipInt_(skladMap[m.sku], 0)) : 0;
      price = m.price;
      count = price ? Math.max(0, stock - buf) : 0;
      if (!price) note = 'нет «Цены Flip» → count=0';
    } else {
      mode = 'C';
      stock = Math.max(0, p.qtyC);
      price = p.price;
      count = price ? stock : 0;
      if (!price) note = 'нет цены в «Прайс Flip» I → count=0';
    }
    var barcode = (m && m.barcode) || p.barcode || '';
    offers.push({code: p.code, name: p.name, price: price || p.price || null, count: count, barcode: barcode});
    report.push({code: p.code, mode: mode, sku: m ? m.sku : '', stock: stock, count: count, price: price, note: note});
  });
  return {offers: offers, report: report};
}

function flipXmlEscape_(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

function flipRenderXml_(offers) {
  var parts = ['<?xml version="1.0" encoding="utf-8"?>', '<offers>'];
  offers.forEach(function (o) {
    parts.push('  <offer>');
    parts.push('    <code>' + flipXmlEscape_(o.code) + '</code>');
    parts.push('    <name>' + flipXmlEscape_(o.name) + '</name>');
    if (o.price) parts.push('    <price>' + Math.round(o.price) + '</price>');
    parts.push('    <count>' + Math.max(0, Math.floor(o.count || 0)) + '</count>');
    if (o.barcode) parts.push('    <barcode>' + flipXmlEscape_(o.barcode) + '</barcode>');
    parts.push('  </offer>');
  });
  parts.push('</offers>');
  return parts.join('\n');
}

/**
 * План переноса «Flip перенос» → «СКЛАД_НАЛИЧИЕ» (правила 1–6, вариант Б).
 * rows: [{row, code, sku, fact, transfer, status}]
 * skladBySku: {SKU: {row, c}}; reserveBySku: {SKU: открытые резервы сейчас}.
 * Новый C = факт + открытые резервы (отложенные под заказы в факт не входят).
 */
function flipTransferPlan_(rows, skladBySku, reserveBySku) {
  var bySku = Object.create(null);
  var results = [];
  rows.forEach(function (r) {
    if (!r.transfer) return;
    if (/^перенесено/i.test(flipText_(r.status))) {
      results.push({row: r.row, code: r.code, sku: r.sku, action: 'SKIP', message: 'уже перенесено'});
      return;
    }
    var sku = flipText_(r.sku).replace(/\s+/g, '');
    var fact = flipInt_(r.fact, null);
    if (!sku) { results.push({row: r.row, code: r.code, action: 'ERROR', message: 'нет SKU'}); return; }
    if (fact === null || fact < 0 || String(r.fact).trim() === '') {
      results.push({row: r.row, code: r.code, sku: sku, action: 'ERROR', message: 'нет «Факт на полке» (целое ≥ 0)'});
      return;
    }
    if (!bySku[sku]) bySku[sku] = [];
    bySku[sku].push({row: r.row, code: r.code, fact: fact});
  });
  var skus = [];
  Object.keys(bySku).forEach(function (sku) {
    var items = bySku[sku];
    var facts = items.map(function (x) { return x.fact; }).filter(function (f, i, a) { return a.indexOf(f) === i; });
    if (facts.length > 1) {
      items.forEach(function (x) {
        results.push({row: x.row, code: x.code, sku: sku, action: 'ERROR', message: 'разные «Факт на полке» для одного SKU: ' + facts.join(', ')});
      });
      return;
    }
    var reserve = Math.max(0, flipInt_(reserveBySku[sku], 0) || 0);
    var existing = skladBySku[sku];
    var newC = facts[0] + reserve;
    skus.push({
      sku: sku, fact: facts[0], reserve: reserve, newC: newC,
      oldC: existing ? existing.c : null, skladRow: existing ? existing.row : null,
      append: !existing, codes: items.map(function (x) { return x.code; }), rows: items.map(function (x) { return x.row; })
    });
    items.forEach(function (x) {
      results.push({
        row: x.row, code: x.code, sku: sku, action: existing ? 'UPDATE' : 'APPEND',
        message: 'C ' + (existing ? existing.c : '—') + ' → ' + newC + ' (факт ' + facts[0] + ' + резерв ' + reserve + ')'
      });
    });
  });
  return {skus: skus, results: results};
}

/* ======================================================================
   ВВОД-ВЫВОД
   ====================================================================== */

function flipProps_() { return PropertiesService.getScriptProperties(); }

function flipIsDryRun_() {
  return String(flipProps_().getProperty(FLIP.PROPS.DRY_RUN) || 'TRUE').toUpperCase() !== 'FALSE';
}

function flipBuffer_() {
  var v = flipProps_().getProperty(FLIP.PROPS.BUFFER);
  var n = flipInt_(v, null);
  return n === null ? 1 : Math.max(0, n);
}

function flipSs_() { return klIoGetSpreadsheet_(); }

function flipSheet_(name) {
  var sh = flipSs_().getSheetByName(name);
  if (!sh) throw new Error('Не найден лист «' + name + '».');
  return sh;
}

function flipApiKey_() {
  var key = flipText_(flipProps_().getProperty(FLIP.PROPS.API_KEY));
  if (!key) throw new Error('Не задан Script Property FLIP_API_KEY.');
  return key;
}

/** GET к Flip API. Ключ только в заголовке; в ошибки и логи не попадает. */
function flipApiGet_(path, query) {
  var qs = (query || []).map(function (p) {
    return encodeURIComponent(p[0]).replace(/%5B%5D$/, '[]') + '=' + encodeURIComponent(p[1]);
  }).join('&');
  var url = FLIP.BASE_URL + path + (qs ? '?' + qs : '');
  var lastError = null;
  for (var attempt = 0; attempt < 3; attempt++) {
    try {
      var resp = UrlFetchApp.fetch(url, {
        method: 'get',
        headers: {Authorization: flipApiKey_(), Accept: 'application/json'},
        muteHttpExceptions: true,
        followRedirects: true
      });
      var status = resp.getResponseCode();
      var text = resp.getContentText('UTF-8');
      if (status === 429 || status >= 500) {
        lastError = new Error('Flip HTTP ' + status + ' ' + path);
        Utilities.sleep(1500 * (attempt + 1));
        continue;
      }
      if (status !== 200) throw new Error('Flip HTTP ' + status + ' ' + path + (/^\s*</.test(text) ? ' (HTML)' : ': ' + text.slice(0, 300)));
      if (/^\s*</.test(text)) throw new Error('Flip вернул HTML вместо JSON: ' + path);
      try { return JSON.parse(text); }
      catch (e) { throw new Error('Flip вернул некорректный JSON: ' + path + ' ' + text.slice(0, 200)); }
    } catch (error) {
      lastError = error;
      if (!/HTTP (429|5\d\d)/.test(String(error.message))) throw error;
    }
  }
  throw lastError || new Error('Flip API недоступен: ' + path);
}

function flipFetchAllOrders_(deadlineMs) {
  var all = [];
  var page = 1, pages = 1;
  while (page <= pages && page <= FLIP.MAX_PAGES) {
    if (Date.now() > deadlineMs) throw new Error('Не успели обойти все страницы GET /orders (' + page + '/' + pages + ').');
    var parsed = flipParseOrdersPage_(flipApiGet_('/orders', [['page', page], ['limit', FLIP.PAGE_LIMIT]]));
    pages = parsed.pages;
    all = all.concat(parsed.rows);
    page++;
  }
  var seen = Object.create(null);
  return all.filter(function (r) { if (seen[r.preorderId]) return false; seen[r.preorderId] = true; return true; });
}

function flipFetchStatuses_(ids, deadlineMs) {
  var result = Object.create(null);
  for (var i = 0; i < ids.length; i += FLIP.STATUS_BATCH) {
    if (Date.now() > deadlineMs) break;
    var chunk = ids.slice(i, i + FLIP.STATUS_BATCH);
    var query = chunk.map(function (id) { return ['goods[]', id]; });
    query.push(['history', 'true']);
    var parsed = flipParseStatusResponse_(flipApiGet_('/orders/statusGoods', query));
    Object.keys(parsed).forEach(function (k) { result[k] = parsed[k]; });
  }
  return result;
}

function flipLoadMapIndex_() {
  var sh = flipSheet_(FLIP.SHEETS.MAP);
  var n = sh.getLastRow() - 1;
  return flipBuildMapIndex_(n > 0 ? sh.getRange(2, 1, n, 6).getDisplayValues() : []);
}

function flipLoadPriceIndex_() {
  var sh = flipSheet_(FLIP.SHEETS.PRICE);
  var n = sh.getLastRow() - FLIP.PRICE_FIRST_ROW + 1;
  return flipBuildPriceIndex_(n > 0 ? sh.getRange(FLIP.PRICE_FIRST_ROW, 1, n, 12).getDisplayValues() : [], FLIP.PRICE_FIRST_ROW);
}

/** F «СКЛАД_НАЛИЧИЕ» как его видит Kaspi XML; пустая карта = источник недоступен. */
function flipLoadSkladMap_() {
  if (typeof SKLAD_getAvailableMap !== 'function') throw new Error('Не найдена SKLAD_getAvailableMap() (Sklad.gs).');
  var raw = SKLAD_getAvailableMap();
  var map = Object.create(null);
  Object.keys(raw || {}).forEach(function (k) { map[normalizeSku_(k)] = raw[k]; });
  return map;
}

/** Строки «СКЛАД_НАЛИЧИЕ»: {SKU: {row, c, f}}. */
function flipLoadSkladRows_() {
  var sh = flipSheet_(FLIP.SHEETS.SKLAD);
  var out = Object.create(null);
  if (sh.getLastRow() < 2) return {sheet: sh, bySku: out};
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues();
  vals.forEach(function (r, i) {
    var sku = normalizeSku_(r[0]);
    if (sku && !out[sku]) out[sku] = {row: i + 2, c: flipInt_(r[2], 0), f: flipInt_(r[5], 0)};
  });
  return {sheet: sh, bySku: out};
}

function flipEnsureHeaders_(name, headers) {
  var sh = flipSs_().getSheetByName(name) || flipSs_().insertSheet(name);
  var cur = sh.getRange(1, 1, 1, headers.length).getDisplayValues()[0];
  if (cur.every(function (c) { return !flipText_(c); })) sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  return sh;
}

var FLIP_ERROR_HEADERS_ = ['Время', 'Тип (UNMAPPED / CONFLICT / API / STATUS)', 'preorderId', 'produceId', 'article',
  'partnerCodes', 'SKU', 'Остаток до', 'Остаток после', 'Детали', 'Разобрано (TRUE/FALSE)'];
var FLIP_DRY_HEADERS_ = ['Время', 'ID запуска', 'Действие', 'preorderId', 'Код Flip', 'SKU',
  'Остаток сейчас', 'Остаток было бы', 'Flip count в XML', 'Детали'];

/** Пишет ошибки, не дублируя пару (тип, preorderId/ключ) среди неразобранных. */
function flipAppendErrors_(errors, dryRun) {
  if (!errors.length) return 0;
  var sh = flipEnsureHeaders_(FLIP.SHEETS.ERRORS, FLIP_ERROR_HEADERS_);
  var existing = Object.create(null);
  if (sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 11).getDisplayValues().forEach(function (r) {
      if (!flipTruthy_(r[10])) existing[r[1] + '|' + r[2] + '|' + r[9].slice(0, 60)] = true;
    });
  }
  var now = new Date();
  var rows = [];
  errors.forEach(function (e) {
    var details = (dryRun ? '[DRY_RUN] ' : '') + flipText_(e.details);
    var key = e.type + '|' + flipText_(e.preorderId) + '|' + details.slice(0, 60);
    if (existing[key]) return;
    existing[key] = true;
    rows.push([now, e.type, flipText_(e.preorderId), flipText_(e.produceId), flipText_(e.article),
      flipText_(e.partnerCodes), flipText_(e.sku), e.before === undefined ? '' : e.before,
      e.after === undefined ? '' : e.after, details.slice(0, 4000), false]);
  });
  if (!rows.length) return 0;
  var start = sh.getLastRow() + 1;
  sh.getRange(start, 3, rows.length, 5).setNumberFormat('@');
  sh.getRange(start, 1, rows.length, rows[0].length).setValues(rows);
  return rows.length;
}

/** Лог dry-run; одинаковые (действие, preorderId, детали) повторно не пишутся. */
function flipAppendDry_(runId, items) {
  if (!items.length) return 0;
  var sh = flipEnsureHeaders_(FLIP.SHEETS.DRY, FLIP_DRY_HEADERS_);
  var existing = Object.create(null);
  if (sh.getLastRow() > 1) {
    var from = Math.max(2, sh.getLastRow() - 3000);
    sh.getRange(from, 1, sh.getLastRow() - from + 1, 10).getDisplayValues().forEach(function (r) {
      existing[r[2] + '|' + r[3] + '|' + r[4] + '|' + r[6] + '|' + r[7] + '|' + r[9]] = true;
    });
  }
  var now = new Date();
  var rows = [];
  items.forEach(function (x) {
    var row = [now, runId, x.action, flipText_(x.preorderId), flipText_(x.code), flipText_(x.sku),
      x.stockNow === undefined ? '' : x.stockNow, x.stockWouldBe === undefined ? '' : x.stockWouldBe,
      x.flipCount === undefined ? '' : x.flipCount, flipText_(x.details).slice(0, 4000)];
    var key = [row[2], row[3], row[4], row[6], row[7], row[9]].map(flipText_).join('|');
    if (existing[key]) return;
    existing[key] = true;
    rows.push(row);
  });
  if (!rows.length) return 0;
  var start = sh.getLastRow() + 1;
  sh.getRange(start, 4, rows.length, 3).setNumberFormat('@');
  sh.getRange(start, 1, rows.length, 10).setValues(rows);
  return rows.length;
}

function flipNotify_(subject, lines, dryRun) {
  if (dryRun || !lines.length || typeof klNotifySend_ !== 'function') return;
  try { klNotifySend_('[Flip] ' + subject, lines.slice(0, 30).join('\n'), false); }
  catch (e) { console.warn('Flip: письмо не отправлено: ' + e.message); }
}

/** Служебное событие Flip в формате ledger (детерминированный Event ID). */
function flipMarker_(type, line, sku, idSuffix, details, nowMs) {
  return klLedgerNormalizePlannedEvent_({
    eventId: ['flip', type, line.preorderId, idSuffix || '1'].join('|'),
    eventType: type,
    qty: 1,
    cumulativeAfter: 1,
    orderId: line.orderId,
    lineId: line.lineId,
    code: line.preorderId,
    sku: sku,
    status: flipText_(line.status || ''),
    eventAtMs: nowMs,
    source: FLIP.SOURCE,
    details: details || {}
  }, {}, nowMs);
}

function flipLineFromOrder_(order) {
  return {preorderId: order.preorderId, orderId: flipOrderId_(order.preorderId), lineId: order.preorderId};
}

function flipFlipLines_(ledgerIndex) {
  var lines = Object.create(null);
  Object.keys(ledgerIndex.byLine).forEach(function (key) {
    var events = ledgerIndex.byLine[key];
    if (!events.length || !flipIsFlipOrderId_(events[0].orderId)) return;
    lines[events[0].lineId] = events;
  });
  return lines;
}

/**
 * Двухфазная запись колонки C «Прайс Flip»: для каждого FLIP_C_DEBIT/CREDIT без
 * FLIP_C_APPLIED сверяет текущее C с before/after из Details и доводит до after.
 */
function flipApplyPendingC_(lines, priceIndex, dryRun, nowMs, report) {
  var sheet = flipSheet_(FLIP.SHEETS.PRICE);
  var applied = [];
  Object.keys(lines).forEach(function (lineId) {
    var events = lines[lineId];
    var done = Object.create(null);
    events.forEach(function (e) {
      if (e.eventType === FLIP.EVENT.C_APPLIED) done[flipText_(e.details && e.details.intentId)] = true;
    });
    events.forEach(function (e) {
      if (e.eventType !== FLIP.EVENT.C_DEBIT && e.eventType !== FLIP.EVENT.C_CREDIT) return;
      if (done[e.eventId]) return;
      var d = e.details || {};
      var code = flipNormCode_(d.code);
      var p = priceIndex.byCode[code];
      var outcome;
      if (!p) outcome = 'CODE_NOT_FOUND';
      else {
        var cell = sheet.getRange(p.row, 3);
        var current = flipInt_(cell.getValue(), 0);
        if (current === d.after) outcome = 'ALREADY';
        else if (current === d.before) {
          if (!dryRun) cell.setValue(d.after);
          outcome = 'WRITTEN';
          p.qtyC = d.after;
        } else outcome = 'MANUAL_REVIEW';
        if (outcome === 'MANUAL_REVIEW') {
          report.errors.push({type: 'STATUS', preorderId: e.lineId, partnerCodes: code, sku: e.sku, before: current, after: d.after,
            details: 'C «Прайс Flip» изменили вручную между фазами (ожидалось ' + d.before + '); проверьте строку ' + p.row});
        }
      }
      var line = {preorderId: e.lineId, orderId: e.orderId, lineId: e.lineId};
      applied.push(flipMarker_(FLIP.EVENT.C_APPLIED, line, e.sku, e.eventType + '|' + e.eventId.split('|').pop(),
        {intentId: e.eventId, outcome: outcome, code: code}, nowMs));
      report.dry.push({action: 'C_' + (e.eventType === FLIP.EVENT.C_DEBIT ? 'DEBIT' : 'CREDIT') + '_' + outcome,
        preorderId: e.lineId, code: code, sku: '', stockNow: d.before, stockWouldBe: d.after});
    });
  });
  return applied;
}

/* ---------------- KL_FLIP_ORDERS_RUN ---------------- */

function KL_FLIP_ORDERS_RUN() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { console.log('[KL_FLIP_ORDERS_RUN] lock занят, пропуск'); return {skipped: 'LOCKED'}; }
  var summary;
  var recalc = false;
  try {
    summary = flipOrdersRunLocked_();
    recalc = summary.mappedReserves > 0 && !summary.dryRun;
  } finally {
    lock.releaseLock();
  }
  if (recalc && typeof SKLAD_recalc === 'function') SKLAD_recalc();
  return summary;
}

function flipOrdersRunLocked_() {
  var started = Date.now();
  var deadline = started + FLIP.RUNTIME_MS;
  var dryRun = flipIsDryRun_();
  var props = flipProps_();
  var initialized = props.getProperty(FLIP.PROPS.INITIALIZED) === 'YES';
  // Только для dry-run: показать, что было бы со списанием, как будто первый запуск уже прошёл.
  if (dryRun && props.getProperty(FLIP.PROPS.DRY_SIMULATE) === 'YES') initialized = true;
  var runId = 'orders-' + Utilities.formatDate(new Date(), 'Asia/Almaty', 'yyyyMMdd-HHmmss');
  var report = {errors: [], dry: [], notify: []};
  var summary = {dryRun: dryRun, initialized: initialized, orders: 0, newLines: 0, registered: 0,
    mappedReserves: 0, cDebits: 0, unmapped: 0, conflicts: 0, appended: 0, errors: 0};
  try {
    var orders = flipFetchAllOrders_(deadline);
    summary.orders = orders.length;
    var ledger = klLedgerReadIndex_();
    var lines = flipFlipLines_(ledger);
    var mapIndex = flipLoadMapIndex_();
    var priceIndex = flipLoadPriceIndex_();
    var sklad = flipLoadSkladRows_();
    mapIndex.errors.forEach(function (e) {
      report.errors.push({type: 'UNMAPPED', partnerCodes: e.code, details: '«Flip map» строка ' + e.row + ': ' + e.error});
    });
    var now = Date.now();
    var events = [];
    var reservedNow = Object.create(null);
    var cTaken = Object.create(null);

    // Фаза 2 прошлых запусков (сбой между намерением и записью C).
    var recovery = flipApplyPendingC_(lines, priceIndex, dryRun, now, report);
    if (recovery.length) events = events.concat(recovery);

    orders.forEach(function (o) {
      if (lines[o.preorderId]) return; // уже учтён: строго один раз на preorderId
      summary.newLines++;
      var line = flipLineFromOrder_(o);
      var res = flipResolveOrder_(o, mapIndex, priceIndex);
      var base = {preorderId: o.preorderId, produceId: o.produceId, article: o.article,
        partnerCodes: o.partnerCodes.join(','), sku: res.mode === 'MAPPED' ? res.sku : ''};
      var detailsCommon = {produceId: o.produceId, article: o.article, partnerCodes: o.partnerCodes,
        groupId: o.groupId, groupStoreName: o.groupStoreName, price: o.price, mode: res.mode, code: res.code};

      if (!initialized) {
        events.push(flipMarker_(FLIP.EVENT.REGISTERED, line, res.sku, '1', detailsCommon, now));
        summary.registered++;
        report.dry.push({action: 'REGISTER_ONLY', preorderId: o.preorderId, code: res.code, sku: base.sku,
          details: 'первый запуск: без списания; режим после инициализации был бы ' + res.mode});
        return;
      }

      if (res.mode === 'MAPPED') {
        var plan = klPlanLineSnapshot_(klFoldLineState_([]), flipSnapshotFor_(
          {orderId: line.orderId, lineId: line.lineId, preorderId: o.preorderId, sku: res.sku}, 'WAIT', now, 'new'), {source: FLIP.SOURCE});
        if (plan.errors && plan.errors.length) {
          report.errors.push(Object.assign({type: 'STATUS', details: 'planner: ' + plan.errors.join(', ')}, base));
          return;
        }
        plan.events.forEach(function (ev) {
          ev.details = Object.assign({}, ev.details || {}, detailsCommon);
          events.push(klLedgerNormalizePlannedEvent_(ev, {}, now));
        });
        var row = sklad.bySku[res.sku];
        var fNow = row ? row.f : 0;
        var used = reservedNow[res.sku] || 0;
        var before = fNow - used;
        reservedNow[res.sku] = used + 1;
        summary.mappedReserves++;
        if (!row) {
          summary.conflicts++;
          report.errors.push(Object.assign({type: 'CONFLICT', before: 0, after: 0,
            details: 'SKU нет в «СКЛАД_НАЛИЧИЕ»: резерв записан, остаток не может уйти ниже 0'}, base));
          report.notify.push('CONFLICT ' + res.sku + ' preorder ' + o.preorderId + ': SKU нет на складе');
        } else if (before <= 0) {
          summary.conflicts++;
          report.errors.push(Object.assign({type: 'CONFLICT', before: Math.max(0, before), after: 0,
            details: 'Flip продал при F=0 (одновременная продажа). Остаток остаётся 0, проверьте наличие.'}, base));
          report.notify.push('CONFLICT ' + res.sku + ' preorder ' + o.preorderId + ': F был ' + Math.max(0, before));
        }
        report.dry.push({action: 'WOULD_DEDUCT', preorderId: o.preorderId, code: res.code, sku: res.sku,
          stockNow: Math.max(0, before), stockWouldBe: Math.max(0, before - 1),
          flipCount: Math.max(0, before - 1 - flipBuffer_()), details: 'RESERVE в ledger (F «СКЛАД_НАЛИЧИЕ»)'});
        return;
      }

      if (res.mode === 'C') {
        var p = priceIndex.byCode[res.code];
        var cur = (cTaken[res.code] !== undefined ? cTaken[res.code] : p.qtyC);
        var take = cur > 0 ? 1 : 0;
        var after = cur - take;
        cTaken[res.code] = after;
        var intent = flipMarker_(FLIP.EVENT.C_DEBIT, line, res.sku, '1',
          Object.assign({before: cur, after: after, taken: take, row: p.row}, detailsCommon), now);
        events.push(intent);
        summary.cDebits++;
        if (!take) {
          summary.conflicts++;
          report.errors.push(Object.assign({type: 'CONFLICT', before: cur, after: after,
            details: 'C «Прайс Flip» уже 0 при заказе Flip; ниже 0 не уходим'}, base));
          report.notify.push('CONFLICT C=0 код ' + res.code + ' preorder ' + o.preorderId);
        }
        report.dry.push({action: 'WOULD_DEDUCT_C', preorderId: o.preorderId, code: res.code, sku: '',
          stockNow: cur, stockWouldBe: after, flipCount: after, details: 'несвязанный товар: колонка C «Прайс Flip»'});
        return;
      }

      events.push(flipMarker_(FLIP.EVENT.UNMAPPED, line, res.sku, '1', detailsCommon, now));
      summary.unmapped++;
      report.errors.push(Object.assign({type: 'UNMAPPED',
        details: 'partnerCodes не найдены ни в «Flip map», ни в «Прайс Flip» — остаток не списан'}, base));
      report.dry.push({action: 'UNMAPPED_NO_DEDUCT', preorderId: o.preorderId, code: res.code, details: 'не списано'});
    });

    // Фаза 1: все намерения и резервы одним batch.
    var appendResult = klLedgerAppendBatch_(events, dryRun);
    summary.appended = appendResult.appended;

    // Фаза 2: запись C по только что подтверждённым намерениям.
    if (!dryRun && summary.cDebits) {
      var after2 = flipFlipLines_(klLedgerReadIndex_());
      var applied = flipApplyPendingC_(after2, flipLoadPriceIndex_(), false, Date.now(), {errors: report.errors, dry: []});
      if (applied.length) klLedgerAppendBatch_(applied, false);
    }

    if (!dryRun && props.getProperty(FLIP.PROPS.INITIALIZED) !== 'YES') {
      props.setProperty(FLIP.PROPS.INITIALIZED, 'YES');
    }
  } catch (error) {
    report.errors.push({type: 'API', details: flipText_(error && error.message)});
    summary.fatal = flipText_(error && error.message);
    report.notify.push('KL_FLIP_ORDERS_RUN: ' + summary.fatal);
  }
  summary.errors = flipAppendErrors_(report.errors, dryRun);
  if (dryRun) summary.dryRows = flipAppendDry_(runId, report.dry);
  flipNotify_('Требуется проверка (заказы)', report.notify, dryRun);
  summary.elapsedMs = Date.now() - started;
  props.setProperty(FLIP.PROPS.ORDERS_LAST, JSON.stringify(summary));
  console.log('[KL_FLIP_ORDERS_RUN] ' + JSON.stringify(summary));
  return summary;
}

/* ---------------- KL_FLIP_STATUS_RUN ---------------- */

function KL_FLIP_STATUS_RUN() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { console.log('[KL_FLIP_STATUS_RUN] lock занят, пропуск'); return {skipped: 'LOCKED'}; }
  var summary;
  try { summary = flipStatusRunLocked_(); }
  finally { lock.releaseLock(); }
  if (summary.stockEvents > 0 && !summary.dryRun && typeof SKLAD_recalc === 'function') SKLAD_recalc();
  return summary;
}

function flipStatusRunLocked_() {
  var started = Date.now();
  var deadline = started + FLIP.RUNTIME_MS;
  var dryRun = flipIsDryRun_();
  var props = flipProps_();
  var runId = 'status-' + Utilities.formatDate(new Date(), 'Asia/Almaty', 'yyyyMMdd-HHmmss');
  var report = {errors: [], dry: [], notify: []};
  var summary = {dryRun: dryRun, open: 0, checked: 0, waiting: 0, closed: 0, stockEvents: 0, manual: 0, errors: 0};
  try {
    var ledger = klLedgerReadIndex_();
    var lines = flipFlipLines_(ledger);
    var mapIndex = flipLoadMapIndex_();
    var priceIndex = flipLoadPriceIndex_();
    var now = Date.now();
    var events = flipApplyPendingC_(lines, priceIndex, dryRun, now, report);
    var open = Object.keys(lines).filter(function (id) { return !flipLineClosed_(lines[id]); });
    summary.open = open.length;
    var statuses = flipFetchStatuses_(open, deadline);
    open.forEach(function (lineId) {
      var info = statuses[lineId];
      if (!info) return;
      summary.checked++;
      var lineEvents = lines[lineId];
      var first = lineEvents[0];
      var mode = flipLineMode_(lineEvents);
      var plannerEvents = flipPlannerEvents_(lineEvents);
      var state = klFoldLineState_(plannerEvents);
      var decision = flipStatusDecision_(info, state.shippedQty > 0);
      var line = {preorderId: lineId, orderId: first.orderId, lineId: lineId, sku: first.sku};
      var tag = {preorderId: lineId, sku: first.sku, partnerCodes: flipText_(first.details && first.details.code)};
      var label = 'код ' + info.code + ' «' + info.text + '» → ' + decision.action + ' (' + decision.reason + ')';

      if (decision.action === 'WAIT') { summary.waiting++; return; }
      if (decision.action === 'UNKNOWN') {
        report.errors.push(Object.assign({type: 'STATUS', details: 'неизвестный код статуса: ' + label}, tag));
        return;
      }
      if (decision.action === 'MANUAL') {
        summary.manual++;
        report.errors.push(Object.assign({type: 'STATUS', details: 'противоречие, разберите вручную: ' + label}, tag));
        report.notify.push('STATUS ' + lineId + ': ' + label);
        return;
      }

      var terminal = decision.action !== 'SHIP';
      if (mode === 'REGISTERED' || mode === 'UNMAPPED') {
        // Учтены вручную / не списывались: остаток не меняем никогда, только закрываем.
        if (terminal) {
          events.push(flipMarker_(FLIP.EVENT.CLOSED, line, first.sku, '1', {status: info.code, mode: mode, decision: decision.action}, now));
          summary.closed++;
          report.dry.push({action: 'CLOSE_' + mode, preorderId: lineId, sku: first.sku, details: label});
        }
        return;
      }

      if (mode === 'MAPPED') {
        var plan = klPlanLineSnapshot_(state, flipSnapshotFor_(line, decision.action, now, info.text), {source: FLIP.SOURCE});
        if (plan.errors && plan.errors.length) {
          report.errors.push(Object.assign({type: 'STATUS', details: 'planner: ' + plan.errors.join(', ') + '; ' + label}, tag));
          return;
        }
        plan.events.forEach(function (ev) {
          ev.details = Object.assign({}, ev.details || {}, {flipStatus: info.code, flipStatusText: info.text});
          events.push(klLedgerNormalizePlannedEvent_(ev, {}, now));
          if (ev.eventType === 'RELEASE') summary.stockEvents++;
        });
        report.dry.push({action: 'MAPPED_' + decision.action, preorderId: lineId, sku: first.sku,
          details: label + '; события: ' + plan.events.map(function (e) { return e.eventType; }).join(',') + ' (' + plan.decision + ')'});
        if (terminal) {
          events.push(flipMarker_(FLIP.EVENT.CLOSED, line, first.sku, '1', {status: info.code, decision: decision.action}, now));
          summary.closed++;
        }
        return;
      }

      if (mode === 'C') {
        var debit = lineEvents.filter(function (e) { return e.eventType === FLIP.EVENT.C_DEBIT; })[0];
        var d = (debit && debit.details) || {};
        var code = flipNormCode_(d.code);
        var p = priceIndex.byCode[code];
        if (decision.action === 'RELEASE') {
          if (!d.taken) {
            report.dry.push({action: 'C_RELEASE_NOTHING', preorderId: lineId, code: code, details: label + '; при заказе C уже был 0'});
          } else if (mapIndex.byCode[code]) {
            summary.manual++;
            report.errors.push(Object.assign({type: 'STATUS', details: 'отмена несвязанной продажи, но код уже активен в «Flip map»: +1 верните вручную в СКЛАД_НАЛИЧИЕ C (' + label + ')'}, tag));
          } else if (p) {
            events.push(flipMarker_(FLIP.EVENT.C_CREDIT, line, first.sku, '1',
              {code: code, before: p.qtyC, after: p.qtyC + 1, taken: 1, row: p.row, reason: decision.reason}, now));
            p.qtyC += 1;
            summary.stockEvents++;
            report.dry.push({action: 'WOULD_RETURN_C', preorderId: lineId, code: code, stockNow: p.qtyC - 1, stockWouldBe: p.qtyC, details: label});
          }
        }
        if (decision.action === 'RETURN' && d.taken) {
          // Возврат после доставки: задача в _KASPI_RETURN_TASKS через planner (RETURN_PENDING).
          var retPlan = klPlanLineSnapshot_(state, flipSnapshotFor_(line, 'RETURN', now, info.text), {source: FLIP.SOURCE});
          retPlan.events.forEach(function (ev) { events.push(klLedgerNormalizePlannedEvent_(ev, {}, now)); });
          report.dry.push({action: 'C_RETURN_PENDING', preorderId: lineId, code: code,
            details: label + '; ждёт подтверждения в _KASPI_RETURN_TASKS, затем +1 в C'});
        }
        if (terminal) {
          events.push(flipMarker_(FLIP.EVENT.CLOSED, line, first.sku, '1', {status: info.code, decision: decision.action}, now));
          summary.closed++;
        }
      }
    });

    // Подтверждённый вручную возврат несвязанного товара → +1 в C «Прайс Flip».
    Object.keys(lines).forEach(function (lineId) {
      var ev = lines[lineId];
      if (flipLineMode_(ev) !== 'C') return;
      var restock = ev.filter(function (e) { return e.eventType === 'RETURN_RESTOCK'; }).length;
      var credited = ev.filter(function (e) { return e.eventType === FLIP.EVENT.C_CREDIT && e.details && e.details.reason === 'RETURN_CONFIRMED'; }).length;
      if (restock > credited) {
        var debit = ev.filter(function (e) { return e.eventType === FLIP.EVENT.C_DEBIT; })[0];
        var code = flipNormCode_(debit && debit.details && debit.details.code);
        var p = priceIndex.byCode[code];
        if (!p) return;
        events.push(flipMarker_(FLIP.EVENT.C_CREDIT, {preorderId: lineId, orderId: ev[0].orderId, lineId: lineId}, ev[0].sku,
          'return' + restock, {code: code, before: p.qtyC, after: p.qtyC + 1, taken: 1, row: p.row, reason: 'RETURN_CONFIRMED'}, now));
        p.qtyC += 1;
        report.dry.push({action: 'WOULD_RETURN_C', preorderId: lineId, code: code, stockNow: p.qtyC - 1, stockWouldBe: p.qtyC, details: 'возврат подтверждён вручную'});
      }
    });

    klLedgerAppendBatch_(events, dryRun);
    if (!dryRun && events.some(function (e) { return e.eventType === FLIP.EVENT.C_CREDIT; })) {
      var applied = flipApplyPendingC_(flipFlipLines_(klLedgerReadIndex_()), flipLoadPriceIndex_(), false, Date.now(),
        {errors: report.errors, dry: []});
      if (applied.length) klLedgerAppendBatch_(applied, false);
    }
    if (!dryRun && typeof klSyncReturnTasks_ === 'function') klSyncReturnTasks_(false);
  } catch (error) {
    report.errors.push({type: 'API', details: flipText_(error && error.message)});
    summary.fatal = flipText_(error && error.message);
    report.notify.push('KL_FLIP_STATUS_RUN: ' + summary.fatal);
  }
  summary.errors = flipAppendErrors_(report.errors, dryRun);
  if (dryRun) summary.dryRows = flipAppendDry_(runId, report.dry);
  flipNotify_('Требуется проверка (статусы)', report.notify, dryRun);
  summary.elapsedMs = Date.now() - started;
  props.setProperty(FLIP.PROPS.STATUS_LAST, JSON.stringify(summary));
  console.log('[KL_FLIP_STATUS_RUN] ' + JSON.stringify(summary));
  return summary;
}

/* ---------------- FLIP_XML_RUN / doGet ---------------- */

function flipBuildXml_() {
  var priceIndex = flipLoadPriceIndex_();
  var mapIndex = flipLoadMapIndex_();
  var sklad = flipLoadSkladMap_();
  if (!Object.keys(sklad).length) {
    throw new Error('SKLAD_getAvailableMap() пустая — Flip XML не обновлён (как и Kaspi XML).');
  }
  var built = flipBuildOffers_(priceIndex, mapIndex, sklad, flipBuffer_());
  var min = flipInt_(flipProps_().getProperty(FLIP.PROPS.XML_MIN_OFFERS), FLIP.XML_MIN_OFFERS_DEFAULT);
  if (built.offers.length < min) {
    throw new Error('Flip XML: всего ' + built.offers.length + ' offer (< ' + min + '), файл не обновлён.');
  }
  return {xml: flipRenderXml_(built.offers), offers: built.offers, report: built.report,
    errors: priceIndex.errors.concat(mapIndex.errors)};
}

function FLIP_XML_RUN() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) { console.log('[FLIP_XML_RUN] lock занят, пропуск'); return {skipped: 'LOCKED'}; }
  try {
    var props = flipProps_();
    var built = flipBuildXml_();
    var file = flipSaveXmlFile_(built.xml);
    var mapped = built.report.filter(function (r) { return r.mode === 'MAPPED'; });
    var result = {
      ok: true, at: new Date().toISOString(), offers: built.offers.length,
      inStock: built.offers.filter(function (o) { return o.count > 0; }).length,
      mapped: mapped.length, buffer: flipBuffer_(), dryRun: flipIsDryRun_(), size: built.xml.length, fileId: file.getId()
    };
    props.setProperty(FLIP.PROPS.XML_LAST, JSON.stringify(result));
    if (flipIsDryRun_()) {
      flipAppendDry_('xml-' + Utilities.formatDate(new Date(), 'Asia/Almaty', 'yyyyMMdd-HHmm'), mapped.map(function (r) {
        return {action: 'XML_MAPPED', code: r.code, sku: r.sku, stockNow: r.stock, flipCount: r.count, details: r.note || ('цена ' + r.price)};
      }));
    }
    console.log('[FLIP_XML_RUN] ' + JSON.stringify(result));
    return result;
  } catch (error) {
    flipProps_().setProperty(FLIP.PROPS.XML_LAST, JSON.stringify({ok: false, at: new Date().toISOString(), error: flipText_(error.message)}));
    flipAppendErrors_([{type: 'API', details: 'FLIP_XML_RUN: ' + flipText_(error.message)}], flipIsDryRun_());
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function flipSaveXmlFile_(xml) {
  var props = flipProps_();
  var id = props.getProperty(FLIP.PROPS.XML_FILE_ID);
  if (id) {
    try { var f = DriveApp.getFileById(id); f.setContent(xml); return f; }
    catch (e) { console.warn('Flip XML-файл не найден, создаётся новый.'); }
  }
  var ss = flipSs_();
  var parents = DriveApp.getFileById(ss.getId()).getParents();
  var folder = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  var file = folder.createFile(Utilities.newBlob(xml, 'application/xml', FLIP.XML_FILE_NAME));
  file.setDescription('Автоматический XML-прайс GRANTS BOOK для Flip.kz.');
  props.setProperty(FLIP.PROPS.XML_FILE_ID, file.getId());
  return file;
}

/** Вызывается из doGet при ?feed=flip (без параметра doGet не меняется). */
function FLIP_DOGET_(params) {
  var props = flipProps_();
  if (params && params.status === '1') {
    return ContentService.createTextOutput(props.getProperty(FLIP.PROPS.XML_LAST) || '{"ok":false}')
      .setMimeType(ContentService.MimeType.JSON);
  }
  var id = props.getProperty(FLIP.PROPS.XML_FILE_ID);
  if (!id) { FLIP_XML_RUN(); id = props.getProperty(FLIP.PROPS.XML_FILE_ID); }
  if (!id) throw new Error('Flip XML ещё не создан. Запустите FLIP_XML_RUN.');
  var xml = DriveApp.getFileById(id).getBlob().getDataAsString('UTF-8');
  if (!/<offers>/.test(xml) || !/<\/offers>\s*$/.test(xml)) throw new Error('Flip XML повреждён.');
  return ContentService.createTextOutput(xml).setMimeType(ContentService.MimeType.TEXT);
}

/* ---------------- Перенос «Flip перенос» → «СКЛАД_НАЛИЧИЕ» ---------------- */

function flipTransferLoad_() {
  var sh = flipSheet_(FLIP.SHEETS.TRANSFER);
  var n = sh.getLastRow() - 1;
  var vals = n > 0 ? sh.getRange(2, 1, n, 8).getValues() : [];
  var disp = n > 0 ? sh.getRange(2, 1, n, 8).getDisplayValues() : [];
  var rows = vals.map(function (r, i) {
    return {row: i + 2, code: flipText_(disp[i][0]), sku: flipText_(disp[i][2]), fact: disp[i][5],
      transfer: r[6] === true || flipTruthy_(disp[i][6]), status: flipText_(disp[i][7])};
  });
  return {sheet: sh, rows: rows};
}

/** Открытые резервы по SKU прямо из ledger (та же свёртка, что SKLAD_recalc). */
function flipReserveBySku_(skus) {
  var ledger = skReadLedgerEvents_();
  if (ledger.problem) throw new Error(ledger.problem);
  var now = Date.now();
  var out = Object.create(null);
  skus.forEach(function (sku) { out[sku] = skLedgerSkuState_(ledger.events, sku, now).activeReserve; });
  return out;
}

function flipTransferPrepare_() {
  var t = flipTransferLoad_();
  var sklad = flipLoadSkladRows_();
  var skus = t.rows.filter(function (r) { return r.transfer && r.sku; })
    .map(function (r) { return flipText_(r.sku).replace(/\s+/g, ''); });
  var reserve = flipReserveBySku_(skus);
  return {transfer: t, sklad: sklad, plan: flipTransferPlan_(t.rows, sklad.bySku, reserve)};
}

function FLIP_TRANSFER_DRY_RUN() {
  var prep = flipTransferPrepare_();
  var runId = 'transfer-dry-' + Utilities.formatDate(new Date(), 'Asia/Almaty', 'yyyyMMdd-HHmmss');
  flipAppendDry_(runId, prep.plan.results.map(function (r) {
    var s = prep.plan.skus.filter(function (x) { return x.sku === r.sku; })[0];
    return {action: 'TRANSFER_' + r.action, code: r.code, sku: r.sku,
      stockNow: s ? (s.oldC === null ? '' : s.oldC) : '', stockWouldBe: s ? s.newC : '',
      details: 'строка ' + r.row + ': ' + r.message};
  }));
  var out = {mode: 'DRY_RUN', skus: prep.plan.skus, results: prep.plan.results};
  console.log('[FLIP_TRANSFER_DRY_RUN] ' + JSON.stringify(out));
  return out;
}

/** Боевой перенос. Требует FLIP_TRANSFER_ALLOWED=YES (снимается после запуска). */
function FLIP_TRANSFER_RUN() {
  var props = flipProps_();
  if (props.getProperty(FLIP.PROPS.TRANSFER_ALLOWED) !== 'YES') {
    throw new Error('Перенос запрещён. После проверки dry-run задайте FLIP_TRANSFER_ALLOWED=YES.');
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Другой цикл сейчас выполняется, повторите позже.');
  var prep;
  try {
    prep = flipTransferPrepare_();
    var sh = prep.sklad.sheet;
    var now = new Date();
    var mapSheet = flipSheet_(FLIP.SHEETS.MAP);
    var mapCodes = mapSheet.getLastRow() > 1 ? mapSheet.getRange(2, 2, mapSheet.getLastRow() - 1, 1).getDisplayValues() : [];
    var statusByRow = Object.create(null);
    prep.plan.results.forEach(function (r) {
      if (r.action === 'ERROR') statusByRow[r.row] = 'ошибка: ' + r.message;
    });
    prep.plan.skus.forEach(function (s) {
      if (s.append) {
        var r = sh.getLastRow() + 1;
        sh.getRange(r, 1).setNumberFormat('@').setValue(s.sku);
        sh.getRange(r, 2).setFormula("=VLOOKUP(A" + r + "; 'Прайс KASPI'!$A:$B; 2; FALSE)");
        sh.getRange(r, 3, 1, 2).setValues([[s.newC, now]]);
        sh.getRange(r, 9).setFormula("=COUNTIF('Прайс KASPI'!A:A; A" + r + ")");
      } else {
        sh.getRange(s.skladRow, 3, 1, 2).setValues([[s.newC, now]]);
      }
      s.codes.forEach(function (code) {
        var key = flipNormCode_(code);
        for (var i = 0; i < mapCodes.length; i++) {
          if (flipNormCode_(mapCodes[i][0]) === key) {
            mapSheet.getRange(i + 2, 1).setNumberFormat('@').setValue(s.sku);
            mapSheet.getRange(i + 2, 5).setValue(true);
          }
        }
      });
      var msg = 'перенесено ' + Utilities.formatDate(now, 'Asia/Almaty', 'dd.MM.yyyy HH:mm') + ', C было ' +
        (s.oldC === null ? '— (новая строка)' : s.oldC) + ' → стало ' + s.newC + ' (факт ' + s.fact + ' + резерв ' + s.reserve + ')';
      s.rows.forEach(function (row) { statusByRow[row] = msg; });
    });
    Object.keys(statusByRow).forEach(function (row) {
      prep.transfer.sheet.getRange(Number(row), 8).setValue(statusByRow[row]);
    });
    SpreadsheetApp.flush();
    props.deleteProperty(FLIP.PROPS.TRANSFER_ALLOWED);
  } finally {
    lock.releaseLock();
  }
  if (typeof SKLAD_recalc === 'function') SKLAD_recalc();
  var out = {mode: 'APPLIED', skus: prep.plan.skus, results: prep.plan.results};
  console.log('[FLIP_TRANSFER_RUN] ' + JSON.stringify(out));
  return out;
}

/* ---------------- Триггеры и самопроверка ---------------- */

/** Создаёт только отсутствующие Flip-триггеры; чужие не трогает. */
function FLIP_INSTALL_TRIGGERS() {
  var have = Object.create(null);
  ScriptApp.getProjectTriggers().forEach(function (t) { have[t.getHandlerFunction()] = true; });
  var created = [];
  if (!have.KL_FLIP_ORDERS_RUN) { ScriptApp.newTrigger('KL_FLIP_ORDERS_RUN').timeBased().everyMinutes(5).create(); created.push('KL_FLIP_ORDERS_RUN'); }
  if (!have.KL_FLIP_STATUS_RUN) { ScriptApp.newTrigger('KL_FLIP_STATUS_RUN').timeBased().everyHours(1).create(); created.push('KL_FLIP_STATUS_RUN'); }
  if (!have.FLIP_XML_RUN) { ScriptApp.newTrigger('FLIP_XML_RUN').timeBased().everyMinutes(15).create(); created.push('FLIP_XML_RUN'); }
  console.log('FLIP_INSTALL_TRIGGERS: ' + JSON.stringify(created));
  return created;
}

function flipAssert_(cond, msg) { if (!cond) throw new Error('FLIP_SELF_TEST: ' + msg); }

/** Чистые проверки; ничего не читает из таблицы и не пишет. */
function FLIP_SELF_TEST() {
  var D = function (code, hist) { return flipStatusDecision_({code: code, text: '', history: hist || []}, false).action; };
  flipAssert_(D(1) === 'WAIT' && D(2) === 'WAIT' && D(11) === 'WAIT' && D(12) === 'WAIT', 'ожидание');
  flipAssert_(flipStatusDecision_({code: null, history: []}, false).action === 'WAIT', 'нет кода');
  flipAssert_(D(3) === 'SHIP' && D(4) === 'SHIP', 'в пути');
  flipAssert_(D(5) === 'COMPLETE' && D(6) === 'COMPLETE' && D(7) === 'COMPLETE', 'закрыть');
  flipAssert_(D(9) === 'RELEASE', '9 без отгрузки');
  flipAssert_(flipStatusDecision_({code: 9, history: []}, true).action === 'MANUAL', '9 после SHIP');
  flipAssert_(D(8, [1, 2]) === 'RELEASE', '8 без отгрузки');
  flipAssert_(D(8, [1, 2, 3]) === 'COMPLETE', '8 после отгрузки');
  flipAssert_(flipStatusDecision_({code: 8, history: []}, true).action === 'COMPLETE', '8 при SHIP в ledger');
  flipAssert_(D(10) === 'RETURN' && D(42) === 'UNKNOWN', '10 и неизвестный');

  var line = {orderId: 'flip:777', lineId: '777', preorderId: '777', sku: 'SKU-1'};
  var plan = klPlanLineSnapshot_(klFoldLineState_([]), flipSnapshotFor_(line, 'WAIT', 1000, ''), {});
  flipAssert_(plan.events.length === 1 && plan.events[0].eventType === 'RESERVE', 'новый заказ → RESERVE');
  var reserved = klFoldLineState_(plan.events);
  var again = klPlanLineSnapshot_(reserved, flipSnapshotFor_(line, 'WAIT', 2000, ''), {});
  flipAssert_(again.events.length === 0, 'повтор → без событий');
  var rel = klPlanLineSnapshot_(reserved, flipSnapshotFor_(line, 'RELEASE', 3000, ''), {});
  flipAssert_(rel.events.length === 1 && rel.events[0].eventType === 'RELEASE', '9 → RELEASE');
  var ship = klPlanLineSnapshot_(reserved, flipSnapshotFor_(line, 'SHIP', 3000, ''), {});
  flipAssert_(ship.events.length === 1 && ship.events[0].eventType === 'SHIP', '3 → SHIP');
  var shipped = klFoldLineState_(plan.events.concat(ship.events));
  var done = klPlanLineSnapshot_(shipped, flipSnapshotFor_(line, 'COMPLETE', 4000, ''), {});
  flipAssert_(done.events.map(function (e) { return e.eventType; }).join() === 'COMPLETE', '6 после SHIP → COMPLETE');
  var ret = klPlanLineSnapshot_(shipped, flipSnapshotFor_(line, 'RETURN', 5000, ''), {});
  flipAssert_(ret.events.map(function (e) { return e.eventType; }).join() === 'RETURN_PENDING', '10 → RETURN_PENDING');
  var directDone = klPlanLineSnapshot_(reserved, flipSnapshotFor_(line, 'COMPLETE', 4000, ''), {});
  flipAssert_(directDone.events.map(function (e) { return e.eventType; }).join() === 'SHIP,COMPLETE', '6 сразу → SHIP,COMPLETE');

  var map = flipBuildMapIndex_([
    ['SKU-1', '000033', '', '6364', 'TRUE', ''],
    ['SKU-1', 'OPTBOOK041', '', '4494', 'FALSE', ''],
    ['', '000042', '', '4494', 'TRUE', '']
  ]);
  flipAssert_(map.byCode['000033'] && !map.byCode.OPTBOOK041 && map.errors.length === 1, 'Flip map');
  var price = flipBuildPriceIndex_([
    ['000033', 'Уве', '3', '', '', '', '', '', '6 364 тг', '', '', ''],
    ['OPTBOOK041', 'Уве 2', '2', '', '', '', '', '', '4 494 тг', '', '', '123'],
    ['OPTBOOK519', 'Без цены', '5', '', '', '', '', '', '', '', '', ''],
    ['Учебник длинный текст без кода', 'https://kaspi.kz/x']
  ], 5);
  flipAssert_(price.order.length === 3 && price.byCode.OPTBOOK041.price === 4494, 'Прайс Flip');
  flipAssert_(flipResolveOrder_({partnerCodes: ['000033']}, map, price).mode === 'MAPPED', 'resolve MAPPED');
  flipAssert_(flipResolveOrder_({partnerCodes: ['X', 'OPTBOOK041']}, map, price).mode === 'C', 'resolve C');
  flipAssert_(flipResolveOrder_({partnerCodes: ['NOPE']}, map, price).mode === 'UNMAPPED', 'resolve UNMAPPED');
  var offers = flipBuildOffers_(price, map, {'SKU-1': 5}, 1).offers;
  flipAssert_(offers[0].count === 4 && offers[0].price === 6364, 'связанный: F−буфер');
  flipAssert_(offers[1].count === 2 && offers[1].barcode === '123', 'несвязанный: C');
  flipAssert_(offers[2].count === 0 && !offers[2].price, 'без цены → 0');
  flipAssert_(flipBuildOffers_(price, map, {}, 1).offers[0].count === 0, 'нет на складе → 0');
  var xml = flipRenderXml_(offers);
  flipAssert_(/^<\?xml/.test(xml) && /<\/offers>$/.test(xml) && (xml.match(/<offer>/g) || []).length === 3, 'XML');

  var tp = flipTransferPlan_([
    {row: 2, code: '000033', sku: 'OPTBOOK041', fact: 3, transfer: true, status: ''},
    {row: 3, code: 'OPTBOOK041', sku: 'OPTBOOK041', fact: 3, transfer: true, status: ''},
    {row: 4, code: '010001', sku: 'MEL', fact: 1, transfer: true, status: ''},
    {row: 5, code: '010002', sku: 'MEL', fact: 2, transfer: true, status: ''},
    {row: 6, code: '000029', sku: 'NEW', fact: 0, transfer: true, status: ''},
    {row: 7, code: '000040', sku: 'X', fact: '', transfer: true, status: ''},
    {row: 8, code: '000041', sku: 'Y', fact: 1, transfer: false, status: ''}
  ], {OPTBOOK041: {row: 9, c: 1}}, {OPTBOOK041: 4});
  var s041 = tp.skus.filter(function (s) { return s.sku === 'OPTBOOK041'; })[0];
  flipAssert_(s041 && s041.newC === 7 && !s041.append && s041.codes.length === 2, 'вариант Б: факт + резерв');
  flipAssert_(!tp.skus.some(function (s) { return s.sku === 'MEL'; }), 'разные факты → не переносить');
  flipAssert_(tp.skus.filter(function (s) { return s.sku === 'NEW'; })[0].append, 'новая строка');
  flipAssert_(tp.results.some(function (r) { return r.row === 7 && r.action === 'ERROR'; }), 'нет факта');
  flipAssert_(!tp.results.some(function (r) { return r.row === 8; }), 'без флажка не трогаем');

  var parsed = flipParseStatusResponse_({data: [{preorderId: 777, status_code: '9', status_text: 'Отменен поставщиком',
    history: [{status_code: '1'}, {status_code: '9'}]}, {preorderId: 778}]});
  flipAssert_(parsed['777'].code === 9 && parsed['777'].history.join() === '1,9' && parsed['778'].code === null, 'statusGoods');
  var page = flipParseOrdersPage_({data: [{preorderId: 1, partnerCodes: ['000033', ' 0000002 ']}], meta: {pagination: {pages: 3}}});
  flipAssert_(page.pages === 3 && page.rows[0].partnerCodes.join() === '000033,0000002', 'GET /orders');
  var threw = false;
  try { flipParseOrdersPage_({error: 'bad limit'}); } catch (e) { threw = true; }
  flipAssert_(threw, 'ошибка с HTTP 200');
  return 'OK: FLIP_SELF_TEST';
}
