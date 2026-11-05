const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const {
  EncryptionUtil,
  COMMENT_IMAGES_DIR,
  store,
  saveStore,
  ensureUserProfile,
  getEffectiveUserProfile,
  getEffectiveScheduleForPanelUser,
  getEffectiveScheduleForCxUid,
  logsBuffer,
  sysLog,
} = require('./index.js');
const { CXProtocol } = require('./protocol.js');
const {
  decodeQrFromImageBuffer,
  broadcastNapCat,
  getPublicBaseUrlClean,
  createHelperSession,
  getHelperSession,
  creditHelperPointsToStudent,
  claimHelperPointsByToken,
  getFormattedLeaderboard,
  getFormattedBountyHistory,
  syncActiveBountiesNow,
  getActiveBountiesForUser,
  executeSignForActive,
  findMatchingAccountsForClass,
  processIncomingChatImageItem,
  pollCoursesOnce,
  getEffectiveTimerIntervalSeconds,
  restartScheduler,
  getEngineState,
} = require('./engine.js');

function readBodyJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const str = Buffer.concat(chunks).toString('utf8');
      if (!str) return resolve({});
      try { resolve(JSON.parse(str)); } catch (_) { resolve({}); }
    });
  });
}

function sendJson(res, data, status = 200, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(data), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Panel-Token, X-Helper-Token, Authorization',
    'Access-Control-Expose-Headers': 'X-Panel-Token',
    'Access-Control-Allow-Private-Network': 'true',
    ...extraHeaders,
  });
  res.end(payload);
}

