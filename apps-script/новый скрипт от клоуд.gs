/******************************************************************************
 * GRANTS BOOK — ЕДИНЫЙ СКРИПТ
 *
 * 1) WB_RUN        — цены Wildberries (Астана) в колонки U:Y листа «Прайс KASPI»
 * 2) KASPI_XML_RUN — XML-прайс для Kaspi (отдаётся через веб-приложение doGet)
 * 3) ORDERS_RUN    — заказы Kaspi → Курдай / Алматы заказы / Вайлберис
 *
 * Установка: вставить файл целиком, запустить SETUP_ALL() один раз.
 * KASPI_TOKEN хранится в Script Properties (меню «GRANTS BOOK» → токен).
 ******************************************************************************/

const GB = Object.freeze({
  SPREADSHEET_ID: '1dLU5KOi3WBLy3uNEiqGv5rf9ka0OwcEw_RjhDQW3H1E',
  TZ: 'Asia/Almaty',
  PRICE_SHEET: 'Прайс KASPI',

  // ---- Частота триггеров ----
  WB_EVERY_HOURS: 1,
  XML_EVERY_MINUTES: 10,      // раньше было 1 — XML-прайс перестраивается реже
  ORDERS_EVERY_MINUTES: 5,

  // ---- Колонки листа «Прайс KASPI» ----
  COL_SKU: 1,        // A
  COL_NAME: 2,       // B
  COL_STOCK: 16,     // P
  COL_PREORDER: 17,  // Q
  COL_WB_LINK: 20,   // T
  COL_PRICE: 21,     // U  цена WB (итог)
  // V продавец, W дней доставки, X дата доставки, Y статус

  // ---- Wildberries ----
  WB_ENDPOINT: 'https://card.wb.ru/cards/v4/detail',
  WB_GEO_ENDPOINT: 'https://user-geo-data.wildberries.ru/get-geo-info',
  WB_LAT: 51.1160,
  WB_LON: 71.4313,
  WB_ADDRESS: 'Астана, улица Алматы 13',
  WB_IDS_PER_REQUEST: 50,
  WB_REQUESTS_PER_WAVE: 15,
  WB_WAVE_DELAY_MS: 300,
  WB_SOFT_LIMIT_MS: 270000,
  WB_NOT_FOUND: 'не найдено',
  MIN_PRICE: 100,
  MAX_PRICE: 10000000,

  // ---- Kaspi XML ----
  XML_COMPANY: 'GRANTS BOOK',
  XML_MERCHANT_ID: '30418106',
  XML_STORE_ID: 'PP1',
  XML_BRAND: 'Без бренда',
  XML_FILE_NAME: 'kaspi-catalog.xml',
  XML_MIN_PRICE: 500,
  XML_MAX_PRICE: 10000000,
  // Исключения: эти артикулы можно продавать дешевле XML_MIN_PRICE
  // и без проверки «цена не ниже оптовой + 5%».
  XML_LOW_PRICE_MIN: 10,
  XML_LOW_PRICE_SKUS: [
    '117084019_902332516', // Ручка Softy
    '117155763_322446166', // Ручка Obama Marble
    '131632153_852180517', // Ручка Obama OB-4451
    '143939533_807949210', // Ручка Obama Smooth line
    '143939535_105675623', // Ручка Obama Smoothline-3
    '107529846_411551632', // Салфетки Flovell Care Б/З розовый
    '103219104_647985000', // Салфетки Flovell Care Б/З синий
    '104284145_831750178', // Салфетки Flovell Care Antibacterial
    '133571928_632713798', // Салфетки Flovell Care Fruits белый
    '121799583_793196731', // Губка AmaSafi меламин
    '143179480_976876548', // Меламиновая губка в упаковке
    '134183177_325849747'  // Губка универсальная 1033 меламин
  ],
  // Свой остаток для товаров, которых нет на складе (вместо стандартных 30 шт).
  // Срок предзаказа берётся из колонки Q «Дни доставки».
  XML_STOCK_OVERRIDES: {
    '117084019_902332516': 1, // Ручка Softy
    '117155763_322446166': 1, // Ручка Obama Marble
    '131632153_852180517': 1, // Ручка Obama OB-4451
    '143939533_807949210': 1, // Ручка Obama Smooth line
    '143939535_105675623': 1, // Ручка Obama Smoothline-3
    '107529846_411551632': 1, // Салфетки Flovell Care Б/З розовый
    '103219104_647985000': 1, // Салфетки Flovell Care Б/З синий
    '104284145_831750178': 1, // Салфетки Flovell Care Antibacterial
    '133571928_632713798': 1, // Салфетки Flovell Care Fruits белый
    '121799583_793196731': 1, // Губка AmaSafi меламин
    '143179480_976876548': 1, // Меламиновая губка в упаковке
    '134183177_325849747': 1  // Губка универсальная 1033 меламин
  },
  // Срок предзаказа для нулевого остатка; в текущем листе «Прайс KASPI»
  // в колонке Q («Дни доставки») для товаров указано 2 дня.
  XML_ZERO_STOCK_PREORDER_DAYS: 2,
  SHEET_BACKUP: '_KASPI_PRICE_BACKUP',
  SHEET_XML_STATUS: '_KASPI_XML_BUILD',
  SHEET_XML_ERRORS: '_KASPI_XML_ERRORS',

  // ---- Kaspi заказы ----
  ORDERS_URL: 'https://kaspi.kz/shop/api/v2/orders',
  ORDERS_PAGE_SIZE: 100,
  ORDERS_LOOKBACK_DAYS: 14,
  ORDERS_MAX_PAGES: 30,
  ORDERS_STATES: ['NEW', 'SIGN_REQUIRED', 'PICKUP', 'DELIVERY', 'KASPI_DELIVERY'],
  ORDERS_ACTIVE: ['APPROVED_BY_BANK', 'ACCEPTED_BY_MERCHANT', 'CANCELLING', 'KASPI_DELIVERY_RETURN_REQUESTED'],
  SHEET_RAW: 'KASPI_ЗАКАЗЫ',
  SHEET_KURDAI: 'Курдай',
  SHEET_ALMATY: 'Алматы заказы',
  SHEET_WB: 'Вайлберис',
  SHEET_ORDERS_STATUS: '_ORDER_SYNC_STATUS',
  SHEET_ORDERS_ERRORS: '_ORDER_SYNC_ERRORS',
  SHEET_PRODUCT_MAP: '_KASPI_PRODUCT_MAP',
  SHEET_PHOTOS: '_ORDER_PRODUCT_PHOTOS'
});


/* ============================================================
   МЕНЮ И УСТАНОВКА
   ============================================================ */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('GRANTS BOOK')
    .addItem('Первичная настройка (триггеры)', 'SETUP_ALL')
    .addSeparator()
    .addItem('Обновить цены WB сейчас', 'WB_RUN')
    .addItem('Обновить XML Kaspi сейчас', 'KASPI_XML_RUN')
    .addItem('Обновить заказы сейчас', 'ORDERS_RUN')
    .addSeparator()
    .addItem('Установить Kaspi API токен', 'SET_KASPI_TOKEN')
    .addItem('Подтвердить возврат на склад', 'KL_CONFIRM_RETURN_RESTOCK_PROMPT')
    .addItem('Показать триггеры и статусы', 'SHOW_STATUS')
    .addToUi();
}

/** Удаляет ВСЕ старые триггеры проекта и создаёт три новых. */
function SETUP_ALL() {
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', GB.SPREADSHEET_ID);

  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });

  ScriptApp.newTrigger('WB_RUN').timeBased().everyHours(GB.WB_EVERY_HOURS).create();
  ScriptApp.newTrigger('KASPI_XML_RUN').timeBased().everyMinutes(GB.XML_EVERY_MINUTES).create();
  ScriptApp.newTrigger('ORDERS_RUN').timeBased().everyMinutes(GB.ORDERS_EVERY_MINUTES).create();

  const msg = 'Созданы триггеры: WB каждые ' + GB.WB_EVERY_HOURS + ' ч, XML каждые ' +
    GB.XML_EVERY_MINUTES + ' мин, заказы каждые ' + GB.ORDERS_EVERY_MINUTES + ' мин.';
  console.log(msg);
  try { getSS_().toast(msg, 'GRANTS BOOK', 10); } catch (e) {}
  return msg;
}

function SET_KASPI_TOKEN() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('Kaspi API Token', 'Вставьте X-Auth-Token Kaspi (сохраняется в Script Properties, не в таблице).', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const token = String(r.getResponseText() || '').trim();
  if (!token) { ui.alert('Токен пустой.'); return; }
  PropertiesService.getScriptProperties().setProperty('KASPI_TOKEN', token);
  ui.alert('KASPI_TOKEN сохранён.');
}

function SHOW_STATUS() {
  const p = PropertiesService.getScriptProperties();
  console.log('Триггеры:');
  ScriptApp.getProjectTriggers().forEach(function (t) {
    console.log('  ' + t.getHandlerFunction() + ' | ' + t.getEventType());
  });
  console.log('KASPI_TOKEN: '***'KASPI_TOKEN') ? 'есть' : 'НЕТ'));
  console.log('XML_FILE_ID: ' + (p.getProperty('XML_FILE_ID') || 'нет'));
  console.log('WB последний результат: ' + (p.getProperty('WB_LAST_RESULT') || 'нет'));
  console.log('XML последний результат: ' + (p.getProperty('XML_LAST_RESULT') || 'нет'));
  console.log('Заказы последний результат: ' + (p.getProperty('ORDERS_LAST_RESULT') || 'нет'));
}


