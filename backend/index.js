const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const Constant = {
  schildSalt: 'ipL$TkeiEmfy1gTXb2XHrdLN0a@7c^vu',
  getFaceSalt: 'uWwjeEKsri',
  webLoginKey: 'u2oh6Vu^HWe4_AES',
  sendCaptchaKey: 'jsDyctOCnay7uotq',
  appLoginKey: 'z4ok6lu^oWp4_AES',
  deviceCodeKey: 'QrCbNY@MuK1X8HGw',
  rsaKeyBody: 'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC79d8Ot0hCbxxSISC6x8SCwTBspFSzlLKHJUYqoFNu1TSRaw4hEYkOnvEaL1VyoxV6HXcDrzwYvaFZaZaPQPFnfCHZy5dQwxcmifgSHqS+oKXw40Ys4cVIqnU5d90S7EWSRdBglX489jlqVaNcQSkDx2TYmC+DbAq9FV/BU09ISQIDAQAB',
  infEncToken: '4faa8662c59590c6f43ae9fe5b002b42',
  infEncKey: 'Z(AfY@XS',
  imKey: 'SL2(M/eD',
  cxCaptchaId: 'Qt9FIw9o4pwRjOyqM6yizZBh682qN2TU',
};

const RSA_PEM = `-----BEGIN PUBLIC KEY-----\n${Constant.rsaKeyBody.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----`;

class EncryptionUtil {
  static md5Hash(text) {
    return crypto.createHash('md5').update(String(text), 'utf8').digest('hex');
  }
  static getUuid() { return crypto.randomUUID(); }
  static getUniqueId() { return crypto.randomUUID().replace(/-/g, ''); }

  static aesCbcEncrypt(text, keyStr) {
    const key = Buffer.from(keyStr, 'utf8');
    const iv = Buffer.from(keyStr, 'utf8');
    const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
    return Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]).toString('base64');
  }

  static aesEcbEncrypt(text, keyStr) {
    const key = Buffer.from(keyStr, 'utf8');
    const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
    return Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]).toString('base64');
  }

  static desEcbDecrypt(hexCipher, keyStr) {
    try {
      const cipherBytes = Buffer.from(hexCipher, 'hex');
      const keyBytes = Buffer.from(keyStr, 'utf8').subarray(0, 8);
      const extendedKey = Buffer.concat([keyBytes, keyBytes, keyBytes]);
      const decipher = crypto.createDecipheriv('des-ede3-ecb', extendedKey, null);
      return Buffer.concat([decipher.update(cipherBytes), decipher.final()]).toString('utf8');
    } catch (_) { return ''; }
  }

  static rsaEncrypt(text) {
    const plainBytes = Buffer.from(String(text), 'utf8');
    const chunks = [];
    for (let i = 0; i < plainBytes.length; i += 117) {
      chunks.push(crypto.publicEncrypt(
        { key: RSA_PEM, padding: crypto.constants.RSA_PKCS1_PADDING },
        plainBytes.subarray(i, Math.min(i + 117, plainBytes.length))
      ));
    }
    return Buffer.concat(chunks).toString('base64');
  }

  static rsaDecrypt(ciphertextBase64) {
    if (!ciphertextBase64) return '';
    try {
      const cipherBytes = Buffer.from(ciphertextBase64, 'base64');
      const chunks = [];
      for (let i = 0; i < cipherBytes.length; i += 128) {
        chunks.push(crypto.publicDecrypt(
          { key: RSA_PEM, padding: crypto.constants.RSA_PKCS1_PADDING },
          cipherBytes.subarray(i, Math.min(i + 128, cipherBytes.length))
        ));
      }
      return Buffer.concat(chunks).toString('utf8');
    } catch (_) { return ''; }
  }

  static getDeviceCode() {
    return this.aesEcbEncrypt(this.getUuid(), Constant.deviceCodeKey);
  }

  static getEncParams(params) {
    const encParams = { _c_0_: this.getUniqueId(), token: Constant.infEncToken, _time: String(Date.now()) };
    const merged = { ...params, ...encParams };
    const qs = Object.entries(merged).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    merged.inf_enc = this.md5Hash(`${qs}&DESKey=${Constant.infEncKey}`);
    return merged;
  }

  static getBufferCRC(buffer) {
    const totalSize = buffer.length;
    const bytesToHash = totalSize > 1048576
      ? Buffer.concat([buffer.subarray(0, 524288), buffer.subarray(totalSize - 524288)])
      : Buffer.from(buffer);
    const sizeHex = Buffer.from(totalSize.toString(16), 'utf8');
    return crypto.createHash('md5').update(Buffer.concat([bytesToHash, sizeHex])).digest('hex');
  }
}

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

