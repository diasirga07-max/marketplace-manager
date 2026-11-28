/**
 * ⚡ БЫСТРЫЙ ПРАЙС для листа «Прайс KASPI» — версия 2
 *
 * Формулы в повторяющихся столбцах заменяются готовыми числами (таблица не тормозит).
 * При правке строки скрипт на секунду ставит формулы ТОЛЬКО в эту строку, берёт результат
 * и снова оставляет числа. Формулы хранятся на скрытом листе «_KP_FORMULAS».
 *
 * КАК ПОЛЬЗОВАТЬСЯ:
 *  - Замените ВЕСЬ код в файле «быстрое обновление формулы» этим кодом → Сохранить.
 *  - Выберите KP_setup → Выполнить. Можно запускать повторно: если уже включено,
 *    он просто восстановит триггеры и пересчитает прайс.
 *  - KP_status → Выполнить: покажет в журнале, что включено и какие триггеры есть.
 */

const KP = {
  SHEET: 'Прайс KASPI',   // имя листа (ищется и по вхождению)
  HEADER_ROW: 1,          // строка заголовков
  ID_COL: 1,              // столбец с артикулом (A)
  SHARE: 0.9,             // столбец ускоряется, если у 90%+ строк одна и та же формула
  MIN_ROWS: 10,
  BATCH: 1500,            // строк за один проход
  AUTO_HOURS: 1,          // автопересчёт всего прайса каждые N часов (0 = выключить)
  STORE: '_KP_FORMULAS'   // скрытый лист с формулами
};

const KP_HANDLERS = ['KP_onEdit', 'KP_onOpen', 'KP_recalcAll'];

/* ===================== УСТАНОВКА ===================== */

function KP_setup() {
  const ss = SpreadsheetApp.getActive();
  const old = kpLoad_();

  // Уже настроено → чиним триггеры и пересчитываем, ничего не ломая
  if (old && old.cols.length) {
    kpInstallTriggers_();
    try { KP_onOpen(); } catch (e) {}
    Logger.log('Уже было включено. Триггеры пересозданы, запускаю полный пересчёт…');
    KP_recalcAll();
    KP_status();
    return;
  }

  const sh = kpSheet_();
  const H = KP.HEADER_ROW, last = sh.getLastRow(), lastCol = sh.getLastColumn(), n = last - H;
  if (n < 1) throw new Error('На листе нет данных');

  const block = sh.getRange(H + 1, 1, n, lastCol);
  const fR1C1 = block.getFormulasR1C1();
  const vals = block.getValues();
  const ids = sh.getRange(H + 1, KP.ID_COL, n, 1).getDisplayValues();
  const head = sh.getRange(H, 1, 1, lastCol).getDisplayValues()[0];

  const cols = [];
  const exc = new Set();
  for (let c = 0; c < lastCol; c++) {
    if (c + 1 === KP.ID_COL) continue;
    const cnt = {};
    for (let r = 0; r < n; r++) if (fR1C1[r][c]) cnt[fR1C1[r][c]] = (cnt[fR1C1[r][c]] || 0) + 1;
    let main = '', best = 0;
    for (const k in cnt) if (cnt[k] > best) { best = cnt[k]; main = k; }
    if (!main || best < KP.MIN_ROWS || best < n * KP.SHARE) continue;

    cols.push({ c: c + 1, head: head[c], r1c1: main });
    for (let r = 0; r < n; r++) {
      if (fR1C1[r][c] !== main && (fR1C1[r][c] !== '' || vals[r][c] !== '')) {
        exc.add(kpKey_(ids[r][0], H + 1 + r) + '\t' + (c + 1));
      }
    }
  }
  if (!cols.length) throw new Error('Не нашёл столбцов с одинаковыми формулами — ускорять нечего.');

  const cfg = { cols: cols, exc: exc };

  // 1) сохраняем формулы  2) сразу ставим триггеры  3) только потом замораживаем
  kpSave_(cfg);
  kpInstallTriggers_();
  kpFreezeAll_(sh, cfg);
  try { KP_onOpen(); } catch (e) {}

  const list = cols.map(x => kpLetter_(x.c) + ' «' + x.head + '»').join(', ');
  Logger.log('Готово. Ускорены столбцы: ' + list + '. Ручных исключений: ' + exc.size);
  kpToast_('Ускорены столбцы: ' + list, 15);
  KP_status();
}

