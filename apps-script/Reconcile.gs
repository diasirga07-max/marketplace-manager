/** Ежедневная сверка, резервное копирование и ручное подтверждение возврата. */

var KL_RECONCILE = Object.freeze({
  REPORT_SHEET: '_KASPI_RECONCILE',
  RETURN_SHEET: '_KASPI_RETURN_TASKS',
  WAREHOUSE_SHEET: 'мой склад',
  REPORT_HEADERS: Object.freeze([
    'Checked at', 'Type', 'SKU', 'Order ID', 'Line ID', 'Ledger qty',
    'Warehouse qty', 'Delta', 'Severity', 'Details'
  ]),
  RETURN_HEADERS: Object.freeze([
    'Task ID', 'Order ID', 'Line ID', 'SKU', 'Qty pending', 'Created at',
    'Status', 'Confirmed qty', 'Confirmed at', 'Details'
  ]),
  EVENTS_WIDTH: 18,
  STALE_ORDER_DAYS: 7,
  STALE_RETURN_DAYS: 3
});

function klReconcileEnsureSheet_(name, headers) {
  var ss = klStockSs_();
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getMaxColumns() < headers.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
  }
  var current = sheet.getRange(1, 1, 1, headers.length).getDisplayValues()[0];
  var next = current.slice();
  for (var i = 0; i < headers.length; i++) {
    if (!klStockText_(next[i])) next[i] = headers[i];
  }
  sheet.getRange(1, 1, 1, headers.length).setValues([next]);
  sheet.setFrozenRows(1);
  return sheet;
}

function klAppendReconcileRows_(rows, dryRun) {
  if (dryRun || !rows.length) return rows;
  var sheet = klReconcileEnsureSheet_(
    KL_RECONCILE.REPORT_SHEET, KL_RECONCILE.REPORT_HEADERS
  );
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length)
    .setValues(rows);
  return rows;
}

/** Идемпотентно поддерживает лист задач по открытым возвратам из ledger. */
function klSyncReturnTasks_(dryRun) {
  var byLine = klCanonicalEventsByLine_();
  var sheet = klStockSs_().getSheetByName(KL_RECONCILE.RETURN_SHEET);
  var summary = {open: 0, appended: 0, updated: 0, dryRun: Boolean(dryRun)};
  var plans = [];
  Object.keys(byLine).forEach(function (key) {
    var events = byLine[key];
    var totals = klLineTotals_(events);
    var first = events[0];
    if (!totals.pending && !totals.restock) return;
    var eligible = totals.returnEligible;
    if (eligible > 0) summary.open++;
    var confirmedAtMs = 0;
    events.forEach(function (event) {
      if (event.eventType === 'RETURN_RESTOCK') {
        confirmedAtMs = Math.max(confirmedAtMs, event.eventAtMs || 0);
      }
    });
    plans.push({
      taskId: first.orderId + '|' + first.lineId,
      orderId: first.orderId,
      lineId: first.lineId,
      sku: first.sku,
      pending: eligible,
      createdAt: totals.oldestPendingMs ? new Date(totals.oldestPendingMs) : new Date(),
      status: eligible > 0 ? 'Ожидает подтверждения' : 'Товар принят на склад',
      confirmedQty: totals.restock,
      confirmedAt: confirmedAtMs ? new Date(confirmedAtMs) : '',
      details: eligible > 0
        ? 'Подтвердите фактическую приёмку и запустите KL_CONFIRM_RETURN_RESTOCK.'
        : 'Закрыто по событиям RETURN_RESTOCK в ledger.'
    });
  });
  if (dryRun) return summary;

  sheet = sheet || klReconcileEnsureSheet_(
    KL_RECONCILE.RETURN_SHEET, KL_RECONCILE.RETURN_HEADERS
  );
  var existing = Object.create(null);
  var last = sheet.getLastRow();
  if (last > 1) {
    var rows = sheet.getRange(2, 1, last - 1, KL_RECONCILE.RETURN_HEADERS.length).getValues();
    for (var i = 0; i < rows.length; i++) {
      var taskId = klStockText_(rows[i][0]);
      if (taskId) existing[taskId] = {rowNumber: i + 2, values: rows[i]};
    }
  }
  var appends = [];
  plans.forEach(function (plan) {
    var current = existing[plan.taskId];
    var row = current ? current.values.slice() : [
      plan.taskId, plan.orderId, plan.lineId, plan.sku, plan.pending,
      plan.createdAt, plan.status, plan.confirmedQty, plan.confirmedAt, plan.details
    ];
    row[1] = plan.orderId;
    row[2] = plan.lineId;
    row[3] = plan.sku;
    row[4] = plan.pending;
    if (!row[5]) row[5] = plan.createdAt;
    row[6] = plan.status;
    row[7] = plan.confirmedQty;
    row[8] = plan.confirmedAt;
    row[9] = plan.details;
    if (current) {
      sheet.getRange(current.rowNumber, 1, 1, row.length).setValues([row]);
      summary.updated++;
    } else {
      appends.push(row);
    }
  });
  if (appends.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, appends.length, appends[0].length)
      .setValues(appends);
    summary.appended = appends.length;
  }
  return summary;
}

