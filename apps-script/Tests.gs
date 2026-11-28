/**
 * Pure-тесты state machine. Их можно запускать из редактора Apps Script через
 * KL_RUN_TESTS(), а также загрузить вместе со StateMachine.gs в Node/vm.
 */

function klTestSnapshot_(orderId, lineId, sku, qty, status, extra) {
  var snapshot = {
    orderId: orderId,
    lineId: lineId,
    code: 'K-' + orderId,
    sku: sku,
    qty: qty,
    state: '',
    status: status,
    eventAt: '2026-11-06T00:00:00.000Z',
    source: 'PURE_TEST'
  };
  Object.keys(extra || {}).forEach(function (key) { snapshot[key] = extra[key]; });
  return snapshot;
}

function klTestPlan_(ledger, snapshot, ctx) {
  return klPlanLineSnapshot_(klFoldLineState_(ledger), snapshot, ctx || {});
}

function klTestAppend_(ledger, plan) {
  for (var i = 0; i < plan.events.length; i++) ledger.push(plan.events[i]);
  return plan;
}

function klTestPlanAndAppend_(ledger, snapshot, ctx) {
  return klTestAppend_(ledger, klTestPlan_(ledger, snapshot, ctx));
}

function klTestJson_(value) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return String(value);
  }
}

function klTestAssert_(condition, message, details) {
  if (!condition) {
    throw new Error(message + (details === undefined ? '' : ': ' + klTestJson_(details)));
  }
}

function klTestAssertEqual_(actual, expected, message) {
  klTestAssert_(actual === expected, message, { expected: expected, actual: actual });
}

function klTestAssertArrayEqual_(actual, expected, message) {
  klTestAssertEqual_(klTestJson_(actual), klTestJson_(expected), message);
}

function klTestEventTypes_(plan) {
  return plan.events.map(function (event) { return event.eventType; });
}

function klTestAvailable_(baseline, ledger) {
  return baseline + klFoldLineState_(ledger).stockDelta;
}

function klTestCountType_(ledger, eventType) {
  return ledger.filter(function (event) { return event.eventType === eventType; }).length;
}

/** 1. Последняя единица резервируется без ошибки и даёт available=0. */
function klTestLastUnit_() {
  var ledger = [];
  var plan = klTestPlanAndAppend_(
    ledger,
    klTestSnapshot_('O1', 'L1', 'SKU-1', 1, 'APPROVED_BY_BANK')
  );
  var state = klFoldLineState_(ledger);
  klTestAssertArrayEqual_(klTestEventTypes_(plan), ['RESERVE'], 'Должен быть один RESERVE');
  klTestAssertEqual_(klTestAvailable_(1, ledger), 0, 'Последнюю единицу можно зарезервировать');
  klTestAssertEqual_(state.openReserveQty, 1, 'preorder/open reserve должен быть равен 1');
  klTestAssertEqual_(plan.events[0].eventId, 'v2|O1|L1|RESERVE|1', 'ID события v2');
  return { available: 0, preorderQty: state.openReserveQty, eventId: plan.events[0].eventId };
}

/** 2. Отмена до передачи курьеру освобождает ровно открытый reserve. */
function klTestCancelBeforeHandoff_() {
  var ledger = [];
  klTestPlanAndAppend_(ledger, klTestSnapshot_('O2', 'L1', 'SKU-2', 1, 'ACCEPTED_BY_MERCHANT'));
  var plan = klTestPlanAndAppend_(ledger, klTestSnapshot_('O2', 'L1', 'SKU-2', 1, 'CANCELLED'));
  klTestAssertArrayEqual_(klTestEventTypes_(plan), ['RELEASE'], 'До handoff нужен RELEASE');
  klTestAssertEqual_(plan.events[0].qty, 1, 'Освобождается одна штука');
  klTestAssertEqual_(klTestAvailable_(1, ledger), 1, 'available возвращается к baseline');
  klTestAssertEqual_(klFoldLineState_(ledger).openReserveQty, 0, 'Открытого reserve не остаётся');
  return { stockDelta: klFoldLineState_(ledger).stockDelta, decision: plan.decision };
}

