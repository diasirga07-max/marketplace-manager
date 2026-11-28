/**
 * Sklad.gs — склад "в наличии" для Kaspi-прайса.
 *
 * Что делает:
 *  - создаёт лист СКЛАД_НАЛИЧИЕ, где вы вручную вводите артикулы и количество;
 *  - считает доступность из контрольного количества и движений _KASPI_ORDER_EVENTS;
 *  - отмена освобождает резерв только при известном факте, что передачи в доставку не было;
 *  - артикулы, которых нет в листе или у которых доступно 0, должны идти в прайс как ПРЕДЗАКАЗ.
 *
 * Безопасность: читает _KASPI_ORDER_EVENTS и пишет только в СКЛАД_НАЛИЧИЕ.
 * KASPI_ЗАКАЗЫ не используется как источник расчёта: этот лист обновляется с перезаписью.
 *
 * Как пользоваться: см. инструкцию в конце файла.
 */

var SK_SHEET = 'СКЛАД_НАЛИЧИЕ';
var SK_RELEASE_WHEN_HANDOFF_UNKNOWN = false;
// По умолчанию только расчёт/отчёт. Снимайте флаг только после проверки DRY_RUN.
var SK_LEDGER_DRY_RUN_ONLY = false;

// Колонки листа склада (1 = A).
var SK_COL = {
  SKU: 1, NAME: 2, QTY: 3, COUNTED_AT: 4,
  RESERVED: 5, AVAILABLE: 6, MODE: 7, MOVEMENT: 8
};

/* ---------- чистые функции (без обращения к таблице, их можно тестировать) ---------- */

function skNormSku_(v) {
  return String(v === null || v === undefined ? '' : v).trim();
}

/**
 * Разрешает SKU из строки заказа в Merchant SKU по _KASPI_PRODUCT_MAP.
 * Для кода вида productId_variantId сначала ищется Master product ID
 * (он хранится в карте в Base64), затем точное совпадение Merchant SKU.
 * Если пары нет или карта недоступна, возвращает исходный код.
 */
function SKLAD_skuResolver(raw, productMap) {
  return skResolveSkuResult_(raw, productMap).sku;
}

/** Возвращает результат и признак явного совпадения с картой товара. */
function skResolveSkuResult_(raw, productMap) {
  var original = skNormSku_(raw);
  if (!original) return {sku: raw, mapped: false};
  if (typeof klResolveSku_ !== 'function') return {sku: original, mapped: false};

  var map = productMap || null;
  if (productMap === undefined && !map && typeof klLoadProductMap_ === 'function') {
    try { map = klLoadProductMap_(); }
    catch (mapError) {
      console.warn('Не удалось прочитать _KASPI_PRODUCT_MAP: ' + mapError.message);
      return {sku: original, mapped: false};
    }
  }
  if (!map) return {sku: original, mapped: false};

  var candidates = [];
  var separator = original.indexOf('_');
  if (separator > 0 && typeof Utilities !== 'undefined' && Utilities.base64Encode) {
    candidates.push(Utilities.base64Encode(original.slice(0, separator)));
  }
  candidates.push(original);

  for (var i = 0; i < candidates.length; i++) {
    var resolved = klResolveSku_(candidates[i], map);
    if (resolved) return {sku: resolved, mapped: true};
  }
  return {sku: original, mapped: false};
}

function skParseDate_(v) {
  if (v instanceof Date) return v.getTime();
  var s = skNormSku_(v);
  if (!s) return NaN;
  var m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    return new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
  }
  var t = Date.parse(s);
  return isNaN(t) ? NaN : t;
}

/** Разбирает одну или несколько позиций, включая множитель xN/хN. */
function skParseOrderSkus_(cell) {
  var raw = skNormSku_(cell);
  if (!raw) return [];
  var parts = raw.split(/[;\n]+/), out = [];
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i].trim();
    if (!part) continue;
    var qty = 1;
    var match = part.match(/^(.+?)\s*[xхXХ×]\s*(\d{1,4})$/);
    if (match && match[1].trim()) {
      part = match[1].trim();
      qty = parseInt(match[2], 10) || 1;
    }
    out.push({sku: part, qty: qty});
  }
  return out;
}

/** Отмена освобождает резерв по отметке передачи; без данных действует отдельный флаг. */
function skIsReleased_(state, status, handedOver, handoffKnown) {
  var st = skNormSku_(state).toUpperCase();
  var ru = skNormSku_(status).toLowerCase();
  var cancelled = st === 'CANCELLED' || ru === 'отменен' || ru === 'отменён';
  if (!cancelled) return false;
  if (handoffKnown === true) return handedOver !== true;
  return SK_RELEASE_WHEN_HANDOFF_UNKNOWN === true;
}

/** Для отчёта исключает завершённые, отменённые и уже возвращённые заказы. */
function skIsActiveOrder_(state, status) {
  var terminal = {COMPLETED: true, CANCELLED: true, RETURNED: true};
  var st = skNormSku_(state).toUpperCase();
  var ru = skNormSku_(status).toUpperCase();
  return !terminal[st] && !terminal[ru];
}

/** Возвращает активные позиции, для которых product map не дала пару. */
function skUnmappedActiveOrders_(orders, stockSkuSet) {
  return (orders || []).filter(function (order) {
    var sku = skNormSku_(order.sku);
    var hasWarehousePair = stockSkuSet
      ? Object.prototype.hasOwnProperty.call(stockSkuSet, sku)
      : order.mapped === true;
    return skIsActiveOrder_(order.state, order.status) && !hasWarehousePair;
  }).map(function (order) {
    return {
      sku: skNormSku_(order.rawSku || order.sku),
      orderNo: skNormSku_(order.orderNo),
      status: skNormSku_(order.status)
    };
  });
}

