# Apps Script «price» (GRANTS BOOK)

Снимок проекта Google Apps Script, привязанного к таблице GRANTS BOOK.

- Script ID: `1Nb_uo0lC3S6VgAnx5O22s-HCIUdztiF-D91iZn0Tr_wTRx-4YwIAUwCP`
- Экспорт: 2026-11-28, 13 файлов. Секреты в коде заменены на `***`.
- `Sklad.gs.gs` — имя как после `clasp clone` (в редакторе файл называется `Sklad.gs`).

## ⚠️ Не делать `clasp push` из этого снимка

При замене секретов на `***` повреждён код:

| Файл | Строка | Что сломано |
|---|---|---|
| `новый скрипт от клоуд.gs` | 163 | `console.log('KASPI_TOKEN: '***'KASPI_TOKEN') ? ...` — синтаксическая ошибка, весь проект перестанет компилироваться |
| `Notify.gs` | 6 | `TELEGRAM_TOKEN_PROPERTY: '***'` — заменено имя свойства (не секрет) |

Снимок — только для чтения и ревью. Изменения переносятся в боевой проект
через свежий `clasp clone` / `clasp pull`, а не из этой папки.

## Flip (ветка flip-shared-stock)

- `Flip.gs` — новый файл, вставляется в редактор вручную (см. `docs/FLIP_CHECKLIST.md`).
- `новый скрипт от клоуд.gs` — единственная правка: ветка `?feed=flip` в `doGet`.
- `tests/flip.test.js` — `node apps-script/tests/flip.test.js` (Flip + реальные
  StateMachine/Ledger/Sklad).
- `vercel/grants-book-kaspi/` — `api/kaspi.js` (без изменений), новый `api/flip-feed.js`.
  В деплое проекта есть ещё `lib/stock*.js`, тест и `.bak`, маршрутами не используются.

## Документы

- `docs/FLIP_DECISIONS.md` — согласованные решения по общему складу Kaspi + Flip.
- `docs/FLIP_PLAN.md` — разбор текущего кода и план изменений.
