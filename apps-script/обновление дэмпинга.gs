/**
 * GRANTS BOOK: место и самая низкая цена на Kaspi по ссылкам на товары.
 *
 * Для каждой строки листа «Прайс KASPI» берёт ссылку на товар Kaspi, запрашивает список
 * предложений продавцов и пишет в ОТДЕЛЬНЫЙ лист KASPI_МЕСТО: вашу цену, ваше место,
 * число продавцов, самую низкую цену, кто её предлагает и дату обновления.
 * Лист «Прайс KASPI» и другие листы скрипт НЕ меняет.
 *
 * ОБНОВЛЕНИЕ:
 *  - Автоматически 2 раза в день (AUTO_HOURS): полный обход всех товаров порциями в фоне.
 *  - Вручную: меню «KASPI место» → «Обновить ВСЕ сейчас» или кнопка-рисунок на листе
 *    (Вставка → Рисунок → «Назначить скрипт» → km_updateAllNow).
 *
 * ПЕРВЫЙ ЗАПУСК: выполните kmInstall (создаст меню), затем в меню «Включить автообновление».
 */

const KM_CFG = {
  SOURCE_SHEET: 'Прайс KASPI',
  OUT_SHEET: 'KASPI_МЕСТО',
  LINK_COL: '',            // буква столбца со ссылками Kaspi; пусто = найти автоматически
  SKU_COL: '',             // буква столбца с артикулом; пусто = столбец «Артикул», иначе A
  CITY_ID: '710000000',    // Астана. Алматы: 750000000
  CITY_NAME: 'Астана',
  ZONE_ID: 'Magnum_ZONE1',
  MY_MERCHANT_ID: '',      // ID вашего магазина в Kaspi, если знаете (надёжнее имени)
  MY_MERCHANT_NAMES: ['GRANTS BOOK'],
  OFFERS_URL: 'https://kaspi.kz/yml/offer-view/offers/{id}',
  PAGE_LIMIT: 64,
  MAX_PAGES: 3,
  BATCH: 4,                // запросов одновременно (Kaspi отвечает 403 на большие пачки)
  PAUSE_MS: 1500,          // пауза между пачками, не уменьшайте
  RUN_BUDGET_MS: 4.5 * 60 * 1000, // один запуск не дольше (лимит Apps Script 6 минут)
  AUTO_HOURS: [9, 21],     // во сколько запускать полный обход (время TZ)
  CONTINUE_MIN: 5,         // как часто продолжать обход в фоне (1, 5, 10, 15, 30)
  DAILY_FETCH_LIMIT: 15000,
  TZ: 'Asia/Almaty',
};

const KM_OUT_HEADERS = ['Артикул', 'Ссылка', 'ID товара', 'Город', 'Моя цена', 'Моё место', 'Всего продавцов',
  'Самая низкая цена', 'Кто самый дешёвый', 'Обновлено', 'Статус'];

/* ---------- меню ---------- */

function kmOnOpen() {
  SpreadsheetApp.getUi().createMenu('KASPI место')
    .addItem('▶ Обновить ВСЕ сейчас', 'km_updateAllNow')
    .addItem('Показать ход обновления', 'km_showStatus')
    .addSeparator()
    .addItem('Включить автообновление (2 раза в день)', 'km_enableAuto')
    .addItem('Выключить автообновление', 'km_disableAuto')
    .addToUi();
}

/** Запустите ОДИН раз: создаёт меню «KASPI место». */
function kmInstall() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'kmOnOpen') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('kmOnOpen').forSpreadsheet(SpreadsheetApp.getActive()).onOpen().create();
  kmOnOpen();
  SpreadsheetApp.getActiveSpreadsheet().toast('Меню «KASPI место» добавлено', 'KASPI место', 6);
}

/* ---------- вспомогательные функции ---------- */

function km_colIndex(letters) {
  const s = String(letters || '').trim().toUpperCase();
  if (!/^[A-Z]{1,3}$/.test(s)) return -1;
  let n = 0;
  for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
  return n - 1;
}

