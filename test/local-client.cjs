const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const webRoot = path.resolve(__dirname, '../frontend/web');
const requests = [];
const signed = new Set();
let active = 'activity-1';
let signType = 0;
function response(request) {
  const url = new URL(request.url);
  requests.push(request);
  let body = {}, headers = {}, status = 200;
  if (url.pathname === '/fanyalogin') {
    assert.equal(request.method, 'POST');
    const data = new URLSearchParams(Buffer.from(request.body, 'base64').toString());
    const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from('u2oh6Vu^HWe4_AES'), Buffer.from('u2oh6Vu^HWe4_AES'));
    assert.equal(Buffer.concat([decipher.update(data.get('password'), 'base64'), decipher.final()]).toString(), 'fixture-password');
    body = { status: true };
    headers['set-cookie'] = ['UID=fixture; Path=/', 'token=local-cookie; Path=/; HttpOnly'];
  } else if (url.pathname === '/apis/login/userLogin4Uname.do') {
    assert.match(request.headers.Cookie, /UID=fixture/);
    body = { result: 1, msg: { puid: 'fixture', name: '本地测试账号', uname: '12345' } };
  } else if (url.pathname === '/mycourse/backclazzdata') {
    assert.match(request.headers.Cookie, /token=local-cookie/);
    body = { result: 1, channelList: [{ content: { id: 'class-1', state: 0, name: '42B', cpi: 'person',
      course: { data: [{ id: 'course-1', name: '课程测试', teacherfactor: '测试教师' }] } } }] };
  } else if (url.pathname === '/pc/curriculum/getMyLessons') {
    body = { result: 1, data: { curriculum: { realCurrentWeek: 1, lessonTimeConfigArray: ['00:00-23:59'] },
      lessonArray: [{ courseId: 'course-1', classId: 'class-1', name: '课程测试', weeks: '1', dayOfWeek: new Date().getDay() || 7 }] } };
  } else if (url.pathname === '/ppt/activeAPI/taskactivelist') {
    body = { result: 1, activeList: [{ id: active, activeType: 2, otherId: signType, status: 1,
      nameOne: '本地签到', url: 'https://mobilelearn.chaoxing.com/widget/sign/preSign?activeId=' + active }] };
  } else if (url.pathname === '/v2/apis/active/getPPTActiveInfo') {
    body = { result: 1, data: { otherId: signType, ifPhoto: 0, openCheckFaceFlag: 0 } };
  } else if (url.pathname === '/v2/apis/sign/getAttendInfo') {
    body = { result: 1, data: { status: signed.has(url.searchParams.get('activeId')) ? 1 : 0 } };
  } else if (url.pathname === '/gas/clazz') body = { data: [{ studentcount: 20 }] };
  else if (url.pathname === '/pptSign/stuSignajax') {
    const data = request.method === 'GET' ? url.searchParams : new URLSearchParams(Buffer.from(request.body, 'base64').toString());
    const decipher = crypto.createDecipheriv('aes-128-ecb', Buffer.from('QrCbNY@MuK1X8HGw'), null);
    const device = Buffer.concat([decipher.update(data.get('deviceCode'), 'base64'), decipher.final()]).toString();
    assert.match(device, /^[a-f0-9-]{36}$/);
    assert.match(request.headers.Cookie, /token=local-cookie/);
    assert.equal(request.headers.Referer, 'https://mobilelearn.chaoxing.com/widget/sign/preSign?activeId=' + data.get('activeId'));
    signed.add(data.get('activeId'));
    body = 'success';
  } else if (url.hostname === 'static-share.example' && url.pathname === '/api/helper/info') {
    body = '<html>static site</html>';
  } else if (url.hostname === 'static-share.example' && url.pathname === '/config.json') {
    body = { apiBaseUrl: 'https://fixture-share.example' };
  } else if (url.pathname === '/api/helper/info') {
    assert.ok(!request.headers.Cookie);
    body = { ok: true, session: { mode: 'sign', courseId: 'course-1', classId: 'class-1', cpi: 'person',
      activeId: active, courseName: '课程测试', signType: 'code', targetUids: ['someone-else'], title: '分享测试' } };
  }
  return { id: request.id, status, headers, body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)).toString('base64') };
}