/** Сжимает отчёт до одной строки на SKU, сохраняя номера заказов. */
function skGroupUnmappedActiveOrders_(orders, stockSkuSet) {
  var groups = Object.create(null);
  skUnmappedActiveOrders_(orders, stockSkuSet).forEach(function (item) {
    if (!groups[item.sku]) groups[item.sku] = [];
    if (item.orderNo && groups[item.sku].indexOf(item.orderNo) < 0) {
      groups[item.sku].push(item.orderNo);
    }
  });
  return Object.keys(groups).sort().map(function (sku) {
    return {sku: sku, orders: groups[sku]};
  });
}

/**
 * orders: [{sku, qty, dateMs, released}]
 * countedAt: {sku: ms}  — когда вы последний раз выставили количество.
 * Возвращает {sku: сколько штук в активных заказах}.
 * Считаются только заказы, созданные ПОСЛЕ даты подсчёта. Если дата заказа не
 * читается, заказ считается активным (безопасно: так не продадим лишнее).
 */
function skCalcReserves_(orders, countedAt) {
  var res = {};
  for (var i = 0; i < orders.length; i++) {
    var o = orders[i];
    var sku = skNormSku_(o.sku);
    if (!sku || !Object.prototype.hasOwnProperty.call(countedAt, sku)) continue;
    if (o.released) continue;
    var t = o.dateMs;
    if (!isNaN(t) && t <= countedAt[sku]) continue;
    res[sku] = (res[sku] || 0) + (o.qty > 0 ? o.qty : 1);
  }
  return res;
}

function skAvailability_(qty, reserved) {
  var q = Number(qty);
  if (!isFinite(q) || q < 0) q = 0;
  return Math.max(0, Math.floor(q) - (reserved || 0));
}

/**
 * Сворачивает историю одной позиции. Списание учитывается один раз по Event ID;
 * RELEASE возвращает только ранее зарезервированное количество, а RETURN_RESTOCK
 * только ранее отмеченное событие RETURN_PENDING. SHIP сам по себе второй раз товар
 * не списывает: резерв уже уменьшил доступность.
 */
function skLedgerLineState_(events, cutoffMs) {
  var seen = Object.create(null);
  var ordered = (events || []).slice().sort(function (a, b) {
    var at = Number(a.eventAtMs) || 0;
    var bt = Number(b.eventAtMs) || 0;
    if (at !== bt) return at - bt;
    return (Number(a.rowNumber) || 0) - (Number(b.rowNumber) || 0);
  });
  var reserveOpen = 0;
  var returnOpen = 0;
  var reserveAtCutoff = 0;
  var returnAtCutoff = 0;
  var movement = 0;
  var applied = [];
  var warnings = [];
  for (var i = 0; i < ordered.length; i++) {
    var event = ordered[i] || {};
    var id = String(event.eventId || '').trim();
    if (id && seen[id]) continue;
    if (id) seen[id] = true;
    var type = String(event.eventType || '').trim().toUpperCase();
    var qty = Number(event.qty);
    if (!isFinite(qty) || qty <= 0 || Math.floor(qty) !== qty) continue;
    var at = Number(event.eventAtMs) || 0;
    var afterCutoff = cutoffMs !== null && cutoffMs !== undefined && at > cutoffMs;
    var delta = 0;
    if (type === 'RESERVE' || type === 'DEDUCTED' || type === 'RESERVED') {
      reserveOpen += qty;
      if (afterCutoff) delta = -qty;
    } else if (type === 'RELEASE' || type === 'RELEASED' || type === 'RESTORED') {
      // Legacy A:J не содержит факта передачи/причины возврата. Не возвращаем его
      // автоматически: только канонический v2 RELEASE безопасно различает сценарии.
      if (event.canonical === false) {
        warnings.push('LEGACY_RESTORED_HANDOFF_UNKNOWN:' + (id || 'row_' + event.rowNumber));
      } else {
        var released = Math.min(reserveOpen, qty);
        if (released < qty) warnings.push('RELEASE_WITHOUT_RESERVE:' + (id || 'row_' + event.rowNumber));
        reserveOpen -= released;
        if (afterCutoff) delta = released;
      }
    } else if (type === 'SHIP' || type === 'SHIPPED') {
      if (qty > reserveOpen) warnings.push('SHIP_WITHOUT_RESERVE:' + (id || 'row_' + event.rowNumber));
      reserveOpen = Math.max(0, reserveOpen - qty);
    } else if (type === 'RETURN_PENDING') {
      returnOpen += qty;
    } else if (type === 'RETURN_RESTOCK' || type === 'RETURN_RESTOCKED' ||
               type === 'RETURNED_TO_STOCK') {
      var restocked = Math.min(returnOpen, qty);
      returnOpen -= restocked;
      if (restocked < qty) warnings.push('RETURN_RESTOCK_WITHOUT_PENDING:' + (id || 'row_' + event.rowNumber));
      if (afterCutoff) delta = restocked;
    }
    if (cutoffMs !== null && cutoffMs !== undefined && at <= cutoffMs) {
      reserveAtCutoff = reserveOpen;
      returnAtCutoff = returnOpen;
    }
    if (delta) {
      movement += delta;
      applied.push({event: event, delta: delta});
    }
  }
  return {
    movement: movement, activeReserve: reserveOpen, pendingReturn: returnOpen,
    activeReserveAtCutoff: reserveAtCutoff, pendingReturnAtCutoff: returnAtCutoff,
    applied: applied, warnings: warnings
  };
}