function km_extractProductId(url) {
  const m = String(url || '').match(/kaspi\.kz\/shop\/p\/[^?#]*?-(\d{5,})\/?(?:[?#]|$)/i);
  return m ? m[1] : '';
}

function km_toPrice(value) {
  const n = Number(String(value == null ? '' : value).replace(/[\s\u00a0₸]/g, '').replace(',', '.'));
  return isFinite(n) && n > 0 ? n : NaN;
}

function km_isMine(offer) {
  const id = String(offer.merchantId || offer.merchantUID || '');
  if (KM_CFG.MY_MERCHANT_ID && id) return id === String(KM_CFG.MY_MERCHANT_ID);
  const name = String(offer.merchantName || '').toLowerCase().trim();
  return !!name && KM_CFG.MY_MERCHANT_NAMES.some(function (n) { return name.indexOf(String(n).toLowerCase().trim()) >= 0; });
}

function km_parseOffersResponse(json) {
  if (!json || typeof json !== 'object') return { offers: [], total: 0 };
  const data = json.data && typeof json.data === 'object' ? json.data : {};
  const offers = Array.isArray(json.offers) ? json.offers : (Array.isArray(data.offers) ? data.offers : []);
  const total = [json.total, json.offersCount, data.total, data.offersCount]
    .map(Number).filter(function (n) { return isFinite(n) && n > 0; })[0] || offers.length;
  return { offers: offers, total: total };
}

// Место = 1 + число предложений СТРОГО дешевле моего: при равных ценах считается лучший вариант.
function km_summarize(offers, total) {
  const list = offers
    .map(function (o) { return { price: km_toPrice(o.price), name: String(o.merchantName || ''), mine: km_isMine(o) }; })
    .filter(function (o) { return isFinite(o.price); })
    .sort(function (a, b) { return a.price - b.price; });
  if (!list.length) return { status: 'Нет предложений' };
  const mine = list.filter(function (o) { return o.mine; })[0];
  const out = {
    total: Math.max(Number(total) || 0, list.length),
    lowest: list[0].price,
    lowestMerchant: list[0].name,
    myPrice: mine ? mine.price : '',
    place: '',
    status: mine ? 'OK' : 'Магазин не найден среди предложений',
  };
  if (mine) out.place = 1 + list.filter(function (o) { return o.price < mine.price; }).length;
  return out;
}

function km_buildRequest(id, productUrl, page) {
  return {
    url: KM_CFG.OFFERS_URL.replace('{id}', id),
    method: 'post',
    contentType: 'application/json',
    headers: {
      Accept: 'application/json, text/plain, */*',
      Referer: productUrl,
      Origin: 'https://kaspi.kz',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    },
    payload: JSON.stringify({
      cityId: KM_CFG.CITY_ID, id: id, merchantUID: [], limit: KM_CFG.PAGE_LIMIT, page: page,
      sortOption: 'PRICE', highRating: null, searchText: null,
      zoneId: [KM_CFG.ZONE_ID], installationId: '-1',
    }),
    muteHttpExceptions: true,
    followRedirects: true,
  };
}

/* ---------- чтение листа ---------- */

function km_detectColumns(sheet) {
  const lastCol = sheet.getLastColumn();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error('В листе «' + KM_CFG.SOURCE_SHEET + '» нет данных');
  const header = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const sample = sheet.getRange(2, 1, Math.min(300, lastRow - 1), lastCol).getValues();
  let link = km_colIndex(KM_CFG.LINK_COL);
  if (link < 0) {
    let best = -1, bestN = 0;
    for (let c = 0; c < lastCol; c++) {
      let n = 0;
      for (let r = 0; r < sample.length; r++) if (String(sample[r][c]).indexOf('kaspi.kz/shop/p/') >= 0) n++;
      if (n > bestN) { bestN = n; best = c; }
    }
    link = best;
  }
  let sku = km_colIndex(KM_CFG.SKU_COL);
  if (sku < 0) {
    sku = header.findIndex(function (h) { return /артикул/i.test(h); });
    if (sku < 0) sku = 0;
  }
  return { link: link, sku: sku, header: header, lastRow: lastRow };
}

function km_readItems(sheet, cols) {
  const n = cols.lastRow - 1;
  const skus = sheet.getRange(2, cols.sku + 1, n, 1).getValues();
  const links = cols.link >= 0 ? sheet.getRange(2, cols.link + 1, n, 1).getValues() : [];
  const items = [];
  for (let i = 0; i < n; i++) {
    const url = cols.link >= 0 ? String(links[i][0] || '').trim() : '';
    items.push({ sku: String(skus[i][0] || '').trim(), url: url, id: km_extractProductId(url) });
  }
  return items;
}

function km_outSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(KM_CFG.OUT_SHEET);
  if (!sh) {
    sh = ss.insertSheet(KM_CFG.OUT_SHEET);
    sh.getRange(1, 1, 1, KM_OUT_HEADERS.length).setValues([KM_OUT_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange('A:C').setNumberFormat('@');
    sh.getRange('J:J').setNumberFormat('dd.mm.yyyy hh:mm');
  }
  return sh;
}

/* ---------- управление обходом ---------- */

/** КНОПКА «Обновить ВСЕ сейчас»: полный обход с первого товара, остальное доделывается в фоне. */
function km_updateAllNow() {
  km_startPass();
  km_toast('Обновление запущено. Ход: меню «Показать ход обновления»');
  km_continuePass();
}

/** Запускается по расписанию. */
function km_scheduledStart() {
  km_startPass();
  km_continuePass();
}

function km_startPass() {
  const p = PropertiesService.getScriptProperties();
  p.setProperty('km_cursor', '0');
  p.setProperty('km_active', '1');
  p.setProperty('km_blockCount', '0');
  p.setProperty('km_passStartedAt', String(Date.now()));
  km_ensureContinueTrigger();
}

function km_continuePass() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const p = PropertiesService.getScriptProperties();
    if (p.getProperty('km_active') !== '1') { km_removeContinueTrigger(); return; }
    const state = km_run();
    if (state === 'done') {
      p.setProperty('km_active', '0');
      p.setProperty('km_lastPassAt', String(Date.now()));
      km_removeContinueTrigger();
      km_toast('Готово: все товары обновлены');
    }
  } finally { lock.releaseLock(); }
}

function km_ensureContinueTrigger() {
  const exists = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'km_continuePass'; });
  if (!exists) ScriptApp.newTrigger('km_continuePass').timeBased().everyMinutes(KM_CFG.CONTINUE_MIN).create();
}