function parseReqCookies(req) {
  const header = req.headers.cookie || '';
  const map = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      map[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return map;
}

function ensurePanelAuthStore() {
  if (!store.panelAuth) {
    store.panelAuth = {
      enabled: true,
      username: 'ishit',
      passwordHash: EncryptionUtil.md5Hash('ishit2026'),
      users: [],
      sessions: {},
    };
  }
  if (!store.panelAuth.sessions) store.panelAuth.sessions = {};
  if (!Array.isArray(store.panelAuth.users)) store.panelAuth.users = [];

  // 确保主管理员账号存在于 users 表中，且 ishit 固定为 admin 角色
  const primaryUsername = store.panelAuth.username || 'ishit';
  const primaryHash = store.panelAuth.passwordHash || EncryptionUtil.md5Hash('ishit2026');
  let adminEntry = store.panelAuth.users.find((u) => u && u.username === primaryUsername);
  if (!adminEntry) {
    adminEntry = store.panelAuth.users.find((u) => u && u.role === 'admin');
  }
  if (!adminEntry) {
    adminEntry = {
      id: 'u_admin',
      username: primaryUsername,
      passwordHash: primaryHash,
      role: 'admin',
      createdAt: Date.now(),
    };
    store.panelAuth.users.unshift(adminEntry);
  } else {
    adminEntry.role = 'admin';
  }
  for (const u of store.panelAuth.users) {
    if (u && u.username === 'ishit') u.role = 'admin';
  }

  // 为存量学习通账号与位置预设补齐默认归属人 / 创建者
  const defaultOwner = adminEntry.username || 'ishit';
  for (const acc of store.accounts || []) {
    if (acc && !acc.ownerUsername) acc.ownerUsername = defaultOwner;
  }
  for (const preset of store.locationPresets || []) {
    if (preset && !preset.createdBy) preset.createdBy = defaultOwner;
  }
  return store.panelAuth;
}

function getValidPanelSession(req, parsedUrl = null) {
  const pa = ensurePanelAuthStore();
  if (pa.enabled === false) return { username: pa.username || 'ishit', role: 'admin', bypass: true };
  const cookies = parseReqCookies(req);
  const queryToken = parsedUrl && parsedUrl.searchParams ? (parsedUrl.searchParams.get('token') || '') : '';
  const token = req.headers['x-panel-token'] || queryToken || cookies.ishit_panel_session || '';
  if (!token) return null;
  const sess = pa.sessions[token];
  if (!sess) return null;
  if (sess.expiresAt && sess.expiresAt < Date.now()) {
    delete pa.sessions[token];
    saveStore();
    return null;
  }
  const userObj = pa.users.find((u) => u && u.username === sess.username);
  if (!userObj) {
    delete pa.sessions[token];
    saveStore();
    return null;
  }
  const role = userObj.username === 'ishit' || userObj.role === 'admin' ? 'admin' : 'user';
  return { token, ...sess, username: userObj.username, role };
}

function resolveAccountActor(req, parsedUrl) {
  const sess = getValidPanelSession(req);
  if (sess) return { username: sess.username, role: sess.role };
  const hToken = req.headers['x-helper-token'] || parsedUrl.searchParams.get('helperToken') || '';
  const hs = hToken ? getHelperSession(hToken) : null;
  if (hs && hs.creatorUsername) {
    const pa = ensurePanelAuthStore();
    const u = pa.users.find((x) => x && x.username === hs.creatorUsername);
    return {
      username: hs.creatorUsername,
      role: u ? (u.role === 'admin' || u.username === 'ishit' ? 'admin' : 'user') : (hs.creatorRole || 'user'),
    };
  }
  const pa = ensurePanelAuthStore();
  return { username: pa.username || 'ishit', role: 'admin' };
}

function canActorBindCxAccount(actor, incomingUid) {
  if (!actor || actor.role === 'admin') return { allowed: true };
  const owned = (store.accounts || []).filter((a) => a && a.ownerUsername === actor.username);
  if (owned.length === 0) return { allowed: true };
  if (owned.some((a) => String(a.uid) === String(incomingUid))) return { allowed: true };
  return {
    allowed: false,
    msg: `普通用户 (${actor.username}) 仅限绑定 1 个学习通账号（当前已绑定：${owned[0].name || owned[0].uid}），如需更换请先移除原账号`,
  };
}

function canSessionEditCxAccount(sess, targetUid) {
  if (!sess) return false;
  if (sess.role === 'admin') return true;
  const acc = (store.accounts || []).find((a) => a && String(a.uid) === String(targetUid));
  if (!acc) return false;
  return acc.ownerUsername === sess.username;
}

function isAuthorizedNapcatWebhook(req) {
  const cfg = store.napcat || {};
  if (cfg.accessToken) {
    const authHeader = String(req.headers['authorization'] || '');
    if (authHeader === `Bearer ${cfg.accessToken}` || req.headers['x-napcat-token'] === cfg.accessToken) {
      return true;
    }
  }
  if (req.headers['cf-connecting-ip'] || req.headers['cf-ray']) return false;
  const remote = String(req.socket?.remoteAddress || '');
  return (
    remote === '127.0.0.1' ||
    remote === '::1' ||
    remote === '::ffff:127.0.0.1' ||
    /^(::ffff:)?172\.(1[6-9]|2\d|3[0-1])\./.test(remote)
  );
}

function maskPhone(phone) {
  const s = String(phone || '').trim();
  if (s.length >= 7) return s.slice(0, 3) + '****' + s.slice(-4);
  return s;
}

function sanitizeAccountForClient(acc, isAdmin = false, currentUsername = '') {
  if (!acc || typeof acc !== 'object') return acc;
  const isOwner = Boolean(currentUsername && acc.ownerUsername === currentUsername);
  const canSeeFullPhone = isAdmin || isOwner;
  return {
    uid: acc.uid,
    name: acc.name,
    avatar: acc.avatar,
    phone: canSeeFullPhone ? acc.phone : maskPhone(acc.phone),
    school: acc.school,
    studentId: acc.studentId || '',
    platform: acc.platform,
    status: acc.status,
    ownerUsername: acc.ownerUsername,
    cachedFaceObjectId: acc.cachedFaceObjectId || undefined,
  };
}

function sanitizeAccountsListForClient(accounts, currentSess) {
  const pa = ensurePanelAuthStore();
  const isAdmin = !currentSess || currentSess.role === 'admin';
  const currentUsername = currentSess ? currentSess.username : (pa.username || 'ishit');
  return (accounts || []).map((a) => sanitizeAccountForClient(a, isAdmin, currentUsername));
}

function isHelperAuthorizedRoute(req, pathname, parsedUrl) {
  if (pathname === '/api/napcat/webhook_image') return isAuthorizedNapcatWebhook(req);
  if (pathname === '/api/helper/info' || pathname === '/api/helper/submit' || pathname === '/api/helper/claim' || pathname === '/api/helper/uploadImage' || pathname === '/api/helper/leaderboard') return true;
  const hToken = req.headers['x-helper-token'] || parsedUrl.searchParams.get('helperToken') || '';
  if (!hToken) return false;
  const hs = getHelperSession(hToken);
  if (!hs) return false;
  if (pathname === '/api/qr/decode' || pathname === '/api/geo/reverse' || pathname === '/api/geo/search' || pathname === '/api/courses/activeInfo') return true;
  if (hs.mode === 'captcha' && (pathname === '/api/captcha/get' || pathname === '/api/captcha/verify')) return true;
  if (
    hs.mode === 'login' &&
    (pathname === '/api/accounts/login' ||
      pathname === '/api/accounts/sms/send' ||
      pathname === '/api/accounts/sms/login' ||
      pathname === '/api/accounts/qr/create' ||
      pathname === '/api/accounts/qr/poll')
  ) {
    return true;
  }
  return false;
}

function addOrUpdateAccount(user, ownerUsername = null) {
  if (!user || !user.uid) return;
  const pa = ensurePanelAuthStore();
  const idx = (store.accounts || []).findIndex((a) => a.uid === user.uid);
  if (idx >= 0) {
    const prevOwner = store.accounts[idx].ownerUsername;
    const prevFaceId = store.accounts[idx].cachedFaceObjectId;
    store.accounts[idx] = {
      ...store.accounts[idx],
      ...user,
      cachedFaceObjectId: user.cachedFaceObjectId || prevFaceId || undefined,
      ownerUsername: prevOwner || ownerUsername || pa.username || 'ishit',
    };
  } else {
    store.accounts.push({
      ...user,
      ownerUsername: ownerUsername || pa.username || 'ishit',
    });
  }
  if (!store.currentUid) store.currentUid = user.uid;
  ensureUserProfile(user.uid);
  saveStore();
  // 异步尝试拉取一次官方人脸底图 objectid 并缓存（在非机房拦截环境下自动持久化）
  CXProtocol.getFaceParams(user, '0', false).catch(() => {});
}

function mergeCoursesForUser(uid) {
  const eff = getEffectiveUserProfile(uid);
  const raw = ensureUserProfile(uid);
  const courses = raw.coursesCache?.length ? raw.coursesCache : (eff.coursesCache || []);
  return courses.map((c) => {
    const st = eff.courseSettings?.[c.courseId] || {
      pollingEnabled: true,
      isTestCourse: false,
      testPollingEnabled: true,
      location: null,
      imageObjectIds: [],
    };
    return {
      ...c,
      settings: {
        pollingEnabled: st.pollingEnabled !== undefined ? st.pollingEnabled : true,
        isTestCourse: Boolean(st.isTestCourse),
        testPollingEnabled: st.testPollingEnabled !== undefined ? Boolean(st.testPollingEnabled) : true,
        location: st.location || null,
        randomOffsetEnabled:
          st.randomOffsetEnabled !== undefined
            ? Boolean(st.randomOffsetEnabled)
            : eff.locationRandomOffsetEnabled !== false,
        randomOffsetMeters:
          st.randomOffsetMeters !== undefined && Number.isFinite(Number(st.randomOffsetMeters))
            ? Math.max(0, Math.min(500, Number(st.randomOffsetMeters)))
            : Number.isFinite(Number(eff.locationRandomOffsetMeters))
            ? Math.max(0, Math.min(500, Number(eff.locationRandomOffsetMeters)))
            : 15,
        imageObjectIds: st.imageObjectIds || [],
      },
    };
  });
}

function fetchJsonUrl(urlStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      u,
      {
        method: 'GET',
        headers: {
          'User-Agent': 'ISHIT-Control-Panel/2.0',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
        timeout: 8000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (_) {
            resolve(null);
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Geo timeout')));
    req.end();
  });
}

const PORT = Number(process.env.PORT || 8080);

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Panel-Token, X-Helper-Token, Authorization',
      'Access-Control-Max-Age': '86400',
      'Access-Control-Allow-Private-Network': 'true',
    });
    return res.end();
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = parsedUrl.pathname;

  try {
    // 公开托管协助留言图片 (/uploads/comments/<filename>)，兼容纯 API 模式与静态托管模式
    if ((pathname.startsWith('/uploads/comments/') || pathname.startsWith('/api/comment_images/')) && req.method === 'GET') {
      const fileName = path.basename(pathname);
      if (!/^[a-zA-Z0-9_-]+\.(jpg|jpeg|png|webp|gif)$/i.test(fileName)) {
        res.writeHead(404);
        return res.end('Not Found');
      }
      const filePath = path.join(COMMENT_IMAGES_DIR, fileName);
      if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        return res.end('Not Found');
      }
      const ext = path.extname(fileName).toLowerCase();
      const mimeMap = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
      };
      const buf = fs.readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': mimeMap[ext] || 'image/jpeg',
        'Content-Length': buf.length,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=604800',
      });
      return res.end(buf);
    }

    // 静态资源（支持纯 API 无前端部署模式：若存在本地 frontend/web 则响应静态页，否则根路径返回纯 API 状态）
    const candidateWebA = path.join(__dirname, '..', 'frontend', 'web');
    const candidateWebB = path.join(__dirname, '..', 'web');
    const webRoot = fs.existsSync(path.join(candidateWebA, 'index.html'))
      ? candidateWebA
      : (fs.existsSync(path.join(candidateWebB, 'index.html')) ? candidateWebB : null);

    if (webRoot) {
      if (pathname === '/config.json') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(path.join(webRoot, 'config.json'), 'utf8'));
      }
      if (pathname === '/style.css') {
        res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(path.join(webRoot, 'style.css'), 'utf8'));
      }
      if (pathname === '/app.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(path.join(webRoot, 'app.js'), 'utf8'));
      }
      if (pathname === '/favicon.png' || pathname === '/favicon.ico') {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
        return res.end(fs.readFileSync(path.join(webRoot, 'favicon.png')));
      }
      if (pathname === '/brand-logo.png') {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
        return res.end(fs.readFileSync(path.join(webRoot, 'brand-logo.png')));
      }
      if (pathname === '/jsqr.js') {
        const jsqrPath = path.join(webRoot, 'jsqr.js');
        if (fs.existsSync(jsqrPath)) {
          res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
          return res.end(fs.readFileSync(jsqrPath, 'utf8'));
        }
      }
      if (pathname.startsWith('/vendor/leaflet/')) {
        const rel = pathname.replace(/^\/+/, '');
        const safePath = path.resolve(webRoot, rel);
        const expectedPrefix = path.resolve(webRoot, 'vendor', 'leaflet');
        if (safePath.startsWith(expectedPrefix) && fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
          const ext = path.extname(safePath).toLowerCase();
          const mime = ext === '.css' ? 'text/css; charset=utf-8'
            : ext === '.js' ? 'application/javascript; charset=utf-8'
            : ext === '.png' ? 'image/png'
            : 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' });
          return res.end(fs.readFileSync(safePath));
        }
      }
      if (pathname === '/' || pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(path.join(webRoot, 'index.html'), 'utf8'));
      }
    } else if (pathname === '/' || pathname === '/index.html') {
      return sendJson(res, { ok: true, service: 'ISHIT Backend API', version: '0.1', webUrl: 'http://ishit.pw' });
    }

    // 0. 面板访问登录鉴权 (支持 Admin / User 权限分级)
    if (pathname === '/api/auth/check' && req.method === 'GET') {
      const pa = ensurePanelAuthStore();
      const sess = getValidPanelSession(req);
      return sendJson(res, {
        ok: true,
        authRequired: pa.enabled !== false,
        authenticated: Boolean(sess),
        username: sess ? sess.username : '',
        role: sess ? sess.role : '',
      });
    }

    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const body = await readBodyJson(req);
      const pa = ensurePanelAuthStore();
      const inputUser = String(body.username || '').trim();
      const inputPass = String(body.password || '');
      const inputHash = EncryptionUtil.md5Hash(inputPass);

      const matchedUser = pa.users.find(
        (u) => u && u.username === inputUser && u.passwordHash === inputHash
      );
      if (!matchedUser) {
        sysLog('AUTH', `面板登录失败: 用户名 ${inputUser || '(空)'}`);
        return sendJson(res, { ok: false, msg: '账号或密码错误' }, 401);
      }

      const role = matchedUser.username === 'ishit' || matchedUser.role === 'admin' ? 'admin' : 'user';
      // 清理过期会话并签发新会话 (有效期 14 天)
      const now = Date.now();
      for (const [tk, sv] of Object.entries(pa.sessions)) {
        if (!sv || (sv.expiresAt && sv.expiresAt < now)) delete pa.sessions[tk];
      }
      const token = EncryptionUtil.getUniqueId() + EncryptionUtil.getUniqueId().slice(0, 16);
      const ttlMs = 14 * 24 * 60 * 60 * 1000;
      pa.sessions[token] = {
        username: matchedUser.username,
        role,
        ip: req.socket?.remoteAddress || '',
        ua: String(req.headers['user-agent'] || '').slice(0, 120),
        createdAt: now,
        expiresAt: now + ttlMs,
      };
      saveStore();
      sysLog('AUTH', `面板登录成功: ${matchedUser.username} [${role}] (${req.socket?.remoteAddress || 'local'})`, { ownerUsernames: [matchedUser.username] });

      const cookieStr = `ishit_panel_session=${token}; Path=/; Max-Age=${14 * 86400}; HttpOnly; SameSite=Lax`;
      return sendJson(res, { ok: true, token, username: matchedUser.username, role }, 200, { 'Set-Cookie': cookieStr });
    }

    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      const pa = ensurePanelAuthStore();
      const sess = getValidPanelSession(req);
      if (sess && sess.token) {
        delete pa.sessions[sess.token];
        saveStore();
      }
      const clearCookie = 'ishit_panel_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax';
      return sendJson(res, { ok: true }, 200, { 'Set-Cookie': clearCookie });
    }

    // 统一 API 访问拦截：除合法协助链接接口外，所有后台 API 均须携带已登录会话
    const currentSess = getValidPanelSession(req, parsedUrl);
    if (pathname.startsWith('/api/')) {
      if (!currentSess && !isHelperAuthorizedRoute(req, pathname, parsedUrl)) {
        return sendJson(res, { ok: false, needAuth: true, msg: '请先登录 ISHIT' }, 401);
      }
    }

    // 修改当前登录网站用户自己的账号与密码（Admin 与 User 均可操作自己的凭据）
    if (pathname === '/api/auth/update' && req.method === 'POST') {
      const body = await readBodyJson(req);
      const pa = ensurePanelAuthStore();
      if (!currentSess) return sendJson(res, { ok: false, msg: '请先登录' }, 401);

      const userObj = pa.users.find((u) => u && u.username === currentSess.username);
      if (!userObj) return sendJson(res, { ok: false, msg: '当前账号不存在' }, 404);

      const currentPassword = String(body.currentPassword || '');
      const newUsername = String(body.newUsername || '').trim();
      const newPassword = String(body.newPassword || '');

      if (EncryptionUtil.md5Hash(currentPassword) !== userObj.passwordHash) {
        return sendJson(res, { ok: false, msg: '当前旧密码不正确' });
      }
      if (!newUsername) {
        return sendJson(res, { ok: false, msg: '登录账号不能为空' });
      }
      if (newUsername !== userObj.username && pa.users.some((u) => u && u.username === newUsername)) {
        return sendJson(res, { ok: false, msg: '该账号名称已被占用，请更换' });
      }
      if (!newPassword || newPassword.length < 4) {
        return sendJson(res, { ok: false, msg: '新密码长度不能少于 4 位' });
      }

      const oldUsername = userObj.username;
      userObj.username = newUsername;
      userObj.passwordHash = EncryptionUtil.md5Hash(newPassword);
      if (pa.username === oldUsername) {
        pa.username = newUsername;
        pa.passwordHash = userObj.passwordHash;
      }

      // 若改了用户名，同步迁移其归属的学习通账号、位置预设创建者与专属轮询设置
      if (newUsername !== oldUsername) {
        for (const acc of store.accounts || []) {
          if (acc && acc.ownerUsername === oldUsername) acc.ownerUsername = newUsername;
        }
        for (const preset of store.locationPresets || []) {
          if (preset && preset.createdBy === oldUsername) preset.createdBy = newUsername;
        }
        if (store.userScheduleConfigs && store.userScheduleConfigs[oldUsername]) {
          store.userScheduleConfigs[newUsername] = store.userScheduleConfigs[oldUsername];
          delete store.userScheduleConfigs[oldUsername];
        }
      }

      // 清理该用户的所有旧会话，仅保留当前新签发会话
      for (const [tk, sv] of Object.entries(pa.sessions)) {
        if (sv && sv.username === oldUsername) delete pa.sessions[tk];
      }
      const now = Date.now();
      const newToken = EncryptionUtil.getUniqueId() + EncryptionUtil.getUniqueId().slice(0, 16);
      const role = userObj.username === 'ishit' || userObj.role === 'admin' ? 'admin' : 'user';
      pa.sessions[newToken] = {
        username: userObj.username,
        role,
        ip: req.socket?.remoteAddress || '',
        ua: String(req.headers['user-agent'] || '').slice(0, 120),
        createdAt: now,
        expiresAt: now + 14 * 24 * 60 * 60 * 1000,
      };
      saveStore();
      sysLog('AUTH', `网站用户 [${oldUsername} -> ${userObj.username}] 已更新自身账号密码`, { ownerUsernames: [userObj.username, oldUsername] });
      const cookieStr = `ishit_panel_session=${newToken}; Path=/; Max-Age=${14 * 86400}; HttpOnly; SameSite=Lax`;
      return sendJson(res, { ok: true, token: newToken, username: userObj.username, role, msg: '账号与密码已更新' }, 200, { 'Set-Cookie': cookieStr });
    }

    // Admin 专属：添加 / 修改 / 删除网站用户 (User / Admin)
    if (pathname === '/api/auth/users' && req.method === 'POST') {
      if (!currentSess || currentSess.role !== 'admin') {
        return sendJson(res, { ok: false, msg: '权限不足：仅管理员 (Admin) 可管理网站用户' }, 403);
      }
      const body = await readBodyJson(req);
      const pa = ensurePanelAuthStore();
      const { action } = body;

      if (action === 'add') {
        const username = String(body.username || '').trim();
        const password = String(body.password || '');
        const role = body.role === 'admin' ? 'admin' : 'user';
        if (!username) return sendJson(res, { ok: false, msg: '请输入用户名' });
        if (pa.users.some((u) => u && u.username === username)) {
          return sendJson(res, { ok: false, msg: '该用户名已存在' });
        }
        if (!password || password.length < 4) {
          return sendJson(res, { ok: false, msg: '密码不能少于 4 位' });
        }
        pa.users.push({
          id: `u_${Date.now()}`,
          username,
          passwordHash: EncryptionUtil.md5Hash(password),
          role: username === 'ishit' ? 'admin' : role,
          createdAt: Date.now(),
        });
        saveStore();
        sysLog('AUTH', `管理员 ${currentSess.username} 新增网站用户: ${username} (${role})`);
        return sendJson(res, { ok: true, msg: `已添加用户 ${username}` });
      }

      if (action === 'update') {
        const targetUsername = String(body.targetUsername || body.username || '').trim();
        const newUsername = String(body.newUsername || targetUsername).trim();
        const newPassword = String(body.newPassword || '');
        const newRole = body.role === 'admin' ? 'admin' : 'user';
        const target = pa.users.find((u) => u && u.username === targetUsername);
        if (!target) return sendJson(res, { ok: false, msg: '目标用户不存在' });
        if (!newUsername) return sendJson(res, { ok: false, msg: '用户名不能为空' });
        if (newUsername !== targetUsername && pa.users.some((u) => u && u.username === newUsername)) {
          return sendJson(res, { ok: false, msg: '新用户名已被占用' });
        }

        target.username = newUsername;
        if (newPassword) {
          if (newPassword.length < 4) return sendJson(res, { ok: false, msg: '密码长度不能少于 4 位' });
          target.passwordHash = EncryptionUtil.md5Hash(newPassword);
        }
        target.role = target.username === 'ishit' ? 'admin' : newRole;

        if (pa.username === targetUsername) {
          pa.username = newUsername;
          if (newPassword) pa.passwordHash = target.passwordHash;
        }

        if (newUsername !== targetUsername) {
          for (const acc of store.accounts || []) {
            if (acc && acc.ownerUsername === targetUsername) acc.ownerUsername = newUsername;
          }
          for (const preset of store.locationPresets || []) {
            if (preset && preset.createdBy === targetUsername) preset.createdBy = newUsername;
          }
          if (store.userScheduleConfigs && store.userScheduleConfigs[targetUsername]) {
            store.userScheduleConfigs[newUsername] = store.userScheduleConfigs[targetUsername];
            delete store.userScheduleConfigs[targetUsername];
          }
        }
        // 使该被修改用户的旧会话失效（若修改的是别人）
        if (targetUsername !== currentSess.username) {
          for (const [tk, sv] of Object.entries(pa.sessions)) {
            if (sv && sv.username === targetUsername) delete pa.sessions[tk];
          }
        } else {
          for (const sv of Object.values(pa.sessions)) {
            if (sv && sv.username === targetUsername) {
              sv.username = newUsername;
              sv.role = target.role;
            }
          }
        }
        saveStore();
        sysLog('AUTH', `管理员 ${currentSess.username} 更新了网站用户: ${targetUsername} -> ${newUsername} (${target.role})`);
        return sendJson(res, { ok: true, msg: '用户信息已更新' });
      }

      if (action === 'delete') {
        const targetUsername = String(body.username || '').trim();
        if (!targetUsername) return sendJson(res, { ok: false, msg: '缺少用户名' });
        if (targetUsername === 'ishit' || targetUsername === currentSess.username) {
          return sendJson(res, { ok: false, msg: '不能删除主管理员或当前登录账号' });
        }
        pa.users = pa.users.filter((u) => u && u.username !== targetUsername);
        for (const [tk, sv] of Object.entries(pa.sessions)) {
          if (sv && sv.username === targetUsername) delete pa.sessions[tk];
        }
        saveStore();
        sysLog('AUTH', `管理员 ${currentSess.username} 删除了网站用户: ${targetUsername}`);
        return sendJson(res, { ok: true, msg: `已删除用户 ${targetUsername}` });
      }

      return sendJson(res, { ok: false, msg: '未知操作' });
    }

    // 1. 全局与用户状态快照（支持 Admin 全局视图 & User 个人仪表盘过滤）
    if (pathname === '/api/status' && req.method === 'GET') {
      const pa = ensurePanelAuthStore();
      const isAdmin = !currentSess || currentSess.role === 'admin';
      const currentUsername = currentSess ? currentSess.username : (pa.username || 'ishit');
      const myOwnedAccounts = (store.accounts || []).filter((a) => a && a.ownerUsername === currentUsername);
      const myOwnedUids = myOwnedAccounts.map((a) => String(a.uid));
      const myOwnedNames = myOwnedAccounts.map((a) => String(a.name || '')).filter(Boolean);
      const myOwnedAcc = myOwnedAccounts[0] || null;
      const myCourseNames = new Set();
      const myCourseIds = new Set();
      const myClassIds = new Set();
      for (const acc of myOwnedAccounts) {
        const eff = getEffectiveUserProfile(acc.uid);
        for (const c of eff?.coursesCache || []) {
          const cn = c.name || c.courseName;
          if (cn) myCourseNames.add(String(cn));
          if (c.courseId) myCourseIds.add(String(c.courseId));
          if (c.classId) myClassIds.add(String(c.classId));
        }
      }
      // 触发非阻塞高频状态巡检，确保悬赏榜与活动监测毫秒级剔除已截止/已签完活动
      syncActiveBountiesNow({ force: false }).catch(() => {});

      const defaultSelectedUid = isAdmin
        ? (store.currentUid || store.accounts?.[0]?.uid || null)
        : (myOwnedAcc?.uid || store.accounts?.[0]?.uid || null);
      const targetUid = parsedUrl.searchParams.get('uid') || defaultSelectedUid;
      const engine = getEngineState();
      const rawProfile = targetUid ? ensureUserProfile(targetUid) : null;
      const effectiveProfile = targetUid ? getEffectiveUserProfile(targetUid) : null;

      // 当前所选学习通账号或当前登录面板用户生效的轮询参数
      const selectedAccObj = (store.accounts || []).find((a) => String(a.uid) === String(targetUid));
      const effectiveSchedule = isAdmin
        ? (selectedAccObj ? getEffectiveScheduleForCxUid(targetUid) : getEffectiveScheduleForPanelUser(currentUsername))
        : getEffectiveScheduleForPanelUser(currentUsername);

      const sanitizedUsers = isAdmin
        ? pa.users.map((u) => {
            const boundAccs = (store.accounts || []).filter((a) => a && a.ownerUsername === u.username);
            return {
              id: u.id,
              username: u.username,
              role: u.username === 'ishit' || u.role === 'admin' ? 'admin' : 'user',
              createdAt: u.createdAt,
              boundAccounts: boundAccs.map((a) => ({ uid: a.uid, name: a.name })),
            };
          })
        : [];

      // 为 User 过滤只属于自己学习通账号的签到记录、与自己有关的日志、活动监测及待验证滑块
      const visibleHistory = isAdmin
        ? (store.signHistory || []).slice(0, 40)
        : (store.signHistory || [])
            .filter((h) => (h.results || []).some((r) => myOwnedUids.includes(String(r.uid)) || myOwnedNames.includes(String(r.name || ''))))
            .map((h) => ({
              ...h,
              results: (h.results || []).filter((r) => myOwnedUids.includes(String(r.uid)) || myOwnedNames.includes(String(r.name || ''))),
            }))
            .slice(0, 40);

      const visibleLogs = isAdmin
        ? logsBuffer.slice(0, 100)
        : logsBuffer
            .filter((entry) => {
              if (!entry) return false;
              if (typeof entry === 'object') {
                if (Array.isArray(entry.ownerUsernames) && entry.ownerUsernames.includes(currentUsername)) return true;
                if (Array.isArray(entry.uids) && entry.uids.some((u) => myOwnedUids.includes(String(u)))) return true;
              }
              const text = typeof entry === 'string' ? entry : String(entry.line || entry.msg || '');
              if (currentUsername && (text.includes(`[${currentUsername}]`) || text.includes(`: ${currentUsername} `))) return true;
              for (const u of myOwnedUids) {
                if (u && text.includes(u)) return true;
              }
              for (const n of myOwnedNames) {
                if (n && text.includes(n)) return true;
              }
              for (const cn of myCourseNames) {
                if (cn && text.includes(`《${cn}》`)) return true;
              }
              return false;
            })
            .slice(0, 100);

      const activeBounties = getActiveBountiesForUser({
        myCourseIds,
        myClassIds,
        myCourseNames,
        myOwnedUids,
      });

      // 活动监测与签到悬赏共享同一实时真理源 (SSOT)：合并未签完悬赏与实时监测活动，自动过滤本人已签完的活动防止重签
      const unifiedActivesMap = new Map();
      for (const item of engine.lastDetectedActives || []) {
        const act = item.active || item;
        const aid = String(act?.id || '');
        if (!aid) continue;
        if (!isAdmin) {
          const relatedToMe =
            (item.memberUids || []).some((u) => myOwnedUids.includes(String(u))) ||
            (item.classId && myClassIds.has(String(item.classId))) ||
            (item.courseId && myCourseIds.has(String(item.courseId)));
          if (!relatedToMe) continue;
          // 若我绑定的账号已经签成功，则不再在我的“活动监测”里展示为待签（防误触重签）
          if (
            myOwnedUids.length > 0 &&
            Array.isArray(item.succeededUids) &&
            myOwnedUids.every((u) => item.succeededUids.includes(String(u)))
          ) {
            continue;
          }
        }
        unifiedActivesMap.set(aid, item);
      }
      // 反哺：若签到悬赏里有本人或同课待签活动，但轮询间隙尚未塞入监测卡片，同步补齐到活动监测
      for (const b of activeBounties) {
        const aid = String(b.activeId || '');
        if (!aid) continue;
        if (!isAdmin && !b.includesMe && !b.isMyCourse) continue;
        if (!isAdmin && myOwnedUids.length > 0 && !b.includesMe && Array.isArray(b.succeededUids) && myOwnedUids.some((u) => b.succeededUids.includes(String(u)))) {
          continue;
        }
        if (!unifiedActivesMap.has(aid)) {
          unifiedActivesMap.set(aid, {
            courseId: b.courseId,
            classId: b.classId,
            courseName: b.courseName,
            memberUids: b.targetUids,
            memberNames: b.targetNames,
            pendingUids: b.pendingUids,
            pendingNames: b.pendingNames,
            succeededUids: b.succeededUids,
            succeededNames: b.succeededNames,
            helperToken: b.token,
            designatedPlace: b.designatedPlace,
            locationRange: b.locationRange,
            active: {
              id: b.activeId,
              name: b.activeName,
              signType: b.signType,
              status: true,
              signedCount: b.signedCount,
              totalCount: b.totalCount,
              endTimeMs: b.endTimeMs,
              waitingThreshold: b.waitingThreshold,
            },
          });
        } else {
          const ex = unifiedActivesMap.get(aid);
          ex.pendingUids = b.pendingUids;
          ex.pendingNames = b.pendingNames;
          ex.succeededUids = b.succeededUids;
          ex.succeededNames = b.succeededNames;
          ex.helperToken = b.token;
          if (ex.active) {
            ex.active.signedCount = b.signedCount || ex.active.signedCount || 0;
            ex.active.totalCount = b.totalCount || ex.active.totalCount || 0;
            ex.active.endTimeMs = b.endTimeMs || ex.active.endTimeMs || 0;
          }
        }
      }
      const visibleActives = Array.from(unifiedActivesMap.values());

      // 为当前登录用户筛选与其学习通账号相关的实时通知（签到检测、签到成功、签到失败）
      const nowMs = Date.now();
      const visibleAlerts = (store.recentAlerts || [])
        .filter((al) => {
          if (!al || nowMs - Number(al.timeMs || 0) > 25 * 60 * 1000) return false;
          if (isAdmin) return true;
          const hitUid = (al.targetUids || []).some((u) => myOwnedUids.includes(String(u)));
          const hitName = (al.targetNames || []).some((n) => myOwnedNames.includes(String(n)));
          // 签到成功/失败仅通知当事人；发现新签到通知当事人或同班同学
          if (al.eventType === 'sign_success' || al.eventType === 'sign_failed') {
            return hitUid || hitName;
          }
          const hitCourse =
            (al.classId && myClassIds.has(String(al.classId))) ||
            (al.courseId && myCourseIds.has(String(al.courseId))) ||
            (al.courseName && myCourseNames.has(String(al.courseName)));
          return hitUid || hitName || hitCourse;
        })
        .slice(0, 20);

      const visibleCaptchas = isAdmin
        ? Object.values(store.pendingCaptchas || {})
        : Object.values(store.pendingCaptchas || {}).filter((c) => myOwnedUids.includes(String(c.uid)));

      const userInClass = isAdmin
        ? engine.inClass
        : myOwnedUids.some((u) => Boolean(engine.perAccountStatus?.[u]?.inClass));

      return sendJson(res, {
        ok: true,
        ...engine,
        inClass: userInClass,
        lastDetectedActives: visibleActives,
        currentUid: store.currentUid,
        selectedUid: targetUid,
        myOwnedUid: myOwnedAcc?.uid || null,
        canEditSelectedAccount: canSessionEditCxAccount(currentSess, targetUid),
        accounts: sanitizeAccountsListForClient(store.accounts, currentSess),
        userProfile: rawProfile,
        effectiveProfile,
        courses: targetUid ? mergeCoursesForUser(targetUid) : [],
        myOwnedCourses: myOwnedAcc ? mergeCoursesForUser(myOwnedAcc.uid) : [],
        locationPresets: store.locationPresets || [],
        schedule: effectiveSchedule,
        globalSchedule: store.schedule,
        bountyConfig: store.bountyConfig || { bountySyncSeconds: 2, idleSyncSeconds: 3 },
        effectiveIntervalSeconds: typeof getEffectiveTimerIntervalSeconds === 'function' ? getEffectiveTimerIntervalSeconds() : Number(store.schedule?.intervalSeconds || 25),
        panelAuth: {
          enabled: pa.enabled !== false,
          username: currentUsername,
          role: isAdmin ? 'admin' : 'user',
          activeSessionCount: Object.keys(pa.sessions || {}).length,
          users: sanitizedUsers,
        },
        napcat: isAdmin ? store.napcat : null,
        bounties: activeBounties,
        leaderboard: getFormattedLeaderboard(),
        bountyHistory: getFormattedBountyHistory(),
        recentAlerts: visibleAlerts,
        pendingCaptchas: visibleCaptchas,
        history: visibleHistory,
        logs: visibleLogs,
      });
    }

    // 1.5 原生后台守护专属极轻量告警心跳接口（省电、低流量、息屏秒推）
    if (pathname === '/api/alerts/poll' && req.method === 'GET') {
      const pa = ensurePanelAuthStore();
      const isAdmin = !currentSess || currentSess.role === 'admin';
      const currentUsername = currentSess ? currentSess.username : (pa.username || 'ishit');
      const myOwnedAccounts = (store.accounts || []).filter((a) => a && a.ownerUsername === currentUsername);
      const myOwnedUids = myOwnedAccounts.map((a) => String(a.uid));
      const myOwnedNames = myOwnedAccounts.map((a) => String(a.name || '')).filter(Boolean);
      const myCourseNames = new Set();
      const myCourseIds = new Set();
      const myClassIds = new Set();
      for (const acc of myOwnedAccounts) {
        const eff = getEffectiveUserProfile(acc.uid);
        for (const c of eff?.coursesCache || []) {
          const cn = c.name || c.courseName;
          if (cn) myCourseNames.add(String(cn));
          if (c.courseId) myCourseIds.add(String(c.courseId));
          if (c.classId) myClassIds.add(String(c.classId));
        }
      }

      syncActiveBountiesNow({ force: false }).catch(() => {});

      const sinceMs = Math.max(0, Number(parsedUrl.searchParams.get('since') || 0));
      const nowMs = Date.now();
      const visibleAlerts = (store.recentAlerts || [])
        .filter((al) => {
          if (!al) return false;
          const t = Number(al.timeMs || 0);
          if (nowMs - t > 25 * 60 * 1000) return false;
          if (sinceMs > 0 && t < sinceMs) return false;
          if (isAdmin) return true;
          const hitUid = (al.targetUids || []).some((u) => myOwnedUids.includes(String(u)));
          const hitName = (al.targetNames || []).some((n) => myOwnedNames.includes(String(n)));
          if (al.eventType === 'sign_success' || al.eventType === 'sign_failed') {
            return hitUid || hitName;
          }
          const hitCourse =
            (al.classId && myClassIds.has(String(al.classId))) ||
            (al.courseId && myCourseIds.has(String(al.courseId))) ||
            (al.courseName && myCourseNames.has(String(al.courseName)));
          return hitUid || hitName || hitCourse;
        })
        .slice(0, 15);

      const activeBounties = getActiveBountiesForUser({
        myCourseIds,
        myClassIds,
        myCourseNames,
        myOwnedUids,
      });

      const engine = getEngineState();
      const userInClass = isAdmin
        ? Boolean(engine.inClass)
        : myOwnedUids.some((u) => Boolean(engine.perAccountStatus?.[u]?.inClass));

      return sendJson(res, {
        ok: true,
        serverTimeMs: nowMs,
        username: currentUsername,
        inClass: userInClass,
        forcePolling: Boolean(store.schedule?.forcePolling),
        effectiveIntervalSeconds: getEffectiveTimerIntervalSeconds(),
        activeBountyCount: activeBounties.length,
        alerts: visibleAlerts,
      });
    }

    // 2. 账号登录：密码登录 / 短信登录 / 扫码登录 (同源 Cookie 代理，支持归属网站用户与 User 单账号限制)
    if (pathname === '/api/accounts/login' && req.method === 'POST') {
      const body = await readBodyJson(req);
      const { username, password, tempKey = '__web_login' } = body;
      if (!username || !password) return sendJson(res, { ok: false, msg: '请输入账号和密码' });
      const actor = resolveAccountActor(req, parsedUrl);

      const loginRes = await CXProtocol.loginWeb(username, password, tempKey);
      if (loginRes && loginRes.status === true) {
        const user = await CXProtocol.fetchUserInfo({ tempSessionKey: tempKey });
        if (user) {
          const check = canActorBindCxAccount(actor, user.uid);
          if (!check.allowed) {
            delete store.tempCookies[tempKey];
            return sendJson(res, { ok: false, msg: check.msg }, 403);
          }
          addOrUpdateAccount(user, actor.username);
          await CXProtocol.getCoursesList(user.uid);
          await CXProtocol.fetchCurriculum(user.uid);
          sysLog('ACCOUNT', `[${actor.username}] 登录学习通成功: ${user.name}`, { uids: [user.uid], ownerUsernames: [actor.username] });
          return sendJson(res, { ok: true, user: sanitizeAccountForClient(user, actor.role === 'admin', actor.username) });
        }
      }
      return sendJson(res, { ok: false, msg: loginRes?.msg2 || loginRes?.mes || '账号或密码错误' });
    }

    if (pathname === '/api/accounts/sms/send' && req.method === 'POST') {
      const actor = resolveAccountActor(req, parsedUrl);
      const check = canActorBindCxAccount(actor, '__new__');
      if (!check.allowed) return sendJson(res, { ok: false, msg: check.msg }, 403);
      const body = await readBodyJson(req);
      const { phone, tempKey = '__sms_login' } = body;
      const r = await CXProtocol.sendSmsCode(phone, tempKey);
      return sendJson(res, { ok: Boolean(r?.status), data: r, msg: r?.mes || (r?.status ? '验证码已发送' : '发送失败') });
    }

    if (pathname === '/api/accounts/sms/login' && req.method === 'POST') {
      const body = await readBodyJson(req);
      const { phone, code, tempKey = '__sms_login' } = body;
      const actor = resolveAccountActor(req, parsedUrl);
      const r = await CXProtocol.loginApp('2', phone, code, tempKey);
      if (r && r.status === true) {
        const user = await CXProtocol.fetchUserInfo({ tempSessionKey: tempKey });
        if (user) {
          const check = canActorBindCxAccount(actor, user.uid);
          if (!check.allowed) {
            delete store.tempCookies[tempKey];
            return sendJson(res, { ok: false, msg: check.msg }, 403);
          }
          addOrUpdateAccount(user, actor.username);
          await CXProtocol.getCoursesList(user.uid);
          await CXProtocol.fetchCurriculum(user.uid);
          sysLog('ACCOUNT', `[${actor.username}] 短信登录学习通成功: ${user.name}`, { uids: [user.uid], ownerUsernames: [actor.username] });
          return sendJson(res, { ok: true, user: sanitizeAccountForClient(user, actor.role === 'admin', actor.username) });
        }
      }
      return sendJson(res, { ok: false, msg: r?.mes || '验证码登录失败' });
    }

    if (pathname === '/api/accounts/qr/create' && req.method === 'POST') {
      const body = await readBodyJson(req);
      const tempKey = body.tempKey || `__qr_${Date.now()}`;
      const qr = await CXProtocol.getQRCodeData(tempKey);
      return sendJson(res, { ok: Boolean(qr?.uuid), tempKey, ...qr });
    }

    if (pathname === '/api/accounts/qr/poll' && req.method === 'POST') {
      const body = await readBodyJson(req);
      const { uuid, enc, tempKey = '__qr' } = body;
      const actor = resolveAccountActor(req, parsedUrl);
      const st = await CXProtocol.checkQRAuthStatus(uuid, enc, tempKey);
      if (st && st.status === true) {
        const user = await CXProtocol.fetchUserInfo({ tempSessionKey: tempKey });
        if (user) {
          const check = canActorBindCxAccount(actor, user.uid);
          if (!check.allowed) {
            delete store.tempCookies[tempKey];
            return sendJson(res, { ok: false, loggedIn: false, msg: check.msg, statusText: check.msg }, 403);
          }
          addOrUpdateAccount(user, actor.username);
          await CXProtocol.getCoursesList(user.uid);
          await CXProtocol.fetchCurriculum(user.uid);
          sysLog('ACCOUNT', `[${actor.username}] 扫码登录学习通成功: ${user.name}`, { uids: [user.uid], ownerUsernames: [actor.username] });
          return sendJson(res, { ok: true, loggedIn: true, user: sanitizeAccountForClient(user, actor.role === 'admin', actor.username) });
        }
      }
      return sendJson(res, {
        ok: true,
        loggedIn: false,
        expired: String(st?.type) === '2',
        statusText: st?.mes || '等待扫码',
        raw: st,
      });
    }

    // 3. 账号动作与用户独立配置 / 沿用其他用户配置
    if (pathname === '/api/accounts/action' && req.method === 'POST') {
      const body = await readBodyJson(req);
      const { action, uid } = body;
      if (action === 'setPrimary' || action === 'switch') {
        if (currentSess && currentSess.role !== 'admin') {
          return sendJson(res, { ok: false, msg: '权限不足：仅管理员可切换全局主账号' }, 403);
        }
        store.currentUid = uid;
        saveStore();
        return sendJson(res, { ok: true, currentUid: store.currentUid });
      }
      if (action === 'delete') {
        if (!canSessionEditCxAccount(currentSess, uid)) {
          return sendJson(res, { ok: false, msg: '权限不足：您只能移除自己名下的学习通账号' }, 403);
        }
        store.accounts = (store.accounts || []).filter((a) => a.uid !== uid);
        delete store.cookies[uid];
        if (store.currentUid === uid) store.currentUid = store.accounts[0]?.uid || null;
        saveStore();
        return sendJson(res, { ok: true, accounts: sanitizeAccountsListForClient(store.accounts, currentSess), currentUid: store.currentUid });
      }
      if (action === 'refreshAll') {
        for (const acc of store.accounts || []) {
          const refreshed = await CXProtocol.fetchUserInfo({ userId: acc.uid });
          if (refreshed) {
            Object.assign(acc, refreshed, {
              status: true,
              ownerUsername: acc.ownerUsername,
              cachedFaceObjectId: refreshed.cachedFaceObjectId || acc.cachedFaceObjectId,
            });
          } else {
            acc.status = false;
          }
        }
        saveStore();
        return sendJson(res, { ok: true, accounts: sanitizeAccountsListForClient(store.accounts, currentSess) });
      }
      if (action === 'uploadFace') {
        if (!canSessionEditCxAccount(currentSess, uid)) {
          return sendJson(res, { ok: false, msg: '权限不足：只能为自己名下的学习通账号上传人脸底图' }, 403);
        }
        const acc = (store.accounts || []).find((a) => String(a.uid) === String(uid));
        if (!acc) return sendJson(res, { ok: false, msg: '未找到该学习通账号' }, 404);
        const cleanB64 = String(body.base64Image || '').replace(/^data:image\/\w+;base64,/, '');
        const buf = Buffer.from(cleanB64, 'base64');
        const faceObjId = await CXProtocol.uploadFaceImageBuffer(acc, buf);
        if (!faceObjId) return sendJson(res, { ok: false, msg: '上传人脸底图到超星云盘失败' });
        sysLog('ACCOUNT', `账号[${acc.name}] 已更新人脸签到照片底图 (${faceObjId.slice(0, 10)}...)`, { uids: [acc.uid] });
        return sendJson(res, { ok: true, cachedFaceObjectId: faceObjId, accounts: sanitizeAccountsListForClient(store.accounts, currentSess) });
      }
      return sendJson(res, { ok: false, msg: '未知操作' });
    }

    if (pathname === '/api/user/profile' && req.method === 'POST') {
      const body = await readBodyJson(req);
      const uid = body.uid || store.currentUid;
      if (!uid) return sendJson(res, { ok: false, msg: '未指定用户' });
      if (!canSessionEditCxAccount(currentSess, uid)) {
        return sendJson(res, { ok: false, msg: '只读模式：您只能修改自己名下的学习通账号配置' }, 403);
      }
      const prof = ensureUserProfile(uid);

      if (body.inheritFromUid !== undefined) prof.inheritFromUid = body.inheritFromUid || null;
      if (body.useCurriculumSchedule !== undefined) prof.useCurriculumSchedule = Boolean(body.useCurriculumSchedule);
      if (body.curriculumBufferMinutes !== undefined) prof.curriculumBufferMinutes = Number(body.curriculumBufferMinutes);
      if (body.defaultLocation !== undefined) prof.defaultLocation = body.defaultLocation;
      if (body.locationRandomOffsetEnabled !== undefined) {
        prof.locationRandomOffsetEnabled = Boolean(body.locationRandomOffsetEnabled);
      }
      if (body.locationRandomOffsetMeters !== undefined && !Number.isNaN(Number(body.locationRandomOffsetMeters))) {
        prof.locationRandomOffsetMeters = Math.max(0, Math.min(500, Number(body.locationRandomOffsetMeters)));
      }
      if (body.slots !== undefined) prof.slots = body.slots;
      if (body.diyLessons !== undefined && Array.isArray(body.diyLessons)) {
        prof.diyLessons = body.diyLessons.map((item, idx) => ({
          id: item.id || `diy_${Date.now()}_${idx}`,
          isDiy: true,
          enabled: item.enabled !== false,
          pollingEnabled: item.pollingEnabled !== false,
          courseId: String(item.courseId || ''),
          classId: String(item.classId || ''),
          className: String(item.className || ''),
          name: String(item.name || '自定义课程'),
          teacherName: String(item.teacherName || ''),
          location: String(item.location || ''),
          dayOfWeek: Math.max(1, Math.min(7, Number(item.dayOfWeek || 1))),
          beginNumber: Math.max(1, Number(item.beginNumber || 1)),
          length: Math.max(1, Number(item.length || 2)),
          startTime: String(item.startTime || '08:00'),
          endTime: String(item.endTime || '09:50'),
          weeks: Array.isArray(item.weeks) ? item.weeks.map(Number).filter(Boolean) : [],
        }));
      }

      // 一键复制其他用户的配置快照到当前用户
      if (body.copyFromUid && store.userProfiles[body.copyFromUid]) {
        const src = store.userProfiles[body.copyFromUid];
        prof.useCurriculumSchedule = src.useCurriculumSchedule;
        prof.curriculumBufferMinutes = src.curriculumBufferMinutes;
        prof.defaultLocation = JSON.parse(JSON.stringify(src.defaultLocation));
        prof.locationRandomOffsetEnabled =
          src.locationRandomOffsetEnabled !== undefined ? Boolean(src.locationRandomOffsetEnabled) : true;
        prof.locationRandomOffsetMeters =
          Number.isFinite(Number(src.locationRandomOffsetMeters)) && Number(src.locationRandomOffsetMeters) >= 0
            ? Math.min(500, Number(src.locationRandomOffsetMeters))
            : 15;
        prof.slots = JSON.parse(JSON.stringify(src.slots || []));
        prof.diyLessons = JSON.parse(JSON.stringify(src.diyLessons || []));
        prof.courseSettings = JSON.parse(JSON.stringify(src.courseSettings || {}));
        if (src.curriculumCache && !prof.curriculumCache) {
          prof.curriculumCache = JSON.parse(JSON.stringify(src.curriculumCache));
        }
      }

      saveStore();
      restartScheduler();
      return sendJson(res, { ok: true, profile: prof, effectiveProfile: getEffectiveUserProfile(uid) });
    }

    // 4. 读取学习通原生课表
    if (pathname === '/api/curriculum/sync' && req.method === 'POST') {
      const body = await readBodyJson(req);
      const uid = body.uid || store.currentUid || store.accounts?.[0]?.uid;
      if (!uid) return sendJson(res, { ok: false, msg: '请先登录账号' });
      if (!canSessionEditCxAccount(currentSess, uid)) {
        return sendJson(res, { ok: false, msg: '只读模式：您只能同步自己名下的学习通课表' }, 403);
      }
      const cur = await CXProtocol.fetchCurriculum(uid);
      if (!cur) return sendJson(res, { ok: false, msg: '读取学习通课表失败' });
      sysLog('CURRICULUM', `已同步学习通课表: 第 ${cur.realCurrentWeek} 周, 共 ${cur.lessons.length} 门排课`, { uids: [uid], ownerUsernames: currentSess?.username ? [currentSess.username] : [] });
      return sendJson(res, { ok: true, curriculum: cur });
    }

    // 5. 课程列表与单门课配置 (支持按用户独立配置)
    if (pathname === '/api/courses' && req.method === 'GET') {
      const force = parsedUrl.searchParams.get('refresh') === '1';
      const uid = parsedUrl.searchParams.get('uid') || store.currentUid || store.accounts?.[0]?.uid;
      if (!uid) return sendJson(res, { ok: true, courses: [] });
      if (force && !canSessionEditCxAccount(currentSess, uid)) {
        return sendJson(res, { ok: false, msg: '只读模式：您只能同步自己名下的学习通课程' }, 403);
      }
      const prof = ensureUserProfile(uid);
      if (force || !prof.coursesCache || prof.coursesCache.length === 0) {
        await CXProtocol.getCoursesList(uid);
      }
      return sendJson(res, { ok: true, courses: mergeCoursesForUser(uid) });
    }

    if (pathname === '/api/courses/settings/batch' && req.method === 'POST') {
      const body = await readBodyJson(req);
      const uid = body.uid || store.currentUid || store.accounts?.[0]?.uid;
      const { pollingEnabled } = body;
      if (!uid || pollingEnabled === undefined) return sendJson(res, { ok: false, msg: '缺少参数' });
      if (!canSessionEditCxAccount(currentSess, uid)) {
        return sendJson(res, { ok: false, msg: '只读模式：无法修改其他用户的课程设置' }, 403);
      }
      const uSched = getEffectiveScheduleForCxUid(uid);
      if (uSched?.forcePolling) {
        return sendJson(res, { ok: false, msg: '当前为持续轮询模式，无法修改常规课程轮询开关（测试课程除外）' });
      }

      const prof = ensureUserProfile(uid);
      const eff = getEffectiveUserProfile(uid);
      const courses = prof.coursesCache?.length ? prof.coursesCache : (eff.coursesCache || []);
      const seenCourseIds = new Set();
      let updatedCount = 0;

      for (const c of courses) {
        const cid = String(c.courseId);
        if (!cid || seenCourseIds.has(cid)) continue;
        seenCourseIds.add(cid);

        const prev = prof.courseSettings[cid] || eff.courseSettings?.[cid] || {
          pollingEnabled: true,
          isTestCourse: false,
          testPollingEnabled: true,
          location: null,
          imageObjectIds: [],
        };
        if (prev.isTestCourse) continue; // 测试课程独立控制，不受常规批量开关影响

        prof.courseSettings[cid] = {
          pollingEnabled: Boolean(pollingEnabled),
          isTestCourse: false,
          testPollingEnabled: prev.testPollingEnabled !== undefined ? Boolean(prev.testPollingEnabled) : true,
          location: prev.location || null,
          ...(prev.randomOffsetEnabled !== undefined ? { randomOffsetEnabled: Boolean(prev.randomOffsetEnabled) } : {}),
          ...(prev.randomOffsetMeters !== undefined ? { randomOffsetMeters: Number(prev.randomOffsetMeters) } : {}),
          imageObjectIds: prev.imageObjectIds || [],
        };
        updatedCount++;
      }

      saveStore();
      restartScheduler();
      return sendJson(res, { ok: true, updatedCount, courses: mergeCoursesForUser(uid) });
    }

    if (pathname === '/api/courses/settings' && req.method === 'POST') {
      const body = await readBodyJson(req);
      const uid = body.uid || store.currentUid || store.accounts?.[0]?.uid;
      const {
        courseId,
        pollingEnabled,
        isTestCourse,
        testPollingEnabled,
        location,
        randomOffsetEnabled,
        randomOffsetMeters,
        imageObjectIds,
      } = body;
      if (!uid || !courseId) return sendJson(res, { ok: false, msg: '缺少参数' });
      if (!canSessionEditCxAccount(currentSess, uid)) {
        return sendJson(res, { ok: false, msg: '只读模式：无法修改其他用户的课程设置' }, 403);
      }
      const uSched = getEffectiveScheduleForCxUid(uid);
      if (pollingEnabled !== undefined && isTestCourse === undefined && testPollingEnabled === undefined && uSched?.forcePolling) {
        return sendJson(res, { ok: false, msg: '当前为持续轮询模式，无法修改常规课程轮询开关（测试课程除外）' });
      }

      const prof = ensureUserProfile(uid);
      const prev = prof.courseSettings[courseId] || {
        pollingEnabled: true,
        isTestCourse: false,
        testPollingEnabled: true,
        location: null,
        imageObjectIds: [],
      };
      prof.courseSettings[courseId] = {
        pollingEnabled: pollingEnabled !== undefined ? Boolean(pollingEnabled) : prev.pollingEnabled,
        isTestCourse: isTestCourse !== undefined ? Boolean(isTestCourse) : Boolean(prev.isTestCourse),
        testPollingEnabled:
          testPollingEnabled !== undefined
            ? Boolean(testPollingEnabled)
            : prev.testPollingEnabled !== undefined
            ? Boolean(prev.testPollingEnabled)
            : true,
        location: location !== undefined ? location : prev.location,
        ...(randomOffsetEnabled !== undefined
          ? { randomOffsetEnabled: Boolean(randomOffsetEnabled) }
          : prev.randomOffsetEnabled !== undefined
          ? { randomOffsetEnabled: Boolean(prev.randomOffsetEnabled) }
          : {}),
        ...(randomOffsetMeters !== undefined && !Number.isNaN(Number(randomOffsetMeters))
          ? { randomOffsetMeters: Math.max(0, Math.min(500, Number(randomOffsetMeters))) }
          : prev.randomOffsetMeters !== undefined
          ? { randomOffsetMeters: Math.max(0, Math.min(500, Number(prev.randomOffsetMeters))) }
          : {}),
        imageObjectIds: imageObjectIds !== undefined ? imageObjectIds : prev.imageObjectIds,
      };
      saveStore();
      restartScheduler();
      return sendJson(res, { ok: true, settings: prof.courseSettings[courseId] });
    }

    if (pathname === '/api/courses/uploadPhoto' && req.method === 'POST') {
      const body = await readBodyJson(req);
      const uid = body.uid || store.currentUid || store.accounts?.[0]?.uid;
      const { courseId, base64Image } = body;
      if (courseId && !canSessionEditCxAccount(currentSess, uid)) {
        return sendJson(res, { ok: false, msg: '只读模式：无法修改其他用户的课程拍照图库' }, 403);
      }
      const user = (store.accounts || []).find((a) => a.uid === uid) || store.accounts?.[0];
      if (!user) return sendJson(res, { ok: false, msg: '请先登录账号' });
      const cleanB64 = String(base64Image || '').replace(/^data:image\/\w+;base64,/, '');
      const buf = Buffer.from(cleanB64, 'base64');
      const objectId = await CXProtocol.uploadImageToPan(user, buf);
      if (!objectId) return sendJson(res, { ok: false, msg: '上传失败' });

      if (courseId) {
        const prof = ensureUserProfile(user.uid);
        const prev = prof.courseSettings[courseId] || { pollingEnabled: true, location: null, imageObjectIds: [] };
        prev.imageObjectIds = [...(prev.imageObjectIds || []), objectId];
        prof.courseSettings[courseId] = prev;
        saveStore();
      }
      return sendJson(res, { ok: true, objectId });
    }

    if (pathname === '/api/courses/actives' && req.method === 'GET') {
      const courseId = parsedUrl.searchParams.get('courseId') || '';
      const classId = parsedUrl.searchParams.get('classId') || '';
      const cpi = parsedUrl.searchParams.get('cpi') || '';
      const primaryUid = parsedUrl.searchParams.get('uid') || store.currentUid;
      const matchedAccs = findMatchingAccountsForClass(courseId, classId, null);
      const tryUids = [
        primaryUid,
        ...matchedAccs.map((a) => a.uid).filter((u) => u !== primaryUid),
      ].filter(Boolean);
      let actives = [];
      let lastError = null;
      for (const u of tryUids) {
        try {
          actives = await CXProtocol.getActiveList(courseId, classId, cpi, u);
          lastError = null;
          break;
        } catch (e) {
          lastError = e;
        }
      }
      if (lastError && actives.length === 0) {
        return sendJson(res, { ok: false, msg: lastError.message, actives: [] });
      }
      return sendJson(res, { ok: true, actives });
    }

    if (pathname === '/api/courses/activeInfo' && req.method === 'GET') {
      const activeId = parsedUrl.searchParams.get('activeId') || '';
      const courseIdParam = parsedUrl.searchParams.get('courseId') || '';
      const classIdParam = parsedUrl.searchParams.get('classId') || '';
      const uid = parsedUrl.searchParams.get('uid') || store.currentUid || store.accounts?.[0]?.uid;
      if (!activeId) return sendJson(res, { ok: false, msg: '缺少 activeId' });
      const info = (await CXProtocol.getActiveInfoWeb(activeId, uid)) || {};
      const otherId = Number(info.otherId ?? 0);
      const signTypeMap = { 0: 'normal', 2: 'qrCode', 3: 'pattern', 4: 'location', 5: 'code' };
      const signType = signTypeMap[otherId] || 'normal';
      let contentObj = {};
      if (info.content && typeof info.content === 'string') {
        try { contentObj = JSON.parse(info.content); } catch (_) {}
      }
      const needPhoto = info.ifphoto === 1 || info.ifPhoto === 1;
      const needLocation =
        signType === 'location' ||
        info.ifopenAddress === 1 ||
        contentObj.ifopenAddress === 1 ||
        Boolean(info.locationText || contentObj.locationText);

      // 解析教师要求位置坐标（转为 WGS-84 供 Leaflet 地图与位置签到框直接填入）
      const parseValidCoord = (...vals) => {
        for (const v of vals) {
          if (v === undefined || v === null || v === '') continue;
          const num = Number(v);
          if (!Number.isNaN(num) && num !== 0 && num !== -1) return num;
        }
        return null;
      };
      let requiredLatitude = null;
      let requiredLongitude = null;
      const gdLat = parseValidCoord(info.locationLatitude_gd, contentObj.locationLatitude_gd);
      const gdLng = parseValidCoord(info.locationLongitude_gd, contentObj.locationLongitude_gd);
      const bdLat = parseValidCoord(info.locationLatitude, contentObj.locationLatitude, info.latitude);
      const bdLng = parseValidCoord(info.locationLongitude, contentObj.locationLongitude, info.longitude);
      if (gdLat !== null && gdLng !== null) {
        const wgs = CXProtocol.gcj02ToWgs84(gdLat, gdLng);
        requiredLatitude = Number(wgs.lat.toFixed(6));
        requiredLongitude = Number(wgs.lng.toFixed(6));
      } else if (bdLat !== null && bdLng !== null) {
        const wgs = CXProtocol.bd09ToWgs84(bdLat, bdLng);
        requiredLatitude = Number(wgs.lat.toFixed(6));
        requiredLongitude = Number(wgs.lng.toFixed(6));
      }

      // 查询已签到人数与班级总人数
      const resolvedCourseId = String(courseIdParam || info.courseId || '');
      const resolvedClassId = String(classIdParam || info.clazzid || info.classId || '');
      const stats = await CXProtocol.getSignAttendStats(activeId, resolvedCourseId, resolvedClassId, uid);

      return sendJson(res, {
        ok: true,
        activeId,
        signType,
        needPhoto,
        needLocation,
        numberCount: Number(info.numberCount || 4),
        designatedPlace: info.locationText || contentObj.locationText || '',
        locationRange: String(info.locationRange || contentObj.locationRange || ''),
        requiredLatitude,
        requiredLongitude,
        requiredBdLat: bdLat !== null ? bdLat : null,
        requiredBdLng: bdLng !== null ? bdLng : null,
        signedCount: stats.signedCount,
        totalCount: stats.totalCount,
        signRatio: stats.signRatio,
      });
    }

    // 6. 常用位置预设池（全局公用，标注创建者） & 地图选点搜索/逆地理编码
    if (pathname === '/api/locations/presets' && req.method === 'POST') {
      const body = await readBodyJson(req);
      const { action, preset, id } = body;
      const actorName = currentSess?.username || ensurePanelAuthStore().username || 'ishit';
      const isAdmin = !currentSess || currentSess.role === 'admin';
      store.locationPresets = store.locationPresets || [];
      if (action === 'add' && preset) {
        const newPreset = {
          id: preset.id || `preset_${Date.now()}`,
          name: preset.name || preset.address || '常用地点',
          address: preset.address || preset.name || '',
          latitude: Number(preset.latitude || 30.8328),
          longitude: Number(preset.longitude || 121.5035),
          createdBy: actorName,
        };
        store.locationPresets.unshift(newPreset);
      } else if (action === 'update' && preset && (preset.id || id)) {
        const targetId = String(preset.id || id);
        const idx = store.locationPresets.findIndex((p) => String(p.id) === targetId);
        if (idx >= 0) {
          const prev = store.locationPresets[idx];
          if (!isAdmin && prev.createdBy && prev.createdBy !== actorName) {
            return sendJson(res, { ok: false, msg: `仅创建者 (${prev.createdBy}) 或管理员可编辑该预设` }, 403);
          }
          store.locationPresets[idx] = {
            ...prev,
            name: preset.name !== undefined ? String(preset.name).trim() || prev.name : prev.name,
            address: preset.address !== undefined ? String(preset.address).trim() || prev.address : prev.address,
            latitude: preset.latitude !== undefined && preset.latitude !== '' ? Number(preset.latitude) : prev.latitude,
            longitude: preset.longitude !== undefined && preset.longitude !== '' ? Number(preset.longitude) : prev.longitude,
            createdBy: prev.createdBy || actorName,
          };
        }
      } else if (action === 'delete' && id) {
        const target = store.locationPresets.find((p) => String(p.id) === String(id));
        if (target && !isAdmin && target.createdBy && target.createdBy !== actorName) {
          return sendJson(res, { ok: false, msg: `仅创建者 (${target.createdBy}) 或管理员可删除该预设` }, 403);
        }
        store.locationPresets = store.locationPresets.filter((p) => p.id !== id);
      }
      saveStore();
      return sendJson(res, { ok: true, locationPresets: store.locationPresets });
    }

    if (pathname === '/api/geo/search' && req.method === 'GET') {
      const q = (parsedUrl.searchParams.get('q') || '').trim();
      if (!q) return sendJson(res, { ok: true, list: [] });

      const seen = new Set();
      const results = [];
      const pushItem = (name, address, lat, lng) => {
        const latitude = Number(lat);
        const longitude = Number(lng);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
        const key = `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
        if (seen.has(key)) return;
        seen.add(key);
        results.push({
          name: String(name || address || q).trim(),
          address: String(address || name || q).trim(),
          latitude,
          longitude,
        });
      };

      // 1. 优先匹配本地常用位置预设
      for (const p of store.locationPresets || []) {
        if ((p.name && p.name.includes(q)) || (p.address && p.address.includes(q)) || q.includes(p.name || '')) {
          pushItem(p.name, p.address, p.latitude, p.longitude);
        }
      }

      // 2. Photon (Komoot OSM) 多策略检索（支持中文连写自动分词）
      const parsePhotonFeatures = (features) => {
        if (!Array.isArray(features)) return;
        for (const f of features) {
          const coords = f?.geometry?.coordinates;
          const props = f?.properties || {};
          if (!Array.isArray(coords) || coords.length < 2) continue;
          const name = props.name || props.street || props.district || props.city || q;
          const addrParts = [props.country, props.state, props.city, props.district, props.street, props.housenumber, props.name]
            .filter(Boolean);
          const uniqueParts = [];
          for (const part of addrParts) {
            if (!uniqueParts.includes(part)) uniqueParts.push(part);
          }
          const address = uniqueParts.join('') || name;
          pushItem(name, address, coords[1], coords[0]);
        }
      };

      const tokenizeChineseQuery = (str) =>
        String(str || '')
          .replace(/(省|市|区|县|镇|乡|街道|路|街|道|巷|弄|号|校区|大学|学院|学校|大厦|广场|中心|公园|站|馆|楼|室)/g, '$1 ')
          .replace(/\s+/g, ' ')
          .trim();

      const queryPhoton = async (kw) => {
        if (!kw) return;
        const data = await fetchJsonUrl(`https://photon.komoot.io/api/?q=${encodeURIComponent(kw)}&limit=8`).catch(() => null);
        if (data && Array.isArray(data.features)) {
          parsePhotonFeatures(data.features);
        }
      };

      await queryPhoton(q);
      const tokenized = tokenizeChineseQuery(q);
      if (results.length < 3 && tokenized && tokenized !== q) {
        await queryPhoton(tokenized);
      }

      // 3. 百度地图 POI 联想兜底（专门解决国内复合门牌号、教学楼简称等）
      if (results.length < 3) {
        const bdSug = await fetchJsonUrl(`https://map.baidu.com/su?wd=${encodeURIComponent(q)}&cid=1&type=0`).catch(() => null);
        if (bdSug && Array.isArray(bdSug.s)) {
          for (const item of bdSug.s.slice(0, 3)) {
            const parts = String(item).split('$');
            const city = parts[0] || '';
            const district = parts[1] || '';
            const poiName = parts[3] || '';
            const candidate = `${city} ${district} ${poiName}`.trim();
            if (candidate) {
              await queryPhoton(candidate);
              if (results.length >= 6) break;
            }
          }
        }
      }

      // 4. Nominatim 最终兜底
      if (results.length === 0) {
        const data = await fetchJsonUrl(
          `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=6&accept-language=zh-CN`
        ).catch(() => null);
        if (Array.isArray(data)) {
          for (const item of data) {
            pushItem(item.display_name.split(',')[0], item.display_name, item.lat, item.lon);
          }
        }
      }

      return sendJson(res, { ok: true, list: results.slice(0, 8) });
    }

    if (pathname === '/api/geo/reverse' && req.method === 'GET') {
      const lat = Number(parsedUrl.searchParams.get('lat') || 0);
      const lng = Number(parsedUrl.searchParams.get('lng') || 0);
      let address = '';

      // 1. Photon 逆地理编码（国内直连 ~200ms）
      const photonData = await fetchJsonUrl(
        `https://photon.komoot.io/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}`
      ).catch(() => null);
      if (photonData && Array.isArray(photonData.features) && photonData.features[0]) {
        const props = photonData.features[0].properties || {};
        const addrParts = [props.state, props.city, props.district, props.street, props.housenumber, props.name].filter(Boolean);
        const uniqueParts = [];
        for (const part of addrParts) {
          if (!uniqueParts.includes(part)) uniqueParts.push(part);
        }
        address = uniqueParts.join('');
      }

      // 2. Nominatim 兜底
      if (!address) {
        const data = await fetchJsonUrl(
          `https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&accept-language=zh-CN`
        ).catch(() => null);
        if (data?.display_name) address = data.display_name;
      }

      return sendJson(res, {
        ok: true,
        address: address || `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
      });
    }

    // 7. 防作弊滑块验证码拉取与校验重签
    if (pathname === '/api/captcha/get' && req.method === 'GET') {
      const key = parsedUrl.searchParams.get('key') || '';
      const uid = parsedUrl.searchParams.get('uid') || store.currentUid || store.accounts?.[0]?.uid;
      if (key && store.pendingCaptchas?.[key]) {
        const item = store.pendingCaptchas[key];
        const fresh = await CXProtocol.getSlideCaptcha(item.uid);
        if (fresh) item.captcha = fresh;
        saveStore();
        return sendJson(res, { ok: true, pending: item });
      }
      const cap = await CXProtocol.getSlideCaptcha(uid);
      return sendJson(res, { ok: Boolean(cap), captcha: cap });
    }

    if (pathname === '/api/captcha/verify' && req.method === 'POST') {
      const body = await readBodyJson(req);
      const { key, xValue } = body;
      const item = store.pendingCaptchas?.[key];
      if (!item || !item.captcha) return sendJson(res, { ok: false, msg: '验证会话不存在或已过期' });

      const validate = await CXProtocol.submitSlideCaptcha({
        userId: item.uid,
        xValue: Number(xValue),
        token: item.captcha.token,
        iv: item.captcha.iv,
        timestamp: item.captcha.timestamp,
        referer: item.captcha.referer,
      });

      if (!validate) {
        const fresh = await CXProtocol.getSlideCaptcha(item.uid);
        item.captcha = fresh;
        saveStore();
        return sendJson(res, { ok: false, msg: '滑块位置未对齐，已刷新图片，请重试', pending: item });
      }

      // 校验通过，立即携带 validate (和 enc2) 重新执行签到
      delete store.pendingCaptchas[key];
      saveStore();

      const relatedHs = (store.helperSessions || []).find(
        (s) => !s.completed && String(s.activeId) === String(item.activeId) && Array.isArray(s.targetUids) && s.targetUids.length > 0
      );
      const captchaTargetUids = relatedHs ? relatedHs.targetUids : [item.uid];
      const record = await executeSignForActive({
        courseId: item.courseId,
        classId: item.classId,
        cpi: item.cpi,
        courseName: item.courseName,
        activeId: item.activeId,
        activeName: item.activeName,
        targetUids: captchaTargetUids,
        signCode: item.signCode,
        enc: item.enc,
        enc2: item.enc2,
        validate,
        address: item.address,
        latitude: item.latitude,
        longitude: item.longitude,
        objectId: item.objectId,
        triggerSource: '滑块验证通过重签',
      });
      return sendJson(res, { ok: true, validate, record });
    }

    // 8. 快速签到与手动详细签到（Admin 快速签到全部账号，User 仅快速签到自己绑定的账号）
    if (pathname === '/api/sign/quick' && req.method === 'POST') {
      const body = await readBodyJson(req);
      const isAdmin = !currentSess || currentSess.role === 'admin';
      const actorName = currentSess?.username || ensurePanelAuthStore().username || 'ishit';
      let onlyUids = null;
      if (!isAdmin) {
        const myAccs = (store.accounts || []).filter((a) => a && a.ownerUsername === actorName);
        if (myAccs.length === 0) {
          return sendJson(res, { ok: false, msg: '您尚未绑定学习通账号，请先在「系统设置 -> 学习通账号」中登录' });
        }
        onlyUids = myAccs.map((a) => String(a.uid));
      }
      const resData = await pollCoursesOnce({
        forceAll: Boolean(body.forceAll),
        triggerSource: isAdmin ? '快速扫描签到(全部账号)' : `快速扫描签到(${actorName})`,
        onlyUids,
        actorUsername: actorName,
      });
      return sendJson(res, { ok: true, ...resData });
    }

    if (pathname === '/api/sign/execute' && req.method === 'POST') {
      const body = await readBodyJson(req);
      const isAdmin = !currentSess || currentSess.role === 'admin';
      const actorName = currentSess?.username || ensurePanelAuthStore().username || 'ishit';
      const myOwnedUids = !isAdmin
        ? (store.accounts || []).filter((a) => a && a.ownerUsername === actorName).map((a) => String(a.uid))
        : null;
      const effectiveTargetUids = !isAdmin
        ? (myOwnedUids && myOwnedUids.length > 0 ? myOwnedUids : ['__none__'])
        : (body.targetUids || null);
      const record = await executeSignForActive({
        courseId: body.courseId,
        classId: body.classId,
        cpi: body.cpi || '',
        courseName: body.courseName || '课程',
        activeId: body.activeId,
        activeName: body.activeName || '签到',
        targetUids: effectiveTargetUids,
        signCode: body.signCode || null,
        enc: body.enc || null,
        qrUrl: body.qrUrl || null,
        address: body.address || null,
        latitude: body.latitude !== undefined && body.latitude !== '' ? Number(body.latitude) : null,
        longitude: body.longitude !== undefined && body.longitude !== '' ? Number(body.longitude) : null,
        objectId: body.objectId || null,
        triggerSource: body.triggerSource || '手动签到',
      });
      return sendJson(res, { ok: true, record });
    }

    // 9. 请求帮忙 (合并多账号协助链接)
    if (pathname === '/api/helper/create' && req.method === 'POST') {
      const body = await readBodyJson(req);
      const mode = body.mode || 'sign';
      const matchedAccs = mode === 'sign'
        ? findMatchingAccountsForClass(body.courseId || '', body.classId || '', body.targetUids)
        : [];
      const mergedUids = matchedAccs.map((a) => a.uid);
      const mergedNames = matchedAccs.map((a) => a.name || a.uid);
      const mergedNamesStr = mergedNames.join('/');

      const autoTitle =
        mode === 'login'
          ? '协助添加学习通账号'
          : mergedNamesStr
          ? `帮 ${mergedNamesStr} 签到《${body.courseName || '课程'}》`
          : `协助签到《${body.courseName || '课程'}》`;

      if (mode === 'login' && currentSess && currentSess.role !== 'admin') {
        const check = canActorBindCxAccount({ username: currentSess.username, role: currentSess.role }, '__new__');
        if (!check.allowed) {
          return sendJson(res, { ok: false, msg: check.msg }, 403);
        }
      }
      const hs = createHelperSession({
        mode,
        title: body.title && !body.title.startsWith('协助签到') ? body.title : autoTitle,
        courseId: body.courseId || '',
        classId: body.classId || '',
        cpi: body.cpi || '',
        courseName: body.courseName || '',
        activeId: body.activeId || '',
        activeName: body.activeName || '',
        signType: body.signType || 'normal',
        targetUids: mergedUids,
        targetNames: mergedNames,
        captchaKey: body.captchaKey || null,
        creatorUsername: currentSess?.username || ensurePanelAuthStore().username || 'ishit',
        creatorRole: currentSess?.role || 'admin',
      });
      let rawPublicBase = String(store.napcat?.publicBaseUrl || 'https://ishit.pw').trim();
      if (!rawPublicBase || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/.*)?$/i.test(rawPublicBase)) {
        rawPublicBase = 'https://ishit.pw';
      } else if (!/^https?:\/\//i.test(rawPublicBase)) {
        rawPublicBase = `https://${rawPublicBase}`;
      }
      rawPublicBase = rawPublicBase.replace(/^http:\/\/ishit\.pw\b/i, 'https://ishit.pw');
      const base = rawPublicBase.replace(/\/+$/, '');
      const shareUrl = `${base}/?help=${hs.token}`;

      let napcatResult = null;
      if (body.broadcastToNapCat) {
        const finalNames = (hs.targetNames && hs.targetNames.length > 0 ? hs.targetNames.join('/') : mergedNamesStr);
        napcatResult = await broadcastNapCat(
          `[学习通签到求助]\n事项：${hs.title}\n${finalNames ? `待签账号：${finalNames}\n` : ''}${hs.courseName ? `课程：${hs.courseName}\n` : ''}合并协助链接：${shareUrl}`,
          {
            force: true,
            eventType: 'help_request',
            eventData: {
              title: hs.title,
              targetUids: hs.targetUids || [],
              targetNames: finalNames,
              courseName: hs.courseName,
              activeName: hs.activeName,
              signType: hs.signType,
              shareUrl,
              helperShareUrl: shareUrl,
            },
          }
        );
      }
      return sendJson(res, { ok: true, session: hs, shareUrl, napcatResult });
    }

    if (pathname === '/api/bounties/sync' && req.method === 'POST') {
      await syncActiveBountiesNow({ force: true });
      const pa = ensurePanelAuthStore();
      const isAdmin = !currentSess || currentSess.role === 'admin';
      const currentUsername = currentSess ? currentSess.username : (pa.username || 'ishit');
      const myOwnedAccounts = (store.accounts || []).filter((a) => a && a.ownerUsername === currentUsername);
      const myOwnedUids = myOwnedAccounts.map((a) => String(a.uid));
      const myCourseNames = new Set();
      const myCourseIds = new Set();
      const myClassIds = new Set();
      for (const acc of myOwnedAccounts) {
        const eff = getEffectiveUserProfile(acc.uid);
        for (const c of eff?.coursesCache || []) {
          const cn = c.name || c.courseName;
          if (cn) myCourseNames.add(String(cn));
          if (c.courseId) myCourseIds.add(String(c.courseId));
          if (c.classId) myClassIds.add(String(c.classId));
        }
      }
      return sendJson(res, {
        ok: true,
        bounties: getActiveBountiesForUser({ myCourseIds, myClassIds, myCourseNames, myOwnedUids }),
        leaderboard: getFormattedLeaderboard(),
        bountyHistory: getFormattedBountyHistory(),
        isAdmin,
      });
    }

    if (pathname === '/api/helper/leaderboard' && req.method === 'GET') {
      return sendJson(res, { ok: true, leaderboard: getFormattedLeaderboard() });
    }

    if (pathname === '/api/helper/uploadImage' && req.method === 'POST') {
      const body = await readBodyJson(req);
      const raw = String(body.base64Image || body.image || '').trim();
      if (!raw) {
        return sendJson(res, { ok: false, msg: '未接收到图片数据' }, 400);
      }
      const match = raw.match(/^data:image\/(jpeg|jpg|png|webp|gif);base64,([A-Za-z0-9+/=\r\n]+)$/i);
      let ext = 'jpg';
      let b64 = raw;
      if (match) {
        ext = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
        b64 = match[2];
      } else {
        b64 = raw.replace(/^data:[^;]+;base64,/i, '');
      }
      const buf = Buffer.from(b64, 'base64');
      if (!buf || buf.length < 32) {
        return sendJson(res, { ok: false, msg: '图片数据无效' }, 400);
      }
      if (buf.length > 8 * 1024 * 1024) {
        return sendJson(res, { ok: false, msg: '图片不能超过 8MB' }, 400);
      }
      fs.mkdirSync(COMMENT_IMAGES_DIR, { recursive: true });
      const randId = Math.random().toString(36).slice(2, 10);
      const fileName = 'cmt_' + Date.now() + '_' + randId + '.' + ext;
      fs.writeFileSync(path.join(COMMENT_IMAGES_DIR, fileName), buf);
      const imageUrl = '/uploads/comments/' + fileName;
      return sendJson(res, { ok: true, imageUrl, url: imageUrl, fileName });
    }

    if (pathname === '/api/helper/claim' && req.method === 'POST') {
      const body = await readBodyJson(req);
      const resClaim = claimHelperPointsByToken({
        claimToken: body.claimToken || '',
        helperName: body.helperName || '',
        studentId: body.studentId || '',
        commentText: body.commentText || '',
        commentImage: body.commentImage || '',
      });
      if (!resClaim.ok) return sendJson(res, resClaim, 400);
      return sendJson(res, {
        ...resClaim,
        leaderboard: getFormattedLeaderboard(),
        bountyHistory: getFormattedBountyHistory(),
      });
    }

    if (pathname === '/api/helper/info' && req.method === 'GET') {
      const token = parsedUrl.searchParams.get('token') || '';
      const hs = getHelperSession(token);
      if (!hs) return sendJson(res, { ok: false, msg: '协助链接已过期或签到已结束' }, 404);
      // 打开协助页时顺带刷新一次该活动的最新状态
      await syncActiveBountiesNow({ force: false }).catch(() => {});
      const pendingCaptcha = hs.captchaKey ? store.pendingCaptchas?.[hs.captchaKey] : null;
      let loggedInHelperAccount = null;
      if (currentSess) {
        if (currentSess.role === 'admin') {
          loggedInHelperAccount =
            (store.accounts || []).find((a) => a.ownerUsername === currentSess.username) ||
            (store.accounts || []).find((a) => String(a.uid) === String(store.currentUid)) ||
            store.accounts?.[0] ||
            null;
        } else {
          loggedInHelperAccount = (store.accounts || []).find((a) => a.ownerUsername === currentSess.username) || null;
        }
      }
      return sendJson(res, {
        ok: true,
        session: hs,
        pendingCaptcha,
        locationPresets: store.locationPresets || [],
        helperLoggedIn: Boolean(currentSess),
        helperPrimaryAccount: loggedInHelperAccount
          ? {
              uid: loggedInHelperAccount.uid,
              name: loggedInHelperAccount.name,
              studentId: loggedInHelperAccount.studentId || '',
              school: loggedInHelperAccount.school || '',
              avatar: loggedInHelperAccount.avatar || '',
            }
          : null,
      });
    }

    if (pathname === '/api/helper/submit' && req.method === 'POST') {
      const body = await readBodyJson(req);
      const hs = getHelperSession(body.token);
      if (!hs) return sendJson(res, { ok: false, msg: '协助链接已过期或该签到已截止' }, 404);

      if (hs.mode === 'sign' || hs.mode === 'captcha') {
        // 仅针对当前仍未签上的同学发起签到（或全量兜底校验），绝不漏掉失败重试者
        const retryOnly = Boolean(body.retryFailedOnly);
        const submitTargets =
          retryOnly && Array.isArray(hs.pendingUids) && hs.pendingUids.length > 0
            ? hs.pendingUids
            : hs.targetUids;

        // 识别登录态辅助主账号
        let helperAcc = null;
        if (currentSess) {
          if (currentSess.role === 'admin') {
            helperAcc =
              (body.helperUid && (store.accounts || []).find((a) => String(a.uid) === String(body.helperUid))) ||
              (store.accounts || []).find((a) => a.ownerUsername === currentSess.username) ||
              (store.accounts || []).find((a) => String(a.uid) === String(store.currentUid)) ||
              store.accounts?.[0] ||
              null;
          } else {
            helperAcc = (store.accounts || []).find((a) => a.ownerUsername === currentSess.username) || null;
          }
        }

        const displayHelper = String(body.helperName || helperAcc?.name || currentSess?.username || '热心同学').trim();
        const record = await executeSignForActive({
          courseId: hs.courseId,
          classId: hs.classId,
          cpi: hs.cpi,
          courseName: hs.courseName || '协助课程',
          activeId: hs.activeId,
          activeName: hs.activeName || '协助签到',
          targetUids: submitTargets,
          signCode: body.signCode || null,
          enc: body.enc || null,
          qrUrl: body.qrUrl || null,
          address: body.address || null,
          latitude: body.latitude !== undefined && body.latitude !== '' && body.latitude !== null ? Number(body.latitude) : null,
          longitude: body.longitude !== undefined && body.longitude !== '' && body.longitude !== null ? Number(body.longitude) : null,
          triggerSource: `悬赏互助(${displayHelper})`,
        });

        // 合并更新本悬赏会话的成功/未成功名单（只有全部签上才关闭悬赏，部分失败允许继续一键重试！）
        const prevSucceededSet = new Set((hs.succeededUids || []).map(String));
        const prevCreditedSet = new Set((hs.creditedUids || []).map(String));
        const newlyCreditedUsers = [];

        for (const r of record.results || []) {
          const rUid = String(r.uid);
          if (r.ok) {
            prevSucceededSet.add(rUid);
            // 只有真正因本次互助签成功（或首次确认成功且未计过分、排除本人自签可选但题目规定根据签到成功人数加分，签失败不算，重试成功才算）
            if (!r.already && !prevCreditedSet.has(rUid)) {
              prevCreditedSet.add(rUid);
              newlyCreditedUsers.push(r);
            }
          }
        }

        const allTargetUids = (hs.targetUids || []).map(String);
        const remainingUids = allTargetUids.filter((u) => !prevSucceededSet.has(u));
        const remainingNames = remainingUids.map(
          (u) => (store.accounts || []).find((a) => String(a.uid) === u)?.name || u
        );
        const allSucceededNames = Array.from(prevSucceededSet).map(
          (u) => (store.accounts || []).find((a) => String(a.uid) === u)?.name || u
        );

        hs.creditedUids = Array.from(prevCreditedSet);
        hs.succeededUids = Array.from(prevSucceededSet);
        hs.succeededNames = allSucceededNames;
        hs.pendingUids = remainingUids;
        hs.pendingNames = remainingNames;
        hs.completed = remainingUids.length === 0 && prevSucceededSet.size > 0;
        hs.updatedAt = Date.now();
        hs.lastResult = record;

        const totalCreditedUids = Array.from(prevCreditedSet);
        const totalCreditedNames = totalCreditedUids.map(
          (u) => (store.accounts || []).find((a) => String(a.uid) === u)?.name || u
        );
        // 只有确保全部目标同学安全签上（remainingUids.length === 0）后，才统一结算加分与弹出签后留言
        const earnedPoints = hs.completed ? totalCreditedUids.length : 0;
        const pendingPoints = !hs.completed ? totalCreditedUids.length : 0;
        const isLoggedInHelper = Boolean(currentSess);
        const lockedHelperName = String(helperAcc?.name || currentSess?.username || '').trim();
        const lockedHelperSid = String(helperAcc?.studentId || helperAcc?.uid || currentSess?.username || '').trim();
        let autoCredited = false;
        let creditedEntry = null;
        let claimToken = '';

        if (hs.completed && !hs.rewardSettled) {
          hs.rewardSettled = true;
          claimToken = EncryptionUtil.getUniqueId();
          hs.claimToken = claimToken;
          store.helperClaims = store.helperClaims || {};
          const explicitSid = String(body.studentId || '').trim();
          const finalHelpedNames = totalCreditedNames.length > 0 ? totalCreditedNames : allSucceededNames;
          if (isLoggedInHelper || helperAcc || explicitSid) {
            // 已登录 ISHIT 账号：填名区域默认锁定为自己，积分自动归入自己名下
            const targetSid = explicitSid || lockedHelperSid;
            const targetName = lockedHelperName || String(body.helperName || targetSid).trim();
            if (earnedPoints > 0 && targetSid) {
              creditedEntry = creditHelperPointsToStudent({
                studentId: targetSid,
                helperName: targetName,
                cxAccount: helperAcc,
                points: earnedPoints,
                activeId: hs.activeId,
                courseName: hs.courseName,
              });
              autoCredited = Boolean(creditedEntry);
            } else {
              autoCredited = true;
            }
            store.helperClaims[claimToken] = {
              claimToken,
              points: earnedPoints,
              activeId: hs.activeId,
              courseName: hs.courseName,
              helpedNames: finalHelpedNames,
              createdAt: Date.now(),
              claimed: true,
              autoCredited: true,
              lockedIdentity: isLoggedInHelper,
              claimedByStudentId: String(targetSid),
              claimedByName: String(creditedEntry?.displayName || targetName),
            };
          } else {
            // 未登录 ISHIT -> 生成事后认领与留言凭证
            store.helperClaims[claimToken] = {
              claimToken,
              points: earnedPoints,
              activeId: hs.activeId,
              courseName: hs.courseName,
              helpedNames: finalHelpedNames,
              createdAt: Date.now(),
              claimed: earnedPoints === 0,
              autoCredited: false,
              lockedIdentity: false,
            };
          }

          // 写入【签到悬赏 - 完成记录】（全部同学安全后统一生成一条完整记录）
          if (finalHelpedNames.length > 0) {
            store.bountyHistory = Array.isArray(store.bountyHistory) ? store.bountyHistory : [];
            store.bountyHistory.unshift({
              id: claimToken,
              claimToken,
              timeMs: Date.now(),
              courseId: hs.courseId || '',
              classId: hs.classId || '',
              courseName: hs.courseName || '协助课程',
              activeId: hs.activeId || '',
              activeName: hs.activeName || '课堂签到',
              signType: hs.signType || 'normal',
              helperName: isLoggedInHelper
                ? (creditedEntry?.displayName || lockedHelperName || '已登录同学')
                : (String(body.helperName || '').trim() || '热心同学'),
              helperCxName: helperAcc?.name || creditedEntry?.cxName || '',
              helperStudentId: isLoggedInHelper ? lockedHelperSid : (creditedEntry?.studentId || ''),
              helperAvatar: creditedEntry?.avatar || helperAcc?.avatar || (helperAcc?.uid ? `https://photo.chaoxing.com/p/${helperAcc.uid}_80` : ''),
              isLoggedInHelper,
              signedNames: allSucceededNames.length > 0 ? allSucceededNames : finalHelpedNames,
              earnedPoints,
              pointsClaimed: Boolean(isLoggedInHelper || autoCredited),
              commentText: '',
              commentImage: '',
            });
            if (store.bountyHistory.length > 100) store.bountyHistory.length = 100;
          }
        } else if (hs.completed && hs.rewardSettled && hs.claimToken) {
          claimToken = hs.claimToken;
          const existingClaim = store.helperClaims?.[claimToken];
          if (existingClaim) {
            autoCredited = Boolean(existingClaim.autoCredited);
          }
        }

        saveStore();
        return sendJson(res, {
          ok: true,
          record,
          session: hs,
          allSafe: Boolean(hs.completed),
          earnedPoints,
          pendingPoints,
          autoCredited,
          creditedEntry,
          claimToken,
          helperLoggedIn: isLoggedInHelper,
          lockedHelperInfo: isLoggedInHelper
            ? {
                name: creditedEntry?.displayName || lockedHelperName || currentSess?.username || '',
                studentId: lockedHelperSid,
              }
            : null,
          remainingCount: remainingUids.length,
          remainingNames,
          allSucceededNames,
        });
      }
      return sendJson(res, { ok: false, msg: '不支持的协助模式' });
    }

    // 10. 轮询参数（Admin 与 User 均可配置自己的轮询模式、频率与防钓鱼参数）与 NapCat 保存
    if (pathname === '/api/schedule' && req.method === 'POST') {
      const body = await readBodyJson(req);
      const isAdmin = !currentSess || currentSess.role === 'admin';
      const currentUsername = currentSess ? currentSess.username : (ensurePanelAuthStore().username || 'ishit');

      // 提取合法轮询配置字段
      const patch = {};
      if (body.masterEnabled !== undefined) patch.masterEnabled = Boolean(body.masterEnabled);
      if (body.forcePolling !== undefined) patch.forcePolling = Boolean(body.forcePolling);
      if (body.intervalSeconds !== undefined) patch.intervalSeconds = Math.max(3, Math.min(300, Number(body.intervalSeconds || 15)));
      if (body.signThresholdEnabled !== undefined) patch.signThresholdEnabled = Boolean(body.signThresholdEnabled);
      if (body.signThresholdRatio !== undefined) patch.signThresholdRatio = Math.max(0.01, Math.min(0.99, Number(body.signThresholdRatio || 0.3)));

      store.userScheduleConfigs = store.userScheduleConfigs || {};

      if (!isAdmin) {
        // User 账号保存自己的独立轮询设置
        const prev = getEffectiveScheduleForPanelUser(currentUsername);
        store.userScheduleConfigs[currentUsername] = { ...prev, ...patch };
        saveStore();
        restartScheduler();
        return sendJson(res, {
          ok: true,
          schedule: store.userScheduleConfigs[currentUsername],
          engine: getEngineState(),
        });
      }

      // Admin 账号：若当前选中的学习通账号归属于某个 User，同步更新该 User 的轮询配置；同时更新全局默认与 Admin 自身配置
      const targetUid = body.uid || '';
      const targetAcc = targetUid ? (store.accounts || []).find((a) => String(a.uid) === String(targetUid)) : null;
      const targetOwner = targetAcc?.ownerUsername || currentUsername;
      if (targetOwner && targetOwner !== currentUsername && store.userScheduleConfigs[targetOwner]) {
        store.userScheduleConfigs[targetOwner] = {
          ...getEffectiveScheduleForPanelUser(targetOwner),
          ...patch,
        };
      }
      store.schedule = { ...store.schedule, ...patch };
      store.userScheduleConfigs[currentUsername] = { ...store.schedule };
      saveStore();
      restartScheduler();
      return sendJson(res, {
        ok: true,
        schedule: targetAcc ? getEffectiveScheduleForCxUid(targetUid) : store.schedule,
        engine: getEngineState(),
      });
    }

    // Admin 专属：签到悬赏系统设置（轮询时长配置、所有签到记录删改、排行榜用户分数编辑与重置）
    if (pathname.startsWith('/api/admin/bounty/')) {
      if (currentSess && currentSess.role !== 'admin') {
        return sendJson(res, { ok: false, msg: '权限不足：仅管理员可管理签到悬赏与全量记录' }, 403);
      }
      store.bountyConfig = store.bountyConfig || { bountySyncSeconds: 2, idleSyncSeconds: 3 };
      store.helperLeaderboard = store.helperLeaderboard || {};
      store.bountyHistory = Array.isArray(store.bountyHistory) ? store.bountyHistory : [];
      store.signHistory = Array.isArray(store.signHistory) ? store.signHistory : [];
      store.helperSessions = Array.isArray(store.helperSessions) ? store.helperSessions : [];

      const buildAdminBountySnapshot = () => {
        const userIntervals = {};
        for (const [uname, ucfg] of Object.entries(store.userScheduleConfigs || {})) {
          if (ucfg && typeof ucfg === 'object') {
            userIntervals[uname] = {
              masterEnabled: ucfg.masterEnabled !== false,
              forcePolling: Boolean(ucfg.forcePolling),
              intervalSeconds: Number(ucfg.intervalSeconds || store.schedule?.intervalSeconds || 25),
            };
          }
        }
        return {
          ok: true,
          polling: {
            globalIntervalSeconds: Number(store.schedule?.intervalSeconds || 25),
            effectiveIntervalSeconds: getEffectiveTimerIntervalSeconds(),
            bountySyncSeconds: Number(store.bountyConfig?.bountySyncSeconds || 2),
            idleSyncSeconds: Number(store.bountyConfig?.idleSyncSeconds || 3),
            userIntervals,
          },
          leaderboard: getFormattedLeaderboard(),
          bountyHistory: store.bountyHistory.slice(0, 100),
          signHistory: store.signHistory.slice(0, 100),
          helperSessions: store.helperSessions.slice(0, 60).map((s) => ({
            token: s.token,
            title: s.title || s.activeName || '签到协助',
            courseName: s.courseName || '',
            activeName: s.activeName || '',
            activeId: s.activeId || '',
            signType: s.signType || 'normal',
            targetNames: s.targetNames || [],
            completed: Boolean(s.completed),
            expired: Boolean(s.expired),
            createdAt: s.createdAt || 0,
            expiresAt: s.expiresAt || 0,
          })),
        };
      };

      if (pathname === '/api/admin/bounty/overview' && req.method === 'GET') {
        return sendJson(res, buildAdminBountySnapshot());
      }

      if (pathname === '/api/admin/bounty/config' && req.method === 'POST') {
        const body = await readBodyJson(req);
        if (body.intervalSeconds !== undefined) {
          const sec = Math.max(3, Math.min(300, Number(body.intervalSeconds || 15)));
          store.schedule = { ...(store.schedule || {}), intervalSeconds: sec };
          if (body.syncAllUsers !== false) {
            store.userScheduleConfigs = store.userScheduleConfigs || {};
            for (const uname of Object.keys(store.userScheduleConfigs)) {
              if (store.userScheduleConfigs[uname] && typeof store.userScheduleConfigs[uname] === 'object') {
                store.userScheduleConfigs[uname].intervalSeconds = sec;
              }
            }
          } else if (currentSess?.username) {
            store.userScheduleConfigs = store.userScheduleConfigs || {};
            store.userScheduleConfigs[currentSess.username] = {
              ...getEffectiveScheduleForPanelUser(currentSess.username),
              intervalSeconds: sec,
            };
          }
        }
        if (body.bountySyncSeconds !== undefined) {
          store.bountyConfig.bountySyncSeconds = Math.max(1, Math.min(60, Number(body.bountySyncSeconds || 3.5)));
        }
        if (body.idleSyncSeconds !== undefined) {
          store.bountyConfig.idleSyncSeconds = Math.max(2, Math.min(120, Number(body.idleSyncSeconds || 3)));
        }
        saveStore();
        restartScheduler(true);
        sysLog('CONF', `[签到悬赏设置] 管理员更新轮询参数: 课程检测=${getEffectiveTimerIntervalSeconds()}s, 悬赏同步=${store.bountyConfig.bountySyncSeconds}s`);
        return sendJson(res, buildAdminBountySnapshot());
      }

      if (pathname === '/api/admin/bounty/leaderboard' && req.method === 'POST') {
        const body = await readBodyJson(req);
        const action = String(body.action || '').trim();

        if (action === 'reset') {
          store.helperLeaderboard = {};
          saveStore();
          sysLog('ADMIN', '[签到大师榜] 管理员已重置排行榜全部积分数据');
          return sendJson(res, buildAdminBountySnapshot());
        }

        if (action === 'delete') {
          const key = String(body.key || body.studentId || '').trim();
          if (key && store.helperLeaderboard[key]) {
            delete store.helperLeaderboard[key];
          } else if (key) {
            for (const [k, v] of Object.entries(store.helperLeaderboard)) {
              if (String(v?.studentId || '') === key || String(v?.key || '') === key) {
                delete store.helperLeaderboard[k];
              }
            }
          }
          saveStore();
          return sendJson(res, buildAdminBountySnapshot());
        }

        if (action === 'upsert') {
          const origKey = String(body.origKey || '').trim();
          const studentId = String(body.studentId || '').trim();
          const displayName = String(body.displayName || '').trim();
          const cxName = String(body.cxName || '').trim();
          const school = String(body.school || '').trim();
          const score = Math.max(0, Number(body.score || 0));
          const assistCount = Math.max(0, Math.floor(Number(body.assistCount || 0)));
          const newKey = studentId || origKey || displayName;
          if (!newKey) {
            return sendJson(res, { ok: false, msg: '学号或用户标识不能为空' }, 400);
          }
          const prev = (origKey && store.helperLeaderboard[origKey]) || store.helperLeaderboard[newKey] || {};
          if (origKey && origKey !== newKey && store.helperLeaderboard[origKey]) {
            delete store.helperLeaderboard[origKey];
          }
          const matchedAcc = (store.accounts || []).find(
            (a) => a && ((studentId && String(a.studentId || '').trim() === studentId) || (prev.boundUid && String(a.uid) === String(prev.boundUid)))
          );
          const namesArr = Array.isArray(body.names)
            ? body.names.map((n) => String(n).trim()).filter(Boolean)
            : Array.isArray(prev.names)
            ? [...prev.names]
            : [];
          if (displayName) {
            const filtered = namesArr.filter((n) => n !== displayName);
            namesArr.length = 0;
            namesArr.push(displayName, ...filtered);
          }
          if (cxName && !namesArr.includes(cxName)) namesArr.push(cxName);

          store.helperLeaderboard[newKey] = {
            ...prev,
            key: newKey,
            studentId: studentId || prev.studentId || '',
            boundUid: String(matchedAcc?.uid || prev.boundUid || ''),
            cxName: cxName || matchedAcc?.name || prev.cxName || displayName || newKey,
            preferredName: displayName || prev.preferredName || cxName || newKey,
            names: namesArr,
            avatar: body.avatar !== undefined ? String(body.avatar) : (matchedAcc?.avatar || prev.avatar || ''),
            school: school || matchedAcc?.school || prev.school || '',
            score,
            assistCount,
            lastAssistAt: prev.lastAssistAt || Date.now(),
            lastCourseName: body.lastCourseName !== undefined ? String(body.lastCourseName) : (prev.lastCourseName || ''),
          };
          saveStore();
          return sendJson(res, buildAdminBountySnapshot());
        }

        return sendJson(res, { ok: false, msg: '未知的排行榜操作' }, 400);
      }

      if (pathname === '/api/admin/bounty/records' && req.method === 'POST') {
        const body = await readBodyJson(req);
        const recordType = String(body.recordType || 'bountyHistory').trim(); // bountyHistory | signHistory | helperSessions
        const action = String(body.action || '').trim();

        if (recordType === 'bountyHistory') {
          if (action === 'clear') {
            store.bountyHistory = [];
            saveStore();
            return sendJson(res, buildAdminBountySnapshot());
          }
          if (action === 'delete') {
            const targetId = String(body.id || body.claimToken || '').trim();
            store.bountyHistory = store.bountyHistory.filter(
              (h) => h && String(h.id || h.claimToken || '') !== targetId
            );
            saveStore();
            return sendJson(res, buildAdminBountySnapshot());
          }
          if (action === 'update') {
            const targetId = String(body.id || body.claimToken || '').trim();
            const rec = store.bountyHistory.find(
              (h) => h && (String(h.id || '') === targetId || String(h.claimToken || '') === targetId)
            );
            if (!rec) return sendJson(res, { ok: false, msg: '未找到该条悬赏完成记录' }, 404);
            if (body.helperName !== undefined) rec.helperName = String(body.helperName).trim();
            if (body.helperStudentId !== undefined) rec.helperStudentId = String(body.helperStudentId).trim();
            if (body.courseName !== undefined) rec.courseName = String(body.courseName).trim();
            if (body.activeName !== undefined) rec.activeName = String(body.activeName).trim();
            if (body.earnedPoints !== undefined) rec.earnedPoints = Math.max(0, Number(body.earnedPoints || 0));
            if (body.pointsClaimed !== undefined) rec.pointsClaimed = Boolean(body.pointsClaimed);
            if (body.commentText !== undefined) rec.commentText = String(body.commentText).slice(0, 500);
            if (body.commentImage !== undefined) rec.commentImage = String(body.commentImage).trim();
            if (body.signedNames !== undefined) {
              rec.signedNames = Array.isArray(body.signedNames)
                ? body.signedNames.map((s) => String(s).trim()).filter(Boolean)
                : String(body.signedNames)
                    .split(/[,，/、\s]+/)
                    .map((s) => s.trim())
                    .filter(Boolean);
            }
            const claimKey = rec.claimToken || rec.id;
            if (claimKey && store.helperClaims && store.helperClaims[claimKey]) {
              if (body.commentText !== undefined) store.helperClaims[claimKey].commentText = rec.commentText;
              if (body.commentImage !== undefined) store.helperClaims[claimKey].commentImage = rec.commentImage;
              if (body.helperName !== undefined) store.helperClaims[claimKey].claimedByName = rec.helperName;
            }
            saveStore();
            return sendJson(res, buildAdminBountySnapshot());
          }
        }

        if (recordType === 'signHistory') {
          if (action === 'clear') {
            store.signHistory = [];
            saveStore();
            return sendJson(res, buildAdminBountySnapshot());
          }
          if (action === 'delete') {
            const targetId = String(body.id || '').trim();
            const idx = Number(body.index);
            if (targetId) {
              store.signHistory = store.signHistory.filter((h) => h && String(h.id || '') !== targetId);
            } else if (Number.isInteger(idx) && idx >= 0 && idx < store.signHistory.length) {
              store.signHistory.splice(idx, 1);
            }
            saveStore();
            return sendJson(res, buildAdminBountySnapshot());
          }
          if (action === 'update') {
            const targetId = String(body.id || '').trim();
            const rec = store.signHistory.find((h) => h && String(h.id || '') === targetId);
            if (!rec) return sendJson(res, { ok: false, msg: '未找到该条系统签到记录' }, 404);
            if (body.courseName !== undefined) rec.courseName = String(body.courseName).trim();
            if (body.activeName !== undefined) rec.activeName = String(body.activeName).trim();
            if (body.signTypeLabel !== undefined) rec.signTypeLabel = String(body.signTypeLabel).trim();
            if (body.triggerSource !== undefined) rec.triggerSource = String(body.triggerSource).trim();
            if (body.time !== undefined) rec.time = String(body.time).trim();
            if (Array.isArray(body.results)) {
              rec.results = body.results.map((r) => ({
                uid: String(r.uid || ''),
                name: String(r.name || ''),
                ok: Boolean(r.ok),
                already: Boolean(r.already),
                msg: String(r.msg || ''),
              }));
            }
            saveStore();
            return sendJson(res, buildAdminBountySnapshot());
          }
        }

        if (recordType === 'helperSessions') {
          if (action === 'clearCompleted') {
            store.helperSessions = store.helperSessions.filter((s) => s && !s.completed && !s.expired);
            saveStore();
            return sendJson(res, buildAdminBountySnapshot());
          }
          if (action === 'clearAll') {
            store.helperSessions = [];
            saveStore();
            return sendJson(res, buildAdminBountySnapshot());
          }
          if (action === 'delete') {
            const tk = String(body.token || '').trim();
            store.helperSessions = store.helperSessions.filter((s) => s && String(s.token || '') !== tk);
            saveStore();
            return sendJson(res, buildAdminBountySnapshot());
          }
          if (action === 'toggleComplete') {
            const tk = String(body.token || '').trim();
            const hs = store.helperSessions.find((s) => s && String(s.token || '') === tk);
            if (hs) {
              hs.completed = Boolean(body.completed);
              saveStore();
            }
            return sendJson(res, buildAdminBountySnapshot());
          }
        }

        return sendJson(res, { ok: false, msg: '不支持的记录管理操作' }, 400);
      }
    }

    if (pathname === '/api/napcat' && req.method === 'POST') {
      if (currentSess && currentSess.role !== 'admin') {
        return sendJson(res, { ok: false, msg: '权限不足：仅管理员可修改 NapCat 设置' }, 403);
      }
      const body = await readBodyJson(req);
      if (body.publicBaseUrl !== undefined) {
        let pb = String(body.publicBaseUrl || '').trim();
        if (!pb) pb = 'https://ishit.pw';
        else if (!/^https?:\/\//i.test(pb)) pb = `https://${pb}`;
        pb = pb.replace(/^http:\/\/ishit\.pw\b/i, 'https://ishit.pw');
        body.publicBaseUrl = pb.replace(/\/+$/, '');
      }
      if (Array.isArray(body.groups)) {
        body.groups = body.groups.map((g) => (String(g).trim() === '1178498159' ? '1134393264' : String(g).trim())).filter(Boolean);
      }
      if (body.groupBindings && body.groupBindings['1178498159'] && !body.groupBindings['1134393264']) {
        body.groupBindings['1134393264'] = body.groupBindings['1178498159'];
        delete body.groupBindings['1178498159'];
      }
      store.napcat = { ...store.napcat, ...body };
      saveStore();
      return sendJson(res, { ok: true, napcat: store.napcat });
    }

    if (pathname === '/api/napcat/test' && req.method === 'POST') {
      if (currentSess && currentSess.role !== 'admin') {
        return sendJson(res, { ok: false, msg: '权限不足：仅管理员可测试 NapCat 推送' }, 403);
      }
      const msg = `[学习通控制端] NapCat 连通测试成功 (${new Date().toLocaleTimeString('zh-CN', { hour12: false })})`;
      const result = await broadcastNapCat(msg, { force: true, eventType: 'test' });
      return sendJson(res, { ok: result.sent, ...result });
    }

    if (pathname === '/api/qr/decode' && req.method === 'POST') {
      const body = await readBodyJson(req);
      const rawB64 = String(body.base64Image || body.image || '').replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
      if (!rawB64) return sendJson(res, { ok: false, msg: '未收到图片数据' });
      const buf = Buffer.from(rawB64, 'base64');
      const qrText = decodeQrFromImageBuffer(buf);
      return sendJson(res, { ok: Boolean(qrText), qrText: qrText || null });
    }

    if (pathname === '/api/napcat/webhook_image' && req.method === 'POST') {
      const body = await readBodyJson(req);
      const img = body.image || body;
      setImmediate(() => {
        processIncomingChatImageItem(img).catch(() => {});
      });
      return sendJson(res, { ok: true });
    }

    return sendJson(res, { ok: false, msg: `Not found: ${pathname}` }, 404);
  } catch (err) {
    sysLog('ERROR', `[${pathname}] ${err.message}`);
    return sendJson(res, { ok: false, msg: err.message }, 500);
  }
});

