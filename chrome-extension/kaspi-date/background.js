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

function gbParseWbText(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('WB browser returned empty response');
  if (/403\s+Forbidden/i.test(raw)) throw new Error('WB browser HTTP 403');
  if (/429\s+Too Many Requests/i.test(raw)) throw new Error('WB browser HTTP 429');

  const firstBrace = raw.indexOf('{');
  const firstBracket = raw.indexOf('[');
  let first = -1;
  if (firstBrace >= 0 && firstBracket >= 0) first = Math.min(firstBrace, firstBracket);
  else first = Math.max(firstBrace, firstBracket);
  const payload = first > 0 ? raw.slice(first) : raw;
  if (!payload.startsWith('{') && !payload.startsWith('[')) {
    throw new Error('WB browser returned non-JSON: ' + payload.slice(0, 160));
  }

  let json;
  try {
    json = JSON.parse(payload);
  } catch (error) {
    throw new Error('WB browser JSON parse failed: ' + String(error?.message || error));
  }

  const products = Array.isArray(json?.products)
    ? json.products
    : (Array.isArray(json?.data?.products) ? json.data.products : []);
  return products.map(gbParseWbProduct).filter(Boolean);
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

async function gbFetchFromPageContext(tabId, url) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async targetUrl => {
      try {
        const response = await fetch(targetUrl, {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
          headers: { accept: 'application/json, text/plain, */*' }
        });
        const text = await response.text();
        return { ok: response.ok, status: response.status, text };
      } catch (error) {
        return { ok: false, status: 0, error: String(error?.message || error), text: '' };
      }
    },
    args: [url]
  });
  return result?.[0]?.result || { ok: false, status: 0, error: 'No page result', text: '' };
}

async function gbFetchWbBatch(ids, destination, tabId) {
  const url = gbBuildWbUrl(ids, destination);

  // First try exactly as the real Wildberries website would: from a WB page,
  // with the user's browser cookies, IP address and TLS/browser fingerprint.
  try {
    const pageResult = await gbFetchFromPageContext(tabId, url);
    if (pageResult?.ok && pageResult.text) return gbParseWbText(pageResult.text);
  } catch (_) {}

  // If CORS or page JavaScript blocks that request, navigate the hidden tab
  // directly to the JSON endpoint. Top-level navigation is not subject to CORS.
  await chrome.tabs.update(tabId, { url, active: false });
  await waitTabComplete(tabId, 30000);
  await sleep(650);
  return gbParseWbText(await gbReadPageText(tabId));
}

async function gbExtractProductPageSnapshot(tabId, item) {
  const id = Number(item?.id);
  const link = String(item?.link || ('https://www.wildberries.ru/catalog/' + id + '/detail.aspx')).trim();
  await chrome.tabs.update(tabId, { url: link, active: false });
  await waitTabComplete(tabId, 30000);
  await sleep(2200);

  const result = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: expectedId => {
      const num = value => {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        const s = String(value ?? '').replace(/\u00a0/g, ' ').replace(/[^\d.,]/g, '').replace(/\s+/g, '').replace(',', '.');
        const n = Number(s);
        return Number.isFinite(n) ? n : 0;
      };

      const prices = [];
      const sellers = [];

      const addPrice = value => {
        const n = num(value);
        if (n >= 20 && n <= 100000000) prices.push(n);
      };
      const addSeller = value => {
        const s = String(value || '').trim();
        if (s && s.length <= 200) sellers.push(s);
      };

      const walk = node => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        const type = String(node['@type'] || '').toLowerCase();
        if (type === 'offer' || type === 'aggregateoffer' || Object.prototype.hasOwnProperty.call(node, 'price')) {
          addPrice(node.price);
          addPrice(node.lowPrice);
          addPrice(node.highPrice);
        }
        if (node.seller) {
          if (typeof node.seller === 'string') addSeller(node.seller);
          else addSeller(node.seller.name);
        }
        for (const value of Object.values(node)) walk(value);
      };

      for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
        try { walk(JSON.parse(script.textContent || '')); } catch (_) {}
      }

      for (const el of document.querySelectorAll(
        'meta[itemprop="price"],meta[property="product:price:amount"],[itemprop="price"],[data-link*="price"],[class*="price"]'
      )) {
        addPrice(el.getAttribute?.('content'));
        const txt = String(el.textContent || '').trim();
        const matches = txt.match(/(?:\d[\d\s\u00a0]{0,12})(?:[.,]\d{1,2})?(?=\s*(?:₸|тг|KZT))/gi) || [];
        matches.forEach(addPrice);
      }

      const bodyText = String(document.body?.innerText || '');
      const kztMatches = bodyText.match(/(?:\d[\d\s\u00a0]{0,12})(?:[.,]\d{1,2})?\s*(?:₸|тг|KZT)/gi) || [];
      kztMatches.slice(0, 50).forEach(addPrice);

      for (const el of document.querySelectorAll('[itemprop="seller"] [itemprop="name"],[itemprop="seller"],[class*="seller"]')) {
        addSeller(el.getAttribute?.('content') || el.textContent);
      }

      const uniquePrices = [...new Set(prices.map(x => Math.round(x * 100) / 100))].sort((a,b)=>a-b);
      const price = uniquePrices[0] || 0;
      return {
        id: expectedId,
        price,
        product: price,
        logistics: 0,
        seller: sellers[0] || '',
        days: null,
        url: location.href,
        title: document.title,
        priceCandidates: uniquePrices.slice(0, 12)
      };
    },
    args: [id]
  });

  const snapshot = result?.[0]?.result || null;
  if (!snapshot || !Number(snapshot.price)) throw new Error('Не удалось извлечь KZT-цену со страницы WB ' + id);
  return snapshot;
}