/* ============================================================
   ОБЩИЕ ФУНКЦИИ
   ============================================================ */

function getSS_() {
  return SpreadsheetApp.openById(GB.SPREADSHEET_ID);
}

function getOrCreateSheet_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function nowText_() {
  return Utilities.formatDate(new Date(), GB.TZ, 'dd.MM.yyyy HH:mm:ss');
}

function clean_(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/\u00A0/g, ' ').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function errText_(e) {
  return String(e && e.message ? e.message : e || 'Неизвестная ошибка');
}

function isQuotaError_(text) {
  return /too many times for one day|слишком много раз за день|urlfetch.*quota/i.test(String(text));
}

function saveResult_(key, obj) {
  try {
    PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(obj));
  } catch (e) { console.warn('Не удалось сохранить статус: ' + e); }
}

/** Повторяет операцию с таблицей при временной ошибке. */
function retry_(fn, what) {
  let last;
  for (let i = 1; i <= 3; i++) {
    try { return fn(); } catch (e) {
      last = e;
      console.warn(what + ': попытка ' + i + '/3: ' + e);
      Utilities.sleep(1500 * i);
    }
  }
  throw new Error(what + ' не удалось после 3 попыток: ' + errText_(last));
}

function chunk_(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function parseNumber_(value) {
  const t = String(value === null || value === undefined ? '' : value)
    .replace(/\u00A0/g, '').replace(/\s+/g, '').replace(/₸/g, '')
    .replace(/тенге/gi, '').replace(/тг/gi, '').replace(',', '.').trim();
  if (!t || !/^-?\d+(?:\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function xmlEscape_(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function normalizeSku_(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/\u00A0/g, '').replace(/[\r\n\t ]+/g, '').trim();
}


/* ============================================================
   1) WILDBERRIES — ЦЕНЫ
   Лист «Прайс KASPI»: T ссылка → U цена, V продавец,
   W дней доставки, X дата доставки, Y статус.
   Цена = минимум по размерам (price.product + price.logistics) / 100.
   ============================================================ */

function WB_RUN() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) { console.log('WB: предыдущий запуск ещё идёт.'); return; }
  const t0 = Date.now();

  try {
    const sheet = retry_(function () { return getSS_().getSheetByName(GB.PRICE_SHEET); }, 'Открытие листа');
    if (!sheet) throw new Error('Лист «' + GB.PRICE_SHEET + '» не найден.');

    const lastRow = retry_(function () { return sheet.getLastRow(); }, 'getLastRow');
    if (lastRow < 2) throw new Error('Нет товаров.');
    const rowCount = lastRow - 1;

    // T:Y — шесть колонок
    const data = [];
    chunk_(Array.from({ length: rowCount }, function (_, i) { return i; }), 1000).forEach(function (idx) {
      const part = retry_(function () {
        return sheet.getRange(2 + idx[0], GB.COL_WB_LINK, idx.length, 6).getValues();
      }, 'Чтение строк');
      part.forEach(function (r) { data.push(r); });
    });

    const geo = wbGeo_(false);
    const stamp = nowText_();

    // ID из ссылок
    const items = [];
    const uniqueIds = [];
    const seen = {};
    let invalid = 0;

    data.forEach(function (row, i) {
      const link = clean_(row[0]);
      if (!link) return;
      const id = wbExtractId_(link);
      if (!id) {
        invalid++;
        row[1] = GB.WB_NOT_FOUND;
        row[5] = 'Некорректная ссылка WB; ' + stamp;
        return;
      }
      items.push({ i: i, id: id });
      if (!seen[id]) { seen[id] = true; uniqueIds.push(id); }
    });

    const api = wbFetchProducts_(uniqueIds, geo, t0);

    let updated = 0, notFound = 0, skipped = 0, noPrice = 0;

    items.forEach(function (it) {
      const row = data[it.i];

      // Запрос к этому ID не прошёл (лимит времени, HTTP-ошибка, квота) — старую цену НЕ трогаем.
      if (!api.okIds[it.id]) {
        row[5] = 'Не обработано (ошибка/лимит). Старая цена сохранена; ' + stamp;
        skipped++;
        return;
      }

      const product = api.products[it.id];
      if (!product) {
        row[1] = GB.WB_NOT_FOUND;
        row[5] = 'Товар не найден WB; ' + stamp;
        notFound++;
        return;
      }

      const price = wbPrice_(product);
      const seller = clean_(product.supplier || product.supplierName || product.sellerName || '');
      if (!price) {
        row[1] = GB.WB_NOT_FOUND;
        if (seller) row[2] = seller;
        row[5] = 'Цена не найдена; ' + stamp;
        noPrice++;
        return;
      }

      row[1] = price.total;
      if (seller) row[2] = seller;
      const days = wbDeliveryDays_(product);
      if (days !== null) {
        row[3] = days;
        const d = new Date();
        d.setDate(d.getDate() + days);
        row[4] = d;
      }
      row[5] = 'Обновлено; ' + price.source + '; товар=' + price.product + '; логистика=' + price.logistics + '; ' + stamp;
      updated++;
    });

    // Записываем только U:Y
    const output = data.map(function (r) { return [r[1], r[2], r[3], r[4], r[5]]; });
    chunk_(output, 500).forEach(function (part, k) {
      retry_(function () {
        sheet.getRange(2 + k * 500, GB.COL_PRICE, part.length, 5).setValues(part);
      }, 'Запись строк');
      Utilities.sleep(150);
    });
    SpreadsheetApp.flush();

    const result = {
      ok: true, rows: rowCount, uniqueIds: uniqueIds.length, updated: updated,
      notFound: notFound, noPrice: noPrice, skipped: skipped, invalid: invalid,
      stoppedByTime: api.stoppedByTime, quota: api.quotaHit,
      seconds: Math.round((Date.now() - t0) / 1000), finishedAt: stamp
    };
    saveResult_('WB_LAST_RESULT', result);
    console.log(JSON.stringify(result));
    return result;

  } catch (e) {
    saveResult_('WB_LAST_RESULT', { ok: false, error: errText_(e), at: nowText_() });
    throw e;
  } finally {
    lock.releaseLock();
  }
}

function wbExtractId_(link) {
  const t = String(link).trim();
  const m = t.match(/\/catalog\/(\d+)/i) || t.match(/[?&]nm=(\d+)/i);
  if (m) return m[1];
  return /^\d{5,15}$/.test(t) ? t : '';
}

function wbGeo_(force) {
  const props = PropertiesService.getScriptProperties();
  const cached = props.getProperty('WB_GEO');
  const time = Number(props.getProperty('WB_GEO_TIME') || 0);

  if (!force && cached && time && Date.now() - time < 6 * 3600 * 1000) {
    try { return JSON.parse(cached); } catch (e) {}
  }

  const url = GB.WB_GEO_ENDPOINT + '?latitude=' + encodeURIComponent(GB.WB_LAT) +
    '&longitude=' + encodeURIComponent(GB.WB_LON) + '&address=' + encodeURIComponent(GB.WB_ADDRESS);
  const resp = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true, followRedirects: true,
    headers: { Accept: 'application/json', 'Accept-Language': 'ru-RU,ru;q=0.9', 'User-Agent': 'Mozilla/5.0' }
  });
  if (resp.getResponseCode() !== 200) throw new Error('WB GEO HTTP ' + resp.getResponseCode());

  let json;
  try { json = JSON.parse(resp.getContentText()); } catch (e) { throw new Error('WB GEO: неправильный JSON'); }
  const xinfo = String(json.xinfo || (json.data && json.data.xinfo) || (json.result && json.result.xinfo) || '').trim();
  if (!xinfo) throw new Error('WB GEO не вернул xinfo');

  const params = {};
  xinfo.replace(/^\?/, '').split('&').forEach(function (part) {
    if (!part) return;
    const eq = part.indexOf('=');
    const k = decodeURIComponent(eq < 0 ? part : part.slice(0, eq));
    const v = decodeURIComponent(eq < 0 ? '' : part.slice(eq + 1));
    if (k) params[k] = v;
  });

  const geo = { xinfo: xinfo, params: params };
  props.setProperty('WB_GEO', JSON.stringify(geo));
  props.setProperty('WB_GEO_TIME', String(Date.now()));
  return geo;
}

function wbUrl_(ids, geo) {
  let url = GB.WB_ENDPOINT + '?appType=1&curr=kzt&lang=ru&nm=' + encodeURIComponent(ids.join(';'));
  const params = (geo && geo.params) || {};
  Object.keys(params).forEach(function (k) {
    if (k === 'nm' || k === 'curr' || k === 'appType' || k === 'lang') return;
    url += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  });
  if (params.spp === undefined) url += '&spp=0';
  return url;
}

