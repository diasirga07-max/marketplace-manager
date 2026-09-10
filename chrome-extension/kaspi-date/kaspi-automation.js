(() => {
  'use strict';
  if (window.__GB_KASPI_DATE_AUTOMATION__) return;
  window.__GB_KASPI_DATE_AUTOMATION__ = true;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = el => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const text = el => String(el && (el.innerText || el.textContent) || '').replace(/\s+/g, ' ').trim();
  const low = el => text(el).toLowerCase();

  function allVisible(selector = 'button,a,input,select,[role="button"],[role="option"],li,div,span') {
    return [...document.querySelectorAll(selector)].filter(visible);
  }
  function findByText(exact, root = document, tags = 'button,a,[role="button"],div,span,li') {
    const q = String(exact).trim().toLowerCase();
    return [...root.querySelectorAll(tags)].filter(visible).find(el => low(el) === q) || null;
  }
  function findContains(needle, root = document, tags = '*') {
    const q = String(needle).trim().toLowerCase();
    return [...root.querySelectorAll(tags)].filter(visible).find(el => low(el).includes(q)) || null;
  }
  async function waitFor(fn, timeout = 15000, step = 180) {
    const started = Date.now(); let last;
    while (Date.now() - started < timeout) {
      try { last = fn(); if (last) return last; } catch (_) {}
      await sleep(step);
    }
    return last || null;
  }
  function setNativeInput(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }
  function safeClick(el) {
    if (!el) return false;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(type => {
      try { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })); } catch (_) {}
    });
    try { el.click(); } catch (_) {}
    return true;
  }
  function monthNumber(raw) {
    const s = String(raw || '').toLowerCase().replace(/ё/g, 'е');
    const months = [['янв',1],['фев',2],['мар',3],['апр',4],['май',5],['мая',5],['июн',6],['июл',7],['авг',8],['сен',9],['сент',9],['окт',10],['ноя',11],['дек',12]];
    const hit = months.find(([k]) => s.includes(k));
    return hit ? hit[1] : 0;
  }
  function parseDateText(raw, defaultYear = new Date().getFullYear()) {
    const s = String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
    let m = s.match(/\b(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](\d{4}))?\b/);
    if (m) return `${+(m[3] || defaultYear)}-${String(+m[2]).padStart(2,'0')}-${String(+m[1]).padStart(2,'0')}`;
    m = s.match(/\b(\d{1,2})\s+([а-я.]+)(?:\s+(\d{4}))?\b/i);
    if (m) { const mo = monthNumber(m[2]); if (mo) return `${+(m[3] || defaultYear)}-${String(mo).padStart(2,'0')}-${String(+m[1]).padStart(2,'0')}`; }
    return '';
  }
  function orderDetailVisible(orderCode) {
    const body = text(document.body);
    return body.includes(orderCode) && /информация о заказе/i.test(body) && /планируемая дата прибытия/i.test(body);
  }
  async function openPreorderSection() {
    const existing = [...document.querySelectorAll('input')].filter(visible).find(i => /номер заказа/i.test(i.placeholder || '') || /номер заказа/i.test(i.getAttribute('aria-label') || ''));
    if (existing) return;
    const pre = findByText('Предзаказ') || findContains('Предзаказ', document, 'a,button,[role="button"],li,div');
    if (pre) safeClick(pre);
    await waitFor(() => [...document.querySelectorAll('input')].filter(visible).find(i => /номер заказа/i.test(i.placeholder || '') || /номер заказа/i.test(i.getAttribute('aria-label') || '')), 12000);
  }
  async function searchOrder(orderCode) {
    if (orderDetailVisible(orderCode)) return true;
    await openPreorderSection();
    let input = await waitFor(() => [...document.querySelectorAll('input')].filter(visible).find(i => /номер заказа/i.test(i.placeholder || '') || /номер заказа/i.test(i.getAttribute('aria-label') || '')), 12000);
    if (!input) {
      const label = findContains('Номер заказа');
      if (label) input = label.closest('form,div')?.querySelector('input') || null;
    }
    if (!input) throw Object.assign(new Error('Не найдено поле «Номер заказа» в кабинете Kaspi.'), { code: 'SEARCH_INPUT_NOT_FOUND' });
    input.focus(); setNativeInput(input, orderCode);
    const area = input.closest('form,section,div') || document;
    const searchBtn = findByText('Поиск', area) || findByText('Поиск');
    if (!searchBtn) throw Object.assign(new Error('Не найдена кнопка «Поиск».'), { code: 'SEARCH_BUTTON_NOT_FOUND' });
    safeClick(searchBtn);
    const result = await waitFor(() => {
      if (orderDetailVisible(orderCode)) return document.body;
      return allVisible('a,button,[role="button"],td,div,span').find(el => text(el) === orderCode) || null;
    }, 18000);
    if (!result) throw Object.assign(new Error('Заказ ' + orderCode + ' не найден в кабинете Kaspi.'), { code: 'ORDER_NOT_FOUND' });
    if (result !== document.body) safeClick(result.closest('a,button,[role="button"]') || result);
    if (!await waitFor(() => orderDetailVisible(orderCode), 18000)) throw Object.assign(new Error('Карточка заказа открылась, но блок «Планируемая дата прибытия» не найден.'), { code: 'ORDER_DETAIL_NOT_READY' });
    return true;
  }
  function findArrivalLabel() {
    return allVisible('div,span,p,td,th,label').find(el => low(el) === 'планируемая дата прибытия') || null;
  }
  function findArrivalRow() {
    const label = findArrivalLabel(); if (!label) return null;
    let p = label.parentElement;
    for (let i = 0; p && i < 7; i++, p = p.parentElement) {
      const t = text(p);
      if (/планируемая дата прибытия/i.test(t) && (/изменить/i.test(t) || /\d{1,2}\s+[а-я]+\.?\s+\d{4}|\d{1,2}[.\/-]\d{1,2}[.\/-]\d{4}/i.test(t))) return p;
    }
    return label.parentElement;
  }
  function currentArrivalDate(defaultYear = new Date().getFullYear()) {
    const row = findArrivalRow(); if (!row) return '';
    const parts = text(row).split(/\n|\s{2,}/).map(x => x.trim()).filter(Boolean);
    for (const part of parts) {
      if (/планируемая дата прибытия|изменить/i.test(part)) continue;
      const d = parseDateText(part, defaultYear); if (d) return d;
    }
    const raw = text(row).replace(/планируемая дата прибытия/ig,'').replace(/изменить/ig,'');
    return parseDateText(raw, defaultYear);
  }
  function findArrivalChangeButton() {
    const row = findArrivalRow();
    if (!row) return null;
    return [...row.querySelectorAll('button,a,[role="button"]')].filter(visible).find(el => low(el) === 'изменить') || null;
  }
  function visibleDialog() {
    const dialogs = allVisible('[role="dialog"],.modal,[class*="modal"],[class*="dialog"]');
    const d = dialogs.find(el => /планируемая дата прибытия/i.test(text(el)) && /сохранить/i.test(text(el)));
    if (d) return d;
    const save = findByText('Сохранить');
    if (!save) return null;
    let p = save.parentElement;
    for (let i=0; p && i<8; i++, p=p.parentElement) if (/планируемая дата прибытия/i.test(text(p))) return p;
    return null;
  }
  function collectDateOptions(root = document, defaultYear = new Date().getFullYear()) {
    const candidates = [...root.querySelectorAll('[role="option"],option,li,button,[role="button"],div,span')].filter(visible);
    const out = [];
    for (const el of candidates) {
      const label = text(el);
      if (!label || label.length > 80) continue;
      const d = parseDateText(label, defaultYear);
      if (d) out.push({ date: d, el, label });
    }
    const seen = new Set();
    return out.filter(x => !seen.has(x.date) && seen.add(x.date));
  }
  async function chooseDate(newDate) {
    const dialog = await waitFor(visibleDialog, 10000);
    if (!dialog) throw Object.assign(new Error('Окно изменения даты не открылось.'), { code: 'DATE_DIALOG_NOT_FOUND' });
    const native = [...dialog.querySelectorAll('input[type="date"]')].filter(visible)[0];
    if (native) { setNativeInput(native, newDate); return { method: 'native-date' }; }
    const select = [...dialog.querySelectorAll('select')].filter(visible)[0];
    if (select) {
      const y = +newDate.slice(0,4);
      const opt = [...select.options].find(o => parseDateText(o.textContent,y) === newDate || o.value === newDate);
      if (!opt) return { ok:false, code:'DATE_NOT_AVAILABLE', availableDates:[...select.options].map(o=>parseDateText(o.textContent,y)).filter(Boolean) };
      select.value = opt.value; select.dispatchEvent(new Event('change',{bubbles:true})); return { method:'select' };
    }
    const opener = [...dialog.querySelectorAll('button,[role="button"],div,span')].filter(visible).find(el => /выберите дату/i.test(text(el)) || /\d{1,2}[.\/-]\d{1,2}[.\/-]\d{4}/.test(text(el)));
    if (opener) { safeClick(opener); await sleep(350); }
    const y = +newDate.slice(0,4);
    const root = visibleDialog() || document;
    const match = await waitFor(() => collectDateOptions(root,y).find(x => x.date === newDate), 6000);
    if (!match) return { ok:false, code:'DATE_NOT_AVAILABLE', availableDates:[...new Set(collectDateOptions(root,y).map(x=>x.date))] };
    safeClick(match.el.closest('button,[role="option"],li,[role="button"]') || match.el);
    await sleep(250);
    return { method:'option', label:match.label };
  }
  async function verifyDateStrict(newDate, timeout = 12000) {
    const y = +newDate.slice(0,4);
    const found = await waitFor(() => currentArrivalDate(y) === newDate, timeout, 300);
    return !!found;
  }
  async function changeArrivalDate(orderCode, newDate) {
    if (!/kaspi\.kz/i.test(location.hostname)) throw new Error('Открыта не страница Kaspi.');
    if (/войти|авторизац/i.test(text(document.body)) && !/кабинет продавца/i.test(text(document.body))) throw Object.assign(new Error('Сначала войдите в кабинет продавца Kaspi.'), { code:'NOT_LOGGED_IN' });
    await searchOrder(orderCode);
    const before = currentArrivalDate(+newDate.slice(0,4));
    if (before === newDate) return { ok:true, verified:true, already:true, orderCode, newDate, message:'В Kaspi уже установлена эта дата.' };
    const changeBtn = await waitFor(findArrivalChangeButton, 8000);
    if (!changeBtn) throw Object.assign(new Error('У заказа не найдена кнопка «Изменить» для планируемой даты прибытия.'), { code:'CHANGE_BUTTON_NOT_FOUND' });
    safeClick(changeBtn);
    const picked = await chooseDate(newDate);
    if (picked && picked.ok === false) return picked;
    const dialog = await waitFor(visibleDialog, 5000);
    if (!dialog) throw Object.assign(new Error('Окно изменения даты закрылось до сохранения.'), { code:'DATE_DIALOG_LOST' });
    const save = findByText('Сохранить', dialog) || findByText('Сохранить');
    if (!save) throw Object.assign(new Error('Не найдена кнопка «Сохранить».'), { code:'SAVE_BUTTON_NOT_FOUND' });
    const enabled = await waitFor(() => (!save.disabled && save.getAttribute('aria-disabled') !== 'true') ? save : null, 6000);
    if (!enabled) return { ok:false, code:'SAVE_DISABLED', error:'Kaspi не активировал кнопку «Сохранить» для выбранной даты.', availableDates:collectDateOptions(dialog,+newDate.slice(0,4)).map(x=>x.date) };
    safeClick(save);
    await waitFor(() => !visibleDialog(), 10000);
    const verified = await verifyDateStrict(newDate, 12000);
    if (!verified) {
      const actualDate = currentArrivalDate(+newDate.slice(0,4));
      return { ok:false, code:'VERIFY_FAILED', error:'Kaspi не изменил дату после сохранения.', orderCode, requestedDate:newDate, actualDate:actualDate || before || '' };
    }
    return { ok:true, verified:true, orderCode, newDate, message:'Дата изменена и подтверждена в Kaspi.' };
  }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== 'KASPI_CHANGE_ARRIVAL_DATE') return;
    changeArrivalDate(String(message.orderCode || ''), String(message.newDate || ''))
      .then(sendResponse)
      .catch(error => sendResponse({ ok:false, code:error.code || 'AUTOMATION_ERROR', error:String(error && error.message || error) }));
    return true;
  });
})();
