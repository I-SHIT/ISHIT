const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const {
  EncryptionUtil,
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
  broadcastNapCat,
  createHelperSession,
  getHelperSession,
  executeSignForActive,
  findMatchingAccountsForClass,
  processIncomingChatImageItem,
  pollCoursesOnce,
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

function getValidPanelSession(req) {
  const pa = ensurePanelAuthStore();
  if (pa.enabled === false) return { username: pa.username || 'ishit', role: 'admin', bypass: true };
  const cookies = parseReqCookies(req);
  const token = req.headers['x-panel-token'] || cookies.ishit_panel_session || '';
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

function isHelperAuthorizedRoute(req, pathname, parsedUrl) {
  if (pathname === '/api/napcat/webhook_image') return true;
  if (pathname === '/api/helper/info' || pathname === '/api/helper/submit') return true;
  const hToken = req.headers['x-helper-token'] || parsedUrl.searchParams.get('helperToken') || '';
  if (!hToken) return false;
  const hs = getHelperSession(hToken);
  if (!hs) return false;
  if (pathname === '/api/geo/reverse' || pathname === '/api/geo/search' || pathname === '/api/courses/activeInfo') return true;
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
    });
    return res.end();
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = parsedUrl.pathname;

  try {
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
      if (pathname === '/' || pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(path.join(webRoot, 'index.html'), 'utf8'));
      }
    } else if (pathname === '/' || pathname === '/index.html') {
      return sendJson(res, { ok: true, service: 'ISHIT Backend API', version: 'beta', webUrl: 'http://ishit.pw' });
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
    const currentSess = getValidPanelSession(req);
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
      for (const acc of myOwnedAccounts) {
        const eff = getEffectiveUserProfile(acc.uid);
        for (const c of eff?.coursesCache || []) {
          const cn = c.name || c.courseName;
          if (cn) myCourseNames.add(String(cn));
        }
      }

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

      const visibleActives = isAdmin
        ? (engine.lastDetectedActives || [])
        : (engine.lastDetectedActives || []).filter((item) =>
            (item.memberUids || []).some((u) => myOwnedUids.includes(String(u)))
          );

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
        accounts: store.accounts || [],
        userProfile: rawProfile,
        effectiveProfile,
        courses: targetUid ? mergeCoursesForUser(targetUid) : [],
        myOwnedCourses: myOwnedAcc ? mergeCoursesForUser(myOwnedAcc.uid) : [],
        locationPresets: store.locationPresets || [],
        schedule: effectiveSchedule,
        globalSchedule: store.schedule,
        panelAuth: {
          enabled: pa.enabled !== false,
          username: currentUsername,
          role: isAdmin ? 'admin' : 'user',
          activeSessionCount: Object.keys(pa.sessions || {}).length,
          users: sanitizedUsers,
        },
        napcat: isAdmin ? store.napcat : null,
        pendingCaptchas: visibleCaptchas,
        history: visibleHistory,
        logs: visibleLogs,
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
          return sendJson(res, { ok: true, user });
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
          return sendJson(res, { ok: true, user });
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
          return sendJson(res, { ok: true, loggedIn: true, user });
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
        return sendJson(res, { ok: true, accounts: store.accounts, currentUid: store.currentUid });
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
        return sendJson(res, { ok: true, accounts: store.accounts });
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
        return sendJson(res, { ok: true, cachedFaceObjectId: faceObjId, accounts: store.accounts });
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
      const { courseId, pollingEnabled, isTestCourse, testPollingEnabled, location, imageObjectIds } = body;
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
      const q = parsedUrl.searchParams.get('q') || '';
      if (!q) return sendJson(res, { ok: true, list: [] });
      const data = await fetchJsonUrl(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=6&accept-language=zh-CN`
      );
      const list = Array.isArray(data)
        ? data.map((item) => ({
            name: item.display_name.split(',')[0],
            address: item.display_name,
            latitude: Number(item.lat),
            longitude: Number(item.lon),
          }))
        : [];
      return sendJson(res, { ok: true, list });
    }

    if (pathname === '/api/geo/reverse' && req.method === 'GET') {
      const lat = parsedUrl.searchParams.get('lat') || '';
      const lng = parsedUrl.searchParams.get('lng') || '';
      const data = await fetchJsonUrl(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&accept-language=zh-CN`
      );
      return sendJson(res, {
        ok: true,
        address: data?.display_name || `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`,
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

      const record = await executeSignForActive({
        courseId: item.courseId,
        classId: item.classId,
        cpi: item.cpi,
        courseName: item.courseName,
        activeId: item.activeId,
        activeName: item.activeName,
        targetUids: null, // 同班级已签账号自动合并展示，当前账号使用 validate 完成重签
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
      let rawPublicBase = String(store.napcat?.publicBaseUrl || 'http://ishit.pw').trim();
      if (!rawPublicBase || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/.*)?$/i.test(rawPublicBase)) {
        rawPublicBase = 'http://ishit.pw';
      } else if (!/^https?:\/\//i.test(rawPublicBase)) {
        rawPublicBase = `http://${rawPublicBase}`;
      }
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

    if (pathname === '/api/helper/info' && req.method === 'GET') {
      const token = parsedUrl.searchParams.get('token') || '';
      const hs = getHelperSession(token);
      if (!hs) return sendJson(res, { ok: false, msg: '协助链接已过期' }, 404);
      const pendingCaptcha = hs.captchaKey ? store.pendingCaptchas?.[hs.captchaKey] : null;
      return sendJson(res, {
        ok: true,
        session: hs,
        pendingCaptcha,
        locationPresets: store.locationPresets || [],
      });
    }

    if (pathname === '/api/helper/submit' && req.method === 'POST') {
      const body = await readBodyJson(req);
      const hs = getHelperSession(body.token);
      if (!hs) return sendJson(res, { ok: false, msg: '协助链接已过期' }, 404);

      if (hs.mode === 'sign') {
        const record = await executeSignForActive({
          courseId: hs.courseId,
          classId: hs.classId,
          cpi: hs.cpi,
          courseName: hs.courseName || '协助课程',
          activeId: hs.activeId,
          activeName: hs.activeName || '协助签到',
          targetUids: hs.targetUids,
          signCode: body.signCode || null,
          enc: body.enc || null,
          qrUrl: body.qrUrl || null,
          address: body.address || null,
          latitude: body.latitude !== undefined && body.latitude !== '' ? Number(body.latitude) : null,
          longitude: body.longitude !== undefined && body.longitude !== '' ? Number(body.longitude) : null,
          triggerSource: `协助(${body.helperName || '同学'})`,
        });
        hs.completed = record.results.some((r) => r.ok);
        hs.lastResult = record;
        saveStore();
        return sendJson(res, { ok: true, record });
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
      if (body.intervalSeconds !== undefined) patch.intervalSeconds = Math.max(10, Number(body.intervalSeconds || 25));
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

    if (pathname === '/api/napcat' && req.method === 'POST') {
      if (currentSess && currentSess.role !== 'admin') {
        return sendJson(res, { ok: false, msg: '权限不足：仅管理员可修改 NapCat 设置' }, 403);
      }
      const body = await readBodyJson(req);
      if (body.publicBaseUrl !== undefined) {
        let pb = String(body.publicBaseUrl || '').trim();
        if (!pb) pb = 'http://ishit.pw';
        else if (!/^https?:\/\//i.test(pb)) pb = `http://${pb}`;
        body.publicBaseUrl = pb.replace(/\/+$/, '');
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
    const prof = ensureUserProfile(acc.uid);
    if (!prof.curriculumCache) {
      await CXProtocol.fetchCurriculum(acc.uid);
    }
  }
  restartScheduler();
});

