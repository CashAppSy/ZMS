"use strict";
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const currentURL = html.match(/src="(js\/core\/namespace\.js\?v=[a-f0-9]+)"/)[1];
const previousURL = 'js/core/namespace.js?v=previous-release';
let published = false, oldRequests = 0, newRequests = 0;
// Isolated fixture: genuine browser HTTP caching, no request interception and
// no Firebase configuration, authentication or production traffic.
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, {'Content-Type':'text/html', 'Cache-Control':'no-cache'});
    return res.end(`<script src="/${published ? currentURL : previousURL}"></script>`);
  }
  if (req.url === '/' + previousURL || req.url === '/' + currentURL) {
    res.writeHead(200, {'Content-Type':'text/javascript', 'Cache-Control':'public, max-age=31536000, immutable'});
    if (req.url === '/' + previousURL) {
      oldRequests++;
      return res.end('window.oldRelease = true;');
    }
    newRequests++;
    return res.end(fs.readFileSync(path.join(root, 'js/core/namespace.js')));
  }
  res.writeHead(404);res.end();
});
(async () => {
  let browser;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless:true, args:['--no-sandbox']});
    const context = await browser.newContext();
    let page = await context.newPage();
    const base = 'http://127.0.0.1:' + server.address().port;
    await page.goto(base);
    assert.equal(await page.evaluate(() => window.oldRelease), true);
    await page.evaluate(() => localStorage.setItem('existing-user-data', 'preserved'));
    await page.close();
    published = true;
    page = await context.newPage();
    // Normal next opening, in the same browser profile with the old JS cached.
    await page.goto(base);
    assert.equal(await page.evaluate(() => typeof window.PMS), 'object');
    assert.equal(await page.evaluate(() => window.oldRelease), undefined);
    assert.equal(await page.evaluate(() => localStorage.getItem('existing-user-data')), 'preserved');
    await page.goto(base);
    assert.equal(oldRequests, 1);
    assert.equal(newRequests, 1, 'unchanged version remains cacheable');
    console.log('PASS: normal reopening loads new version, preserves user data and reuses unchanged assets.');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {console.error(error);process.exitCode = 1;});
