'use strict';

const { handler } = require('../lib/grants-data-service');
const analytics = require('../lib/analytics/handler');
const { protect } = require('../lib/access-guard');

// /api/analytics is rewritten here (vercel.json) as module=analytics:
// the Hobby plan allows at most 12 serverless functions per deployment.
function isAnalytics(req) {
  return Boolean(req.query && req.query.module === 'analytics');
}

module.exports = protect((req, res) => (isAnalytics(req) ? analytics.handler(req, res) : handler(req, res)), {
  isPublic: (req) => (isAnalytics(req)
    ? analytics.isPublic(req)
    : !req.query || !req.query.op || req.query.op === 'health'),
});
