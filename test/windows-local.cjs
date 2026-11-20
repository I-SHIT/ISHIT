const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fixture = require('./local-client.cjs');

async function run() {
  const errors = [];
  const server = http.createServer(async (req, res) => {
    try {
      if (!req.headers['x-fixture-url']) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, authRequired: true, authenticated: false })); return; }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const result = fixture.response({ id: 'native', url: req.headers['x-fixture-url'], method: req.method,
        headers: { Cookie: req.headers.cookie, Referer: req.headers.referer }, body: Buffer.concat(chunks).toString('base64') });
      for (const [key, value] of Object.entries(result.headers)) res.setHeader(key, value);
      res.writeHead(result.status); res.end(Buffer.from(result.body, 'base64'));
    } catch (err) { errors.push(err.message); res.writeHead(500); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = 'http://127.0.0.1:' + server.address().port;
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ishit-native-'));
  const clientDir = path.join(temp, 'client');
  await fs.cp(path.resolve(__dirname, '../frontend/windows/publish'), clientDir, { recursive: true });
  await fs.writeFile(path.join(clientDir, 'config.json'), JSON.stringify({ apiBaseUrl: endpoint, directIpUrl: endpoint }));
  const client = spawn(path.join(clientDir, 'ISHIT.exe'), [], { windowsHide: true, stdio: 'ignore',
    env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: path.join(temp, 'profile'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=18973 --remote-debugging-address=127.0.0.1' } });
  let browser;
  try {
    for (let attempt = 0; attempt < 80; attempt++) {
      try { browser = await chromium.connectOverCDP('http://127.0.0.1:18973', { timeout: 1000 }); break; }
      catch (_) { await new Promise(resolve => setTimeout(resolve, 150)); }
    }
    assert.ok(browser, 'WebView2 must start');
    const page = browser.contexts()[0].pages()[0];
    page.on('pageerror', err => errors.push(err.message));
    await page.waitForFunction(() => typeof enterOfflineMode === 'function');
    await page.evaluate(() => localStorage.setItem('ishit_mode', 'offline'));
    await page.reload();
    await page.waitForFunction(() => typeof state !== 'undefined' && state.status?.panelAuth?.role === 'admin');
    await page.evaluate(endpoint => {
      const original = chrome.webview.postMessage.bind(chrome.webview);
      chrome.webview.postMessage = msg => {
        if (typeof msg === 'string' && msg.startsWith('local:http:')) {
          const payload = JSON.parse(msg.slice(11));
          payload.headers['X-Fixture-Url'] = payload.url;
          payload.url = endpoint;
          return original('local:http:' + JSON.stringify(payload));
        }
        return original(msg);
      };
      onLocalForeground(true);
    }, endpoint);
    const login = await page.evaluate(() => api('/api/accounts/login', 'POST', { username: 'fixture-user', password: 'fixture-password' }));
    assert.equal(login.ok, true, JSON.stringify(login));
    await page.evaluate(() => api('/api/schedule', 'POST', { masterEnabled: true, intervalSeconds: 3 }));
    for (let i = 0; i < 60 && !fixture.signed.has('activity-1'); i++) await page.waitForTimeout(100);
    assert.ok(fixture.signed.has('activity-1'), 'automatic signing through native HttpClient');
    await page.evaluate(() => refreshStatus(true));
    await page.evaluate(() => { switchMainModule('user'); switchUserSubTab('schedule'); });
    await page.screenshot({ path: path.join(temp, 'windows.png') });
    await page.evaluate(() => onLocalForeground(false));
    const count = fixture.requests.length;
    await page.waitForTimeout(3300);
    assert.equal(fixture.requests.length, count);
    assert.deepEqual(errors, []);
    console.log('PASS actual ISHIT.exe / WebView2 / native HttpClient / login cookies / automatic signing / foreground pause');
    console.log('Screenshot ' + path.join(temp, 'windows.png'));
  } finally {
    await browser?.close();
    client.kill();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
run().catch(err => { console.error(err); process.exitCode = 1; });
