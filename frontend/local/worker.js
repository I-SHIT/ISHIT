const fs = require('./fs');
const http = require('./http');
const { Buffer } = require('buffer');
let core;
let engine;
let foreground = false;

function applyForeground(active) {
  if (engine && foreground === active) return;
  foreground = active;
  http.setForeground(active);
  if (!engine) return;
  if (active) engine.restartScheduler();
  else engine.stopScheduler();
}

function localAccount() {
  const auth = core.store.panelAuth;
  auth.enabled = false;
  auth.sessions = {};
  for (const account of core.store.accounts) account.ownerUsername = auth.username;
  core.saveStore();
}

async function importSharedActivity(link) {
  const url = new URL(link);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('请输入 HTTP 或 HTTPS 分享链接');
  let session;
  const portable = url.searchParams.get('localShare');
  if (portable) session = JSON.parse(Buffer.from(portable, 'base64').toString('utf8'));
  else session = await readSharedSession(url);
  if (!session || !['login', 'sign', 'captcha'].includes(session.mode)) throw new Error('分享活动格式无效');
  if (session.expiresAt && session.expiresAt <= Date.now()) throw new Error('分享活动已过期');
  if (session.mode === 'login') return { ok: true, login: true };
  const accounts = core.store.accounts.filter(account => core.getEffectiveUserProfile(account.uid).coursesCache.some(course =>
    String(course.courseId) === String(session.courseId) && String(course.classId) === String(session.classId)));
  const targetAccounts = accounts.filter(account => (session.targetUids || []).map(String).includes(String(account.uid)));
  const targets = targetAccounts.length ? targetAccounts : accounts;
  if (!targets.length) throw new Error('请先在本机绑定参与该课程的学习通账号');
  const local = engine.createHelperSession({ ...session, mode: 'sign', captchaKey: null,
    targetUids: targets.map(a => a.uid), targetNames: targets.map(a => a.name),
    pendingUids: targets.map(a => a.uid), pendingNames: targets.map(a => a.name),
    succeededUids: [], succeededNames: [], creatorUsername: core.store.panelAuth.username });
  return { ok: true, token: local.token };
}

async function readPublicJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { timeout: 15000 }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (_) { reject(new Error('分享服务返回了无法识别的数据')); }
      });
    });
    request.on('error', reject);
    request.end();
  });
}

async function readSharedSession(url) {
  const token = url.searchParams.get('help');
  if (!token) throw new Error('链接缺少协助标识');
  const endpoint = new URL('/api/helper/info', url);
  endpoint.searchParams.set('token', token);
  let raw;
  try { raw = await readPublicJson(endpoint); } catch (_) {}
  if (!raw || raw.ok === undefined) {
    const config = await readPublicJson(new URL('/config.json', url));
    const base = config.apiBaseUrl || config.httpsApiBaseUrl;
    if (!base) throw new Error('分享链接来源服务未提供可用的接口地址');
    const configured = new URL('/api/helper/info', base);
    configured.searchParams.set('token', token);
    raw = await readPublicJson(configured);
  }
  if (!raw.ok || !raw.session) throw new Error(raw.msg || '分享链接读取失败');
  return raw.session;
}

self.onmessage = async event => {
  const msg = event.data;
  try {
    if (msg.type === 'networkResult') { http.complete(msg); return; }
    if (msg.type === 'foreground') { applyForeground(msg.active); return; }
    if (msg.type === 'init') {
      globalThis.ISHIT_LOCAL_CLIENT = true;
      fs.load(msg.files);
      core = require('../../backend/index.js');
      if (!Object.keys(msg.files || {}).length) {
        core.store.panelAuth.username = '本地用户';
        core.store.panelAuth.users = [];
      }
      localAccount();
      engine = require('../../backend/engine.js');
      require('../../backend/server.js');
      applyForeground(msg.active);
      self.postMessage({ type: 'ready' });
      return;
    }
    let result;
    if (msg.type === 'snapshot') result = { format: 'ishit-local', version: 2, files: fs.snapshot() };
    else if (msg.type === 'api') {
      if (msg.url === '/api/local/helper/open') result = { json: await importSharedActivity(msg.body.url) };
      else {
        const response = await http.dispatch(msg.url, msg.method, msg.body, msg.headers);
        if (!foreground) engine.stopScheduler();
        result = response;
      }
    } else return;
    self.postMessage({ type: 'result', id: msg.id, result });
  } catch (err) {
    self.postMessage({ type: msg.type === 'init' ? 'initError' : 'result', id: msg.id, error: err.message });
  }
};
