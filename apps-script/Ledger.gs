/**
 * Append-only ledger событий Kaspi.
 *
 * A:J — неизменяемый legacy-контракт. Каноническое событие
 * хранится в K:R. Этот файл никогда не переписывает строки событий:
 * все новые факты добавляются только в конец листа.
 */

var KL_LEDGER_SHEET_ = '_KASPI_ORDER_EVENTS';
var KL_ERROR_SHEET_ = '_ORDER_SYNC_ERRORS';
var KL_PRODUCT_MAP_SHEET_ = '_KASPI_PRODUCT_MAP';
var KL_DRY_RUN_PROPERTY_ = 'KL_DRY_RUN';
var KL_CUTOVER_READY_PROPERTY_ = 'KL_CUTOVER_READY';
var KL_EVENT_SCHEMA_VERSION_ = 1;

var KL_LEDGER_HEADERS_ = Object.freeze([
  'Event key',
  'Order ID',
  'Order code',
  'Creation ms',
  'Status',
  'Entry ID',
  'SKU',
  'Qty',
  'Action',
  'Updated at',
  'Event ID',
  'Event type',
  'Cumulative qty',
  'Event at ms',
  'Processed at ms',
  'Source',
  'Schema version',
  'Details'
]);

var KL_ERROR_HEADERS_ = Object.freeze([
  'Дата/время',
  'Источник',
  'Этап',
  'Код/статус',
  'Артикул/заказ',
  'Ошибка',
  'Детали'
]);

var KL_PRODUCT_MAP_HEADERS_ = Object.freeze([
  'Master product ID',
  'Merchant SKU',
  'Name',
  'Updated at'
]);

/** Приводит значение к строке без скрытых GAS-вызовов. */
function klIoText_(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function klIoNumber_(value, fallback) {
  var number = Number(value);
  return isFinite(number) ? number : (fallback === undefined ? 0 : fallback);
}

function klIoToMs_(value, fallback) {
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? (fallback || 0) : value.getTime();
  }
  if (typeof value === 'number' && isFinite(value)) {
    // API Kaspi обычно отдаёт ms; секунды нормализуем явно.
    return value > 0 && value < 100000000000 ? Math.round(value * 1000) : Math.round(value);
  }
  var text = klIoText_(value);
  if (!text) return fallback || 0;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return klIoToMs_(Number(text), fallback);
  var parsed = Date.parse(text);
  return isNaN(parsed) ? (fallback || 0) : parsed;
}

function klIoNormalizeSku_(value) {
  var sku = klIoText_(value);
  if (!sku) return '';
  if (typeof normalizeSku_ === 'function') {
    try {
      return klIoText_(normalizeSku_(sku));
    } catch (error) {
      // Нештатный legacy-normalizer не должен ломать ledger.
    }
  }
  return sku.toUpperCase();
}

function klIoLog_(message) {
  if (typeof console !== 'undefined' && console.log) {
    console.log(message);
    return;
  }
  if (typeof Logger !== 'undefined') Logger.log(message);
}

function klIoWarn_(message) {
  if (typeof console !== 'undefined' && console.warn) {
    console.warn(message);
    return;
  }
  klIoLog_(message);
}

/** Получает таблицу из уже существующего проектного контракта. */
function klIoGetSpreadsheet_() {
  if (typeof getSS_ === 'function') {
    var existing = getSS_();
    if (existing) return existing;
  }

  var id = '';
  if (typeof GB !== 'undefined' && GB) {
    id = klIoText_(
      GB.SPREADSHEET_ID || GB.SS_ID || GB.SHEET_ID || GB.spreadsheetId || GB.ssId
    );
  }
  if (!id && typeof KL_STOCK !== 'undefined' && KL_STOCK) {
    id = klIoText_(KL_STOCK.SPREADSHEET_ID);
  }
  if (id) return SpreadsheetApp.openById(id);

  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw new Error('Не удалось определить Google Spreadsheet.');
  return active;
}

function klIoGetSheet_(name) {
  return klIoGetSpreadsheet_().getSheetByName(name);
}

/**
 * Расширяет строку заголовков, но не меняет ни одну непустую ячейку.
 * Это особенно важно для legacy A:J.
 */
