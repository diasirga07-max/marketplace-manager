(() => {
  'use strict';
  if (window.__GB_KASPI_GRANTS_BRIDGE__) return;
  window.__GB_KASPI_GRANTS_BRIDGE__ = true;

  const DATE_STORE = 'gbPreorderDateOverridesV2';
  const codeKey = s => String(s || '').trim().replace(/-1$/, '');

  function validIso(s) {
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return false;
    const y = +m[1], mo = +m[2], d = +m[3];
    const x = new Date(Date.UTC(y, mo - 1, d));
    return x.getUTCFullYear() === y && x.getUTCMonth() === mo - 1 && x.getUTCDate() === d;
  }

  function parseDate(v) {
    const s = String(v || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return validIso(s) ? s : '';
    const m = s.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})$/);
    if (!m) return '';
    const iso = `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
    return validIso(iso) ? iso : '';
  }

  function fmt(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    return `${d}.${m}.${y}`;
  }

  function show(message, type = 'warn') {
    const box = document.getElementById('pdmsg');
    if (!box) return;
    box.textContent = message;
    box.className = 'pdmsg show ' + type;
  }

  function saveLocal(code, date) {
    try {
      const all = JSON.parse(localStorage.getItem(DATE_STORE) || '{}') || {};
      all[codeKey(code)] = date;
      localStorage.setItem(DATE_STORE, JSON.stringify(all));
    } catch (_) {}
  }

  function clearLocal(code) {
    try {
      const all = JSON.parse(localStorage.getItem(DATE_STORE) || '{}') || {};
      delete all[codeKey(code)];
      localStorage.setItem(DATE_STORE, JSON.stringify(all));
    } catch (_) {}
  }

  function dateInput(code) {
    const key = codeKey(code);
    return [...document.querySelectorAll('[data-date-input]')].find(el => el.dataset.dateInput === key) || null;
  }

  function setButton(button, text, disabled) {
    if (!button) return;
    button.textContent = text;
    button.disabled = !!disabled;
  }

  function injectStatus() {
    const head = document.querySelector('#gbPre .pdh');
    if (!head || document.getElementById('gbKaspiExtStatus')) return;
    const badge = document.createElement('span');
    badge.id = 'gbKaspiExtStatus';
    badge.textContent = '🧩 Kaspi расширение подключено';
    badge.style.cssText = 'display:inline-flex;align-items:center;padding:8px 10px;border-radius:999px;background:#ecfdf3;color:#027a48;font:800 12px Inter,Arial,sans-serif;border:1px solid #abefc6;';
    const close = document.getElementById('pdclose');
    head.insertBefore(badge, close || null);
  }

  new MutationObserver(injectStatus).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', injectStatus, { once: true });

  document.addEventListener('click', (event) => {
    const button = event.target && event.target.closest ? event.target.closest('#gbPre [data-change]') : null;
    if (!button) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const code = String(button.dataset.change || '').trim();
    const input = dateInput(code);
    const newDate = parseDate(input && input.value);
    if (!newDate) {
      show('Введите корректную дату в формате ДД.ММ.ГГГГ или выберите её календарём.', 'warn');
      if (input) input.focus();
      return;
    }

    saveLocal(code, newDate);
    setButton(button, 'Передаю в Kaspi…', true);
    show('Дата ' + fmt(newDate) + ' сохранена на сайте. Передаю её в авторизованный кабинет Kaspi…', 'ok');

    chrome.runtime.sendMessage({ type: 'CHANGE_ARRIVAL_DATE', orderCode: codeKey(code), newDate }, (result) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        setButton(button, 'Сохранить дату', false);
        show('Ошибка расширения: ' + runtimeError.message, 'err');
        return;
      }

      if (result && result.ok) {
        clearLocal(code);
        setButton(button, 'Изменено ✓', true);
        show(result.message || ('Дата ' + fmt(newDate) + ' изменена в Kaspi.'), 'ok');
        setTimeout(() => location.reload(), 1200);
        return;
      }

      setButton(button, 'Сохранить дату', false);
      if (result && result.code === 'DATE_NOT_AVAILABLE') {
        const available = [...new Set(result.availableDates || [])].slice(0, 15).map(fmt).join(', ');
        show('Kaspi не предлагает дату ' + fmt(newDate) + '.' + (available ? ' Доступные даты: ' + available : ' Выберите дату, доступную в кабинете Kaspi.'), 'err');
      } else if (result && result.code === 'NOT_LOGGED_IN') {
        show('Сначала войдите в кабинет продавца Kaspi в открывшейся вкладке, затем нажмите «Сохранить дату» ещё раз.', 'err');
      } else {
        show('Не удалось изменить дату в Kaspi: ' + String(result && (result.error || result.message) || 'неизвестная ошибка'), 'err');
      }
    });
  }, true);
})();
