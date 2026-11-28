/*
 * Локальная проверка Flip.gs вместе с настоящими StateMachine.gs, Ledger.gs и
 * Sklad.gs.gs (только чистые функции). Запуск: node apps-script/tests/flip.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const dir = path.join(__dirname, '..');
const ctx = vm.createContext({
  console,
  normalizeSku_: (v) => String(v == null ? '' : v).replace(/ /g, '').replace(/[\r\n\t ]+/g, '').trim(),
});
for (const file of ['StateMachine.gs', 'Ledger.gs', 'Sklad.gs.gs', 'Flip.gs']) {
  vm.runInContext(fs.readFileSync(path.join(dir, file), 'utf8'), ctx, {filename: file});
}
const g = (name) => ctx[name];

// 1. Встроенная самопроверка Flip.gs.
assert.strictEqual(g('FLIP_SELF_TEST')(), 'OK: FLIP_SELF_TEST');

// 2. Существующие тесты склада не сломаны.
assert.ok(/^OK/.test(g('SKLAD_TEST_ledgerMovement_')()));

// 3. Сквозная цепочка: события Flip → свёртка SKLAD → F.
const plan = g('klPlanLineSnapshot_');
const fold = g('klFoldLineState_');
const snap = g('flipSnapshotFor_');
const norm = g('klLedgerNormalizePlannedEvent_');
const marker = g('flipMarker_');
const toSklad = (events) => events.map((e, i) => ({
  eventId: e.eventId, eventType: e.eventType, qty: e.qty, orderId: e.orderId, lineId: e.lineId,
  sku: e.sku, eventAtMs: e.eventAtMs, rowNumber: i + 2, canonical: true,
}));
const F = (C, events, sku, cutoff) => {
  const st = g('skLedgerSkuState_')(toSklad(events), sku, cutoff);
  return g('skAvailableAfterMovement_')(C, st.movement, st.activeReserveAtCutoff);
};

const SKU = 'OPTBOOK041';
const cutoff = 1000;
const line = {orderId: 'flip:555', lineId: '555', preorderId: '555', sku: SKU};
let ledger = [];
const step = (action, at) => {
  const p = plan(fold(ledger.filter((e) => e.source === 'FLIP_API' && !/^FLIP_/.test(e.eventType))), snap(line, action, at, ''), {});
  assert.deepStrictEqual(Array.from(p.errors), []);
  const evs = p.events.map((e) => norm(e, {}, at));
  ledger = ledger.concat(evs);
  return evs.map((e) => e.eventType).join(',');
};

assert.strictEqual(F(3, ledger, SKU, cutoff), 3);
assert.strictEqual(step('WAIT', 2000), 'RESERVE');          // новый заказ Flip
assert.strictEqual(F(3, ledger, SKU, cutoff), 2);
assert.strictEqual(step('WAIT', 2100), '');                 // повтор — без двойного списания
assert.strictEqual(step('RELEASE', 2200), 'RELEASE');       // 9 отменён поставщиком
assert.strictEqual(F(3, ledger, SKU, cutoff), 3);

ledger = [];
step('WAIT', 2000);
assert.strictEqual(step('SHIP', 2500), 'SHIP');              // 3 в пути
assert.strictEqual(F(3, ledger, SKU, cutoff), 2);           // отгрузка остаток не меняет
assert.strictEqual(step('COMPLETE', 3000), 'COMPLETE');      // 6 выполнен
assert.strictEqual(F(3, ledger, SKU, cutoff), 2);
assert.strictEqual(step('RETURN', 4000), 'RETURN_PENDING');  // 10 → ждёт ручного подтверждения
assert.strictEqual(F(3, ledger, SKU, cutoff), 2);           // без подтверждения не возвращаем

// 4. Маркеры Flip (регистрация, несвязанные C-списания) на F не влияют.
const regLine = {orderId: 'flip:600', lineId: '600', preorderId: '600'};
const markers = [
  marker('FLIP_REGISTERED', regLine, SKU, '1', {}, 2000),
  marker('FLIP_CLOSED', regLine, SKU, '1', {}, 2500),
  marker('FLIP_C_DEBIT', {orderId: 'flip:601', lineId: '601', preorderId: '601'}, 'FLIPC_000033', '1', {code: '000033', before: 3, after: 2}, 2000),
];
assert.strictEqual(F(3, markers, SKU, cutoff), 3);
assert.strictEqual(new Set(markers.map((m) => m.eventId)).size, 3);

// 5. Вариант Б переноса: C := факт + открытый резерв → F == факт.
ledger = [];
step('WAIT', 500);                                           // резерв открыт до переноса
const now = 5000;
const reserveNow = g('skLedgerSkuState_')(toSklad(ledger), SKU, now).activeReserve;
assert.strictEqual(reserveNow, 1);
const tp = g('flipTransferPlan_')([{row: 2, code: '000033', sku: SKU, fact: 2, transfer: true, status: ''}],
  {[SKU]: {row: 9, c: 1}}, {[SKU]: reserveNow});
assert.strictEqual(tp.skus[0].newC, 3);
assert.strictEqual(F(tp.skus[0].newC, ledger, SKU, now), 2); // F = факт на полке
// После переноса отмена того заказа возвращает книгу: F = 3.
ledger = ledger.concat(plan(fold(ledger), snap(line, 'RELEASE', 6000, ''), {}).events.map((e) => norm(e, {}, 6000)));
assert.strictEqual(F(tp.skus[0].newC, ledger, SKU, now), 3);

// 6. Flip XML: структура и экранирование.
const xml = g('flipRenderXml_')([{code: '000003', name: 'A & <B>', price: 1532, count: 2, barcode: ''}]);
assert.ok(xml.includes('<name>A &amp; &lt;B&gt;</name>') && !xml.includes('<barcode>'));

console.log('OK: flip.test.js');