function klIoEnsureSheetHeaders_(name, headers) {
  var ss = klIoGetSpreadsheet_();
  var sheet = ss.getSheetByName(name);
  var created = false;
  if (!sheet) {
    sheet = ss.insertSheet(name);
    created = true;
  }
  if (sheet.getMaxColumns() < headers.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
  }

  var current = sheet.getRange(1, 1, 1, headers.length).getDisplayValues()[0];
  var warnings = [];
  for (var i = 0; i < headers.length; i++) {
    var actual = klIoText_(current[i]);
    if (!actual) {
      sheet.getRange(1, i + 1).setValue(headers[i]);
    } else if (actual !== headers[i]) {
      warnings.push(
        name + '!' + String.fromCharCode(65 + i) + '1: "' + actual +
        '" (expected "' + headers[i] + '")'
      );
    }
  }
  sheet.setFrozenRows(1);
  for (var w = 0; w < warnings.length; w++) klIoWarn_(warnings[w]);
  return {sheet: sheet, created: created, warnings: warnings};
}

function klLedgerEnsureSheet_() {
  return klIoEnsureSheetHeaders_(KL_LEDGER_SHEET_, KL_LEDGER_HEADERS_).sheet;
}

function klLedgerEnsureErrorSheet_() {
  return klIoEnsureSheetHeaders_(KL_ERROR_SHEET_, KL_ERROR_HEADERS_).sheet;
}

function klLedgerEnsureProductMapSheet_() {
  return klIoEnsureSheetHeaders_(KL_PRODUCT_MAP_SHEET_, KL_PRODUCT_MAP_HEADERS_).sheet;
}

/** K:R должны быть точными; при конфликте безопаснее остановить запись. */
function klLedgerValidateCanonicalHeaders_(sheet) {
  var headers = sheet.getRange(1, 1, 1, KL_LEDGER_HEADERS_.length)
    .getDisplayValues()[0];
  var conflicts = [];
  for (var i = 10; i < KL_LEDGER_HEADERS_.length; i++) {
    if (klIoText_(headers[i]) !== KL_LEDGER_HEADERS_[i]) {
      conflicts.push(String.fromCharCode(65 + i) + '1');
    }
  }
  if (conflicts.length) {
    throw new Error(
      'Канонические заголовки K:R конфликтуют: ' + conflicts.join(', ')
    );
  }
}

function klLedgerLegacyActionForEvent_(eventType) {
  var type = klIoText_(eventType).toUpperCase();
  if (type === 'RESERVE' || type === 'SHIP') return 'DEDUCTED';
  if (type === 'RELEASE' || type === 'RETURN_RESTOCK') return 'RESTORED';
  return type;
}

function klLedgerEventTypeFromLegacy_(action) {
  var normalized = klIoText_(action).toUpperCase();
  if (normalized === 'DEDUCTED' || normalized === 'RESERVED') return 'RESERVE';
  if (normalized === 'RESTORED' || normalized === 'RELEASED') return 'RELEASE';
  if (normalized === 'SHIPPED') return 'SHIP';
  if (normalized === 'RETURN_RESTOCKED' || normalized === 'RETURNED_TO_STOCK') {
    return 'RETURN_RESTOCK';
  }
  return normalized;
}

function klLedgerLineKey_(orderId, lineId) {
  return klIoText_(orderId) + '\u001f' + klIoText_(lineId);
}

function klLedgerParseDetails_(value) {
  if (value && typeof value === 'object' && !(value instanceof Date)) return value;
  var text = klIoText_(value);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    return {legacy: text};
  }
}

function klLedgerReadRow_(row, rowNumber) {
  var canonicalId = klIoText_(row[10]);
  var legacyId = klIoText_(row[0]);
  var eventType = klIoText_(row[11]).toUpperCase() ||
    klLedgerEventTypeFromLegacy_(row[8]);
  if (!eventType) return null;

  var eventAt = klIoToMs_(row[13], klIoToMs_(row[3], klIoToMs_(row[9], 0)));
  var cumulativeCell = row[12];
  var cumulative = cumulativeCell === '' || cumulativeCell === null ||
    cumulativeCell === undefined ? null : Math.max(0, klIoNumber_(cumulativeCell, 0));
  return {
    eventId: canonicalId || legacyId || ('LEGACY_ROW_' + rowNumber),
    eventType: eventType,
    qty: Math.max(0, klIoNumber_(row[7], 0)),
    cumulativeAfter: cumulative,
    orderId: klIoText_(row[1]),
    lineId: klIoText_(row[5]),
    entryId: klIoText_(row[5]),
    code: klIoText_(row[2]),
    orderCode: klIoText_(row[2]),
    creationMs: klIoToMs_(row[3], 0),
    status: klIoText_(row[4]).toUpperCase(),
    sku: klIoNormalizeSku_(row[6]),
    eventAt: eventAt,
    eventAtMs: eventAt,
    processedAtMs: klIoToMs_(row[14], klIoToMs_(row[9], 0)),
    source: klIoText_(row[15]) || 'LEGACY',
    schemaVersion: canonicalId ? klIoNumber_(row[16], KL_EVENT_SCHEMA_VERSION_) : 0,
    details: klLedgerParseDetails_(row[17]),
    rowNumber: rowNumber,
    canonical: Boolean(canonicalId)
  };
}