function wbFetchProducts_(ids, geo, t0) {
  const out = { products: {}, okIds: {}, stoppedByTime: false, quotaHit: false };
  if (!ids.length) return out;

  const waves = chunk_(chunk_(ids, GB.WB_IDS_PER_REQUEST), GB.WB_REQUESTS_PER_WAVE);

  for (let w = 0; w < waves.length; w++) {
    if (Date.now() - t0 > GB.WB_SOFT_LIMIT_MS) { out.stoppedByTime = true; break; }

    const wave = waves[w];
    const requests = wave.map(function (c) {
      return {
        url: wbUrl_(c, geo), method: 'get', muteHttpExceptions: true, followRedirects: true,
        headers: { Accept: 'application/json', 'Accept-Language': 'ru-RU,ru;q=0.9', 'User-Agent': 'Mozilla/5.0' }
      };
    });

    let responses;
    try {
      responses = UrlFetchApp.fetchAll(requests);
    } catch (e) {
      console.warn('WB fetchAll: ' + e);
      if (isQuotaError_(errText_(e))) { out.quotaHit = true; break; }
      continue;
    }

    responses.forEach(function (resp, k) {
      const code = resp.getResponseCode();
      if (code !== 200) { console.warn('WB HTTP ' + code); return; }
      try {
        const json = JSON.parse(resp.getContentText() || '{}');
        const list = (json.data && Array.isArray(json.data.products)) ? json.data.products
          : Array.isArray(json.products) ? json.products
          : (json.data && Array.isArray(json.data)) ? json.data : null;
        if (!list) return;

        // Успешный разбор — только тогда считаем ID «проверенными».
        wave[k].forEach(function (id) { out.okIds[id] = true; });
        list.forEach(function (p) {
          const id = String(p && (p.id || p.nmId || p.nmID) || '').replace(/\D/g, '');
          if (id) out.products[id] = p;
        });
      } catch (e) {
        console.warn('WB JSON: ' + e);
      }
    });

    if (w < waves.length - 1) Utilities.sleep(GB.WB_WAVE_DELAY_MS);
  }
  return out;
}

function wbPrice_(p) {
  let best = null;

  (Array.isArray(p.sizes) ? p.sizes : []).forEach(function (s) {
    const pr = s && s.price;
    if (!pr) return;
    const prod = Math.round(Number(pr.product) / 100);
    if (!(prod > 0)) return;
    const logRaw = Number(pr.logistics);
    const log = logRaw > 0 ? Math.round(logRaw / 100) : 0;
    const total = prod + log;
    if (total >= GB.MIN_PRICE && total <= GB.MAX_PRICE && (!best || total < best.total)) {
      best = { total: total, product: prod, logistics: log, source: 'sizes.product+logistics' };
    }
  });
  if (best) return best;

  const sale = Math.round(Number(p.salePriceU) / 100);
  if (sale >= GB.MIN_PRICE && sale <= GB.MAX_PRICE) {
    return { total: sale, product: sale, logistics: 0, source: 'salePriceU-fallback' };
  }
  return null;
}

function wbDeliveryDays_(p) {
  const direct = [p.deliveryDays, p.deliveryDuration, p.delivery && p.delivery.days];
  for (let i = 0; i < direct.length; i++) {
    const v = Number(direct[i]);
    if (Number.isFinite(v) && v >= 0 && v <= 90 && direct[i] !== null && direct[i] !== undefined) return Math.ceil(v);
  }
  const hours = (Array.isArray(p.sizes) ? p.sizes : [])
    .map(function (s) { return (Number(s && s.time1) || 0) + (Number(s && s.time2) || 0); })
    .filter(function (h) { return h > 0; });
  return hours.length ? Math.ceil(Math.min.apply(null, hours) / 24) : null;
}


/* ============================================================
   2) KASPI XML
   Читает «Прайс KASPI»: A артикул, B название, Q предзаказ, U цена.
   Доступный остаток берёт из СКЛАД_НАЛИЧИЕ. Пишет XML в Drive; doGet отдаёт его.
   ============================================================ */

function KASPI_XML_RUN() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { console.log('XML: предыдущее обновление ещё идёт.'); return; }

  try {
    const ss = getSS_();
    const built = buildXml_(ss);
    const file = saveXmlFile_(ss, built.xml);
    if (typeof klMarkPriceQueuePublished_ === 'function' &&
        typeof klIsDryRun_ === 'function' && !klIsDryRun_()) {
      klMarkPriceQueuePublished_();
    }

    PropertiesService.getScriptProperties().setProperties({
      XML_FILE_ID: file.getId(),
      LAST_UPDATED: built.updatedAt,
      LAST_OFFERS: String(built.offers),
      LAST_SKIPPED: String(built.skipped),
      LAST_WARNINGS: String(built.warnings),
      LAST_BACKUP_PRICES: String(built.backupUsed),
      LAST_XML_SIZE: String(built.xml.length)
    });

    writeXmlStatus_(ss, built, file);
    writeXmlErrorsIfChanged_(ss, built.errors);

    const result = {
      ok: true, offers: built.offers, skipped: built.skipped, warnings: built.warnings,
      backupUsed: built.backupUsed, updatedAt: built.updatedAt
    };
    saveResult_('XML_LAST_RESULT', result);
    console.log(JSON.stringify(result));
    return result;

  } catch (e) {
    saveResult_('XML_LAST_RESULT', { ok: false, error: errText_(e), at: nowText_() });
    throw e;
  } finally {
    lock.releaseLock();
  }
}

/** Веб-приложение: Kaspi/Vercel получает XML по этой ссылке. ?status=1 — статус. */
function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    const props = PropertiesService.getScriptProperties();

    // Flip XML (Flip.gs). Без ?feed=flip ниже всё работает как раньше.
    if (params.feed === 'flip' && typeof FLIP_DOGET_ === 'function') return FLIP_DOGET_(params);

    if (params.status === '1') {
      return ContentService.createTextOutput(JSON.stringify({
        ok: Boolean(props.getProperty('XML_FILE_ID')),
        service: 'GRANTS BOOK Kaspi XML',
        updatedAt: props.getProperty('LAST_UPDATED'),
        offers: Number(props.getProperty('LAST_OFFERS') || 0),
        skipped: Number(props.getProperty('LAST_SKIPPED') || 0),
        warnings: Number(props.getProperty('LAST_WARNINGS') || 0),
        backupPricesUsed: Number(props.getProperty('LAST_BACKUP_PRICES') || 0),
        xmlSize: Number(props.getProperty('LAST_XML_SIZE') || 0)
      }, null, 2)).setMimeType(ContentService.MimeType.JSON);
    }

    let id = props.getProperty('XML_FILE_ID');
    if (!id) { KASPI_XML_RUN(); id = props.getProperty('XML_FILE_ID'); }
    if (!id) throw new Error('XML ещё не создан. Запустите KASPI_XML_RUN.');

    const xml = DriveApp.getFileById(id).getBlob().getDataAsString('UTF-8');
    xmlValidate_(xml);
    return ContentService.createTextOutput(xml).setMimeType(ContentService.MimeType.TEXT);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: errText_(err) }, null, 2))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/** Артикул из списка исключений с низкой ценой. */
function xmlLowPriceSku_(sku) {
  return GB.XML_LOW_PRICE_SKUS.indexOf(normalizeSku_(sku)) >= 0;
}

/** Цена допустима: от XML_MIN_PRICE (для исключений — от XML_LOW_PRICE_MIN) до XML_MAX_PRICE. */
function xmlAllowedPrice_(v, sku) {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n) || n > GB.XML_MAX_PRICE) return false;
  const min = (sku && xmlLowPriceSku_(sku)) ? GB.XML_LOW_PRICE_MIN : GB.XML_MIN_PRICE;
  return n >= min;
}