/** 3. Три одинаковых snapshot создают только один RESERVE. */
function klTestReserveReplay_() {
  var ledger = [];
  var snapshot = klTestSnapshot_('O3', 'L1', 'SKU-3', 1, 'APPROVED_BY_BANK');
  for (var i = 0; i < 3; i++) klTestPlanAndAppend_(ledger, snapshot);
  klTestAssertEqual_(klTestCountType_(ledger, 'RESERVE'), 1, 'Replay не дублирует reserve');

  var duplicateFold = klFoldLineState_([ledger[0], ledger[0], ledger[0]]);
  klTestAssertEqual_(duplicateFold.reservedQty, 1, 'Fold дедуплицирует один event_id');
  klTestAssertEqual_(duplicateFold.eventCount, 1, 'Дубль не увеличивает eventCount');
  return { ledgerEvents: ledger.length, foldedEvents: duplicateFold.eventCount };
}

/** 4. Два CANCELLED snapshot создают только один RELEASE. */
function klTestReleaseReplay_() {
  var ledger = [];
  var active = klTestSnapshot_('O4', 'L1', 'SKU-4', 1, 'ACCEPTED_BY_MERCHANT');
  var cancelled = klTestSnapshot_('O4', 'L1', 'SKU-4', 1, 'CANCELLED');
  klTestPlanAndAppend_(ledger, active);
  klTestPlanAndAppend_(ledger, cancelled);
  var replay = klTestPlanAndAppend_(ledger, cancelled);
  klTestAssertEqual_(klTestCountType_(ledger, 'RELEASE'), 1, 'Replay не дублирует release');
  klTestAssertEqual_(replay.events.length, 0, 'Повторная отмена уже выровнена');
  klTestAssertEqual_(klTestAvailable_(1, ledger), 1, 'Stock не увеличен повторно');
  return { ledgerEvents: ledger.length, replayDecision: replay.decision };
}

/** 5. Crash после append: fold видит pending event до commit-marker. */
function klTestCrashReplay_() {
  var ledger = [];
  var snapshot = klTestSnapshot_('O5', 'L1', 'SKU-5', 1, 'APPROVED_BY_BANK');
  var first = klTestPlan_(ledger, snapshot);
  klTestAppend_(ledger, first); // append состоялся, проекция ещё старая
  var staleProjection = 1;

  var retry = klTestPlan_(ledger, snapshot);
  var absoluteTarget = 1 + retry.nextState.stockDelta;
  klTestAssertEqual_(retry.events.length, 0, 'Retry не добавляет второй RESERVE');
  klTestAssertEqual_(staleProjection, 1, 'Симулируется старая проекция после crash');
  klTestAssertEqual_(absoluteTarget, 0, 'Retry восстанавливает абсолютную проекцию');
  klTestAssertEqual_(ledger.length, 1, 'Ledger остаётся append-only без дубля');
  return { beforeProjection: staleProjection, recoveredTarget: absoluteTarget, ledgerEvents: ledger.length };
}

/** 6. После ship отмена только ставит pending; склад растёт после подтверждения. */
function klTestCancelAfterShip_() {
  var ledger = [];
  var active = klTestSnapshot_('O6', 'L1', 'SKU-6', 1, 'ACCEPTED_BY_MERCHANT');
  var completed = klTestSnapshot_('O6', 'L1', 'SKU-6', 1, 'COMPLETED', {
    courierTransmissionMs: 1000
  });
  klTestPlanAndAppend_(ledger, active);
  klTestPlanAndAppend_(ledger, completed);

  var cancelled = klTestSnapshot_('O6', 'L1', 'SKU-6', 1, 'CANCELLED', {
    courierTransmissionMs: 1000
  });
  var pending = klTestPlanAndAppend_(ledger, cancelled);
  klTestAssertArrayEqual_(klTestEventTypes_(pending), ['RETURN_PENDING'], 'Отмена после ship ждёт возврат');
  klTestAssertEqual_(pending.stockDelta, 0, 'RETURN_PENDING не меняет stock');
  klTestAssertEqual_(klTestAvailable_(1, ledger), 0, 'До подтверждения available остаётся 0');

  // Kaspi называет пункт приёма warehouse, но это ещё не полка продавца.
  cancelled.returnedToWarehouse = '2026-11-06T02:00:00.000Z';
  var transit = klTestPlan_(ledger, cancelled, { returnedToWarehouse: true });
  klTestAssertEqual_(transit.events.length, 0, 'returnedToWarehouse не подтверждает restock');
  klTestAssertEqual_(transit.returnConfirmed, false, 'Нужен явный ручной флаг');

  var confirmed = klTestPlanAndAppend_(ledger, cancelled, { manualReturnConfirmed: true });
  klTestAssertArrayEqual_(klTestEventTypes_(confirmed), ['RETURN_RESTOCK'], 'Подтверждение создаёт restock');
  klTestAssertEqual_(confirmed.stockDelta, 1, 'Подтверждённый возврат даёт +1');
  klTestAssertEqual_(klTestAvailable_(1, ledger), 1, 'После restock available=1');
  return {
    pendingDelta: pending.stockDelta,
    kaspiWarehouseDelta: transit.stockDelta,
    confirmedDelta: confirmed.stockDelta
  };
}

