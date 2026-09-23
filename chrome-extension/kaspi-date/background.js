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

async function gbFetchWbBatch(ids, destination) {
  const url = new URL('https://card.wb.ru/cards/v4/detail');
  url.searchParams.set('appType', '1');
  url.searchParams.set('curr', 'kzt');
  url.searchParams.set('dest', String(destination || 82));
  url.searchParams.set('spp', '30');
  url.searchParams.set('lang', 'ru');
  url.searchParams.set('ab_testing', 'false');
  url.searchParams.set('nm', ids.join(';'));

  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          accept: 'application/json, text/plain, */*',
          'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8'
        },
        credentials: 'include',
        cache: 'no-store'
      });
      const text = await response.text();
      if (!response.ok) throw new Error('WB HTTP ' + response.status + ': ' + text.slice(0, 120));
      const trimmed = String(text || '').trim();
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) throw new Error('WB вернул не JSON');
      const json = JSON.parse(trimmed);
      const products = Array.isArray(json?.products) ? json.products : (Array.isArray(json?.data?.products) ? json.data.products : []);
      return products.map(gbParseWbProduct).filter(Boolean);
    } catch (error) {
      lastError = error;
      await sleep(700 * (attempt + 1));
    }
  }
  throw lastError || new Error('WB request failed');
}

async function gbRunWbPriceSync() {
  const sourceResponse = await fetch(GB_WB_SYNC_API + '?mode=browser-source&t=' + Date.now(), { cache: 'no-store' });
  const source = await sourceResponse.json().catch(() => ({}));
  if (!sourceResponse.ok || !source.ok) throw new Error(source.error || ('Source HTTP ' + sourceResponse.status));
  const ids = Array.isArray(source.ids) ? source.ids.map(Number).filter(Number.isInteger) : [];
  if (!ids.length) return { ok: true, updated: 0, message: 'WB ссылок нет' };

  const snapshots = [];
  const errors = [];
  for (const batch of gbChunks(ids, GB_WB_BATCH)) {
    try {
      snapshots.push(...await gbFetchWbBatch(batch, Number(source.destination || 82)));
    } catch (error) {
      errors.push(String(error && error.message || error));
    }
    await sleep(350);
  }

  if (!snapshots.length) {
    throw new Error('Chrome не получил цены WB: ' + (errors[0] || 'нет данных'));
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
