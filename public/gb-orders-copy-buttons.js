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
      #ot .gb-sku-wrap{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
      #ot .gb-order-list{display:flex;flex-direction:column;gap:5px;align-items:flex-start}
      #ot .gb-order-item{display:flex;align-items:center;gap:6px;white-space:nowrap}
      #ot .gb-copy-btn{
        display:inline-flex;
        align-items:center;
        justify-content:center;
        min-height:26px;
        padding:4px 7px;
        border:1px solid #d9dee8;
        border-radius:7px;
        background:#fff;
        color:#344054;
        font:700 11px/1 Arial,sans-serif;
        cursor:pointer;
        white-space:nowrap;
        box-shadow:0 1px 2px rgba(16,24,40,.05);
      }
      #ot .gb-copy-btn:hover{background:#f5f7fb;border-color:#b9c2d0}
      #ot .gb-copy-btn.gb-copied{background:#ecfdf3;border-color:#86efac;color:#067647}
      #ot .gb-copy-mini{width:28px;min-width:28px;padding:4px;font-size:14px}
      #ot .gb-copy-value{font-weight:700}
      #ot .gb-order-number{font-variant-numeric:tabular-nums}
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

  function flashButton(btn, ok) {
    const old = btn.textContent;
    btn.textContent = ok ? '✓' : '!';
    if (ok) btn.classList.add('gb-copied');
    setTimeout(() => {
      btn.textContent = old;
      btn.classList.remove('gb-copied');
    }, 1000);
  }

  function cleanSku(td) {
    // Take only text nodes that belong directly to the SKU cell.
    // This excludes badges/links such as "WB ↗".
    const direct = [...td.childNodes]
      .filter(n => n.nodeType === Node.TEXT_NODE)
      .map(n => String(n.textContent || '').trim())
      .filter(Boolean)
      .join(' ')
      .trim();

    const clean = value => {
      let text = String(value || '').trim();
      // Remove WB status/link text even when it is glued directly to SKU,
      // e.g. "WBKANSPOD275WB: нет ссылки" -> "WBKANSPOD275".
      text = text.replace(/WB:\s*.*$/i, '').trim();
      text = text.replace(/\s*WB\s*[↗↑]?\s*$/i, '').trim();
      return text;
    };

    if (direct) return clean(direct);

    // Safe fallback for layouts where the SKU is wrapped in an element.
    return clean(td.textContent);
  }

  function enhanceSkuCell(td) {
    if (!td || td.dataset.gbCopyReady === 'sku') return;
    const sku = cleanSku(td);
    if (!sku) return;

    td.dataset.gbCopyReady = 'sku';
    td.classList.add('gb-copy-cell');
    td.textContent = '';

    const wrap = document.createElement('div');
    wrap.className = 'gb-sku-wrap';

    const value = document.createElement('span');
    value.className = 'gb-copy-value';
    value.textContent = sku;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'gb-copy-btn gb-copy-mini';
    btn.textContent = '⧉';
    btn.title = 'Скопировать артикул';
    btn.setAttribute('aria-label','Скопировать артикул');

    btn.addEventListener('click', async e => {
      e.preventDefault();
      e.stopPropagation();
      flashButton(btn, await gbCopyText(sku));
    });

    wrap.append(value, btn);
    td.append(wrap);
  }

  function extractOrderNumbers(td) {
    const text = String(td.textContent || '');
    const found = text.match(/\b\d{7,15}\b/g) || [];
    return [...new Set(found)];
  }

  function enhanceOrdersCell(td) {
    if (!td || td.dataset.gbCopyReady === 'orders') return;
    const orders = extractOrderNumbers(td);
    if (!orders.length) return;

    td.dataset.gbCopyReady = 'orders';
    td.classList.add('gb-copy-cell');
    td.textContent = '';

    const list = document.createElement('div');
    list.className = 'gb-order-list';

    for (const order of orders) {
      const item = document.createElement('div');
      item.className = 'gb-order-item';

      const number = document.createElement('span');
      number.className = 'gb-order-number';
      number.textContent = order;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gb-copy-btn gb-copy-mini';
      btn.textContent = '⧉';
      btn.title = 'Скопировать заказ ' + order;
      btn.setAttribute('aria-label','Скопировать заказ ' + order);

      btn.addEventListener('click', async e => {
        e.preventDefault();
        e.stopPropagation();
        flashButton(btn, await gbCopyText(order));
      });

      item.append(number, btn);
      list.append(item);
    }

    td.append(list);
  }

  function enhanceRows() {
    const body = document.getElementById('ot');
    if (!body) return;

    for (const tr of body.querySelectorAll('tr')) {
      const cells = tr.querySelectorAll(':scope > td');
      if (cells.length < 5) continue;
      enhanceSkuCell(cells[2]);
      enhanceOrdersCell(cells[4]);
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