function createDefaultUserProfile() {
  return {
    inheritFromUid: null,
    useCurriculumSchedule: true,
    curriculumBufferMinutes: 10,
    defaultLocation: {
      name: '奉贤校区',
      address: '上海市奉贤区海思路100号',
      latitude: 30.8328,
      longitude: 121.5035,
    },
    courseSettings: {},
    coursesCache: [],
    curriculumCache: null,
    diyLessons: [],
    slots: [
      { id: 'slot_1', label: '第一二节', weekdays: [1, 2, 3, 4, 5], start: '08:00', end: '09:50', enabled: false },
      { id: 'slot_2', label: '第三四节', weekdays: [1, 2, 3, 4, 5], start: '10:10', end: '12:00', enabled: false },
      { id: 'slot_3', label: '第五六节', weekdays: [1, 2, 3, 4, 5], start: '14:00', end: '15:50', enabled: false },
      { id: 'slot_4', label: '第七八节', weekdays: [1, 2, 3, 4, 5], start: '16:10', end: '18:00', enabled: false },
      { id: 'slot_5', label: '晚间课程', weekdays: [1, 2, 3, 4, 5], start: '19:00', end: '21:50', enabled: false },
    ],
  };
}

const defaultStore = {
  uniqueId: EncryptionUtil.getUniqueId(),
  currentUid: null,
  accounts: [],
  cookies: {},
  tempCookies: {},
  userProfiles: {},
  locationPresets: [
    {
      id: 'preset_sit_fx',
      name: '上海应用技术大学(奉贤)',
      address: '上海市奉贤区海思路100号',
      latitude: 30.8328,
      longitude: 121.5035,
    },
    {
      id: 'preset_sit_xh',
      name: '上海应用技术大学(徐汇)',
      address: '上海市徐汇区漕宝路120号',
      latitude: 31.1685,
      longitude: 121.4192,
    },
  ],
  handledActiveKeys: [],
  signHistory: [],
  helperSessions: [],
  pendingCaptchas: {},
  schedule: {
    masterEnabled: true,
    forcePolling: false,
    intervalSeconds: 25,
    signThresholdEnabled: false,
    signThresholdRatio: 0.3,
  },
  userScheduleConfigs: {},
  panelAuth: {
    enabled: true,
    username: 'ishit',
    passwordHash: EncryptionUtil.md5Hash('ishit2026'),
    sessions: {},
  },
  napcat: {
    enabled: false,
    httpUrl: 'http://127.0.0.1:3000',
    accessToken: '',
    groupIds: [],
    privateIds: [],
    groupBindings: {},
    publicBaseUrl: 'https://ishit.pw',
  },
};

let store = { ...defaultStore };
if (fs.existsSync(STORE_FILE)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    store = {
      ...defaultStore,
      ...loaded,
      userProfiles: loaded.userProfiles || {},
      locationPresets: Array.isArray(loaded.locationPresets) && loaded.locationPresets.length > 0
        ? loaded.locationPresets
        : defaultStore.locationPresets,
      panelAuth: {
        ...defaultStore.panelAuth,
        ...(loaded.panelAuth || {}),
        sessions: (loaded.panelAuth && loaded.panelAuth.sessions) || {},
      },
      schedule: { ...defaultStore.schedule, ...(loaded.schedule || {}) },
      userScheduleConfigs: loaded.userScheduleConfigs || {},
      napcat: {
        ...defaultStore.napcat,
        ...(loaded.napcat || {}),
        publicBaseUrl:
          !loaded.napcat?.publicBaseUrl || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/.*)?$/i.test(String(loaded.napcat.publicBaseUrl).trim())
            ? defaultStore.napcat.publicBaseUrl
            : String(loaded.napcat.publicBaseUrl).trim().replace(/\/+$/, ''),
      },
    };
    if (store.accounts && store.accounts.length > 0) {
      for (const acc of store.accounts) {
        if (!store.userProfiles[acc.uid]) {
          const prof = createDefaultUserProfile();
          if (loaded.courseSettings) prof.courseSettings = { ...loaded.courseSettings };
          if (loaded.coursesCache) prof.coursesCache = [...loaded.coursesCache];
          store.userProfiles[acc.uid] = prof;
        }
      }
    }
  } catch (_) {}
}

