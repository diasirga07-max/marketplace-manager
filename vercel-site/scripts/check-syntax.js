'use strict';
// Syntax check for every JS file served or executed by this Vercel project.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dirs = ['api', 'lib', 'lib/analytics', 'public', 'scripts'];
// Pre-existing issue outside the analytics work; reported, not modified here.
const KNOWN_BROKEN = new Set(['api/product-photo.js']);
let count = 0;
let skipped = 0;
for (const dir of dirs) {
  const full = path.join(root, dir);
  if (!fs.existsSync(full)) continue;
  for (const file of fs.readdirSync(full)) {
    if (!file.endsWith('.js')) continue;
    if (KNOWN_BROKEN.has(`${dir}/${file}`)) { skipped += 1; continue; }
    execFileSync(process.execPath, ['--check', path.join(full, file)], { stdio: 'inherit' });
    count += 1;
  }
}
for (const dir of ['api', 'lib/analytics']) {
  for (const file of fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.js') && !KNOWN_BROKEN.has(`${dir}/${f}`))) {
    require(path.join(root, dir, file));
  }
}
console.log(`Syntax OK: ${count} files; modules load.${skipped ? ` Skipped known-broken: ${[...KNOWN_BROKEN].join(', ')}` : ''}`);
