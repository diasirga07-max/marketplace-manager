(()=>{
  'use strict';
  if (window.GB_ORDER_COPY_BUTTONS_LOADED) return;
  window.GB_ORDER_COPY_BUTTONS_LOADED = true;

  const STYLE_ID = 'gbOrderCopyButtonsStyle';
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #ot .gb-copy-cell{vertical-align:top}
      #ot .gb-copy-btn{
        display:inline-flex;
        align-items:center;
        gap:5px;
        margin:0 0 7px 0;
        padding:5px 8px;
        border:1px solid #d9dee8;
        border-radius:7px;
        background:#fff;
        color:#344054;
        font:700 11px/1.1 Arial,sans-serif;
        cursor:pointer;
        white-space:nowrap;
        box-shadow:0 1px 2px rgba(16,24,40,.05);
      }
      #ot .gb-copy-btn:hover{background:#f5f7fb;border-color:#b9c2d0}
      #ot .gb-copy-btn.gb-copied{background:#ecfdf3;border-color:#86efac;color:#067647}
      #ot .gb-copy-value{display:block}
    `;
    document.head.appendChild(style);
  }

  async function gbCopyText(text) {
    const value = String(text || '').trim();
    if (!value) return false;
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly','');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) {}
      ta.remove();
      return ok;
    }
  }

  function addCopyButton(td, kind) {
    if (!td || td.dataset.gbCopyReady === '1') return;

    const original = String(td.textContent || '').trim();
    if (!original) return;

    td.dataset.gbCopyReady = '1';
    td.dataset.gbCopyValue = original;
    td.classList.add('gb-copy-cell');

    td.textContent = '';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'gb-copy-btn';
    btn.textContent = '⧉ Скопировать';
    btn.title = kind === 'sku' ? 'Скопировать артикул' : 'Скопировать номера заказов';

    const value = document.createElement('span');
    value.className = 'gb-copy-value';
    value.textContent = original;

    btn.addEventListener('click', async e => {
      e.preventDefault();
      e.stopPropagation();
      const ok = await gbCopyText(td.dataset.gbCopyValue || '');
      const old = btn.textContent;
      btn.textContent = ok ? '✓ Скопировано' : 'Ошибка';
      if (ok) btn.classList.add('gb-copied');
      setTimeout(() => {
        btn.textContent = old;
        btn.classList.remove('gb-copied');
      }, 1200);
    });

    td.append(btn, value);
  }

  function enhanceRows() {
    const body = document.getElementById('ot');
    if (!body) return;
    for (const tr of body.querySelectorAll('tr')) {
      const cells = tr.querySelectorAll(':scope > td');
      if (cells.length < 5) continue;
      addCopyButton(cells[2], 'sku');
      addCopyButton(cells[4], 'orders');
    }
  }

  let queued = false;
  function scheduleEnhance() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      enhanceRows();
    });
  }

  const start = () => {
    const body = document.getElementById('ot');
    if (!body) {
      setTimeout(start, 250);
      return;
    }
    enhanceRows();
    new MutationObserver(scheduleEnhance).observe(body, {childList:true, subtree:true});
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, {once:true});
  } else {
    start();
  }
})();