/**
 * Чистая state machine для строки заказа Kaspi.
 *
 * Файл намеренно не обращается к SpreadsheetApp, LockService, Utilities и
 * другим сервисам Apps Script. Один и тот же ledger поэтому можно безопасно
 * сворачивать и в GAS V8, и в локальных Node-тестах.
 */

var KL_STATE_MACHINE_ = Object.freeze({
  VERSION: 'v2',
  EVENT: Object.freeze({
    RESERVE: 'RESERVE',
    RELEASE: 'RELEASE',
    SHIP: 'SHIP',
    RETURN_PENDING: 'RETURN_PENDING',
    RETURN_RESTOCK: 'RETURN_RESTOCK',
    COMPLETE: 'COMPLETE',
    CANCEL_NO_RESERVE: 'CANCEL_NO_RESERVE'
  }),
  ACTIVE_STATUS: Object.freeze({
    APPROVED_BY_BANK: true,
    ACCEPTED_BY_MERCHANT: true
  }),
  RETURN_STATUS: Object.freeze({
    KASPI_DELIVERY_RETURN_REQUESTED: true,
    RETURNED: true
  }),
  KNOWN_STATUS: Object.freeze({
    APPROVED_BY_BANK: true,
    ACCEPTED_BY_MERCHANT: true,
    CANCELLING: true,
    CANCELLED: true,
    COMPLETED: true,
    KASPI_DELIVERY_RETURN_REQUESTED: true,
    RETURNED: true
  })
});

function klSmText_(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function klSmUpper_(value) {
  return klSmText_(value).toUpperCase();
}

function klSmOwn_(object, key) {
  return Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);
}

function klSmFiniteNumber_(value, fallback) {
  var number = Number(value);
  return isFinite(number) ? number : fallback;
}

function klSmQty_(value, fallback) {
  var number = klSmFiniteNumber_(value, fallback);
  if (!isFinite(number)) return number;
  return number > 0 ? number : 0;
}

function klSmIsNonNegativeInteger_(value) {
  var number = Number(value);
  return isFinite(number) && number >= 0 && Math.floor(number) === number;
}

function klSmIsPositiveInteger_(value) {
  var number = Number(value);
  return isFinite(number) && number > 0 && Math.floor(number) === number;
}

function klSmCanonicalNumber_(value) {
  var number = klSmQty_(value, 0);
  if (!number || Object.is(number, -0)) return '0';
  return String(number);
}

/**
 * encodeURIComponent есть и в GAS V8, и в Node. Перед кодированием заменяем
 * одинокие surrogate-коды, чтобы повреждённый внешний ID не уронил весь sync.
 */
function klSmEscapeIdPart_(value) {
  var text = String(value === null || value === undefined ? '' : value);
  var safe = '';
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF) {
      var next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xDC00 && next <= 0xDFFF) {
        safe += text.charAt(i) + text.charAt(i + 1);
        i++;
      } else {
        safe += '\uFFFD';
      }
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      safe += '\uFFFD';
    } else {
      safe += text.charAt(i);
    }
  }
  return encodeURIComponent(safe).replace(/[!'()*]/g, function (character) {
    return '%' + character.charCodeAt(0).toString(16).toUpperCase();
  });
}

/** Детерминированный ID v2: повторное планирование даёт тот же ключ. */
function klMakeDeterministicEventId_(orderId, lineId, eventType, cumulativeAfter) {
  return [
    KL_STATE_MACHINE_.VERSION,
    klSmEscapeIdPart_(orderId),
    klSmEscapeIdPart_(lineId),
    klSmUpper_(eventType),
    klSmCanonicalNumber_(cumulativeAfter)
  ].join('|');
}

function klSmEmptyEventIds_() {
  return Object.create(null);
}

function klSmCopyEventIds_(source) {
  var result = klSmEmptyEventIds_();
  if (!source) return result;
  Object.keys(source).forEach(function (key) {
    if (source[key]) result[key] = true;
  });
  return result;
}

function klSmEmptyLineState_() {
  return klSmRecomputeState_({
    orderId: '',
    lineId: '',
    sku: '',
    reservedQty: 0,
    releasedQty: 0,
    shippedQty: 0,
    returnPendingQty: 0,
    returnRestockedQty: 0,
    completedQty: 0,
    cancelNoReserveQty: 0,
    eventCount: 0,
    lastEventType: '',
    lastEventId: '',
    eventIds: klSmEmptyEventIds_(),
    warnings: []
  });
}