async function gbSendReport(payload) {
  try {
    await fetch(GB_WB_SYNC_API + '?mode=browser-report&t=' + Date.now(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-grants-book-wb-bridge': '1'
      },
      body: JSON.stringify(payload),
      cache: 'no-store'
    });
  } catch (_) {}
}

async function gbRunWbPriceSync() {
  const sourceResponse = await fetch(GB_WB_SYNC_API + '?mode=browser-source&t=' + Date.now(), { cache: 'no-store' });
  const source = await sourceResponse.json().catch(() => ({}));
  if (!sourceResponse.ok || !source.ok) throw new Error(source.error || ('Source HTTP ' + sourceResponse.status));
  const ids = Array.isArray(source.ids) ? source.ids.map(Number).filter(Number.isInteger) : [];
  const items = Array.isArray(source.items)
    ? source.items.filter(x => Number.isInteger(Number(x?.id)) && Number(x.id) > 0)
    : ids.map(id => ({ id, link: 'https://www.wildberries.ru/catalog/' + id + '/detail.aspx' }));
  if (!ids.length) return { ok: true, updated: 0, message: 'WB ссылок нет' };

  const snapshots = [];
  const errors = [];
  let wbTab = null;
  try {
    wbTab = await chrome.tabs.create({ url: 'https://www.wildberries.ru/', active: false });
    await waitTabComplete(wbTab.id, 30000);
    await sleep(1200);

    for (const batch of gbChunks(ids, GB_WB_BATCH)) {
      try {
        snapshots.push(...await gbFetchWbBatch(batch, Number(source.destination || 82), wbTab.id));
      } catch (error) {
        errors.push('API: ' + String(error && error.message || error));
      }
      await sleep(450);
    }

    const have = new Set(snapshots.map(x => Number(x?.id)));
    const missingItems = items.filter(x => !have.has(Number(x.id)));
    for (const item of missingItems) {
      try {
        snapshots.push(await gbExtractProductPageSnapshot(wbTab.id, item));
      } catch (error) {
        errors.push('PAGE ' + item.id + ': ' + String(error && error.message || error));
      }
      await sleep(350);
    }
  } finally {
    if (wbTab?.id) {
      try { await chrome.tabs.remove(wbTab.id); } catch (_) {}
    }
  }

  await gbSendReport({
    event: 'sync-fetch-finished',
    extensionVersion: chrome.runtime.getManifest().version,
    requested: ids.length,
    snapshots: snapshots.length,
    errors: errors.slice(0, 30)
  });

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
  const message = String(error && error.message || error);
  await chrome.storage.local.set({
    gbWbLastErrorAt: new Date().toISOString(),
    gbWbLastError: message
  });
  await gbSendReport({
    event: 'sync-error',
    extensionVersion: chrome.runtime.getManifest().version,
    error: message
  });
}

function gbEnsureWbAlarm() {
  chrome.alarms.create(GB_WB_ALARM, { delayInMinutes: 1, periodInMinutes: 5 });
}

gbEnsureWbAlarm();

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