// 全局异常与退出信号诊断日志，确保任何意外退出都在 app.log 留下完整堆栈
process.on('uncaughtException', (err) => {
  sysLog('FATAL', `未捕获异常 (uncaughtException): ${err?.stack || err?.message || err}`);
});
process.on('unhandledRejection', (reason) => {
  sysLog('FATAL', `未处理的 Promise 拒绝 (unhandledRejection): ${reason?.stack || reason?.message || reason}`);
});
['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((sig) => {
  process.on(sig, () => {
    sysLog('EXIT', `收到系统信号 ${sig}，进程即将退出`);
    process.exit(0);
  });
});

server.listen(PORT, '0.0.0.0', async () => {
  sysLog('BOOT', `服务已启动 http://127.0.0.1:${PORT}`);
  // 启动时若已有登录账号，但未缓存课表，自动拉取一次学习通课表
  for (const acc of store.accounts || []) {
    if (!acc.studentId) {
      try {
        const uInfo = await CXProtocol.fetchUserInfo({ userId: acc.uid });
        if (uInfo?.studentId) {
          acc.studentId = uInfo.studentId;
          saveStore();
        }
      } catch (_) {}
    }
    const prof = ensureUserProfile(acc.uid);
    if (!prof.coursesCache || prof.coursesCache.length === 0) {
      await CXProtocol.getCoursesList(acc.uid);
    }
    if (!prof.curriculumCache) {
      await CXProtocol.fetchCurriculum(acc.uid);
    }
  }
  restartScheduler();
});

