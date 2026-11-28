/**
 * Материализованная проекция остатков Kaspi.
 *
 * Источник истины после cutover — append-only события V2 в
 * `_KASPI_ORDER_EVENTS`. Колонки A:G `_KASPI_STOCK_STATE` сохранены для
 * совместимости; физический остаток хранится отдельно в H.
 */

var KL_STOCK = Object.freeze({
  SPREADSHEET_ID: '1dLU5KOi3WBLy3uNEiqGv5rf9ka0OwcEw_RjhDQW3H1E',
  TZ: 'Asia/Almaty',
  EVENTS_SHEET: '_KASPI_ORDER_EVENTS',
  STOCK_SHEET: '_KASPI_STOCK_STATE',
  PRICE_SHEET: 'Прайс KASPI',
  QUEUE_SHEET: '_KASPI_PRICE_QUEUE',
  ERROR_SHEET: '_ORDER_SYNC_ERRORS',
  DRY_RUN_PROPERTY: 'KL_DRY_RUN',
  CUTOVER_PROPERTY: 'KL_CUTOVER_READY',
  CAPTURE_PROPERTY: 'KL_ALLOW_OPENING_CAPTURE',
  STOCK_HEADERS: Object.freeze([
    'SKU', 'Baseline stock', 'Current stock', 'Baseline ms', 'Updated at',
    'Source', 'Legacy current stock', 'Opening physical', 'Active reserve',
    'Available', 'Base preOrder', 'Projection hash', 'Projected at',
    'Needs review'
  ]),
  QUEUE_HEADERS: Object.freeze([
    'SKU', 'Available', 'preOrder', 'Queued at', 'Status', 'Source'
  ])
});

function klStockSs_() {
  if (typeof getSS_ === 'function') return getSS_();
  return SpreadsheetApp.openById(KL_STOCK.SPREADSHEET_ID);
}

function klStockText_(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function klStockNum_(value, fallback) {
  var number = Number(value);
  return isFinite(number) ? number : (fallback === undefined ? 0 : fallback);
}

function klStockSku_(value) {
  var sku = klStockText_(value);
  if (!sku) return '';
  if (typeof normalizeSku_ === 'function') return klStockText_(normalizeSku_(sku));
  return sku.toUpperCase();
}

function klIsDryRun_() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(KL_STOCK.DRY_RUN_PROPERTY);
  var cutover = props.getProperty(KL_STOCK.CUTOVER_PROPERTY);
  // Два независимых предохранителя: случайное FALSE ещё не включает запись.
  return raw === null || String(raw).toUpperCase() !== 'FALSE' ||
    String(cutover).toUpperCase() !== 'YES';
}

function klEnsureStockSheet_() {
  var ss = klStockSs_();
  var sheet = ss.getSheetByName(KL_STOCK.STOCK_SHEET);
  if (!sheet) sheet = ss.insertSheet(KL_STOCK.STOCK_SHEET);
  if (sheet.getMaxColumns() < KL_STOCK.STOCK_HEADERS.length) {
    sheet.insertColumnsAfter(
      sheet.getMaxColumns(),
      KL_STOCK.STOCK_HEADERS.length - sheet.getMaxColumns()
    );
  }
  var current = sheet.getRange(1, 1, 1, KL_STOCK.STOCK_HEADERS.length)
    .getDisplayValues()[0];
  var next = current.slice();
  for (var i = 0; i < KL_STOCK.STOCK_HEADERS.length; i++) {
    // A:G — живые legacy-заголовки, их не переименовываем.
    if (i >= 7 && !klStockText_(next[i])) next[i] = KL_STOCK.STOCK_HEADERS[i];
    if (i < 7 && !klStockText_(next[i])) next[i] = KL_STOCK.STOCK_HEADERS[i];
  }
  sheet.getRange(1, 1, 1, next.length).setValues([next]);
  sheet.setFrozenRows(1);
  sheet.getRange('A:A').setNumberFormat('@');
  return sheet;
}