function saveStore() {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), 'utf8');
  } catch (e) {
    console.error('保存配置失败:', e.message);
  }
}

function getEffectiveScheduleForPanelUser(panelUsername) {
  const base = {
    masterEnabled: true,
    forcePolling: false,
    intervalSeconds: 25,
    signThresholdEnabled: false,
    signThresholdRatio: 0.3,
    ...(store.schedule || {}),
  };
  if (!panelUsername) return base;
  const userCfg = store.userScheduleConfigs?.[panelUsername];
  if (!userCfg || typeof userCfg !== 'object') return base;
  return {
    ...base,
    ...userCfg,
  };
}

function getEffectiveScheduleForCxUid(uid) {
  const acc = (store.accounts || []).find((a) => String(a.uid) === String(uid));
  const owner = acc?.ownerUsername || '';
  return getEffectiveScheduleForPanelUser(owner);
}

function ensureUserProfile(uid) {
  if (!uid) return createDefaultUserProfile();
  if (!store.userProfiles[uid]) {
    store.userProfiles[uid] = createDefaultUserProfile();
    saveStore();
  }
  return store.userProfiles[uid];
}

function getEffectiveUserProfile(uid) {
  const raw = ensureUserProfile(uid);
  raw.diyLessons = Array.isArray(raw.diyLessons) ? raw.diyLessons : [];
  if (raw.inheritFromUid && raw.inheritFromUid !== uid && store.userProfiles[raw.inheritFromUid]) {
    const target = store.userProfiles[raw.inheritFromUid];
    return {
      ...raw,
      useCurriculumSchedule: target.useCurriculumSchedule,
      curriculumBufferMinutes: target.curriculumBufferMinutes,
      defaultLocation: target.defaultLocation,
      slots: target.slots,
      diyLessons: Array.isArray(target.diyLessons) ? target.diyLessons : raw.diyLessons,
      courseSettings: { ...target.courseSettings, ...raw.courseSettings },
      effectiveCurriculum: target.curriculumCache || raw.curriculumCache,
      inheritedFrom: raw.inheritFromUid,
    };
  }
  return {
    ...raw,
    diyLessons: raw.diyLessons,
    effectiveCurriculum: raw.curriculumCache,
    inheritedFrom: null,
  };
}

const logsBuffer = [];
function sysLog(level, msg, meta = null) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const line = `[${ts}] [${level}] ${msg}`;
  console.log(line);
  const entry = {
    time: ts,
    tag: level,
    msg,
    line,
    uids: Array.isArray(meta?.uids) ? meta.uids.map(String) : [],
    ownerUsernames: Array.isArray(meta?.ownerUsernames) ? meta.ownerUsernames.map(String) : [],
  };
  logsBuffer.unshift(entry);
  if (logsBuffer.length > 300) logsBuffer.pop();
}

function getChaoxingHeaders() {
  const deviceModel = 'Pixel 9 Pro';
  const systemHttpAgent = 'Dalvik/2.1.0 (Linux; U; Android 16; Pixel 9 Pro Build/BP4A.260205.002)';
  const userAgentTemp = `(device:${deviceModel}) Language/zh_CN com.chaoxing.mobile/ChaoXingStudy_3_6.7.4_android_phone_10940_314 (@Kalimdor)_${store.uniqueId}`;
  const schild = EncryptionUtil.md5Hash(`(schild:${Constant.schildSalt}) ${userAgentTemp}`);
  return {
    'User-Agent': `${systemHttpAgent} (schild:${schild}) ${userAgentTemp}`,
    'Accept-Language': 'zh_CN',
    'Connection': 'keep-alive',
    'content-type': 'application/x-www-form-urlencoded',
  };
}

