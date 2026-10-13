"use strict";
// Commit the generated index with every client release. No runtime cache or
// storage is cleared: only changed files receive new request URLs.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const file = path.join(root, 'index.html');
const original = fs.readFileSync(file, 'utf8');
let count = 0;
const versioned = original.replace(/\b(src|href)="((?:js|css)\/[^"?]+\.(?:js|css))(?:\?[^" ]*)?"/g, (_, attr, asset) => {
  const hash = createHash('sha256').update(fs.readFileSync(path.join(root, asset))).digest('hex').slice(0, 16);
  count++;
  return `${attr}="${asset}?v=${hash}"`;
});
if (!count) throw new Error('No client assets found in index.html');
if (process.argv.includes('--check')) {
  if (versioned !== original) {
    console.error('Asset versions are stale. Run npm run version:assets and commit index.html.');
    process.exitCode = 1;
  } else console.log(`${count} client asset versions match their contents.`);
} else {
  if (versioned !== original) fs.writeFileSync(file, versioned);
  console.log(`Versioned ${count} client assets.`);
}
