/**
 * Инкрементальный сборщик заказов Kaspi для GAS V8.
 *
 * Запуск по умолчанию — DRY_RUN. Запись в ledger разрешена только при
 * KL_DRY_RUN=FALSE и KL_CUTOVER_READY=YES одновременно. Ни одна функция в
 * этом файле не заменяет legacy ORDERS_RUN/KASPI_XML_RUN/buildXml_.
 */

var KL_ORDERS_RUNTIME_MS_ = 270000; // около 4,5 минуты
var KL_ORDERS_COMMIT_RESERVE_MS_ = 35000;
var KL_ORDERS_OVERLAP_MS_ = 48 * 60 * 60 * 1000;
var KL_ORDERS_PAGE_SIZE_ = 100;
var KL_ORDERS_MAX_PAGES_ = 1000;
var KL_ORDERS_MAX_RETRIES_ = 3;
var KL_ORDERS_DEFAULT_STATES_ = Object.freeze([
  'NEW', 'SIGN_REQUIRED', 'PICKUP', 'DELIVERY', 'KASPI_DELIVERY', 'ARCHIVE'
]);

var KL_ORDERS_PROPS_ = Object.freeze({
  CURSOR: 'KL_ORDERS_CURSOR_MS',
  WINDOW_FROM: 'KL_ORDERS_WINDOW_FROM_MS',
  WINDOW_TO: 'KL_ORDERS_WINDOW_TO_MS',
  NEXT_PAGE: 'KL_ORDERS_NEXT_PAGE',
  NEXT_STATE_INDEX: 'KL_ORDERS_NEXT_STATE_INDEX'
});

function klOrdersStates_() {
  var configured = typeof GB !== 'undefined' && GB && Array.isArray(GB.ORDERS_STATES)
    ? GB.ORDERS_STATES.slice() : KL_ORDERS_DEFAULT_STATES_.slice();
  // ARCHIVE нужен для финальных CANCELLED/COMPLETED/RETURNED.
  configured.push('ARCHIVE');
  var seen = Object.create(null);
  return configured.map(function (state) {
    return klIoText_(state).toUpperCase();
  }).filter(function (state) {
    if (!state || seen[state]) return false;
    seen[state] = true;
    return true;
  });
}

function klOrdersSafetyMode_(props) {
  var dryRunRaw = klIoText_(props.getProperty(KL_DRY_RUN_PROPERTY_)).toUpperCase();
  var cutoverRaw = klIoText_(props.getProperty(KL_CUTOVER_READY_PROPERTY_)).toUpperCase();
  var production = dryRunRaw === 'FALSE' && cutoverRaw === 'YES';
  return {
    dryRun: !production,
    production: production,
    dryRunFlag: dryRunRaw || '(unset)',
    cutoverFlag: cutoverRaw || '(unset)'
  };
}

function klOrdersReadWindow_(props, nowMs, production) {
  var savedFrom = klIoToMs_(props.getProperty(KL_ORDERS_PROPS_.WINDOW_FROM), 0);
  var savedTo = klIoToMs_(props.getProperty(KL_ORDERS_PROPS_.WINDOW_TO), 0);
  var savedPage = Math.max(0, Math.floor(klIoNumber_(
    props.getProperty(KL_ORDERS_PROPS_.NEXT_PAGE), 0
  )));
  var savedStateIndex = Math.max(0, Math.floor(klIoNumber_(
    props.getProperty(KL_ORDERS_PROPS_.NEXT_STATE_INDEX), 0
  )));
  if (production && savedFrom > 0 && savedTo >= savedFrom) {
    return {
      fromMs: savedFrom,
      toMs: savedTo,
      page: savedPage,
      stateIndex: savedStateIndex,
      resumed: true
    };
  }

  var cursor = klIoToMs_(props.getProperty(KL_ORDERS_PROPS_.CURSOR), 0);
  var fromMs = cursor > 0 ? Math.max(0, cursor - KL_ORDERS_OVERLAP_MS_) :
    Math.max(0, nowMs - KL_ORDERS_OVERLAP_MS_);
  return {fromMs: fromMs, toMs: nowMs, page: 0, stateIndex: 0, resumed: false};
}

function klOrdersSaveInitialWindow_(props, windowState, production) {
  if (!production || windowState.resumed) return;
  props.setProperties({
    KL_ORDERS_WINDOW_FROM_MS: String(windowState.fromMs),
    KL_ORDERS_WINDOW_TO_MS: String(windowState.toMs),
    KL_ORDERS_NEXT_PAGE: String(windowState.page),
    KL_ORDERS_NEXT_STATE_INDEX: String(windowState.stateIndex || 0)
  }, false);
}

