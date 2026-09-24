'use strict';

const KASPI_URL = 'https://kaspi.kz/mc/';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function findKaspiTab() {
  const tabs = await chrome.tabs.query({ url: ['https://kaspi.kz/mc/*', 'https://kaspi.kz/*'] });
  return tabs.find(t => /kaspi\.kz\/mc\//i.test(t.url || '')) || tabs[0] || null;
}

async function waitTabComplete(tabId, timeout = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') return tab;
    } catch (_) {}
    await sleep(300);
  }
  return chrome.tabs.get(tabId);
}

async function sendWithRetry(tabId, message, timeout = 45000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeout) {
    try {
      const result = await chrome.tabs.sendMessage(tabId, message);
      if (result) return result;
    } catch (e) {
      lastError = e;
    }
    await sleep(700);
  }
  throw lastError || new Error('Не удалось подключиться к странице Kaspi.');
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'CHANGE_ARRIVAL_DATE') return;

  (async () => {
    let tab = await findKaspiTab();
    if (!tab) {
      tab = await chrome.tabs.create({ url: KASPI_URL, active: true });
    } else {
      await chrome.tabs.update(tab.id, { active: true });
    }
    await waitTabComplete(tab.id);
    await sleep(700);
    const result = await sendWithRetry(tab.id, {
      type: 'KASPI_CHANGE_ARRIVAL_DATE',
      orderCode: message.orderCode,
      newDate: message.newDate
    });
    return { ...result, tabId: tab.id };
  })().then(sendResponse).catch(error => {
    sendResponse({ ok: false, code: 'BACKGROUND_ERROR', error: String(error && error.message || error) });
  });

  return true;
});


const GB_WB_SYNC_API = 'https://grants-book-kaspi-assistant.vercel.app/api/wb-sheets-sync-v3';
const GB_WB_ALARM = 'gb-wb-price-sync';
const GB_WB_BATCH = 20;

function gbChunks(values, size) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function gbWbQty(size) {
  return (Array.isArray(size?.stocks) ? size.stocks : []).reduce((sum, stock) => sum + Math.max(0, Number(stock?.qty || 0)), 0);
}

function gbParseWbProduct(product) {
  const id = Number(product?.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  const variants = [];
  for (const size of Array.isArray(product?.sizes) ? product.sizes : []) {
    const productPrice = Number(size?.price?.product || 0);
    const logistics = Math.max(0, Number(size?.price?.logistics || 0));
    if (productPrice <= 0) continue;
    let hours = Math.max(0, Number(size?.time1 || 0)) + Math.max(0, Number(size?.time2 || 0));
    if (!hours) {
      const times = (Array.isArray(size?.stocks) ? size.stocks : [])
        .filter(stock => Number(stock?.qty || 0) > 0)
        .map(stock => Math.max(0, Number(stock?.time1 || 0)) + Math.max(0, Number(stock?.time2 || 0)))
        .filter(Boolean);
      if (times.length) hours = Math.min(...times);
    }
    variants.push({
      product: productPrice,
      logistics,
      total: productPrice + logistics,
      available: gbWbQty(size) > 0,
      hours
    });
  }
  if (!variants.length) return null;
  const available = variants.filter(v => v.available);
  const pool = available.length ? available : variants;
  const best = pool.reduce((a, b) => b.total < a.total ? b : a);
  return {
    id,
    seller: String(product?.supplier || '').trim(),
    product: best.product / 100,
    logistics: best.logistics / 100,
    price: best.total / 100,
    days: best.hours ? Math.max(1, Math.ceil(best.hours / 24)) : null
  };
}

function gbBuildWbUrl(ids, destination) {
  const url = new URL('https://card.wb.ru/cards/v4/detail');
  url.searchParams.set('appType', '1');
  url.searchParams.set('curr', 'kzt');
  url.searchParams.set('dest', String(destination || 82));
  url.searchParams.set('spp', '30');
  url.searchParams.set('lang', 'ru');
  url.searchParams.set('ab_testing', 'false');
  url.searchParams.set('nm', ids.join(';'));
  return url.toString();
}

async function gbReadPageText(tabId) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const body = document.body?.innerText || document.body?.textContent || '';
      const root = document.documentElement?.innerText || document.documentElement?.textContent || '';
      return String(body || root || '').trim();
    }
  });
  return String(result?.[0]?.result || '').trim();
}