/** Индекс событий по разрешённому SKU; читает только ledger, не создаёт листы. */
function skReadLedgerEvents_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss && ss.getSheetByName('_KASPI_ORDER_EVENTS');
  if (!sheet) return {events: [], problem: 'Не найден лист _KASPI_ORDER_EVENTS.'};
  var rawRows = [];
  if (sheet.getLastRow() >= 2) {
    var width = Math.min(18, Math.max(10, sheet.getLastColumn()));
    rawRows = sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues();
  }
  var productMap = null;
  var mapSheet = ss.getSheetByName('_KASPI_PRODUCT_MAP');
  productMap = {byMerchant: Object.create(null), byMaster: Object.create(null), conflicts: Object.create(null)};
  if (mapSheet && mapSheet.getLastRow() >= 2) {
    var mapWidth = mapSheet.getLastColumn();
    var headers = mapSheet.getRange(1, 1, 1, mapWidth).getDisplayValues()[0];
    var masterCol = headers.indexOf('Master product ID');
    var merchantCol = headers.indexOf('Merchant SKU');
    if (masterCol < 0 || merchantCol < 0) {
      return {events: [], problem: '_KASPI_PRODUCT_MAP не содержит заголовки Master product ID и Merchant SKU.'};
    }
    var mapRows = mapSheet.getRange(2, 1, mapSheet.getLastRow() - 1, mapWidth).getDisplayValues();
    mapRows.forEach(function (row) {
      var master = skNormSku_(row[masterCol]).toUpperCase();
      var merchant = skNormSku_(row[merchantCol]);
      if (!master || !merchant) return;
      var merchantKey = merchant.toUpperCase();
      if (productMap.byMerchant[merchantKey] && productMap.byMerchant[merchantKey] !== merchant) {
        productMap.conflicts[merchantKey] = true;
        delete productMap.byMerchant[merchantKey];
      } else if (!productMap.conflicts[merchantKey]) {
        productMap.byMerchant[merchantKey] = merchant;
      }
      if (productMap.byMaster[master] && productMap.byMaster[master] !== merchant) {
        productMap.conflicts[master] = true;
        delete productMap.byMaster[master];
      } else if (!productMap.conflicts[master]) {
        productMap.byMaster[master] = merchant;
      }
    });
  }
  var events = [];
  rawRows.forEach(function (row, index) {
    var eventId = skNormSku_(row[10]) || skNormSku_(row[0]) || ('LEGACY_ROW_' + (index + 2));
    var canonical = Boolean(skNormSku_(row[10]) && skNormSku_(row[11]));
    var type = skNormSku_(row[11]).toUpperCase();
    if (!type) {
      var action = skNormSku_(row[8]).toUpperCase();
      type = typeof klLedgerEventTypeFromLegacy_ === 'function'
        ? klLedgerEventTypeFromLegacy_(action) : action;
      if (type === 'DEDUCTED' || type === 'RESERVED') type = 'RESERVE';
      if (type === 'RESTORED' || type === 'RELEASED') type = 'RELEASE';
      if (type === 'SHIPPED') type = 'SHIP';
      if (type === 'RETURN_RESTOCKED' || type === 'RETURNED_TO_STOCK') type = 'RETURN_RESTOCK';
    }
    if (!type) return;
    var sku = skNormSku_(row[6]);
    if (typeof SKLAD_skuResolver === 'function' && sku) {
      try { sku = skNormSku_(SKLAD_skuResolver(sku, productMap)) || sku; }
      catch (resolverError) { /* Сохраняем исходный SKU для видимой сверки. */ }
    }
    var legacyUpdatedAt = row[9];
    var eventAt = 0;
    if (canonical) eventAt = skLedgerToMs_(row[13]);
    else eventAt = skLedgerToMs_(legacyUpdatedAt) || skLedgerToMs_(row[3]);
    events.push({
      eventId: eventId, eventType: type, qty: Number(row[7]) || 0,
      orderId: row[1] || '', lineId: row[5] || '', sku: sku,
      eventAtMs: eventAt, rowNumber: index + 2,
      code: row[2] || '', canonical: canonical
    });
  });
  return {events: events, problem: ''};
}

/** Преобразует Date, время Google Sheets либо миллисекунды Kaspi в epoch ms. */
function skLedgerToMs_(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && isFinite(value)) {
    if (value > 100000000000) return Math.round(value);
    if (value > 20000 && value < 100000) return Math.round((value - 25569) * 86400000);
    if (value > 0 && value < 100000000000) return Math.round(value * 1000);
  }
  var parsed = Date.parse(String(value || ''));
  return isNaN(parsed) ? 0 : parsed;
}

function skEventsForSku_(events, sku) {
  var key = skNormSku_(sku).toUpperCase();
  return (events || []).filter(function (event) {
    return skNormSku_(event.sku).toUpperCase() === key;
  });
}

function skLedgerMovement_(events, sku, countedAtMs) {
  return skLedgerSkuState_(events, sku, countedAtMs).movement;
}

/**
 * C — физическое количество на дату подсчёта.
 * Вычитаем резерв, уже открытый на эту дату, затем применяем только движения после неё.
 */
function skAvailableAfterMovement_(qty, movement, reserveAtCount) {
  var baseline = Number(qty);
  if (!isFinite(baseline) || baseline < 0) baseline = 0;
  var reserved = Number(reserveAtCount);
  if (!isFinite(reserved) || reserved < 0) reserved = 0;
  return Math.max(0, Math.floor(baseline) - Math.floor(reserved) + (Number(movement) || 0));
}