function klEnsurePriceQueue_() {
  var ss = klStockSs_();
  var sheet = ss.getSheetByName(KL_STOCK.QUEUE_SHEET);
  if (!sheet) sheet = ss.insertSheet(KL_STOCK.QUEUE_SHEET);
  if (sheet.getMaxColumns() < KL_STOCK.QUEUE_HEADERS.length) {
    sheet.insertColumnsAfter(
      sheet.getMaxColumns(),
      KL_STOCK.QUEUE_HEADERS.length - sheet.getMaxColumns()
    );
  }
  var row = sheet.getRange(1, 1, 1, KL_STOCK.QUEUE_HEADERS.length)
    .getDisplayValues()[0];
  var next = row.slice();
  for (var i = 0; i < next.length; i++) {
    if (!klStockText_(next[i])) next[i] = KL_STOCK.QUEUE_HEADERS[i];
  }
  sheet.getRange(1, 1, 1, next.length).setValues([next]);
  sheet.setFrozenRows(1);
  return sheet;
}

/**
 * Читает только канонические V2-события K:R. Legacy A:J уже учтены в
 * opening physical и повторно не проигрываются.
 */
function klLoadCanonicalStockEvents_() {
  var sheet = klStockSs_().getSheetByName(KL_STOCK.EVENTS_SHEET);
  var bySku = Object.create(null);
  if (!sheet || sheet.getLastRow() < 2 || sheet.getLastColumn() < 18) return bySku;
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 18).getValues();
  for (var i = 0; i < rows.length; i++) {
    var eventId = klStockText_(rows[i][10]);
    var type = klStockText_(rows[i][11]).toUpperCase();
    var sku = klStockSku_(rows[i][6]);
    var qty = Math.max(0, Math.floor(klStockNum_(rows[i][7], 0)));
    if (!eventId || !type || !sku || !qty) continue;
    if (!bySku[sku]) bySku[sku] = [];
    bySku[sku].push({
      eventId: eventId,
      eventType: type,
      qty: qty,
      orderId: klStockText_(rows[i][1]),
      lineId: klStockText_(rows[i][5])
    });
  }
  return bySku;
}

/** Чистая функция расчёта одной позиции. */
function klProjectSku_(openingPhysical, events) {
  var opening = Math.max(0, Math.floor(klStockNum_(openingPhysical, 0)));
  var physical = opening;
  var reserve = 0;
  var seen = Object.create(null);
  var errors = [];
  var ordered = (events || []).slice();
  for (var i = 0; i < ordered.length; i++) {
    var event = ordered[i] || {};
    var id = klStockText_(event.eventId);
    if (id && seen[id]) continue;
    if (id) seen[id] = true;
    var qty = Math.max(0, Math.floor(klStockNum_(event.qty, 0)));
    var type = klStockText_(event.eventType).toUpperCase();
    if (!qty) continue;
    if (type === 'RESERVE' || type === 'OPENING_RESERVE') reserve += qty;
    if (type === 'RELEASE') reserve -= qty;
    if (type === 'SHIP') {
      reserve -= qty;
      physical -= qty;
    }
    if (type === 'RETURN_RESTOCK') physical += qty;
    if (reserve < 0) {
      errors.push('Активный резерв стал отрицательным после ' + type);
      reserve = 0;
    }
  }
  var raw = physical - reserve;
  if (physical < 0) errors.push('Физический остаток меньше нуля: ' + physical);
  if (raw < 0) errors.push('Доступный остаток меньше нуля: ' + raw);
  return {
    openingPhysical: opening,
    physical: Math.max(0, physical),
    activeReserve: Math.max(0, reserve),
    availableRaw: raw,
    available: Math.max(0, raw),
    errors: errors
  };
}

function klPreOrderFor_(available, basePreOrder) {
  var days = Math.max(0, Math.min(30, Math.floor(klStockNum_(basePreOrder, 0))));
  return Number(available) > 0 ? 0 : days;
}

function klProjectionHash_(projection, basePreOrder) {
  return [
    projection.openingPhysical,
    projection.physical,
    projection.activeReserve,
    projection.available,
    klPreOrderFor_(projection.available, basePreOrder)
  ].join('|');
}

