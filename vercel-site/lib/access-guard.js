'use strict';

const crypto = require('node:crypto');

let hasWarnedAboutDisabledGuard = false;

function protect(handler, { isPublic } = {}) {
  return function guardedHandler(req, res) {
    const expected = String(process.env.GB_ACCESS_CODE || '').trim();
    if (!expected) {
      if (!hasWarnedAboutDisabledGuard) {
        hasWarnedAboutDisabledGuard = true;
        console.warn('GB_ACCESS_CODE is not configured; API access guard is disabled');
      }
      return handler(req, res);
    }

    if (req.method === 'OPTIONS' || (typeof isPublic === 'function' && isPublic(req))) {
      return handler(req, res);
    }

    const headers = req.headers || {};
    const headerValue = headers['x-gb-access'] ?? headers['X-GB-Access'];
    const supplied = headerValue == null ? req.query?.access : headerValue;
    const code = Array.isArray(supplied) ? supplied[0] : supplied;
    const givenHash = crypto.createHash('sha256').update(String(code ?? '')).digest();
    const expectedHash = crypto.createHash('sha256').update(String(expected)).digest();

    if (crypto.timingSafeEqual(givenHash, expectedHash)) {
      return handler(req, res);
    }

    res.statusCode = 401;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(JSON.stringify({
      ok: false,
      code: 'access_required',
      error: 'Требуется код доступа',
    }));
  };
}

module.exports = { protect };