function klSmReadTotal_(state, preferred, legacy, fallback) {
  if (klSmOwn_(state, preferred)) return klSmQty_(state[preferred], 0);
  if (legacy && klSmOwn_(state, legacy)) return klSmQty_(state[legacy], 0);
  return fallback || 0;
}

/** Клонирует и нормализует состояние, не меняя объект вызывающего кода. */
function klSmNormalizeLineState_(state) {
  state = state || {};
  var eventIds = state.eventIds || state.appliedEventIds;
  var result = {
    orderId: klSmText_(state.orderId),
    lineId: klSmText_(state.lineId || state.entryId),
    sku: klSmText_(state.sku),
    reservedQty: klSmReadTotal_(state, 'reservedQty', 'reserveTotal', 0),
    releasedQty: klSmReadTotal_(state, 'releasedQty', 'releaseTotal', 0),
    shippedQty: klSmReadTotal_(state, 'shippedQty', 'shipTotal', 0),
    returnPendingQty: klSmReadTotal_(state, 'returnPendingQty', 'returnPendingTotal', 0),
    returnRestockedQty: klSmReadTotal_(state, 'returnRestockedQty', 'returnTotal', 0),
    completedQty: klSmReadTotal_(state, 'completedQty', 'completeTotal', 0),
    cancelNoReserveQty: klSmReadTotal_(state, 'cancelNoReserveQty', 'cancelNoReserveTotal', 0),
    eventCount: Math.max(0, klSmFiniteNumber_(state.eventCount, 0)),
    lastEventType: klSmUpper_(state.lastEventType),
    lastEventId: klSmText_(state.lastEventId),
    eventIds: klSmCopyEventIds_(eventIds),
    warnings: Array.isArray(state.warnings) ? state.warnings.slice() : []
  };
  return klSmRecomputeState_(result);
}

function klSmRecomputeState_(state) {
  state.openReserveQty = Math.max(
    0,
    state.reservedQty - state.releasedQty - state.shippedQty
  );
  state.openReturnQty = Math.max(
    0,
    state.returnPendingQty - state.returnRestockedQty
  );
  state.stockDelta = -state.reservedQty + state.releasedQty + state.returnRestockedQty;

  // Алиасы оставляют fold совместимым со старым агрегатом Ledger.gs.
  state.reserveTotal = state.reservedQty;
  state.releaseTotal = state.releasedQty;
  state.shipTotal = state.shippedQty;
  state.returnPendingTotal = state.returnPendingQty;
  state.returnTotal = state.returnRestockedQty;
  state.completeTotal = state.completedQty;
  state.cancelNoReserveTotal = state.cancelNoReserveQty;
  state.appliedEventIds = state.eventIds;

  if (state.openReturnQty > 0) state.lifecycle = KL_STATE_MACHINE_.EVENT.RETURN_PENDING;
  else if (state.returnRestockedQty > 0) state.lifecycle = KL_STATE_MACHINE_.EVENT.RETURN_RESTOCK;
  else if (state.completedQty > 0) state.lifecycle = KL_STATE_MACHINE_.EVENT.COMPLETE;
  else if (state.shippedQty > 0) state.lifecycle = KL_STATE_MACHINE_.EVENT.SHIP;
  else if (state.openReserveQty > 0) state.lifecycle = KL_STATE_MACHINE_.EVENT.RESERVE;
  else if (state.cancelNoReserveQty > 0) state.lifecycle = KL_STATE_MACHINE_.EVENT.CANCEL_NO_RESERVE;
  else if (state.releasedQty > 0) state.lifecycle = KL_STATE_MACHINE_.EVENT.RELEASE;
  else state.lifecycle = 'EMPTY';
  return state;
}

function klSmEventType_(event) {
  return klSmUpper_(event && (event.eventType || event.type));
}

