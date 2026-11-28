# План: общий склад Kaspi + Flip (по коду проекта «price», 2026-11-28)

Статус: код написан (Flip.gs, ветка doGet, api/flip-feed.js), режим FLIP_DRY_RUN.
Решения — FLIP_DECISIONS.md, установка — FLIP_CHECKLIST.md.
Прокси XML на Vercel — `/api/flip-feed` в проекте grants-book-kaspi
(`/api/flip` занят разделом Flip в grants-book-kaspi-assistant, не трогаем).
Перенос: вариант Б — C := «Факт на полке» + открытые резервы SKU из ledger.

Известное ограничение (по правилу владельца): строка закрывается на 5/6/7, поэтому
возврат, пришедший позже (12 → 10), автоматически не отслеживается.

## 1. Как сейчас считается F в «СКЛАД_НАЛИЧИЕ» (Sklad.gs.gs)

`SKLAD_recalc` (триггер каждые 5 мин + onEdit колонки C) для каждой строки:

```
F = max(0, C − резерв_на_дату_D + движение_после_D)
E = все открытые резервы сейчас
```

- События — из `_KASPI_ORDER_EVENTS` (K:R канонические, A:J legacy), свёртка по
  (orderId, lineId) в `skLedgerLineState_`, дедуп по Event ID.
- После D: RESERVE → −qty; RELEASE (только канонический) → +min(reserveOpen, qty);
  RETURN_RESTOCK → +min(returnPending, qty); SHIP/RETURN_PENDING остаток не меняют.
- До D: резерв, открытый на момент D (`activeReserveAtCutoff`), вычитается из C.
- Время RESERVE = дата создания заказа Kaspi, SHIP = дата передачи курьеру.
- Предупреждения ledger (кроме LEGACY_RESTORED) обнуляют F до ручной сверки.
- Kaspi XML (`buildXml_`) берёт `SKLAD_getAvailableMap()` (только F>0):
  F>0 → stockCount=F, preOrder=0; иначе stockCount=30 + preOrder из Q (или 2).
  Цена N; нет цены / <500 / ниже оптовой+5% → available="no".
  `XML_STOCK_OVERRIDES` (12 SKU) → stockCount=1 при F=0.
  Все 43 расхождения F↔XML объяснены этими правилами.

### СТОП по переносу (условие владельца сработало)

Ожидалось: «вычитаются заказы, созданные после D». Фактически ещё и **резерв,
открытый на момент D, вычитается из C**. Значит «Факт на полке» должен включать
экземпляры, отложенные под ещё не отгруженные заказы (они физически на полке).
Если отложенные под заказы книги лежат отдельно и в факт не попадут — они будут
вычтены дважды и F занизится. Перенос не выполняется до ответа владельца.

## 2. Заказы Flip через тот же ledger и state machine

Изменения существующих файлов: **только ветка `?feed=flip` в `doGet`**.
Orders / Ledger / StateMachine / StockCalc / Sklad / Reconcile / Notify / buildXml_
не меняются. Вся логика — новый файл `Flip.gs`.

- Строка ledger: orderId=`flip:<preorderId>`, lineId=`<preorderId>`, qty=1,
  sku = Kaspi SKU из «Flip map» (Активен=TRUE), source=`FLIP_API`.
- События строит существующий `klPlanLineSnapshot_` по адаптированному snapshot:
  статус Flip → канонический статус Kaspi (ACCEPTED_BY_MERCHANT / CANCELLED /
  COMPLETED / RETURNED) + признак передачи (handoff/handoffKnown).
- Запись — существующий `klLedgerAppendBatch_` (дедуп по детерминированному
  Event ID, перечитывание после записи) под общим ScriptLock.
- `SKLAD_recalc` подхватывает события сам → F → Kaspi XML и Flip XML.
- Первый запуск: текущие заказы — маркер `FLIP_REGISTERED` (типа нет ни в одной
  свёртке → остаток не меняется); такие строки в planner не передаются никогда,
  по конечному статусу закрываются маркером `FLIP_CLOSED`.
- Несвязанный товар: списание C «Прайс Flip» двухфазно —
  `FLIP_C_DEBIT` (намерение, до/после в Details) → запись C → `FLIP_C_APPLIED`;
  повтор после сбоя сверяет C с «до/после». Отмена → `FLIP_C_CREDIT` так же.
  SKU в ledger для них `FLIPC_<код>` (не пересекается с Kaspi SKU).