function buildXml_(ss, options) {
  options = options || {};
  const reportOnly = options.reportOnly === true;
  const sheet = ss.getSheetByName(GB.PRICE_SHEET);
  if (!sheet) throw new Error('Не найден лист «' + GB.PRICE_SHEET + '».');
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error('На листе нет товаров.');
  const n = lastRow - 1;

  // Читаем только нужные колонки (а не все 21)
  const ab = sheet.getRange(2, GB.COL_SKU, n, 2).getDisplayValues();
  const q = sheet.getRange(2, GB.COL_PREORDER, n, 1).getDisplayValues();
  const u = sheet.getRange(2, 14, n, 1).getValues(); // N — Цена Kaspi (числом)
  const wh = sheet.getRange(2, 3, n, 1).getValues(); // C — оптовая цена
  // XML получает доступный остаток только из СКЛАД_НАЛИЧИЕ.
  // SKLAD_getAvailableMap уже вычитает активные заказы, поэтому ledger здесь
  // не применяется повторно и старый P не используется как источник наличия.
  let skladAvailability;
  try {
    if (typeof SKLAD_getAvailableMap !== 'function') {
      throw new Error('Не найдена функция SKLAD_getAvailableMap() из Sklad.gs.');
    }
    skladAvailability = kaspiRequireNonEmptySkladAvailabilityIndex_(SKLAD_getAvailableMap());
  } catch (stockError) {
    const reason = errText_(stockError);
    if (!reportOnly) {
      try {
        writeXmlErrorsIfChanged_(ss, [kaspiSkladSourceErrorRow_(reason)]);
      } catch (logError) {
        console.error('Не удалось записать причину пустой карты склада в ' + GB.SHEET_XML_ERRORS + ': ' + errText_(logError));
      }
    }
    // Сборка прерывается до saveXmlFile_(), поэтому последний рабочий XML остаётся на месте.
    throw stockError;
  }

  const updatedAt = Utilities.formatDate(new Date(), GB.TZ, 'yyyy-MM-dd HH:mm:ss');
  const backup = readBackup_(ss, reportOnly);
  let backupChanged = false;

  const used = new Set();
  const errors = [];
  const stockReport = [];
  const parts = [];
  let offers = 0, skipped = 0, warnings = 0, backupUsed = 0;

  function err(row, sku, type, msg) { errors.push([row, clean_(sku), type, msg]); }

  parts.push('<?xml version="1.0" encoding="utf-8"?>');
  parts.push('<kaspi_catalog date="' + xmlEscape_(updatedAt) + '" xmlns="kaspiShopping"' +
    ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"' +
    ' xsi:schemaLocation="kaspiShopping http://kaspi.kz/kaspishopping.xsd">');
  parts.push('  <company>' + xmlEscape_(GB.XML_COMPANY) + '</company>');
  parts.push('  <merchantid>' + xmlEscape_(GB.XML_MERCHANT_ID) + '</merchantid>');
  parts.push('  <offers>');

  for (let i = 0; i < n; i++) {
    const sheetRow = i + 2;
    const rawSku = ab[i][0];
    if (!clean_(rawSku)) continue;

    const sku = normalizeSku_(rawSku);
    const model = clean_(ab[i][1]);

    if (!sku) { err(sheetRow, rawSku, 'ОШИБКА', 'Пустой артикул.'); skipped++; continue; }
    if (sku.length > 20) { err(sheetRow, sku, 'ОШИБКА', 'Артикул длиннее 20 символов.'); skipped++; continue; }
    if (!/^[A-Za-z0-9_-]+$/.test(sku)) { err(sheetRow, sku, 'ОШИБКА', 'Недопустимые символы в артикуле.'); skipped++; continue; }
    if (used.has(sku)) { err(sheetRow, sku, 'ОШИБКА', 'Повторяющийся артикул.'); skipped++; continue; }
    if (!model) { err(sheetRow, sku, 'ОШИБКА', 'Пустое название в колонке B.'); skipped++; continue; }

    const pre = parsePreorder_(q[i][0]);
    pre.isSet = clean_(q[i][0]) !== '' && !pre.warning;
    if (pre.warning) { warnings++; err(sheetRow, sku, 'ПРЕДУПРЕЖДЕНИЕ', pre.warning); }
    let availability = kaspiAvailabilityForSkladSku_(
      sku, skladAvailability, pre, GB.XML_STORE_ID, GB.XML_ZERO_STOCK_PREORDER_DAYS
    );
    // Свой остаток для артикулов из XML_STOCK_OVERRIDES, если товара нет на складе
    const skladQty = Object.prototype.hasOwnProperty.call(skladAvailability, sku) ? skladAvailability[sku] : 0;
    const stockOverride = Object.prototype.hasOwnProperty.call(GB.XML_STOCK_OVERRIDES, sku)
      ? Math.max(0, Math.floor(Number(GB.XML_STOCK_OVERRIDES[sku]) || 0)) : null;
    if (stockOverride !== null && stockOverride > 0 && !(skladQty > 0)) {
      availability = '<availability available="yes" storeId="' + xmlEscape_(GB.XML_STORE_ID) + '"' +
        ' preOrder="' + kaspiPreorderDays_(0, pre, GB.XML_ZERO_STOCK_PREORDER_DAYS) + '"' +
        ' stockCount="' + stockOverride + '"/>';
    }
    stockReport.push(kaspiSkladReportRow_(
      sku, q[i][0], skladAvailability, pre, GB.XML_ZERO_STOCK_PREORDER_DAYS
    ));

    const rawPrice = u[i][0];
    const parsed = parseNumber_(rawPrice);
    let price = null;

    if (xmlAllowedPrice_(parsed, sku)) {
      price = Math.round(parsed);
      const old = backup.get(sku);
      if (!old || old.price !== price) {
        backup.set(sku, { price: price, updatedAt: updatedAt });
        backupChanged = true;
      }
    }

    let unavailable = false;
    if (price === null) {
      err(sheetRow, sku, 'НЕТ ЦЕНЫ', 'Товар снят с наличия: в N нет корректной цены («' + rawPrice + '»).');
      const old = backup.get(sku);
      price = (old && xmlAllowedPrice_(old.price, sku)) ? Math.round(Number(old.price)) : GB.XML_MIN_PRICE;
      unavailable = true;
      skipped++;
    }

    // Защита: цена не должна быть ниже оптовой + 5% (кроме артикулов-исключений)
    const whNum = parseNumber_(wh[i][0]);
    if (!xmlLowPriceSku_(sku) && whNum !== null && whNum > 0 && price < whNum * 1.05) {
      err(sheetRow, sku, 'НИЖЕ ОПТОВОЙ', 'Товар снят с наличия: цена ' + price + ' ₸ ниже оптовой ' + whNum + ' ₸ + 5%.');
      unavailable = true;
      skipped++;
    }

    // Наличие уже рассчитано в SKLAD_getAvailableMap() с учётом резервов.

    parts.push('    <offer sku="' + xmlEscape_(sku) + '">');
    parts.push('      <model>' + xmlEscape_(model) + '</model>');
    parts.push('      <brand>' + xmlEscape_(GB.XML_BRAND) + '</brand>');
    parts.push('      <availabilities>');
    parts.push('        ' + (unavailable ? '<availability available="no" storeId="' + xmlEscape_(GB.XML_STORE_ID) + '"/>' : availability));
    parts.push('      </availabilities>');
    parts.push('      <price>' + price + '</price>');
    parts.push('    </offer>');

    used.add(sku);
    offers++;
  }

  parts.push('  </offers>');
  parts.push('</kaspi_catalog>');
  const xml = parts.join('\n');

  if (offers === 0) {
    if (!reportOnly) writeXmlErrorsIfChanged_(ss, errors);
    throw new Error('XML не создан: нет ни одного товара с корректной ценой.');
  }
  xmlValidate_(xml);

  // Резервные цены перезаписываем только при изменениях
  if (backupChanged && !reportOnly) writeBackup_(ss, backup);

  return { xml: xml, updatedAt: updatedAt, offers: offers, skipped: skipped, warnings: warnings, backupUsed: backupUsed, errors: errors, stockReport: stockReport };
}

/** Чистый отчёт по одному SKU для сверки склада и preOrder. */
function kaspiSkladReportRow_(sku, qValue, stockIndex, preorder, defaultDays) {
  const key = normalizeSku_(sku);
  const stockCount = Object.prototype.hasOwnProperty.call(stockIndex, key)
    ? Math.max(0, Number(stockIndex[key]) || 0) : 0;
  const parsed = preorder || parsePreorder_(qValue);
  return {
    sku: key,
    stockCount: stockCount,
    qDays: clean_(qValue),
    available: 'yes',
    preOrder: kaspiPreorderDays_(stockCount, parsed, defaultDays)
  };
}

/**
 * Только собирает XML и показывает отчёт по активной копии таблицы.
 * Не создаёт/не изменяет XML-файлы, свойства, листы статуса или резервных цен.
 */
function KASPI_XML_REPORT_ONLY() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Откройте копию таблицы и запускайте отчёт из её Apps Script.');
  if (ss.getId() === GB.SPREADSHEET_ID) {
    throw new Error('Отчёт остановлен: активна основная таблица, а не её копия.');
  }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Другая синхронизация сейчас выполняется.');
  try {
    const built = buildXml_(ss, {reportOnly: true});
    const report = {
      mode: 'REPORT_ONLY_NO_PUBLISH',
      spreadsheetId: ss.getId(),
      offers: built.offers,
      skipped: built.skipped,
      warnings: built.warnings,
      xmlSize: built.xml.length,
      products: built.stockReport
    };
    console.log('XML отчёт, без публикации: ' + JSON.stringify({
      mode: report.mode, spreadsheetId: report.spreadsheetId,
      offers: report.offers, skipped: report.skipped,
      warnings: report.warnings, products: report.products.length
    }));
    const chunkSize = 100;
    for (let i = 0; i < report.products.length; i += chunkSize) {
      console.log('Товары ' + (i + 1) + '–' + Math.min(i + chunkSize, report.products.length) + ': ' +
        JSON.stringify(report.products.slice(i, i + chunkSize)));
    }
    return report;
  } finally {
    lock.releaseLock();
  }
}

/** Чисто нормализует карту склада по тем же правилам, что SKU XML. */
function kaspiBuildSkladAvailabilityIndex_(rawMap) {
  if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) {
    throw new Error('SKLAD_getAvailableMap() должна вернуть объект {артикул: количество}.');
  }
  const index = Object.create(null);
  Object.keys(rawMap).forEach(function (rawSku) {
    const sku = normalizeSku_(rawSku);
    if (!sku) return;
    const quantity = Number(rawMap[rawSku]);
    if (!Number.isFinite(quantity) || quantity < 0) {
      throw new Error('Некорректное количество склада для артикула «' + sku + '».');
    }
    if (Object.prototype.hasOwnProperty.call(index, sku)) {
      throw new Error('Дублирующийся артикул склада после нормализации: «' + sku + '».');
    }
    index[sku] = Math.floor(quantity);
  });
  return index;
}

