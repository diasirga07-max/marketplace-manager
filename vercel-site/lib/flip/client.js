'use strict';

// Server-side client for the Flip.kz partner API (https://partner.flip.kz/api/v1).
// The key (FLIP_API_KEY) is sent as `Authorization: <key>` — without "Bearer" —
// and never leaves the server: it is not logged and not returned to the browser.
//
// API quirks handled here:
//   * parameter errors arrive with HTTP 200 — the reason is in body.error / body.errors;
//   * 403 / 404 arrive as an nginx HTML page, not JSON — handled by status;
//   * empty values (0, false, "", []) are omitted from responses — read as "no value";
//   * one order row = one unit (count is always 1); quantity = number of rows.

const DEFAULT_BASE = 'https://partner.flip.kz/api/v1';
const TIMEOUT_MS = 25_000;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

class FlipError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message);
    this.name = 'FlipError';
    this.status = status;
    this.code = code;
  }
}

function apiKey() {
  return String(process.env.FLIP_API_KEY || '').trim();
}

function configured() {
  return Boolean(apiKey());
}

function baseUrl() {
  return String(process.env.FLIP_API_BASE_URL || DEFAULT_BASE).trim().replace(/\/+$/, '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// body.error may be a string, {code, message} or absent; body.errors may be an
// array of strings/objects or an object {field: message}.
function bodyError(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '';
  const text = (value) => {
    if (value == null || value === '' || value === false) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    if (Array.isArray(value)) return value.map(text).filter(Boolean).join('; ');
    if (typeof value === 'object') {
      if (value.message || value.msg || value.description) return String(value.message || value.msg || value.description);
      return Object.entries(value).map(([k, v]) => `${k}: ${text(v)}`).join('; ');
    }
    return String(value);
  };
  return [text(body.error), text(body.errors)].filter(Boolean).join('; ');
}

function statusMessage(status) {
  if (status === 401) return 'Flip: ключ не передан или неверный (401)';
  if (status === 403) return 'Flip: доступ запрещён (403) — проверьте FLIP_API_KEY';
  if (status === 404) return 'Flip: метод не найден (404)';
  if (status === 429) return 'Flip: слишком много запросов (429)';
  return `Flip: HTTP ${status}`;
}

// Low-level GET. Returns parsed JSON or throws FlipError with a Russian message.
async function request(path, params = {}, { retries = 2, fetchImpl = fetch } = {}) {
  const key = apiKey();
  if (!key) throw new FlipError('FLIP_API_KEY не настроен в Vercel', { code: 'not_configured' });
  const url = new URL(baseUrl() + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: key, Accept: 'application/json' },
        signal: controller.signal,
        cache: 'no-store',
      });
      const raw = await response.text();
      const type = String(response.headers.get('content-type') || '');
      let body = null;
      if (/json/i.test(type) || /^\s*[[{]/.test(raw)) {
        try { body = JSON.parse(raw); } catch { body = null; }
      }
      if (!response.ok) {
        const detail = body ? bodyError(body) : '';
        const error = new FlipError(detail ? `${statusMessage(response.status)}: ${detail}` : statusMessage(response.status), { status: response.status });
        if (RETRYABLE.has(response.status) && attempt < retries) { lastError = error; await sleep(1500 * (attempt + 1)); continue; }
        throw error;
      }
      if (!body) throw new FlipError(`Flip вернул не JSON (HTTP ${response.status})`, { status: response.status });
      const detail = bodyError(body);
      if (detail) throw new FlipError(`Flip: ${detail}`, { status: response.status, code: 'body_error' });
      return body;
    } catch (error) {
      if (error instanceof FlipError) throw error;
      lastError = new FlipError(error && error.name === 'AbortError' ? 'Flip не ответил вовремя' : `Flip недоступен: ${error && error.message ? error.message : error}`);
      if (attempt < retries) { await sleep(1500 * (attempt + 1)); continue; }
      throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new FlipError('Flip: неизвестная ошибка');
}

// ---------- helpers for omitted values ----------

function num(value) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function str(value) {
  return value === undefined || value === null ? '' : String(value);
}

function list(value) {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) return value.map(str).filter(Boolean);
  return String(value).split(/[,;]\s*/).filter(Boolean);
}

function dataArray(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  for (const key of ['data', 'items', 'orders', 'result', 'rows']) {
    if (Array.isArray(body[key])) return body[key];
    if (body[key] && typeof body[key] === 'object' && Array.isArray(body[key].items)) return body[key].items;
  }
  return [];
}

// Real /orders responses wrap both levels in arrays: meta: [{ pagination: [{ total, limit, pages, currentPage }] }].
function pagination(body) {
  const one = (v) => (Array.isArray(v) ? v[0] : v) || {};
  const p = one(one(body && body.meta).pagination || (body && body.pagination));
  return { page: num(p.page || p.currentPage) || 1, pages: num(p.pages || p.pageCount || p.totalPages) || 1, total: num(p.total || p.totalCount) };
}

// ---------- orders ----------

function normalizeUnit(raw, group) {
  return {
    preorderId: str(raw.preorderId),
    produceId: str(raw.produceId),
    article: str(raw.article),
    title: str(raw.name || raw.title || raw.produceName),
    price: num(raw.price),
    partnerCodes: list(raw.partnerCodes),
    groupId: str(group.groupId),
  };
}

// The API may return either groups with nested units, or flat units carrying
// the group fields. Both are folded into Map<groupId, group>.
function mergeOrderRows(rows, groups = new Map()) {
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const nested = Array.isArray(row.items) ? row.items : Array.isArray(row.preorders) ? row.preorders : Array.isArray(row.units) ? row.units : null;
    const groupInfo = {
      groupId: str(row.groupId || (nested ? row.id : '')) || 'без группы',
      groupName: str(row.groupName),
      groupStoreName: str(row.groupStoreName),
    };
    let group = groups.get(groupInfo.groupId);
    if (!group) {
      group = { ...groupInfo, items: [], seen: new Set() };
      groups.set(groupInfo.groupId, group);
    }
    if (!group.groupName && groupInfo.groupName) group.groupName = groupInfo.groupName;
    if (!group.groupStoreName && groupInfo.groupStoreName) group.groupStoreName = groupInfo.groupStoreName;
    for (const unitRaw of nested || [row]) {
      const unit = normalizeUnit(unitRaw || {}, group);
      const id = unit.preorderId || `${group.groupId}:${group.items.length}`;
      if (group.seen.has(id)) continue; // a unit repeated on adjacent pages
      group.seen.add(id);
      group.items.push(unit);
    }
  }
  return groups;
}