function klBackupWarehouseDaily_(dryRun) {
  var ss = klStockSs_();
  var source = ss.getSheetByName(KL_RECONCILE.WAREHOUSE_SHEET);
  if (!source) return {ok: false, reason: 'Лист «мой склад» не найден'};
  var date = Utilities.formatDate(new Date(), KL_STOCK.TZ, 'yyyy-MM-dd');
  var name = '_BACKUP мой склад ' + date;
  if (ss.getSheetByName(name)) return {ok: true, skipped: true, name: name};
  if (dryRun) return {ok: true, dryRun: true, name: name};
  source.copyTo(ss).setName(name);
  return {ok: true, created: true, name: name};
}

function klLoadWarehouseIndex_() {
  var props = PropertiesService.getScriptProperties();
  var skuHeader = klStockText_(props.getProperty('KL_WAREHOUSE_SKU_HEADER'));
  var qtyHeader = klStockText_(props.getProperty('KL_WAREHOUSE_QTY_HEADER'));
  if (!skuHeader || !qtyHeader) {
    return {
      ok: false,
      error: 'Не заданы KL_WAREHOUSE_SKU_HEADER и KL_WAREHOUSE_QTY_HEADER'
    };
  }
  var sheet = klStockSs_().getSheetByName(KL_RECONCILE.WAREHOUSE_SHEET);
  if (!sheet || sheet.getLastRow() < 1) {
    return {ok: false, error: 'Лист «мой склад» пуст или отсутствует'};
  }
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  var skuCol = headers.indexOf(skuHeader);
  var qtyCol = headers.indexOf(qtyHeader);
  if (skuCol < 0 || qtyCol < 0) {
    return {
      ok: false,
      error: 'На листе «мой склад» нет подтверждённых заголовков: ' +
        skuHeader + ' / ' + qtyHeader
    };
  }
  var index = Object.create(null);
  if (sheet.getLastRow() > 1) {
    var rows = sheet.getRange(
      2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()
    ).getValues();
    for (var i = 0; i < rows.length; i++) {
      var sku = klStockSku_(rows[i][skuCol]);
      if (!sku) continue;
      index[sku] = (index[sku] || 0) + Math.max(0, klStockNum_(rows[i][qtyCol], 0));
    }
  }
  return {ok: true, bySku: index};
}

