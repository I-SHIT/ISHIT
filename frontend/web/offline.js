const MODE_KEY = 'ishit_mode';
const LOCAL_DB = 'ishit-local-engine';
const LOCAL_FORMAT = 'ishit-local';
let localWorker = null;
let localReady = null;
let localSequence = 0;
let localNetworkSequence = 0;
const localNetworkPrefix = Array.from(crypto.getRandomValues(new Uint32Array(2)), n => n.toString(16)).join('-');
let localWrite = Promise.resolve();
let localDb = null;
let localActive = !document.hidden;
let localPersistenceError = null;
const localCalls = new Map();
const localNetwork = new Map();
const localFiles = {};
const localAssetUrls = new Map();

function isOfflineMode() { return localStorage.getItem(MODE_KEY) === 'offline'; }
function decodeLocalText(base64) {
  return new TextDecoder().decode(Uint8Array.from(atob(base64), c => c.charCodeAt(0)));
}
function encodeLocalText(text) {
  const bytes = new TextEncoder().encode(text);
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw);
}
function openLocalDatabase() {
  if (localDb) return Promise.resolve(localDb);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LOCAL_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('files');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => { localDb = request.result; resolve(localDb); };
  });
}
async function readLocalFiles() {
  const db = await openLocalDatabase();
  return new Promise((resolve, reject) => {
    const files = {};
    const transaction = db.transaction('files');
    const cursor = transaction.objectStore('files').openCursor();
    cursor.onsuccess = () => {
      const row = cursor.result;
      if (row) { files[row.key] = row.value; row.continue(); }
    };
    transaction.oncomplete = () => resolve(files);
    transaction.onerror = () => reject(transaction.error);
  });
}
async function persistLocalFiles(files, replace = false) {
  const db = await openLocalDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('files', 'readwrite');
    const store = transaction.objectStore('files');
    if (replace) store.clear();
    for (const [key, value] of Object.entries(files)) store.put(value, key);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('保存被中断'));
  });
}
function enqueueLocalWrite(path, value) {
  localFiles[path] = value;
  localWrite = localWrite.then(() => persistLocalFiles({ [path]: value })).catch(err => {
    localPersistenceError = err;
    showToast('本地保存失败 · ' + err.message);
    onLocalForeground(false);
  });
}
function loadLocalEngineScript() {
  if (window.ISHIT_LOCAL_WORKER_SOURCE) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'local-engine.js?v=021';
    script.onload = resolve;
    script.onerror = () => reject(new Error('本地引擎加载失败，请重新安装客户端'));
    document.head.append(script);
  });
}
function legacyOfflineFiles(raw) {
  const old = JSON.parse(raw);
  if (old.format !== 'ishit-offline' || old.version !== 1 || !Array.isArray(old.courses) || !Array.isArray(old.lessons))
    throw new Error('旧版离线配置无法识别');
  const uid = 'local-courses';
  const profile = { coursesCache: old.courses.map(c => ({ courseId: c.id, classId: '', name: c.name, note: c.classroom })),
    courseSettings: Object.fromEntries(old.courses.map(c => [c.id, { pollingEnabled: c.enabled }])),
    diyLessons: old.lessons.map((l, i) => ({ id: 'legacy-' + i, isDiy: true, courseId: l.course,
      name: old.courses.find(c => c.id === l.course)?.name || '课程', dayOfWeek: l.day, weeks: l.weeks,
      startTime: l.start, endTime: l.end, enabled: l.enabled, pollingEnabled: l.enabled })),
    useCurriculumSchedule: true, curriculumBufferMinutes: old.buffer, curriculumCache: null };
  const store = { accounts: [{ uid, name: '旧版本地课表', platform: 'local', status: 'local', ownerUsername: old.name }],
    currentUid: uid, userProfiles: { [uid]: profile }, schedule: { masterEnabled: old.enabled, intervalSeconds: old.interval },
    panelAuth: { enabled: false, username: old.name, sessions: {}, users: [] } };
  return { '/data/store.json': encodeLocalText(JSON.stringify(store)) };
}
async function startLocalEngine() {
  if (localReady) return localReady;
  localReady = (async () => {
    await loadLocalEngineScript();
    let files = await readLocalFiles();
    if (!Object.keys(files).length && localStorage.getItem('ishit_offline_workspace_v1')) {
      files = legacyOfflineFiles(localStorage.getItem('ishit_offline_workspace_v1'));
      await persistLocalFiles(files, true);
    }
    if (files['/data/store.json']) validateLocalImport({ format: LOCAL_FORMAT, version: 2, files });
    Object.assign(localFiles, files);
    const blob = URL.createObjectURL(new Blob([window.ISHIT_LOCAL_WORKER_SOURCE], { type: 'application/javascript' }));
    const worker = new Worker(blob);
    URL.revokeObjectURL(blob);
    localWorker = worker;
    await new Promise((resolve, reject) => {
      worker.onerror = event => reject(new Error(event.message || '本地引擎初始化失败'));
      worker.onmessage = async event => {
        const msg = event.data;
        if (msg.type === 'ready') { resolve(); return; }
        if (msg.type === 'initError') { reject(new Error(msg.error)); return; }
        if (msg.type === 'persist') { enqueueLocalWrite(msg.path, msg.value); return; }
        if (msg.type === 'network') { sendLocalHttp(msg, worker); return; }
        if (msg.type === 'cancelNetwork') {
          for (const [id, request] of localNetwork) {
            if (request.worker === worker && request.id === msg.id) cancelLocalHttp(id);
          }
          return;
        }
        if (msg.type === 'result') {
          const call = localCalls.get(msg.id);
          if (!call) return;
          localCalls.delete(msg.id);
          await localWrite;
          if (msg.error || (localPersistenceError && call.type !== 'snapshot')) call.reject(new Error(msg.error || localPersistenceError.message));
          else call.resolve(msg.result);
        }
      };
      worker.postMessage({ type: 'init', files, active: localActive });
    });
    await localWrite;
  })();
  try { await localReady; } catch (err) { localReady = null; stopLocalEngine(); throw err; }
}
function localRpc(type, args = {}) {
  return new Promise((resolve, reject) => {
    const id = ++localSequence;
    localCalls.set(id, { resolve, reject, type });
    localWorker.postMessage({ type, id, ...args });
  });
}
async function localApi(url, method = 'GET', body = null) {
  await startLocalEngine();
  if (!url.startsWith('/api/')) throw new Error('本地接口路径无效');
  const result = await localRpc('api', { url, method, body });
  return result.json || JSON.parse(decodeLocalText(result.body));
}
function localAssetUrl(path) {
  const bytes = localFiles['/data/comment_images/' + path.split('/').pop()];
  if (!bytes) return '';
  const previous = localAssetUrls.get(path);
  if (previous?.bytes === bytes) return previous.url;
  if (previous) URL.revokeObjectURL(previous.url);
  const mime = path.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(bytes), c => c.charCodeAt(0))], { type: mime }));
  localAssetUrls.set(path, { bytes, url });
  return url;
}
function cancelLocalHttp(id) {
  localNetwork.delete(id);
  if (window.IshitAndroidBridge?.cancelLocalRequest) window.IshitAndroidBridge.cancelLocalRequest(id);
  else window.chrome?.webview?.postMessage('local:cancel:' + id);
}
function sendLocalHttp(request, worker) {
  const id = localNetworkPrefix + '-' + (++localNetworkSequence);
  if (!localActive) {
    worker.postMessage({ type: 'networkResult', id: request.id, error: '请保持客户端在前台' });
    return;
  }
  const payload = { ...request, id };
  localNetwork.set(id, { worker, id: request.id });
  if (window.IshitAndroidBridge?.localRequest) window.IshitAndroidBridge.localRequest(JSON.stringify(payload));
  else if (window.chrome?.webview) window.chrome.webview.postMessage('local:http:' + JSON.stringify(payload));
  else onLocalHttpResult({ id, error: '学习通本地请求需要 Windows 或 Android 客户端' });
}
window.onLocalHttpResult = raw => {
  const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const pending = localNetwork.get(String(result.id));
  if (!pending) return;
  localNetwork.delete(String(result.id));
  pending.worker.postMessage({ ...result, type: 'networkResult', id: pending.id });
};
window.onLocalForeground = active => {
  localActive = Boolean(active) && !document.hidden && !localPersistenceError;
  localWorker?.postMessage({ type: 'foreground', active: localActive });
  if (!localActive) {
    for (const [id, pending] of localNetwork) {
      pending.worker.postMessage({ type: 'networkResult', id: pending.id, error: '客户端进入后台，请回到前台后继续' });
      cancelLocalHttp(id);
    }
  }
  const label = document.getElementById('localModeStatus');
  if (label) label.textContent = localActive ? '离线模式 · 本机运行' : '离线模式 · 后台已暂停';
};
document.addEventListener('visibilitychange', () => onLocalForeground(!document.hidden));
window.addEventListener('blur', () => onLocalForeground(false));
window.addEventListener('focus', () => onLocalForeground(true));

