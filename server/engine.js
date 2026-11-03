const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const {
  EncryptionUtil,
  store,
  saveStore,
  getEffectiveUserProfile,
  getEffectiveScheduleForPanelUser,
  getEffectiveScheduleForCxUid,
  sysLog,
  cxRequest,
} = require('./index.js');
const { CXProtocol } = require('./protocol.js');
const jsQR = require('jsqr');
const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');

function fetchRawBuffer(urlStr, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      u,
      {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const nextUrl = res.headers.location.startsWith('http')
            ? res.headers.location
            : new URL(res.headers.location, u.origin).toString();
          return fetchRawBuffer(nextUrl, timeoutMs).then(resolve, reject);
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Image download timeout')));
    req.end();
  });
}

function downsampleRgba(src, srcW, srcH, step) {
  const dstW = Math.max(1, Math.floor(srcW / step));
  const dstH = Math.max(1, Math.floor(srcH / step));
  const dst = new Uint8ClampedArray(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    const sy = y * step;
    for (let x = 0; x < dstW; x++) {
      const sx = x * step;
      const sOff = (sy * srcW + sx) * 4;
      const dOff = (y * dstW + x) * 4;
      dst[dOff] = src[sOff];
      dst[dOff + 1] = src[sOff + 1];
      dst[dOff + 2] = src[sOff + 2];
      dst[dOff + 3] = 255;
    }
  }
  return { rgba: dst, width: dstW, height: dstH };
}

function cropRgba(src, srcW, srcH, x0, y0, cropW, cropH) {
  const dst = new Uint8ClampedArray(cropW * cropH * 4);
  for (let y = 0; y < cropH; y++) {
    const sy = y0 + y;
    for (let x = 0; x < cropW; x++) {
      const sx = x0 + x;
      const sOff = (sy * srcW + sx) * 4;
      const dOff = (y * cropW + x) * 4;
      dst[dOff] = src[sOff];
      dst[dOff + 1] = src[sOff + 1];
      dst[dOff + 2] = src[sOff + 2];
      dst[dOff + 3] = 255;
    }
  }
  return { rgba: dst, width: cropW, height: cropH };
}

function binarizeRgba(src, w, h, factor = 1.0) {
  let sum = 0;
  const n = w * h;
  const lum = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const v = (src[o] * 77 + src[o + 1] * 150 + src[o + 2] * 29) >> 8;
    lum[i] = v;
    sum += v;
  }
  const thresh = (sum / Math.max(1, n)) * factor;
  const dst = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const c = lum[i] < thresh ? 0 : 255;
    const o = i * 4;
    dst[o] = c;
    dst[o + 1] = c;
    dst[o + 2] = c;
    dst[o + 3] = 255;
  }
  return { rgba: dst, width: w, height: h };
}

function decodeQrFromImageBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
  try {
    let width = 0;
    let height = 0;
    let rgba = null;
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      const decoded = jpeg.decode(buf, { useTArray: true, maxResolutionInMP: 36, maxMemoryUsageInMB: 384 });
      width = decoded.width;
      height = decoded.height;
      rgba = new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength);
    } else if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      const decoded = PNG.sync.read(buf);
      width = decoded.width;
      height = decoded.height;
      rgba = new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength);
    } else {
      try {
        const decoded = jpeg.decode(buf, { useTArray: true, maxResolutionInMP: 36, maxMemoryUsageInMB: 384 });
        width = decoded.width;
        height = decoded.height;
        rgba = new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength);
      } catch (_) {}
    }
    if (!rgba || !width || !height) return null;

    // 1. 原图直接识别 (attemptBoth 支持反色屏幕拍照)
    let qr = jsQR(rgba, width, height, { inversionAttempts: 'attemptBoth' });
    if (qr && qr.data) return qr.data.trim();

    // 2. 高清大图降采样识别（手机拍摄大屏二维码摩尔纹/模糊时，2x/3x/4x 降采样识别率大幅提升）
    for (const step of [2, 3, 4]) {
      if (width / step >= 180 && height / step >= 180) {
        const sub = downsampleRgba(rgba, width, height, step);
        qr = jsQR(sub.rgba, sub.width, sub.height, { inversionAttempts: 'attemptBoth' });
        if (qr && qr.data) return qr.data.trim();
        for (const f of [1.0, 0.88, 1.12]) {
          const bin = binarizeRgba(sub.rgba, sub.width, sub.height, f);
          qr = jsQR(bin.rgba, bin.width, bin.height, { inversionAttempts: 'dontInvert' });
          if (qr && qr.data) return qr.data.trim();
        }
      }
    }

    // 3. 多尺度滑窗裁剪 + 亮度均值二值化（针对手机拍电脑/投影屏幕存在蓝光偏色、摩尔纹、二维码偏角或占比较小的情况）
    const side = Math.min(width, height);
    if (side >= 320) {
      for (const s of [0.85, 0.70, 0.55, 0.42]) {
        const cw = Math.floor(side * s);
        const ch = cw;
        if (cw < 200) continue;
        const fyList = s >= 0.8 ? [0.25, 0.35, 0.15, 0.45] : [0.2, 0.35, 0.5, 0.1, 0.65];
        const fxList = s >= 0.8 ? [0.08, 0.15, 0.25] : [0.15, 0.3, 0.45, 0.05];
        for (const fy of fyList) {
          for (const fx of fxList) {
            const x0 = Math.min(width - cw, Math.max(0, Math.floor(width * fx)));
            const y0 = Math.min(height - ch, Math.max(0, Math.floor(height * fy)));
            const patch = cropRgba(rgba, width, height, x0, y0, cw, ch);
            qr = jsQR(patch.rgba, patch.width, patch.height, { inversionAttempts: 'dontInvert' });
            if (qr && qr.data) return qr.data.trim();
            for (const f of [1.0, 0.86, 1.12]) {
              const bin = binarizeRgba(patch.rgba, patch.width, patch.height, f);
              qr = jsQR(bin.rgba, bin.width, bin.height, { inversionAttempts: 'dontInvert' });
              if (qr && qr.data) return qr.data.trim();
            }
          }
        }
      }
    }
  } catch (_) {}
  return null;
}

// ============================================================================
// 1. NapCat (OneBot v11) 联动播报
// ============================================================================
function postJson(urlStr, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = lib.request(
      u,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          ...headers,
        },
        timeout: 8000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const txt = Buffer.concat(chunks).toString('utf8');
          try { resolve({ statusCode: res.statusCode, data: JSON.parse(txt) }); }
          catch (_) { resolve({ statusCode: res.statusCode, data: txt }); }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('NapCat request timeout')));
    req.write(body);
    req.end();
  });
}

function resolveRelatedCxUids(message, eventData = {}) {
  const uidSet = new Set();
  if (Array.isArray(eventData.targetUids)) {
    for (const u of eventData.targetUids) {
      if (u) uidSet.add(String(u).trim());
    }
  }
  if (Array.isArray(eventData.results)) {
    for (const r of eventData.results) {
      if (r && r.uid) uidSet.add(String(r.uid).trim());
    }
  }
  const msgStr = String(message || '');
  const namesStr = String(eventData.targetNames || '');
  for (const acc of store.accounts || []) {
    if (!acc || !acc.uid) continue;
    const uid = String(acc.uid).trim();
    const name = String(acc.name || '').trim();
    if (name && (msgStr.includes(name) || namesStr.includes(name))) {
      uidSet.add(uid);
    } else if (msgStr.includes(uid) || namesStr.includes(uid)) {
      uidSet.add(uid);
    }
  }
  return Array.from(uidSet);
}

function buildGroupAtMessage(baseMessage, groupId, relatedUids, cfg) {
  const bindingsForGroup = (cfg.groupBindings && cfg.groupBindings[String(groupId)]) || {};
  const globalBindings = cfg.accountQqBindings || {};
  const qqSet = new Set();
  for (const uid of relatedUids) {
    const groupList = bindingsForGroup[String(uid)];
    const fallbackList = globalBindings[String(uid)];
    const rawList = Array.isArray(groupList)
      ? groupList
      : typeof groupList === 'string'
      ? groupList.split(/[\s,，;；\n]+/)
      : Array.isArray(fallbackList)
      ? fallbackList
      : [];
    for (const q of rawList) {
      const clean = String(q).trim();
      if (/^\d{5,13}$/.test(clean)) qqSet.add(clean);
    }
  }
  if (qqSet.size === 0) return baseMessage;
  const atSuffix = Array.from(qqSet)
    .map((qq) => `[CQ:at,qq=${qq}]`)
    .join(' ');
  return `${baseMessage}\n${atSuffix}`;
}

async function broadcastNapCat(message, { force = false, eventType = 'sign_result', eventData = {} } = {}) {
  const cfg = store.napcat || {};
  if (!cfg.enabled && !force) return { sent: false, reason: 'NapCat 未开启' };
  const rawBase = String(cfg.httpUrl || 'http://127.0.0.1:6099/plugin/napcat-plugin-qce/api').replace(/\/+$/, '');
  const headers = {};
  if (cfg.accessToken) {
    headers['Authorization'] = `Bearer ${cfg.accessToken}`;
    headers['X-ISHIT-Token'] = cfg.accessToken;
  }

  const groups = (cfg.groups || cfg.groupIds || []).map((g) => String(g).trim()).filter(Boolean);
  const privateUsers = (cfg.privateUsers || cfg.privateIds || []).map((u) => String(u).trim()).filter(Boolean);
  const relatedUids = resolveRelatedCxUids(message, eventData);
  const groupMessages = {};
  for (const gid of groups) {
    groupMessages[String(gid)] = buildGroupAtMessage(message, gid, relatedUids, cfg);
  }

  // 判断是否为 NapCat Bridge 插件地址 (6099 端口或包含 /plugin/)
  const isBridgeUrl = rawBase.includes('/plugin/') || rawBase.endsWith(':6099');
  const bridgeEndpoint = rawBase.endsWith('/notify')
    ? rawBase
    : rawBase.includes('/plugin/')
    ? `${rawBase}/notify`
    : `${rawBase}/plugin/napcat-plugin-qce/api/notify`;

  if (isBridgeUrl) {
    try {
      const resp = await postJson(
        bridgeEndpoint,
        {
          eventType,
          message,
          groups,
          privateUsers,
          groupMessages,
          ...eventData,
        },
        headers
      );
      const data = resp.data || {};
      if (data.ok || data.sentCount > 0) {
        sysLog('NAPCAT', `Bridge 插件推送成功 (${eventType}): 发送 ${data.sentCount} 个目标`);
        return { sent: true, sentCount: data.sentCount, details: data.details };
      }
      const reason = data.reason || data.message || '插件未返回成功状态（请检查是否配置了群号或私聊 QQ）';
      sysLog('WARN', `Bridge 插件响应: ${reason}`);
      return { sent: false, reason, details: data.details };
    } catch (e) {
      sysLog('ERROR', `Bridge 插件请求异常: ${e.message}`);
      return { sent: false, reason: e.message };
    }
  }

  // 兼容传统 OneBot v11 HTTP Server (如 3000 端口)
  let sentCount = 0;
  const errors = [];

  for (const gid of groups) {
    const finalMsg = groupMessages[String(gid)] || message;
    try {
      await postJson(`${rawBase}/send_group_msg`, { group_id: Number(gid) || gid, message: finalMsg }, headers);
      sentCount++;
    } catch (e) { errors.push(`群[${gid}]: ${e.message}`); }
  }

  for (const uid of privateUsers) {
    try {
      await postJson(`${rawBase}/send_private_msg`, { user_id: Number(uid) || uid, message }, headers);
      sentCount++;
    } catch (e) { errors.push(`私聊[${uid}]: ${e.message}`); }
  }

  if (sentCount > 0 || errors.length > 0) {
    sysLog('NAPCAT', `播报完成: 成功 ${sentCount}, 失败 ${errors.length}`);
  }
  return { sent: sentCount > 0, sentCount, errors, reason: errors.join('; ') || (sentCount === 0 ? '未配置群号或私聊 QQ' : '') };
}