function klOrdersSaveProgress_(
  props, windowState, nextStateIndex, nextPage, complete, production
) {
  if (!production) return;
  if (complete) {
    props.setProperty(KL_ORDERS_PROPS_.CURSOR, String(windowState.toMs));
    props.deleteProperty(KL_ORDERS_PROPS_.WINDOW_FROM);
    props.deleteProperty(KL_ORDERS_PROPS_.WINDOW_TO);
    props.deleteProperty(KL_ORDERS_PROPS_.NEXT_PAGE);
    props.deleteProperty(KL_ORDERS_PROPS_.NEXT_STATE_INDEX);
    return;
  }
  props.setProperties({
    KL_ORDERS_WINDOW_FROM_MS: String(windowState.fromMs),
    KL_ORDERS_WINDOW_TO_MS: String(windowState.toMs),
    KL_ORDERS_NEXT_PAGE: String(Math.max(0, nextPage)),
    KL_ORDERS_NEXT_STATE_INDEX: String(Math.max(0, nextStateIndex))
  }, false);
}

function klOrdersBaseUrl_() {
  var configured = '';
  if (typeof GB !== 'undefined' && GB) {
    configured = klIoText_(
      GB.KASPI_ORDERS_URL || GB.KASPI_API_URL || GB.KASPI_BASE_URL ||
      GB.KASPI_BASE || GB.kaspiOrdersUrl
    );
  }
  if (!configured) configured = 'https://kaspi.kz/shop/api/v2/orders';
  if (/\/orders(?:\?|$)/.test(configured)) return configured.replace(/\?$/, '');
  if (/\/shop\/api\/v2\/?$/.test(configured)) {
    return configured.replace(/\/$/, '') + '/orders';
  }
  return configured.replace(/\/$/, '') + '/shop/api/v2/orders';
}

function klOrdersQueryPart_(key, value) {
  return encodeURIComponent(key) + '=' + encodeURIComponent(String(value));
}

function klOrdersPageUrl_(state, fromMs, toMs, page, pageSize) {
  var query = [
    klOrdersQueryPart_('page[number]', page),
    klOrdersQueryPart_('page[size]', pageSize),
    klOrdersQueryPart_('filter[orders][state]', state),
    klOrdersQueryPart_('filter[orders][creationDate][$ge]', fromMs),
    klOrdersQueryPart_('filter[orders][creationDate][$le]', toMs),
    klOrdersQueryPart_('include[orders]', 'entries')
  ];
  var base = klOrdersBaseUrl_();
  return base + (base.indexOf('?') >= 0 ? '&' : '?') + query.join('&');
}

function klOrdersToken_() {
  var token = '';
  if (typeof GB !== 'undefined' && GB) {
    token = klIoText_(
      GB.KASPI_TOKEN || GB.KASPI_API_TOKEN || GB.KASPI_API_KEY ||
      GB.kaspiToken || GB.token
    );
  }
  if (token) return token;
  var props = PropertiesService.getScriptProperties();
  return klIoText_(
    props.getProperty('KASPI_TOKEN') || props.getProperty('KASPI_API_TOKEN')
  );
}

function klOrdersDirectFetch_(url) {
  var headers = {
    Accept: 'application/vnd.api+json',
    'Content-Type': 'application/vnd.api+json'
  };
  var token = klOrdersToken_();
  if (token) headers['X-Auth-Token'] = token;
  return UrlFetchApp.fetch(url, {
    method: 'get',
    headers: headers,
    muteHttpExceptions: true,
    followRedirects: true
  });
}

function klOrdersParseFetchResult_(result) {
  if (result === null || result === undefined) {
    throw new Error('Kaspi API вернул пустой ответ.');
  }

  if (result && typeof result.getResponseCode === 'function') {
    var code = Number(result.getResponseCode());
    var body = result.getContentText();
    if (code < 200 || code >= 300) {
      var httpError = new Error('Kaspi HTTP ' + code + ': ' + String(body).slice(0, 500));
      httpError.statusCode = code;
      httpError.retryable = code === 408 || code === 429 || code >= 500;
      throw httpError;
    }
    result = body;
  }

  if (typeof result === 'string') {
    try {
      return JSON.parse(result);
    } catch (error) {
      throw new Error('Kaspi API вернул невалидный JSON: ' + error.message);
    }
  }
  if (result && typeof result.body === 'string' && result.data === undefined) {
    return klOrdersParseFetchResult_(result.body);
  }
  return result;
}