function klReconcilePhysical_(checkedAt) {
  var warehouse = klLoadWarehouseIndex_();
  if (!warehouse.ok) {
    return [[
      checkedAt, 'WAREHOUSE_SCHEMA', '', '', '', '', '', '', 'ERROR',
      warehouse.error
    ]];
  }
  var stock = klLoadStockRows_();
  var eventsBySku = klLoadCanonicalStockEvents_();
  var rows = [];
  Object.keys(stock.bySku).forEach(function (sku) {
    var stateRow = stock.bySku[sku].values;
    var opening = stateRow[7];
    if (opening === '' || opening === null || opening === undefined) {
      rows.push([
        checkedAt, 'NO_OPENING', sku, '', '', '', warehouse.bySku[sku], '',
        'ERROR', 'Не зафиксирован Opening physical'
      ]);
      return;
    }
    var projection = klProjectSku_(opening, eventsBySku[sku] || []);
    var actual = Object.prototype.hasOwnProperty.call(warehouse.bySku, sku)
      ? warehouse.bySku[sku] : '';
    var delta = actual === '' ? '' : actual - projection.physical;
    if (actual === '' || delta !== 0 || projection.errors.length) {
      rows.push([
        checkedAt, 'PHYSICAL', sku, '', '', projection.physical, actual, delta,
        projection.errors.length || actual === '' ? 'ERROR' : 'WARN',
        projection.errors.join('; ') || 'Расхождение не исправлено автоматически'
      ]);
    }
  });
  return rows;
}

function klCanonicalEventsByLine_() {
  var sheet = klStockSs_().getSheetByName(KL_STOCK.EVENTS_SHEET);
  var byLine = Object.create(null);
  if (!sheet || sheet.getLastRow() < 2 || sheet.getLastColumn() < 18) return byLine;
  var rows = sheet.getRange(
    2, 1, sheet.getLastRow() - 1, KL_RECONCILE.EVENTS_WIDTH
  ).getValues();
  for (var i = 0; i < rows.length; i++) {
    if (!klStockText_(rows[i][10])) continue;
    var orderId = klStockText_(rows[i][1]);
    var lineId = klStockText_(rows[i][5]);
    var key = orderId + '|' + lineId;
    if (!byLine[key]) byLine[key] = [];
    byLine[key].push({
      eventId: klStockText_(rows[i][10]),
      eventType: klStockText_(rows[i][11]).toUpperCase(),
      cumulativeAfter: klStockNum_(rows[i][12], 0),
      eventAtMs: klStockNum_(rows[i][13], 0),
      orderId: orderId,
      orderCode: klStockText_(rows[i][2]),
      creationMs: klStockNum_(rows[i][3], 0),
      status: klStockText_(rows[i][4]),
      lineId: lineId,
      sku: klStockSku_(rows[i][6]),
      qty: Math.max(0, klStockNum_(rows[i][7], 0)),
      source: klStockText_(rows[i][15]),
      details: klStockText_(rows[i][17])
    });
  }
  return byLine;
}

function klLineTotals_(events) {
  var totals = {
    reserve: 0, release: 0, ship: 0, pending: 0, restock: 0,
    oldestReserveMs: 0, oldestPendingMs: 0
  };
  var seen = Object.create(null);
  (events || []).forEach(function (event) {
    if (seen[event.eventId]) return;
    seen[event.eventId] = true;
    var qty = Math.max(0, klStockNum_(event.qty, 0));
    if (event.eventType === 'RESERVE') {
      totals.reserve += qty;
      if (!totals.oldestReserveMs || event.eventAtMs < totals.oldestReserveMs) {
        totals.oldestReserveMs = event.eventAtMs;
      }
    }
    if (event.eventType === 'RELEASE') totals.release += qty;
    if (event.eventType === 'SHIP') totals.ship += qty;
    if (event.eventType === 'RETURN_PENDING') {
      totals.pending += qty;
      if (!totals.oldestPendingMs || event.eventAtMs < totals.oldestPendingMs) {
        totals.oldestPendingMs = event.eventAtMs;
      }
    }
    if (event.eventType === 'RETURN_RESTOCK') totals.restock += qty;
  });
  totals.openReserve = Math.max(0, totals.reserve - totals.release - totals.ship);
  totals.returnEligible = Math.max(
    0, Math.min(totals.ship - totals.restock, totals.pending - totals.restock)
  );
  return totals;
}

