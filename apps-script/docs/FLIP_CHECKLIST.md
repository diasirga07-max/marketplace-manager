# Чек-лист: Flip в режиме dry-run

Код: `apps-script/Flip.gs`, правка `doGet` в `новый скрипт от клоуд.gs`,
прокси `apps-script/vercel/grants-book-kaspi/api/flip-feed.js`.
Проверки: `node apps-script/tests/flip.test.js`.

## 1. Apps Script (вручную в редакторе, НЕ `clasp push` из снимка)

1. Создать файл **Flip** и вставить содержимое `Flip.gs` целиком.
2. В `новый скрипт от клоуд.gs` → `doGet` сразу после строки
   `const props = PropertiesService.getScriptProperties();` вставить:
   ```js
   // Flip XML (Flip.gs). Без ?feed=flip ниже всё работает как раньше.
   if (params.feed === 'flip' && typeof FLIP_DOGET_ === 'function') return FLIP_DOGET_(params);
   ```
3. Запустить `FLIP_SELF_TEST` → в логе `OK: FLIP_SELF_TEST`.
4. Развернуть → Управление развёртываниями → текущее веб-приложение →
   ✏️ → Версия: **Новая версия** → Развернуть. URL `/exec` не меняется.
   (Без новой версии `?feed=flip` будет отдавать Kaspi XML, и прокси вернёт 503.)

## 2. Script Properties

| Свойство | Значение | Зачем |
|---|---|---|
| `FLIP_API_KEY` | ключ Flip (вводите сами) | заголовок `Authorization` |
| `FLIP_DRY_RUN` | `TRUE` | ничего не пишет в ledger, C, СКЛАД_НАЛИЧИЕ |
| `FLIP_SAFETY_BUFFER` | `1` | count = F − 1 для связанных |
| `KL_NOTIFY_EMAIL` | ваш email (если ещё не задан) | письма о конфликтах (только в бою) |
| `FLIP_DRY_SIMULATE_INITIALIZED` | `YES` — временно, по желанию | показать в dry-run списание так, будто первый запуск уже прошёл |

Не задавать до боевого включения: `FLIP_INITIALIZED` (ставит сам первый боевой
запуск), `FLIP_TRANSFER_ALLOWED` (только для разового переноса после «ок»).

## 3. Dry-run

1. Запустить вручную `KL_FLIP_ORDERS_RUN` → лист «Flip dry-run»: REGISTER_ONLY
   (или WOULD_DEDUCT / WOULD_DEDUCT_C / UNMAPPED_NO_DEDUCT при SIMULATE).
2. `KL_FLIP_STATUS_RUN` — в dry-run пока пусто (нет строк в ledger); проверяет связь с statusGoods.
3. `FLIP_XML_RUN` → файл `flip-catalog.xml` в Drive; открыть
   `<web app>/exec?feed=flip` — 231 offer.
4. `FLIP_TRANSFER_DRY_RUN` — после заполнения «Факт на полке» и «Перенести».
5. Прислать: листы «Flip dry-run», «Flip ошибки», результаты из логов.

Триггеры на время dry-run можно включить: `FLIP_INSTALL_TRIGGERS()`
(создаёт только KL_FLIP_ORDERS_RUN 5 мин, KL_FLIP_STATUS_RUN 1 ч, FLIP_XML_RUN 15 мин).
**Не запускать `SETUP_ALL()`** — удаляет все триггеры проекта.

## 4. Vercel (grants-book-kaspi) — по отдельному «ок»

Добавить `api/flip-feed.js` и строку в `vercel.json`, задеплоить в production.
`api/kaspi.js` не меняется. Ссылка для Flip → Прайсы (после включения в бой):
`https://grants-book-kaspi.vercel.app/api/flip-feed`

## 5. Kaspi XML не изменился

До и после: `https://grants-book-kaspi.vercel.app/api/kaspi`, сравнить без
атрибута `date` в `<kaspi_catalog>`. Эталон снят 2026-11-28 (6380 offer).

## 6. Боевое включение (только после вашего «ок»)

1. `FLIP_DRY_RUN=FALSE`, удалить `FLIP_DRY_SIMULATE_INITIALIZED`.
2. Первый `KL_FLIP_ORDERS_RUN`: текущие заказы → FLIP_REGISTERED, `FLIP_INITIALIZED=YES`.
3. В кабинете Flip → Прайсы → ссылка `/api/flip-feed`, «Каждый час».