/** Активные резервы ledger без строки склада — для ручной сверки. */
function skUnmappedLedgerReserves_(events, stockSkuSet) {
  var skuSet = Object.create(null);
  (events || []).forEach(function (event) {
    var sku = skNormSku_(event.sku);
    if (sku) skuSet[sku.toUpperCase()] = sku;
  });
  var missing = [];
  Object.keys(skuSet).forEach(function (key) {
    if (Object.prototype.hasOwnProperty.call(stockSkuSet || {}, key)) return;
    var state = skLedgerSkuState_(events, skuSet[key], null);
    if (state.activeReserve <= 0) return;
    missing.push({sku: skuSet[key], qty: state.activeReserve});
  });
  return missing.sort(function (a, b) { return a.sku.localeCompare(b.sku); });
}

function skLedgerWarningsAll_(events) {
  var skuSet = Object.create(null), warnings = [];
  (events || []).forEach(function (event) {
    var sku = skNormSku_(event.sku);
    if (sku) skuSet[sku.toUpperCase()] = sku;
  });
  Object.keys(skuSet).forEach(function (key) {
    var sku = skuSet[key];
    skLedgerSkuState_(events, sku, null).warnings.forEach(function (warning) {
      warnings.push({sku: sku, warning: warning});
    });
  });
  return warnings;
}

/** Пишет ошибки свёртки журнала один раз на неизменившийся набор проблем. */
function skAppendLedgerErrorsOnce_(issues) {
  var props = PropertiesService.getScriptProperties();
  var property = 'SKLAD_LEDGER_ERROR_HASH';
  if (!issues.length) {
    props.deleteProperty(property);
    return 0;
  }
  var source = JSON.stringify(issues);
  var hash = typeof klNotifyHash_ === 'function' ? klNotifyHash_(source) : source.slice(0, 4000);
  if (props.getProperty(property) === hash) return 0;
  if (typeof klLedgerAppendErrors_ !== 'function') {
    throw new Error('Не найдена функция klLedgerAppendErrors_ для записи _ORDER_SYNC_ERRORS.');
  }
  var count = klLedgerAppendErrors_(issues.map(function (item) {
    return {
      stage: 'SKLAD_LEDGER_FOLD', error: item.warning,
      sku: item.sku, orderId: item.orderId, entryId: item.lineId,
      orderCode: item.code, status: item.eventType
    };
  }));
  props.setProperty(property, hash);
  return count;
}

/** Сводит каждую позицию отдельно, чтобы события разных заказов не смешивались. */
function skLedgerSkuState_(events, sku, countedAtMs) {
  var lines = Object.create(null);
  skEventsForSku_(events, sku).forEach(function (event) {
    var order = String(event.orderId || '');
    var line = String(event.lineId || event.eventId || event.rowNumber || '');
    var key = order + '\u001f' + line;
    if (!lines[key]) lines[key] = [];
    lines[key].push(event);
  });
  var result = {
    movement: 0, activeReserve: 0, pendingReturn: 0,
    activeReserveAtCutoff: 0, pendingReturnAtCutoff: 0, applied: [], warnings: []
  };
  Object.keys(lines).forEach(function (key) {
    var folded = skLedgerLineState_(lines[key], countedAtMs);
    result.movement += folded.movement;
    result.activeReserve += folded.activeReserve;
    result.pendingReturn += folded.pendingReturn;
    result.activeReserveAtCutoff += folded.activeReserveAtCutoff;
    result.pendingReturnAtCutoff += folded.pendingReturnAtCutoff;
    result.applied = result.applied.concat(folded.applied);
    result.warnings = result.warnings.concat(folded.warnings);
  });
  return result;
}

/* ---------- работа с таблицей ---------- */

/** Первый запуск: создаёт лист и триггеры. Запустите один раз. */
function SKLAD_setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SK_SHEET);
  if (!sh) sh = ss.insertSheet(SK_SHEET);
  var headers = [
    'Артикул (SKU Kaspi)',
    'Название (по желанию)',
    'Количество на складе (вводите вы)',
    'Дата подсчёта (авто)',
    'В активных заказах (авто)',
    'Доступно для продажи (авто)',
    'Режим на Kaspi (авто)',
    'Движение по заказам'
  ];
  sh.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#e8f0fe').setWrap(true);
  sh.setFrozenRows(1);
  sh.setColumnWidths(1, 1, 160);
  sh.setColumnWidths(2, 1, 260);
  sh.setColumnWidths(3, 5, 150);
  sh.setColumnWidth(SK_COL.MOVEMENT, 190);
  sh.getRange(2, SK_COL.SKU, sh.getMaxRows() - 1, 1).setNumberFormat('@');
  sh.getRange(2, SK_COL.QTY, sh.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireNumberGreaterThanOrEqualTo(0)
      .setAllowInvalid(false).setHelpText('Целое число, 0 или больше').build());
  var auto = sh.getRange(2, SK_COL.COUNTED_AT, sh.getMaxRows() - 1, 5);
  auto.setBackground('#f3f3f3');
  var already = sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).some(function (p) {
    return p.getDescription() === 'SKLAD_AUTO';
  });
  if (!already) auto.protect().setDescription('SKLAD_AUTO').setWarningOnly(true);
  SKLAD_installTriggers();
  SpreadsheetApp.getActive().toast('Лист "' + SK_SHEET + '" готов. Вводите артикулы и количество.', 'Склад', 8);
}

function SKLAD_installTriggers() {
  var mine = { SKLAD_onEdit: 1, SKLAD_recalc: 1, SKLAD_onOpen: 1 };
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (mine[t.getHandlerFunction()]) ScriptApp.deleteTrigger(t);
  });
  var ss = SpreadsheetApp.getActive();
  ScriptApp.newTrigger('SKLAD_onEdit').forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger('SKLAD_onOpen').forSpreadsheet(ss).onOpen().create();
  ScriptApp.newTrigger('SKLAD_recalc').timeBased().everyMinutes(5).create();
}