/** Диагностика: что включено и какие триггеры есть */
function KP_status() {
  const cfg = kpLoad_();
  if (!cfg) { Logger.log('Быстрый прайс НЕ включён (нет листа ' + KP.STORE + ').'); return; }
  Logger.log('Ускоренные столбцы: ' + cfg.cols.map(x => kpLetter_(x.c) + ' «' + x.head + '»').join(', '));
  Logger.log('Ручных исключений: ' + cfg.exc.size);
  const tr = ScriptApp.getProjectTriggers()
    .filter(t => KP_HANDLERS.indexOf(t.getHandlerFunction()) !== -1)
    .map(t => t.getHandlerFunction() + ' (' + t.getEventType() + ')');
  Logger.log('Триггеры: ' + (tr.length ? tr.join(', ') : 'НЕТ — запустите KP_setup'));
}

/** На случай, если нужно только пересоздать триггеры и пересчитать */
function KP_fixTriggers() {
  kpInstallTriggers_();
  KP_recalcAll();
  KP_status();
}

/* ===================== ТРИГГЕРЫ / МЕНЮ ===================== */

function KP_onOpen() {
  SpreadsheetApp.getUi().createMenu('⚡ Быстрый прайс')
    .addItem('Пересчитать выделенные строки', 'KP_recalcSelection')
    .addItem('Пересчитать весь прайс', 'KP_recalcAll')
    .addSeparator()
    .addItem('Вернуть формулы (выключить)', 'KP_restoreFormulas')
    .addToUi();
}

function KP_onEdit(e) {
  if (!e || !e.range) return;
  const sh = e.range.getSheet();
  let target;
  try { target = kpSheet_(); } catch (err) { return; }
  if (sh.getSheetId() !== target.getSheetId()) return;

  const H = KP.HEADER_ROW;
  const start = Math.max(e.range.getRow(), H + 1);
  const end = e.range.getLastRow();
  if (end < start) return;

  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(25000)) return;
  try {
    const cfg = kpLoad_();
    if (!cfg || !cfg.cols.length) return;

    // правка в самом «ускоренном» столбце: число = ручное значение, пусто = вернуть расчёт
    const c1 = e.range.getColumn(), c2 = e.range.getLastColumn();
    const touched = cfg.cols.filter(col => col.c >= c1 && col.c <= c2);
    if (touched.length) {
      const len = end - start + 1;
      const ids = sh.getRange(start, KP.ID_COL, len, 1).getDisplayValues();
      let changed = false;
      touched.forEach(col => {
        const rng = sh.getRange(start, col.c, len, 1);
        const v = rng.getValues(), fx = rng.getFormulasR1C1();
        for (let i = 0; i < len; i++) {
          const k = kpKey_(ids[i][0], start + i) + '\t' + col.c;
          const manual = fx[i][0] ? fx[i][0] !== col.r1c1 : v[i][0] !== '';
          if (manual && !cfg.exc.has(k)) { cfg.exc.add(k); changed = true; }
          if (!manual && cfg.exc.has(k)) { cfg.exc.delete(k); changed = true; }
        }
      });
      if (changed) kpSave_(cfg);
    }

    for (let s = start; s <= end; s += KP.BATCH) {
      kpRecalcRows_(sh, cfg, s, Math.min(end, s + KP.BATCH - 1));
    }
  } finally {
    lock.releaseLock();
  }
}

/* ===================== КНОПКИ МЕНЮ ===================== */