function km_removeContinueTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'km_continuePass') ScriptApp.deleteTrigger(t); });
}

function km_enableAuto() {
  km_disableAuto();
  KM_CFG.AUTO_HOURS.forEach(function (h) {
    ScriptApp.newTrigger('km_scheduledStart').timeBased().everyDays(1).atHour(h).inTimezone(KM_CFG.TZ).create();
  });
  km_toast('Автообновление включено: ' + KM_CFG.AUTO_HOURS.map(function (h) { return h + ':00'; }).join(' и ') + ' каждый день');
}

function km_disableAuto() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const f = t.getHandlerFunction();
    if (f === 'km_scheduledStart' || f === 'km_continuePass' || f === 'km_processNextBatch') ScriptApp.deleteTrigger(t);
  });
  PropertiesService.getScriptProperties().setProperty('km_active', '0');
}

function km_showStatus() {
  const p = PropertiesService.getScriptProperties();
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(KM_CFG.SOURCE_SHEET);
  const total = sh ? Math.max(sh.getLastRow() - 1, 0) : 0;
  const fmt = function (ms) { return ms ? Utilities.formatDate(new Date(Number(ms)), KM_CFG.TZ, 'dd.MM.yyyy HH:mm') : 'ещё не было'; };
  const auto = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'km_scheduledStart'; }).length;
  SpreadsheetApp.getUi().alert([
    p.getProperty('km_active') === '1'
      ? 'Обход ИДЁТ: обработано ' + Number(p.getProperty('km_cursor') || 0) + ' из ' + total + ' (начат ' + fmt(p.getProperty('km_passStartedAt')) + ')'
      : 'Обход не идёт',
    'Последний полный обход завершён: ' + fmt(p.getProperty('km_lastPassAt')),
    'Автообновление: ' + (auto ? 'включено (' + KM_CFG.AUTO_HOURS.map(function (h) { return h + ':00'; }).join(', ') + ')' : 'ВЫКЛЮЧЕНО'),
    'Запросов сегодня: ' + Number(p.getProperty('km_fetchCount') || 0) + ' из ' + KM_CFG.DAILY_FETCH_LIMIT,
  ].join('\n'));
}

/* ---------- основной обход ---------- */

function km_today() { return Utilities.formatDate(new Date(), KM_CFG.TZ, 'yyyy-MM-dd'); }