function SKLAD_onOpen() {
  SpreadsheetApp.getUi().createMenu('Склад')
    .addItem('Пересчитать доступность', 'SKLAD_recalc')
    .addItem('DRY_RUN журнала заказов', 'SKLAD_LEDGER_DRY_RUN_REPORT')
    .addItem('Тесты журнала', 'SKLAD_TEST_ledgerMovement_')
    .addItem('Проверить данные', 'SKLAD_check')
    .addToUi();
}

/** При изменении количества ставит дату подсчёта и пересчитывает. */
function SKLAD_onEdit(e) {
  if (!e || !e.range) return;
  var sh = e.range.getSheet();
  if (sh.getName() !== SK_SHEET) return;
  var r = e.range;
  if (r.getRow() < 2) return;
  var c1 = r.getColumn(), c2 = r.getLastColumn();
  if (SK_COL.QTY < c1 || SK_COL.QTY > c2) return;
  var now = new Date();
  var n = r.getNumRows();
  var stamps = [];
  for (var i = 0; i < n; i++) stamps.push([now]);
  sh.getRange(r.getRow(), SK_COL.COUNTED_AT, n, 1).setValues(stamps);
  SKLAD_recalc();
}

/** Чистая проверка resolver: Master ID, прямое совпадение и fallback на raw. */
function SKLAD_TEST_skuResolver_() {
  if (typeof Utilities === 'undefined' || !Utilities.base64Encode ||
      typeof klResolveSku_ !== 'function') {
    throw new Error('Для проверки нужны Apps Script Utilities и klResolveSku_.');
  }
  var masterKey = Utilities.base64Encode('101535286');
  var map = {
    byMerchant: { 'KNOWN-SKU': 'KNOWN-SKU' },
    byMaster: {},
    conflicts: {}
  };
  map.byMaster[masterKey.toUpperCase()] = 'PRICE-SKU-1';
  var mapped = SKLAD_skuResolver('101535286_766003910', map);
  var direct = SKLAD_skuResolver('KNOWN-SKU', map);
  var fallback = SKLAD_skuResolver('UNKNOWN_123', map);
  if (mapped !== 'PRICE-SKU-1' || direct !== 'KNOWN-SKU' || fallback !== 'UNKNOWN_123') {
    throw new Error('Проверка SKLAD_skuResolver не пройдена: ' +
      JSON.stringify({mapped: mapped, direct: direct, fallback: fallback}));
  }
  return 'OK: 3 проверки SKLAD_skuResolver';
}

/** Чистые проверки составных SKU, количества и безопасной обработки отмены. */
function SKLAD_TEST_v2_() {
  var parsed = skParseOrderSkus_('SHYN024; SHYN028; SHYN024 x2; WBKANSPLS х3');
  var expected = [
    {sku: 'SHYN024', qty: 1},
    {sku: 'SHYN028', qty: 1},
    {sku: 'SHYN024', qty: 2},
    {sku: 'WBKANSPLS', qty: 3}
  ];
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) {
    throw new Error('Разбор артикула/количества не пройден: ' + JSON.stringify(parsed));
  }
  var oldReleaseFlag = SK_RELEASE_WHEN_HANDOFF_UNKNOWN;
  SK_RELEASE_WHEN_HANDOFF_UNKNOWN = false;
  var unknownHandoffDefault = skIsReleased_('CANCELLED', '', false, false);
  SK_RELEASE_WHEN_HANDOFF_UNKNOWN = true;
  var unknownHandoffOptIn = skIsReleased_('CANCELLED', '', false, false);
  SK_RELEASE_WHEN_HANDOFF_UNKNOWN = oldReleaseFlag;
  if (unknownHandoffDefault !== false || unknownHandoffOptIn !== true ||
      skIsReleased_('CANCELLED', '', true, true) !== false ||
      skIsReleased_('CANCELLED', '', false, true) !== true ||
      skIsReleased_('CANCELLED', '', false, false) !== false ||
      skIsReleased_('', 'CANCELLING', false, true) !== false) {
    throw new Error('Проверка статусов отмены/передачи не пройдена.');
  }
  var reserves = skCalcReserves_([
    {sku: 'SHYN024', qty: 2, dateMs: 20, released: false},
    {sku: 'SHYN024', qty: 1, dateMs: 20, released: true},
    {sku: 'SHYN028', qty: 3, dateMs: 20, released: false}
  ], {SHYN024: 10, SHYN028: 10});
  if (reserves.SHYN024 !== 2 || reserves.SHYN028 !== 3) {
    throw new Error('Проверка суммирования резервов по qty не пройдена: ' + JSON.stringify(reserves));
  }
  var unmapped = skUnmappedActiveOrders_([
    {sku: 'MISS-1', rawSku: 'MISS-1', mapped: false, status: 'ACCEPTED_BY_MERCHANT', orderNo: 'O1'},
    {sku: 'MISS-2', rawSku: 'MISS-2', mapped: false, status: 'CANCELLING', orderNo: 'O2'},
    {sku: 'DONE', rawSku: 'DONE', mapped: false, status: 'COMPLETED', orderNo: 'O3'},
    {sku: 'KNOWN', rawSku: 'KNOWN', mapped: true, status: 'ACCEPTED_BY_MERCHANT', orderNo: 'O4'}
  ]);
  if (unmapped.length !== 2 || unmapped[0].sku !== 'MISS-1' || unmapped[1].sku !== 'MISS-2') {
    throw new Error('Отчёт по несопоставленным активным SKU некорректен: ' + JSON.stringify(unmapped));
  }
  var grouped = skGroupUnmappedActiveOrders_([
    {sku: 'MISS-1', mapped: false, status: 'ACCEPTED_BY_MERCHANT', orderNo: 'O1'},
    {sku: 'MISS-1', mapped: false, status: 'ACCEPTED_BY_MERCHANT', orderNo: 'O2'},
    {sku: 'DONE', mapped: false, status: 'COMPLETED', orderNo: 'O3'}
  ]);
  if (grouped.length !== 1 || grouped[0].orders.join(',') !== 'O1,O2') {
    throw new Error('Группировка несопоставленных активных SKU не пройдена.');
  }
  var warehouseAware = skUnmappedActiveOrders_([
    {sku: 'SAME-RAW', mapped: false, status: 'ACCEPTED_BY_MERCHANT', orderNo: 'O5'},
    {sku: 'NO-STOCK-ROW', mapped: true, status: 'ACCEPTED_BY_MERCHANT', orderNo: 'O6'}
  ], {'SAME-RAW': 2});
  if (warehouseAware.length !== 1 || warehouseAware[0].sku !== 'NO-STOCK-ROW') {
    throw new Error('Сверка активных SKU со складской картой не пройдена.');
  }
  return 'OK: разбор позиций, qty, флаг передачи и активные несопоставленные SKU';
}