function klBuildStaleRows_(checkedAt) {
  var nowMs = checkedAt.getTime();
  var byLine = klCanonicalEventsByLine_();
  var rows = [];
  Object.keys(byLine).forEach(function (key) {
    var events = byLine[key];
    var first = events[0];
    var totals = klLineTotals_(events);
    if (totals.openReserve > 0 && totals.oldestReserveMs &&
        nowMs - totals.oldestReserveMs > KL_RECONCILE.STALE_ORDER_DAYS * 86400000) {
      rows.push([
        checkedAt, 'STALE_RESERVE', first.sku, first.orderId, first.lineId,
        totals.openReserve, '', '', 'WARN',
        'Резерв старше ' + KL_RECONCILE.STALE_ORDER_DAYS + ' дней'
      ]);
    }
    if (totals.returnEligible > 0 && totals.oldestPendingMs &&
        nowMs - totals.oldestPendingMs > KL_RECONCILE.STALE_RETURN_DAYS * 86400000) {
      rows.push([
        checkedAt, 'STALE_RETURN', first.sku, first.orderId, first.lineId,
        totals.returnEligible, '', '', 'WARN',
        'Возврат ожидает приёмки больше ' + KL_RECONCILE.STALE_RETURN_DAYS + ' дней'
      ]);
    }
  });
  return rows;
}

function KL_RECONCILE_DAILY() {
  var dryRun = klIsDryRun_();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return {ok: false, skipped: 'LOCKED'};
  try {
    var checkedAt = new Date();
    var backup = klBackupWarehouseDaily_(dryRun);
    // Repair идёт до сверки: crash после append не должен оставлять проекцию
    // недоигранной до появления того же заказа в API.
    var repair = klMaterializeAffectedSkus_(
      Object.keys(klLoadCanonicalStockEvents_()), dryRun
    );
    var returnTasks = klSyncReturnTasks_(dryRun);
    var rows = klReconcilePhysical_(checkedAt).concat(klBuildStaleRows_(checkedAt));
    klAppendReconcileRows_(rows, dryRun);
    if (!dryRun) {
      if (rows.length) klNotifyIssues_(rows, 'Ежедневная сверка Kaspi');
      else klNotifySuccess_('Ежедневная сверка Kaspi: расхождений нет');
    }
    return {
      ok: rows.length === 0,
      dryRun: dryRun,
      backup: backup,
      repair: repair,
      returnTasks: returnTasks,
      issues: rows
    };
  } catch (error) {
    if (!dryRun) klNotifyFailure_(error, 'KL_RECONCILE_DAILY');
    throw error;
  } finally {
    lock.releaseLock();
  }
}

/** Принудительно восстанавливает материализованную проекцию после сбоя. */
function KL_REPAIR_PROJECTION() {
  var eventsBySku = klLoadCanonicalStockEvents_();
  return klMaterializeAffectedSkus_(Object.keys(eventsBySku), klIsDryRun_());
}

/**
 * Предпусковой аудит legacy snapshot. Ничего не исправляет и не мигрирует:
 * показывает, где Baseline - DEDUCTED не совпадает с Current stock.
 */