const sentNotifyDedupSet = new Set();
const pendingNapCatRetryQueue = []; // { message, options, attempts, nextRetryAt }

async function broadcastNapCatWithRetry(message, options = {}) {
  const { dedupKey } = options;
  if (dedupKey && sentNotifyDedupSet.has(dedupKey)) {
    return { sent: true, deduplicated: true };
  }
  const res = await broadcastNapCat(message, options);
  if (res && res.sent) {
    if (dedupKey) sentNotifyDedupSet.add(dedupKey);
    return res;
  }
  // 若因为 QQ NT 网络瞬断 (如 1006514 网络连接异常) 推送失败，自动加入后台重试队列（最多补偿重试 4 次）
  const cfg = store.napcat || {};
  if (cfg.enabled) {
    pendingNapCatRetryQueue.push({
      message,
      options,
      dedupKey: dedupKey || null,
      attempts: 1,
      nextRetryAt: Date.now() + 8000,
    });
    sysLog('NAPCAT', `群聊播报暂时失败(${res?.reason || '网络波动'})，已加入补偿队列自动重发`);
  }
  return res;
}

async function flushNapCatRetryQueue() {
  if (pendingNapCatRetryQueue.length === 0) return;
  const now = Date.now();
  for (let i = pendingNapCatRetryQueue.length - 1; i >= 0; i--) {
    const item = pendingNapCatRetryQueue[i];
    if (now < item.nextRetryAt) continue;
    if (item.dedupKey && sentNotifyDedupSet.has(item.dedupKey)) {
      pendingNapCatRetryQueue.splice(i, 1);
      continue;
    }
    const res = await broadcastNapCat(item.message, item.options);
    if (res && res.sent) {
      if (item.dedupKey) sentNotifyDedupSet.add(item.dedupKey);
      pendingNapCatRetryQueue.splice(i, 1);
      sysLog('NAPCAT', '补偿队列重发群聊通知成功');
    } else {
      item.attempts += 1;
      if (item.attempts >= 5) {
        pendingNapCatRetryQueue.splice(i, 1);
        sysLog('WARN', '补偿队列群聊通知重试满 5 次仍失败，已放弃该条消息');
      } else {
        item.nextRetryAt = Date.now() + item.attempts * 10000;
      }
    }
  }
}

// ============================================================================
// 2. 协助链接会话管理
// ============================================================================
// 查找指定班级 (classId/courseId) 涵盖的所有已登录账号
function findMatchingAccountsForClass(courseId, classId, explicitTargetUids = null) {
  const allAccounts = store.accounts || [];
  if (explicitTargetUids && explicitTargetUids.length > 0) {
    return allAccounts.filter((u) => explicitTargetUids.includes(u.uid));
  }
  if (!classId && !courseId) return allAccounts;
  const matched = allAccounts.filter((u) => {
    const eff = getEffectiveUserProfile(u.uid);
    const list = eff.coursesCache || [];
    if (list.length === 0) return true; // 若该账号尚未缓存课程表，默认纳入尝试
    return list.some(
      (c) =>
        (classId && String(c.classId) === String(classId)) ||
        (!classId && courseId && String(c.courseId) === String(courseId))
    );
  });
  return matched.length > 0 ? matched : allAccounts;
}

function createHelperSession({
  mode = 'sign',
  title = '协助签到',
  courseId = '',
  classId = '',
  cpi = '',
  courseName = '',
  activeId = '',
  activeName = '',
  signType = 'normal',
  targetUids = [],
  targetNames = [],
  captchaKey = null,
  creatorUsername = '',
  creatorRole = 'admin',
  ttlMinutes = 45,
}) {
  store.helperSessions = (store.helperSessions || []).filter((s) => s.expiresAt > Date.now());

  // 针对同一签到活动 (activeId + classId)，若已有未完成协助会话，直接合并账号并复用同一个链接，绝不重复生成多个链接
  if (mode === 'sign' && activeId) {
    const existing = store.helperSessions.find(
      (s) => s.mode === 'sign' && String(s.activeId) === String(activeId) && !s.completed
    );
    if (existing) {
      const mergedUids = [...new Set([...(existing.targetUids || []), ...(targetUids || [])])];
      const mergedNames = [...new Set([...(existing.targetNames || []), ...(targetNames || [])])];
      existing.targetUids = mergedUids;
      existing.targetNames = mergedNames;
      if (title) existing.title = title;
      existing.expiresAt = Date.now() + ttlMinutes * 60 * 1000;
      saveStore();
      return existing;
    }
  }

  const token = EncryptionUtil.getUniqueId().slice(0, 10);
  const session = {
    token,
    mode, // 'sign' | 'login' | 'captcha'
    title,
    courseId: String(courseId),
    classId: String(classId),
    cpi: String(cpi),
    courseName,
    activeId: String(activeId),
    activeName,
    signType,
    targetUids,
    targetNames,
    captchaKey,
    creatorUsername: String(creatorUsername || ''),
    creatorRole: String(creatorRole || 'admin'),
    createdAt: Date.now(),
    expiresAt: Date.now() + ttlMinutes * 60 * 1000,
    completed: false,
    lastResult: null,
  };
  store.helperSessions.unshift(session);
  saveStore();
  return session;
}

function getHelperSession(token) {
  return (store.helperSessions || []).find((s) => s.token === token && s.expiresAt > Date.now()) || null;
}

// ============================================================================
// 3. 签到执行引擎 (按每个账号的独立/继承配置定位 + 防作弊 Validate 滑块支持)
// ============================================================================
const SIGN_TYPE_INDEX_MAP = {
  0: 'normal',
  2: 'qrCode',
  3: 'pattern',
  4: 'location',
  5: 'code',
};

const SIGN_TYPE_LABEL = {
  normal: '普通签到',
  photo: '拍照签到',
  location: '位置签到',
  pattern: '手势签到',
  code: '签到码签到',
  qrCode: '二维码签到',
};

function parseQrInput(qrInput) {
  if (!qrInput) return { enc: null, code: null };
  const trimmed = String(qrInput).trim();
  if (/^[0-9A-Fa-f]{24,64}$/.test(trimmed)) return { enc: trimmed, code: null };
  try {
    const u = new URL(trimmed);
    return {
      enc: u.searchParams.get('enc') || null,
      code: u.searchParams.get('c') || null,
      id: u.searchParams.get('id') || '',
    };
  } catch (_) {
    const encMatch = trimmed.match(/enc=([0-9A-Za-z]+)/);
    const cMatch = trimmed.match(/[?&]c=([0-9A-Za-z]+)/);
    return {
      enc: encMatch ? encMatch[1] : trimmed,
      code: cMatch ? cMatch[1] : null,
    };
  }
}

async function performSingleAccountSign({
  user,
  accountIndex = 0,
  courseId,
  classId,
  cpi = '',
  courseName = '',
  activeId,
  activeName = '',
  activeInfo = {},
  signType = 'normal',
  needPhoto = false,
  needFace = false,
  designatedPlace = '',
  signCode = null,
  enc = null,
  enc2 = null,
  validate = null,
  address = null,
  latitude = null,
  longitude = null,
  objectId = null,
}) {
  // 读取该用户独立配置（或沿用的目标用户配置）
  const effProfile = getEffectiveUserProfile(user.uid);
  const courseSetting = effProfile.courseSettings?.[courseId] || {};
  const userDefLoc = effProfile.defaultLocation || {
    address: '上海市奉贤区海思路100号',
    latitude: 30.8328,
    longitude: 121.5035,
  };

  let contentObj = {};
  if (activeInfo.content && typeof activeInfo.content === 'string') {
    try { contentObj = JSON.parse(activeInfo.content); } catch (_) {}
  }
  const parseValidCoord = (...vals) => {
    for (const v of vals) {
      if (v === undefined || v === null || v === '') continue;
      const num = Number(v);
      if (!Number.isNaN(num) && num !== 0 && num !== -1) return num;
    }
    return null;
  };
  const teacherBdLat = parseValidCoord(activeInfo.locationLatitude, contentObj.locationLatitude, activeInfo.latitude);
  const teacherBdLng = parseValidCoord(activeInfo.locationLongitude, contentObj.locationLongitude, activeInfo.longitude);

  const resolvedAddress = address || courseSetting?.location?.address || designatedPlace || userDefLoc.address || '教学楼';
  let resolvedLat = null;
  let resolvedLng = null;
  let coordSystem = 'wgs84';

  if (latitude !== null && latitude !== undefined && latitude !== '' && longitude !== null && longitude !== undefined && longitude !== '') {
    resolvedLat = Number(latitude);
    resolvedLng = Number(longitude);
    coordSystem = 'wgs84';
  } else if (courseSetting?.location?.latitude && courseSetting?.location?.longitude) {
    resolvedLat = Number(courseSetting.location.latitude);
    resolvedLng = Number(courseSetting.location.longitude);
    coordSystem = 'wgs84';
  } else if (teacherBdLat !== null && teacherBdLng !== null) {
    // 若未单独指定该课预设，且教师活动自带目标百度坐标，直接精确对齐教师要求坐标（并加微小随机偏移 <5米）
    resolvedLat = teacherBdLat + (Math.random() - 0.5) * 0.00004;
    resolvedLng = teacherBdLng + (Math.random() - 0.5) * 0.00004;
    coordSystem = 'bd09';
  } else {
    resolvedLat = Number(userDefLoc.latitude ?? 30.8328);
    resolvedLng = Number(userDefLoc.longitude ?? 121.5035);
    coordSystem = 'wgs84';
  }

  let faceParams = {};
  if (needFace) {
    performSingleAccountSign._faceCache = performSingleAccountSign._faceCache || {};
    const faceCacheKey = `${user.uid}_${activeId}`;
    const cachedFp = performSingleAccountSign._faceCache[faceCacheKey];
    if (cachedFp && cachedFp.faceId && cachedFp.faceEnc && Date.now() - cachedFp.ts < 45000) {
      faceParams = cachedFp;
    } else {
      faceParams = await CXProtocol.getFaceParams(user, activeId);
      if (faceParams && faceParams.faceId) {
        performSingleAccountSign._faceCache[faceCacheKey] = { ...faceParams, ts: Date.now() };
      }
    }
  }

  const deviceCode = EncryptionUtil.getDeviceCode();
  const signUrl = 'https://mobilelearn.chaoxing.com/pptSign/stuSignajax';
  let rawResp = null;

  if (signType === 'normal') {
    const imgPool = courseSetting?.imageObjectIds || [];
    const chosenObjId = objectId || (needPhoto && imgPool.length > 0 ? imgPool[accountIndex % imgPool.length] : null);
    const baseParams = {
      activeId: String(activeId),
      courseId: String(courseId),
      uid: String(user.uid),
      clientip: '',
      latitude: '-1',
      longitude: '-1',
      appType: '15',
      fid: '0',
      name: user.name || '',
      deviceCode,
    };
    if (faceParams.faceId) {
      baseParams.currentFaceId = faceParams.faceId;
      baseParams.ifCFP = '1';
      baseParams.faceEnc = faceParams.faceEnc || '';
    }
    if (validate) baseParams.validate = validate;

    if (chosenObjId) {
      rawResp = await cxRequest(signUrl, {
        method: 'POST',
        body: { ...baseParams, objectId: chosenObjId },
        userId: user.uid,
      });
    } else {
      rawResp = await cxRequest(signUrl, {
        method: 'GET',
        params: baseParams,
        userId: user.uid,
      });
    }
  } else if (signType === 'location') {
    const loc = CXProtocol.buildLocationPayload(user, resolvedAddress, resolvedLat, resolvedLng, coordSystem);
    const formData = {
      name: user.name || '',
      address: resolvedAddress,
      activeId: String(activeId),
      courseId: String(courseId),
      uid: String(user.uid),
      clientip: '',
      latitude: loc.bdLat.toFixed(6),
      longitude: loc.bdLng.toFixed(6),
      fid: '0',
      appType: '15',
      ifTiJiao: '1',
      deviceCode,
      vpProbability: '-1',
      vpStrategy: '',
      currentFaceId: faceParams.faceId || '',
      ifCFP: faceParams.faceId ? '1' : '0',
      faceEnc: faceParams.faceEnc || '',
      locationResult: loc.locationResultJson,
    };
    if (validate) formData.validate = validate;
    rawResp = await cxRequest(signUrl, { method: 'POST', body: formData, userId: user.uid });
  } else if (signType === 'code' || signType === 'pattern') {
    const loc = CXProtocol.buildLocationPayload(user, resolvedAddress, resolvedLat, resolvedLng, coordSystem);
    const formData = {
      activeId: String(activeId),
      courseId: String(courseId),
      uid: String(user.uid),
      clientip: '',
      latitude: loc.bdLat.toFixed(6),
      longitude: loc.bdLng.toFixed(6),
      appType: '15',
      fid: '0',
      name: user.name || '',
      signCode: String(signCode),
      deviceCode,
      location: loc.locationJson,
      locationResult: loc.locationResultJson,
      currentFaceId: faceParams.faceId || '',
      ifCFP: faceParams.faceId ? '1' : '0',
      faceEnc: faceParams.faceEnc || '',
    };
    if (validate) formData.validate = validate;
    rawResp = await cxRequest(signUrl, { method: 'POST', body: formData, userId: user.uid });
  } else if (signType === 'qrCode') {
    const loc = CXProtocol.buildLocationPayload(user, resolvedAddress, resolvedLat, resolvedLng, coordSystem);
    const formData = {
      enc: String(enc || ''),
      name: user.name || '',
      activeId: String(activeId),
      uid: String(user.uid),
      clientip: '',
      location: loc.locationJson,
      locationResult: loc.locationResultJson,
      latitude: '-1',
      longitude: '-1',
      fid: '0',
      appType: '15',
      deviceCode,
      vpProbability: '',
      vpStrategy: '',
      currentFaceId: faceParams.faceId || '',
      ifCFP: faceParams.faceId ? '1' : '0',
      courseId: String(courseId),
      faceEnc: faceParams.faceEnc || '',
    };
    if (signCode) formData.signCode = String(signCode);
    if (validate) formData.validate = validate;
    if (enc2) formData.enc2 = enc2;
    rawResp = await cxRequest(signUrl, { method: 'POST', body: formData, userId: user.uid });
  }

  return typeof rawResp === 'string' ? rawResp.trim() : JSON.stringify(rawResp || '');
}