/** Чистые тесты ledger: списание, отмена, возврат, replay и защита от минуса. */
function SKLAD_TEST_ledgerMovement_() {
  var events = [
    {eventId: 'O1|L1|RESERVE|2', eventType: 'RESERVE', qty: 2, orderId: 'O1', lineId: 'L1', sku: 'SKU-1', eventAtMs: 20},
    // Точный повтор того же Event ID не должен списать второй раз.
    {eventId: 'O1|L1|RESERVE|2', eventType: 'RESERVE', qty: 2, orderId: 'O1', lineId: 'L1', sku: 'SKU-1', eventAtMs: 20},
    {eventId: 'O1|L1|RELEASE|1', eventType: 'RELEASE', qty: 1, orderId: 'O1', lineId: 'L1', sku: 'SKU-1', eventAtMs: 30},
    {eventId: 'O1|L1|SHIP|1', eventType: 'SHIP', qty: 1, orderId: 'O1', lineId: 'L1', sku: 'SKU-1', eventAtMs: 40},
    // Первая увиденная отмена без RESERVE ничего не возвращает.
    {eventId: 'O2|L1|RELEASE|1', eventType: 'RELEASE', qty: 1, orderId: 'O2', lineId: 'L1', sku: 'SKU-1', eventAtMs: 50},
    {eventId: 'O3|L1|RESERVE|1', eventType: 'RESERVE', qty: 1, orderId: 'O3', lineId: 'L1', sku: 'SKU-2', eventAtMs: 20},
    {eventId: 'O3|L1|SHIP|1', eventType: 'SHIP', qty: 1, orderId: 'O3', lineId: 'L1', sku: 'SKU-2', eventAtMs: 21},
    {eventId: 'O3|L1|RETURN_PENDING|1', eventType: 'RETURN_PENDING', qty: 1, orderId: 'O3', lineId: 'L1', sku: 'SKU-2', eventAtMs: 22},
    {eventId: 'O3|L1|RETURN_RESTOCK|1', eventType: 'RETURN_RESTOCK', qty: 1, orderId: 'O3', lineId: 'L1', sku: 'SKU-2', eventAtMs: 60},
    {eventId: 'O4|L1|RESERVE|4', eventType: 'RESERVE', qty: 4, orderId: 'O4', lineId: 'L1', sku: 'SKU-3', eventAtMs: 20}
  ];
  var partial = skLedgerSkuState_(events, 'SKU-1', 10);
  var pending = skLedgerSkuState_(events.filter(function (e) {
    return e.orderId === 'O3' && e.eventType !== 'RETURN_RESTOCK';
  }), 'SKU-2', 10);
  var returned = skLedgerSkuState_(events, 'SKU-2', 10);
  var strictCutoff = skLedgerSkuState_(events, 'SKU-1', 30);
  var legacyAmbiguous = skLedgerSkuState_([
    {eventId: 'legacy-reserve', eventType: 'RESERVE', qty: 1, orderId: 'OL', lineId: 'LL', sku: 'SKU-L', eventAtMs: 20, canonical: false},
    {eventId: 'legacy-restore', eventType: 'RELEASE', qty: 1, orderId: 'OL', lineId: 'LL', sku: 'SKU-L', eventAtMs: 30, canonical: false}
  ], 'SKU-L', 10);
  if (partial.movement !== -1 || partial.activeReserve !== 0) {
    throw new Error('Резерв/частичная отмена/передача дают неверный итог: ' + JSON.stringify(partial));
  }
  if (pending.movement !== -1 || pending.pendingReturn !== 1) {
    throw new Error('Ожидание возврата не должно добавлять остаток: ' + JSON.stringify(pending));
  }
  if (returned.movement !== 0 || returned.pendingReturn !== 0) {
    throw new Error('Подтверждённый возврат должен компенсировать одно списание: ' + JSON.stringify(returned));
  }
  if (strictCutoff.movement !== 0) {
    throw new Error('Событие ровно на времени подсчёта не должно считаться событием после него.');
  }
  if (strictCutoff.activeReserveAtCutoff !== 1) {
    throw new Error('DRY_RUN должен отдельно показывать резерв, уже существовавший на дату подсчёта.');
  }
  if (legacyAmbiguous.movement !== -1 || legacyAmbiguous.activeReserve !== 1 ||
      !legacyAmbiguous.warnings.some(function (warning) {
        return warning.indexOf('LEGACY_RESTORED_HANDOFF_UNKNOWN:') === 0;
      })) {
    throw new Error('Старое RESTORED без даты передачи не должно автоматически возвращать товар.');
  }
  if (skAvailableAfterMovement_(1, partial.movement, partial.activeReserveAtCutoff) !== 0 ||
      skAvailableAfterMovement_(1, -4, 0) !== 0 ||
      skAvailableAfterMovement_(6, 0, 1) !== 5 ||
      skAvailableAfterMovement_(6, 1, 1) !== 6 ||
      skLedgerSkuState_(events, 'SKU-3', 10).movement !== -4) {
    throw new Error('Нарушена формула физический остаток − резерв на дату подсчёта + движение.');
  }
  return 'OK: dedupe, резерв, частичная отмена, SHIP, RETURN_PENDING, RETURN_RESTOCK, cutoff, floor';
}

