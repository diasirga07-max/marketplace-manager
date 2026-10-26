'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { handler } = require('../lib/grants-data-service');

function invoke({ method = 'GET', query = {}, headers = {}, body } = {}) {
  const responseHeaders = new Map();
  let responseBody = '';
  const req = { method, query, headers, body };
  const res = {
    statusCode: 200,
    setHeader(name, value) {
      responseHeaders.set(String(name).toLowerCase(), String(value));
    },
    end(value = '') {
      responseBody = String(value);
    },
  };

  return Promise.resolve(handler(req, res)).then(() => ({
    status: res.statusCode,
    headers: Object.fromEntries(responseHeaders),
    text: responseBody,
    json: responseBody ? JSON.parse(responseBody) : null,
  }));
}

test('health keeps the legacy contract and reports the restored service', async () => {
  const response = await invoke({ query: { op: 'health' } });
  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.equal(response.json.version, '14.1.1');
  assert.equal(typeof response.json.serverTokenConfigured, 'boolean');
  assert.equal(response.headers['access-control-allow-origin'], '*');
});

test('protected operations do not run without a Kaspi token', async () => {
  const response = await invoke({ query: { op: 'orders' } });
  assert.equal(response.status, 401);
  assert.equal(response.json.ok, false);
  assert.match(response.json.error, /token/i);
});

test('OPTIONS preserves CORS compatibility', async () => {
  const response = await invoke({ method: 'OPTIONS' });
  assert.equal(response.status, 204);
  assert.equal(response.text, '');
  assert.match(response.headers['access-control-allow-methods'], /POST/);
});

test('scanner rejects an empty scan before any upstream request', async () => {
  const response = await invoke({
    method: 'POST',
    query: { op: 'scan' },
    headers: { 'x-kaspi-token': 'test-token' },
    body: { scan: 'not-a-number' },
  });
  assert.equal(response.status, 400);
  assert.equal(response.json.ok, false);
});

test('orders export keeps the legacy group validation without another function', async () => {
  const response = await invoke({
    query: { op: 'orders-export', group: 'unknown' },
    headers: { 'x-kaspi-token': 'test-token' },
  });
  assert.equal(response.status, 400);
  assert.match(response.json.error, /group must be/);
});

test('unknown operation returns 404 for an authenticated request', async () => {
  const response = await invoke({
    query: { op: 'does-not-exist' },
    headers: { 'x-kaspi-token': 'test-token' },
  });
  assert.equal(response.status, 404);
  assert.equal(response.json.ok, false);
});

test('browser data modules keep API traffic on the active deployment', () => {
  const read = relative => fs.readFileSync(path.join(__dirname, relative), 'utf8');
  const shell = read('../index.html');
  const guard = read('../public/gb-api-guard.js');
  const service = read('../lib/grants-data-service.js');
  const chat = read('../../public/gb-chat.js');
  const newOrders = read('../../public/gb-new-orders.js');
  const preorder = read('../../public/gb-preorder-dates-v2.js');
  const historicalApi = /https:\/\/grants-book-kaspi-assistant-[a-z0-9]+-dias10\.vercel\.app\/api\//i;

  assert.match(shell, /gb-api-guard\.js\?v=20261018-1/);
  assert.match(shell, /const API='\/api\/preorder-dates';/);
  assert.match(shell, /const LIVE_FALLBACK='\/api\/data\?op=orders';/);
  assert.match(shell, /const urls=\[\.\.\.new Set\(\[LIVE_API,LIVE_FALLBACK\]\)\];/);
  assert.match(guard, /url\.pathname\.startsWith\('\/api\/'\)/);
  assert.doesNotMatch(chat, historicalApi);
  assert.match(chat, /Array\.isArray\(d\?\.orders\)\?d\.orders:d\?\.rows/);
  assert.doesNotMatch(newOrders, historicalApi);
  assert.doesNotMatch(preorder, historicalApi);
  assert.match(preorder, /const urls=\[\.\.\.new Set\(\[LIVE_API,LIVE_FALLBACK\]\)\];/);
  assert.match(service, /rows, orders: rows/);

  const expression = shell.match(/const apiPatch=(.*);\n\s*h=h\.replace\(unpackMarker/);
  assert.ok(expression, 'nested API patch must remain discoverable');
  const apiPatch = vm.runInNewContext(`(${expression[1]})`);
  const context = { h: "<html><head></head><body><script>const API_BASE='https://legacy.example/api/data';</script></body></html>", Error };
  vm.runInNewContext(apiPatch, context);
  assert.match(context.h, /<script src='\/gb-api-guard\.js\?v=20261018-1'><\/script>/);
  assert.match(context.h, /const API_BASE='\/api\/data'/);

  const calls = [];
  const browser = { fetch: input => { calls.push(input); return Promise.resolve({ ok: true }); } };
  vm.runInNewContext(guard, {
    window: browser,
    URL,
    Request,
    location: { href: 'https://grants-book-kaspi-assistant.vercel.app/' },
  });
  browser.fetch('https://grants-book-kaspi-assistant-aex41sn9x-dias10.vercel.app/api/data?op=orders');
  browser.fetch('https://raw.githubusercontent.com/example/module.js');
  assert.equal(calls[0], '/api/data?op=orders');
  assert.equal(calls[1], 'https://raw.githubusercontent.com/example/module.js');

  const preorderExpression = shell.match(/const preorderAddon=(`[^]*?`);\n\s*const qualityAddon=/);
  assert.ok(preorderExpression, 'preorder add-on must remain discoverable');
  const preorderAddon = vm.runInNewContext(`(${preorderExpression[1]})`);
  assert.doesNotThrow(() => new vm.Script(preorderAddon));
});
