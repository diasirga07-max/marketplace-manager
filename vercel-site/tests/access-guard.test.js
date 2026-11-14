'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { protect } = require('../lib/access-guard');

async function invoke({ configured, method = 'GET', query = {}, headers = {}, isPublic } = {}) {
  const previousCode = process.env.GB_ACCESS_CODE;
  if (configured == null) delete process.env.GB_ACCESS_CODE;
  else process.env.GB_ACCESS_CODE = configured;
  try {
    const responseHeaders = new Map();
    let text = '';
    const req = { method, query, headers };
    const res = {
      statusCode: 200,
      setHeader(name, value) { responseHeaders.set(String(name).toLowerCase(), value); },
      end(value = '') { text = String(value); return this; },
    };
    const handler = (_req, reply) => reply.end(JSON.stringify({ ok: true }));
    await protect(handler, { isPublic })(req, res);
    return {
      status: res.statusCode,
      headers: Object.fromEntries(responseHeaders),
      body: JSON.parse(text),
    };
  } finally {
    if (previousCode === undefined) delete process.env.GB_ACCESS_CODE;
    else process.env.GB_ACCESS_CODE = previousCode;
  }
}

test('guard is disabled without GB_ACCESS_CODE', async () => {
  const response = await invoke();
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true });
});

test('missing code returns JSON 401 without caching', async () => {
  const response = await invoke({ configured: 'test-access-secret' });
  assert.equal(response.status, 401);
  assert.deepEqual(response.body, {
    ok: false,
    code: 'access_required',
    error: 'Требуется код доступа',
  });
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(response.headers['access-control-allow-origin'], '*');
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('incorrect code returns 401', async () => {
  const response = await invoke({
    configured: 'test-access-secret',
    headers: { 'x-gb-access': 'incorrect' },
  });
  assert.equal(response.status, 401);
});

test('correct X-GB-Access header allows the request', async () => {
  const response = await invoke({
    configured: 'test-access-secret',
    headers: { 'x-gb-access': 'test-access-secret' },
  });
  assert.equal(response.status, 200);
});

test('query ?access= works for Google Sheets', async () => {
  const response = await invoke({
    configured: 'test-access-secret',
    query: { access: 'test-access-secret' },
  });
  assert.equal(response.status, 200);
});

test('header takes priority over query parameter', async () => {
  const response = await invoke({
    configured: 'test-access-secret',
    query: { access: 'test-access-secret' },
    headers: { 'x-gb-access': 'incorrect' },
  });
  assert.equal(response.status, 401);
});

test('OPTIONS requests bypass access code validation', async () => {
  const response = await invoke({ configured: 'test-access-secret', method: 'OPTIONS' });
  assert.equal(response.status, 200);
});

test('isPublic requests bypass access code validation', async () => {
  const response = await invoke({
    configured: 'test-access-secret',
    query: { op: 'health' },
    isPublic: req => req.query.op === 'health',
  });
  assert.equal(response.status, 200);
});

test('trailing whitespace and newline in GB_ACCESS_CODE are ignored', async () => {
  const response = await invoke({
    configured: 'test-access-secret  \n',
    headers: { 'x-gb-access': 'test-access-secret' },
  });
  assert.equal(response.status, 200);
});