/** Главный расчёт. Запускается сам: при правке количества и каждые 5 минут. */
function SKLAD_recalc() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return;
  try {
    var sh = SpreadsheetApp.getActive().getSheetByName(SK_SHEET);
    if (!sh || sh.getLastRow() < 2) return;
    var n = sh.getLastRow() - 1;
    var rows = sh.getRange(2, 1, n, 4).getValues();

    var ledger = skReadLedgerEvents_();
    if (ledger.problem) {
      // При сбое чтения журнала не пересчитываем и не завышаем доступность.
      SpreadsheetApp.getActive().toast(ledger.problem, 'Склад: расчёт остановлен', 10);
      return;
    }
    var out = [];
    var ledgerIssues = [];
    for (var j = 0; j < n; j++) {
      var s = skNormSku_(rows[j][SK_COL.SKU - 1]);
      if (!s) { out.push(['', '', '', '']); continue; }
      var stamp = rows[j][SK_COL.COUNTED_AT - 1];
      var cutoff = stamp instanceof Date ? stamp.getTime() : skParseDate_(stamp);
      // Без даты нельзя безопасно применять старые события к ручному остатку.
      if (isNaN(cutoff)) cutoff = Date.now();
      var state = skLedgerSkuState_(ledger.events, s, cutoff);
      var avail = skAvailableAfterMovement_(
        rows[j][SK_COL.QTY - 1], state.movement, state.activeReserveAtCutoff
      );
      state.warnings.forEach(function (warning) {
        // Неоднозначность legacy RESTORED удерживает резерв, но не ломает остаток;
        // другие нарушения ledger обнуляют SKU до ручной сверки.
        if (warning.indexOf('LEGACY_RESTORED_HANDOFF_UNKNOWN:') === 0) return;
        avail = 0;
        var match = warning.match(/^(?:RELEASE_WITHOUT_RESERVE|SHIP_WITHOUT_RESERVE|RETURN_RESTOCK_WITHOUT_PENDING):(.+)$/);
        var eventId = match ? match[1] : '';
        var event = ledger.events.filter(function (candidate) { return candidate.eventId === eventId; })[0] || {};
        ledgerIssues.push({
          warning: warning, sku: s, orderId: event.orderId || '',
          lineId: event.lineId || '', code: event.code || '', eventType: event.eventType || ''
        });
      });
      out.push([
        state.activeReserve, avail,
        avail > 0 ? 'В наличии, доставка 0 дн.' : 'Предзаказ',
        state.movement
      ]);
    }
    if (SK_LEDGER_DRY_RUN_ONLY) {
      console.log('SKLAD_recalc DRY_RUN: рассчитано строк ' + out.length +
        ', проблем ledger ' + ledgerIssues.length + '; запись отключена. ' +
        'Подробный отчёт: запустите SKLAD_LEDGER_DRY_RUN_REPORT().');
      return;
    }
    skAppendLedgerErrorsOnce_(ledgerIssues);
    sh.getRange(2, SK_COL.RESERVED, n, 4).setValues(out);
  } finally {
    lock.releaseLock();
  }
}

/**
 * DRY_RUN без записи в листы: показывает, какие события после даты подсчёта
 * изменили бы доступность и к какому остатку это привело бы.
 */