function getCookieJar(userId, tempSessionKey = null) {
  if (tempSessionKey) {
    if (!store.tempCookies[tempSessionKey]) store.tempCookies[tempSessionKey] = {};
    return store.tempCookies[tempSessionKey];
  }
  const uid = userId !== undefined ? userId : store.currentUid;
  if (!uid) {
    if (!store.tempCookies.__default) store.tempCookies.__default = {};
    return store.tempCookies.__default;
  }
  if (!store.cookies[uid]) store.cookies[uid] = {};
  return store.cookies[uid];
}

function mergeSetCookies(setCookieHeaders, jar) {
  if (!setCookieHeaders || !Array.isArray(setCookieHeaders)) return;
  for (const line of setCookieHeaders) {
    const firstPart = line.split(';')[0];
    const eqIdx = firstPart.indexOf('=');
    if (eqIdx > 0) {
      jar[firstPart.slice(0, eqIdx).trim()] = firstPart.slice(eqIdx + 1).trim();
    }
  }
}

async function cxRequest(urlStr, {
  method = 'GET',
  params = null,
  headers = {},
  body = null,
  userId = undefined,
  tempSessionKey = null,
  rawBuffer = false,
  allowRedirects = true,
} = {}) {
  let targetUrl = new URL(urlStr);
  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) targetUrl.searchParams.set(k, String(v));
    }
  }

  const jar = getCookieJar(userId, tempSessionKey);
  let redirectCount = 0;
  let currentMethod = method.toUpperCase();
  let currentBody = body;

  while (redirectCount <= 4) {
    const cookieHeader = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const reqHeaders = { ...getChaoxingHeaders(), ...headers };
    if (cookieHeader) reqHeaders['Cookie'] = cookieHeader;

    let payloadBuffer = null;
    if (currentBody !== null && currentBody !== undefined && currentMethod !== 'GET') {
      if (Buffer.isBuffer(currentBody)) payloadBuffer = currentBody;
      else if (typeof currentBody === 'string') payloadBuffer = Buffer.from(currentBody, 'utf8');
      else if (typeof currentBody === 'object') {
        const encoded = Object.entries(currentBody)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join('&');
        payloadBuffer = Buffer.from(encoded, 'utf8');
      }
      if (payloadBuffer) reqHeaders['Content-Length'] = payloadBuffer.length;
    }

    const res = await new Promise((resolve, reject) => {
      const lib = targetUrl.protocol === 'https:' ? https : http;
      const req = lib.request(targetUrl, { method: currentMethod, headers: reqHeaders, timeout: 12000 }, (resp) => {
        const chunks = [];
        resp.on('data', (chunk) => chunks.push(chunk));
        resp.on('end', () => resolve({ statusCode: resp.statusCode, headers: resp.headers, buffer: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('Request timeout')));
      if (payloadBuffer) req.write(payloadBuffer);
      req.end();
    });

    mergeSetCookies(res.headers['set-cookie'], jar);
    if (userId) saveStore();

    if (allowRedirects && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      const loc = res.headers.location;
      targetUrl = loc.startsWith('http') ? new URL(loc) : new URL(loc, targetUrl.origin);
      currentMethod = 'GET';
      currentBody = null;
      redirectCount++;
      continue;
    }

    if (rawBuffer) return res.buffer;
    const text = res.buffer.toString('utf8');
    try { return JSON.parse(text); } catch (_) { return text; }
  }
  return null;
}

module.exports = {
  Constant,
  EncryptionUtil,
  store,
  saveStore,
  createDefaultUserProfile,
  ensureUserProfile,
  getEffectiveUserProfile,
  getEffectiveScheduleForPanelUser,
  getEffectiveScheduleForCxUid,
  logsBuffer,
  sysLog,
  cxRequest,
};