/** 7. Частичное изменение одной строки не затрагивает соседнюю строку. */
function klTestPartialMultiLine_() {
  var lineOne = [];
  var lineTwo = [];
  klTestPlanAndAppend_(lineOne, klTestSnapshot_('O7', 'L1', 'SKU-A', 3, 'APPROVED_BY_BANK'));
  klTestPlanAndAppend_(lineTwo, klTestSnapshot_('O7', 'L2', 'SKU-B', 2, 'APPROVED_BY_BANK'));

  var partial = klTestPlanAndAppend_(
    lineOne,
    klTestSnapshot_('O7', 'L1', 'SKU-A', 1, 'ACCEPTED_BY_MERCHANT')
  );
  var neighbour = klTestPlan_(
    lineTwo,
    klTestSnapshot_('O7', 'L2', 'SKU-B', 2, 'ACCEPTED_BY_MERCHANT')
  );
  klTestAssertArrayEqual_(klTestEventTypes_(partial), ['RELEASE'], 'Уменьшение 3→1 освобождает две штуки');
  klTestAssertEqual_(partial.events[0].qty, 2, 'Частичный RELEASE равен 2');
  klTestAssertEqual_(neighbour.events.length, 0, 'Соседняя строка уже выровнена');
  klTestAssertEqual_(klFoldLineState_(lineOne).openReserveQty, 1, 'В L1 остаётся одна штука');
  klTestAssertEqual_(klFoldLineState_(lineTwo).openReserveQty, 2, 'В L2 остаются две штуки');

  var cancelRemainder = klTestPlanAndAppend_(
    lineOne,
    klTestSnapshot_('O7', 'L1', 'SKU-A', 1, 'CANCELLED')
  );
  klTestAssertEqual_(cancelRemainder.events[0].qty, 1, 'Финальная отмена освобождает только остаток L1');
  klTestAssertEqual_(klFoldLineState_(lineTwo).openReserveQty, 2, 'L2 после отмены L1 не изменилась');
  return { lineOneOpen: 0, lineTwoOpen: 2, partialRelease: partial.events[0].qty };
}

/** 8. Ошибка SKU локальна строке и не останавливает batch. */
function klTestMissingSkuIsolation_() {
  var bad = klTestPlan_(
    [],
    klTestSnapshot_('O8', 'L-BAD', '', 1, 'APPROVED_BY_BANK')
  );
  var good = klTestPlan_(
    [],
    klTestSnapshot_('O8', 'L-GOOD', 'SKU-GOOD', 1, 'APPROVED_BY_BANK')
  );
  klTestAssert_(bad.errors.indexOf('MISSING_SKU') >= 0, 'Нужна ошибка MISSING_SKU');
  klTestAssertEqual_(bad.events.length, 0, 'Плохая строка не создаёт events');
  klTestAssertArrayEqual_(klTestEventTypes_(good), ['RESERVE'], 'Следующая строка продолжает обрабатываться');
  return { badErrors: bad.errors, goodEvents: klTestEventTypes_(good) };
}

function klTestMakeLock_() {
  var held = false;
  return {
    tryLock: function () {
      if (held) return false;
      held = true;
      return true;
    },
    releaseLock: function () { held = false; },
    isHeld: function () { return held; }
  };
}

function klTestRunWithLock_(lock, work) {
  if (!lock.tryLock(1)) return { status: 'LOCK_BUSY', value: null };
  try {
    return { status: 'OK', value: work() };
  } finally {
    lock.releaseLock();
  }
}