// 自动识别学习通防作弊滑块缺口 X 坐标（Alpha 轮廓法向梯度对齐 + 描边亮度阶跃匹配）
function solveSlideCaptchaX(shadeDataUrl, cutoutDataUrl) {
  try {
    const sB64 = String(shadeDataUrl || '').split(',')[1];
    const cB64 = String(cutoutDataUrl || '').split(',')[1];
    if (!sB64 || !cB64) return null;

    const shadeBuf = Buffer.from(sB64, 'base64');
    const cutoutBuf = Buffer.from(cB64, 'base64');
    const shade = jpeg.decode(shadeBuf, { useTArray: true });
    const cutout = PNG.sync.read(cutoutBuf);
    const W = shade.width;
    const H = shade.height;
    const cW = cutout.width;
    const cH = cutout.height;
    if (!W || !H || !cW || !cH) return null;

    let minY = cH;
    let maxY = 0;
    let minX = cW;
    let maxX = 0;
    const alphaMask = new Uint8Array(cW * cH);
    for (let y = 0; y < cH; y++) {
      for (let x = 0; x < cW; x++) {
        const a = cutout.data[(y * cW + x) * 4 + 3];
        if (a > 128) {
          alphaMask[y * cW + x] = 1;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
    }

    const borderPoints = [];
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (!alphaMask[y * cW + x]) continue;
        let nx = 0;
        let ny = 0;
        if (x === 0 || !alphaMask[y * cW + (x - 1)]) nx -= 1;
        if (x === cW - 1 || !alphaMask[y * cW + (x + 1)]) nx += 1;
        if (y === 0 || !alphaMask[(y - 1) * cW + x]) ny -= 1;
        if (y === cH - 1 || !alphaMask[(y + 1) * cW + x]) ny += 1;
        if (nx !== 0 || ny !== 0) {
          borderPoints.push({ x, y, nx, ny });
        }
      }
    }
    if (borderPoints.length < 16) return null;

    const shadeLum = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const idx = i * 4;
      shadeLum[i] = 0.299 * shade.data[idx] + 0.587 * shade.data[idx + 1] + 0.114 * shade.data[idx + 2];
    }

    const shadeGx = new Float32Array(W * H);
    const shadeGy = new Float32Array(W * H);
    const shadeGrad = new Float32Array(W * H);
    for (let y = Math.max(1, minY - 2); y <= Math.min(H - 2, maxY + 2); y++) {
      for (let x = 1; x < W - 1; x++) {
        const gx =
          -shadeLum[(y - 1) * W + (x - 1)] + shadeLum[(y - 1) * W + (x + 1)] +
          -2 * shadeLum[y * W + (x - 1)] + 2 * shadeLum[y * W + (x + 1)] +
          -shadeLum[(y + 1) * W + (x - 1)] + shadeLum[(y + 1) * W + (x + 1)];
        const gy =
          -shadeLum[(y - 1) * W + (x - 1)] - 2 * shadeLum[(y - 1) * W + x] - shadeLum[(y - 1) * W + (x + 1)] +
          shadeLum[(y + 1) * W + (x - 1)] + 2 * shadeLum[(y + 1) * W + x] + shadeLum[(y + 1) * W + (x + 1)];
        shadeGx[y * W + x] = gx;
        shadeGy[y * W + x] = gy;
        shadeGrad[y * W + x] = Math.sqrt(gx * gx + gy * gy);
      }
    }

    let bestX = 0;
    let bestScore = -1e9;
    for (let ox = 38; ox <= W - cW - 2; ox++) {
      let score = 0;
      for (let i = 0; i < borderPoints.length; i++) {
        const bp = borderPoints[i];
        const sx = ox + bp.x;
        const sy = bp.y;
        const gMag = shadeGrad[sy * W + sx];
        const gAlign = Math.abs(shadeGx[sy * W + sx] * bp.nx + shadeGy[sy * W + sx] * bp.ny);
        const inX = Math.max(0, Math.min(W - 1, sx - bp.nx * 3));
        const inY = Math.max(0, Math.min(H - 1, sy - bp.ny * 3));
        const borderBright = shadeLum[sy * W + sx] - shadeLum[inY * W + inX];
        score += gMag * 0.5 + gAlign * 0.5 + Math.max(0, borderBright) * 1.8;
      }
      score /= borderPoints.length;
      if (score > bestScore) {
        bestScore = score;
        bestX = ox;
      }
    }
    return bestX > 0 ? bestX : null;
  } catch (_) {
    return null;
  }
}

// 全自动拉取并破解滑块验证码（最多自动尝试 maxAttempts 次，单轮综合通过率 ~99.8%）
async function autoSolveSlideCaptcha(userId, maxAttempts = 4) {
  let lastCapData = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const capData = await CXProtocol.getSlideCaptcha(userId);
      if (!capData || !capData.shadeImage || !capData.cutoutImage) continue;
      lastCapData = capData;

      const xValue = solveSlideCaptchaX(capData.shadeImage, capData.cutoutImage);
      if (!xValue) continue;

      const validate = await CXProtocol.submitSlideCaptcha({
        userId,
        xValue,
        token: capData.token,
        iv: capData.iv,
        timestamp: capData.timestamp,
        referer: capData.referer,
      });

      if (validate) {
        sysLog('CAPTCHA', `账号[${userId}] 自动过滑块成功 (第${attempt}次, x=${xValue})`, { uids: [userId] });
        return { ok: true, validate, xValue, attempt };
      }
    } catch (_) {}
  }
  return { ok: false, validate: null, lastCapData };
}