- Минус: RESERVE пишется (заказ реальный), Sklad сам держит F≥0;
  если F до заказа был 0 → «Flip ошибки» CONFLICT + письмо через существующий
  `klNotifySend_` (KL_NOTIFY_EMAIL; Telegram не настраивается).
- Код не найден / не активен → «Flip ошибки» UNMAPPED (для неактивных — списание C).
- Ежечасно `KL_FLIP_STATUS_RUN`: statusGoods пачками по 50 (history=true) для
  незакрытых строк. Адаптер кода Flip → snapshot для `klPlanLineSnapshot_`:
  - 1, 2 → ACCEPTED_BY_MERCHANT без передачи (резерв держится);
  - 3, 4 → ACCEPTED_BY_MERCHANT с передачей → SHIP (остаток не меняется);
  - 5, 6, 7 → COMPLETED (SHIP при необходимости + COMPLETE);
  - 9 → CANCELLED, handoffKnown=true, handoff=false → RELEASE (+1);
    если SHIP уже был — не планировать, STATUS на ручной разбор;
  - 8 → без отгрузки (нет SHIP и нет 3+ в history) — как 9;
    с отгрузкой — как COMPLETED (книга на складе Flip, без возврата);
  - 10 → RETURNED → RETURN_PENDING → ручное подтверждение через существующие
    `_KASPI_RETURN_TASKS` / `KL_CONFIRM_RETURN_RESTOCK` (как Kaspi);
  - 11, 12, нет кода → ничего, перезапрос в следующий час.
  Неизвестный код → hold + «Flip ошибки» STATUS.
- `FLIP_DRY_RUN=TRUE`: всё считается, пишется только «Flip dry-run» (+ лог);
  ledger, C, СКЛАД_НАЛИЧИЕ не трогаются.

## 3. Flip XML

- `FLIP_XML_RUN` (триггер каждые 15 мин) → Drive `flip-catalog.xml`,
  свойство `FLIP_XML_FILE_ID`; `doGet(?feed=flip)` отдаёт файл.
  Без параметра `doGet` работает байт-в-байт как сейчас.
- 231 код из «Прайс Flip»; связанный: count=max(0, F−FLIP_SAFETY_BUFFER), цена
  «Flip map» D; несвязанный: C и I. Нет цены → count=0. barcode — если есть.
- Vercel: `api/flip.js` по образцу `api/kaspi.js` (проверка `</offers>` и
  минимального числа offer), `vercel.json` maxDuration.
- Проверка Kaspi: XML до/после без атрибута `date` — идентичен.

## 4. Перенос «Flip перенос» → «СКЛАД_НАЛИЧИЕ»

`FLIP_TRANSFER_DRY_RUN` / `FLIP_TRANSFER_RUN` по правилам 1–6. Скрипт сам ставит
D (onEdit на правки скрипта не срабатывает), затем `SKLAD_recalc`.
Заблокирован до ответа по п. 1 (СТОП).

## 5. Триггеры и нагрузка

- Новые: `KL_FLIP_ORDERS_RUN` 5 мин, `KL_FLIP_STATUS_RUN` 1 ч, `FLIP_XML_RUN` 15 мин.
- Общий ScriptLock с KL_ORDERS_RUN / SKLAD_recalc / KASPI_XML_RUN:
  Flip-запуски короткие, `tryLock(5000)`, при занятости пропуск.
- НЕ запускать `SETUP_ALL()` — он удаляет ВСЕ триггеры проекта.

## 6. Замечания по коду (не исправлялись)

- `новый скрипт от клоуд.gs:163` повреждена заменой секрета на `***`
  (синтаксическая ошибка) — этот снимок нельзя `clasp push`.
- `Notify.gs:6` имя свойства Telegram заменено на `***`.
- 8 SKU с F>0 не продаются на Kaspi (available="no"): цена N < 500 или `#VALUE!`
  (501794197, 112209318_588506326, 111386737_580370750, 117161805_553959415,
  WBKANSAKV185, WBKANSPOD024, WBKANSPLS270, WBKANSPLS089).
- 6 SKU в «СКЛАД_НАЛИЧИЕ» отсутствуют в «Прайс KASPI» (#N/A в B).