function finishGroups(groups) {
  return [...groups.values()].map(({ seen, ...group }) => ({
    ...group,
    units: group.items.length,
    total: group.items.reduce((sum, item) => sum + item.price, 0),
  }));
}

// All pending orders, every page (pagination counts units, not groups).
async function fetchPendingOrders({ limit = 100, maxPages = 100, fetchImpl } = {}) {
  const groups = new Map();
  let page = 1;
  let pages = 1;
  do {
    const body = await request('/orders', { page, limit }, { fetchImpl });
    mergeOrderRows(dataArray(body), groups);
    pages = pagination(body).pages;
    page += 1;
  } while (page <= pages && page <= maxPages);
  const list = finishGroups(groups);
  return { groups: list, units: list.reduce((n, g) => n + g.units, 0), total: list.reduce((n, g) => n + g.total, 0), pages, fetchedAt: Date.now() };
}

// ---------- sales statistics ----------

async function fetchSales({ dateFrom, dateTo, include, page, limit, fetchImpl } = {}) {
  return request('/statistics/sales', { dateFrom, dateTo, include, page, limit }, { fetchImpl });
}

module.exports = {
  FlipError,
  bodyError,
  configured,
  dataArray,
  fetchPendingOrders,
  fetchSales,
  finishGroups,
  mergeOrderRows,
  num,
  pagination,
  request,
  sleep,
};