async function executeSignForActive({
  courseId,
  classId,
  cpi = '',
  courseName = '未知课程',
  activeId,
  activeName = '课堂签到',
  targetUids = null,
  signCode = null,
  enc = null,
  enc2 = null,
  validate = null,
  qrUrl = null,
  address = null,
  latitude = null,
  longitude = null,
  objectId = null,
  triggerSource = '手动触发',
}) {
  const probeUid = (Array.isArray(targetUids) && targetUids[0]) || store.currentUid || store.accounts?.[0]?.uid;
  const activeInfo = (await CXProtocol.getActiveInfoWeb(activeId, probeUid)) || {};
  const otherId = Number(activeInfo.otherId ?? 0);
  const signType = SIGN_TYPE_INDEX_MAP[otherId] || 'normal';
  const needPhoto = activeInfo.ifphoto === 1 || activeInfo.ifPhoto === 1;
  const needFace = activeInfo.openCheckFaceFlag === 1;
  const needCaptcha = activeInfo.showVCode === 1;
  const numberCount = Number(activeInfo.numberCount || 4);
  const designatedPlace = activeInfo.locationText || '';
  const locationRange = activeInfo.locationRange ? String(activeInfo.locationRange) : '';

  let resolvedEnc = enc;
  if (!resolvedEnc && qrUrl) {
    const parsed = parseQrInput(qrUrl);
    resolvedEnc = parsed.enc;
    if (parsed.code) await CXProtocol.getSignDetail(activeId, parsed.code);
  }

  let resolvedCode = signCode ? String(signCode).trim() : (activeInfo.signCode ? String(activeInfo.signCode).trim() : '');
  if ((signType === 'code' || signType === 'pattern') && resolvedCode) {
    const checkErr = await CXProtocol.checkSignCode(activeId, resolvedCode);
    if (checkErr) sysLog('WARN', `签到码校验返回: ${checkErr}`);
  }

  // 自动筛选所有拥有相同班级/课程的已登录账号，一并执行或合并生成唯一协助链接
  const accounts = findMatchingAccountsForClass(courseId, classId, targetUids);

  const results = [];
  let needHelperFlag = false;
  let needCaptchaKey = null;

  for (let i = 0; i < accounts.length; i++) {
    const user = accounts[i];
    try {
      const attendInfo = await CXProtocol.getAttendInfoWeb(activeId, user.uid);
      const status = Number(attendInfo?.status ?? 0);
      if (status === 1 || status === 9) {
        results.push({ uid: user.uid, name: user.name, ok: true, already: true, msg: status === 9 ? '已签到(迟到)' : '已签到' });
        continue;
      }

      if ((signType === 'code' || signType === 'pattern') && !resolvedCode) {
        needHelperFlag = true;
        results.push({
          uid: user.uid,
          name: user.name,
          ok: false,
          needHelper: true,
          msg: `需输入${signType === 'pattern' ? '手势' : '签到码'}`,
        });
        continue;
      }

      if (signType === 'qrCode' && !resolvedEnc) {
        // 尝试【无码/静态码盲狙降级签到】：若教师未开启严格动态刷新 (ifrefreshewm=0) 或接口泄漏了静态 signCode，尝试直接携带 signCode 盲签一次
        if (resolvedCode || Number(activeInfo.ifrefreshewm ?? 1) === 0) {
          try {
            if (resolvedCode) {
              await CXProtocol.getSignDetail(activeId, resolvedCode, user.uid);
            }
            let blindResp = await performSingleAccountSign({
              user,
              accountIndex: i,
              courseId,
              classId,
              cpi,
              courseName,
              activeId,
              activeName,
              activeInfo,
              signType: 'qrCode',
              needPhoto,
              needFace,
              designatedPlace,
              signCode: resolvedCode,
              enc: '',
              enc2,
              validate,
              address,
              latitude,
              longitude,
              objectId,
            });
            if (blindResp.startsWith('validate')) {
              const parts = blindResp.split('_');
              const extractedEnc2 = parts.length > 1 ? parts[1] : enc2;
              const autoSolved = await autoSolveSlideCaptcha(user.uid, 3);
              if (autoSolved.ok && autoSolved.validate) {
                blindResp = await performSingleAccountSign({
                  user,
                  accountIndex: i,
                  courseId,
                  classId,
                  cpi,
                  courseName,
                  activeId,
                  activeName,
                  activeInfo,
                  signType: 'qrCode',
                  needPhoto,
                  needFace,
                  designatedPlace,
                  signCode: resolvedCode,
                  enc: '',
                  enc2: extractedEnc2,
                  validate: autoSolved.validate,
                  address,
                  latitude,
                  longitude,
                  objectId,
                });
              }
            }
            if (blindResp === 'success' || blindResp === 'success2' || blindResp.includes('已签到')) {
              sysLog('SIGN', `账号[${user.name || user.uid}] 二维码免扫码盲狙成功！`, { uids: [user.uid] });
              results.push({
                uid: user.uid,
                name: user.name,
                ok: true,
                msg: `${blindResp} (免扫码盲签成功)`,
              });
              continue;
            }
          } catch (_) {}
        }

        needHelperFlag = true;
        results.push({
          uid: user.uid,
          name: user.name,
          ok: false,
          needHelper: true,
          msg: '需扫描现场二维码或往群内发送二维码照片',
        });
        continue;
      }

      const respStr = await performSingleAccountSign({
        user,
        accountIndex: i,
        courseId,
        classId,
        cpi,
        courseName,
        activeId,
        activeName,
        activeInfo,
        signType,
        needPhoto,
        needFace,
        designatedPlace,
        signCode: resolvedCode,
        enc: resolvedEnc,
        enc2,
        validate,
        address,
        latitude,
        longitude,
        objectId,
      });

      // 处理防作弊滑块验证码响应: validate 或 validate_enc2 -> 优先全自动视觉识别过滑块并立即重签！
      if (respStr.startsWith('validate')) {
        const parts = respStr.split('_');
        const extractedEnc2 = parts.length > 1 ? parts[1] : enc2;
        sysLog('CAPTCHA', `账号[${user.name || user.uid}] 触发防作弊滑块，正在执行全自动缺口识别...`, { uids: [user.uid] });

        const autoSolved = await autoSolveSlideCaptcha(user.uid, 4);
        if (autoSolved.ok && autoSolved.validate) {
          const retryResp = await performSingleAccountSign({
            user,
            accountIndex: i,
            courseId,
            classId,
            cpi,
            courseName,
            activeId,
            activeName,
            activeInfo,
            signType,
            needPhoto,
            needFace,
            designatedPlace,
            signCode: resolvedCode,
            enc: resolvedEnc,
            enc2: extractedEnc2,
            validate: autoSolved.validate,
            address,
            latitude,
            longitude,
            objectId,
          });
          const retryOk = retryResp === 'success' || retryResp === 'success2' || retryResp.includes('已签到');
          if (retryOk || !retryResp.startsWith('validate')) {
            // 若此前有残留的待验证记录，自动清理
            if (store.pendingCaptchas) {
              delete store.pendingCaptchas[`${user.uid}_${activeId}`];
              saveStore();
            }
            results.push({
              uid: user.uid,
              name: user.name,
              ok: retryOk,
              msg: retryOk ? `${retryResp === 'success2' ? 'success(迟到签)' : retryResp} (已自动过滑块 x=${autoSolved.xValue})` : (retryResp || '无响应'),
            });
            continue;
          }
        }

        // 兜底：若连续 4 次自动识别均未通过，才转入人工滑块面板
        const capData = autoSolved.lastCapData || (await CXProtocol.getSlideCaptcha(user.uid));
        const capKey = `${user.uid}_${activeId}`;
        store.pendingCaptchas = store.pendingCaptchas || {};
        store.pendingCaptchas[capKey] = {
          key: capKey,
          uid: user.uid,
          userName: user.name,
          courseId: String(courseId),
          classId: String(classId),
          cpi: String(cpi),
          courseName,
          activeId: String(activeId),
          activeName,
          signType,
          signCode: resolvedCode,
          enc: resolvedEnc,
          enc2: extractedEnc2,
          address,
          latitude,
          longitude,
          objectId,
          captcha: capData,
          createdAt: Date.now(),
        };
        saveStore();
        needCaptchaKey = capKey;
        needHelperFlag = true;
        results.push({
          uid: user.uid,
          name: user.name,
          ok: false,
          needCaptcha: true,
          captchaKey: capKey,
          msg: '自动滑块未通过，请点击【滑块验证】完成重签',
        });
        continue;
      }

      const ok = respStr === 'success' || respStr === 'success2' || respStr.includes('已签到');
      results.push({
        uid: user.uid,
        name: user.name,
        ok,
        msg: respStr || '无响应',
      });
    } catch (e) {
      results.push({ uid: user.uid, name: user.name, ok: false, msg: `异常: ${e.message}` });
    }
  }

  let helperShareUrl = null;
  const pendingHelperUsers = results.filter((r) => !r.ok);
  const mergedNamesStr = (pendingHelperUsers.length > 0 ? pendingHelperUsers : accounts)
    .map((u) => u.name || u.uid)
    .join('/');

  if (needHelperFlag) {
    const hs = createHelperSession({
      mode: needCaptchaKey ? 'captcha' : 'sign',
      title: needCaptchaKey
        ? `帮 ${mergedNamesStr} 完成《${courseName}》滑块验证`
        : `帮 ${mergedNamesStr} 签到《${courseName}》(${SIGN_TYPE_LABEL[signType] || signType})`,
      courseId,
      classId,
      cpi,
      courseName,
      activeId,
      activeName,
      signType,
      targetUids: (pendingHelperUsers.length > 0 ? pendingHelperUsers : accounts).map((u) => u.uid),
      targetNames: (pendingHelperUsers.length > 0 ? pendingHelperUsers : accounts).map((u) => u.name || u.uid),
      captchaKey: needCaptchaKey,
    });
    const baseUrl = String(store.napcat?.publicBaseUrl || 'http://127.0.0.1:8080').replace(/\/+$/, '');
    helperShareUrl = `${baseUrl}/?help=${hs.token}`;
  }

  const succeededUsers = results.filter((r) => r.ok);
  const failedUsers = results.filter((r) => !r.ok);

  if (succeededUsers.length > 0) {
    markAccountsNotifiedForActive(
      activeId,
      succeededUsers.map((u) => u.uid)
    );
  }

  // 只要本次所有账号均已签到成功，自动将该活动的未完成协助会话标记为已完成
  if (succeededUsers.length > 0 && failedUsers.length === 0) {
    for (const hs of store.helperSessions || []) {
      if (!hs.completed && String(hs.activeId) === String(activeId)) {
        hs.completed = true;
      }
    }
  }

  const record = {
    id: `${activeId}_${Date.now()}`,
    time: new Date().toLocaleString('zh-CN', { hour12: false }),
    courseId: String(courseId),
    classId: String(classId),
    courseName,
    activeId: String(activeId),
    activeName,
    signType,
    signTypeLabel: needPhoto && signType === 'normal' ? '拍照签到' : (SIGN_TYPE_LABEL[signType] || signType),
    needPhoto,
    needFace,
    needCaptcha,
    numberCount,
    designatedPlace,
    locationRange,
    triggerSource,
    helperShareUrl,
    results,
  };

  if (succeededUsers.length > 0 && failedUsers.length === 0) {
    for (const hs of store.helperSessions || []) {
      if (String(hs.activeId) === String(activeId)) {
        hs.lastResult = record;
      }
    }
  }

  store.signHistory = store.signHistory || [];
  store.signHistory.unshift(record);
  if (store.signHistory.length > 80) store.signHistory.pop();
  saveStore();

  // 合并群聊提醒格式：将签到成功的多个账号合并为一行“已签成功：A / B / C”，失败/待协助的合并展示
  const successNamesStr = succeededUsers.map((r) => r.name || r.uid).join(' / ');
  const lines = [
    succeededUsers.length > 0 && !helperShareUrl
      ? `[学习通签到成功] (${triggerSource})`
      : helperShareUrl
      ? `[学习通签到求助] (${triggerSource})`
      : `[学习通签到通知] (${triggerSource})`,
    `课程：${courseName}`,
    `活动：${activeName} (${record.signTypeLabel})`,
  ];
  if (designatedPlace) lines.push(`地点：${designatedPlace} (${locationRange || '-'}m)`);
  if (succeededUsers.length > 0) {
    lines.push(`签到成功：${successNamesStr}`);
  }
  if (failedUsers.length > 0) {
    const failSummary = failedUsers.map((r) => `${r.name || r.uid}(${r.msg})`).join(' / ');
    lines.push(`待处理：${failSummary}`);
  }
  if (helperShareUrl) {
    lines.push(`合并协助（帮 ${mergedNamesStr} 一键签到）：${helperShareUrl}`);
  }

  const shouldNotify =
    helperShareUrl
      ? store.napcat?.notifyOnNeedHelper !== false
      : store.napcat?.notifyOnComplete !== false;

  if (shouldNotify) {
    await broadcastNapCatWithRetry(lines.join('\n'), {
      eventType: helperShareUrl ? 'help_request' : 'sign_result',
      dedupKey: helperShareUrl ? `help_${activeId}` : `ok_${activeId}_${succeededUsers.map((u) => u.uid).sort().join(',')}_${triggerSource}`,
      eventData: {
        title: helperShareUrl ? `帮 ${mergedNamesStr} 签到《${courseName}》` : `签到成功《${courseName}》`,
        targetNames: helperShareUrl ? mergedNamesStr : successNamesStr,
        courseName,
        activeName,
        signType,
        signTypeLabel: record.signTypeLabel,
        designatedPlace,
        locationRange,
        triggerSource,
        helperShareUrl,
        shareUrl: helperShareUrl,
        results,
      },
    });
  }
  sysLog('SIGN', `课程《${courseName}》(${record.signTypeLabel}) 处理完成 [成功:${succeededUsers.length}/${results.length}]`, { uids: results.map((r) => r.uid) });

  return record;
}

