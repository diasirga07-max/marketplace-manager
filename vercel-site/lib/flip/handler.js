'use strict';

// Flip API («Flip»). Served by api/data.js with module=flip (Hobby: max 12 functions).
//   GET  /api/flip?op=health
//   GET  op=orders[&live=1]           pending orders by warehouse
//   GET  op=badge&since=<ms>          number of orders first seen after `since`
//   GET  op=sales&from&to[&page]      sales report (summary; items for supplierType=fee)
//   GET  op=dynamics&from&to&granularity=day|week|month
//   POST op=backfill {days, force}    fill daily history (resumable, one request per day)
//   GET  op=poll                      cron (CRON_SECRET): new orders → Telegram
//        (/api/flip/poll-orders is rewritten here; called every 5 min by GitHub Actions)
//   GET  op=daily                     Vercel Cron, 01:00 Asia/Almaty (CRON_SECRET)
// All Flip requests happen on the server; FLIP_API_KEY never reaches the browser.

const crypto = require('node:crypto');
const client = require('./client');
const service = require('./service');
const store = require('./store');
const telegram = require('./telegram');

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.end(JSON.stringify(data));
}

function body(req) {
  let value = req.body || {};
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { value = {}; }
  }
  return value && typeof value === 'object' ? value : {};
}

// Cron endpoints require CRON_SECRET (Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`).
function cronAuthorized(req) {
  const secret = String(process.env.CRON_SECRET || '').trim();
  if (!secret) return false;
  const headers = req.headers || {};
  const given = String(headers.authorization || headers.Authorization || '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(`Bearer ${secret}`).digest();
  return crypto.timingSafeEqual(a, b);
}

function statusFor(error) {
  const message = String((error && error.message) || '');
  if (error && error.code === 'not_configured') return 503;
  if (error && error.name === 'FlipError') return 502;
  if (/формате|позже|Максимальный|уже выполняется/.test(message)) return 400;
  return 500;
}

async function handler(req, res) {
  const q = req.query || {};
  const op = String(q.op || 'health');
  try {
    if (op === 'health') {
      return send(res, 200, {
        ok: true,
        flip: client.configured() ? 'FLIP_API_KEY задан' : 'нет FLIP_API_KEY',
        telegram: telegram.configured() ? 'настроен' : 'нет TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID',
        cron: process.env.CRON_SECRET ? 'CRON_SECRET задан' : 'нет CRON_SECRET',
        ...store.status(),
      });
    }
    if (op === 'poll' || op === 'daily') {
      if (!cronAuthorized(req)) return send(res, 401, { ok: false, error: 'Unauthorized' });
      const result = op === 'poll' ? await service.poll() : await service.dailyCron();
      return send(res, 200, result);
    }
    if (op === 'orders') return send(res, 200, { ok: true, ...(await service.orders({ live: q.live === '1' })) });
    if (op === 'badge') return send(res, 200, { ok: true, ...(await service.badge({ since: Number(q.since) || 0 })) });
    if (op === 'sales') {
      return send(res, 200, await service.salesReport({ from: q.from, to: q.to, page: Math.max(1, Number(q.page) || 1), limit: Math.min(500, Math.max(1, Number(q.limit) || 100)) }));
    }
    if (op === 'dynamics') return send(res, 200, await service.dynamics({ from: q.from, to: q.to, granularity: q.granularity }));
    if (op === 'backfill') {
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Используйте POST' });
      const b = body(req);
      return send(res, 200, await service.backfill({ days: b.days || q.days || 90, force: Boolean(b.force) }));
    }
    return send(res, 404, { ok: false, error: 'Неизвестная операция' });
  } catch (error) {
    console.error('Flip API failed', { op, error: error && error.message });
    return send(res, statusFor(error), { ok: false, error: (error && error.message) || 'Ошибка сервера' });
  }
}

function isPublic(req) {
  const op = req.query && req.query.op;
  return !op || op === 'health' || op === 'poll' || op === 'daily'; // cron ops check CRON_SECRET themselves
}

module.exports = { handler, isPublic, __test: { cronAuthorized } };
