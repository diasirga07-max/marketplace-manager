'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = name => fs.readFileSync(path.join(__dirname, name), 'utf8');
const source = read('../api/product-photo.js');
const extractImage = vm.runInNewContext(
  source.slice(0, source.indexOf('module.exports = async function')) + '\nextractImage;',
  { URL },
);
const url = 'https://resources.cdn-kaspi.kz/img/m/p/a.jpg';

test('product-photo extracts an escaped Kaspi JSON image URL', () => {
  assert.equal(extractImage(JSON.stringify({ image: url }).replaceAll('/', '\\/')), url);
});

test('product-photo extracts og:image URL', () => {
  assert.equal(extractImage('<meta property="og:image" content="' + url + '">'), url);
});

test('product-photo extracts HTML img src URL', () => {
  assert.equal(extractImage('<img alt="book" src="' + url + '">'), url);
});

test('orders photo resolver is served locally and calls guarded window.fetch for /api/product-photo', () => {
  const index = read('../index.html');
  const script = read('../public/gb-orders-photo-enrich.js');
  assert.match(index, /loadScript\('\/gb-orders-photo-enrich\.js\?v=20261025-1'/);
  assert.match(script, /await window\.fetch\('\/api\/product-photo\?/);
  assert.doesNotMatch(script, /await originalFetch\('\/api\/product-photo\?/);
});