/** Одно чтение ledger даёт индекс для planner и дедупликации. */
function klLedgerReadIndex_() {
  var sheet = klIoGetSheet_(KL_LEDGER_SHEET_);
  var index = {
    sheet: sheet,
    events: [],
    byId: Object.create(null),
    byLine: Object.create(null)
  };
  if (!sheet || sheet.getLastRow() < 2) return index;

  var width = Math.min(KL_LEDGER_HEADERS_.length, Math.max(1, sheet.getLastColumn()));
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues();
  for (var i = 0; i < rows.length; i++) {
    while (rows[i].length < KL_LEDGER_HEADERS_.length) rows[i].push('');
    var event = klLedgerReadRow_(rows[i], i + 2);
    if (!event) continue;
    index.events.push(event);
    if (!index.byId[event.eventId]) index.byId[event.eventId] = event;
    var key = klLedgerLineKey_(event.orderId, event.lineId);
    if (!index.byLine[key]) index.byLine[key] = [];
    index.byLine[key].push(event);
  }
  return index;
}

function klLedgerPriorEvents_(index, orderId, lineId) {
  var events = index.byLine[klLedgerLineKey_(orderId, lineId)] || [];
  return events.slice();
}

function klLedgerMakeEventId_(event) {
  return [
    klIoText_(event.orderId),
    klIoText_(event.lineId || event.entryId),
    klIoText_(event.eventType).toUpperCase(),
    String(Math.max(0, klIoNumber_(event.cumulativeAfter, event.qty)))
  ].join('|');
}

/** Приводит ответ pure planner к контракту ledger. */
function klLedgerNormalizePlannedEvent_(rawEvent, snapshot, processedAtMs) {
  var raw = rawEvent || {};
  var snap = snapshot || {};
  var type = klIoText_(raw.eventType || raw.type).toUpperCase();
  if (!type) throw new Error('Planner вернул событие без eventType.');

  var event = {
    eventId: klIoText_(raw.eventId || raw.id),
    eventType: type,
    qty: Math.max(0, klIoNumber_(raw.qty, 0)),
    cumulativeAfter: Math.max(0, klIoNumber_(
      raw.cumulativeAfter !== undefined ? raw.cumulativeAfter : raw.cumulativeQty,
      raw.qty
    )),
    orderId: klIoText_(raw.orderId || snap.orderId),
    lineId: klIoText_(raw.lineId || raw.entryId || snap.lineId || snap.entryId),
    code: klIoText_(raw.code || raw.orderCode || snap.code || snap.orderCode),
    creationMs: klIoToMs_(raw.creationMs, klIoToMs_(snap.creationMs, 0)),
    status: klIoText_(raw.status || snap.status).toUpperCase(),
    state: klIoText_(raw.state || snap.state).toUpperCase(),
    sku: klIoNormalizeSku_(raw.sku || snap.sku),
    eventAtMs: klIoToMs_(
      raw.eventAtMs !== undefined ? raw.eventAtMs : raw.eventAt,
      klIoToMs_(snap.eventAtMs !== undefined ? snap.eventAtMs : snap.eventAt, processedAtMs)
    ),
    processedAtMs: klIoToMs_(processedAtMs, Date.now()),
    source: klIoText_(raw.source || snap.source) || 'KASPI_API',
    schemaVersion: KL_EVENT_SCHEMA_VERSION_,
    details: raw.details && typeof raw.details === 'object'
      ? raw.details : klLedgerParseDetails_(raw.details)
  };
  if (!event.orderId || !event.lineId || !event.sku) {
    throw new Error('Planner вернул неполное событие (orderId/lineId/sku).');
  }
  if (!event.eventId) event.eventId = klLedgerMakeEventId_(event);
  return event;
}