function KP_recalcAll() {
  const lock = LockService.getDocumentLock();
  lock.waitLock(60000);
  try {
    const cfg = kpLoad_();
    if (!cfg || !cfg.cols.length) { Logger.log('Не включено'); return; }
    const sh = kpSheet_();
    const last = sh.getLastRow();
    const t = Date.now();
    for (let s = KP.HEADER_ROW + 1; s <= last; s += KP.BATCH) {
      kpRecalcRows_(sh, cfg, s, Math.min(last, s + KP.BATCH - 1));
    }
    const msg = 'Пересчитано строк: ' + (last - KP.HEADER_ROW) + ' за ' + Math.round((Date.now() - t) / 1000) + ' сек';
    Logger.log(msg);
    kpToast_(msg);
  } finally {
    lock.releaseLock();
  }
}

function KP_recalcSelection() {
  const sh = kpSheet_();
  const r = sh.getActiveRange();
  if (!r || r.getSheet().getSheetId() !== sh.getSheetId()) { kpToast_('Выделите строки на листе прайса'); return; }
  const cfg = kpLoad_();
  if (!cfg) return;
  const start = Math.max(r.getRow(), KP.HEADER_ROW + 1), end = r.getLastRow();
  const lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    for (let s = start; s <= end; s += KP.BATCH) kpRecalcRows_(sh, cfg, s, Math.min(end, s + KP.BATCH - 1));
  } finally { lock.releaseLock(); }
  kpToast_('Пересчитано строк: ' + Math.max(0, end - start + 1));
}