/** 9. Интеграционная simulation: второй запуск делает bounded skip под lock. */
function klTestConcurrentLockSimulation_() {
  var lock = klTestMakeLock_();
  var ledger = [];
  var snapshot = klTestSnapshot_('O9', 'L1', 'SKU-9', 1, 'APPROVED_BY_BANK');
  klTestAssert_(lock.tryLock(1), 'Первый запуск должен взять lock');

  var second = klTestRunWithLock_(lock, function () {
    return klTestPlanAndAppend_(ledger, snapshot);
  });
  klTestAssertEqual_(second.status, 'LOCK_BUSY', 'Второй запуск ждёт/пропускает bounded lock');
  klTestAssertEqual_(ledger.length, 0, 'До lock нельзя читать/планировать/писать');
  lock.releaseLock();

  var next = klTestRunWithLock_(lock, function () {
    return klTestPlanAndAppend_(ledger, snapshot);
  });
  klTestAssertEqual_(next.status, 'OK', 'После освобождения следующий запуск проходит');
  klTestAssertEqual_(ledger.length, 1, 'Создан ровно один RESERVE');
  return { concurrentAttempt: second.status, nextAttempt: next.status, ledgerEvents: ledger.length };
}

/** 10. CANCELLING удерживает reserve до окончательного CANCELLED. */
function klTestCancellingHold_() {
  var ledger = [];
  klTestPlanAndAppend_(ledger, klTestSnapshot_('O10', 'L1', 'SKU-10', 1, 'APPROVED_BY_BANK'));
  var hold = klTestPlanAndAppend_(ledger, klTestSnapshot_('O10', 'L1', 'SKU-10', 1, 'CANCELLING'));
  klTestAssertEqual_(hold.events.length, 0, 'CANCELLING не освобождает reserve');
  klTestAssertEqual_(klTestAvailable_(1, ledger), 0, 'available остаётся 0 во время CANCELLING');
  var cancel = klTestPlanAndAppend_(ledger, klTestSnapshot_('O10', 'L1', 'SKU-10', 1, 'CANCELLED'));
  klTestAssertArrayEqual_(klTestEventTypes_(cancel), ['RELEASE'], 'Только CANCELLED освобождает reserve');
  klTestAssertEqual_(klTestAvailable_(1, ledger), 1, 'После CANCELLED available восстановлен');
  return { holdDecision: hold.decision, finalDecision: cancel.decision };
}

/** 11. Первый увиденный CANCELLED не увеличивает stock. */
function klTestFirstSeenCancelled_() {
  var ledger = [];
  var snapshot = klTestSnapshot_('O11', 'L1', 'SKU-11', 1, 'CANCELLED');
  var first = klTestPlanAndAppend_(ledger, snapshot);
  var replay = klTestPlanAndAppend_(ledger, snapshot);
  klTestAssertArrayEqual_(klTestEventTypes_(first), ['CANCEL_NO_RESERVE'], 'Нужен audit marker');
  klTestAssertEqual_(first.stockDelta, 0, 'Marker не меняет склад');
  klTestAssertEqual_(klTestAvailable_(1, ledger), 1, 'Первичная отмена не добавляет товар');
  klTestAssertEqual_(replay.events.length, 0, 'Marker идемпотентен');
  return { eventId: first.events[0].eventId, stockDelta: first.stockDelta };
}

/** Дополнительно: последовательные частичные RELEASE имеют cumulative ID 2 и 4. */
function klTestPartialMultiRelease_() {
  var ledger = [];
  klTestPlanAndAppend_(ledger, klTestSnapshot_('O12', 'L1', 'SKU-12', 5, 'APPROVED_BY_BANK'));
  var first = klTestPlanAndAppend_(ledger, klTestSnapshot_('O12', 'L1', 'SKU-12', 3, 'ACCEPTED_BY_MERCHANT'));
  var second = klTestPlanAndAppend_(ledger, klTestSnapshot_('O12', 'L1', 'SKU-12', 1, 'ACCEPTED_BY_MERCHANT'));
  var replay = klTestPlan_(ledger, klTestSnapshot_('O12', 'L1', 'SKU-12', 1, 'ACCEPTED_BY_MERCHANT'));
  klTestAssertEqual_(first.events[0].qty, 2, 'Первый partial RELEASE=2');
  klTestAssertEqual_(second.events[0].qty, 2, 'Второй partial RELEASE=2');
  klTestAssertEqual_(first.events[0].eventId, 'v2|O12|L1|RELEASE|2', 'Первый cumulativeAfter=2');
  klTestAssertEqual_(second.events[0].eventId, 'v2|O12|L1|RELEASE|4', 'Второй cumulativeAfter=4');
  klTestAssertEqual_(replay.events.length, 0, 'Последний partial snapshot идемпотентен');
  klTestAssertEqual_(klFoldLineState_(ledger).openReserveQty, 1, 'Осталась одна зарезервированная штука');
  return { releaseIds: [first.events[0].eventId, second.events[0].eventId] };
}