function klLedgerSafeJson_(value) {
  try {
    return JSON.stringify(value || {});
  } catch (error) {
    return JSON.stringify({serializationError: klIoText_(error && error.message)});
  }
}

function klLedgerEventToRow_(event) {
  var processedAt = klIoToMs_(event.processedAtMs, Date.now());
  return [
    event.eventId,
    event.orderId,
    event.code,
    event.creationMs,
    event.status,
    event.lineId,
    event.sku,
    event.qty,
    klLedgerLegacyActionForEvent_(event.eventType),
    new Date(processedAt).toISOString(),
    event.eventId,
    event.eventType,
    event.cumulativeAfter,
    event.eventAtMs,
    processedAt,
    event.source,
    event.schemaVersion || KL_EVENT_SCHEMA_VERSION_,
    klLedgerSafeJson_(event.details)
  ];
}

function klLedgerSameIdentity_(left, right) {
  return left && right &&
    klIoText_(left.eventId) === klIoText_(right.eventId) &&
    klIoText_(left.orderId) === klIoText_(right.orderId) &&
    klIoText_(left.lineId) === klIoText_(right.lineId) &&
    klIoNormalizeSku_(left.sku) === klIoNormalizeSku_(right.sku) &&
    klIoText_(left.eventType).toUpperCase() === klIoText_(right.eventType).toUpperCase();
}

/**
 * Дедуплицирует, добавляет одним batch и затем перечитывает ledger.
 * Повтор после падения не создаст второе событие с тем же Event ID.
 */
function klLedgerAppendBatch_(events, dryRun) {
  var before = klLedgerReadIndex_();
  var unique = [];
  var batchById = Object.create(null);
  var skipped = 0;

  for (var i = 0; i < (events || []).length; i++) {
    var event = events[i];
    if (!event || !klIoText_(event.eventId)) continue;
    var id = klIoText_(event.eventId);
    if (batchById[id]) {
      if (!klLedgerSameIdentity_(batchById[id], event)) {
        throw new Error('Коллизия Event ID в batch: ' + id);
      }
      skipped++;
      continue;
    }
    batchById[id] = event;
    if (before.byId[id]) {
      if (!klLedgerSameIdentity_(before.byId[id], event)) {
        throw new Error('Коллизия Event ID с ledger: ' + id);
      }
      skipped++;
      continue;
    }
    unique.push(event);
  }

  if (dryRun || !unique.length) {
    return {
      planned: Object.keys(batchById).length,
      appended: 0,
      skipped: skipped,
      confirmed: dryRun ? [] : Object.keys(batchById),
      index: before
    };
  }

  var sheet = klLedgerEnsureSheet_();
  klLedgerValidateCanonicalHeaders_(sheet);

  // После setup перечитываем ID: между двумя чтениями мог писать другой запуск.
  before = klLedgerReadIndex_();
  var rows = [];
  var appendEvents = [];
  for (var u = 0; u < unique.length; u++) {
    if (before.byId[unique[u].eventId]) {
      skipped++;
      continue;
    }
    appendEvents.push(unique[u]);
    rows.push(klLedgerEventToRow_(unique[u]));
  }

  if (rows.length) {
    var startRow = sheet.getLastRow() + 1;
    // Длинные ID и SKU записываем как текст, чтобы Sheets их не округлил.
    sheet.getRange(startRow, 1, rows.length, 3).setNumberFormat('@');
    sheet.getRange(startRow, 6, rows.length, 2).setNumberFormat('@');
    sheet.getRange(startRow, 11, rows.length, 1).setNumberFormat('@');
    sheet.getRange(startRow, 1, rows.length, KL_LEDGER_HEADERS_.length).setValues(rows);
    SpreadsheetApp.flush();
  }

  var after = klLedgerReadIndex_();
  var missing = [];
  var confirmed = [];
  Object.keys(batchById).forEach(function (id) {
    if (after.byId[id]) confirmed.push(id);
    else missing.push(id);
  });
  if (missing.length) {
    throw new Error('Ledger не подтвердил Event ID: ' + missing.join(', '));
  }
  return {
    planned: Object.keys(batchById).length,
    appended: appendEvents.length,
    skipped: skipped,
    confirmed: confirmed,
    index: after
  };
}