function SKLAD_LEDGER_DRY_RUN_REPORT() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss && ss.getSheetByName(SK_SHEET);
  if (!sh || sh.getLastRow() < 2) throw new Error('Лист «' + SK_SHEET + '» пуст или отсутствует.');
  var ledger = skReadLedgerEvents_();
  if (ledger.problem) throw new Error(ledger.problem);
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues();
  var report = [];
  rows.forEach(function (row, index) {
    var sku = skNormSku_(row[SK_COL.SKU - 1]);
    if (!sku) return;
    var cutoff = row[SK_COL.COUNTED_AT - 1] instanceof Date
      ? row[SK_COL.COUNTED_AT - 1].getTime()
      : skParseDate_(row[SK_COL.COUNTED_AT - 1]);
    var missingCutoff = isNaN(cutoff);
    if (missingCutoff) cutoff = Date.now();
    var state = skLedgerSkuState_(ledger.events, sku, cutoff);
    var severeWarnings = state.warnings.filter(function (warning) {
      return warning.indexOf('LEGACY_RESTORED_HANDOFF_UNKNOWN:') !== 0;
    });
    report.push({
      sheetRow: index + 2, sku: sku, baselineQty: Number(row[SK_COL.QTY - 1]) || 0,
      countedAt: missingCutoff ? '' : new Date(cutoff),
      movement: state.movement,
      availableWouldBe: severeWarnings.length ? 0 :
        skAvailableAfterMovement_(
          row[SK_COL.QTY - 1], state.movement, state.activeReserveAtCutoff
        ),
      activeReserveNow: state.activeReserve,
      activeReserveAtCount: state.activeReserveAtCutoff,
      baselineWarning: state.activeReserveAtCutoff > 0
        ? 'На дату подсчёта был активный резерв; он вычтен из физического количества C.'
        : '',
      missingCountDate: missingCutoff,
      ledgerWarnings: state.warnings,
      events: state.applied.map(function (item) {
        return {
          eventId: item.event.eventId, eventType: item.event.eventType,
          orderId: item.event.orderId, lineId: item.event.lineId,
          eventAt: item.event.eventAtMs ? new Date(item.event.eventAtMs) : '',
          delta: item.delta
        };
      })
    });
  });
  var summary = {
    mode: 'DRY_RUN_NO_WRITES',
    rows: report.length,
    deductionEvents: report.reduce(function (n, row) {
      return n + row.events.filter(function (e) { return e.delta < 0; }).length;
    }, 0),
    returnEvents: report.reduce(function (n, row) {
      return n + row.events.filter(function (e) { return e.delta > 0; }).length;
    }, 0),
    rowsMissingCountDate: report.filter(function (row) { return row.missingCountDate; }).length,
    warningCount: report.reduce(function (n, row) { return n + row.ledgerWarnings.length; }, 0),
    products: report
  };
  console.log('SKLAD ledger DRY_RUN: ' + JSON.stringify(summary));
  return summary;
}

/**
 * Для сборки прайса: возвращает {артикул: доступное количество}.
 * Артикула нет в карте → доступно 0 → в прайсе ставьте предзаказ.
 */
function SKLAD_getAvailableMap() {
  // Пустая карта заставляет сборщик XML остановиться и сохранить последний рабочий файл.
  if (SK_LEDGER_DRY_RUN_ONLY) return {};
  var sh = SpreadsheetApp.getActive().getSheetByName(SK_SHEET);
  var map = {};
  if (!sh || sh.getLastRow() < 2) return map;
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, SK_COL.AVAILABLE).getValues();
  vals.forEach(function (r) {
    var sku = skNormSku_(r[SK_COL.SKU - 1]);
    var a = Number(r[SK_COL.AVAILABLE - 1]);
    if (sku && isFinite(a) && a > 0) map[sku] = Math.floor(a);
  });
  return map;
}

/** Проверка данных склада и активных резервов ledger без пары в складе. */
function SKLAD_check() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SK_SHEET);
  var lastRow = sh ? sh.getLastRow() : 0;
  var vals = sh && lastRow >= 2 ? sh.getRange(2, 1, lastRow - 1, 3).getValues() : [];
  var seen = {}, problems = [];
  if (!sh || lastRow < 2) problems.push('Лист «' + SK_SHEET + '» пуст или отсутствует.');
  vals.forEach(function (r, i) {
    var sku = skNormSku_(r[0]);
    var line = i + 2;
    if (!sku) { if (r[2] !== '') problems.push('Строка ' + line + ': есть количество, но нет артикула'); return; }
    var skuKey = sku.toUpperCase();
    if (seen[skuKey]) problems.push('Строка ' + line + ': артикул ' + sku + ' повторяется (первый раз в строке ' + seen[skuKey] + ')');
    else seen[skuKey] = line;
    var q = Number(r[2]);
    if (r[2] === '' || !isFinite(q) || q < 0 || q !== Math.floor(q)) problems.push('Строка ' + line + ': количество должно быть целым числом ≥ 0');
  });
  var ledger = skReadLedgerEvents_();
  if (ledger.problem) problems.push(ledger.problem);
  else {
    skLedgerWarningsAll_(ledger.events).forEach(function (item) {
      problems.push(item.sku + ': проверка ledger — ' + item.warning);
    });
    var unmapped = skUnmappedLedgerReserves_(ledger.events, seen);
    if (unmapped.length) {
      problems.push('SKU с активным резервом без строки в «' + SK_SHEET + '»: ' + unmapped.length + '.');
      unmapped.forEach(function (item) {
        problems.push(item.sku + ': активный резерв ' + item.qty + ' шт.');
      });
    }
  }
  var report = problems.length ? problems.join('\n') : 'Проблем не найдено.';
  console.log('SKLAD_check:\n' + report);
  // Полный список остаётся доступен в журнале даже при большом числе SKU.
  SpreadsheetApp.getUi().alert(report.length > 9000 ?
    report.slice(0, 9000) + '\n…Полный список: журнал исполнения.' : report);
}

/**
 * ИНСТРУКЦИЯ
 * 1. Сначала добавьте файл только в копию проекта и запустите SKLAD_LEDGER_DRY_RUN_REPORT.
 * 2. Не запускайте SKLAD_setup и не публикуйте XML до проверки отчёта.
 * 3. После проверки настройте канонический KL_ORDERS_RUN и только затем осознанно
 *    снимите SK_LEDGER_DRY_RUN_ONLY; KL_CUTOVER_READY здесь не меняется.
 * 4. В СКЛАД_НАЛИЧИЕ заполните A — артикул, C — физический остаток на момент подсчёта;
 *    D — дата этого подсчёта. После даты применяются события из _KASPI_ORDER_EVENTS.
 * 5. Изменили C — дата D обновится сама. Пересчёт доступности отображается в F.
 * 6. Прайс должен брать наличие из SKLAD_getAvailableMap(): есть в карте → доставка 0 дней,
 *    нет → предзаказ (срок из колонки Q, иначе 2 дня).
 */