/** Повторяет только сетевой вызов; planner и append никогда не повторяются внутри retry. */
function klOrdersFetchJsonWithRetry_(url, deadlineMs) {
  var lastError = null;
  for (var attempt = 0; attempt < KL_ORDERS_MAX_RETRIES_; attempt++) {
    if (Date.now() >= deadlineMs) throw new Error('Истёк budget до API-запроса.');
    try {
      var response = typeof fetchKaspiJson_ === 'function'
        ? fetchKaspiJson_(url, klOrdersToken_())
        : klOrdersDirectFetch_(url);
      return klOrdersParseFetchResult_(response);
    } catch (error) {
      lastError = error;
      if (error && error.retryable === false) break;
      if (attempt + 1 >= KL_ORDERS_MAX_RETRIES_) break;
      var waitMs = Math.min(8000, 500 * Math.pow(2, attempt) + Math.floor(Math.random() * 250));
      if (Date.now() + waitMs >= deadlineMs) break;
      Utilities.sleep(waitMs);
    }
  }
  throw lastError || new Error('Kaspi API недоступен.');
}

function klOrdersFetchPage_(state, fromMs, toMs, page, pageSize, deadlineMs) {
  // fetchKaspiJson_ — предпочтительный проектный helper.
  if (typeof fetchKaspiJson_ === 'function') {
    return klOrdersFetchJsonWithRetry_(
      klOrdersPageUrl_(state, fromMs, toMs, page, pageSize), deadlineMs
    );
  }

  // Мягкая совместимость с инсталляциями, где есть только fetchOrders_.
  if (typeof fetchOrders_ === 'function') {
    var lastError = null;
    for (var attempt = 0; attempt < KL_ORDERS_MAX_RETRIES_; attempt++) {
      try {
        return klOrdersParseFetchResult_(
          fetchOrders_(state, fromMs, toMs, page, pageSize)
        );
      } catch (error) {
        lastError = error;
        if (attempt + 1 >= KL_ORDERS_MAX_RETRIES_) break;
        var waitMs = Math.min(8000, 500 * Math.pow(2, attempt));
        if (Date.now() + waitMs >= deadlineMs) break;
        Utilities.sleep(waitMs);
      }
    }
    throw lastError || new Error('fetchOrders_ не вернул заказы.');
  }

  return klOrdersFetchJsonWithRetry_(
    klOrdersPageUrl_(state, fromMs, toMs, page, pageSize), deadlineMs
  );
}

function klOrdersIncludedIndex_(included) {
  var index = Object.create(null);
  (included || []).forEach(function (resource) {
    if (!resource) return;
    var id = klIoText_(resource.id);
    var type = klIoText_(resource.type);
    if (id) index[(type ? type + ':' : '') + id] = resource;
    if (id && !index[id]) index[id] = resource;
  });
  return index;
}

function klOrdersResolveIncluded_(reference, includedIndex) {
  if (!reference) return null;
  if (reference.attributes) return reference;
  var id = klIoText_(reference.id);
  var type = klIoText_(reference.type);
  return includedIndex[(type ? type + ':' : '') + id] || includedIndex[id] || reference;
}

function klOrdersEntryResources_(rawOrder, includedIndex) {
  var attributes = rawOrder && rawOrder.attributes ? rawOrder.attributes : (rawOrder || {});
  var direct = rawOrder && Array.isArray(rawOrder.entries) ? rawOrder.entries :
    (Array.isArray(attributes.entries) ? attributes.entries : []);
  if (direct.length) return direct;

  var relationship = rawOrder && rawOrder.relationships && rawOrder.relationships.entries;
  var data = relationship && relationship.data;
  if (!Array.isArray(data)) return [];
  return data.map(function (reference) {
    return klOrdersResolveIncluded_(reference, includedIndex);
  });
}

function klOrdersMerchantProductCode_(resource) {
  var attributes = resource && resource.attributes ? resource.attributes : (resource || {});
  var offer = attributes.offer || resource.offer || {};
  var product = attributes.product || resource.product || {};
  var merchantProduct = product.merchantProduct || attributes.merchantProduct || {};
  return klIoText_(
    offer.code || merchantProduct.code || product.merchantProductCode ||
    attributes.merchantProductCode || resource.merchantProductCode || attributes.code
  );
}

/** Нормализует одну entry в явный контракт, не подменяя SKU. */
function klNormalizeOrderEntry_(rawEntry) {
  var raw = rawEntry || {};
  var attributes = raw.attributes || raw;
  var quantityRaw = attributes.quantity !== undefined ? attributes.quantity : raw.quantity;
  var quantity = Number(quantityRaw);
  return {
    id: klIoText_(raw.id || attributes.id || attributes.entryId),
    product: {
      merchantProduct: {
        code: klOrdersMerchantProductCode_(raw)
      }
    },
    quantity: isFinite(quantity) ? quantity : NaN,
    raw: raw
  };
}