/** Дополнительно: return-статусы точны и ждут физического подтверждения. */
function klTestReturnStatuses_() {
  var ledger = [];
  klTestPlanAndAppend_(ledger, klTestSnapshot_('O13', 'L1', 'SKU-13', 1, 'APPROVED_BY_BANK'));
  klTestPlanAndAppend_(ledger, klTestSnapshot_('O13', 'L1', 'SKU-13', 1, 'COMPLETED', {
    courierTransmissionDate: '2026-11-06T01:00:00.000Z'
  }));
  var requested = klTestPlanAndAppend_(
    ledger,
    klTestSnapshot_('O13', 'L1', 'SKU-13', 1, 'KASPI_DELIVERY_RETURN_REQUESTED', {
      courierTransmissionDate: '2026-11-06T01:00:00.000Z'
    })
  );
  var returned = klTestPlan_(
    ledger,
    klTestSnapshot_('O13', 'L1', 'SKU-13', 1, 'RETURNED', {
      courierTransmissionDate: '2026-11-06T01:00:00.000Z'
    })
  );
  var unsupported = klTestPlan_(
    [],
    klTestSnapshot_('O13X', 'L1', 'SKU-X', 1, 'ALMOST_RETURNED')
  );
  klTestAssertArrayEqual_(klTestEventTypes_(requested), ['RETURN_PENDING'], 'Requested создаёт pending');
  klTestAssertEqual_(returned.events.length, 0, 'RETURNED без warehouse confirmation остаётся pending');
  klTestAssertEqual_(unsupported.decision, 'UNSUPPORTED_STATUS', 'Fuzzy status не распознаётся');
  return { requested: requested.decision, returned: returned.decision, fuzzy: unsupported.decision };
}

/** Дополнительно: разделители в ID экранируются и не дают коллизий. */
function klTestEventIdEscaping_() {
  var escaped = klMakeDeterministicEventId_('A|B', 'Линия 1', 'reserve', 2);
  var plain = klMakeDeterministicEventId_('A', 'B|Линия 1', 'RESERVE', 2);
  klTestAssert_(escaped.indexOf('v2|A%7CB|') === 0, 'Pipe должен быть escaped');
  klTestAssert_(escaped !== plain, 'Разные пары ID не должны коллидировать');
  return { escaped: escaped, other: plain };
}

/** Дополнительно: courierTransmissionDate превращает active reserve в SHIP. */
function klTestActiveCourierHandoff_() {
  var ledger = [];
  klTestPlanAndAppend_(
    ledger,
    klTestSnapshot_('O15', 'L1', 'SKU-15', 1, 'ACCEPTED_BY_MERCHANT')
  );
  var handoff = klTestPlanAndAppend_(
    ledger,
    klTestSnapshot_('O15', 'L1', 'SKU-15', 1, 'ACCEPTED_BY_MERCHANT', {
      courierTransmissionDate: '2026-11-06T03:00:00.000Z'
    })
  );
  klTestAssertArrayEqual_(klTestEventTypes_(handoff), ['SHIP'], 'Handoff должен создать SHIP');
  klTestAssertEqual_(klFoldLineState_(ledger).openReserveQty, 0, 'SHIP снимает reserve');
  klTestAssertEqual_(klTestAvailable_(1, ledger), 0, 'SHIP не возвращает available');
  return {decision: handoff.decision, stockDelta: handoff.stockDelta};
}

/** Дополнительно: CANCELLING после handoff фиксирует SHIP, но не RELEASE. */
function klTestCancellingAfterHandoff_() {
  var ledger = [];
  klTestPlanAndAppend_(
    ledger,
    klTestSnapshot_('O16', 'L1', 'SKU-16', 1, 'ACCEPTED_BY_MERCHANT')
  );
  var cancelling = klTestPlanAndAppend_(
    ledger,
    klTestSnapshot_('O16', 'L1', 'SKU-16', 1, 'CANCELLING', {
      courierTransmissionMs: 1000
    })
  );
  klTestAssertArrayEqual_(klTestEventTypes_(cancelling), ['SHIP'], 'После handoff нужен SHIP');
  klTestAssertEqual_(klTestCountType_(ledger, 'RELEASE'), 0, 'CANCELLING не создаёт RELEASE');
  klTestAssertEqual_(klTestCountType_(ledger, 'RETURN_PENDING'), 0, 'Pending ждёт CANCELLED');
  return {decision: cancelling.decision};
}