function klLoadStockRows_() {
  var sheet = klEnsureStockSheet_();
  var result = {sheet: sheet, rows: [], bySku: Object.create(null)};
  if (sheet.getLastRow() < 2) return result;
  var values = sheet.getRange(
    2, 1, sheet.getLastRow() - 1, KL_STOCK.STOCK_HEADERS.length
  ).getValues();
  for (var i = 0; i < values.length; i++) {
    var sku = klStockSku_(values[i][0]);
    if (!sku) continue;
    result.bySku[sku] = {rowNumber: i + 2, values: values[i]};
    result.rows.push(result.bySku[sku]);
  }
  return result;
}

/**
 * Абсолютно (не `+/-`) восстанавливает проекцию затронутых SKU из ledger.
 * Это делает повтор после падения безопасным.
 */
function klMaterializeAffectedSkus_(skus, dryRunOrContext) {
  var dryRun = typeof dryRunOrContext === 'boolean'
    ? dryRunOrContext
    : (dryRunOrContext && typeof dryRunOrContext.dryRun === 'boolean'
      ? dryRunOrContext.dryRun : klIsDryRun_());
  var wanted = Object.create(null);
  (skus || []).forEach(function (sku) {
    var normalized = klStockSku_(sku);
    if (normalized) wanted[normalized] = true;
  });
  var stock = klLoadStockRows_();
  var eventsBySku = klLoadCanonicalStockEvents_();
  var now = new Date();
  var result = [];
  var writes = [];
  Object.keys(wanted).forEach(function (sku) {
    var record = stock.bySku[sku];
    if (!record) {
      result.push({sku: sku, ok: false, error: 'SKU отсутствует в _KASPI_STOCK_STATE'});
      return;
    }
    var row = record.values.slice();
    var openingRaw = row[7];
    if (openingRaw === '' || openingRaw === null || openingRaw === undefined) {
      row[13] = 'NO_OPENING_PHYSICAL';
      result.push({sku: sku, ok: false, error: 'Не зафиксирован Opening physical'});
      if (!dryRun) writes.push({rowNumber: record.rowNumber, values: row});
      return;
    }
    var projection = klProjectSku_(openingRaw, eventsBySku[sku] || []);
    var basePreOrder = Math.max(0, Math.floor(klStockNum_(row[10], 0)));
    var preOrder = klPreOrderFor_(projection.available, basePreOrder);
    var previousHash = klStockText_(row[11]);
    var projectionHash = klProjectionHash_(projection, basePreOrder);
    row[2] = projection.available; // legacy Current stock = доступно к продаже
    row[4] = now;
    row[5] = 'KASPI_LEDGER_V2';
    row[8] = projection.activeReserve;
    row[9] = projection.available;
    row[11] = projectionHash;
    row[12] = now;
    row[13] = projection.errors.join('; ');
    result.push({
      sku: sku,
      ok: projection.errors.length === 0,
      physical: projection.physical,
      activeReserve: projection.activeReserve,
      available: projection.available,
      preOrder: preOrder,
      changed: previousHash !== projectionHash,
      errors: projection.errors
    });
    if (!dryRun) writes.push({rowNumber: record.rowNumber, values: row});
  });

  if (!dryRun && writes.length) {
    // Строки могут быть несмежными: пишем только подготовленные абсолютные цели.
    for (var i = 0; i < writes.length; i++) {
      stock.sheet.getRange(
        writes[i].rowNumber, 1, 1, KL_STOCK.STOCK_HEADERS.length
      ).setValues([writes[i].values]);
    }
    SpreadsheetApp.flush();
    klQueuePriceUpdates_(result.filter(function (item) {
      return item.ok && item.changed;
    }), false);
  }
  return result;
}

