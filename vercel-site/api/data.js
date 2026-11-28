'use strict';

const { handler } = require('../lib/grants-data-service');
const analytics = require('../lib/analytics/handler');
const quality = require('../lib/quality/handler');
const consumables = require('../lib/consumables/handler');
const flip = require('../lib/flip/handler');
const { protect } = require('../lib/access-guard');

// /api/analytics is rewritten here (vercel.json) as module=analytics:
// the Hobby plan allows at most 12 serverless functions per deployment.
function isAnalytics(req) {
  return Boolean(req.query && req.query.module === 'analytics');
}

// /api/quality is rewritten here as module=quality («Показатели качества»).
function isQuality(req) {
  return Boolean(req.query && req.query.module === 'quality');
}

// module=consumables — раздел «Расходники».
function isConsumables(req) {
  return Boolean(req.query && req.query.module === 'consumables');
}

// module=flip — раздел «Flip» (/api/flip and /api/flip/poll-orders are rewritten here).
function isFlip(req) {
  return Boolean(req.query && req.query.module === 'flip');
}

module.exports = protect((req, res) => {
  if (isFlip(req)) return flip.handler(req, res);
  if (isQuality(req)) return quality.handler(req, res);
  if (isConsumables(req)) return consumables.handler(req, res);
  return isAnalytics(req) ? analytics.handler(req, res) : handler(req, res);
}, {
  isPublic: (req) => {
    if (isQuality(req)) return quality.isPublic(req);
    if (isConsumables(req)) return consumables.isPublic(req);
    if (isFlip(req)) return flip.isPublic(req);
    return isAnalytics(req)
      ? analytics.isPublic(req)
      : !req.query || !req.query.op || req.query.op === 'health';
  },
});