function KP_restoreFormulas() {
  let ui = null;
  try { ui = SpreadsheetApp.getUi(); } catch (e) {}
  if (ui && ui.alert('Вернуть формулы во все строки и выключить быстрый прайс?', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;

  const lock = LockService.getDocumentLock();
  lock.waitLock(60000);
  try {
    const cfg = kpLoad_();
    if (!cfg) { kpToast_('Быстрый прайс не был включён'); return; }
    const sh = kpSheet_();
    const H = KP.HEADER_ROW, last = sh.getLastRow(), n = last - H;
    const ids = sh.getRange(H + 1, KP.ID_COL, n, 1).getDisplayValues();
    cfg.cols.forEach(col => {
      kpRuns_(ids, H + 1, col.c, cfg.exc).forEach(([i, len]) =>
        sh.getRange(H + 1 + i, col.c, len, 1).setFormulaR1C1(col.r1c1));
    });
    kpRemoveTriggers_();
    const ss = SpreadsheetApp.getActive();
    const st = ss.getSheetByName(KP.STORE);
    if (st) ss.deleteSheet(st);
  } finally { lock.releaseLock(); }
  Logger.log('Формулы возвращены, быстрый прайс выключен.');
  if (ui) ui.alert('Формулы возвращены, быстрый прайс выключен.');
}

/* ===================== ЯДРО ===================== */

// Формулы → значения во всех ускоренных столбцах (одна запись на столбец)
function kpFreezeAll_(sh, cfg) {
  const H = KP.HEADER_ROW, last = sh.getLastRow(), n = last - H;
  if (n < 1) return;
  SpreadsheetApp.flush();
  const ids = sh.getRange(H + 1, KP.ID_COL, n, 1).getDisplayValues();
  cfg.cols.forEach(col => {
    const rng = sh.getRange(H + 1, col.c, n, 1);
    const v = rng.getValues(), fA1 = rng.getFormulas();
    const out = v.map((row, i) => {
      const isExc = cfg.exc.has(kpKey_(ids[i][0], H + 1 + i) + '\t' + col.c);
      return [isExc && fA1[i][0] ? fA1[i][0] : row[0]]; // у исключений оставляем их формулу
    });
    rng.setValues(out);
  });
}

// Ставит формулы только в строки start..end, ждёт расчёт, заменяет на значения
function kpRecalcRows_(sh, cfg, start, end) {
  const len = end - start + 1;
  if (len < 1) return;
  const ids = sh.getRange(start, KP.ID_COL, len, 1).getDisplayValues();
  const plan = cfg.cols.map(col => {
    const isExc = ids.map((r, i) => cfg.exc.has(kpKey_(r[0], start + i) + '\t' + col.c));
    return { col: col, isExc: isExc, runs: kpRuns_(ids, start, col.c, cfg.exc) };
  });

  // 1) формулы в нужные ячейки
  plan.forEach(p => p.runs.forEach(([i, l]) =>
    sh.getRange(start + i, p.col.c, l, 1).setFormulaR1C1(p.col.r1c1)));
  SpreadsheetApp.flush();

  // 2) результат → значения (одна запись на столбец, исключения не трогаем)
  plan.forEach(p => {
    if (!p.runs.length) return;
    const rng = sh.getRange(start, p.col.c, len, 1);
    const v = rng.getValues(), fA1 = rng.getFormulas();
    const out = v.map((row, i) => [p.isExc[i] && fA1[i][0] ? fA1[i][0] : row[0]]);
    rng.setValues(out);
  });
}

// Непрерывные куски строк без исключений: [[смещение, длина], ...]
function kpRuns_(ids, firstRow, col, exc) {
  const runs = [];
  let s = -1;
  for (let i = 0; i <= ids.length; i++) {
    const ok = i < ids.length && !exc.has(kpKey_(ids[i][0], firstRow + i) + '\t' + col);
    if (ok && s < 0) s = i;
    if (!ok && s >= 0) { runs.push([s, i - s]); s = -1; }
  }
  return runs;
}

function kpKey_(id, row) {
  id = String(id).trim();
  return id ? 'id:' + id : 'row:' + row;
}

/* ===================== ХРАНЕНИЕ ===================== */

function kpSave_(cfg) {
  const ss = SpreadsheetApp.getActive();
  let st = ss.getSheetByName(KP.STORE);
  if (!st) { st = ss.insertSheet(KP.STORE); st.hideSheet(); }
  st.clearContents();

  const a = [['col', 'header', 'r1c1']].concat(cfg.cols.map(x => [x.c, 'H:' + x.head, 'F:' + x.r1c1]));
  const ex = [['key', 'col']].concat(Array.from(cfg.exc).map(s => { const p = s.split('\t'); return [p[0], Number(p[1])]; }));
  const need = Math.max(a.length, ex.length);
  if (st.getMaxRows() < need) st.insertRowsAfter(st.getMaxRows(), need - st.getMaxRows());
  if (st.getMaxColumns() < 6) st.insertColumnsAfter(st.getMaxColumns(), 6 - st.getMaxColumns());

  st.getRange(1, 1, a.length, 3).setValues(a);
  st.getRange(1, 5, ex.length, 2).setValues(ex);
}

function kpLoad_() {
  const st = SpreadsheetApp.getActive().getSheetByName(KP.STORE);
  if (!st || st.getLastRow() < 2) return null;
  const v = st.getRange(1, 1, st.getLastRow(), 6).getValues();
  const cols = [], exc = new Set();
  for (let i = 1; i < v.length; i++) {
    if (v[i][0] !== '') cols.push({
      c: Number(v[i][0]),
      head: String(v[i][1]).replace(/^H:/, ''),
      r1c1: String(v[i][2]).replace(/^F:/, '')
    });
    if (v[i][4] !== '') exc.add(String(v[i][4]) + '\t' + Number(v[i][5]));
  }
  return { cols: cols, exc: exc };
}

/* ===================== СЛУЖЕБНОЕ ===================== */

function kpSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(KP.SHEET);
  if (!sh) sh = ss.getSheets().find(s => s.getName().indexOf(KP.SHEET) !== -1);
  if (!sh) throw new Error('Не найден лист «' + KP.SHEET + '»');
  return sh;
}

function kpInstallTriggers_() {
  kpRemoveTriggers_();
  const ss = SpreadsheetApp.getActive();
  ScriptApp.newTrigger('KP_onEdit').forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger('KP_onOpen').forSpreadsheet(ss).onOpen().create();
  if (KP.AUTO_HOURS > 0) ScriptApp.newTrigger('KP_recalcAll').timeBased().everyHours(KP.AUTO_HOURS).create();
}

function kpRemoveTriggers_() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (KP_HANDLERS.indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
  });
}

function kpLetter_(c) {
  let s = '';
  while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); }
  return s;
}

function kpToast_(msg, sec) {
  try { SpreadsheetApp.getActive().toast(msg, '⚡ Быстрый прайс', sec || 5); } catch (e) {}
}