/** Останавливает сборку, если склад не вернул ни одного SKU. */
function kaspiRequireNonEmptySkladAvailabilityIndex_(rawMap) {
  const index = kaspiBuildSkladAvailabilityIndex_(rawMap);
  if (Object.keys(index).length === 0) {
    throw new Error('SKLAD_getAvailableMap() вернула пустую карту: лист СКЛАД_НАЛИЧИЕ отсутствует, пуст или не содержит доступных SKU. XML не обновлён.');
  }
  return index;
}

function kaspiSkladSourceErrorRow_(message) {
  return ['', '', 'ОШИБКА ИСТОЧНИКА ОСТАТКОВ', String(message || 'Пустая карта склада.')];
}

/** Формирует XML наличия одного SKU только по индексу листа СКЛАД_НАЛИЧИЕ. */
function kaspiAvailabilityForSkladSku_(sku, skladIndex, preorder, storeId, defaultDays) {
  const normalized = normalizeSku_(sku);
  const exists = Object.prototype.hasOwnProperty.call(skladIndex, normalized);
  const quantity = exists ? skladIndex[normalized] : 0;
  const hasStock = quantity > 0;
  return kaspiAvailabilityXml_(
    {available: hasStock ? 'yes' : 'no', stockCount: quantity},
    preorder,
    storeId,
    defaultDays
  );
}

/** Общее правило срока для XML и отчёта: запас → 0, иначе Q>0 до 30, fallback 2. */
function kaspiPreorderDays_(stockCount, preorder, defaultDays) {
  if (Number(stockCount) > 0) return 0;
  const fallback = Math.max(1, Math.min(30, Math.floor(Number(defaultDays) || 2)));
  const qDays = Math.floor(Number(preorder && preorder.days) || 0);
  return qDays > 0 ? Math.min(30, qDays) : fallback;
}

/** Ручные проверки XML-правила карты склада без обращения к Google Sheets. */
function KASPI_XML_TEST_skladAvailability_() {
  const map = kaspiBuildSkladAvailabilityIndex_({' SKU-1 ': 3, 'SKU-2': 0});
  const present = kaspiAvailabilityForSkladSku_('SKU-1', map, {days: 4, isSet: true}, 'PP1', 2);
  const zeroPresent = kaspiAvailabilityForSkladSku_('SKU-2', map, {days: 4, isSet: true}, 'PP1', 2);
  const missingWithQ = kaspiAvailabilityForSkladSku_('SKU-3', map, {days: 4, isSet: true}, 'PP1', 2);
  const missingWithoutQ = kaspiAvailabilityForSkladSku_('SKU-3', map, {days: 0, isSet: false}, 'PP1', 2);
  const cases = [
    [present, 'stockCount="3"', 'preOrder="0"'],
    [zeroPresent, 'preOrder="4"'],
    [missingWithQ, 'preOrder="4"'],
    [missingWithoutQ, 'preOrder="2"']
  ];
  cases.forEach(function (test, i) {
    if (test[0].indexOf('available="yes"') < 0 || test[0].indexOf('available="no"') >= 0 ||
        test.slice(1).some(function (expected) { return test[0].indexOf(expected) < 0; })) {
      throw new Error('Проверка карты склада №' + (i + 1) + ' не пройдена: ' + test[0]);
    }
  });
  let duplicateRejected = false;
  try { kaspiBuildSkladAvailabilityIndex_({'SKU 1': 1, 'SKU1': 2}); }
  catch (error) { duplicateRejected = true; }
  if (!duplicateRejected) throw new Error('Нормализующийся дубликат артикула должен быть отклонён.');
  return 'OK: 5 проверок XML availability из карты склада';
}

/** Проверяет требуемые три сценария отчёта без Google Sheets/Drive. */
function KASPI_XML_TEST_reportRows_() {
  const stock = {IN_STOCK: 2, ZERO_Q0: 0, EMPTY_Q: 0, FIVE_DAYS: 0, FORTY_FIVE_DAYS: 0};
  const q0 = parsePreorder_('0'); q0.isSet = true;
  const qEmpty = parsePreorder_(''); qEmpty.isSet = false;
  const q5 = parsePreorder_('5'); q5.isSet = true;
  const q45 = parsePreorder_('45'); q45.isSet = false;
  const rows = [
    kaspiSkladReportRow_('ZERO_Q0', '0', stock, q0, 2),
    kaspiSkladReportRow_('EMPTY_Q', '', stock, qEmpty, 2),
    kaspiSkladReportRow_('FIVE_DAYS', '5', stock, q5, 2),
    kaspiSkladReportRow_('FORTY_FIVE_DAYS', '45', stock, q45, 2),
    kaspiSkladReportRow_('IN_STOCK', '45', stock, q45, 2)
  ];
  const expected = [
    {sku: 'ZERO_Q0', stockCount: 0, qDays: '0', available: 'yes', preOrder: 2},
    {sku: 'EMPTY_Q', stockCount: 0, qDays: '', available: 'yes', preOrder: 2},
    {sku: 'FIVE_DAYS', stockCount: 0, qDays: '5', available: 'yes', preOrder: 5},
    {sku: 'FORTY_FIVE_DAYS', stockCount: 0, qDays: '45', available: 'yes', preOrder: 30},
    {sku: 'IN_STOCK', stockCount: 2, qDays: '45', available: 'yes', preOrder: 0}
  ];
  if (JSON.stringify(rows) !== JSON.stringify(expected)) {
    throw new Error('Отчёт по наличию не совпадает с тремя сценариями: ' + JSON.stringify(rows));
  }
  const xmlCases = [
    ['ZERO_Q0', q0, 'preOrder="2"'],
    ['EMPTY_Q', qEmpty, 'preOrder="2"'],
    ['FIVE_DAYS', q5, 'preOrder="5"'],
    ['FORTY_FIVE_DAYS', q45, 'preOrder="30"'],
    ['IN_STOCK', q45, 'preOrder="0"']
  ];
  xmlCases.forEach(function (test) {
    const xml = kaspiAvailabilityForSkladSku_(test[0], stock, test[1], 'PP1', 2);
    if (xml.indexOf('available="yes"') < 0 || xml.indexOf(test[2]) < 0) {
      throw new Error('XML и отчёт расходятся для ' + test[0] + ': ' + xml);
    }
  });
  return 'OK: Q=0, пустая Q, Q=5, Q=45, положительный остаток; XML совпадает с отчётом';
}

/** Чистая проверка защитного отказа на пустой карте остатков. */
function KASPI_XML_TEST_emptySkladMap_() {
  let rejected = false;
  try { kaspiRequireNonEmptySkladAvailabilityIndex_({}); }
  catch (error) {
    rejected = /пустую карту/i.test(error.message) && /XML не обновлён/i.test(error.message);
  }
  if (!rejected) throw new Error('Пустая карта должна остановить сборку XML.');
  const row = kaspiSkladSourceErrorRow_('пустая карта');
  if (row[2] !== 'ОШИБКА ИСТОЧНИКА ОСТАТКОВ' || row[3] !== 'пустая карта') {
    throw new Error('Причина отказа не подготовлена для _KASPI_XML_ERRORS.');
  }
  const usable = kaspiRequireNonEmptySkladAvailabilityIndex_({SKU1: 1});
  if (usable.SKU1 !== 1) throw new Error('Непустая карта должна пройти проверку.');
  return 'OK: пустая карта блокирует XML, причина логируется, непустая карта проходит';
}

/** Чистая функция: формирует XML наличия, не обращаясь к таблице или API. */
function kaspiAvailabilityXml_(stock, preorder, storeId, defaultPreorderDays) {
  // available всегда yes; срок рассчитывается тем же правилом, что и отчёт.
  const stockCount = Number(stock && stock.stockCount) || 0;
  const hasStock = stockCount > 0;
  const attrs = ['available="yes"', 'storeId="' + xmlEscape_(storeId) + '"'];
  if (hasStock) {
    attrs.push('preOrder="0"');
    attrs.push('stockCount="' + Math.max(0, stockCount) + '"');
  } else {
    attrs.push('preOrder="' + kaspiPreorderDays_(stockCount, preorder, defaultPreorderDays) + '"');
    attrs.push('stockCount="30"');
  }
  return '<availability ' + attrs.join(' ') + '/>';
}