function klLedgerUniqueSkus_(skus) {
  var seen = Object.create(null);
  var result = [];
  (skus || []).forEach(function (value) {
    var sku = klIoNormalizeSku_(value);
    if (!sku || seen[sku]) return;
    seen[sku] = true;
    result.push(sku);
  });
  return result;
}

/**
 * Crash-recovery hook: проекция всегда пересчитывается абсолютно из ledger.
 * Если запуск упал после append, overlap снова затронет SKU и вызовет hook.
 */
function klLedgerMaterializeAffected_(skus, dryRun, context) {
  var unique = klLedgerUniqueSkus_(skus);
  if (!unique.length) return [];
  if (typeof klMaterializeAffectedSkus_ !== 'function') {
    throw new Error('Не найден hook klMaterializeAffectedSkus_.');
  }
  return klMaterializeAffectedSkus_(unique, {
    dryRun: Boolean(dryRun),
    source: 'KL_ORDERS_RUN',
    context: context || {}
  });
}

function klProductMapKey_(merchantSku) {
  return klIoText_(merchantSku).toUpperCase();
}

/** Читает только явную SKU-карту; колонки остатков здесь не угадываются. */
function klLoadProductMap_() {
  var sheet = klIoGetSheet_(KL_PRODUCT_MAP_SHEET_);
  var result = {
    byMerchant: Object.create(null),
    byMaster: Object.create(null),
    conflicts: Object.create(null),
    rowCount: 0
  };
  if (!sheet || sheet.getLastRow() < 2) return result;

  var width = Math.max(KL_PRODUCT_MAP_HEADERS_.length, sheet.getLastColumn());
  var headers = sheet.getRange(1, 1, 1, width).getDisplayValues()[0];
  var masterIndex = headers.indexOf('Master product ID');
  var merchantIndex = headers.indexOf('Merchant SKU');
  if (masterIndex < 0 || merchantIndex < 0) {
    throw new Error(
      '_KASPI_PRODUCT_MAP должен содержать Master product ID и Merchant SKU.'
    );
  }

  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getDisplayValues();
  for (var i = 0; i < rows.length; i++) {
    var key = klProductMapKey_(rows[i][merchantIndex]);
    var merchant = klIoNormalizeSku_(rows[i][merchantIndex]);
    var masterKey = klProductMapKey_(rows[i][masterIndex]);
    if (!key || !merchant || !masterKey) continue;
    result.rowCount++;
    if (result.byMerchant[key] && result.byMerchant[key] !== merchant) {
      result.conflicts[key] = [result.byMerchant[key], merchant];
      delete result.byMerchant[key];
      continue;
    }
    if (!result.conflicts[key]) result.byMerchant[key] = merchant;
    if (result.byMaster[masterKey] && result.byMaster[masterKey] !== merchant) {
      result.conflicts[masterKey] = [result.byMaster[masterKey], merchant];
      delete result.byMaster[masterKey];
    } else if (!result.conflicts[masterKey]) {
      result.byMaster[masterKey] = merchant;
    }
  }
  return result;
}

function klResolveSku_(merchantProductCode, productMap) {
  var map = productMap || klLoadProductMap_();
  var key = klProductMapKey_(merchantProductCode);
  if (!key || map.conflicts[key]) return '';
  return klIoNormalizeSku_(map.byMerchant[key] || map.byMaster[key]);
}

/** Пишет ошибки пакетом; сам ledger при этом не изменяется. */
function klLedgerAppendErrors_(errors) {
  if (!errors || !errors.length) return 0;
  var sheet = klLedgerEnsureErrorSheet_();
  var rows = errors.map(function (item) {
    var reference = [
      klIoText_(item.sku),
      klIoText_(item.orderCode || item.orderId),
      klIoText_(item.entryId)
    ].filter(function (value) { return Boolean(value); }).join(' | ');
    return [
      item.loggedAt || new Date(),
      'Kaspi Ledger V2',
      klIoText_(item.stage),
      klIoText_(item.status || item.code) || 'ERROR',
      reference,
      klIoText_(item.error),
      klLedgerSafeJson_(item.details)
    ];
  });
  var start = sheet.getLastRow() + 1;
  sheet.getRange(start, 2, rows.length, 4).setNumberFormat('@');
  sheet.getRange(start, 1, rows.length, KL_ERROR_HEADERS_.length).setValues(rows);
  return rows.length;
}