function klSmCurrentCumulative_(state, eventType) {
  if (eventType === KL_STATE_MACHINE_.EVENT.RESERVE) return state.reservedQty;
  if (eventType === KL_STATE_MACHINE_.EVENT.RELEASE) return state.releasedQty;
  if (eventType === KL_STATE_MACHINE_.EVENT.SHIP) return state.shippedQty;
  if (eventType === KL_STATE_MACHINE_.EVENT.RETURN_PENDING) return state.returnPendingQty;
  if (eventType === KL_STATE_MACHINE_.EVENT.RETURN_RESTOCK) return state.returnRestockedQty;
  if (eventType === KL_STATE_MACHINE_.EVENT.COMPLETE) return state.completedQty;
  if (eventType === KL_STATE_MACHINE_.EVENT.CANCEL_NO_RESERVE) return state.cancelNoReserveQty;
  return 0;
}

/** Чисто применяет одно событие; duplicate event_id становится no-op. */
function klApplyEvent_(lineState, event) {
  var next = klSmNormalizeLineState_(lineState);
  if (!event) return next;

  var eventId = klSmText_(event.eventId || event.id);
  if (eventId && next.eventIds[eventId]) return next;

  var eventType = klSmEventType_(event);
  if (!klSmIsPositiveInteger_(event.qty)) {
    next.warnings.push('INVALID_EVENT_QTY:' + (eventId || eventType));
    return klSmRecomputeState_(next);
  }
  var qty = Number(event.qty);
  var before = klSmCurrentCumulative_(next, eventType);
  var advertisedAfter = klSmQty_(event.cumulativeAfter, before + qty);

  if (eventType === KL_STATE_MACHINE_.EVENT.RESERVE) next.reservedQty += qty;
  else if (eventType === KL_STATE_MACHINE_.EVENT.RELEASE) next.releasedQty += qty;
  else if (eventType === KL_STATE_MACHINE_.EVENT.SHIP) next.shippedQty += qty;
  else if (eventType === KL_STATE_MACHINE_.EVENT.RETURN_PENDING) next.returnPendingQty += qty;
  else if (eventType === KL_STATE_MACHINE_.EVENT.RETURN_RESTOCK) next.returnRestockedQty += qty;
  else if (eventType === KL_STATE_MACHINE_.EVENT.COMPLETE) next.completedQty += qty;
  else if (eventType === KL_STATE_MACHINE_.EVENT.CANCEL_NO_RESERVE) next.cancelNoReserveQty += qty;
  else {
    next.warnings.push('UNKNOWN_EVENT:' + eventType);
    return klSmRecomputeState_(next);
  }

  if (Math.abs(advertisedAfter - (before + qty)) > 1e-9) {
    next.warnings.push('CUMULATIVE_MISMATCH:' + (eventId || eventType));
  }
  if (next.releasedQty + next.shippedQty > next.reservedQty + 1e-9) {
    next.warnings.push('RESERVE_UNDERFLOW:' + (eventId || eventType));
  }
  if (next.returnRestockedQty > next.returnPendingQty + 1e-9) {
    next.warnings.push('RETURN_UNDERFLOW:' + (eventId || eventType));
  }

  if (!next.orderId) next.orderId = klSmText_(event.orderId);
  if (!next.lineId) next.lineId = klSmText_(event.lineId || event.entryId);
  if (!next.sku) next.sku = klSmText_(event.sku);
  if (eventId) next.eventIds[eventId] = true;
  next.eventCount += 1;
  next.lastEventType = eventType;
  next.lastEventId = eventId;
  return klSmRecomputeState_(next);
}

/** Ledger сворачивается независимо от processed/applied commit-marker. */
function klFoldLineState_(events, seedState) {
  var state = klSmNormalizeLineState_(seedState || klSmEmptyLineState_());
  var list = Array.isArray(events) ? events : [];
  for (var i = 0; i < list.length; i++) state = klApplyEvent_(state, list[i]);
  return state;
}

function klEventStockDelta_(event) {
  var type = klSmEventType_(event);
  var qty = klSmQty_(event && event.qty, 0);
  if (type === KL_STATE_MACHINE_.EVENT.RESERVE) return -qty;
  if (type === KL_STATE_MACHINE_.EVENT.RELEASE) return qty;
  if (type === KL_STATE_MACHINE_.EVENT.RETURN_RESTOCK) return qty;
  return 0;
}