/** Ручные проверки чистой функции наличия; не читает и не меняет таблицу. */
function KASPI_XML_TEST_availability_() {
  const cases = [
    {name: 'положительный остаток: preOrder 0', stock: {available: 'yes', stockCount: 1}, pre: {days: 4}, expected: 'preOrder="0"'},
    {name: 'нет SKU на складе: срок строки Q', stock: {available: 'no', stockCount: 0}, pre: {days: 3, isSet: true}, expected: 'preOrder="3"'},
    {name: 'нет SKU на складе: Q равно 0', stock: {available: 'no', stockCount: 0}, pre: {days: 0, isSet: true}, expected: 'preOrder="2"'},
    {name: 'нет SKU на складе: пустое Q использует N', stock: {available: 'no', stockCount: 0}, pre: {days: 0, isSet: false}, expected: 'preOrder="2"'}
  ];
  cases.forEach(function (test) {
    const xml = kaspiAvailabilityXml_(test.stock, test.pre, 'PP1', 2);
    if (xml.indexOf('available="yes"') < 0 || xml.indexOf('available="no"') >= 0 ||
        xml.indexOf(test.expected) < 0) {
      throw new Error('Проверка не пройдена: ' + test.name + ' → ' + xml);
    }
  });
  return 'OK: ' + cases.length + ' проверок XML availability';
}

function xmlValidate_(xml) {
  const t = String(xml || '').trim();
  if (!t) throw new Error('XML пустой.');
  if (!/<kaspi_catalog\b/i.test(t) || !/<\/kaspi_catalog>/i.test(t)) throw new Error('Нет тега kaspi_catalog.');
  if (!/<offers\b/i.test(t) || !/<\/offers>/i.test(t)) throw new Error('Нет раздела offers.');
  const bad = Array.from(t.matchAll(/<price>(\d+)<\/price>/gi))
    .map(function (m) { return Number(m[1]); })
    .find(function (p) { return !(p >= Math.min(GB.XML_MIN_PRICE, GB.XML_LOW_PRICE_MIN) && p <= GB.XML_MAX_PRICE); });
  if (bad !== undefined) throw new Error('В XML запрещённая цена: ' + bad + ' ₸.');
}

function parseStock_(value) {
  const t = clean_(value).toLowerCase();
  if (t === 'yes' || t === 'да') return { available: 'yes', stockCount: null, warning: null };
  if (t === 'no' || t === 'нет' || t === '') return { available: 'no', stockCount: 0, warning: null };
  const num = parseNumber_(value);
  if (num === null) return { available: 'no', stockCount: 0, warning: 'Некорректный остаток в P: «' + value + '». Установлен 0.' };
  const c = Math.max(0, Math.floor(num));
  return { available: c > 0 ? 'yes' : 'no', stockCount: c, warning: null };
}

function parsePreorder_(value) {
  if (!clean_(value)) return { days: 0, warning: null };
  const num = parseNumber_(value);
  if (num === null) return { days: 0, warning: 'Некорректный срок предзаказа в Q: «' + value + '». Предзаказ отключён.' };
  const d = Math.floor(num);
  if (d < 0) return { days: 0, warning: 'Отрицательный срок предзаказа. Отключён.' };
  if (d > 30) return { days: 30, warning: 'Предзаказ больше 30 дней. Установлено 30.' };
  return { days: d, warning: null };
}

function readBackup_(ss, readOnly) {
  const map = new Map();
  let sh = ss.getSheetByName(GB.SHEET_BACKUP);
  if (!sh) {
    if (readOnly) return map;
    sh = ss.insertSheet(GB.SHEET_BACKUP);
    sh.getRange('A1:C1').setValues([['SKU', 'Последняя корректная цена', 'Дата обновления']]);
    sh.hideSheet();
    return map;
  }
  const last = sh.getLastRow();
  if (last < 2) return map;
  sh.getRange(2, 1, last - 1, 3).getValues().forEach(function (r) {
    const sku = normalizeSku_(r[0]);
    const price = Number(r[1]);
    if (sku && xmlAllowedPrice_(price, sku)) map.set(sku, { price: price, updatedAt: clean_(r[2]) });
  });
  return map;
}

function writeBackup_(ss, backup) {
  const sh = getOrCreateSheet_(ss, GB.SHEET_BACKUP);
  const values = [['SKU', 'Последняя корректная цена', 'Дата обновления']];
  backup.forEach(function (d, sku) {
    if (xmlAllowedPrice_(d.price, sku)) values.push([sku, Math.round(Number(d.price)), d.updatedAt || '']);
  });
  sh.clearContents();
  sh.getRange(1, 1, values.length, 3).setValues(values);
  sh.getRange('A1:C1').setFontWeight('bold');
  if (!sh.isSheetHidden()) sh.hideSheet();
}

function saveXmlFile_(ss, xml) {
  const props = PropertiesService.getScriptProperties();
  const existing = props.getProperty('XML_FILE_ID');

  if (existing) {
    try {
      const f = DriveApp.getFileById(existing);
      f.setContent(xml);
      return f;
    } catch (e) {
      console.warn('Старый XML-файл не найден, создаётся новый.');
    }
  }

  const parents = DriveApp.getFileById(ss.getId()).getParents();
  const folder = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  const file = folder.createFile(Utilities.newBlob(xml, 'application/xml', GB.XML_FILE_NAME));
  file.setDescription('Автоматический XML-прайс GRANTS BOOK для Kaspi.');
  props.setProperty('XML_FILE_ID', file.getId());
  return file;
}

function writeXmlStatus_(ss, r, file) {
  const sh = getOrCreateSheet_(ss, GB.SHEET_XML_STATUS);
  const values = [
    ['Параметр', 'Значение'],
    ['Статус', 'XML успешно создан'],
    ['Дата обновления', r.updatedAt],
    ['Источник цены', 'U — цена WB'],
    ['Минимальная цена', GB.XML_MIN_PRICE],
    ['Код склада', GB.XML_STORE_ID],
    ['Товаров в XML', r.offers],
    ['Пропущено строк', r.skipped],
    ['Предупреждений', r.warnings],
    ['Резервных цен', r.backupUsed],
    ['Размер XML', r.xml.length],
    ['ID XML-файла', file.getId()],
    ['Файл в Drive', file.getUrl()]
  ];
  sh.getRange(1, 1, values.length, 2).setValues(values);
  sh.getRange('A1:B1').setFontWeight('bold');
}

/** Лист ошибок перезаписывается только если список ошибок изменился. */
function writeXmlErrorsIfChanged_(ss, errors) {
  const props = PropertiesService.getScriptProperties();
  const hash = Utilities.base64Encode(
    Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify(errors), Utilities.Charset.UTF_8));
  if (props.getProperty('XML_ERR_HASH') === hash) return;

  const sh = getOrCreateSheet_(ss, GB.SHEET_XML_ERRORS);
  const header = [['Строка', 'Артикул', 'Тип', 'Описание']];
  const values = errors.length ? header.concat(errors) : header.concat([['', '', 'OK', 'Ошибок нет']]);
  sh.clearContents();
  sh.getRange(1, 1, values.length, 4).setValues(values);
  sh.getRange('A1:D1').setFontWeight('bold');
  props.setProperty('XML_ERR_HASH', hash);
}


/* ============================================================
   3) ЗАКАЗЫ KASPI → Курдай / Алматы / Вайлберис
   OPT… → Курдай, WB… → Вайлберис, остальное → Алматы.
   ============================================================ */

function ORDERS_RUN() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(2000)) { console.log('Заказы: другой процесс уже идёт.'); return; }
  const t0 = Date.now();
  const ss = getSS_();

  try {
    const token = String(PropertiesService.getScriptProperties().getProperty('KASPI_TOKEN') || '').trim();
    if (!token) throw new Error('Не установлен KASPI_TOKEN (меню GRANTS BOOK → Установить Kaspi API токен).');

    const now = new Date();
    const orders = fetchOrders_(token, now);
    const names = loadMap_(ss, GB.SHEET_PRODUCT_MAP, 1, 2); // B артикул → C название
    const photos = loadMap_(ss, GB.SHEET_PHOTOS, 0, 1);     // A артикул → B url

    writeRawOrders_(ss, orders);

    const dash = buildDashboards_(orders, names, photos, now);
    writeDashboard_(ss, GB.SHEET_KURDAI, dash.kurdai);
    writeDashboard_(ss, GB.SHEET_ALMATY, dash.almaty);
    writeDashboard_(ss, GB.SHEET_WB, dash.wb);

    const units = orders.reduce(function (t, o) {
      return t + (o.entries || []).reduce(function (s, e) { return s + Math.max(1, Number(e.quantity || 1)); }, 0);
    }, 0);

    writeOrdersStatus_(ss, true, {
      summary: 'OK: Курдай ' + dash.kurdai.length + ', Алматы ' + dash.almaty.length + ', Вайлберис ' + dash.wb.length,
      orders: orders.length, units: units, ms: Date.now() - t0, now: now
    });
    saveResult_('ORDERS_LAST_RESULT', { ok: true, orders: orders.length, at: nowText_() });
    SpreadsheetApp.flush();

  } catch (e) {
    try {
      writeOrdersStatus_(ss, false, { summary: 'Ошибка: ' + errText_(e).slice(0, 1000), ms: Date.now() - t0, now: new Date() });
      appendOrdersError_(ss, e);
    } catch (logErr) { console.error(logErr); }
    saveResult_('ORDERS_LAST_RESULT', { ok: false, error: errText_(e), at: nowText_() });
    throw e;
  } finally {
    lock.releaseLock();
  }
}