/** Дополнительно: snapshot qty целое >=0, а event qty целое >0. */
function klTestQuantityValidation_() {
  var negative = klTestPlan_(
    [],
    klTestSnapshot_('O17', 'L-NEG', 'SKU-17', -1, 'APPROVED_BY_BANK')
  );
  var fractional = klTestPlan_(
    [],
    klTestSnapshot_('O17', 'L-FRAC', 'SKU-17', 1.5, 'APPROVED_BY_BANK')
  );
  klTestAssert_(negative.errors.indexOf('INVALID_QTY') >= 0, 'Отрицательный qty запрещён');
  klTestAssert_(fractional.errors.indexOf('INVALID_QTY') >= 0, 'Дробный qty запрещён');
  klTestAssertEqual_(negative.events.length + fractional.events.length, 0, 'Невалидный qty не создаёт events');

  var invalidFold = klFoldLineState_([{
    eventId: 'v2|O17|L1|RESERVE|1.5',
    eventType: 'RESERVE',
    qty: 1.5,
    cumulativeAfter: 1.5,
    orderId: 'O17',
    lineId: 'L1',
    sku: 'SKU-17'
  }]);
  klTestAssertEqual_(invalidFold.reservedQty, 0, 'Fold не применяет дробное событие');
  klTestAssert_(
    invalidFold.warnings[0].indexOf('INVALID_EVENT_QTY:') === 0,
    'Fold возвращает warning для event qty'
  );
  return {negative: negative.errors, fractional: fractional.errors, warnings: invalidFold.warnings};
}

/**
 * Node-совместимый runner: не использует Logger/SpreadsheetApp и всегда
 * возвращает подробный результат вместо остановки на первом падении.
 */
function klRunPureTests_() {
  var cases = [
    { name: '01_last_unit', run: klTestLastUnit_ },
    { name: '02_cancel_before_handoff', run: klTestCancelBeforeHandoff_ },
    { name: '03_reserve_replay_x3', run: klTestReserveReplay_ },
    { name: '04_release_replay_x2', run: klTestReleaseReplay_ },
    { name: '05_crash_append_before_projection', run: klTestCrashReplay_ },
    { name: '06_cancel_after_ship_and_confirm', run: klTestCancelAfterShip_ },
    { name: '07_partial_multi_line_qty', run: klTestPartialMultiLine_ },
    { name: '08_missing_sku_isolation', run: klTestMissingSkuIsolation_ },
    { name: '09_concurrent_lock_simulation', run: klTestConcurrentLockSimulation_ },
    { name: '10_cancelling_hold', run: klTestCancellingHold_ },
    { name: '11_first_seen_cancelled', run: klTestFirstSeenCancelled_ },
    { name: '12_partial_multi_release', run: klTestPartialMultiRelease_ },
    { name: '13_exact_return_statuses', run: klTestReturnStatuses_ },
    { name: '14_event_id_escaping', run: klTestEventIdEscaping_ },
    { name: '15_active_courier_handoff', run: klTestActiveCourierHandoff_ },
    { name: '16_cancelling_after_handoff', run: klTestCancellingAfterHandoff_ },
    { name: '17_quantity_validation', run: klTestQuantityValidation_ }
  ];
  var startedAt = Date.now();
  var results = [];
  var passedCount = 0;

  for (var i = 0; i < cases.length; i++) {
    var testStartedAt = Date.now();
    try {
      var details = cases[i].run();
      results.push({
        name: cases[i].name,
        passed: true,
        durationMs: Date.now() - testStartedAt,
        details: details || {}
      });
      passedCount++;
    } catch (error) {
      results.push({
        name: cases[i].name,
        passed: false,
        durationMs: Date.now() - testStartedAt,
        error: error && error.message ? error.message : String(error),
        stack: error && error.stack ? String(error.stack) : ''
      });
    }
  }

  return {
    passed: passedCount === cases.length,
    total: cases.length,
    passedCount: passedCount,
    failedCount: cases.length - passedCount,
    durationMs: Date.now() - startedAt,
    tests: results
  };
}

/** Ручная точка входа для редактора Google Apps Script. */
function KL_RUN_TESTS() {
  var result = klRunPureTests_();
  if (typeof Logger !== 'undefined' && Logger && typeof Logger.log === 'function') {
    Logger.log(JSON.stringify(result, null, 2));
  }
  if (!result.passed) {
    throw new Error('KL pure tests failed: ' + result.failedCount + '/' + result.total);
  }
  return result;
}
