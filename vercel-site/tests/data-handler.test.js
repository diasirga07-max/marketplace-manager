'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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
  assert.equal(response.json.version, '14.0.0');
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