/**
 * Безопасный setup: добавляет только недостающие листы/заголовки.
 * Триггеры здесь намеренно не создаются: иначе DRY_RUN удвоит API-трафик
 * рядом с живым ORDERS_RUN и может снова исчерпать UrlFetch quota.
 */
function KL_SETUP_SHEETS_AND_TRIGGERS() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Другой Kaspi-запуск уже выполняется.');
  try {
    var ledger = klIoEnsureSheetHeaders_(KL_LEDGER_SHEET_, KL_LEDGER_HEADERS_);
    var errors = klIoEnsureSheetHeaders_(KL_ERROR_SHEET_, KL_ERROR_HEADERS_);
    var productMap = klIoEnsureSheetHeaders_(
      KL_PRODUCT_MAP_SHEET_, KL_PRODUCT_MAP_HEADERS_
    );

    var props = PropertiesService.getScriptProperties();
    if (props.getProperty(KL_DRY_RUN_PROPERTY_) === null) {
      props.setProperty(KL_DRY_RUN_PROPERTY_, 'true');
    }
    // KL_CUTOVER_READY намеренно не включаем: это ручной safety gate.

    var found = false;
    var foundReconcile = false;
    var triggers = ScriptApp.getProjectTriggers();
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === 'KL_ORDERS_RUN') {
        found = true;
      }
      if (triggers[i].getHandlerFunction() === 'KL_RECONCILE_DAILY') {
        foundReconcile = true;
      }
    }
    var report = {
      dryRun: !(
        String(props.getProperty(KL_DRY_RUN_PROPERTY_)).toUpperCase() === 'FALSE' &&
        String(props.getProperty(KL_CUTOVER_READY_PROPERTY_)).toUpperCase() === 'YES'
      ),
      cutoverReady: props.getProperty(KL_CUTOVER_READY_PROPERTY_) === 'YES',
      createdSheets: [
        ledger.created ? KL_LEDGER_SHEET_ : '',
        errors.created ? KL_ERROR_SHEET_ : '',
        productMap.created ? KL_PRODUCT_MAP_SHEET_ : ''
      ].filter(function (name) { return Boolean(name); }),
      headerWarnings: ledger.warnings.concat(errors.warnings, productMap.warnings),
      ordersTriggerExists: found,
      reconcileTriggerExists: foundReconcile,
      createdOrdersTrigger: false,
      createdReconcileTrigger: false,
      productionEnabled:
        String(props.getProperty(KL_DRY_RUN_PROPERTY_)).toUpperCase() === 'FALSE' &&
        String(props.getProperty(KL_CUTOVER_READY_PROPERTY_)).toUpperCase() === 'YES'
    };
    klIoLog_(JSON.stringify(report));
    return report;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Отдельный явный шаг после cutover. Ничего не удаляет и не трогает чужие
 * triggers; создаёт только отсутствующие KL_* handlers.
 */
function KL_INSTALL_PRODUCTION_TRIGGERS() {
  var props = PropertiesService.getScriptProperties();
  if (String(props.getProperty(KL_DRY_RUN_PROPERTY_)).toUpperCase() !== 'FALSE' ||
      String(props.getProperty(KL_CUTOVER_READY_PROPERTY_)).toUpperCase() !== 'YES') {
    throw new Error(
      'Триггеры не установлены: нужны KL_DRY_RUN=FALSE и KL_CUTOVER_READY=YES.'
    );
  }
  var handlers = Object.create(null);
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    handlers[trigger.getHandlerFunction()] = true;
  });
  if (!handlers.KL_ORDERS_RUN) {
    ScriptApp.newTrigger('KL_ORDERS_RUN').timeBased().everyMinutes(10).create();
  }
  if (!handlers.KL_RECONCILE_DAILY) {
    ScriptApp.newTrigger('KL_RECONCILE_DAILY')
      .timeBased().everyDays(1).atHour(4).create();
  }
  return {
    ordersTriggerCreated: !handlers.KL_ORDERS_RUN,
    reconcileTriggerCreated: !handlers.KL_RECONCILE_DAILY,
    legacyOrdersTriggerStillExists: Boolean(handlers.ORDERS_RUN)
  };
}
