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

function isSafeExternalImageUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = (u.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (!host || host === 'localhost' || host === '::1' || host === '0.0.0.0') return false;
    if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return false;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return false;
    if (/^(fc|fd|fe80):/i.test(host)) return false;
    return true;
  } catch (_) {
    return false;
  }
}

function fetchRawBuffer(urlStr, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (!isSafeExternalImageUrl(urlStr)) {
      return reject(new Error('Blocked unsafe internal/invalid image URL'));
    }
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

function resizeRgbaNearest(src, srcW, srcH, dstW, dstH) {
  const w = Math.max(1, Math.round(dstW));
  const h = Math.max(1, Math.round(dstH));
  const dst = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(srcH - 1, Math.floor((y * srcH) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(srcW - 1, Math.floor((x * srcW) / w));
      const sOff = (sy * srcW + sx) * 4;
      const dOff = (y * w + x) * 4;
      dst[dOff] = src[sOff];
      dst[dOff + 1] = src[sOff + 1];
      dst[dOff + 2] = src[sOff + 2];
      dst[dOff + 3] = 255;
    }
  }
  return { rgba: dst, width: w, height: h };
}

function addWhiteBorderRgba(src, srcW, srcH, pad = 28) {
  const dstW = srcW + pad * 2;
  const dstH = srcH + pad * 2;
  const dst = new Uint8ClampedArray(dstW * dstH * 4);
  dst.fill(255);
  for (let y = 0; y < srcH; y++) {
    const srcRow = y * srcW * 4;
    const dstRow = ((y + pad) * dstW + pad) * 4;
    dst.set(src.subarray(srcRow, srcRow + srcW * 4), dstRow);
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

function adaptiveBinarizeRgba(src, w, h, radius = 14, offset = 7) {
  const n = w * h;
  const lum = new Uint8Array(n);
  const integral = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const o = idx * 4;
      const v = (src[o] * 77 + src[o + 1] * 150 + src[o + 2] * 29) >> 8;
      lum[idx] = v;
      rowSum += v;
      integral[(y + 1) * (w + 1) + (x + 1)] = integral[y * (w + 1) + (x + 1)] + rowSum;
    }
  }
  const dst = new Uint8ClampedArray(n * 4);
  for (let y = 0; y < h; y++) {
    const y1 = Math.max(0, y - radius);
    const y2 = Math.min(h - 1, y + radius);
    for (let x = 0; x < w; x++) {
      const x1 = Math.max(0, x - radius);
      const x2 = Math.min(w - 1, x + radius);
      const count = (x2 - x1 + 1) * (y2 - y1 + 1);
      const sum =
        integral[(y2 + 1) * (w + 1) + (x2 + 1)] -
        integral[y1 * (w + 1) + (x2 + 1)] -
        integral[(y2 + 1) * (w + 1) + x1] +
        integral[y1 * (w + 1) + x1];
      const idx = y * w + x;
      const c = lum[idx] * count < sum - offset * count ? 0 : 255;
      const o = idx * 4;
      dst[o] = c;
      dst[o + 1] = c;
      dst[o + 2] = c;
      dst[o + 3] = 255;
    }
  }
  return { rgba: dst, width: w, height: h };
}

function tryJsQrVariants(imgObj, includeAdaptive = true) {
  if (!imgObj || !imgObj.rgba || imgObj.width < 32 || imgObj.height < 32) return null;
  let qr = jsQR(imgObj.rgba, imgObj.width, imgObj.height, { inversionAttempts: "attemptBoth" });
  if (qr && qr.data) return qr.data.trim();

  // 加白边静区（解决紧贴二维码边缘截图无 Quiet Zone 无法定位 Finder Pattern 的问题）
  const pad = Math.max(16, Math.round(Math.min(imgObj.width, imgObj.height) * 0.08));
  const padded = addWhiteBorderRgba(imgObj.rgba, imgObj.width, imgObj.height, pad);
  qr = jsQR(padded.rgba, padded.width, padded.height, { inversionAttempts: "attemptBoth" });
  if (qr && qr.data) return qr.data.trim();

  // 局部积分图自适应阈值二值化（解决投影仪/屏幕偏色、反光、阴影不均）
  if (includeAdaptive) {
    const rad = Math.max(8, Math.round(Math.min(padded.width, padded.height) / 28));
    for (const off of [7, 2]) {
      const adap = adaptiveBinarizeRgba(padded.rgba, padded.width, padded.height, rad, off);
      qr = jsQR(adap.rgba, adap.width, adap.height, { inversionAttempts: "dontInvert" });
      if (qr && qr.data) return qr.data.trim();
    }
  }

  // 全局均值阈值二值化
  for (const f of [1.0, 0.88, 1.12]) {
    const bin = binarizeRgba(padded.rgba, padded.width, padded.height, f);
    qr = jsQR(bin.rgba, bin.width, bin.height, { inversionAttempts: "dontInvert" });
    if (qr && qr.data) return qr.data.trim();
  }
  return null;
}

function decodeQrFromImageBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
  try {
    let width = 0;
    let height = 0;
    let rgba = null;
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      const decoded = jpeg.decode(buf, { useTArray: true, maxResolutionInMP: 48, maxMemoryUsageInMB: 512 });
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
        const decoded = jpeg.decode(buf, { useTArray: true, maxResolutionInMP: 48, maxMemoryUsageInMB: 512 });
        width = decoded.width;
        height = decoded.height;
        rgba = new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength);
      } catch (_) {}
    }
    if (!rgba || !width || !height) return null;

    // 1. 多尺度归一化识别（覆盖高清原图、中等尺寸、抗摩尔纹降采样、以及小尺寸放大）
    const maxSide = Math.max(width, height);
    const targetMaxSides = [840, 540, 1200, 360];
    if (maxSide <= 1400) targetMaxSides.unshift(maxSide);
    const seenScales = new Set();
    for (const targetMax of targetMaxSides) {
      const scale = targetMax === maxSide ? 1 : targetMax / maxSide;
      const rw = Math.max(64, Math.round(width * scale));
      const rh = Math.max(64, Math.round(height * scale));
      const key = `${rw}x${rh}`;
      if (seenScales.has(key) || rw > 1600 || rh > 1600) continue;
      seenScales.add(key);
      const scaled = rw === width && rh === height
        ? { rgba, width, height }
        : resizeRgbaNearest(rgba, width, height, rw, rh);
      const hit = tryJsQrVariants(scaled, true);
      if (hit) return hit;
    }

    // 2. 局部裁剪识别（针对手机远拍大屏、二维码在画面局部区域的情况）
    const workMax = 960;
    const baseImg = maxSide > workMax
      ? resizeRgbaNearest(rgba, width, height, Math.round((width * workMax) / maxSide), Math.round((height * workMax) / maxSide))
      : { rgba, width, height };
    const side = Math.min(baseImg.width, baseImg.height);
    if (side >= 260) {
      for (const s of [0.72, 0.50]) {
        const cw = Math.floor(side * s);
        const ch = cw;
        if (cw < 160) continue;
        for (const [fx, fy] of [[0.5, 0.5], [0.5, 0.32], [0.32, 0.5], [0.68, 0.5]]) {
          const x0 = Math.min(baseImg.width - cw, Math.max(0, Math.floor(baseImg.width * fx - cw / 2)));
          const y0 = Math.min(baseImg.height - ch, Math.max(0, Math.floor(baseImg.height * fy - ch / 2)));
          const patch = cropRgba(baseImg.rgba, baseImg.width, baseImg.height, x0, y0, cw, ch);
          const hit = tryJsQrVariants(patch, false);
          if (hit) return hit;
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

const KNOWN_MISCONFIGURED_GROUP_MAP = {
  '1178498159': '1134393264',
};

function normalizeConfiguredGroups(rawList) {
  const arr = Array.isArray(rawList) ? rawList : [];
  const out = [];
  for (const item of arr) {
    let gid = String(item || '').trim();
    if (!gid) continue;
    if (KNOWN_MISCONFIGURED_GROUP_MAP[gid]) {
      gid = KNOWN_MISCONFIGURED_GROUP_MAP[gid];
    }
    if (!out.includes(gid)) out.push(gid);
  }
  return out;
}

function buildGroupAtMessage(baseMessage, groupId, relatedUids, cfg) {
  const bindingsForGroup =
    (cfg.groupBindings &&
      (cfg.groupBindings[String(groupId)] ||
        (String(groupId) === '1134393264' ? cfg.groupBindings['1178498159'] : null))) ||
    {};
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

  const groups = normalizeConfiguredGroups(cfg.groups || cfg.groupIds || []);
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
      let totalSent = 0;
      const allDetails = [];
      let lastReason = '';

      // 逐群发送携带该群专属 [CQ:at,qq=...] 后缀的 message，确保即使旧版 Bridge 插件未读取 groupMessages 也能 100% 触发 @ 通知！
      for (const gid of groups) {
        const finalGroupMsg = groupMessages[String(gid)] || message;
        const resp = await postJson(
          bridgeEndpoint,
          {
            eventType,
            message: finalGroupMsg,
            groups: [String(gid)],
            privateUsers: [],
            groupMessages: { [String(gid)]: finalGroupMsg },
            ...eventData,
          },
          headers
        );
        const data = resp.data || {};
        if (data.ok || data.sentCount > 0) {
          totalSent += Number(data.sentCount || 1);
        } else {
          lastReason = data.reason || data.message || lastReason;
        }
        if (Array.isArray(data.details)) allDetails.push(...data.details);
      }

      if (privateUsers.length > 0 || groups.length === 0) {
        const resp = await postJson(
          bridgeEndpoint,
          {
            eventType,
            message,
            groups: groups.length === 0 ? [] : [],
            privateUsers,
            groupMessages,
            ...eventData,
          },
          headers
        );
        const data = resp.data || {};
        if (data.ok || data.sentCount > 0) {
          totalSent += Number(data.sentCount || 1);
        } else {
          lastReason = data.reason || data.message || lastReason;
        }
        if (Array.isArray(data.details)) allDetails.push(...data.details);
      }

      if (totalSent > 0) {
        sysLog('NAPCAT', `Bridge 插件推送成功 (${eventType}): 发送 ${totalSent} 个目标`);
        return { sent: true, sentCount: totalSent, details: allDetails };
      }
      const reason = lastReason || '插件未返回成功状态（请检查是否配置了群号或私聊 QQ）';
      sysLog('WARN', `Bridge 插件响应: ${reason}`);
      return { sent: false, reason, details: allDetails };
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
      nextRetryAt: Date.now() + 14000,
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
      if (item.attempts >= 6) {
        pendingNapCatRetryQueue.splice(i, 1);
        sysLog('WARN', '补偿队列群聊通知重试满 6 次仍失败，已放弃该条消息');
      } else {
        item.nextRetryAt = Date.now() + 15000;
      }
    }
  }
}

// ============================================================================
// 2. 协助链接会话管理
// ============================================================================
// 查找指定班级 (classId/courseId) 涵盖的所有已登录账号
// SSOT: 检查单个已登录账号针对指定课程/班级是否开启了自动签到/轮询
function isAccountAutoSignEnabledForCourse(uid, courseId, classId) {
  const accCfg = getEffectiveScheduleForCxUid(uid);
  const eff = getEffectiveUserProfile(uid);
  const courses = eff.coursesCache || [];
  const matchedCourse = courses.find(
    (c) =>
      (classId && String(c.classId) === String(classId)) ||
      (courseId && String(c.courseId) === String(courseId))
  );
  const resolvedCourseId = matchedCourse ? String(matchedCourse.courseId) : (courseId ? String(courseId) : "");
  const st = resolvedCourseId ? eff.courseSettings?.[resolvedCourseId] : null;

  // 测试课程拥有独立最高优先级，由 testPollingEnabled 独立控制
  if (st?.isTestCourse) {
    return st.testPollingEnabled !== false;
  }

  // 常规课程：必须开启账号轮询总开关 masterEnabled
  if (!accCfg.masterEnabled) {
    return false;
  }

  // 若非持续轮询模式，则尊重单门课程的 pollingEnabled 开关
  if (!accCfg.forcePolling && st && st.pollingEnabled === false) {
    return false;
  }

  return true;
}

function findMatchingAccountsForClass(courseId, classId, explicitTargetUids = null, options = {}) {
  const { onlyAutoSignEnabled = false } = options || {};
  const allAccounts = store.accounts || [];
  if (Array.isArray(explicitTargetUids)) {
    const targetSet = new Set(explicitTargetUids.map(String));
    return allAccounts.filter((u) => targetSet.has(String(u.uid)));
  }
  if (!classId && !courseId) {
    return onlyAutoSignEnabled
      ? allAccounts.filter((u) => isAccountAutoSignEnabledForCourse(u.uid, courseId, classId))
      : allAccounts;
  }
  const matched = allAccounts.filter((u) => {
    const eff = getEffectiveUserProfile(u.uid);
    const list = eff.coursesCache || [];
    if (list.length === 0) return !onlyAutoSignEnabled;
    return list.some(
      (c) =>
        (classId && String(c.classId) === String(classId)) ||
        (!classId && courseId && String(c.courseId) === String(courseId))
    );
  });
  if (onlyAutoSignEnabled) {
    return matched.filter((u) => isAccountAutoSignEnabledForCourse(u.uid, courseId, classId));
  }
  return matched.length > 0 ? matched : allAccounts;
}

function getPublicBaseUrlClean() {
  let rawBaseUrl = String(store.napcat?.publicBaseUrl || 'https://ishit.pw').trim();
  if (!rawBaseUrl || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/.*)?$/i.test(rawBaseUrl)) {
    rawBaseUrl = 'https://ishit.pw';
  } else if (!/^https?:\/\//i.test(rawBaseUrl)) {
    rawBaseUrl = `https://${rawBaseUrl}`;
  }
  rawBaseUrl = rawBaseUrl.replace(/^http:\/\/ishit\.pw\b/i, 'https://ishit.pw');
  return rawBaseUrl.replace(/\/+$/, '');
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
  signTypeLabel = '',
  targetUids = [],
  targetNames = [],
  pendingUids = null,
  pendingNames = null,
  succeededUids = [],
  succeededNames = [],
  designatedPlace = '',
  locationRange = '',
  needLocation = false,
  needPhoto = false,
  endTimeMs = 0,
  signedCount = 0,
  totalCount = 0,
  waitingThreshold = false,
  captchaKey = null,
  creatorUsername = '',
  creatorRole = 'admin',
  ttlMinutes = 45,
}) {
  store.helperSessions = (store.helperSessions || []).filter((s) => s.expiresAt > Date.now());

  if ((mode === 'sign' || mode === 'captcha') && activeId) {
    const existing = store.helperSessions.find(
      (s) => (s.mode === 'sign' || s.mode === 'captcha') && String(s.activeId) === String(activeId) && !s.completed
    );
    if (existing) {
      const mergedUids = [...new Set([...(existing.targetUids || []), ...(targetUids || [])].map(String))];
      const mergedNames = [...new Set([...(existing.targetNames || []), ...(targetNames || [])])];
      existing.targetUids = mergedUids;
      existing.targetNames = mergedNames;
      if (Array.isArray(pendingUids)) existing.pendingUids = pendingUids.map(String);
      if (Array.isArray(pendingNames)) existing.pendingNames = pendingNames;
      if (Array.isArray(succeededUids) && succeededUids.length > 0) {
        existing.succeededUids = [...new Set([...(existing.succeededUids || []), ...succeededUids.map(String)])];
      }
      if (Array.isArray(succeededNames) && succeededNames.length > 0) {
        existing.succeededNames = [...new Set([...(existing.succeededNames || []), ...succeededNames])];
      }
      if (title) existing.title = title;
      if (signType) existing.signType = signType;
      if (signTypeLabel) existing.signTypeLabel = signTypeLabel;
      if (designatedPlace) existing.designatedPlace = designatedPlace;
      if (locationRange) existing.locationRange = locationRange;
      if (needLocation !== undefined) existing.needLocation = Boolean(needLocation || existing.needLocation);
      if (needPhoto !== undefined) existing.needPhoto = Boolean(needPhoto || existing.needPhoto);
      if (endTimeMs > 0) existing.endTimeMs = Number(endTimeMs);
      if (totalCount > 0) {
        existing.signedCount = Number(signedCount || 0);
        existing.totalCount = Number(totalCount || 0);
      }
      existing.waitingThreshold = Boolean(waitingThreshold);
      if (captchaKey) {
        existing.captchaKey = captchaKey;
        existing.mode = 'captcha';
      }
      existing.updatedAt = Date.now();
      existing.expiresAt = Date.now() + ttlMinutes * 60 * 1000;
      saveStore();
      return existing;
    }
  }

  const token = EncryptionUtil.getUniqueId();
  const cleanTargetUids = (targetUids || []).map(String);
  const session = {
    token,
    mode,
    title,
    courseId: String(courseId),
    classId: String(classId),
    cpi: String(cpi),
    courseName,
    activeId: String(activeId),
    activeName,
    signType,
    signTypeLabel: signTypeLabel || SIGN_TYPE_LABEL[signType] || signType,
    targetUids: cleanTargetUids,
    targetNames: targetNames || [],
    pendingUids: Array.isArray(pendingUids) ? pendingUids.map(String) : cleanTargetUids,
    pendingNames: Array.isArray(pendingNames) ? pendingNames : (targetNames || []),
    succeededUids: Array.isArray(succeededUids) ? succeededUids.map(String) : [],
    succeededNames: Array.isArray(succeededNames) ? succeededNames : [],
    creditedUids: [],
    designatedPlace: String(designatedPlace || ''),
    locationRange: String(locationRange || ''),
    needLocation: Boolean(needLocation || designatedPlace || signType === 'location'),
    needPhoto: Boolean(needPhoto || signType === 'photo'),
    endTimeMs: Number(endTimeMs || 0),
    signedCount: Number(signedCount || 0),
    totalCount: Number(totalCount || 0),
    waitingThreshold: Boolean(waitingThreshold),
    captchaKey,
    creatorUsername: String(creatorUsername || ''),
    creatorRole: String(creatorRole || 'admin'),
    createdAt: Date.now(),
    updatedAt: Date.now(),
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

// 跨端强提醒实时事件总线（覆盖：签到发现、签到成功、签到失败/需悬赏协助）
function pushRealtimeSignAlert({
  eventType = 'sign_detected', // 'sign_detected' | 'sign_success' | 'sign_failed'
  title = '',
  body = '',
  courseId = '',
  classId = '',
  courseName = '',
  activeId = '',
  activeName = '',
  signType = 'normal',
  signTypeLabel = '',
  targetUids = [],
  targetNames = [],
  helperToken = '',
  shareUrl = '',
  urgent = true,
  dedupKey = '',
}) {
  store.recentAlerts = Array.isArray(store.recentAlerts) ? store.recentAlerts : [];
  const now = Date.now();
  if (dedupKey) {
    const dup = store.recentAlerts.find((a) => a.dedupKey === dedupKey && now - (a.timeMs || 0) < 90 * 1000);
    if (dup) return dup;
  }
  const alertItem = {
    id: `alert_${now}_${Math.random().toString(36).slice(2, 7)}`,
    dedupKey: dedupKey || `${eventType}_${activeId}_${now}`,
    eventType,
    timeMs: now,
    time: new Date(now).toLocaleTimeString('zh-CN', { hour12: false }),
    title: String(title || '学习通签到通知'),
    body: String(body || ''),
    courseId: String(courseId || ''),
    classId: String(classId || ''),
    courseName: String(courseName || ''),
    activeId: String(activeId || ''),
    activeName: String(activeName || ''),
    signType: String(signType || 'normal'),
    signTypeLabel: String(signTypeLabel || SIGN_TYPE_LABEL[signType] || signType),
    targetUids: (targetUids || []).map(String),
    targetNames: (targetNames || []).map(String),
    helperToken: String(helperToken || ''),
    shareUrl: String(shareUrl || ''),
    urgent: Boolean(urgent),
  };
  store.recentAlerts.unshift(alertItem);
  if (store.recentAlerts.length > 80) {
    store.recentAlerts = store.recentAlerts.slice(0, 80);
  }
  saveStore();
  return alertItem;
}

// 签到大师排行榜积分结算（以学号 studentId 为唯一主键 SSOT，支持同一学号绑定多个曾用名称/称号）
function creditHelperPointsToStudent({
  studentId = '',
  helperName = '',
  cxAccount = null,
  points = 0,
  activeId = '',
  courseName = '',
}) {
  const pts = Math.max(0, Number(points || 0));
  if (pts <= 0) return null;
  store.helperLeaderboard = store.helperLeaderboard || {};

  let matchedAcc = cxAccount;
  const cleanSid = String(studentId || cxAccount?.studentId || '').trim();
  if (!matchedAcc && cleanSid) {
    matchedAcc = (store.accounts || []).find(
      (a) => a && (String(a.studentId || '').trim() === cleanSid || String(a.uid) === cleanSid)
    );
  }
  const key = cleanSid || String(matchedAcc?.studentId || matchedAcc?.uid || helperName || 'anonymous').trim();
  if (!key) return null;

  const existing = store.helperLeaderboard[key] || {
    key,
    studentId: cleanSid || String(matchedAcc?.studentId || ''),
    boundUid: String(matchedAcc?.uid || ''),
    cxName: String(matchedAcc?.name || ''),
    avatar: String(matchedAcc?.avatar || ''),
    school: String(matchedAcc?.school || ''),
    names: [],
    score: 0,
    assistCount: 0,
    lastAssistAt: 0,
    lastCourseName: '',
  };

  if (cleanSid) existing.studentId = cleanSid;
  if (matchedAcc) {
    existing.boundUid = String(matchedAcc.uid || existing.boundUid || '');
    existing.cxName = String(matchedAcc.name || existing.cxName || '');
    existing.avatar = String(matchedAcc.avatar || existing.avatar || '');
    existing.school = String(matchedAcc.school || existing.school || '');
    if (matchedAcc.studentId && !existing.studentId) existing.studentId = String(matchedAcc.studentId);
  }

  const customAlias = String(helperName || '').trim();
  const cxAlias = String(matchedAcc?.name || '').trim();
  existing.names = Array.isArray(existing.names) ? existing.names : [];
  if (customAlias) {
    existing.names = [customAlias, ...existing.names.filter((n) => n && n !== customAlias)];
    existing.preferredName = customAlias;
  }
  if (cxAlias && !existing.names.includes(cxAlias)) {
    existing.names.push(cxAlias);
  }

  existing.score = Number(existing.score || 0) + pts;
  existing.assistCount = Number(existing.assistCount || 0) + 1;
  existing.lastAssistAt = Date.now();
  if (courseName) existing.lastCourseName = String(courseName);

  store.helperLeaderboard[key] = existing;
  saveStore();
  return existing;
}

function getFormattedBountyHistory(limit = 50) {
  store.bountyHistory = Array.isArray(store.bountyHistory) ? store.bountyHistory : [];
  return store.bountyHistory.slice(0, limit);
}

function claimHelperPointsByToken({ claimToken = '', helperName = '', studentId = '', commentText = '', commentImage = '' }) {
  store.helperClaims = store.helperClaims || {};
  store.bountyHistory = Array.isArray(store.bountyHistory) ? store.bountyHistory : [];
  const tokenKey = String(claimToken || '').trim();
  const claim = store.helperClaims[tokenKey];
  if (!claim) return { ok: false, msg: '积分认领凭证不存在或已失效' };
  const cleanSid = String(studentId || claim.claimedByStudentId || '').trim();
  const cleanName = String(helperName || '').trim().slice(0, 40);
  const cleanComment = String(commentText || '').trim().slice(0, 300);
  const cleanImg = String(commentImage || '').trim();

  let histRec = store.bountyHistory.find((h) => h && (h.claimToken === tokenKey || h.id === tokenKey));
  if (!histRec && claim.activeId) {
    histRec = store.bountyHistory.find((h) => h && String(h.activeId) === String(claim.activeId));
  }
  if (!histRec && (cleanComment || cleanImg || cleanName || cleanSid)) {
    histRec = {
      id: tokenKey,
      claimToken: tokenKey,
      timeMs: Number(claim.createdAt || Date.now()),
      courseId: "",
      classId: "",
      courseName: claim.courseName || "协助课程",
      activeId: claim.activeId || "",
      activeName: "课堂签到",
      signType: "normal",
      helperName: cleanName || claim.claimedByName || cleanSid || "热心同学",
      helperCxName: "",
      helperStudentId: cleanSid || String(claim.claimedByStudentId || ""),
      helperAvatar: "",
      isLoggedInHelper: Boolean(claim.lockedIdentity),
      signedNames: Array.isArray(claim.helpedNames) ? claim.helpedNames : [],
      earnedPoints: Number(claim.points || 0),
      pointsClaimed: Boolean(claim.claimed || cleanSid),
      commentText: "",
      commentImage: "",
    };
    store.bountyHistory.unshift(histRec);
    if (store.bountyHistory.length > 100) store.bountyHistory.length = 100;
  }

  // 已自动入榜（如已登录 ISHIT 主账号）或已认领过同一学号：锁定身份，仅更新留言/图片（未锁定时允许更新称号）
  if (claim.claimed) {
    if (claim.claimedByStudentId && cleanSid && String(claim.claimedByStudentId) !== cleanSid) {
      return { ok: false, msg: '该次协助积分已被认领，请勿重复提交' };
    }
    const targetSid = String(claim.claimedByStudentId || cleanSid || '').trim();
    store.helperLeaderboard = store.helperLeaderboard || {};
    const existing = targetSid ? store.helperLeaderboard[targetSid] : null;
    if (!claim.lockedIdentity && existing && cleanName) {
      existing.names = [cleanName, ...(existing.names || []).filter((n) => n && n !== cleanName)];
      existing.preferredName = cleanName;
      claim.claimedByName = cleanName;
      if (histRec) histRec.helperName = cleanName;
    }
    if (cleanComment) {
      claim.commentText = cleanComment;
      if (histRec) histRec.commentText = cleanComment;
    }
    if (cleanImg) {
      claim.commentImage = cleanImg;
      if (histRec) histRec.commentImage = cleanImg;
    }
    saveStore();
    const formatted = targetSid
      ? getFormattedLeaderboard().find((e) => String(e.studentId) === targetSid || String(e.key) === targetSid)
      : null;
    return {
      ok: true,
      entry: formatted || existing || null,
      points: Number(claim.points || 0),
      updatedAliasOnly: true,
      bountyHistory: getFormattedBountyHistory(),
    };
  }

  // 未登录用户：如果没填学号，但填了留言/图片/昵称，允许仅保存留言记录
  if (!cleanSid) {
    if (!cleanComment && !cleanImg && !cleanName) {
      return { ok: false, msg: '请填写学号以认领积分，或填写留言内容' };
    }
    if (cleanName) {
      claim.claimedByName = cleanName;
      if (histRec) histRec.helperName = cleanName;
    }
    if (cleanComment) {
      claim.commentText = cleanComment;
      if (histRec) histRec.commentText = cleanComment;
    }
    if (cleanImg) {
      claim.commentImage = cleanImg;
      if (histRec) histRec.commentImage = cleanImg;
    }
    saveStore();
    return {
      ok: true,
      entry: null,
      points: 0,
      commentSavedOnly: true,
      bountyHistory: getFormattedBountyHistory(),
    };
  }

  const entry = creditHelperPointsToStudent({
    studentId: cleanSid,
    helperName: cleanName || cleanSid,
    points: Number(claim.points || 0),
    activeId: claim.activeId,
    courseName: claim.courseName,
  });
  claim.claimed = true;
  claim.claimedByStudentId = cleanSid;
  claim.claimedByName = cleanName || cleanSid;
  claim.claimedAt = Date.now();
  if (cleanComment) claim.commentText = cleanComment;
  if (cleanImg) claim.commentImage = cleanImg;

  if (histRec) {
    histRec.helperName = cleanName || entry?.displayName || cleanSid;
    histRec.helperStudentId = cleanSid;
    histRec.pointsClaimed = true;
    if (cleanComment) histRec.commentText = cleanComment;
    if (cleanImg) histRec.commentImage = cleanImg;
  }

  saveStore();
  const formatted = getFormattedLeaderboard().find((e) => String(e.studentId) === cleanSid || String(e.key) === cleanSid);
  return {
    ok: true,
    entry: formatted || entry,
    points: Number(claim.points || 0),
    bountyHistory: getFormattedBountyHistory(),
  };
}

function getFormattedLeaderboard() {
  store.helperLeaderboard = store.helperLeaderboard || {};
  const accounts = store.accounts || [];
  const entries = Object.values(store.helperLeaderboard).map((item) => {
    const sid = String(item.studentId || '').trim();
    const uid = String(item.boundUid || '').trim();
    const matchedAcc = accounts.find(
      (a) => (uid && String(a.uid) === uid) || (sid && String(a.studentId || '').trim() === sid)
    );
    const cxName = matchedAcc?.name || item.cxName || '';
    const names = Array.isArray(item.names) ? [...item.names] : [];
    if (cxName && !names.includes(cxName)) names.push(cxName);
    const preferred = item.preferredName || names[0] || cxName || sid || '匿名侠客';
    return {
      key: item.key || sid || uid,
      studentId: sid || matchedAcc?.studentId || '',
      boundUid: matchedAcc?.uid || uid || '',
      cxName: cxName || names[0] || '匿名侠客',
      displayName: preferred,
      names,
      avatar: matchedAcc?.avatar || item.avatar || (matchedAcc?.uid ? `https://photo.chaoxing.com/p/${matchedAcc.uid}_80` : ''),
      school: matchedAcc?.school || item.school || '',
      score: Number(item.score || 0),
      assistCount: Number(item.assistCount || 0),
      lastAssistAt: Number(item.lastAssistAt || 0),
      lastCourseName: item.lastCourseName || '',
    };
  });
  entries.sort((a, b) => b.score - a.score || b.assistCount - a.assistCount || b.lastAssistAt - a.lastAssistAt);
  return entries.map((e, idx) => ({ ...e, rank: idx + 1 }));
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
  const teacherGdLat = parseValidCoord(activeInfo.locationLatitude_gd, contentObj.locationLatitude_gd);
  const teacherGdLng = parseValidCoord(activeInfo.locationLongitude_gd, contentObj.locationLongitude_gd);
  const teacherRangeM = Number(String(activeInfo.locationRange || contentObj.locationRange || '').replace(/[^\d.]/g, '')) || 100;

  const calcBdDistanceM = (lat1, lng1, lat2, lng2) => {
    const R = 6371000;
    const dLat = ((lat1 - lat2) * Math.PI) / 180;
    const dLng = ((lng1 - lng2) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat2 * Math.PI) / 180) * Math.cos((lat1 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(Math.max(0, Math.min(1, a))));
  };

  const hasManualCoord =
    latitude !== null && latitude !== undefined && latitude !== '' &&
    longitude !== null && longitude !== undefined && longitude !== '';
  const hasTeacherCoord = (teacherBdLat !== null && teacherBdLng !== null) || (teacherGdLat !== null && teacherGdLng !== null);

  const randomOffsetEnabled =
    courseSetting?.randomOffsetEnabled !== undefined
      ? Boolean(courseSetting.randomOffsetEnabled)
      : effProfile?.locationRandomOffsetEnabled !== false;
  const rawOffsetM =
    courseSetting?.randomOffsetMeters !== undefined
      ? Number(courseSetting.randomOffsetMeters)
      : Number(effProfile?.locationRandomOffsetMeters ?? 15);
  const randomOffsetMeters = Number.isFinite(rawOffsetM) && rawOffsetM >= 0 ? Math.min(500, rawOffsetM) : 15;

  const applyMeterJitter = (lat, lng, maxMeters) => {
    if (!Number.isFinite(maxMeters) || maxMeters <= 0) return { lat, lng };
    const r = maxMeters * Math.sqrt(Math.random());
    const theta = Math.random() * 2 * Math.PI;
    const dNorthM = r * Math.cos(theta);
    const dEastM = r * Math.sin(theta);
    const metersPerDegLat = 111320;
    const metersPerDegLng = 111320 * Math.max(0.2, Math.cos((lat * Math.PI) / 180));
    return {
      lat: lat + dNorthM / metersPerDegLat,
      lng: lng + dEastM / metersPerDegLng,
    };
  };

  let targetBdLat = teacherBdLat;
  let targetBdLng = teacherBdLng;
  if ((targetBdLat === null || targetBdLng === null) && teacherGdLat !== null && teacherGdLng !== null) {
    const bdFromGd = CXProtocol.gcj02ToBd09(teacherGdLat, teacherGdLng);
    targetBdLat = bdFromGd.lat;
    targetBdLng = bdFromGd.lng;
  }

  let resolvedAddress = address || designatedPlace || courseSetting?.location?.address || userDefLoc.address || '教学楼';
  let resolvedLat = null;
  let resolvedLng = null;
  let coordSystem = 'wgs84';

  if (hasManualCoord) {
    resolvedLat = Number(latitude);
    resolvedLng = Number(longitude);
    coordSystem = 'wgs84';
    resolvedAddress = address || designatedPlace || courseSetting?.location?.address || userDefLoc.address || '教学楼';
  } else if (hasTeacherCoord && targetBdLat !== null && targetBdLng !== null) {
    // 教师活动明确下发了目标靶心坐标：计算课程预设坐标是否在允许半径内，若超出则锁死教师靶心坐标
    let useCoursePreset = false;
    if (courseSetting?.location?.latitude && courseSetting?.location?.longitude) {
      const presetBd = CXProtocol.wgs84ToBd09(Number(courseSetting.location.latitude), Number(courseSetting.location.longitude));
      const distM = calcBdDistanceM(presetBd.lat, presetBd.lng, targetBdLat, targetBdLng);
      if (distM <= Math.max(15, teacherRangeM - 10)) {
        useCoursePreset = true;
      }
    }

    if (useCoursePreset) {
      resolvedLat = Number(courseSetting.location.latitude);
      resolvedLng = Number(courseSetting.location.longitude);
      coordSystem = 'wgs84';
      resolvedAddress = address || courseSetting?.location?.address || designatedPlace || userDefLoc.address || '教学楼';
    } else {
      resolvedLat = targetBdLat;
      resolvedLng = targetBdLng;
      coordSystem = 'bd09';
      resolvedAddress = address || designatedPlace || courseSetting?.location?.address || userDefLoc.address || '教学楼';
    }
  } else if (courseSetting?.location?.latitude && courseSetting?.location?.longitude) {
    resolvedLat = Number(courseSetting.location.latitude);
    resolvedLng = Number(courseSetting.location.longitude);
    coordSystem = 'wgs84';
    resolvedAddress = address || courseSetting?.location?.address || designatedPlace || userDefLoc.address || '教学楼';
  } else {
    resolvedLat = Number(userDefLoc.latitude ?? 30.8328);
    resolvedLng = Number(userDefLoc.longitude ?? 121.5035);
    coordSystem = 'wgs84';
  }

  // 无论使用预设位置、默认位置、浏览器自动定位还是教师靶心自动定位，统一按账号独立施加随机米数偏差防雷同
  if (randomOffsetEnabled && randomOffsetMeters > 0 && Number.isFinite(resolvedLat) && Number.isFinite(resolvedLng)) {
    const jittered = applyMeterJitter(resolvedLat, resolvedLng, randomOffsetMeters);
    if (hasTeacherCoord && targetBdLat !== null && targetBdLng !== null && teacherRangeM > 0) {
      const safeFenceM = Math.max(3, teacherRangeM - 4);
      const baseBd = coordSystem === 'bd09' ? { lat: resolvedLat, lng: resolvedLng } : CXProtocol.wgs84ToBd09(resolvedLat, resolvedLng);
      const baseDistM = calcBdDistanceM(baseBd.lat, baseBd.lng, targetBdLat, targetBdLng);
      const candBd = coordSystem === 'bd09' ? jittered : CXProtocol.wgs84ToBd09(jittered.lat, jittered.lng);
      const candDistM = calcBdDistanceM(candBd.lat, candBd.lng, targetBdLat, targetBdLng);

      if (baseDistM <= safeFenceM && candDistM > safeFenceM) {
        // 若基准点本在教师允许围栏内而随机偏差越界，则沿教师靶心安全半径内重采样，绝不因随机偏差导致超出范围
        const clampedCenterJitter = applyMeterJitter(targetBdLat, targetBdLng, Math.min(randomOffsetMeters, safeFenceM));
        resolvedLat = clampedCenterJitter.lat;
        resolvedLng = clampedCenterJitter.lng;
        coordSystem = 'bd09';
      } else {
        resolvedLat = jittered.lat;
        resolvedLng = jittered.lng;
      }
    } else {
      resolvedLat = jittered.lat;
      resolvedLng = jittered.lng;
    }
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

      let respStr = await performSingleAccountSign({
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

      // 自愈兜底：若因手动传入坐标偏移触发 errorLocation，立即剥离自定义坐标并对齐教师靶心坐标重签一次
      if (respStr.startsWith('errorLocation')) {
        sysLog('WARN', `账号[${user.name || user.uid}] 位置偏差(${respStr})，正在强制锁定教师靶心坐标重签...`, { uids: [user.uid] });
        respStr = await performSingleAccountSign({
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
          address: designatedPlace || null,
          latitude: null,
          longitude: null,
          objectId,
        });
      }

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
  let activeHelperToken = '';
  const succeededUsers = results.filter((r) => r.ok);
  const failedUsers = results.filter((r) => !r.ok);
  const pendingHelperUsers = failedUsers;
  const mergedNamesStr = (pendingHelperUsers.length > 0 ? pendingHelperUsers : accounts)
    .map((u) => u.name || u.uid)
    .join('/');
  const signTypeLabelResolved = needPhoto && signType === 'normal' ? '拍照签到' : (SIGN_TYPE_LABEL[signType] || signType);

  // 零延迟高同步：只要存在任何未签成功账号（无论扫码/手势/定位失败/滑块/拍照/未知原因），立即上榜签到悬赏大厅
  if (needHelperFlag || pendingHelperUsers.length > 0) {
    const hs = createHelperSession({
      mode: needCaptchaKey ? 'captcha' : 'sign',
      title: needCaptchaKey
        ? `帮 ${mergedNamesStr} 完成《${courseName}》滑块验证`
        : `帮 ${mergedNamesStr} 签到《${courseName}》(${signTypeLabelResolved})`,
      courseId,
      classId,
      cpi,
      courseName,
      activeId,
      activeName,
      signType,
      signTypeLabel: signTypeLabelResolved,
      targetUids: accounts.map((u) => u.uid),
      targetNames: accounts.map((u) => u.name || u.uid),
      pendingUids: pendingHelperUsers.map((u) => u.uid),
      pendingNames: pendingHelperUsers.map((u) => u.name || u.uid),
      succeededUids: succeededUsers.map((u) => u.uid),
      succeededNames: succeededUsers.map((u) => u.name || u.uid),
      designatedPlace,
      locationRange,
      needLocation: Boolean(designatedPlace || signType === 'location'),
      needPhoto,
      endTimeMs: Number(activeInfo.endTime || activeInfo.endtime || 0),
      waitingThreshold: false,
      captchaKey: needCaptchaKey,
    });
    activeHelperToken = hs.token;
    const baseUrl = getPublicBaseUrlClean();
    helperShareUrl = `${baseUrl}/?help=${hs.token}`;
  }

  if (succeededUsers.length > 0) {
    markAccountsNotifiedForActive(
      activeId,
      succeededUsers.map((u) => u.uid)
    );
  }

  // 只要本次所有账号均已签到成功，自动将该活动的未完成协助会话标记为已完成，并实时同步活动监测列表
  if (succeededUsers.length > 0 && failedUsers.length === 0) {
    for (const hs of store.helperSessions || []) {
      if (!hs.completed && String(hs.activeId) === String(activeId)) {
        hs.completed = true;
        hs.closeReason = '全部已签到完成';
      }
    }
    markActiveFullyCompleted(activeId);
    lastDetectedActives = (lastDetectedActives || []).filter(
      (it) => String((it.active || it)?.id) !== String(activeId)
    );
  } else {
    for (const it of lastDetectedActives || []) {
      const act = it.active || it;
      if (String(act?.id) === String(activeId)) {
        it.pendingUids = failedUsers.map((u) => String(u.uid));
        it.pendingNames = failedUsers.map((u) => u.name || u.uid);
        it.succeededUids = succeededUsers.map((u) => String(u.uid));
        it.succeededNames = succeededUsers.map((u) => u.name || u.uid);
        it.helperToken = activeHelperToken || it.helperToken || '';
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

  // 实时强通知：签到成功 & 签到失败（含待协助）均独立推送到用户端通知总线
  const newlySucceededAlertUsers = succeededUsers.filter((r) => !r.already);
  if (newlySucceededAlertUsers.length > 0) {
    const okNames = newlySucceededAlertUsers.map((r) => r.name || r.uid);
    pushRealtimeSignAlert({
      eventType: 'sign_success',
      title: `签到成功：《${courseName}》`,
      body: `${activeName} (${record.signTypeLabel}) · 已签上：${okNames.join(' / ')}`,
      courseId,
      classId,
      courseName,
      activeId,
      activeName,
      signType,
      signTypeLabel: record.signTypeLabel,
      targetUids: newlySucceededAlertUsers.map((r) => r.uid),
      targetNames: okNames,
      helperToken: activeHelperToken,
      shareUrl: helperShareUrl || '',
      urgent: false,
      dedupKey: `ok_${activeId}_${newlySucceededAlertUsers.map((r) => r.uid).sort().join(',')}`,
    });
  }
  if (failedUsers.length > 0) {
    const failNames = failedUsers.map((r) => r.name || r.uid);
    const failReasons = Array.from(new Set(failedUsers.map((r) => r.msg || '需人工协助'))).slice(0, 2).join('；');
    pushRealtimeSignAlert({
      eventType: 'sign_failed',
      title: `签到未通过：《${courseName}》`,
      body: `${activeName} (${record.signTypeLabel}) · 未签上：${failNames.join(' / ')}（${failReasons}）`,
      courseId,
      classId,
      courseName,
      activeId,
      activeName,
      signType,
      signTypeLabel: record.signTypeLabel,
      targetUids: failedUsers.map((r) => r.uid),
      targetNames: failNames,
      helperToken: activeHelperToken,
      shareUrl: helperShareUrl || '',
      urgent: true,
      dedupKey: `fail_${activeId}_${failedUsers.map((r) => r.uid).sort().join(',')}_${failReasons}`,
    });
  }

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
    const allInvolvedUids = results.map((r) => String(r.uid)).filter(Boolean);
    const allInvolvedNames = results.map((r) => r.name || r.uid).join(' / ');
    const statusFingerprint = results.map((r) => `${r.uid}:${r.ok ? 1 : 0}`).sort().join(',');
    await broadcastNapCatWithRetry(lines.join('\n'), {
      eventType: helperShareUrl ? 'help_request' : 'sign_result',
      dedupKey: helperShareUrl ? `help_${activeId}` : `res_${activeId}_${statusFingerprint}_${triggerSource}`,
      eventData: {
        title: helperShareUrl
          ? `帮 ${mergedNamesStr} 签到《${courseName}》`
          : (failedUsers.length === 0 ? `签到成功《${courseName}》` : `签到结果通知《${courseName}》`),
        targetUids: allInvolvedUids,
        targetNames: helperShareUrl ? mergedNamesStr : (successNamesStr || allInvolvedNames),
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
          probeUids: [],
        });
      }
      const entry = classMap.get(key);
      if (!entry.probeUids.includes(uid)) {
        entry.probeUids.push(uid);
      }
      entry.memberCpis[uid] = c.cpi;
      if (shouldScan) {
        if (!entry.shouldScan) {
          entry.scanUid = uid;
        }
        entry.shouldScan = true;
        if (!entry.memberUids.includes(uid)) {
          entry.memberUids.push(uid);
          entry.memberNames.push(acc.name || uid);
        }
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
        await sleepMs(1100);
      }
      const entry = enabledEntries[idx];
      const course = entry.course;
      const classLabel = course.note ? `${course.name}(${course.note})` : course.name;
      let actives = null;
      let lastErr = null;

      // Probe pool vs sign target pool decoupling: rotate memberUids first, fallback to probeUids for read-only active scanning
      const primaryScanUids = entry.memberUids && entry.memberUids.length > 0 ? [...entry.memberUids] : [entry.scanUid];
      pollCoursesOnce._rrIndex = ((pollCoursesOnce._rrIndex || 0) + 1) % Math.max(1, primaryScanUids.length);
      const rotatedPrimaryUids = [
        ...primaryScanUids.slice(pollCoursesOnce._rrIndex),
        ...primaryScanUids.slice(0, pollCoursesOnce._rrIndex),
      ];
      const fallbackProbeUids = (entry.probeUids || []).filter((u) => !rotatedPrimaryUids.includes(u));
      const orderedUids = [...rotatedPrimaryUids, ...fallbackProbeUids];

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
            const deferredNameList = deferredUids.map(
              (u) => (store.accounts || []).find((a) => String(a.uid) === String(u))?.name || u
            );
            const waitHs = createHelperSession({
              mode: 'sign',
              title: `帮 ${deferredNameList.join('/')} 签到《${course.name}》(${SIGN_TYPE_LABEL[act.signType] || act.signType || '签到'})`,
              courseId: course.courseId,
              classId: course.classId,
              cpi: course.cpi,
              courseName: course.name,
              activeId: act.id,
              activeName: act.name,
              signType: act.signType || 'normal',
              signTypeLabel: SIGN_TYPE_LABEL[act.signType] || act.signType || '课堂签到',
              targetUids: entry.memberUids,
              targetNames: entry.memberNames,
              pendingUids: deferredUids,
              pendingNames: deferredNameList,
              endTimeMs: Number(stats.endTimeMs || 0),
              signedCount: Number(stats.signedCount || 0),
              totalCount: Number(stats.totalCount || 0),
              waitingThreshold: true,
            });
            pushRealtimeSignAlert({
              eventType: 'sign_detected',
              title: `发现新签到：《${course.name}》`,
              body: `${act.name} · 当前已签 ${stats.signedCount}/${stats.totalCount}`,
              courseId: course.courseId,
              classId: course.classId,
              courseName: course.name,
              activeId: act.id,
              activeName: act.name,
              signType: act.signType || 'normal',
              signTypeLabel: SIGN_TYPE_LABEL[act.signType] || act.signType || '签到',
              targetUids: deferredUids,
              targetNames: deferredNameList,
              helperToken: waitHs.token,
              shareUrl: `${getPublicBaseUrlClean()}/?help=${waitHs.token}`,
              urgent: true,
              dedupKey: `detect_${act.id}_${deferredUids.slice().sort().join(',')}`,
            });
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
              const deferredNames = deferredUids
                .map((u) => (store.accounts || []).find((a) => String(a.uid) === String(u))?.name || u)
                .join(' / ');
              sysLog(
                'PROTECT',
                `[人数保护] 《${course.name}·${act.name}》当前已签 ${stats.signedCount}/${stats.totalCount} (${(stats.signRatio * 100).toFixed(1)}%) < 阈值 ${(act.thresholdRatio * 100).toFixed(0)}%，${deferredUids.length} 个账号已挂入 3s 高频盯盘与临期压哨保护${remainTip}`,
                { uids: deferredUids, ownerUsernames: scopedLogMeta.ownerUsernames }
              );
              if (store.napcat?.notifyOnDetect !== false) {
                broadcastNapCatWithRetry(
                  [
                    `[学习通签到监测] (防钓鱼人数保护等待中)`,
                    `课程：《${course.name}》`,
                    `活动：${act.name} (已签 ${stats.signedCount}/${stats.totalCount} 人，当前 ${(stats.signRatio * 100).toFixed(1)}% < 阈值 ${(act.thresholdRatio * 100).toFixed(0)}%)`,
                    `等待达标账号：${deferredNames}${remainTip}`,
                  ].join('\n'),
                  {
                    eventType: 'sign_result',
                    dedupKey: `protect_wait_${act.id}_${deferredUids.slice().sort().join(',')}`,
                    eventData: {
                      targetUids: deferredUids,
                      targetNames: deferredNames,
                      courseName: course.name,
                      activeName: act.name,
                    },
                  }
                ).catch(() => {});
              }
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

    // 过滤掉在本次轮询中已经全员签到完成或已截止的活动，并附带关联悬赏与实时待签状态，防止活动监测死灰复燃或重复签到
    const liveFilteredDetected = detected.filter((it) => {
      const act = it.active || it;
      const aid = String(act?.id || '');
      if (!aid || isActiveFullyCompleted(aid)) return false;
      if (act.endTimeMs && act.endTimeMs > 0 && Date.now() > act.endTimeMs + 4000) return false;
      const hs = (store.helperSessions || []).find(
        (s) => !s.completed && !s.expired && (s.mode === 'sign' || s.mode === 'captcha') && String(s.activeId) === aid
      );
      if (hs) {
        it.pendingUids = Array.isArray(hs.pendingUids) ? hs.pendingUids : (hs.targetUids || []);
        it.pendingNames = Array.isArray(hs.pendingNames) ? hs.pendingNames : (hs.targetNames || []);
        it.succeededUids = Array.isArray(hs.succeededUids) ? hs.succeededUids : [];
        it.succeededNames = Array.isArray(hs.succeededNames) ? hs.succeededNames : [];
        it.helperToken = hs.token;
        it.designatedPlace = hs.designatedPlace || '';
        it.locationRange = hs.locationRange || '';
        if (it.pendingUids.length === 0 && it.succeededUids.length > 0) return false;
      }
      return true;
    });

    if (isScopedScan) {
      const scopedSet = new Set(onlyUids.map(String));
      const keptOther = (lastDetectedActives || []).filter(
        (item) => !(item.memberUids || []).every((u) => scopedSet.has(String(u)))
      );
      const mergedMap = new Map();
      for (const it of [...liveFilteredDetected, ...keptOther]) {
        const aid = String(it.active?.id || it.id || '');
        if (!mergedMap.has(aid) && !isActiveFullyCompleted(aid)) mergedMap.set(aid, it);
      }
      lastDetectedActives = Array.from(mergedMap.values());
    } else if (!hitRateLimit || liveFilteredDetected.length > 0 || detected.length > 0) {
      lastDetectedActives = liveFilteredDetected;
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
const fullySignedActiveIds = new Set(); // 已确认全员签完或截止的活动 ID，防止活动监测死灰复燃或重复签到

// 记录在 executeSignForActive 中已经播报过成功的账号，避免状态巡检器重复播报同一账号
function markAccountsNotifiedForActive(activeId, uids) {
  const aid = String(activeId);
  if (!notifiedAttendSuccessMap.has(aid)) notifiedAttendSuccessMap.set(aid, new Set());
  const set = notifiedAttendSuccessMap.get(aid);
  for (const u of uids || []) set.add(String(u));
}

function markActiveFullyCompleted(activeId) {
  if (activeId) fullySignedActiveIds.add(String(activeId));
}

function isActiveFullyCompleted(activeId) {
  return Boolean(activeId && fullySignedActiveIds.has(String(activeId)));
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
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const candidateDirs = [];

  try {
    const winBase = 'D:/TencentFiles/Tencent Files';
    if (fs.existsSync(winBase)) {
      for (const uin of fs.readdirSync(winBase)) {
        if (!/^\d{5,12}$/.test(uin)) continue;
        candidateDirs.push(`${winBase}/${uin}/nt_qq/nt_data/Pic/${ym}/Ori`);
        candidateDirs.push(`${winBase}/${uin}/nt_qq/nt_data/Emoji/emoji-recv/${ym}/Ori`);
      }
    }
  } catch (_) {}

  try {
    const linuxBase = '/opt/napcat/qq';
    if (fs.existsSync(linuxBase)) {
      for (const entry of fs.readdirSync(linuxBase)) {
        if (!entry.startsWith('nt_qq')) continue;
        candidateDirs.push(`${linuxBase}/${entry}/nt_data/Pic/${ym}/Ori`);
        candidateDirs.push(`${linuxBase}/${entry}/nt_data/Emoji/emoji-recv/${ym}/Ori`);
      }
    }
  } catch (_) {}

  for (const oriDir of candidateDirs) {
    try {
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
    } catch (_) {}
  }
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
    const hsUids = Array.isArray(t.helperSession?.targetUids) && t.helperSession.targetUids.length > 0
      ? t.helperSession.targetUids
      : null;
    const matchedAccounts = hsUids
      ? findMatchingAccountsForClass(t.courseId, t.classId, hsUids)
      : findMatchingAccountsForClass(t.courseId, t.classId, null, { onlyAutoSignEnabled: true });
    const targetUids = matchedAccounts.map((a) => a.uid);
    if (targetUids.length === 0) {
      sysLog("QR_WATCH", `课程《${t.courseName}》当前无开启自动监测的账号，跳过群二维码自动签到`);
      continue;
    }

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
let isSyncingBounties = false;
async function checkExternalSignCompletions(options = {}) {
  const { force = false } = options || {};
  const now = Date.now();
  const hasLiveBounties = (store.helperSessions || []).some(
    (s) => !s.completed && (s.mode === 'sign' || s.mode === 'captcha') && s.expiresAt > now
  );
  const syncSec = Math.max(1, Math.min(60, Number(store.bountyConfig?.bountySyncSeconds || 3.5)));
  const idleSec = Math.max(3, Math.min(120, Number(store.bountyConfig?.idleSyncSeconds || 10)));
  const minInterval = force ? 0 : (hasLiveBounties ? Math.round(syncSec * 1000) : Math.round(idleSec * 1000));
  if (isSyncingBounties || now - lastExternalSyncAt < minInterval) return;
  isSyncingBounties = true;
  lastExternalSyncAt = now;

  try {
    const watchMap = new Map();
    for (const hs of store.helperSessions || []) {
      if (!hs.completed && (hs.mode === 'sign' || hs.mode === 'captcha') && hs.activeId) {
        if (hs.expiresAt <= now) {
          hs.completed = true;
          hs.expired = true;
          hs.closeReason = '协助会话超时';
          continue;
        }
        const aid = String(hs.activeId);
        if (!watchMap.has(aid)) {
          watchMap.set(aid, {
            activeId: aid,
            courseId: hs.courseId,
            classId: hs.classId,
            courseName: hs.courseName || '课程',
            activeName: hs.activeName || '课堂签到',
            signType: hs.signType || 'normal',
            signTypeLabel: hs.signTypeLabel || SIGN_TYPE_LABEL[hs.signType] || hs.signType || '签到',
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
            signType: act.signType || 'normal',
            signTypeLabel: SIGN_TYPE_LABEL[act.signType] || act.signType || '签到',
            hsList: [],
          });
        }
      }
    }

    let storeDirty = false;

    for (const [aid, meta] of watchMap.entries()) {
      const hsTargetUids = Array.from(
        new Set((meta.hsList || []).flatMap((hs) => (Array.isArray(hs.targetUids) ? hs.targetUids.map(String) : [])))
      );
      const autoEnabledAccounts = findMatchingAccountsForClass(meta.courseId, meta.classId, null, { onlyAutoSignEnabled: true });
      const hsAccounts = hsTargetUids.length > 0 ? findMatchingAccountsForClass(meta.courseId, meta.classId, hsTargetUids) : [];
      const mergedAccMap = new Map();
      for (const a of [...autoEnabledAccounts, ...hsAccounts]) {
        mergedAccMap.set(String(a.uid), a);
      }
      const accounts = Array.from(mergedAccMap.values());
      const probeUid = accounts[0]?.uid || store.currentUid || store.accounts?.[0]?.uid;

      // 1) 实时探测签到活动在学习通官方是否已截止/过期 -> 秒级下架无效悬赏
      let stats = null;
      if (probeUid && meta.courseId && meta.classId) {
        try {
          stats = await CXProtocol.getSignAttendStats(aid, meta.courseId, meta.classId, probeUid);
        } catch (_) {}
      }
      const isActivityEnded =
        Boolean(stats?.isOver) ||
        (Number(stats?.endTimeMs || 0) > 0 && Date.now() > Number(stats.endTimeMs) + 4000);

      if (stats) {
        for (const hs of meta.hsList) {
          hs.signedCount = Number(stats.signedCount || hs.signedCount || 0);
          hs.totalCount = Number(stats.totalCount || hs.totalCount || 0);
          if (stats.endTimeMs > 0) hs.endTimeMs = Number(stats.endTimeMs);
        }
      }

      if (isActivityEnded) {
        if (meta.hsList.length > 0) {
          for (const hs of meta.hsList) {
            hs.completed = true;
            hs.expired = true;
            hs.closeReason = '签到已截止';
            hs.updatedAt = Date.now();
          }
          storeDirty = true;
        }
        markActiveFullyCompleted(aid);
        lastDetectedActives = (lastDetectedActives || []).filter((it) => String((it.active || it)?.id) !== aid);
        pendingThresholdWatchMap.delete(aid);
        continue;
      }

      if (accounts.length === 0) continue;

      // 2) 逐账号同步真实出勤状态 -> 签上的人实时从待签列表和活动监测剔除，全员签完立刻下架悬赏与监测（防重签）
      const notifiedSet = notifiedAttendSuccessMap.get(aid) || new Set();
      const newlySigned = [];
      const currentSignedAccs = [];
      const currentPendingAccs = [];

      for (const acc of accounts) {
        try {
          const att = await CXProtocol.getAttendInfoWeb(aid, acc.uid);
          const st = Number(att?.status ?? 0);
          const signed = st === 1 || st === 9;
          if (signed) {
            currentSignedAccs.push(acc);
            if (!notifiedSet.has(String(acc.uid))) {
              newlySigned.push(acc);
            }
          } else {
            currentPendingAccs.push(acc);
          }
        } catch (_) {
          currentPendingAccs.push(acc);
        }
      }

      const allSigned = currentPendingAccs.length === 0 && currentSignedAccs.length > 0;

      for (const hs of meta.hsList) {
        const hsTargetSet = new Set((hs.targetUids || []).map(String));
        const hsPending = hsTargetSet.size > 0
          ? currentPendingAccs.filter((a) => hsTargetSet.has(String(a.uid)))
          : currentPendingAccs;
        const hsSigned = hsTargetSet.size > 0
          ? currentSignedAccs.filter((a) => hsTargetSet.has(String(a.uid)))
          : currentSignedAccs;
        const prevPendingKey = (hs.pendingUids || []).join(',');
        hs.pendingUids = hsPending.map((a) => String(a.uid));
        hs.pendingNames = hsPending.map((a) => a.name || a.uid);
        hs.succeededUids = hsSigned.map((a) => String(a.uid));
        hs.succeededNames = hsSigned.map((a) => a.name || a.uid);
        if (prevPendingKey !== hs.pendingUids.join(',')) {
          hs.updatedAt = Date.now();
          storeDirty = true;
        }
        if (hsPending.length === 0 && hsSigned.length > 0) {
          hs.completed = true;
          hs.closeReason = '全部已签到完成';
          hs.updatedAt = Date.now();
          storeDirty = true;
        }
      }

      // 实时同步活动监测列表 (lastDetectedActives)：已全员签完的活动立即移除，未签完的实时更新待签/已签名单
      if (allSigned) {
        markActiveFullyCompleted(aid);
        lastDetectedActives = (lastDetectedActives || []).filter(
          (it) => String((it.active || it)?.id) !== aid
        );
      } else {
        for (const it of lastDetectedActives || []) {
          const act = it.active || it;
          if (String(act?.id) === aid) {
            if (stats) {
              act.signedCount = stats.signedCount;
              act.totalCount = stats.totalCount;
              act.signRatio = stats.signRatio;
              if (stats.endTimeMs > 0) act.endTimeMs = stats.endTimeMs;
            }
            it.pendingUids = currentPendingAccs.map((a) => String(a.uid));
            it.pendingNames = currentPendingAccs.map((a) => a.name || a.uid);
            it.succeededUids = currentSignedAccs.map((a) => String(a.uid));
            it.succeededNames = currentSignedAccs.map((a) => a.name || a.uid);
          }
        }
      }

      // 若监测到了进行中活动但尚无悬赏卡片且仍有未签完账号，自动补建零延迟悬赏会话防止漏显
      if (meta.hsList.length === 0 && currentPendingAccs.length > 0) {
        const activeDetail = (await CXProtocol.getActiveInfoWeb(aid, probeUid).catch(() => null)) || {};
        const sType = SIGN_TYPE_INDEX_MAP[Number(activeDetail.otherId ?? 0)] || meta.signType || 'normal';
        const needPhoto = activeDetail.ifphoto === 1 || activeDetail.ifPhoto === 1;
        const label = needPhoto && sType === 'normal' ? '拍照签到' : (SIGN_TYPE_LABEL[sType] || meta.signTypeLabel || '签到');
        createHelperSession({
          mode: 'sign',
          title: `帮 ${currentPendingAccs.map((a) => a.name || a.uid).join('/')} 签到《${meta.courseName}》(${label})`,
          courseId: meta.courseId,
          classId: meta.classId,
          courseName: meta.courseName,
          activeId: aid,
          activeName: meta.activeName,
          signType: sType,
          signTypeLabel: label,
          targetUids: accounts.map((a) => a.uid),
          targetNames: accounts.map((a) => a.name || a.uid),
          pendingUids: currentPendingAccs.map((a) => a.uid),
          pendingNames: currentPendingAccs.map((a) => a.name || a.uid),
          succeededUids: currentSignedAccs.map((a) => a.uid),
          succeededNames: currentSignedAccs.map((a) => a.name || a.uid),
          designatedPlace: activeDetail.locationText || '',
          locationRange: activeDetail.locationRange ? String(activeDetail.locationRange) : '',
          needLocation: Boolean(activeDetail.locationText || sType === 'location'),
          needPhoto,
          endTimeMs: Number(stats?.endTimeMs || activeDetail.endTime || 0),
          signedCount: Number(stats?.signedCount || 0),
          totalCount: Number(stats?.totalCount || 0),
        });
        storeDirty = true;
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
          signType: meta.signType || 'normal',
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
        storeDirty = true;

        pushRealtimeSignAlert({
          eventType: 'sign_success',
          title: `签到成功：《${meta.courseName}》`,
          body: `${meta.activeName} (${meta.signTypeLabel}) · 已确认签上：${mergedNames}`,
          courseId: meta.courseId,
          classId: meta.classId,
          courseName: meta.courseName,
          activeId: aid,
          activeName: meta.activeName,
          signType: meta.signType || 'normal',
          signTypeLabel: meta.signTypeLabel,
          targetUids: newlySigned.map((a) => a.uid),
          targetNames: newlySigned.map((a) => a.name || a.uid),
          urgent: false,
          dedupKey: `ext_alert_ok_${aid}_${newlySigned.map((a) => a.uid).sort().join(',')}`,
        });

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
              targetUids: newlySigned.map((a) => String(a.uid)),
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
      }
    }

    if (storeDirty) saveStore();
  } finally {
    isSyncingBounties = false;
  }
}

async function syncActiveBountiesNow(options = {}) {
  await checkExternalSignCompletions({ force: Boolean(options.force) });
}

function getActiveBountiesForUser({ myCourseIds = new Set(), myClassIds = new Set(), myCourseNames = new Set(), myOwnedUids = [] } = {}) {
  const now = Date.now();
  const baseUrl = getPublicBaseUrlClean();
  const ownedSet = new Set((myOwnedUids || []).map(String));
  const rawList = (store.helperSessions || []).filter((hs) => {
    if (!hs || hs.completed || hs.expired) return false;
    if (hs.mode !== 'sign' && hs.mode !== 'captcha') return false;
    if (hs.expiresAt <= now) return false;
    if (hs.endTimeMs && hs.endTimeMs > 0 && now > hs.endTimeMs + 4000) return false;
    const pend = Array.isArray(hs.pendingUids) ? hs.pendingUids : (hs.targetUids || []);
    if (pend.length === 0) return false;
    return true;
  });

  // 按 activeId 去重（只保留最新一条活跃悬赏）
  const seenActive = new Set();
  const list = [];
  for (const hs of rawList) {
    const aid = String(hs.activeId || hs.token);
    if (seenActive.has(aid)) continue;
    seenActive.add(aid);

    const pendingUids = Array.isArray(hs.pendingUids) ? hs.pendingUids.map(String) : (hs.targetUids || []).map(String);
    const pendingNames = Array.isArray(hs.pendingNames) && hs.pendingNames.length > 0
      ? hs.pendingNames
      : pendingUids.map((u) => (store.accounts || []).find((a) => String(a.uid) === u)?.name || u);
    const succeededUids = Array.isArray(hs.succeededUids) ? hs.succeededUids.map(String) : [];
    const succeededNames = Array.isArray(hs.succeededNames) ? hs.succeededNames : [];

    const isMyCourse =
      (hs.classId && myClassIds.has(String(hs.classId))) ||
      (hs.courseId && myCourseIds.has(String(hs.courseId))) ||
      (hs.courseName && myCourseNames.has(String(hs.courseName))) ||
      pendingUids.some((u) => ownedSet.has(u));
    const includesMe = pendingUids.some((u) => ownedSet.has(u));

    list.push({
      token: hs.token,
      mode: hs.mode,
      title: hs.title,
      courseId: hs.courseId,
      classId: hs.classId,
      courseName: hs.courseName || '未知课程',
      activeId: hs.activeId,
      activeName: hs.activeName || '课堂签到',
      signType: hs.signType || 'normal',
      signTypeLabel: hs.signTypeLabel || SIGN_TYPE_LABEL[hs.signType] || hs.signType || '签到',
      designatedPlace: hs.designatedPlace || '',
      locationRange: hs.locationRange || '',
      needLocation: Boolean(hs.needLocation || hs.designatedPlace || hs.signType === 'location'),
      needPhoto: Boolean(hs.needPhoto || hs.signType === 'photo'),
      waitingThreshold: Boolean(hs.waitingThreshold),
      targetUids: hs.targetUids || [],
      targetNames: hs.targetNames || [],
      pendingUids,
      pendingNames,
      succeededUids,
      succeededNames,
      signedCount: Number(hs.signedCount || 0),
      totalCount: Number(hs.totalCount || 0),
      endTimeMs: Number(hs.endTimeMs || 0),
      createdAt: Number(hs.createdAt || now),
      updatedAt: Number(hs.updatedAt || hs.createdAt || now),
      expiresAt: Number(hs.expiresAt || now + 1800000),
      shareUrl: `${baseUrl}/?help=${hs.token}`,
      isMyCourse: Boolean(isMyCourse),
      includesMe: Boolean(includesMe),
    });
  }

  // 排序优先级：1) 包含我本人未签 -> 2) 同课程悬赏 -> 3) 最新更新时间
  list.sort((a, b) => {
    if (a.includesMe !== b.includesMe) return a.includesMe ? -1 : 1;
    if (a.isMyCourse !== b.isMyCourse) return a.isMyCourse ? -1 : 1;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
  return list;
}

async function processIncomingChatImageItem(img) {
  if (!img || !img.id || processedChatImageIds.has(img.id)) return false;
  let buf = null;
  if (img.base64) {
    buf = Buffer.from(String(img.base64).replace(/^data:image\/\w+;base64,/, ''), 'base64');
  }
  if ((!buf || buf.length < 128) && img.localPath) {
    const rawPath = String(img.localPath);
    const mappedHostPath = rawPath.replace(/^\/app\/\.config\/QQ\b/, '/opt/napcat/qq');
    const allowedRoots = ['/opt/napcat/qq/', '/app/.config/QQ/'];
    for (const candidate of [mappedHostPath, rawPath]) {
      const normalized = path.posix.normalize(String(candidate).replace(/\\/g, '/'));
      if (allowedRoots.some((root) => normalized.startsWith(root)) && fs.existsSync(normalized)) {
        try {
          buf = fs.readFileSync(normalized);
          if (buf && buf.length >= 128) break;
        } catch (_) {}
      }
    }
  }
  if ((!buf || buf.length < 128) && img.url && isSafeExternalImageUrl(img.url)) {
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
    const groups = normalizeConfiguredGroups(cfg.groups || cfg.groupIds || []);
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
        for (const hs of store.helperSessions || []) {
          if (!hs.completed && String(hs.activeId) === String(aid)) {
            hs.completed = true;
            hs.expired = true;
            hs.closeReason = '签到已截止';
          }
        }
        saveStore();
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
  const valid = candidates.filter((n) => !Number.isNaN(n) && n >= 5);
  return valid.length > 0 ? Math.max(5, Math.min(...valid)) : 25;
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
  decodeQrFromImageBuffer,
  broadcastNapCat,
  getPublicBaseUrlClean,
  createHelperSession,
  getHelperSession,
  pushRealtimeSignAlert,
  creditHelperPointsToStudent,
  claimHelperPointsByToken,
  getFormattedLeaderboard,
  getFormattedBountyHistory,
  syncActiveBountiesNow,
  getActiveBountiesForUser,
  solveSlideCaptchaX,
  autoSolveSlideCaptcha,
  executeSignForActive,
  isAccountAutoSignEnabledForCourse,
  findMatchingAccountsForClass,
  handleDetectedQrCodeText,
  processIncomingChatImageItem,
  pollGroupQrImagesOnce,
  getAccountActiveScheduleStatus,
  getGlobalScheduleSummary,
  pollCoursesOnce,
  getEffectiveTimerIntervalSeconds,
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