function klSmSnapshotValue_(snapshot, preferred, fallback) {
  if (klSmOwn_(snapshot, preferred)) return snapshot[preferred];
  return fallback && klSmOwn_(snapshot, fallback) ? snapshot[fallback] : undefined;
}

function klSmNormalizeSnapshot_(snapshot, ctx) {
  snapshot = snapshot || {};
  ctx = ctx || {};
  var rawQty = klSmSnapshotValue_(snapshot, 'qty', 'quantity');
  var qtyProvided = rawQty !== undefined && rawQty !== null && klSmText_(rawQty) !== '';
  var qtyValid = qtyProvided && klSmIsNonNegativeInteger_(rawQty);
  var rawEventAt = klSmSnapshotValue_(snapshot, 'eventAt', 'eventAtMs');
  if (rawEventAt === undefined) rawEventAt = klSmSnapshotValue_(ctx, 'eventAt', 'eventAtMs');
  return {
    orderId: klSmText_(snapshot.orderId),
    lineId: klSmText_(snapshot.lineId || snapshot.entryId),
    code: klSmText_(snapshot.code || snapshot.orderCode),
    // merchantProductCode обязан пройти `_KASPI_PRODUCT_MAP` в I/O-слое.
    // Не подменяем им канонический SKU: иначе потеряется MISSING_SKU.
    sku: klSmText_(snapshot.sku),
    qty: qtyValid ? Number(rawQty) : NaN,
    qtyProvided: qtyProvided,
    qtyValid: qtyValid,
    state: klSmUpper_(snapshot.state),
    status: klSmUpper_(snapshot.status),
    eventAt: rawEventAt === undefined ? '' : rawEventAt,
    source: klSmText_(snapshot.source || ctx.source) || 'KASPI_API',
    raw: snapshot
  };
}

/** Статус выбирается только по точному значению; substring/fuzzy match запрещён. */
function klSmCanonicalStatus_(snapshot) {
  if (KL_STATE_MACHINE_.KNOWN_STATUS[snapshot.status]) return snapshot.status;
  if (KL_STATE_MACHINE_.KNOWN_STATUS[snapshot.state]) return snapshot.state;
  return snapshot.status || snapshot.state;
}

function klSmTruthyMarker_(value) {
  if (value === true) return true;
  if (value === false || value === null || value === undefined || value === '') return false;
  if (typeof value === 'number') return isFinite(value) && value > 0;
  var text = klSmUpper_(value);
  return text !== '' && text !== 'FALSE' && text !== '0' && text !== 'NULL';
}

function klSmHasHandoff_(snapshot, lineState) {
  var raw = snapshot.raw || {};
  var status = klSmUpper_(snapshot.status || snapshot.state);
  // Эти конечные статусы возможны только после передачи заказа в доставку.
  // Если мы увидели их впервые, всё равно создаём задачу ожидания возврата.
  if (KL_STATE_MACHINE_.RETURN_STATUS[status]) return true;
  return klSmTruthyMarker_(raw.handoff) ||
    klSmTruthyMarker_(raw.courierTransmissionMs) ||
    klSmTruthyMarker_(raw.courierTransmissionDate) ||
    lineState.shippedQty > 0;
}

/** Источник явно подтвердил наличие или отсутствие факта передачи. */
function klSmHandoffKnown_(snapshot, lineState) {
  var raw = snapshot.raw || {};
  var status = klSmUpper_(snapshot.status || snapshot.state);
  if (KL_STATE_MACHINE_.RETURN_STATUS[status] ||
      status === 'COMPLETED' || lineState.shippedQty > 0) return true;
  return klSmOwn_(raw, 'handoffKnown') && klSmTruthyMarker_(raw.handoffKnown);
}

function klSmReleaseUnknownHandoff_(ctx) {
  if (ctx && ctx.releaseWhenHandoffUnknown === true) return true;
  return typeof SK_RELEASE_WHEN_HANDOFF_UNKNOWN !== 'undefined' &&
    SK_RELEASE_WHEN_HANDOFF_UNKNOWN === true;
}