async function gbFetchWbBatch(ids, destination, tabId) {
  const url = gbBuildWbUrl(ids, destination);
  await chrome.tabs.update(tabId, { url, active: false });
  await waitTabComplete(tabId, 30000);
  await sleep(650);

  const text = await gbReadPageText(tabId);
  if (!text) throw new Error('WB browser tab returned empty response');
  if (/403\s+Forbidden/i.test(text)) throw new Error('WB browser tab HTTP 403');
  if (/429\s+Too Many Requests/i.test(text)) throw new Error('WB browser tab HTTP 429');

  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  let first = -1;
  if (firstBrace >= 0 && firstBracket >= 0) first = Math.min(firstBrace, firstBracket);
  else first = Math.max(firstBrace, firstBracket);
  const payload = first > 0 ? text.slice(first) : text;
  if (!payload.startsWith('{') && !payload.startsWith('[')) {
    throw new Error('WB browser tab returned non-JSON: ' + payload.slice(0, 160));
  }

  let json;
  try {
    json = JSON.parse(payload);
  } catch (error) {
    throw new Error('WB browser tab JSON parse failed: ' + String(error?.message || error));
  }

  const products = Array.isArray(json?.products)
    ? json.products
    : (Array.isArray(json?.data?.products) ? json.data.products : []);
  return products.map(gbParseWbProduct).filter(Boolean);
}

async function gbRunWbPriceSync() {
  const sourceResponse = await fetch(GB_WB_SYNC_API + '?mode=browser-source&t=' + Date.now(), { cache: 'no-store' });
  const source = await sourceResponse.json().catch(() => ({}));
  if (!sourceResponse.ok || !source.ok) throw new Error(source.error || ('Source HTTP ' + sourceResponse.status));
  const ids = Array.isArray(source.ids) ? source.ids.map(Number).filter(Number.isInteger) : [];
  if (!ids.length) return { ok: true, updated: 0, message: 'WB ссылок нет' };

  const snapshots = [];
  const errors = [];
  let wbTab = null;
  try {
    wbTab = await chrome.tabs.create({ url: 'about:blank', active: false });
    for (const batch of gbChunks(ids, GB_WB_BATCH)) {
      try {
        snapshots.push(...await gbFetchWbBatch(batch, Number(source.destination || 82), wbTab.id));
      } catch (error) {
        errors.push(String(error && error.message || error));
      }
      await sleep(450);
    }
  } finally {
    if (wbTab?.id) {
      try { await chrome.tabs.remove(wbTab.id); } catch (_) {}
    }
  }

  if (!snapshots.length) {
    throw new Error('Chrome не получил цены WB через браузерную вкладку: ' + (errors[0] || 'нет данных'));
  }

  const ingestResponse = await fetch(GB_WB_SYNC_API + '?mode=browser-ingest&t=' + Date.now(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-grants-book-wb-bridge': '1'
    },
    body: JSON.stringify({ snapshots }),
    cache: 'no-store'
  });
  const result = await ingestResponse.json().catch(() => ({}));
  if (!ingestResponse.ok || !result.ok) throw new Error(result.error || ('Ingest HTTP ' + ingestResponse.status));
  await chrome.storage.local.set({
    gbWbLastSyncAt: new Date().toISOString(),
    gbWbLastSyncResult: result,
    gbWbLastError: ''
  });
  return result;
}

async function gbRememberWbError(error) {
  await chrome.storage.local.set({
    gbWbLastErrorAt: new Date().toISOString(),
    gbWbLastError: String(error && error.message || error)
  });
}

function gbEnsureWbAlarm() {
  chrome.alarms.create(GB_WB_ALARM, { delayInMinutes: 1, periodInMinutes: 15 });
}

chrome.runtime.onInstalled.addListener(() => {
  gbEnsureWbAlarm();
  gbRunWbPriceSync().catch(gbRememberWbError);
});

chrome.runtime.onStartup.addListener(() => {
  gbEnsureWbAlarm();
  gbRunWbPriceSync().catch(gbRememberWbError);
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm?.name === GB_WB_ALARM) gbRunWbPriceSync().catch(gbRememberWbError);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'WB_SYNC_NOW') return;
  gbRunWbPriceSync().then(sendResponse).catch(error => {
    gbRememberWbError(error);
    sendResponse({ ok: false, error: String(error && error.message || error) });
  });
  return true;
});