function fetchOrders_(token, now) {
  const to = now.getTime();
  const from = to - GB.ORDERS_LOOKBACK_DAYS * 86400000 + 60000;
  const byCode = new Map();

  GB.ORDERS_STATES.forEach(function (state) {
    let page = 0, pageCount = 1;
    while (page < pageCount && page < GB.ORDERS_MAX_PAGES) {
      const json = fetchKaspiJson_(ordersUrl_(state, page, from, to), token);
      normalizeOrdersPage_(json).forEach(function (o) { if (o.code) byCode.set(String(o.code), o); });
      pageCount = Math.max(1, Number(json && json.meta && json.meta.pageCount || 1));
      page++;
    }
  });

  return Array.from(byCode.values()).sort(function (a, b) {
    return Number(b.creationDate || 0) - Number(a.creationDate || 0);
  });
}

function ordersUrl_(state, page, from, to) {
  const p = {
    'page[number]': page,
    'page[size]': GB.ORDERS_PAGE_SIZE,
    'filter[orders][state]': state,
    'filter[orders][creationDate][$ge]': from,
    'filter[orders][creationDate][$le]': to,
    'include[orders]': 'entries'
  };
  return GB.ORDERS_URL + '?' + Object.keys(p)
    .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(p[k]); }).join('&');
}

function fetchKaspiJson_(url, token) {
  const options = {
    method: 'get', muteHttpExceptions: true, followRedirects: true,
    headers: { 'X-Auth-Token': token, Accept: 'application/vnd.api+json', 'Content-Type': 'application/vnd.api+json' }
  };
  const delays = [0, 1200, 3000];
  let last = null;

  for (let a = 0; a < delays.length; a++) {
    if (delays[a]) Utilities.sleep(delays[a]);
    try {
      const resp = UrlFetchApp.fetch(url, options);
      const code = resp.getResponseCode();
      const body = resp.getContentText();

      if (code >= 200 && code < 300) {
        try { return JSON.parse(body || '{}'); }
        catch (e) { throw new Error('Kaspi вернул некорректный JSON: ' + body.slice(0, 500)); }
      }
      if (code === 401 || code === 403) throw new Error('Kaspi API HTTP ' + code + '. Проверьте KASPI_TOKEN.');
      if (code === 429 || code >= 500) { last = new Error('Kaspi API HTTP ' + code + ': ' + body.slice(0, 300)); continue; }
      throw new Error('Kaspi API HTTP ' + code + ': ' + body.slice(0, 500));

    } catch (e) {
      const msg = errText_(e);
      if (isQuotaError_(msg)) throw new Error('Исчерпан суточный лимит UrlFetch Google.');
      if (/HTTP 40[13]/.test(msg)) throw e;
      last = e;
      if (a === delays.length - 1) throw e;
    }
  }
  throw last || new Error('Неизвестная ошибка Kaspi API.');
}

function normalizeOrdersPage_(json) {
  const included = Array.isArray(json && json.included) ? json.included : [];
  const byId = new Map();
  const byOrder = new Map();

  included.forEach(function (it) {
    if (!it || it.type !== 'orderentries') return;
    if (it.id) byId.set(String(it.id), it);
    const rel = it.relationships && it.relationships.order && it.relationships.order.data;
    if (rel && rel.id) {
      const oid = String(rel.id);
      if (!byOrder.has(oid)) byOrder.set(oid, []);
      byOrder.get(oid).push(it);
    }
  });

  const orders = Array.isArray(json && json.data) ? json.data : [];
  return orders.map(function (o) {
    const a = o.attributes || {};
    const oid = String(o.id || '');
    const refs = (o.relationships && o.relationships.entries && Array.isArray(o.relationships.entries.data))
      ? o.relationships.entries.data : [];

    const full = refs.length
      ? refs.map(function (r) { return byId.get(String(r.id)); }).filter(Boolean)
      : (byOrder.get(oid) || []);

    const entries = full.map(function (en) {
      const ea = en.attributes || {};
      const offer = ea.offer || {};
      return {
        sku: String(offer.code || ea.code || '').trim(),
        name: String(offer.name || ea.name || '').trim(),
        quantity: Math.max(1, Number(ea.quantity || 1))
      };
    });

    return {
      code: String(a.code || '').trim(),
      totalPrice: Number(a.totalPrice || 0),
      creationDate: Number(a.creationDate || 0),
      deliveryMode: String(a.deliveryMode || ''),
      state: String(a.state || ''),
      status: String(a.status || ''),
      preOrder: Boolean(a.preOrder),
      plannedDate: Number(a.plannedDeliveryDate || a.reservationDate || a.courierTransmissionPlanningDate || 0),
      courierTransmissionDate: parseKaspiHandoffDate_(a.courierTransmissionDate),
      entries: entries
    };
  });
}

/** Переводит epoch milliseconds Kaspi в Date; нулевое/пустое значение оставляет пустым. */
function parseKaspiHandoffDate_(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms) : '';
}

/** Чистый предикат для отменённых строк raw-листа. */
function isCancelledRawOrder_(status) {
  return String(status || '').trim().toUpperCase() === 'CANCELLED';
}

/** Чистая проверка формата даты передачи курьеру. */
function KASPI_ORDERS_TEST_handoffDate_() {
  const ms = 1794432000000;
  const date = parseKaspiHandoffDate_(ms);
  const parsed = normalizeOrdersPage_({
    data: [{attributes: {code: 'TEST', courierTransmissionDate: ms}}]
  })[0];
  if (!(date instanceof Date) || date.getTime() !== ms ||
      parseKaspiHandoffDate_(0) !== '' || parseKaspiHandoffDate_('') !== '' ||
      !isCancelledRawOrder_('CANCELLED') || isCancelledRawOrder_('CANCELLING') ||
      !(parsed.courierTransmissionDate instanceof Date) ||
      parsed.courierTransmissionDate.getTime() !== ms) {
    throw new Error('Преобразование courierTransmissionDate некорректно.');
  }
  return 'OK: epoch milliseconds преобразуются в Date, пустая дата остаётся пустой';
}

function humanStatus_(s) {
  const m = {
    APPROVED_BY_BANK: '🟡 Новый',
    ACCEPTED_BY_MERCHANT: '✅ Принят',
    COMPLETED: '📦 Выдан',
    CANCELLED: '❌ Отменён',
    CANCELLING: '🟠 Отмена',
    RETURNED: '↩️ Возврат',
    KASPI_DELIVERY_RETURN_REQUESTED: '↩️ Возврат запрошен'
  };
  return m[s] || s || '—';
}

function clearAndWrite_(sheet, headers, rows, width) {
  const lastRow = Math.max(sheet.getLastRow(), 1);
  sheet.getRange(1, 1, lastRow, Math.min(width, sheet.getMaxColumns())).clearContent();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (rows.length) sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
}

function writeRawOrders_(ss, orders) {
  const sheet = getOrCreateSheet_(ss, GB.SHEET_RAW);
  const headers = ['№ заказа', 'Артикул', 'Дата заказа', 'Сумма', 'Доставка', 'State', 'Статус Kaspi', 'Статус', 'Предзаказ', 'Плановая дата'];
  const handoffHeader = 'Дата передачи курьеру';
  const currentHeaders = sheet.getLastColumn() ?
    sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0] : [];
  let handoffCol = currentHeaders.indexOf(handoffHeader) + 1;
  if (!handoffCol) {
    handoffCol = Math.max(headers.length, sheet.getLastColumn()) + 1;
    if (sheet.getMaxColumns() < handoffCol) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), handoffCol - sheet.getMaxColumns());
    }
    sheet.getRange(1, handoffCol).setValue(handoffHeader);
  }

  const rows = orders.map(function (o) {
    const skus = [];
    o.entries.forEach(function (e) {
      if (!e.sku) return;
      skus.push(e.quantity > 1 ? e.sku + ' x' + e.quantity : e.sku);
    });
    return [
      o.code, skus.join('; '),
      o.creationDate ? new Date(o.creationDate) : '',
      o.totalPrice, o.deliveryMode, o.state, o.status, humanStatus_(o.status),
      o.preOrder ? 'Да' : 'Нет',
      o.plannedDate ? new Date(o.plannedDate) : '',
      o.courierTransmissionDate ? new Date(o.courierTransmissionDate) : ''
    ];
  });

  // Перезаписываем только известные столбцы A:J и целевой столбец даты,
  // чтобы не затирать чужие данные в промежуточных или добавленных колонках.
  const oldLastRow = Math.max(sheet.getLastRow(), 1);
  sheet.getRange(1, 1, oldLastRow, headers.length).clearContent();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, 10).setValues(rows.map(function (row) { return row.slice(0, 10); }));
    sheet.getRange(2, handoffCol, rows.length, 1).setValues(rows.map(function (row) { return [row[10]]; }));
  }
  if (rows.length) {
    sheet.getRange(2, 3, rows.length, 1).setNumberFormat('dd.MM.yyyy HH:mm:ss');
    sheet.getRange(2, 4, rows.length, 1).setNumberFormat('#,##0');
    sheet.getRange(2, 10, rows.length, 1).setNumberFormat('dd.MM.yyyy HH:mm:ss');
    sheet.getRange(2, handoffCol, rows.length, 1).setNumberFormat('dd.MM.yyyy HH:mm:ss');
  }
  sheet.setFrozenRows(1);
}