function klSmReturnConfirmed_(snapshot, ctx) {
  var raw = snapshot.raw || {};
  ctx = ctx || {};
  // Kaspi `returnedToWarehouse` означает возврат в пункт приёма, а не
  // физическую приёмку продавцом. Restock разрешает только явный ручной флаг.
  return klSmTruthyMarker_(raw.manualReturnConfirmed) ||
    klSmTruthyMarker_(raw.restockConfirmedByUser) ||
    klSmTruthyMarker_(ctx.manualReturnConfirmed) ||
    klSmTruthyMarker_(ctx.restockConfirmedByUser);
}

function klSmBuildEvent_(snapshot, lineState, eventType, qty, details) {
  qty = klSmQty_(qty, 0);
  var cumulativeAfter = klSmCurrentCumulative_(lineState, eventType) + qty;
  var stockDelta = klEventStockDelta_({ eventType: eventType, qty: qty });
  var eventDetails = {};
  Object.keys(details || {}).forEach(function (key) { eventDetails[key] = details[key]; });
  eventDetails.stockDelta = stockDelta;
  return {
    eventId: klMakeDeterministicEventId_(
      snapshot.orderId,
      snapshot.lineId,
      eventType,
      cumulativeAfter
    ),
    eventType: eventType,
    qty: qty,
    cumulativeAfter: cumulativeAfter,
    orderId: snapshot.orderId,
    lineId: snapshot.lineId,
    code: snapshot.code,
    sku: snapshot.sku,
    status: snapshot.status,
    state: snapshot.state,
    eventAt: snapshot.eventAt,
    source: snapshot.source,
    stockDelta: stockDelta,
    details: eventDetails
  };
}

function klSmPushEvent_(plan, snapshot, eventType, qty, reason) {
  if (!(qty > 0)) return;
  var event = klSmBuildEvent_(snapshot, plan.nextState, eventType, qty, {
    reason: reason,
    desiredQty: plan.desiredQty,
    handoff: plan.handoff
  });
  plan.events.push(event);
  plan.nextState = klApplyEvent_(plan.nextState, event);
  plan.stockDelta += event.stockDelta;
}

function klSmEnsureShipped_(plan, snapshot, targetQty, reason) {
  var missingShip = Math.max(0, targetQty - plan.nextState.shippedQty);
  if (!(missingShip > 0)) return;
  var missingReserve = Math.max(0, missingShip - plan.nextState.openReserveQty);
  if (missingReserve > 0) {
    klSmPushEvent_(plan, snapshot, KL_STATE_MACHINE_.EVENT.RESERVE, missingReserve, reason + ':BACKFILL_RESERVE');
  }
  klSmPushEvent_(plan, snapshot, KL_STATE_MACHINE_.EVENT.SHIP, missingShip, reason);
}

function klSmCloseResidualReserve_(plan, snapshot, reason) {
  if (plan.nextState.openReserveQty > 0) {
    klSmPushEvent_(
      plan,
      snapshot,
      KL_STATE_MACHINE_.EVENT.RELEASE,
      plan.nextState.openReserveQty,
      reason
    );
  }
}

function klSmEnsureReturnPending_(plan, snapshot, targetQty, reason) {
  var missing = Math.max(0, targetQty - plan.nextState.returnPendingQty);
  if (missing > 0) {
    klSmPushEvent_(plan, snapshot, KL_STATE_MACHINE_.EVENT.RETURN_PENDING, missing, reason);
  }
}

function klSmEnsureReturnRestocked_(plan, snapshot, reason) {
  if (plan.nextState.openReturnQty > 0) {
    klSmPushEvent_(
      plan,
      snapshot,
      KL_STATE_MACHINE_.EVENT.RETURN_RESTOCK,
      plan.nextState.openReturnQty,
      reason
    );
  }
}

function klSmPlanResult_(lineState, snapshot, status, ctx) {
  return {
    events: [],
    nextState: klSmNormalizeLineState_(lineState),
    decision: 'NOOP',
    status: status,
    desiredQty: snapshot.qty,
    handoff: klSmHasHandoff_(snapshot, lineState),
    returnConfirmed: klSmReturnConfirmed_(snapshot, ctx),
    stockDelta: 0,
    errors: []
  };
}