function stopLocalEngine() {
  for (const id of localNetwork.keys()) cancelLocalHttp(id);
  localWorker?.terminate();
  localWorker = null;
  localReady = null;
  for (const call of localCalls.values()) call.reject(new Error('本地引擎已停止'));
  localCalls.clear();
}
async function enterOfflineMode() {
  try {
    await localWrite;
    window.IshitAndroidBridge?.setOfflineMode?.(true);
    localStorage.setItem(MODE_KEY, 'offline');
    location.reload();
  } catch (err) { showToast(err.message); }
}
async function leaveOfflineMode() {
  onLocalForeground(false);
  await localWrite;
  if (localPersistenceError) { showToast('请先导出配置 · ' + localPersistenceError.message); return; }
  stopLocalEngine();
  localStorage.removeItem(MODE_KEY);
  window.IshitAndroidBridge?.setOfflineMode?.(false);
  location.replace(location.pathname);
}
function toggleClientMode() {
  if (isOfflineMode()) leaveOfflineMode();
  else enterOfflineMode();
}
async function exportOffline() {
  try {
    const snapshot = await localRpc('snapshot');
    snapshot.preferences = {
      helperName: localStorage.getItem('ishit_helper_name') || '',
      helperStudentId: localStorage.getItem('ishit_helper_sid') || ''
    };
    const json = JSON.stringify(snapshot, null, 2);
    if (window.IshitAndroidBridge?.exportOfflineConfig) { window.IshitAndroidBridge.exportOfflineConfig(json); return; }
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'ISHIT-offline.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (err) { showToast('导出失败 · ' + err.message); }
}
function validateLocalImport(data) {
  if (data.format === 'ishit-offline' && data.version === 1) return legacyOfflineFiles(JSON.stringify(data));
  if (data.format !== LOCAL_FORMAT || data.version !== 2 || !data.files || typeof data.files !== 'object' || Array.isArray(data.files))
    throw new Error('配置格式或版本不受支持');
  const files = data.files;
  const raw = files['/data/store.json'];
  if (typeof raw !== 'string') throw new Error('配置缺少账号数据');
  for (const [key, value] of Object.entries(files)) {
    if (!(key === '/data/store.json' || /^\/data\/comment_images\/[\w.-]+$/.test(key)) || typeof value !== 'string')
      throw new Error('配置包含无效文件');
    atob(value);
  }
  const store = JSON.parse(decodeLocalText(raw));
  if (!Array.isArray(store.accounts) || !store.userProfiles || typeof store.userProfiles !== 'object' ||
      !store.schedule || typeof store.schedule !== 'object' || !store.panelAuth?.username)
    throw new Error('账号或课表配置不完整');
  const seen = new Set();
  for (const account of store.accounts) {
    if (!account?.uid || seen.has(String(account.uid))) throw new Error('账号标识重复或缺失');
    seen.add(String(account.uid));
  }
  for (const profile of Object.values(store.userProfiles)) {
    if (!profile || !Array.isArray(profile.coursesCache) || !Array.isArray(profile.diyLessons) ||
        !profile.courseSettings || typeof profile.courseSettings !== 'object') throw new Error('课程配置无效');
  }
  return files;
}
async function importOfflineFile(input) {
  if (!input.files.length) return;
  try {
    const data = JSON.parse(await input.files[0].text());
    const files = validateLocalImport(data);
    if (!confirm('将用备份替换本机全部离线账号、课程、设置和记录，是否继续？')) return;
    onLocalForeground(false);
    stopLocalEngine();
    await localWrite;
    await persistLocalFiles(files, true);
    if (data.preferences) {
      localStorage.setItem('ishit_helper_name', String(data.preferences.helperName || ''));
      localStorage.setItem('ishit_helper_sid', String(data.preferences.helperStudentId || ''));
    }
    location.reload();
  } catch (err) {
    showToast('导入失败 · ' + err.message);
    if (!localWorker) { localActive = !document.hidden; await startLocalEngine(); }
  } finally { input.value = ''; }
}
async function openOfflineShare() {
  const url = document.getElementById('localShareInput').value.trim();
  if (!url) return showToast('请输入分享链接');
  try {
    const result = await localApi('/api/local/helper/open', 'POST', { url });
    if (result.login) { switchMainModule('settings'); switchSettingsSubTab('accounts'); }
    else openInAppBountyAssist(result.token);
  } catch (err) { showToast(err.message); }
}
function applyOfflineUi() {
  document.documentElement.classList.toggle('offline-mode', isOfflineMode());
  document.querySelectorAll('[data-mode-button]').forEach(el => {
    el.textContent = isOfflineMode() ? '切回在线模式' : '进入离线模式';
  });
  onLocalForeground(localActive);
}