/** Дозаполняет фактическую передачу курьеру для отменённых заказов за 60 дней. */
function ORDERS_BACKFILL_CANCELLED_HANDOFF_60D() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(2000)) throw new Error('Синхронизация заказов уже выполняется.');
  try {
    const ss = getSS_();
    const sheet = ss.getSheetByName(GB.SHEET_RAW);
    if (!sheet || sheet.getLastRow() < 2) throw new Error('Лист «' + GB.SHEET_RAW + '» пуст или отсутствует.');
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
    const orderCol = headers.indexOf('№ заказа') + 1;
    const dateCol = headers.indexOf('Дата заказа') + 1;
    const stateCol = headers.indexOf('State') + 1;
    const statusCol = headers.indexOf('Статус Kaspi') + 1;
    const existingHandoffCol = headers.indexOf('Дата передачи курьеру') + 1;
    if (!orderCol || !dateCol || !stateCol || !statusCol) {
      throw new Error('Не найдены обязательные заголовки для дозаполнения отменённых заказов.');
    }
    let handoffCol = headers.indexOf('Дата передачи курьеру') + 1;
    if (!handoffCol) {
      handoffCol = sheet.getLastColumn() + 1;
      if (sheet.getMaxColumns() < handoffCol) {
        sheet.insertColumnsAfter(sheet.getMaxColumns(), handoffCol - sheet.getMaxColumns());
      }
      sheet.getRange(1, handoffCol).setValue('Дата передачи курьеру');
    }
    const lastRow = sheet.getLastRow();
    const values = sheet.getRange(2, 1, lastRow - 1, Math.max(handoffCol, statusCol)).getValues();
    const now = Date.now();
    const cutoff = now - 60 * 86400000;
    const candidates = [];
    values.forEach(function (row, index) {
      if (!isCancelledRawOrder_(row[statusCol - 1])) return;
      const creationValue = row[dateCol - 1];
      const creationMs = creationValue instanceof Date ? creationValue.getTime() : Date.parse(creationValue);
      if (!Number.isFinite(creationMs) || creationMs < cutoff || creationMs > now) return;
      if (existingHandoffCol && row[existingHandoffCol - 1]) return;
      candidates.push({row: index + 2, order: String(row[orderCol - 1] || '').trim()});
    });
    if (!candidates.length) return {checked: 0, updated: 0, reason: 'Нет отменённых заказов за последние 60 дней.'};

    const token = String(PropertiesService.getScriptProperties().getProperty('KASPI_TOKEN') || '').trim();
    if (!token) throw new Error('Не установлен KASPI_TOKEN.');
    const byCode = new Map();
    const from = cutoff, to = now;
    let pagesRead = 0;
    GB.ORDERS_STATES.concat(['ARCHIVE']).filter(function (state, index, list) {
      return list.indexOf(state) === index;
    }).forEach(function (state) {
      let page = 0;
      let pageCount = 1;
      while (page < pageCount && page < GB.ORDERS_MAX_PAGES) {
        const json = fetchKaspiJson_(ordersUrl_(state, page, from, to), token);
        normalizeOrdersPage_(json).forEach(function (order) {
          if (order.code) byCode.set(String(order.code), order);
        });
        pageCount = Math.max(1, Number(json && json.meta && json.meta.pageCount || 1));
        page++;
        pagesRead++;
      }
    });

    let updated = 0;
    candidates.forEach(function (candidate) {
      const fresh = byCode.get(candidate.order);
      if (!fresh || !fresh.courierTransmissionDate) return;
      sheet.getRange(candidate.row, handoffCol).setValue(new Date(fresh.courierTransmissionDate));
      updated++;
    });
    if (updated) sheet.getRange(2, handoffCol, lastRow - 1, 1).setNumberFormat('dd.MM.yyyy HH:mm:ss');
    return {checked: candidates.length, updated: updated, pages: pagesRead, cutoff: new Date(cutoff)};
  } finally {
    lock.releaseLock();
  }
}

function buildDashboards_(orders, names, photos, now) {
  const maps = { kurdai: new Map(), almaty: new Map(), wb: new Map() };

  orders.forEach(function (o) {
    if (GB.ORDERS_ACTIVE.indexOf(o.status) === -1) return;

    o.entries.forEach(function (e) {
      const sku = String(e.sku || '').trim();
      if (!sku) { console.warn('Заказ ' + o.code + ': позиция без артикула.'); return; }

      const key = sku.toUpperCase();
      const target = key.indexOf('OPT') === 0 ? maps.kurdai : key.indexOf('WB') === 0 ? maps.wb : maps.almaty;

      if (!target.has(key)) {
        target.set(key, {
          sku: sku,
          name: String(e.name || names[key] || 'Название не найдено'),
          photo: String(photos[key] || ''),
          quantity: 0, orders: new Set(), statuses: new Set()
        });
      }
      const p = target.get(key);
      p.quantity += Math.max(1, Number(e.quantity || 1));
      if (o.code) p.orders.add(String(o.code));
      if (o.status) p.statuses.add(o.status);
      if ((!p.name || p.name === 'Название не найдено') && names[key]) p.name = names[key];
      if (!p.photo && photos[key]) p.photo = photos[key];
    });
  });

  function toRows(map) {
    return Array.from(map.values())
      .sort(function (a, b) { return String(a.sku).localeCompare(String(b.sku), 'ru', { numeric: true, sensitivity: 'base' }); })
      .map(function (it) {
        return [it.sku, it.name, it.photo, it.quantity,
          Array.from(it.orders).join(', '),
          Array.from(it.statuses).map(humanStatus_).join(' / '),
          now];
      });
  }
  return { kurdai: toRows(maps.kurdai), almaty: toRows(maps.almaty), wb: toRows(maps.wb) };
}

function writeDashboard_(ss, name, rows) {
  const sheet = getOrCreateSheet_(ss, name);
  const headers = ['Артикул', 'Название товара', 'Фото товара', 'Количество', 'Номера заказов', 'Статус', 'Дата последнего обновления'];
  clearAndWrite_(sheet, headers, rows, 7);

  sheet.setFrozenRows(1);
  [145, 330, 100, 90, 300, 130, 170].forEach(function (w, i) { sheet.setColumnWidth(i + 1, w); });
  if (!rows.length) return;

  sheet.getRange(2, 7, rows.length, 1).setNumberFormat('dd.MM.yyyy HH:mm:ss');
  sheet.getRange(2, 1, rows.length, 7).setVerticalAlignment('middle').setWrap(true);

  const formulas = rows.map(function (r) {
    const url = String(r[2] || '').trim();
    if (!/^https?:\/\//i.test(url)) return [''];
    return ['=IFERROR(IMAGE("' + url.replace(/"/g, '""') + '",4,70,70),"")'];
  });
  sheet.getRange(2, 3, formulas.length, 1).setFormulas(formulas);
  sheet.setRowHeights(2, rows.length, 80);
}

/** Читает служебный лист в словарь «АРТИКУЛ (верхний регистр) → значение». */
function loadMap_(ss, sheetName, skuIdx, valIdx) {
  const out = {};
  const sh = ss.getSheetByName(sheetName);
  if (!sh || sh.getLastRow() < 2) return out;
  const width = Math.max(skuIdx, valIdx) + 1;
  sh.getRange(2, 1, sh.getLastRow() - 1, width).getDisplayValues().forEach(function (r) {
    const sku = String(r[skuIdx] || '').trim();
    const val = String(r[valIdx] || '').trim();
    if (sku && val) out[sku.toUpperCase()] = val;
  });
  return out;
}

function writeOrdersStatus_(ss, ok, s) {
  const sh = getOrCreateSheet_(ss, GB.SHEET_ORDERS_STATUS);
  sh.getRange(1, 1, 1, 6).setValues([['Параметр', 'Значение', 'Kaspi активных заказов', 'Kaspi единиц', 'Длительность, мс', 'Обновлено']]);
  if (ok) {
    sh.getRange(2, 1, 1, 6).setValues([['Последняя успешная синхронизация', s.summary, s.orders, s.units, s.ms, s.now]]);
    sh.getRange(3, 1, 1, 6).setValues([['Последняя попытка', 'OK', s.orders, s.units, s.ms, s.now]]);
  } else {
    sh.getRange(3, 1, 1, 6).setValues([['Последняя попытка', s.summary, '', '', s.ms, s.now]]);
  }
  sh.getRange(2, 6, 2, 1).setNumberFormat('dd.MM.yyyy HH:mm:ss');
}

function appendOrdersError_(ss, err) {
  const sh = getOrCreateSheet_(ss, GB.SHEET_ORDERS_ERRORS);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, 7).setValues([['Дата/время', 'Источник', 'Этап', 'Код/статус', 'Артикул/заказ', 'Ошибка', 'Детали']]);
  }
  sh.appendRow([new Date(), 'Kaspi Orders', 'ORDERS_RUN', 'ERROR', '', errText_(err).slice(0, 1000),
    String(err && err.stack ? err.stack : err).slice(0, 3000)]);
  sh.getRange(sh.getLastRow(), 1).setNumberFormat('dd.MM.yyyy HH:mm:ss');

  // Журнал не растёт бесконечно: храним последние 500 строк
  const last = sh.getLastRow();
  if (last > 501) sh.deleteRows(2, last - 501);
}
