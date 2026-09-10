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
