'use strict';

const { handler } = require('../lib/grants-data-service');
const { protect } = require('../lib/access-guard');

module.exports = protect(handler, {
  isPublic: req => !req.query || !req.query.op || req.query.op === 'health',
});