function klOrdersBoolean_(value) {
  if (value === true) return true;
  if (typeof value === 'number') return isFinite(value) && value > 0;
  var text = klIoText_(value).toUpperCase();
  return text !== '' && text !== 'FALSE' && text !== 'NO' && text !== '0' &&
    text !== 'NULL' && text !== 'UNDEFINED';
}

/** Нормализует поля Kaspi, используемые state machine. */
function klNormalizeOrder_(rawOrder, includedIndex) {
  var raw = rawOrder || {};
  var attributes = raw.attributes || raw;
  var kaspiDelivery = attributes.kaspiDelivery &&
    typeof attributes.kaspiDelivery === 'object' ? attributes.kaspiDelivery : {};
  var handoffKnown =
    (Object.prototype.hasOwnProperty.call(attributes, 'courierTransmissionDate') &&
      attributes.courierTransmissionDate !== undefined) ||
    (Object.prototype.hasOwnProperty.call(raw, 'courierTransmissionDate') &&
      raw.courierTransmissionDate !== undefined) ||
    (Object.prototype.hasOwnProperty.call(kaspiDelivery, 'courierTransmissionDate') &&
      kaspiDelivery.courierTransmissionDate !== undefined);
  var entryResources = klOrdersEntryResources_(raw, includedIndex || Object.create(null));
  return {
    id: klIoText_(raw.id || attributes.id || attributes.orderId),
    code: klIoText_(attributes.code || raw.code || attributes.orderCode),
    state: klIoText_(attributes.state || raw.state).toUpperCase(),
    status: klIoText_(attributes.status || raw.status).toUpperCase(),
    creationDate: klIoToMs_(attributes.creationDate || raw.creationDate, 0),
    courierTransmissionDate: klIoToMs_(
      attributes.courierTransmissionDate || raw.courierTransmissionDate ||
      kaspiDelivery.courierTransmissionDate, 0
    ),
    courierTransmissionDateKnown: handoffKnown,
    returnedToWarehouse: klOrdersBoolean_(
      attributes.returnedToWarehouse !== undefined
        ? attributes.returnedToWarehouse : raw.returnedToWarehouse
    ),
    entries: entryResources.map(klNormalizeOrderEntry_),
    raw: raw
  };
}

function klOrdersRelatedEntriesUrl_(rawOrder) {
  var relationship = rawOrder && rawOrder.relationships && rawOrder.relationships.entries;
  var related = relationship && relationship.links && relationship.links.related;
  if (related && typeof related === 'object') related = related.href || related.url;
  return klIoText_(related);
}