function klQueuePriceUpdates_(items, dryRun) {
  if (dryRun || !items || !items.length) return items || [];
  var sheet = klEnsurePriceQueue_();
  var now = new Date();
  var rows = items.map(function (item) {
    return [item.sku, item.available, item.preOrder, now, 'PENDING', 'KASPI_LEDGER_V2'];
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length)
    .setValues(rows);
  return items;
}

/**
 * Индекс для минимального патча существующего buildXml_. available всегда yes.
 */
function klBuildXmlAvailabilityIndex_() {
  var stock = klLoadStockRows_();
  var index = Object.create(null);
  Object.keys(stock.bySku).forEach(function (sku) {
    var row = stock.bySku[sku].values;
    var available = Math.max(0, Math.floor(klStockNum_(row[9], row[2])));
    var basePreOrder = Math.max(0, Math.floor(klStockNum_(row[10], 0)));
    index[sku] = {
      available: 'yes',
      quantity: available,
      preOrder: String(klPreOrderFor_(available, basePreOrder))
    };
  });
  return index;
}

function KL_GET_XML_AVAILABILITY(sku, fallbackStock, fallbackPreOrder, index) {
  var normalized = klStockSku_(sku);
  var found = index && index[normalized];
  if (found) return found;
  var qty = Math.max(0, Math.floor(klStockNum_(fallbackStock, 0)));
  return {
    available: 'yes',
    quantity: qty,
    preOrder: String(klPreOrderFor_(qty, fallbackPreOrder))
  };
}

/**
 * Одноразовый захват opening balance. Преднамеренно заблокирован свойством,
 * потому что `мой склад` сейчас не содержит проверенной колонки количества.
 */
function KL_CAPTURE_OPENING_FROM_PRICE_KASPI() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(KL_STOCK.CAPTURE_PROPERTY) !== 'YES') {
    throw new Error(
      'Захват запрещён. После проверки источника задайте KL_ALLOW_OPENING_CAPTURE=YES.'
    );
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Другой цикл Kaspi уже выполняется.');
  try {
    var ss = klStockSs_();
    var price = ss.getSheetByName(KL_STOCK.PRICE_SHEET);
    if (!price || price.getLastRow() < 2 || price.getLastColumn() < 17) {
      throw new Error('Лист Прайс KASPI или проверенные колонки A/P/Q недоступны.');
    }
    var headers = price.getRange(1, 1, 1, 17).getDisplayValues()[0];
    if (klStockText_(headers[15]) !== 'Количество' ||
        klStockText_(headers[16]) !== 'Дни доставки') {
      throw new Error('Заголовки P/Q изменились; захват остановлен без записи.');
    }
    var source = price.getRange(2, 1, price.getLastRow() - 1, 17).getValues();
    var captured = Object.create(null);
    for (var i = 0; i < source.length; i++) {
      var sku = klStockSku_(source[i][0]);
      if (!sku) continue;
      var physical = Math.max(0, Math.floor(klStockNum_(source[i][15], 0)));
      var basePreOrder = Math.max(0, Math.floor(klStockNum_(source[i][16], 0)));
      captured[sku] = {physical: physical, basePreOrder: basePreOrder};
    }
    var stock = klLoadStockRows_();
    var now = new Date();
    var rowsToAppend = [];
    Object.keys(captured).forEach(function (sku) {
      var record = stock.bySku[sku];
      if (record) {
        var row = record.values.slice();
        if (row[7] !== '' && row[7] !== null) return; // opening неизменяемый
        row[7] = captured[sku].physical;
        row[10] = captured[sku].basePreOrder;
        row[12] = now;
        row[13] = 'OPENING_CAPTURED_NOT_CUTOVER';
        stock.sheet.getRange(record.rowNumber, 1, 1, row.length).setValues([row]);
      } else {
        var newRow = new Array(KL_STOCK.STOCK_HEADERS.length).fill('');
        newRow[0] = sku;
        newRow[1] = captured[sku].physical;
        newRow[2] = captured[sku].physical;
        newRow[3] = now.getTime();
        newRow[4] = now;
        newRow[5] = 'PRICE_KASPI_CAPTURE';
        newRow[7] = captured[sku].physical;
        newRow[10] = captured[sku].basePreOrder;
        newRow[12] = now;
        newRow[13] = 'OPENING_CAPTURED_NOT_CUTOVER';
        rowsToAppend.push(newRow);
      }
    });
    if (rowsToAppend.length) {
      stock.sheet.getRange(
        stock.sheet.getLastRow() + 1, 1, rowsToAppend.length,
        KL_STOCK.STOCK_HEADERS.length
      ).setValues(rowsToAppend);
    }
    props.deleteProperty(KL_STOCK.CAPTURE_PROPERTY);
    SpreadsheetApp.flush();
    return {captured: Object.keys(captured).length, appended: rowsToAppend.length};
  } finally {
    lock.releaseLock();
  }
}