/** Возвращает: 'done' (все обработаны), 'more' (нужна ещё порция), 'blocked', 'limit'. */
function km_run() {
  const t0 = Date.now();
  const props = PropertiesService.getScriptProperties();
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(KM_CFG.SOURCE_SHEET);
  if (!sh) throw new Error('Нет листа «' + KM_CFG.SOURCE_SHEET + '»');
  const cols = km_detectColumns(sh);
  const items = km_readItems(sh, cols);
  const out = km_outSheet();
  let cursor = Number(props.getProperty('km_cursor') || 0);

  if (cursor >= items.length) { props.setProperty('km_cursor', '0'); return 'done'; }
  if (props.getProperty('km_fetchDay') !== km_today()) { props.setProperty('km_fetchDay', km_today()); props.setProperty('km_fetchCount', '0'); }
  let fetched = Number(props.getProperty('km_fetchCount') || 0);

  while (cursor < items.length && Date.now() - t0 < KM_CFG.RUN_BUDGET_MS) {
    if (fetched + KM_CFG.BATCH > KM_CFG.DAILY_FETCH_LIMIT) {
      km_log('Достигнут дневной лимит запросов, продолжим завтра');
      return 'limit';
    }
    const slice = items.slice(cursor, cursor + KM_CFG.BATCH);
    const reqs = [], idxs = [];
    slice.forEach(function (it, k) { if (it.id) { reqs.push(km_buildRequest(it.id, it.url, 0)); idxs.push(k); } });
    const resps = reqs.length ? UrlFetchApp.fetchAll(reqs) : [];
    fetched += reqs.length;

    // 403/429: подождать и повторить по одному запросу
    let stillBlocked = 0;
    resps.forEach(function (r, j) {
      const c = r.getResponseCode();
      if (c !== 403 && c !== 429) return;
      Utilities.sleep(3000);
      const again = UrlFetchApp.fetch(reqs[j].url, reqs[j]);
      fetched++;
      resps[j] = again;
      const c2 = again.getResponseCode();
      if (c2 === 403 || c2 === 429) stillBlocked++;
    });
    // Блокировка по всей пачке: ничего не пишем, повторим эту пачку позже
    if (reqs.length && stillBlocked >= Math.min(3, reqs.length)) {
      const n = Number(props.getProperty('km_blockCount') || 0) + 1;
      props.setProperty('km_blockCount', String(n));
      props.setProperty('km_fetchCount', String(fetched));
      km_log('Kaspi временно ограничил запросы, пауза (' + n + ')');
      if (n >= 3) {
        props.setProperty('km_active', '0');
        km_removeContinueTrigger();
        km_log('Обход остановлен: Kaspi ограничивает запросы. Расписание сохранено, попробуйте позже.');
      }
      return 'blocked';
    }

    const now = new Date();
    const rows = slice.map(function (it) {
      return [it.sku, it.url, it.id, KM_CFG.CITY_NAME, '', '', '', '', '', now, it.id ? '' : (it.url ? 'Не удалось распознать ID' : 'Нет ссылки')];
    });
    idxs.forEach(function (k, j) {
      const code = resps[j].getResponseCode();
      if (code === 403 || code === 429) { rows[k][10] = 'Kaspi ограничил запрос (HTTP ' + code + '), повторится в следующем обходе'; return; }
      if (code !== 200) { rows[k][10] = 'Ошибка HTTP ' + code; return; }
      try {
        const p = km_parseOffersResponse(JSON.parse(resps[j].getContentText()));
        const offers = p.offers.slice();
        let page = 1;
        while (p.total > offers.length && page < KM_CFG.MAX_PAGES && offers.length >= KM_CFG.PAGE_LIMIT * page) {
          const req = km_buildRequest(slice[k].id, slice[k].url, page);
          const more = UrlFetchApp.fetch(req.url, req);
          fetched++;
          if (more.getResponseCode() !== 200) break;
          offers.push.apply(offers, km_parseOffersResponse(JSON.parse(more.getContentText())).offers);
          page++;
          Utilities.sleep(KM_CFG.PAUSE_MS);
        }
        const s = km_summarize(offers, p.total);
        rows[k][4] = s.myPrice === undefined ? '' : s.myPrice;
        rows[k][5] = s.place === undefined ? '' : s.place;
        rows[k][6] = s.total === undefined ? '' : s.total;
        rows[k][7] = s.lowest === undefined ? '' : s.lowest;
        rows[k][8] = s.lowestMerchant === undefined ? '' : s.lowestMerchant;
        rows[k][10] = s.status === 'Нет предложений'
          ? 'Нет предложений. Ответ Kaspi: ' + resps[j].getContentText().slice(0, 150)
          : s.status;
      } catch (e) {
        rows[k][10] = 'Не удалось разобрать ответ: ' + String(e).slice(0, 80);
      }
    });
    // строка листа результатов = строка исходного листа (cursor + 2)
    out.getRange(cursor + 2, 1, rows.length, KM_OUT_HEADERS.length).setValues(rows);
    cursor += slice.length;
    props.setProperty('km_cursor', String(cursor));
    props.setProperty('km_fetchCount', String(fetched));

    props.setProperty('km_blockCount', '0');
    Utilities.sleep(KM_CFG.PAUSE_MS);
  }
  if (cursor >= items.length) { props.setProperty('km_cursor', '0'); return 'done'; }
  return 'more';
}

function km_toast(msg) { try { SpreadsheetApp.getActiveSpreadsheet().toast(msg, 'KASPI место', 8); } catch (e) { } }
function km_log(msg) { Logger.log(msg); km_toast(msg); }