function klSmValidateSnapshot_(lineState, snapshot) {
  var errors = [];
  if (!snapshot.orderId) errors.push('MISSING_ORDER_ID');
  if (!snapshot.lineId) errors.push('MISSING_LINE_ID');
  if (!snapshot.sku) errors.push('MISSING_SKU');
  if (!snapshot.qtyProvided || !snapshot.qtyValid || !isFinite(snapshot.qty)) {
    errors.push('INVALID_QTY');
  }
  if (lineState.orderId && snapshot.orderId && lineState.orderId !== snapshot.orderId) {
    errors.push('ORDER_ID_MISMATCH');
  }
  if (lineState.lineId && snapshot.lineId && lineState.lineId !== snapshot.lineId) {
    errors.push('LINE_ID_MISMATCH');
  }
  if (lineState.sku && snapshot.sku && lineState.sku !== snapshot.sku) {
    errors.push('SKU_MISMATCH');
  }
  return errors;
}

/**
 * Основной pure API.
 *
 * @param {Object|Array} lineState результат klFoldLineState_ (или массив событий)
 * @param {Object} snapshot адаптированный snapshot строки Kaspi
 * @param {Object=} ctx подтверждение возврата и служебный context
 * @return {{events:Array,nextState:Object,decision:string,status:string}}
 */