async function run() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/config.json') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ apiBaseUrl: origin })); return; }
      if (url.pathname === '/api/auth/check') { res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,authRequired:true,authenticated:false}));return; }
      const file = path.join(webRoot, url.pathname === '/' ? 'index.html' : url.pathname);
      const types = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png' };
      res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
      res.end(await fs.readFile(file));
    } catch (_) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let browser;
  const errors = [];
  try {
    browser = await chromium.launch({ executablePath: process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const context = await browser.newContext();
    await context.exposeFunction('fixtureNativeRequest', raw => response(JSON.parse(raw)));
    await context.addInitScript(() => {
      window.IshitAndroidBridge = {
        localRequest(raw) { window.fixtureNativeRequest(raw).then(window.onLocalHttpResult); },
        cancelLocalRequest() {}, setOfflineMode() {}
      };
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.goto(origin);
    await page.evaluate(() => localStorage.setItem('ishit_panel_token', 'keep-online-token'));
    await page.locator('#panelLoginApp [data-mode-button]').click();
    await page.waitForFunction(() => typeof state !== 'undefined' && state.status?.panelAuth?.role === 'admin');
    assert.equal(await page.locator('#offline-workspace').count(), 0);
    const api = (url, body = null) => page.evaluate(([url, body]) => api(url, body ? 'POST' : 'GET', body), [url, body]);
    let result = await api('/api/accounts/login', { username: 'fixture-user', password: 'fixture-password' });
    assert.equal(result.ok, true, JSON.stringify(result));
    result = await api('/api/status');
    assert.equal(result.accounts[0].name, '本地测试账号');
    assert.equal(result.courses.length, 1);
    assert.equal(result.effectiveProfile.effectiveCurriculum.lessons.length, 1);
    await api('/api/schedule', { masterEnabled: true, intervalSeconds: 3 });
    for (let i = 0; i < 50 && !signed.has(active); i++) await page.waitForTimeout(100);
    if (!signed.has(active)) console.log(JSON.stringify((await api('/api/status')).history,null,2));
    assert.ok(signed.has(active), 'scheduled automatic sign');
    result = await api('/api/status');
    assert.ok(result.history.some(row => row.results.some(r => r.ok)));
    await api('/api/courses/settings', { uid: 'fixture', courseId: 'course-1', location: { address: '本地预设', latitude: 30, longitude: 120 }, imageObjectIds: ['photo-1'] });
    const uploaded = await api('/api/helper/uploadImage', { base64Image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=' });
    assert.equal(uploaded.ok, true);
    await api('/api/napcat', { enabled: false, httpUrl: 'http://127.0.0.1:3000', accessToken: 'fixture-secret' });
    await page.evaluate(() => onLocalForeground(false));
    const requestCount = requests.length;
    active = 'activity-2';
    await page.waitForTimeout(3600);
    assert.equal(requests.length, requestCount, 'background must send no requests');
    await page.evaluate(() => onLocalForeground(true));
    for (let i = 0; i < 50 && !signed.has(active); i++) await page.waitForTimeout(100);
    assert.ok(signed.has(active), 'resume must restart scheduled polling');
    await api('/api/schedule', { masterEnabled: false });
    active = 'activity-shared';
    signType = 5;
    result = await api('/api/local/helper/open', { url: 'https://static-share.example/?help=public-token' });
    assert.equal(result.ok, true);
    const assisted = await api('/api/helper/submit', { token: result.token, signCode: '1234' });
    assert.ok(assisted.record.results.some(r => r.ok), JSON.stringify(assisted));
    const portable = await api('/api/helper/create', { mode: 'sign', courseId: 'course-1', classId: 'class-1',
      activeId: 'activity-portable', courseName: '课程测试', targetUids: ['fixture'] });
    assert.ok(portable.shareUrl.includes('localShare='));
    assert.equal((await api('/api/local/helper/open', { url: portable.shareUrl })).ok, true);
    await page.evaluate(() => { switchMainModule('settings'); switchSettingsSubTab('security'); });
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出全部配置', exact: true }).click();
    const backup = await fs.readFile(await (await downloaded).path());
    const snapshot = JSON.parse(backup);
    assert.ok(Object.keys(snapshot.files).some(key => key.startsWith('/data/comment_images/')));
    const savedStore = JSON.parse(Buffer.from(snapshot.files['/data/store.json'], 'base64'));
    assert.equal(savedStore.cookies.fixture.token, 'local-cookie');
    assert.equal(savedStore.napcat.accessToken, 'fixture-secret');
    assert.equal(savedStore.userProfiles.fixture.courseSettings['course-1'].location.address, '本地预设');
    assert.ok(!backup.includes('keep-online-token'));
    await page.locator('#offlineImportFile').setInputFiles({ name: 'bad.json', mimeType:'application/json', buffer: Buffer.from('{"format":"invalid"}') });
    await page.waitForTimeout(100);
    assert.equal((await api('/api/status')).accounts.length, 1);
    const secondContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await secondContext.exposeFunction('fixtureNativeRequest', raw => response(JSON.parse(raw)));
    await secondContext.addInitScript(() => {
      window.ISHIT_PLATFORM = 'android';
      window.IshitAndroidBridge = {
        localRequest(raw) { window.fixtureNativeRequest(raw).then(window.onLocalHttpResult); },
        cancelLocalRequest() {}, setOfflineMode() {}
      };
    });
    const second = await secondContext.newPage();
    second.on('pageerror', error => errors.push(error.message));
    second.on('dialog', dialog => dialog.accept());
    await second.addInitScript(() => localStorage.setItem('ishit_mode', 'offline'));
    await second.goto(origin);
    await second.waitForFunction(() => typeof state !== 'undefined' && state.status?.panelAuth?.role === 'admin');
    await second.locator('#offlineImportFile').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: backup });
    await second.waitForFunction(() => typeof state !== 'undefined' && state.status?.accounts?.length === 1);
    const restored = await second.evaluate(() => localRpc('snapshot'));
    const restoredStore = JSON.parse(Buffer.from(restored.files['/data/store.json'], 'base64'));
    assert.deepEqual(Object.keys(restored.files).sort(), Object.keys(snapshot.files).sort());
    assert.equal(restoredStore.cookies.fixture.token, 'local-cookie');
    assert.deepEqual(restoredStore.userProfiles, savedStore.userProfiles);
    assert.equal(restoredStore.napcat.accessToken, 'fixture-secret');
    assert.equal(await second.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const refreshed = await second.evaluate(() => api('/api/courses?refresh=1&uid=fixture'));
    assert.equal(refreshed.courses.length, 1);
    const legacyContext = await browser.newContext();
    const legacy = await legacyContext.newPage();
    await legacy.addInitScript(() => {
      localStorage.setItem('ishit_mode', 'offline');
      localStorage.setItem('ishit_offline_workspace_v1', JSON.stringify({ format: 'ishit-offline', version: 1,
        name: '旧用户', enabled: false, interval: 25, buffer: 10, courses: [{ id: 'a', name: '旧课程', classroom: '42B', enabled: true }],
        lessons: [{ course: 'a', day: 1, weeks: [], start: '08:00', end: '09:00', enabled: true }] }));
    });
    await legacy.goto(origin);
    await legacy.waitForFunction(() => typeof state !== 'undefined' && state.status?.accounts?.length === 1);
    assert.equal(await legacy.evaluate(() => state.status.courses[0].name), '旧课程');
    await legacy.reload();
    await legacy.waitForFunction(() => typeof state !== 'undefined' && state.status?.courses?.[0]?.name === '旧课程');
    await page.locator('#settings-pane-security [data-mode-button]').click();
    await page.locator('#panelLoginApp').waitFor({state:'visible'});
    assert.equal(await page.evaluate(() => localStorage.getItem('ishit_panel_token')), 'keep-online-token');
    assert.deepEqual(errors, []);
    console.log('PASS full offline UI, login crypto/cookies, course+curriculum sync, automatic sign, native foreground gate, share import+sign, all-settings migration, invalid import, online credentials');
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}
module.exports = { response, requests, signed, setActivity(id, type = 0) { active = id; signType = type; } };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
