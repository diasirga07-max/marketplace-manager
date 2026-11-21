'use strict';

// Minimal Google Sheets client for the service account stored in
// GOOGLE_SERVICE_ACCOUNT_JSON. Shared by the analytics storage layer.

const crypto = require('node:crypto');

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const RETRYABLE_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);

const SPREADSHEET_ID = String(
  process.env.KASPI_SHEET_ID ||
    process.env.GOOGLE_SHEET_ID ||
    process.env.GOOGLE_SPREADSHEET_ID ||
    '1dLU5KOi3WBLy3uNEiqGv5rf9ka0OwcEw_RjhDQW3H1E',
).trim();

const STATE = globalThis.__GB_GOOGLE_SHEETS || (globalThis.__GB_GOOGLE_SHEETS = {
  token: null,
  sheetTitles: null,
  sheetTitlesAt: 0,
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function b64url(value) {
  return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function configured() {
  return Boolean(String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim());
}

function serviceAccount() {
  const raw = String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON не настроен');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Некорректный GOOGLE_SERVICE_ACCOUNT_JSON: ${error.message}`);
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('Service Account JSON не содержит client_email/private_key');
  }
  return { email: parsed.client_email, key: String(parsed.private_key).replace(/\\n/g, '\n') };
}

async function googleToken() {
  if (STATE.token && STATE.token.exp > Date.now() + 60_000) return STATE.token.value;
  const account = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: account.email,
    scope: GOOGLE_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${head}.${claims}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${b64url(signer.sign(account.key))}`;
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json.access_token) {
    throw new Error(`Google OAuth ${response.status}: ${json.error_description || json.error || 'token error'}`);
  }
  STATE.token = { value: json.access_token, exp: Date.now() + Number(json.expires_in || 3600) * 1000 };
  return STATE.token.value;
}

async function request(path, { method = 'GET', body, label = 'Google Sheets' } = {}) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const token = await googleToken();
      const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body == null ? undefined : JSON.stringify(body),
        cache: 'no-store',
      });
      const text = await response.text();
      if (response.ok) return text ? JSON.parse(text) : {};
      lastError = new Error(`${label} ${response.status}: ${text.slice(0, 300)}`);
      lastError.status = response.status;
      if (!RETRYABLE_HTTP.has(response.status)) throw lastError;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (lastError.status && !RETRYABLE_HTTP.has(lastError.status)) throw lastError;
      if (attempt === 3) throw lastError;
    }
    await sleep(400 * 2 ** attempt + Math.floor(Math.random() * 200));
  }
  throw lastError || new Error(`${label} failed`);
}

function a1(sheet, range) {
  return `'${String(sheet).replace(/'/g, "''")}'!${range}`;
}

async function sheetTitles(force = false) {
  if (!force && STATE.sheetTitles && Date.now() - STATE.sheetTitlesAt < 10 * 60_000) {
    return STATE.sheetTitles;
  }
  const json = await request('?fields=sheets.properties.title', { label: 'Google Sheets meta' });
  STATE.sheetTitles = new Set((json.sheets || []).map((sheet) => sheet.properties.title));
  STATE.sheetTitlesAt = Date.now();
  return STATE.sheetTitles;
}

async function ensureSheet(title, header) {
  const titles = await sheetTitles();
  if (titles.has(title)) return false;
  try {
    await request(':batchUpdate', {
      method: 'POST',
      label: 'Google Sheets addSheet',
      body: { requests: [{ addSheet: { properties: { title, hidden: true } } }] },
    });
  } catch (error) {
    // Another instance may have created it concurrently.
    if (!/already exists/i.test(error.message)) throw error;
  }
  titles.add(title);
  if (Array.isArray(header) && header.length) await putValues(title, 'A1', [header]);
  return true;
}

async function getValues(sheet, range = 'A:Z') {
  const json = await request(
    `/values/${encodeURIComponent(a1(sheet, range))}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`,
    { label: 'Google Sheets GET' },
  );
  return Array.isArray(json.values) ? json.values : [];
}

async function batchGetValues(sheet, ranges) {
  if (!ranges.length) return [];
  const query = ranges.map((range) => `ranges=${encodeURIComponent(a1(sheet, range))}`).join('&');
  const json = await request(
    `/values:batchGet?${query}&majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`,
    { label: 'Google Sheets batchGet' },
  );
  return (json.valueRanges || []).map((range) => (Array.isArray(range.values) ? range.values : []));
}

async function putValues(sheet, range, values) {
  return request(`/values/${encodeURIComponent(a1(sheet, range))}?valueInputOption=RAW`, {
    method: 'PUT',
    label: 'Google Sheets PUT',
    body: { range: a1(sheet, range), majorDimension: 'ROWS', values },
  });
}

async function clearValues(sheet, range = 'A2:Z') {
  return request(`/values/${encodeURIComponent(a1(sheet, range))}:clear`, {
    method: 'POST',
    label: 'Google Sheets CLEAR',
    body: {},
  });
}

module.exports = {
  SPREADSHEET_ID,
  batchGetValues,
  clearValues,
  configured,
  ensureSheet,
  getValues,
  putValues,
};