// ============================================================================
// 4. 课表驱动 + 自定义时段驱动的自动轮询器
// ============================================================================
let pollTimer = null;
let isScanning = false;
let lastPollTime = null;
let lastDetectedActives = [];
let protectWatchTimer = null;
let isCheckingProtected = false;
const pendingThresholdWatchMap = new Map(); // activeId -> task

function parseHmToMins(hm) {
  const [h, m] = String(hm || '08:00').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

// 获取用户所有已设为【测试课程】的列表及其独立轮询状态
function getTestCoursesInfo(effProfile) {
  const courses = effProfile?.coursesCache || [];
  const settingsMap = effProfile?.courseSettings || {};
  const seenIds = new Set();
  const allTestCourses = [];
  const activeTestCourses = [];
  for (const c of courses) {
    const cid = String(c.courseId);
    if (seenIds.has(cid)) continue;
    const st = settingsMap[c.courseId];
    if (st && st.isTestCourse) {
      seenIds.add(cid);
      allTestCourses.push(c);
      if (st.testPollingEnabled !== false) {
        activeTestCourses.push(c);
      }
    }
  }
  return { allTestCourses, activeTestCourses };
}

// 检查某门课是否在用户配置中开启了轮询（测试课程拥有最高独立优先级）
function isLessonCoursePollingEnabled(effProfile, lesson) {
  const settingsMap = effProfile?.courseSettings || {};
  const courses = effProfile?.coursesCache || [];
  const matchedCourse = courses.find(
    (c) =>
      (lesson.courseId && String(c.courseId) === String(lesson.courseId)) ||
      (lesson.name && (c.name || c.courseName) === lesson.name)
  );
  const st = (lesson.courseId && settingsMap[lesson.courseId]) || (matchedCourse && settingsMap[matchedCourse.courseId]);
  if (st) {
    if (st.isTestCourse) return st.testPollingEnabled !== false;
    return st.pollingEnabled !== false;
  }
  return true;
}

// 检查单个账号当前是否处于轮询激活状态
function getAccountActiveScheduleStatus(uid, now = new Date()) {
  const cfg = getEffectiveScheduleForCxUid(uid);
  const eff = getEffectiveUserProfile(uid);
  const { activeTestCourses } = getTestCoursesInfo(eff);
  const testNames = activeTestCourses.map((c) => c.name || c.courseName);

  // 测试课程不受轮询模式、总开关、课表时间影响，只要开启了测试轮询即随时监测
  if (!cfg.masterEnabled) {
    if (activeTestCourses.length > 0) {
      return {
        inClass: true,
        hasActiveTestCourses: true,
        activeTestCourses,
        mode: 'test_only',
        reason: `测试轮询: ${testNames.join(', ')}`,
        matchedLessons: [],
        matchedSlot: { label: `测试课程 (${testNames[0]})` },
      };
    }
    return { inClass: false, hasActiveTestCourses: false, activeTestCourses: [], mode: cfg.forcePolling ? 'continuous' : 'curriculum', reason: '轮询已关闭', matchedLessons: [], matchedSlot: null };
  }

  if (cfg.forcePolling) {
    const suffix = activeTestCourses.length > 0 ? ` · 含测试课 ${testNames.join(', ')}` : '';
    return {
      inClass: true,
      hasActiveTestCourses: activeTestCourses.length > 0,
      activeTestCourses,
      mode: 'continuous',
      reason: `持续轮询（全课程全时段${suffix}）`,
      matchedLessons: [],
      matchedSlot: { label: '持续轮询' },
    };
  }

  const day = now.getDay() === 0 ? 7 : now.getDay(); // 1..7
  const curMins = now.getHours() * 60 + now.getMinutes();
  const buffer = Number(eff.curriculumBufferMinutes ?? 10);

  // 1. 课表轮询模式：合并学习通导入课表 + DIY 自定义课表（支持按课程-班级规则匹配），并过滤掉未勾选轮询的课程
  const importedLessons = (eff.useCurriculumSchedule !== false && eff.effectiveCurriculum && Array.isArray(eff.effectiveCurriculum.lessons))
    ? eff.effectiveCurriculum.lessons
    : [];
  const diyLessons = Array.isArray(eff.diyLessons)
    ? eff.diyLessons.filter((d) => d && d.enabled !== false)
    : [];
  const combinedLessons = [...importedLessons, ...diyLessons];

  if (combinedLessons.length > 0) {
    const curWeek = Number(eff.effectiveCurriculum?.realCurrentWeek || 1);
    const timeMatchedLessons = combinedLessons.filter((les) => {
      if (Number(les.dayOfWeek) !== day) return false;
      if (Array.isArray(les.weeks) && les.weeks.length > 0 && !les.weeks.includes(curWeek)) return false;
      const sMins = parseHmToMins(les.startTime) - buffer;
      const eMins = parseHmToMins(les.endTime) + buffer;
      return curMins >= sMins && curMins <= eMins;
    });

    if (timeMatchedLessons.length > 0) {
      const enabledLessons = timeMatchedLessons.filter((les) => {
        if (les.isDiy && les.pollingEnabled === false) return false;
        return isLessonCoursePollingEnabled(eff, les);
      });
      if (enabledLessons.length > 0) {
        const suffix = activeTestCourses.length > 0 ? ` + 测试课: ${testNames.join(', ')}` : '';
        return {
          inClass: true,
          regularInClass: true,
          hasActiveTestCourses: activeTestCourses.length > 0,
          activeTestCourses,
          mode: 'curriculum',
          reason: `课表轮询中: ${enabledLessons.map((l) => l.name).join(', ')}${suffix}`,
          matchedLessons: enabledLessons,
          matchedSlot: { label: `${enabledLessons[0].name} (${enabledLessons[0].startTime}-${enabledLessons[0].endTime})` },
        };
      }
      if (activeTestCourses.length > 0) {
        return {
          inClass: true,
          regularInClass: false,
          hasActiveTestCourses: true,
          activeTestCourses,
          mode: 'test_only',
          reason: `测试课程轮询中: ${testNames.join(', ')} (排课已暂停)`,
          matchedLessons: [],
          matchedSlot: { label: `测试课程 (${testNames[0]})` },
        };
      }
      return {
        inClass: false,
        regularInClass: false,
        hasActiveTestCourses: false,
        activeTestCourses: [],
        mode: 'curriculum',
        reason: `当前排课已暂停轮询: ${timeMatchedLessons.map((l) => l.name).join(', ')}`,
        matchedLessons: [],
        matchedSlot: null,
      };
    }
  }

  // 2. 非上课时间，但存在已开启轮询的【测试课程】 -> 照常随时轮询该测试课程
  if (activeTestCourses.length > 0) {
    return {
      inClass: true,
      regularInClass: false,
      hasActiveTestCourses: true,
      activeTestCourses,
      mode: 'test_only',
      reason: `测试轮询: ${testNames.join(', ')}`,
      matchedLessons: [],
      matchedSlot: { label: `测试课程 (${testNames[0]})` },
    };
  }

  return { inClass: false, regularInClass: false, hasActiveTestCourses: false, activeTestCourses: [], mode: 'curriculum', reason: '课表轮询 · 非上课时间', matchedLessons: [], matchedSlot: null };
}

function getGlobalScheduleSummary() {
  const uid = store.currentUid || store.accounts?.[0]?.uid;
  if (!uid) {
    return {
      inClass: Boolean(store.schedule?.masterEnabled && store.schedule?.forcePolling),
      matchedSlot: store.schedule?.forcePolling ? { label: '持续轮询' } : null,
      perAccountStatus: {},
    };
  }
  const perAccountStatus = {};
  let anyInClass = false;
  let primarySlot = null;
  for (const acc of store.accounts || []) {
    const st = getAccountActiveScheduleStatus(acc.uid);
    perAccountStatus[acc.uid] = st;
    if (st.inClass) {
      anyInClass = true;
      if (!primarySlot) primarySlot = st.matchedSlot;
    }
  }
  return {
    inClass: anyInClass,
    matchedSlot: primarySlot,
    perAccountStatus,
  };
}

// 聚合已登录账号需要轮询的班级课程（支持 onlyUids 限定扫描指定账号）
async function collectEnabledClassEntries(forceAll = false, onlyUids = null) {
  const classMap = new Map(); // key: classId_courseId -> { course, memberUids: [], memberNames: [], scanUid }
  const allowedUidSet = Array.isArray(onlyUids) && onlyUids.length > 0 ? new Set(onlyUids.map(String)) : null;

  for (const acc of store.accounts || []) {
    if (allowedUidSet && !allowedUidSet.has(String(acc.uid))) continue;
    const uid = acc.uid;
    const accCfg = getEffectiveScheduleForCxUid(uid);
    const isContinuousMode = Boolean(accCfg.masterEnabled && accCfg.forcePolling);
    const eff = getEffectiveUserProfile(uid);
    let courses = eff.coursesCache || [];
    if (courses.length === 0 || forceAll) {
      courses = await CXProtocol.getCoursesList(uid);
    }

    const accSchedule = getAccountActiveScheduleStatus(uid);
    const regularInClass = Boolean(accSchedule.regularInClass);
    const matchedLessons = accSchedule.matchedLessons || [];

    for (const c of courses) {
      let shouldScan = false;
      if (forceAll) {
        shouldScan = true;
      } else {
        const st = eff.courseSettings?.[c.courseId];
        if (st?.isTestCourse) {
          shouldScan = st.testPollingEnabled !== false;
        } else if (isContinuousMode) {
          shouldScan = true;
        } else if (regularInClass) {
          const pollingEnabled = st?.pollingEnabled !== undefined ? st.pollingEnabled : true;
          if (pollingEnabled) {
            if (matchedLessons.length > 0) {
              shouldScan = matchedLessons.some((l) => {
                if (l.classId && String(l.classId) !== String(c.classId)) return false;
                if (l.courseId && String(l.courseId) === String(c.courseId)) return true;
                if (l.name && (c.name || c.courseName) === l.name) return true;
                return false;
              });
            } else {
              shouldScan = true;
            }
          }
        }
      }

      const key = `${c.classId}_${c.courseId}`;
      if (!classMap.has(key)) {
        classMap.set(key, {
          course: c,
          scanUid: uid,
          shouldScan: false,
          memberUids: [],
          memberNames: [],
          memberCpis: {},
        });
      }
      const entry = classMap.get(key);
      if (shouldScan) entry.shouldScan = true;
      if (!entry.memberUids.includes(uid)) {
        entry.memberUids.push(uid);
        entry.memberNames.push(acc.name || uid);
        entry.memberCpis[uid] = c.cpi;
      }
    }
  }

  const allEntries = Array.from(classMap.values());
  const enabledEntries = allEntries.filter((e) => e.shouldScan);
  return { allEntries, enabledEntries };
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollCoursesOnce({ forceAll = false, triggerSource = '自动轮询', onlyUids = null, actorUsername = null } = {}) {
  const isScopedScan = Array.isArray(onlyUids) && onlyUids.length > 0;
  if (!isScopedScan && isScanning) return { scanning: true, detected: lastDetectedActives };
  if (!isScopedScan) {
    isScanning = true;
    lastPollTime = new Date().toLocaleString('zh-CN', { hour12: false });
  }

  const detected = [];
  let hitRateLimit = false;
  const scopedLogMeta = {
    uids: isScopedScan ? onlyUids.map(String) : [],
    ownerUsernames: actorUsername ? [String(actorUsername)] : [],
  };
  try {
    if (!store.accounts || store.accounts.length === 0) {
      return { scanning: false, detected: [] };
    }

    const { allEntries, enabledEntries } = await collectEnabledClassEntries(forceAll, onlyUids);
    const allScanUids = Array.from(new Set(enabledEntries.flatMap((e) => e.memberUids || [])));
    sysLog('POLL', `[${triggerSource}] 扫描 ${enabledEntries.length}/${allEntries.length} 个班级`, {
      uids: allScanUids.length > 0 ? allScanUids : scopedLogMeta.uids,
      ownerUsernames: scopedLogMeta.ownerUsernames,
    });

    for (let idx = 0; idx < enabledEntries.length; idx++) {
      if (idx > 0) {
        await sleepMs(450);
      }
      const entry = enabledEntries[idx];
      const course = entry.course;
      const classLabel = course.note ? `${course.name}(${course.note})` : course.name;
      let actives = null;
      let lastErr = null;

      // 多账号轮转与频控故障转移：同班级如有多个已登录账号，轮流使用不同账号扫描；若某账号处于学习通频控中，立即无缝切下一个账号！
      const candidateUids = entry.memberUids && entry.memberUids.length > 0 ? [...entry.memberUids] : [entry.scanUid];
      pollCoursesOnce._rrIndex = ((pollCoursesOnce._rrIndex || 0) + 1) % Math.max(1, candidateUids.length);
      const orderedUids = [
        ...candidateUids.slice(pollCoursesOnce._rrIndex),
        ...candidateUids.slice(0, pollCoursesOnce._rrIndex),
      ];

      for (const tryUid of orderedUids) {
        const tryCpi = (entry.memberCpis && entry.memberCpis[tryUid]) || course.cpi;
        try {
          actives = await CXProtocol.getActiveList(course.courseId, course.classId, tryCpi, tryUid);
          break;
        } catch (err) {
          lastErr = err;
          if (err && err.rateLimited) {
            continue; // 该账号被频控，立即尝试同班级的下一个账号
          }
          break;
        }
      }

      if (!actives) {
        if (lastErr && lastErr.rateLimited) {
          hitRateLimit = true;
          sysLog('WARN', `[${triggerSource}] 班级《${classLabel}》全部账号均在学习通频控冷却中，跳过本班级`, { uids: entry.memberUids, ownerUsernames: scopedLogMeta.ownerUsernames });
          continue;
        }
        if (lastErr) {
          sysLog('WARN', `[${triggerSource}] 拉取《${classLabel}》活动失败: ${lastErr.message}`, { uids: entry.memberUids, ownerUsernames: scopedLogMeta.ownerUsernames });
        }
        continue;
      }

      for (const act of actives) {
        if (!act.isSignActivity || !act.status) continue;

        // 查询当前签到人数与班级总人数统计（用于界面展示 + 防钓鱼/防反向签到人数比例保护）
        const probeUid = orderedUids[0] || entry.scanUid || store.currentUid;
        let stats = { signedCount: Number(act.attendNum || 0), totalCount: 0, signRatio: 0, startTimeMs: 0, endTimeMs: 0, isOver: false };
        try {
          stats = await CXProtocol.getSignAttendStats(act.id, course.courseId, course.classId, probeUid);
          act.signedCount = stats.signedCount;
          act.totalCount = stats.totalCount;
          act.signRatio = stats.signRatio;
          if (stats.endTimeMs > 0) act.endTimeMs = stats.endTimeMs;
        } catch (_) {}

        const item = {
          courseId: course.courseId,
          classId: course.classId,
          cpi: course.cpi,
          courseName: course.name,
          className: course.note || '',
          teacher: course.teacher,
          memberUids: entry.memberUids,
          memberNames: entry.memberNames,
          active: act,
        };
        detected.push(item);

        const handledKey = `${act.id}`;
        store.handledActiveKeys = store.handledActiveKeys || [];
        const alreadyHandled = store.handledActiveKeys.includes(handledKey);
        if (!alreadyHandled || forceAll) {
          // 按账号独立计算防钓鱼人数比例保护：已达标或未开保护的账号立即签，未达标的账号挂入 3s 高频盯盘
          const readyUids = [];
          const deferredUids = [];
          let maxDeferredThreshold = 0;

          for (const mUid of entry.memberUids) {
            const uKey = `${act.id}_${mUid}`;
            if (!forceAll && store.handledActiveKeys.includes(uKey)) continue;
            const uCfg = getEffectiveScheduleForCxUid(mUid);
            const protectEnabled = Boolean(uCfg.signThresholdEnabled);
            const thresholdRatio = Math.max(0.01, Math.min(0.99, Number(uCfg.signThresholdRatio ?? 0.3)));
            if (!forceAll && protectEnabled && stats.totalCount > 0 && stats.signRatio < thresholdRatio) {
              deferredUids.push(mUid);
              if (thresholdRatio > maxDeferredThreshold) maxDeferredThreshold = thresholdRatio;
            } else {
              readyUids.push(mUid);
            }
          }

          if (deferredUids.length > 0) {
            act.waitingThreshold = true;
            act.thresholdRatio = maxDeferredThreshold || 0.3;
            const prevTask = pendingThresholdWatchMap.get(handledKey);
            pendingThresholdWatchMap.set(handledKey, {
              activeId: String(act.id),
              courseId: String(course.courseId),
              classId: String(course.classId),
              cpi: course.cpi,
              courseName: course.name,
              activeName: act.name,
              memberUids: deferredUids,
              probeUid,
              firstSeenAt: prevTask?.firstSeenAt || Date.now(),
              endTimeMs: Number(stats.endTimeMs || prevTask?.endTimeMs || 0),
              activeRef: act,
            });
            pollCoursesOnce._protectLogTs = pollCoursesOnce._protectLogTs || {};
            const lastLog = pollCoursesOnce._protectLogTs[act.id] || 0;
            if (Date.now() - lastLog > 60000) {
              pollCoursesOnce._protectLogTs[act.id] = Date.now();
              const remainTip =
                stats.endTimeMs > Date.now()
                  ? `，距截止剩 ${Math.max(1, Math.round((stats.endTimeMs - Date.now()) / 1000))}s`
                  : '';
              sysLog(
                'PROTECT',
                `[人数保护] 《${course.name}·${act.name}》当前已签 ${stats.signedCount}/${stats.totalCount} (${(stats.signRatio * 100).toFixed(1)}%) < 阈值 ${(act.thresholdRatio * 100).toFixed(0)}%，${deferredUids.length} 个账号已挂入 3s 高频盯盘与临期压哨保护${remainTip}`,
                { uids: deferredUids, ownerUsernames: scopedLogMeta.ownerUsernames }
              );
            }
          } else {
            act.waitingThreshold = false;
            pendingThresholdWatchMap.delete(handledKey);
          }

          if (readyUids.length > 0) {
            for (const rUid of readyUids) {
              const uKey = `${act.id}_${rUid}`;
              if (!store.handledActiveKeys.includes(uKey)) store.handledActiveKeys.push(uKey);
            }
            if (deferredUids.length === 0 && !store.handledActiveKeys.includes(handledKey)) {
              store.handledActiveKeys.push(handledKey);
            }
            saveStore();
            await executeSignForActive({
              courseId: course.courseId,
              classId: course.classId,
              cpi: course.cpi,
              courseName: course.name,
              activeId: act.id,
              activeName: act.name,
              targetUids: readyUids,
              triggerSource,
            });
          }
        }
      }
    }

    if (detected.length > 0) {
      const detectedUids = Array.from(new Set(detected.flatMap((d) => d.memberUids || [])));
      sysLog('POLL', `[${triggerSource}] 发现 ${detected.length} 个进行中签到活动: ${detected.map((d) => `${d.courseName}·${d.active.name}`).join(', ')}`, {
        uids: detectedUids,
        ownerUsernames: scopedLogMeta.ownerUsernames,
      });
    }

    if (isScopedScan) {
      const scopedSet = new Set(onlyUids.map(String));
      const keptOther = (lastDetectedActives || []).filter(
        (item) => !(item.memberUids || []).every((u) => scopedSet.has(String(u)))
      );
      const mergedMap = new Map();
      for (const it of [...detected, ...keptOther]) {
        const aid = String(it.active?.id || it.id || "");
        if (!mergedMap.has(aid)) mergedMap.set(aid, it);
      }
      lastDetectedActives = Array.from(mergedMap.values());
    } else if (!hitRateLimit || detected.length > 0) {
      lastDetectedActives = detected;
    }
  } catch (e) {
    sysLog('ERROR', `轮询异常: ${e.message}`, scopedLogMeta);
  } finally {
    if (!isScopedScan) isScanning = false;
  }

  return { scanning: false, detected: isScopedScan ? detected : lastDetectedActives };
}

// ============================================================================
// 5. 群聊二维码图片持续监听 + 外部/手动签到成功状态闭环同步（支持多账号合并提醒）
// ============================================================================
let qrWatchTimer = null;
let isWatchingQr = false;
const processedChatImageIds = new Set();
const processedQrEncKeys = new Set();
const notifiedAttendSuccessMap = new Map(); // activeId -> Set(uid)

// 记录在 executeSignForActive 中已经播报过成功的账号，避免状态巡检器重复播报同一账号
function markAccountsNotifiedForActive(activeId, uids) {
  const aid = String(activeId);
  if (!notifiedAttendSuccessMap.has(aid)) notifiedAttendSuccessMap.set(aid, new Set());
  const set = notifiedAttendSuccessMap.get(aid);
  for (const u of uids || []) set.add(String(u));
}

function getNapCatRecentImagesEndpoint() {
  const cfg = store.napcat || {};
  const rawBase = String(cfg.httpUrl || 'http://127.0.0.1:6099/plugin/napcat-plugin-qce/api').replace(/\/+$/, '');
  if (rawBase.endsWith('/notify')) {
    return rawBase.replace(/\/notify$/, '/recent_images');
  }
  if (rawBase.includes('/plugin/')) {
    return `${rawBase}/recent_images`;
  }
  return `${rawBase}/plugin/napcat-plugin-qce/api/recent_images`;
}

// 兜底：扫描本机 QQ NT 原图落地目录 (Pic/YYYY-MM/Ori) 最近收到的图片，即使 NapCat 事件漏推也能秒级捕获二维码
function scanLocalQqNtRecentImages(sinceMs) {
  const results = [];
  try {
    const baseDir = 'D:/TencentFiles/Tencent Files';
    if (!fs.existsSync(baseDir)) return results;
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const entries = fs.readdirSync(baseDir);
    for (const uin of entries) {
      if (!/^\d{5,12}$/.test(uin)) continue;
      const oriDir = `${baseDir}/${uin}/nt_qq/nt_data/Pic/${ym}/Ori`;
      if (!fs.existsSync(oriDir)) continue;
      const files = fs.readdirSync(oriDir);
      for (const fname of files) {
        const fullPath = `${oriDir}/${fname}`;
        let st = null;
        try {
          st = fs.statSync(fullPath);
        } catch (_) {
          continue;
        }
        if (!st || !st.isFile() || st.size < 256 || st.mtimeMs < sinceMs) continue;
        // 按文件名哈希去重（多 QQ 同群收到同一张图 MD5 文件名相同）
        const fileKey = `local_nt_${fname.toLowerCase()}`;
        if (results.some((x) => x.id === fileKey)) continue;
        results.push({
          id: fileKey,
          senderName: 'QQ群图片',
          groupId: '',
          localPath: fullPath,
          timestamp: st.mtimeMs,
        });
      }
    }
  } catch (_) {}
  return results;
}

// 当识别出有效学习通签到二维码后，自动匹配或使用 getActiveInfoWeb 直接定位班级，将所有同班级已登录账号一并签上
async function handleDetectedQrCodeText(qrText, meta = {}) {
  const parsed = parseQrInput(qrText);
  if (!parsed || !parsed.enc) return false;

  const dedupKey = `${parsed.id || 'any'}_${parsed.enc}`;
  if (processedQrEncKeys.has(dedupKey)) return false;

  const senderLabel = meta.senderName ? `[${meta.senderName}]` : '群内图片';
  sysLog('QR_WATCH', `从${senderLabel}识别到有效学习通签到二维码 (id=${parsed.id || '未知'}, enc=${parsed.enc.slice(0, 10)}...)`);

  // 0. 关键抢跑：一旦拿到二维码里的 id 与 c，第一时间替所有账号并发触发一次 getSignDetail(id, c) 预锁定服务端 10s 时间窗！
  if (parsed.id && parsed.code) {
    const preloadPromises = (store.accounts || []).map((acc) =>
      CXProtocol.getSignDetail(String(parsed.id), parsed.code, acc.uid).catch(() => null)
    );
    await Promise.all(preloadPromises);
  }

  // 1. 收集已知需要签到的二维码活动会话（未完成的协助会话 + 当前已探测到的活动）
  const candidateTargets = new Map(); // activeId -> { courseId, classId, cpi, courseName, activeId, activeName }

  for (const hs of store.helperSessions || []) {
    if (!hs.completed && hs.mode === 'sign' && hs.activeId) {
      if (hs.signType === 'qrCode' || (parsed.id && String(hs.activeId) === String(parsed.id))) {
        candidateTargets.set(String(hs.activeId), {
          courseId: hs.courseId,
          classId: hs.classId,
          cpi: hs.cpi,
          courseName: hs.courseName || '课程',
          activeId: String(hs.activeId),
          activeName: hs.activeName || '二维码签到',
          helperSession: hs,
        });
      }
    }
  }

  for (const item of lastDetectedActives || []) {
    const act = item.active || item;
    if (act && act.status && act.id) {
      if (act.signType === 'qrCode' || (parsed.id && String(act.id) === String(parsed.id))) {
        const aid = String(act.id);
        if (!candidateTargets.has(aid)) {
          candidateTargets.set(aid, {
            courseId: item.courseId,
            classId: item.classId,
            cpi: item.cpi,
            courseName: item.courseName || '课程',
            activeId: aid,
            activeName: act.name || '二维码签到',
          });
        }
      }
    }
  }

  // 2. 关键破局：若二维码自带活动 id（学习通标准二维码均含 id=2000...），直接调 getActiveInfoWeb(id) 秒查 clazzid！
  // 该接口完全不受 activelist 频控影响，哪怕活动监测被限流，照样 100% 精准定位班级并拉上同班所有账号一起签！
  if (parsed.id && !candidateTargets.has(String(parsed.id))) {
    const aid = String(parsed.id);
    const probeUid = store.currentUid || store.accounts?.[0]?.uid;
    try {
      const info = await CXProtocol.getActiveInfoWeb(aid, probeUid);
      if (info && (info.clazzid || info.classId)) {
        const targetClassId = String(info.clazzid || info.classId);
        let matchedCourse = null;
        for (const acc of store.accounts || []) {
          const eff = getEffectiveUserProfile(acc.uid);
          const found = (eff.coursesCache || []).find((c) => String(c.classId) === targetClassId);
          if (found) {
            matchedCourse = found;
            break;
          }
        }
        candidateTargets.set(aid, {
          courseId: matchedCourse ? String(matchedCourse.courseId) : String(info.courseId || ''),
          classId: targetClassId,
          cpi: matchedCourse ? String(matchedCourse.cpi || '') : '',
          courseName: matchedCourse ? matchedCourse.name : (info.courseName || '课堂课程'),
          activeId: aid,
          activeName: info.name || info.nameOne || '二维码签到',
        });
      }
    } catch (_) {}
  }

  // 3. 若二维码没有带 id 且当前无候选，才错峰扫描已启用监测的班级
  if (candidateTargets.size === 0) {
    const { enabledEntries } = await collectEnabledClassEntries(false);
    for (let idx = 0; idx < enabledEntries.length; idx++) {
      if (idx > 0) await sleepMs(450);
      const entry = enabledEntries[idx];
      const c = entry.course;
      let actives = null;
      const candUids = entry.memberUids && entry.memberUids.length > 0 ? entry.memberUids : [entry.scanUid];
      for (const u of candUids) {
        const tryCpi = (entry.memberCpis && entry.memberCpis[u]) || c.cpi;
        try {
          actives = await CXProtocol.getActiveList(c.courseId, c.classId, tryCpi, u);
          break;
        } catch (_) {}
      }
      if (!actives) continue;
      for (const act of actives) {
        if (!act.isSignActivity || !act.status) continue;
        if (act.signType === 'qrCode') {
          const aid = String(act.id);
          if (!candidateTargets.has(aid)) {
            candidateTargets.set(aid, {
              courseId: c.courseId,
              classId: c.classId,
              cpi: c.cpi,
              courseName: c.name,
              activeId: aid,
              activeName: act.name || '二维码签到',
            });
          }
        }
      }
    }
  }

  let targets = Array.from(candidateTargets.values());
  if (parsed.id && candidateTargets.has(String(parsed.id))) {
    targets = [candidateTargets.get(String(parsed.id))];
  }

  if (targets.length === 0) {
    sysLog('QR_WATCH', `已解析二维码 (enc=${parsed.enc.slice(0, 8)}...)，但未找到匹配的进行中签到活动`);
    return false;
  }

  // 只有找到了目标活动并实际发起签到后，才锁定该 enc（避免二维码先于活动探测到达时被过早丢弃）
  processedQrEncKeys.add(dedupKey);

  let anySigned = false;
  for (const t of targets) {
    const matchedAccounts = findMatchingAccountsForClass(t.courseId, t.classId, null);
    const targetUids = matchedAccounts.map((a) => a.uid);

    const record = await executeSignForActive({
      courseId: t.courseId,
      classId: t.classId,
      cpi: t.cpi,
      courseName: t.courseName,
      activeId: t.activeId,
      activeName: t.activeName,
      targetUids,
      signCode: parsed.code || null,
      enc: parsed.enc,
      qrUrl: qrText,
      triggerSource: `群聊二维码自动识别(${meta.senderName || '群图片'})`,
    });

    if (record && record.results && record.results.some((r) => r.ok)) {
      anySigned = true;
    }
  }

  return anySigned;
}

// 巡检未完成的签到活动（含手机 App 自己手动签成功、老师后台代签、或其他外部途径签成功），自动触发群聊合并提醒！
let lastExternalSyncAt = 0;
async function checkExternalSignCompletions() {
  const now = Date.now();
  if (now - lastExternalSyncAt < 12000) return; // 每 12 秒巡检一次外部签到状态
  lastExternalSyncAt = now;

  // 收集当前待完成/进行中的活动：未完成的协助会话 + 当前监测到的未全员签完活动
  const watchMap = new Map(); // activeId -> { courseId, classId, courseName, activeName, signTypeLabel, hsList: [] }
  for (const hs of store.helperSessions || []) {
    if (!hs.completed && hs.mode === 'sign' && hs.activeId && hs.expiresAt > now) {
      const aid = String(hs.activeId);
      if (!watchMap.has(aid)) {
        watchMap.set(aid, {
          activeId: aid,
          courseId: hs.courseId,
          classId: hs.classId,
          courseName: hs.courseName || '课程',
          activeName: hs.activeName || '课堂签到',
          signTypeLabel: SIGN_TYPE_LABEL[hs.signType] || hs.signType || '签到',
          hsList: [],
        });
      }
      watchMap.get(aid).hsList.push(hs);
    }
  }

  for (const item of lastDetectedActives || []) {
    const act = item.active || item;
    if (act && act.status && act.id) {
      const aid = String(act.id);
      if (!watchMap.has(aid)) {
        watchMap.set(aid, {
          activeId: aid,
          courseId: item.courseId,
          classId: item.classId,
          courseName: item.courseName || '课程',
          activeName: act.name || '课堂签到',
          signTypeLabel: SIGN_TYPE_LABEL[act.signType] || act.signType || '签到',
          hsList: [],
        });
      }
    }
  }

  for (const [aid, meta] of watchMap.entries()) {
    const accounts = findMatchingAccountsForClass(meta.courseId, meta.classId, null);
    if (accounts.length === 0) continue;

    const notifiedSet = notifiedAttendSuccessMap.get(aid) || new Set();
    const newlySigned = [];
    let allSigned = true;

    for (const acc of accounts) {
      try {
        const att = await CXProtocol.getAttendInfoWeb(aid, acc.uid);
        const signed = Number(att?.status ?? 0) === 1;
        if (signed) {
          if (!notifiedSet.has(String(acc.uid))) {
            newlySigned.push(acc);
          }
        } else {
          allSigned = false;
        }
      } catch (_) {
        allSigned = false;
      }
    }

    if (newlySigned.length > 0) {
      markAccountsNotifiedForActive(
        aid,
        newlySigned.map((a) => a.uid)
      );
      const mergedNames = newlySigned.map((a) => a.name || a.uid).join(' / ');
      const record = {
        id: `${aid}_ext_${Date.now()}`,
        time: new Date().toLocaleString('zh-CN', { hour12: false }),
        courseId: String(meta.courseId || ''),
        classId: String(meta.classId || ''),
        courseName: meta.courseName,
        activeId: aid,
        activeName: meta.activeName,
        signType: 'normal',
        signTypeLabel: meta.signTypeLabel,
        triggerSource: '外部/学习通端签到同步',
        helperShareUrl: null,
        results: newlySigned.map((a) => ({
          uid: a.uid,
          name: a.name || a.uid,
          ok: true,
          already: true,
          msg: '已签到成功',
        })),
      };

      store.signHistory = store.signHistory || [];
      store.signHistory.unshift(record);
      if (store.signHistory.length > 80) store.signHistory.pop();

      if (allSigned) {
        for (const hs of meta.hsList) {
          hs.completed = true;
          hs.lastResult = record;
        }
      }
      saveStore();

      if (store.napcat?.notifyOnComplete !== false) {
        const msgLines = [
          `[学习通签到成功] (状态同步)`,
          `课程：${meta.courseName}`,
          `活动：${meta.activeName} (${meta.signTypeLabel})`,
          `签到成功：${mergedNames}`,
        ];
        await broadcastNapCatWithRetry(msgLines.join('\n'), {
          eventType: 'sign_result',
          dedupKey: `ext_ok_${aid}_${newlySigned.map((a) => a.uid).sort().join(',')}`,
          eventData: {
            title: `签到成功《${meta.courseName}》`,
            targetNames: mergedNames,
            courseName: meta.courseName,
            activeName: meta.activeName,
            signTypeLabel: meta.signTypeLabel,
            triggerSource: '外部/学习通端签到同步',
            results: record.results,
          },
        });
      }
      sysLog('SIGN', `检测到《${meta.courseName}》外部/手动签到成功: ${mergedNames}`, { uids: newlySigned.map((a) => a.uid) });
    } else if (allSigned && meta.hsList.length > 0) {
      for (const hs of meta.hsList) {
        hs.completed = true;
      }
      saveStore();
    }
  }
}

async function processIncomingChatImageItem(img) {
  if (!img || !img.id || processedChatImageIds.has(img.id)) return false;
  let buf = null;
  if (img.base64) {
    buf = Buffer.from(img.base64, 'base64');
  } else if (img.localPath && fs.existsSync(img.localPath)) {
    buf = fs.readFileSync(img.localPath);
  } else if (img.url && img.url.startsWith('http')) {
    try {
      buf = await fetchRawBuffer(img.url);
    } catch (_) {}
  }
  if (!buf || buf.length < 128) return false;
  processedChatImageIds.add(img.id);

  const qrText = decodeQrFromImageBuffer(buf);
  if (!qrText) return false;

  const parsed = parseQrInput(qrText);
  const isChaoxingQr =
    qrText.includes('chaoxing.com') ||
    qrText.includes('enc=') ||
    /^[0-9A-Fa-f]{24,64}$/.test(qrText.trim());
  if (isChaoxingQr && parsed.enc) {
    return await handleDetectedQrCodeText(qrText, {
      senderName: img.senderName || img.userId || '群成员',
      groupId: img.groupId,
    });
  }
  return false;
}

async function pollGroupQrImagesOnce() {
  if (isWatchingQr) return;
  await flushNapCatRetryQueue();
  if (!store.accounts || store.accounts.length === 0) return;

  isWatchingQr = true;
  try {
    // 1. 先检查是否有手动/App端/外部途径完成的签到需要合并播报
    await checkExternalSignCompletions();

    const cfg = store.napcat || {};
    const groups = (cfg.groups || cfg.groupIds || []).map((g) => String(g).trim()).filter(Boolean);
    const since = Date.now() - 12 * 60 * 1000; // 检查最近 12 分钟内的群图片（不再受 inClass 门禁死锁）

    const imageCandidates = [];

    // 2. 从 NapCat Bridge 插件拉取群消息图片
    try {
      const endpoint = getNapCatRecentImagesEndpoint();
      const headers = {};
      if (cfg.accessToken) {
        headers['Authorization'] = `Bearer ${cfg.accessToken}`;
        headers['X-ISHIT-Token'] = cfg.accessToken;
      }
      const resp = await postJson(endpoint, { since, groups }, headers);
      if (Array.isArray(resp?.data?.images)) {
        imageCandidates.push(...resp.data.images);
      }
    } catch (_) {}

    // 3. 叠加本机 QQ NT 原图目录兜底扫描（防止机器人在断网重连窗口漏掉群图片事件）
    const localImgs = scanLocalQqNtRecentImages(since);
    imageCandidates.push(...localImgs);

    for (const img of imageCandidates) {
      await processIncomingChatImageItem(img);
    }
  } catch (_) {
  } finally {
    isWatchingQr = false;
  }
}

// 3 秒高频人数盯盘 + 1 分钟短时签到【临期压哨抢签】保护器
async function tickProtectedActivesWatcher() {
  if (isCheckingProtected || pendingThresholdWatchMap.size === 0) return;
  isCheckingProtected = true;
  try {
    for (const [aid, task] of Array.from(pendingThresholdWatchMap.entries())) {
      store.handledActiveKeys = store.handledActiveKeys || [];
      if (store.handledActiveKeys.includes(aid)) {
        pendingThresholdWatchMap.delete(aid);
        continue;
      }

      if (Date.now() - (task.firstSeenAt || 0) > 2 * 3600 * 1000) {
        pendingThresholdWatchMap.delete(aid);
        continue;
      }

      const remainingUids = (task.memberUids || []).filter((u) => !store.handledActiveKeys.includes(`${aid}_${u}`));
      if (remainingUids.length === 0) {
        pendingThresholdWatchMap.delete(aid);
        if (task.activeRef) task.activeRef.waitingThreshold = false;
        continue;
      }

      // 先检查是否有用户刚刚关闭了防钓鱼保护
      const disabledProtectUids = remainingUids.filter((u) => !getEffectiveScheduleForCxUid(u).signThresholdEnabled);
      if (disabledProtectUids.length > 0) {
        for (const u of disabledProtectUids) store.handledActiveKeys.push(`${aid}_${u}`);
        task.memberUids = remainingUids.filter((u) => !disabledProtectUids.includes(u));
        if (task.memberUids.length === 0) {
          pendingThresholdWatchMap.delete(aid);
          if (task.activeRef) task.activeRef.waitingThreshold = false;
          if (!store.handledActiveKeys.includes(aid)) store.handledActiveKeys.push(aid);
        }
        saveStore();
        await executeSignForActive({
          courseId: task.courseId,
          classId: task.classId,
          cpi: task.cpi,
          courseName: task.courseName,
          activeId: task.activeId,
          activeName: task.activeName,
          targetUids: disabledProtectUids,
          triggerSource: '关闭人数保护放行',
        });
        if (task.memberUids.length === 0) continue;
      }

      let stats = null;
      try {
        stats = await CXProtocol.getSignAttendStats(task.activeId, task.courseId, task.classId, task.probeUid);
      } catch (_) {
        continue;
      }
      if (!stats) continue;

      if (stats.endTimeMs > 0) task.endTimeMs = stats.endTimeMs;
      if (task.activeRef) {
        task.activeRef.signedCount = stats.signedCount;
        task.activeRef.totalCount = stats.totalCount;
        task.activeRef.signRatio = stats.signRatio;
      }

      if (stats.isOver) {
        pendingThresholdWatchMap.delete(aid);
        if (task.activeRef) task.activeRef.waitingThreshold = false;
        sysLog(
          'PROTECT',
          `[人数保护] 《${task.courseName}·${task.activeName}》已结束 (最终已签 ${stats.signedCount}/${stats.totalCount})，停止盯盘`,
          { uids: task.memberUids || [] }
        );
        continue;
      }

      const now = Date.now();
      const remainMs = task.endTimeMs > 0 ? task.endTimeMs - now : Infinity;
      const isDeadlineBuzzer =
        task.endTimeMs > 0 &&
        remainMs > -1500 &&
        remainMs <= 9500 &&
        (stats.signedCount >= 2 || stats.signRatio >= 0.05);

      const triggeredUids = [];
      let sampleThreshold = 0.3;
      for (const u of task.memberUids) {
        const uCfg = getEffectiveScheduleForCxUid(u);
        const tRatio = Math.max(0.01, Math.min(0.99, Number(uCfg.signThresholdRatio ?? 0.3)));
        sampleThreshold = tRatio;
        if ((stats.totalCount > 0 && stats.signRatio >= tRatio) || isDeadlineBuzzer) {
          triggeredUids.push(u);
        }
      }

      if (triggeredUids.length > 0) {
        for (const u of triggeredUids) {
          const uKey = `${aid}_${u}`;
          if (!store.handledActiveKeys.includes(uKey)) store.handledActiveKeys.push(uKey);
        }
        task.memberUids = task.memberUids.filter((u) => !triggeredUids.includes(u));
        if (task.memberUids.length === 0) {
          pendingThresholdWatchMap.delete(aid);
          if (task.activeRef) task.activeRef.waitingThreshold = false;
          if (!store.handledActiveKeys.includes(aid)) store.handledActiveKeys.push(aid);
        }
        saveStore();
        const reachedThreshold = !isDeadlineBuzzer || (stats.totalCount > 0 && stats.signRatio >= sampleThreshold);
        const reasonTag = reachedThreshold
          ? `人数达标 ${(stats.signRatio * 100).toFixed(1)}%>=${(sampleThreshold * 100).toFixed(0)}%`
          : `临期压哨抢签(剩${Math.max(0, (remainMs / 1000).toFixed(1))}s,已签${stats.signedCount}人)`;
        sysLog(
          'PROTECT',
          `[人数保护放行] 《${task.courseName}·${task.activeName}》触发 ${reasonTag}，立即为 ${triggeredUids.length} 个账号执行自动签到！`,
          { uids: triggeredUids }
        );
        await executeSignForActive({
          courseId: task.courseId,
          classId: task.classId,
          cpi: task.cpi,
          courseName: task.courseName,
          activeId: task.activeId,
          activeName: task.activeName,
          targetUids: triggeredUids,
          triggerSource: reachedThreshold ? '人数达标自动签' : '临期压哨抢签',
        });
      }
    }
  } catch (_) {
  } finally {
    isCheckingProtected = false;
  }
}

let immediatePollTimer = null;
async function runScheduledPollTick() {
  const summary = getGlobalScheduleSummary();
  if (summary.inClass) {
    const primaryUid = store.currentUid || store.accounts?.[0]?.uid;
    const st = primaryUid ? summary.perAccountStatus?.[primaryUid] : null;
    const modeLabel =
      st?.mode === 'test_only'
        ? '测试课程轮询'
        : store.schedule?.forcePolling
        ? '持续轮询'
        : '课表轮询';
    await pollCoursesOnce({ forceAll: false, triggerSource: modeLabel });
  }
}

function getEffectiveTimerIntervalSeconds() {
  const candidates = [Number(store.schedule?.intervalSeconds || 25)];
  for (const cfg of Object.values(store.userScheduleConfigs || {})) {
    if (cfg && cfg.masterEnabled !== false && cfg.intervalSeconds) {
      candidates.push(Number(cfg.intervalSeconds));
    }
  }
  const valid = candidates.filter((n) => !Number.isNaN(n) && n >= 10);
  return valid.length > 0 ? Math.max(10, Math.min(...valid)) : 25;
}

function restartScheduler(triggerImmediate = true) {
  if (pollTimer) clearInterval(pollTimer);
  const sec = getEffectiveTimerIntervalSeconds();
  pollTimer = setInterval(runScheduledPollTick, sec * 1000);
  if (triggerImmediate) {
    if (immediatePollTimer) clearTimeout(immediatePollTimer);
    immediatePollTimer = setTimeout(() => {
      runScheduledPollTick();
    }, 350);
  }

  if (qrWatchTimer) clearInterval(qrWatchTimer);
  qrWatchTimer = setInterval(() => {
    pollGroupQrImagesOnce();
  }, 2000);

  if (protectWatchTimer) clearInterval(protectWatchTimer);
  protectWatchTimer = setInterval(() => {
    tickProtectedActivesWatcher();
  }, 3000);
}

module.exports = {
  broadcastNapCat,
  createHelperSession,
  getHelperSession,
  solveSlideCaptchaX,
  autoSolveSlideCaptcha,
  executeSignForActive,
  findMatchingAccountsForClass,
  handleDetectedQrCodeText,
  processIncomingChatImageItem,
  pollGroupQrImagesOnce,
  getAccountActiveScheduleStatus,
  getGlobalScheduleSummary,
  pollCoursesOnce,
  restartScheduler,
  getEngineState: () => {
    const summary = getGlobalScheduleSummary();
    return {
      isScanning,
      lastPollTime,
      lastDetectedActives,
      inClass: summary.inClass,
      matchedSlot: summary.matchedSlot,
      perAccountStatus: summary.perAccountStatus,
    };
  },
};
