# Показатели качества (/quality)

Раздел GRANTS BOOK Control Center. Прод — проект Vercel `grants-book-kaspi-assistant`, каталог `vercel-site/`.

## Где что лежит
| Что | Файл |
|---|---|
| Формулы (чистые функции) | `vercel-site/lib/quality/formulas.js` |
| Метрики, детализация, калибровка, рекомендации | `vercel-site/lib/quality/compute.js` |
| Загрузка из Kaspi (окна ≤14 дней, все state, все страницы, ретраи) | `vercel-site/lib/quality/loader.js` |
| Хранилище (память → Vercel Runtime Cache → скрытый лист `GB_Качество`) | `vercel-site/lib/quality/store.js` |
| API `/api/quality` → `/api/data?module=quality` | `vercel-site/lib/quality/handler.js` |
| UI (оверлей в Control Center + страница `/quality`) | `vercel-site/public/gb-quality.js`, `vercel-site/public/quality.html` |
| Тесты | `vercel-site/tests/quality-*.test.js` |
| Probe Kaspi API | `scripts/kaspi-probe.ts` → `docs/kaspi-sample.json` |

Новой serverless-функции нет: на Hobby их максимум 12, все слоты заняты. Модуль обслуживает существующая `api/data.js`.

## Определения
- **Окно**: по `creationDate`, Asia/Almaty, N дней включительно (30 дней на 21.11 → 23.10–21.11; рейтинг 90 дней → 24.08–21.11).
- **Отмены по вине продавца** = CANCELLED/CANCELLING с `cancellationReason` из списка «вина продавца» / завершённые заказы (ARCHIVE). Список размечается в UI. По умолчанию: MERCHANT_OUT_OF_STOCK, PRODUCT_OUT_OF_STOCK, TIMEOUT_MERCHANT_DELIVERY.
- **Задержки** = заказы Kaspi Доставки с наступившей `kaspiDelivery.courierTransmissionPlanningDate`, у которых `courierTransmissionDate` позже плана или передачи нет. Знаменатель — такие же заказы КД. Заказ, отменённый до передачи, не учитывается. Выданный заказ без даты передачи тоже не учитывается, он попадает в «покрытие».
- **Возвраты по качеству** = возвраты (RETURNED, KASPI_DELIVERY_RETURN_REQUESTED), у которых причина из CSV-импорта совпадает со словами «качества» / (COMPLETED + возвраты). Возврат без причины идёт в «причина неизвестна» и считается отдельно, как верхняя граница.
- **Рейтинг, чаты**: в Shop API их нет. Источники — «Снимок кабинета» (ручной ввод) или импорт отзывов.

## Деплой
1. Влить ветку в `main`. Workflow `Deploy GRANTS BOOK dashboard` сам задеплоит `vercel-site/`.
2. В Vercel → Settings → Environment Variables:
   - `CRON_SECRET` — любая длинная строка. Vercel Cron передаёт её в `Authorization: Bearer`. Без неё cron принимается только по User-Agent `vercel-cron`.
   - `KASPI_API_TOKEN`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `GB_ACCESS_CODE` — уже есть.
3. Cron в `vercel-site/vercel.json` запускается раз в сутки (01:17 UTC): на Hobby чаще нельзя, иначе деплой упадёт. На Pro поменяйте расписание на `0 * * * *`, чтобы обновлять каждый час. Открытая страница сама перезапрашивает данные раз в час. Сервер обновляет данные в фоне, если им больше часа.
4. Первая загрузка 100 дней — несколько шагов по ~4 минуты: кнопка «Обновить из Kaspi» повторяет их сама.
5. Проверка: `cd vercel-site && npm run check`.