function KL_AUDIT_LEGACY_MIGRATION() {
  var ss = klStockSs_();
  var eventsSheet = ss.getSheetByName(KL_STOCK.EVENTS_SHEET);
  var stockSheet = ss.getSheetByName(KL_STOCK.STOCK_SHEET);
  var result = {ok: true, checkedRows: 0, issues: [], bySku: {}};
  if (!eventsSheet || !stockSheet) {
    return {
      ok: false,
      checkedRows: 0,
      issues: ['Нет _KASPI_ORDER_EVENTS или _KASPI_STOCK_STATE'],
      bySku: {}
    };
  }
  var seenKeys = Object.create(null);
  if (eventsSheet.getLastRow() > 1) {
    var width = Math.min(Math.max(eventsSheet.getLastColumn(), 10), 18);
    var rows = eventsSheet.getRange(
      2, 1, eventsSheet.getLastRow() - 1, width
    ).getValues();
    for (var i = 0; i < rows.length; i++) {
      // K заполнена — это уже V2, а не legacy snapshot.
      if (width >= 11 && klStockText_(rows[i][10])) continue;
      var key = klStockText_(rows[i][0]);
      var sku = klStockSku_(rows[i][6]);
      var qty = Math.max(0, klStockNum_(rows[i][7], 0));
      var action = klStockText_(rows[i][8]).toUpperCase();
      if (!key && !sku) continue;
      result.checkedRows++;
      if (key && seenKeys[key]) result.issues.push('Дубликат legacy Event key: ' + key);
      if (key) seenKeys[key] = true;
      if (!sku) {
        result.issues.push('Legacy строка ' + (i + 2) + ': пустой SKU');
        continue;
      }
      if (!result.bySku[sku]) result.bySku[sku] = {deducted: 0, restored: 0};
      if (action === 'DEDUCTED') result.bySku[sku].deducted += qty;
      else if (action === 'RESTORED') result.bySku[sku].restored += qty;
      else result.issues.push(
        'Legacy строка ' + (i + 2) + ': неизвестный Action ' + action
      );
    }
  }
  var stockRows = stockSheet.getLastRow() > 1
    ? stockSheet.getRange(2, 1, stockSheet.getLastRow() - 1, 7).getValues() : [];
  var stockBySku = Object.create(null);
  for (var s = 0; s < stockRows.length; s++) {
    var stockSku = klStockSku_(stockRows[s][0]);
    if (!stockSku) continue;
    stockBySku[stockSku] = {
      baseline: klStockNum_(stockRows[s][1], 0),
      current: klStockNum_(stockRows[s][2], 0)
    };
  }
  Object.keys(result.bySku).forEach(function (sku) {
    var stock = stockBySku[sku];
    if (!stock) {
      result.issues.push('Legacy SKU отсутствует в stock state: ' + sku);
      return;
    }
    var expected = stock.baseline - result.bySku[sku].deducted;
    result.bySku[sku].baseline = stock.baseline;
    result.bySku[sku].current = stock.current;
    result.bySku[sku].expectedSimple = expected;
    result.bySku[sku].matches = expected === stock.current;
    if (!result.bySku[sku].matches) {
      result.issues.push(
        sku + ': Baseline ' + stock.baseline + ' - DEDUCTED ' +
        result.bySku[sku].deducted + ' = ' + expected +
        ', но Current stock = ' + stock.current
      );
    }
  });
  result.ok = result.issues.length === 0;
  console.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * Единственная публичная точка возврата товара в физический остаток.
 * Remote RETURNED сам по себе эту функцию не вызывает.
 */
function KL_CONFIRM_RETURN_RESTOCK(orderId, lineId, qty) {
  var wantedOrder = klStockText_(orderId);
  var wantedLine = klStockText_(lineId);
  var wantedQty = Math.max(0, Math.floor(klStockNum_(qty, 0)));
  if (!wantedOrder || !wantedLine || !wantedQty) {
    throw new Error('Нужны orderId, lineId и положительное целое qty.');
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Другой цикл Kaspi уже выполняется.');
  try {
    var byLine = klCanonicalEventsByLine_();
    var events = byLine[wantedOrder + '|' + wantedLine] || [];
    if (!events.length) throw new Error('Позиция заказа отсутствует в ledger V2.');
    var totals = klLineTotals_(events);
    if (wantedQty > totals.returnEligible) {
      throw new Error(
        'Нельзя оприходовать ' + wantedQty + '; ожидает подтверждения ' +
        totals.returnEligible + '.'
      );
    }
    var first = events[0];
    var cumulativeAfter = totals.restock + wantedQty;
    var eventId;
    if (typeof klMakeDeterministicEventId_ === 'function') {
      eventId = klMakeDeterministicEventId_(
        wantedOrder, wantedLine, 'RETURN_RESTOCK', cumulativeAfter
      );
    } else {
      eventId = [
        'v2', wantedOrder, wantedLine, 'RETURN_RESTOCK', cumulativeAfter
      ].join('|');
    }
    for (var i = 0; i < events.length; i++) {
      if (events[i].eventId === eventId) {
        return {ok: true, duplicate: true, eventId: eventId};
      }
    }
    var plan = {
      eventId: eventId,
      orderId: wantedOrder,
      orderCode: first.orderCode,
      creationMs: first.creationMs,
      status: 'RETURN_CONFIRMED',
      lineId: wantedLine,
      sku: first.sku,
      qty: wantedQty,
      eventType: 'RETURN_RESTOCK',
      cumulativeAfter: cumulativeAfter,
      eventAtMs: Date.now(),
      source: 'MANUAL_CONFIRM',
      details: JSON.stringify({confirmedBy: Session.getActiveUser().getEmail() || ''})
    };
    if (klIsDryRun_()) return {ok: true, dryRun: true, event: plan};

    var sheet = klStockSs_().getSheetByName(KL_STOCK.EVENTS_SHEET);
    if (!sheet || sheet.getLastColumn() < 18) {
      throw new Error('Канонические колонки K:R ledger не установлены.');
    }
    sheet.getRange(sheet.getLastRow() + 1, 1, 1, 18).setValues([[
      plan.eventId, plan.orderId, plan.orderCode, plan.creationMs, plan.status,
      plan.lineId, plan.sku, plan.qty, 'RESTORED', new Date(), plan.eventId,
      plan.eventType, plan.cumulativeAfter, plan.eventAtMs, '', plan.source,
      'v2', plan.details
    ]]);
    SpreadsheetApp.flush(); // ledger — commit; projection можно безопасно повторить
    var projection = klMaterializeAffectedSkus_([plan.sku], false);
    var returnTasks = klSyncReturnTasks_(false);
    return {ok: true, eventId: eventId, projection: projection, returnTasks: returnTasks};
  } finally {
    lock.releaseLock();
  }
}

/** Меню подтверждения: пользователь подтверждает физическую приёмку товара. */
function KL_CONFIRM_RETURN_RESTOCK_PROMPT() {
  var ui = SpreadsheetApp.getUi();
  if (klIsDryRun_()) {
    ui.alert('Подтверждение недоступно',
      'Ledger работает в DRY_RUN. Боевые записи не включены.', ui.ButtonSet.OK);
    return;
  }
  var order = ui.prompt('Номер заказа', 'Введите Order ID из листа _KASPI_RETURN_TASKS.', ui.ButtonSet.OK_CANCEL);
  if (order.getSelectedButton() !== ui.Button.OK) return;
  var line = ui.prompt('Позиция заказа', 'Введите Line ID из листа _KASPI_RETURN_TASKS.', ui.ButtonSet.OK_CANCEL);
  if (line.getSelectedButton() !== ui.Button.OK) return;
  var quantity = ui.prompt('Принятое количество', 'Введите фактически принятое целое количество.', ui.ButtonSet.OK_CANCEL);
  if (quantity.getSelectedButton() !== ui.Button.OK) return;
  var result = KL_CONFIRM_RETURN_RESTOCK(
    String(order.getResponseText() || '').trim(),
    String(line.getResponseText() || '').trim(),
    Number(String(quantity.getResponseText() || '').trim())
  );
  ui.alert(result.ok
    ? 'Возврат записан в ledger. Остаток пересчитан.'
    : 'Возврат не записан. Проверьте журнал ошибок.');
}