function klOrdersHydrateEntries_(order, deadlineMs) {
  var complete = order.entries.length && order.entries.every(function (entry) {
    return entry.id && isFinite(entry.quantity) &&
      Boolean(klOrdersMerchantProductCode_(entry));
  });
  if (complete) return order;
  var relatedUrl = klOrdersRelatedEntriesUrl_(order.raw);
  if (!relatedUrl) return order;
  if (/^\//.test(relatedUrl)) relatedUrl = 'https://kaspi.kz' + relatedUrl;
  var payload = klOrdersFetchJsonWithRetry_(relatedUrl, deadlineMs);
  var resources = Array.isArray(payload) ? payload :
    (Array.isArray(payload.data) ? payload.data :
      (Array.isArray(payload.entries) ? payload.entries : []));
  order.entries = resources.map(klNormalizeOrderEntry_);
  return order;
}

function klOrdersNextLink_(payload) {
  var next = payload && payload.links && payload.links.next;
  if (next && typeof next === 'object') next = next.href || next.url;
  return klIoText_(next);
}

function klOrdersExtractPage_(payload, page, pageSize) {
  var data;
  if (Array.isArray(payload)) data = payload;
  else if (payload && Array.isArray(payload.data)) data = payload.data;
  else if (payload && Array.isArray(payload.orders)) data = payload.orders;
  else if (payload && Array.isArray(payload.items)) data = payload.items;
  else throw new Error('Kaspi API: в ответе нет массива orders/data.');

  if (payload && payload.errors && payload.errors.length) {
    throw new Error('Kaspi API errors: ' + klLedgerSafeJson_(payload.errors).slice(0, 1000));
  }

  var meta = payload && payload.meta ? payload.meta : {};
  var pageCount = Number(
    meta.pageCount || meta.totalPages ||
    (meta.pagination && (meta.pagination.pageCount || meta.pagination.totalPages))
  );
  var nextLink = klOrdersNextLink_(payload);
  var explicitNext = payload && payload.links &&
    Object.prototype.hasOwnProperty.call(payload.links, 'next');
  var hasNext;
  if (nextLink) hasNext = true;
  else if (isFinite(pageCount) && pageCount > 0) hasNext = page + 1 < pageCount;
  else if (explicitNext) hasNext = false;
  else hasNext = data.length >= pageSize;

  return {
    resources: data,
    includedIndex: klOrdersIncludedIndex_(payload && payload.included),
    hasNext: hasNext,
    nextLink: nextLink
  };
}

function klOrdersPageSignature_(resources) {
  if (!resources || !resources.length) return 'EMPTY';
  var first = resources[0] || {};
  var last = resources[resources.length - 1] || {};
  return [resources.length, klIoText_(first.id), klIoText_(last.id)].join('|');
}

function klOrdersPushError_(context, order, entry, stage, error, details) {
  var record = {
    loggedAt: new Date(),
    orderId: order && order.id,
    orderCode: order && order.code,
    entryId: entry && entry.id,
    stage: stage,
    error: klIoText_(error && error.message ? error.message : error),
    details: details || {}
  };
  context.errors.push(record);
  context.summary.errors++;
  var warning = '[KL_ORDERS_RUN] ' + record.stage + ': ' + record.error;
  if (record.stage === 'SKU_MAPPING') {
    var mappingDetails = record.details || {};
    warning += ' ' + JSON.stringify({
        orderCode: record.orderCode || '',
        orderId: record.orderId || '',
        entryId: record.entryId || '',
        merchantProductCode: mappingDetails.merchantProductCode || '',
        mapConflict: Boolean(mappingDetails.mapConflict)
      });
  }
  klIoWarn_(warning);
}

function klOrdersPlanSnapshot_(order, entry, sku, observedAtMs) {
  return {
    orderId: order.id,
    lineId: entry.id,
    entryId: entry.id,
    code: order.code,
    orderCode: order.code,
    sku: sku,
    qty: entry.quantity,
    quantity: entry.quantity,
    state: order.state,
    status: order.status,
    creationMs: order.creationDate,
    creationDate: order.creationDate,
    courierTransmissionMs: order.courierTransmissionDate,
    courierTransmissionDate: order.courierTransmissionDate,
    handoffKnown: order.courierTransmissionDateKnown === true,
    handoff: Boolean(order.courierTransmissionDate),
    returnedToWarehouse: order.returnedToWarehouse,
    eventAt: observedAtMs,
    eventAtMs: observedAtMs,
    source: 'KASPI_API'
  };
}

/** Загружает допустимые SKU из двух подтверждённых источников артикула. */
function klOrdersLoadSkuCatalog_() {
  var ss = klIoGetSpreadsheet_();
  var catalog = {
    bySku: Object.create(null),
    kaspiProductIds: Object.create(null)
  };
  var price = ss.getSheetByName('Прайс KASPI');
  if (price && price.getLastRow() >= 2) {
    var priceRows = price.getLastRow() - 1;
    var priceSkus = price.getRange(2, 1, priceRows, 1).getDisplayValues();
    var priceLinks = price.getRange(2, 18, priceRows, 1).getDisplayValues();
    for (var i = 0; i < priceRows; i++) {
      var sku = klIoNormalizeSku_(priceSkus[i][0]);
      if (sku) catalog.bySku[sku] = true;
      var productId = klOrdersKaspiProductId_(priceLinks[i][0]);
      if (productId) catalog.kaspiProductIds[productId] = true;
    }
  }
  var stock = ss.getSheetByName('СКЛАД_НАЛИЧИЕ');
  if (stock && stock.getLastRow() >= 2) {
    stock.getRange(2, 1, stock.getLastRow() - 1, 1)
      .getDisplayValues().forEach(function (row) {
        var sku = klIoNormalizeSku_(row[0]);
        if (sku) catalog.bySku[sku] = true;
      });
  }
  return catalog;
}

/** Берёт числовой Kaspi product ID в конце URL товара из колонки R. */
function klOrdersKaspiProductId_(value) {
  var url = klIoText_(value).split(/[?#]/)[0].replace(/\/+$/, '');
  var lastSegment = url.slice(url.lastIndexOf('/') + 1);
  var match = lastSegment.match(/-(\d+)$/);
  return match ? match[1] : '';
}

/** Проверяет, есть ли ещё не разрешённый код в прайсе по SKU или URL товара. */
function klOrdersHasPriceMatch_(merchantCode, skuCatalog) {
  var catalog = skuCatalog || {};
  var bySku = catalog.bySku || catalog;
  var exact = klIoNormalizeSku_(merchantCode);
  if (exact && Object.prototype.hasOwnProperty.call(bySku, exact)) return true;
  var masterId = klIoText_(merchantCode).split('_')[0];
  return Boolean(masterId && catalog.kaspiProductIds &&
    Object.prototype.hasOwnProperty.call(catalog.kaspiProductIds, masterId));
}

/** Время события для ledger: дата создания для RESERVE, дата передачи для SHIP. */
function klOrdersEventAt_(event, snapshot, observedAtMs) {
  event = event || {};
  snapshot = snapshot || {};
  var type = klIoText_(event.eventType || event.type).toUpperCase();
  if (type === 'RESERVE') {
    var created = klIoToMs_(snapshot.creationMs || snapshot.creationDate, 0);
    return created || observedAtMs;
  }
  if (type === 'SHIP') {
    var handoff = klIoToMs_(
      snapshot.courierTransmissionMs || snapshot.courierTransmissionDate, 0
    );
    return handoff || observedAtMs;
  }
  return klIoToMs_(
    event.eventAtMs !== undefined ? event.eventAtMs : event.eventAt,
    observedAtMs
  );
}

function klOrdersStageEvents_(context, events, snapshot, observedAtMs) {
  for (var i = 0; i < events.length; i++) {
    var rawEvent = {};
    Object.keys(events[i] || {}).forEach(function (key) {
      rawEvent[key] = events[i][key];
    });
    rawEvent.eventAtMs = klOrdersEventAt_(rawEvent, snapshot, observedAtMs);
    var normalized = klLedgerNormalizePlannedEvent_(rawEvent, snapshot, observedAtMs);
    var existing = context.ledger.byId[normalized.eventId] ||
      context.stagedById[normalized.eventId];
    if (existing) {
      if (!klLedgerSameIdentity_(existing, normalized)) {
        throw new Error('Коллизия staged Event ID: ' + normalized.eventId);
      }
      continue;
    }
    context.stagedById[normalized.eventId] = normalized;
    context.plannedEvents.push(normalized);
    var key = klLedgerLineKey_(normalized.orderId, normalized.lineId);
    if (!context.ledger.byLine[key]) context.ledger.byLine[key] = [];
    context.ledger.byLine[key].push(normalized);
  }
}

/** Разрешает SKU: карта Master ID, затем точный код в подтверждённых каталогах. */
function klOrdersResolveSku_(merchantCode, productMap, skuCatalog) {
  var raw = klIoText_(merchantCode);
  var separator = raw.indexOf('_');
  if (separator > 0 && typeof Utilities !== 'undefined' && Utilities.base64Encode) {
    var masterId = Utilities.base64Encode(raw.slice(0, separator));
    var masterMapped = klResolveSku_(masterId, productMap);
    if (masterMapped) return masterMapped;
  }

  var direct = klResolveSku_(raw, productMap);
  if (direct) return direct;

  var catalog = skuCatalog || Object.create(null);
  var knownSkus = catalog.bySku || catalog;
  var exact = klIoNormalizeSku_(raw);
  return exact && Object.prototype.hasOwnProperty.call(knownSkus, exact) ? exact : '';
}

function klOrdersProcessEntry_(context, order, entry, observedAtMs) {
  context.summary.entries++;
  var merchantCode = klIoText_(
    entry && entry.product && entry.product.merchantProduct &&
    entry.product.merchantProduct.code
  );
  var sku = klOrdersResolveSku_(merchantCode, context.productMap, context.skuCatalog);
  if (sku) context.affectedSkus.push(sku);

  var snapshot = klOrdersPlanSnapshot_(order, entry, sku, observedAtMs);
  var priorEvents = klLedgerPriorEvents_(context.ledger, order.id, entry.id);
  var lineState = klFoldLineState_(priorEvents);
  var plan = klPlanLineSnapshot_(lineState, snapshot, {
    source: 'KASPI_API',
    observedAtMs: observedAtMs,
    dryRun: context.safety.dryRun
  });

  if (plan.errors && plan.errors.length) {
    var missingSku = plan.errors.indexOf('MISSING_SKU') >= 0;
    if (missingSku && merchantCode) {
      context.unmatchedSkuCodes = context.unmatchedSkuCodes || Object.create(null);
      context.unmatchedSkuCodes[merchantCode] = true;
      if (klOrdersHasPriceMatch_(merchantCode, context.skuCatalog)) {
        context.cursorBlockingSkuCodes = context.cursorBlockingSkuCodes || Object.create(null);
        context.cursorBlockingSkuCodes[merchantCode] = true;
      }
    }
    klOrdersPushError_(
      context,
      order,
      entry,
      missingSku ? 'SKU_MAPPING' : 'PLAN_SNAPSHOT',
      new Error(plan.errors.join(', ')),
      {
        merchantProductCode: merchantCode,
        mapConflict: Boolean(context.productMap.conflicts[klProductMapKey_(merchantCode)]),
        plannerDecision: plan.decision
      }
    );
    return;
  }

  klOrdersStageEvents_(context, plan.events || [], snapshot, observedAtMs);
  context.summary.plannedEvents = context.plannedEvents.length;
}

/** Ошибка одного заказа/строки не останавливает остальной batch. */
function klOrdersProcessOrder_(context, rawOrder, includedIndex, observedAtMs, deadlineMs) {
  var order = null;
  try {
    order = klNormalizeOrder_(rawOrder, includedIndex);
    order = klOrdersHydrateEntries_(order, deadlineMs);
    if (!order.id) throw new Error('У заказа нет id.');
    if (!order.entries.length) throw new Error('У заказа нет entries.');
    context.summary.orders++;

    for (var i = 0; i < order.entries.length; i++) {
      try {
        klOrdersProcessEntry_(context, order, order.entries[i], observedAtMs);
      } catch (entryError) {
        klOrdersPushError_(
          context, order, order.entries[i], 'ENTRY_PROCESS', entryError, {}
        );
      }
    }
  } catch (orderError) {
    klOrdersPushError_(
      context,
      order || {id: klIoText_(rawOrder && rawOrder.id), code: ''},
      null,
      'ORDER_PROCESS',
      orderError,
      {}
    );
  }
}

function klOrdersFlushErrors_(context) {
  if (!context.errors.length) return 0;
  if (context.safety && context.safety.dryRun) {
    // DRY_RUN не пишет даже диагностические листы; ошибки остаются в summary/log.
    return 0;
  }
  try {
    var count = klLedgerAppendErrors_(context.errors);
    context.errors = [];
    return count;
  } catch (error) {
    klIoWarn_('[KL_ORDERS_RUN] Не удалось записать error log: ' + error.message);
    return 0;
  }
}

/** Внутренний runner вызывается уже под ScriptLock. */
function klOrdersRunLocked_() {
  var startedAt = Date.now();
  var hardDeadline = startedAt + KL_ORDERS_RUNTIME_MS_;
  var processingDeadline = hardDeadline - KL_ORDERS_COMMIT_RESERVE_MS_;
  var props = PropertiesService.getScriptProperties();
  var safety = klOrdersSafetyMode_(props);
  var windowState = klOrdersReadWindow_(props, startedAt, safety.production);
  klOrdersSaveInitialWindow_(props, windowState, safety.production);
  var states = klOrdersStates_();

  var summary = {
    dryRun: safety.dryRun,
    production: safety.production,
    cutoverReady: safety.cutoverFlag === 'YES',
    windowFromMs: windowState.fromMs,
    windowToMs: windowState.toMs,
    startStateIndex: windowState.stateIndex,
    nextStateIndex: windowState.stateIndex,
    currentState: states[windowState.stateIndex] || '',
    startPage: windowState.page,
    nextPage: windowState.page,
    pages: 0,
    orders: 0,
    entries: 0,
    plannedEvents: 0,
    appendedEvents: 0,
    deduplicatedEvents: 0,
    affectedSkus: 0,
    errors: 0,
    windowComplete: false,
    cursorAdvanced: false,
    progressSaved: false,
    elapsedMs: 0
  };

  var context = {
    safety: safety,
    summary: summary,
    ledger: klLedgerReadIndex_(),
    productMap: klLoadProductMap_(),
    skuCatalog: klOrdersLoadSkuCatalog_(),
    unmatchedSkuCodes: Object.create(null),
    cursorBlockingSkuCodes: Object.create(null),
    stagedById: Object.create(null),
    plannedEvents: [],
    affectedSkus: [],
    errors: []
  };

  var stateIndex = Math.min(windowState.stateIndex || 0, states.length);
  var page = windowState.page;
  var pageSignature = '';
  var fatalError = null;
  var windowComplete = stateIndex >= states.length;

  try {
    while (stateIndex < states.length &&
           summary.pages < KL_ORDERS_MAX_PAGES_ &&
           Date.now() < processingDeadline) {
      var currentState = states[stateIndex];
      summary.currentState = currentState;
      var payload = klOrdersFetchPage_(
        currentState,
        windowState.fromMs,
        windowState.toMs,
        page,
        KL_ORDERS_PAGE_SIZE_,
        processingDeadline
      );
      var pageData = klOrdersExtractPage_(payload, page, KL_ORDERS_PAGE_SIZE_);
      var signature = klOrdersPageSignature_(pageData.resources);
      if (page > 0 && pageSignature && signature !== 'EMPTY' &&
          signature === pageSignature) {
        throw new Error(
          'Kaspi вернул ту же страницу повторно; pagination остановлена.'
        );
      }
      pageSignature = signature;

      var pageComplete = true;
      for (var i = 0; i < pageData.resources.length; i++) {
        if (Date.now() >= processingDeadline) {
          pageComplete = false;
          break;
        }
        klOrdersProcessOrder_(
          context,
          pageData.resources[i],
          pageData.includedIndex,
          Date.now(),
          processingDeadline
        );
      }

      if (!pageComplete) break; // В свойствах остаётся та же page для idempotent resume.
      summary.pages++;
      page++;
      if (!pageData.hasNext) {
        stateIndex++;
        page = 0;
        pageSignature = '';
      }
      summary.nextStateIndex = stateIndex;
      summary.nextPage = page;
      if (stateIndex >= states.length) windowComplete = true;
    }
    if (summary.pages >= KL_ORDERS_MAX_PAGES_ && !windowComplete) {
      throw new Error('Достигнут safety limit pagination: ' + KL_ORDERS_MAX_PAGES_);
    }
  } catch (error) {
    fatalError = error;
    klOrdersPushError_(context, null, null, 'RUN_FETCH', error, {
      state: states[stateIndex] || '',
      stateIndex: stateIndex,
      page: page
    });
  }

  var appendResult = null;
  var commitError = null;
  try {
    appendResult = klLedgerAppendBatch_(context.plannedEvents, safety.dryRun);
    summary.appendedEvents = appendResult.appended;
    summary.deduplicatedEvents = appendResult.skipped;

    var affected = klLedgerUniqueSkus_(context.affectedSkus.concat(
      context.plannedEvents.map(function (event) { return event.sku; })
    ));
    summary.affectedSkus = affected.length;
    // Остаток ведётся только в СКЛАД_НАЛИЧИЕ + ledger.
    if (typeof klSyncReturnTasks_ === 'function') {
      summary.returnTasks = klSyncReturnTasks_(safety.dryRun);
    }
  } catch (error) {
    commitError = error;
    klOrdersPushError_(context, null, null, 'LEDGER_COMMIT', error, {});
  }

  summary.unmatchedSkuCodes = Object.keys(context.unmatchedSkuCodes).sort();
  summary.unmatchedSkuCount = summary.unmatchedSkuCodes.length;
  summary.cursorBlockingSkuCodes = Object.keys(context.cursorBlockingSkuCodes).sort();
  summary.cursorBlockingSkuCount = summary.cursorBlockingSkuCodes.length;
  // Отсутствие строки на складе безопасно (это предзаказ), но неизвестный код
  // без товара в прайсе не блокирует курсор; найденный в прайсе product ID
  // требует исправления карты до продвижения.
  var canAdvance = safety.production && !commitError &&
    summary.cursorBlockingSkuCount === 0;
  if (canAdvance) {
    klOrdersSaveProgress_(
      props, windowState, stateIndex, page, windowComplete, true
    );
  }
  summary.windowComplete = windowComplete;
  summary.progressSaved = canAdvance;
  summary.cursorAdvanced = Boolean(windowComplete && canAdvance);
  summary.nextStateIndex = windowComplete && canAdvance ? 0 : stateIndex;
  summary.nextPage = windowComplete && canAdvance ? 0 : page;
  summary.elapsedMs = Date.now() - startedAt;
  summary.cursorBlockedByUnmatchedSku = Boolean(
    safety.production && summary.cursorBlockingSkuCount > 0
  );
  if (fatalError) summary.fatalError = klIoText_(fatalError.message);
  if (commitError) summary.commitError = klIoText_(commitError.message);

  klOrdersFlushErrors_(context);
  if (!safety.dryRun && typeof klNotifyFailure_ === 'function' && summary.errors > 0) {
    klNotifyFailure_(
      new Error('Ошибок в цикле: ' + summary.errors),
      'KL_ORDERS_RUN'
    );
  } else if (!safety.dryRun && typeof klNotifySuccess_ === 'function') {
    klNotifySuccess_('KL_ORDERS_RUN завершён без ошибок.');
  }
  klIoLog_('[KL_ORDERS_RUN] ' + JSON.stringify(summary));
  return summary;
}

/**
 * Единственная trigger-entrypoint нового ingestion. Legacy entrypoints не трогаем.
 */
function KL_ORDERS_RUN() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    var locked = {skipped: true, reason: 'SCRIPT_LOCK_BUSY', dryRun: true};
    klIoLog_('[KL_ORDERS_RUN] ' + JSON.stringify(locked));
    return locked;
  }
  try {
    return klOrdersRunLocked_();
  } finally {
    lock.releaseLock();
  }
}