function klPlanLineSnapshot_(lineState, snapshot, ctx) {
  // Мягкая совместимость с ранним прототипом (snapshot, priorEvents, ctx).
  if (Array.isArray(snapshot)) {
    var legacySnapshot = lineState;
    lineState = klFoldLineState_(snapshot);
    snapshot = legacySnapshot;
  } else if (Array.isArray(lineState)) {
    lineState = klFoldLineState_(lineState);
  }

  ctx = ctx || {};
  lineState = klSmNormalizeLineState_(lineState || klSmEmptyLineState_());
  snapshot = klSmNormalizeSnapshot_(snapshot, ctx);
  var status = klSmCanonicalStatus_(snapshot);
  var plan = klSmPlanResult_(lineState, snapshot, status, ctx);
  plan.errors = klSmValidateSnapshot_(lineState, snapshot);
  if (plan.errors.length) {
    plan.decision = 'INVALID_SNAPSHOT';
    return plan;
  }

  if (!KL_STATE_MACHINE_.KNOWN_STATUS[status]) {
    plan.decision = 'UNSUPPORTED_STATUS';
    return plan;
  }

  if (KL_STATE_MACHINE_.ACTIVE_STATUS[status]) {
    // Kaspi может ещё показывать ACCEPTED_BY_MERCHANT, хотя фактическая
    // передача курьеру уже зафиксирована отдельным полем.
    if (plan.handoff) {
      klSmEnsureShipped_(plan, snapshot, plan.desiredQty, 'COURIER_HANDOFF');
      klSmCloseResidualReserve_(plan, snapshot, 'COURIER_HANDOFF_RELEASE_REMAINDER');
      plan.decision = plan.events.length ? 'HANDOFF_SHIPPED' : 'HANDOFF_ALIGNED';
      return plan;
    }
    var reserveDifference = plan.desiredQty - plan.nextState.openReserveQty;
    if (reserveDifference > 0) {
      klSmPushEvent_(plan, snapshot, KL_STATE_MACHINE_.EVENT.RESERVE, reserveDifference, 'ACTIVE_ALIGN');
      plan.decision = 'ACTIVE_RESERVED';
    } else if (reserveDifference < 0) {
      klSmPushEvent_(plan, snapshot, KL_STATE_MACHINE_.EVENT.RELEASE, -reserveDifference, 'ACTIVE_ALIGN');
      plan.decision = 'ACTIVE_RELEASED';
    } else {
      plan.decision = 'ACTIVE_ALIGNED';
    }
    return plan;
  }

  if (status === 'CANCELLING') {
    if (plan.handoff) {
      klSmEnsureShipped_(plan, snapshot, plan.desiredQty, 'CANCELLING_HANDOFF');
      plan.decision = plan.events.length ? 'CANCELLING_SHIPPED_HOLD' : 'CANCELLING_HOLD';
    } else {
      plan.decision = 'CANCELLING_HOLD';
    }
    return plan;
  }

  if (status === 'COMPLETED') {
    klSmEnsureShipped_(plan, snapshot, plan.desiredQty, 'COMPLETED_SHIP');
    klSmCloseResidualReserve_(plan, snapshot, 'COMPLETED_RELEASE_REMAINDER');
    var missingComplete = Math.max(0, plan.desiredQty - plan.nextState.completedQty);
    if (missingComplete > 0) {
      klSmPushEvent_(plan, snapshot, KL_STATE_MACHINE_.EVENT.COMPLETE, missingComplete, 'COMPLETED_MARK');
    }
    plan.decision = plan.events.length ? 'COMPLETED_APPLIED' : 'COMPLETED_ALIGNED';
    return plan;
  }

  if (status === 'CANCELLED') {
    // Без точного факта «не передан» отмена не освобождает товар по умолчанию.
    // Включить это поведение можно только явным флагом SK_RELEASE_WHEN_HANDOFF_UNKNOWN.
    if (!plan.handoff && !klSmHandoffKnown_(snapshot, plan.nextState) &&
        !klSmReleaseUnknownHandoff_(ctx)) {
      plan.decision = 'CANCELLED_HANDOFF_UNKNOWN_HOLD';
      return plan;
    }
    if (!plan.handoff) {
      if (plan.nextState.openReserveQty > 0) {
        klSmCloseResidualReserve_(plan, snapshot, 'CANCELLED_PRE_HANDOFF');
        plan.decision = 'CANCELLED_RELEASED';
      } else if (plan.nextState.reservedQty === 0 && plan.nextState.shippedQty === 0) {
        var markerTarget = plan.desiredQty > 0 ? plan.desiredQty : 1;
        var missingMarker = Math.max(0, markerTarget - plan.nextState.cancelNoReserveQty);
        if (missingMarker > 0) {
          klSmPushEvent_(
            plan,
            snapshot,
            KL_STATE_MACHINE_.EVENT.CANCEL_NO_RESERVE,
            missingMarker,
            'FIRST_SEEN_CANCELLED'
          );
        }
        plan.decision = plan.events.length ? 'CANCELLED_NO_RESERVE_MARKED' : 'CANCELLED_NO_RESERVE_ALIGNED';
      } else {
        plan.decision = 'CANCELLED_ALREADY_RELEASED';
      }
      return plan;
    }

    klSmEnsureShipped_(plan, snapshot, plan.desiredQty, 'CANCELLED_POST_HANDOFF_SHIP');
    klSmCloseResidualReserve_(plan, snapshot, 'CANCELLED_POST_HANDOFF_RELEASE_REMAINDER');
    klSmEnsureReturnPending_(plan, snapshot, plan.nextState.shippedQty, 'CANCELLED_POST_HANDOFF');
    if (plan.returnConfirmed) {
      klSmEnsureReturnRestocked_(plan, snapshot, 'WAREHOUSE_RETURN_CONFIRMED');
    }
    plan.decision = plan.returnConfirmed ? 'CANCELLED_RETURN_RESTOCKED' : 'CANCELLED_RETURN_PENDING';
    return plan;
  }

  if (KL_STATE_MACHINE_.RETURN_STATUS[status]) {
    if (!plan.handoff) {
      plan.decision = 'RETURN_BEFORE_HANDOFF_HOLD';
      return plan;
    }
    klSmEnsureShipped_(plan, snapshot, plan.desiredQty, 'RETURN_STATUS_SHIP');
    klSmCloseResidualReserve_(plan, snapshot, 'RETURN_STATUS_RELEASE_REMAINDER');
    klSmEnsureReturnPending_(plan, snapshot, plan.nextState.shippedQty, 'RETURN_STATUS_PENDING');
    if (plan.returnConfirmed) {
      klSmEnsureReturnRestocked_(plan, snapshot, 'WAREHOUSE_RETURN_CONFIRMED');
    }
    plan.decision = plan.returnConfirmed ? 'RETURN_RESTOCKED' : 'RETURN_PENDING';
    return plan;
  }

  plan.decision = 'UNSUPPORTED_STATUS';
  return plan;
}

/** Удобный alias с snapshot первым аргументом. */
function klPlanSnapshot_(snapshot, priorOrState, ctx) {
  var state = Array.isArray(priorOrState) ? klFoldLineState_(priorOrState) : priorOrState;
  return klPlanLineSnapshot_(state || klSmEmptyLineState_(), snapshot, ctx || {});
}
