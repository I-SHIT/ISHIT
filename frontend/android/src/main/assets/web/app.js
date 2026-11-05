const state = {
  status: null,
  selectedUid: null,
  courses: [],
  qrPollTimer: null,
  statusPollTimer: null,
  currentManualCtx: null,
  currentCsCourse: null,
  currentHelpPayload: null,
  currentCaptchaKey: null,
  helperToken: null,
  helperSession: null,
  helperLoggedIn: false,
  helperPrimaryAccount: null,
  inAppHelperReturn: false,
  inAppReturnModule: 'bounty',
  seenAlertIds: new Set(),
  initialAlertsSeeded: false,
  currentLiveAlert: null,
  lastPollIntervalMs: 5000,
  mainMap: null,
  mainMarker: null,
  modalMap: null,
  modalMarker: null,
  modalTargetIds: null,
  copiedLessonClipboard: null,
  claimCommentImageUrl: '',
  claimCommentUploading: false,
  adminBountyData: null,
  adminRecordTab: 'bountyHistory',
};

const SIGN_TYPE_LABELS = {
  normal: '普通签到',
  qrCode: '二维码签到',
  pattern: '手势签到',
  location: '位置签到',
  code: '签到码签到',
};

function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2600);
}

const DEFAULT_REMOTE_API_BASE = 'http://47.117.27.75';
const DEFAULT_HTTPS_TUNNEL_BASE = 'https://appraisal-occurring-performance-phrase.trycloudflare.com';
const FALLBACK_DIRECT_API_BASE = 'http://47.117.27.75';
let _loadedConfigEndpoint = null;

function detectPlatformType() {
  if (window.ISHIT_PLATFORM === 'windows') return 'windows';
  if (window.ISHIT_PLATFORM === 'android') return 'android';
  const host = String(location.hostname || '').toLowerCase();
  if (host === 'ishit.local') return 'windows';
  if (host === 'appassets.androidplatform.net' || window.IshitAndroidBridge) return 'android';
  return 'web';
}

function applyPlatformLayoutClass() {
  const plat = detectPlatformType();
  const root = document.documentElement;
  root.classList.remove('platform-windows', 'platform-android', 'platform-web');
  root.classList.add(`platform-${plat}`);
  return plat;
}

applyPlatformLayoutClass();

function sendWinHostCmd(cmd) {
  try {
    if (window.chrome && window.chrome.webview && typeof window.chrome.webview.postMessage === "function") {
      window.chrome.webview.postMessage(cmd);
    }
  } catch (_) {}
}

function isInteractiveCaptionTarget(target) {
  if (!target || typeof target.closest !== "function") return false;
  return Boolean(target.closest("button, a, input, select, textarea, label, .win-window-controls, .status-dot"));
}

function onWinTitlebarMouseDown(e) {
  if (detectPlatformType() !== "windows") return;
  if (e && e.button !== 0) return;
  if (isInteractiveCaptionTarget(e?.target)) return;
  sendWinHostCmd("win:drag");
}

function onWinTitlebarDblClick(e) {
  if (detectPlatformType() !== "windows") return;
  if (isInteractiveCaptionTarget(e?.target)) return;
  sendWinHostCmd("win:maximize");
}

window.onHostWindowStateChange = function(isMaximized) {
  document.documentElement.classList.toggle("win-maximized", Boolean(isMaximized));
  document.querySelectorAll(".win-max-btn").forEach((btn) => {
    btn.innerHTML = isMaximized
      ? '<svg class="win-icon-max" viewBox="0 0 12 12"><path d="M3.5 3.5V2.2h6.3v6.3H8.5M2.2 3.8h6v6h-6z" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round"/></svg>'
      : '<svg class="win-icon-max" viewBox="0 0 12 12"><rect x="2.2" y="2.2" width="7.6" height="7.6" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
  });
};

function mountWinResizeHandles() {
  if (detectPlatformType() !== "windows") return;
  if (document.getElementById("winResizeOverlay")) return;
  const wrap = document.createElement("div");
  wrap.id = "winResizeOverlay";
  const dirs = ["top", "bottom", "left", "right", "topleft", "topright", "bottomleft", "bottomright"];
  for (const d of dirs) {
    const g = document.createElement("div");
    g.className = `win-resize-grip win-resize-${d}`;
    g.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if (document.documentElement.classList.contains("win-maximized")) return;
      e.preventDefault();
      e.stopPropagation();
      sendWinHostCmd(`win:resize:${d}`);
    });
    wrap.appendChild(g);
  }
  document.body.appendChild(wrap);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mountWinResizeHandles);
} else {
  mountWinResizeHandles();
}

function updateWinTopbarTitle(mainMod, subTitle) {
  const el = document.getElementById("winActiveModuleTitle");
  if (!el) return;
  if (subTitle) {
    el.textContent = `${mainMod} · ${subTitle}`;
  } else {
    el.textContent = mainMod;
  }
}

if (!isStandaloneClientEnv() && String(location.hostname || "").toLowerCase() === "ishit.pw" && location.protocol === "http:") {
  location.replace("https://ishit.pw" + location.pathname + location.search + location.hash);
}

function isStandaloneClientEnv() {
  const plat = detectPlatformType();
  if (plat === 'windows' || plat === 'android') return true;
  const proto = String(location.protocol || '').toLowerCase();
  if (proto === 'file:' || proto === 'app:' || proto === 'capacitor:') return true;
  if (window.ISHIT_NATIVE_CLIENT === true) return true;
  return false;
}

function normalizeApiBaseUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  return s.replace(/\/+$/, '');
}

function resolveEndpointFromConfigObj(cfg) {
  if (!cfg || typeof cfg !== 'object') return '';
  // 若当前为公网 Web 浏览器 HTTPS 环境（如 https://ishit.pw），自动使用加密隧道 httpsApiBaseUrl 绕过 Mixed Content 与备案墙
  if (!isStandaloneClientEnv() && location.protocol === 'https:' && cfg.httpsApiBaseUrl) {
    return normalizeApiBaseUrl(cfg.httpsApiBaseUrl);
  }
  if (cfg.apiBaseUrl && String(cfg.apiBaseUrl).trim()) {
    return normalizeApiBaseUrl(cfg.apiBaseUrl);
  }
  if (cfg.serverHost && String(cfg.serverHost).trim()) {
    const host = String(cfg.serverHost).trim();
    const port = cfg.serverPort && Number(cfg.serverPort) !== 80 && Number(cfg.serverPort) !== 443 ? `:${cfg.serverPort}` : '';
    return normalizeApiBaseUrl(`${host}${port}`);
  }
  return '';
}

function readBridgeConfigSync() {
  if (window.IshitAndroidBridge && typeof window.IshitAndroidBridge.getConfigJson === 'function') {
    try {
      const raw = window.IshitAndroidBridge.getConfigJson();
      if (raw) {
        const parsedObj = JSON.parse(raw);
        window.ISHIT_CONFIG = parsedObj;
        const ep = resolveEndpointFromConfigObj(parsedObj);
        if (ep) return ep;
      }
    } catch (_) {}
  }
  if (window.ISHIT_CONFIG && typeof window.ISHIT_CONFIG === 'object') {
    const fromInjected = resolveEndpointFromConfigObj(window.ISHIT_CONFIG);
    if (fromInjected) return fromInjected;
  }
  return '';
}

async function loadExternalConfigJson() {
  try {
    localStorage.removeItem('ishit_api_base_url');
  } catch (_) {}

  const syncEp = readBridgeConfigSync();
  if (syncEp) {
    _loadedConfigEndpoint = syncEp;
    return _loadedConfigEndpoint;
  }

  try {
    const res = await fetch(`config.json?_t=${Date.now()}`, { cache: 'no-store' });
    if (res.ok) {
      const cfg = await res.json();
      const parsed = resolveEndpointFromConfigObj(cfg);
      if (parsed) {
        _loadedConfigEndpoint = parsed;
        return _loadedConfigEndpoint;
      }
    }
  } catch (_) {}
  _loadedConfigEndpoint = (!isStandaloneClientEnv() && location.protocol === 'https:')
    ? DEFAULT_HTTPS_TUNNEL_BASE
    : DEFAULT_REMOTE_API_BASE;
  return _loadedConfigEndpoint;
}

function getApiBaseUrl() {
  const syncEp = readBridgeConfigSync();
  if (syncEp) return syncEp;
  if (_loadedConfigEndpoint) {
    return _loadedConfigEndpoint;
  }
  return (!isStandaloneClientEnv() && location.protocol === 'https:')
    ? DEFAULT_HTTPS_TUNNEL_BASE
    : DEFAULT_REMOTE_API_BASE;
}

function resolveAssetUrl(rawUrl) {
  const s = String(rawUrl || '').trim();
  if (!s) return '';
  if (/^(https?:|data:|blob:)/i.test(s)) return s;
  const base = getApiBaseUrl();
  if (s.startsWith('/')) return base ? base + s : s;
  return base ? `${base}/${s}` : s;
}

function openImagePreviewModal(src) {
  const clean = resolveAssetUrl(src);
  if (!clean) return;
  const img = document.getElementById('imagePreviewModalImg');
  if (img) img.src = clean;
  openModal('imagePreviewModal');
}

function syncApiEndpointUi() {}

async function api(url, method = 'GET', body = null) {
  const base = getApiBaseUrl();
  const fullUrl = /^https?:\/\//i.test(url) ? url : (base ? base + url : url);
  const isCrossOrigin = Boolean(base && (!location.origin || base !== location.origin));
  const opts = {
    method,
    headers: {},
    credentials: isCrossOrigin ? 'omit' : 'same-origin',
  };
  const savedToken = localStorage.getItem('ishit_panel_token');
  if (savedToken) opts.headers['X-Panel-Token'] = savedToken;
  if (state.helperToken) opts.headers['X-Helper-Token'] = state.helperToken;
  if (body !== null) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(fullUrl, opts);
  } catch (err) {
    // 若在原生客户端 (Windows/Android) 或非 HTTPS 环境下域名尚未生效，自动无缝回退至云服务器 IP 端口直连
    const fallbackBase = (window.ISHIT_CONFIG && window.ISHIT_CONFIG.directIpUrl) || FALLBACK_DIRECT_API_BASE;
    if (fallbackBase && base !== fallbackBase && (isStandaloneClientEnv() || location.protocol !== 'https:')) {
      _loadedConfigEndpoint = normalizeApiBaseUrl(fallbackBase);
      const retryUrl = /^https?:\/\//i.test(url) ? url : (_loadedConfigEndpoint + url);
      res = await fetch(retryUrl, { ...opts, credentials: 'omit' });
    } else {
      throw err;
    }
  }
  const data = await res.json();
  if (res.status === 401 && data && data.needAuth && !state.helperToken) {
    showPanelLoginScreen();
  }
  return data;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setHtmlIfChanged(el, html, sig = html) {
  if (!el) return false;
  if (el._lastRenderSig === sig) return false;
  el._lastRenderSig = sig;
  el.innerHTML = html;
  return true;
}

function updateRemainTagsInPlace(container) {
  if (!container) return;
  const now = Date.now();
  container.querySelectorAll('.js-remain-tag[data-end-ms]').forEach((tag) => {
    const endMs = Number(tag.getAttribute('data-end-ms') || 0);
    if (endMs > now) {
      const remainSec = Math.max(0, Math.round((endMs - now) / 1000));
      tag.textContent = `剩余 ${remainSec >= 60 ? Math.floor(remainSec / 60) + '分' + (remainSec % 60) + '秒' : remainSec + '秒'}`;
    }
  });
}

let modalZCounter = 1000;
function openModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  modalZCounter += 10;
  el.style.zIndex = String(modalZCounter);
  el.classList.add('open');
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('open');
}

function copyText(inputId) {
  const el = document.getElementById(inputId);
  if (!el) return;
  el.select();
  if (window.IshitAndroidBridge && typeof window.IshitAndroidBridge.copyToClipboard === 'function') {
    window.IshitAndroidBridge.copyToClipboard(el.value);
  } else if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(el.value).catch(() => document.execCommand('copy'));
  } else {
    document.execCommand('copy');
  }
  showToast('已复制');
}

function initPatternGrid(containerId, inputId) {
  const box = document.getElementById(containerId);
  if (!box) return;
  box.innerHTML = '';
  for (let i = 1; i <= 9; i++) {
    const dot = document.createElement('div');
    dot.className = 'pattern-dot';
    dot.textContent = i;
    dot.onclick = () => {
      const inp = document.getElementById(inputId);
      if (!inp.value.includes(String(i))) {
        inp.value += String(i);
        dot.classList.add('active');
      }
    };
    box.appendChild(dot);
  }
}

function clearPattern(inputId, gridId) {
  const inp = document.getElementById(inputId);
  if (inp) inp.value = '';
  document.querySelectorAll(`#${gridId} .pattern-dot`).forEach((d) => d.classList.remove('active'));
}

function isCurrentPanelAdmin() {
  return (state.status?.panelAuth?.role || state.panelRole || 'admin') === 'admin';
}

function getCurrentPanelUsername() {
  return state.status?.panelAuth?.username || state.panelUsername || '';
}

function canEditSelectedAccount() {
  if (isCurrentPanelAdmin()) return true;
  if (state.status && state.status.canEditSelectedAccount !== undefined) {
    return Boolean(state.status.canEditSelectedAccount);
  }
  const curAcc = (state.status?.accounts || []).find((a) => String(a.uid) === String(state.selectedUid));
  if (!curAcc) return false;
  return curAcc.ownerUsername === getCurrentPanelUsername();
}

function applyPanelRolePermissionsUi(panelAuth) {
  const role = panelAuth?.role || state.panelRole || 'admin';
  const username = panelAuth?.username || state.panelUsername || '';
  state.panelRole = role;
  state.panelUsername = username;
  const isAdmin = role === 'admin';

  // 顶部与 Windows 侧边栏当前网站用户与角色标签
  const badgeText = username ? `${username} (${isAdmin ? 'Admin' : 'User'})` : '';
  const userBadge = document.getElementById('currentPanelUserBadge');
  if (userBadge) {
    userBadge.textContent = badgeText;
    userBadge.style.display = username ? 'inline-flex' : 'none';
  }
  const winUserBadge = document.getElementById('winSidebarPanelUserBadge');
  if (winUserBadge) {
    winUserBadge.textContent = badgeText;
    winUserBadge.style.display = username ? 'inline-flex' : 'none';
  }

  // 1. User 与 Admin 均显示【仪表盘】（User 仅看自身账号签到记录与相关日志）；User 隐藏【系统设置 -> NapCat 推送】
  const tabGlobal = document.getElementById('mainTabGlobal');
  if (tabGlobal) tabGlobal.style.display = '';

  const tabNapcat = document.getElementById('settingsTabNapcat');
  if (tabNapcat) tabNapcat.style.display = isAdmin ? '' : 'none';
  const winTabNapcat = document.getElementById('winSettingsTabNapcat');
  if (winTabNapcat) winTabNapcat.style.display = isAdmin ? '' : 'none';
  const paneNapcat = document.getElementById('settings-pane-napcat');
  if (!isAdmin && paneNapcat) paneNapcat.style.display = 'none';

  const tabBountyAdmin = document.getElementById('settingsTabBounty');
  if (tabBountyAdmin) tabBountyAdmin.style.display = isAdmin ? '' : 'none';
  const winTabBountyAdmin = document.getElementById('winSettingsTabBounty');
  if (winTabBountyAdmin) winTabBountyAdmin.style.display = isAdmin ? '' : 'none';
  const paneBountyAdmin = document.getElementById('settings-pane-bounty-admin');
  if (!isAdmin && paneBountyAdmin) paneBountyAdmin.style.display = 'none';

  const activeSettingSub = document.querySelector('#settingsSubTabs .tab-btn.active')?.getAttribute('data-sub');
  if (!isAdmin && (activeSettingSub === 'napcat' || activeSettingSub === 'bounty-admin')) {
    switchSettingsSubTab('polling');
  }

  // 2. 用户管理中的 Admin 用户管理面板显隐
  const adminUsersPanel = document.getElementById('adminUsersManagePanel');
  if (adminUsersPanel) adminUsersPanel.style.display = isAdmin ? 'block' : 'none';
  const secRoleHint = document.getElementById('secSelfRoleHint');
  if (secRoleHint) {
    secRoleHint.textContent = isAdmin
      ? '您当前为管理员 (Admin)'
      : '您当前为普通用户 (User)';
  }

  // 3. 账号工作台只读横幅与控件可用状态
  const canEdit = canEditSelectedAccount();
  const curAcc = (state.status?.accounts || []).find((a) => String(a.uid) === String(state.selectedUid));
  const banner = document.getElementById('userReadonlyBanner');
  const bannerText = document.getElementById('userReadonlyBannerText');
  if (banner) {
    if (!canEdit && curAcc) {
      banner.style.display = 'flex';
      if (bannerText) {
        bannerText.textContent = `只读浏览模式：当前查看的学习通账号「${curAcc.name}」归属于网站用户 [${curAcc.ownerUsername || 'admin'}]，您可查看其课程与课表，但无法修改配置。`;
      }
    } else {
      banner.style.display = 'none';
    }
  }

  // 课表与位置面板中的保存/编辑按钮对非归属 User 禁用
  document.querySelectorAll('#user-pane-schedule button, #user-pane-schedule input, #user-pane-schedule select').forEach((el) => {
    // 允许周次切换和“显示非本周课程”复选框在只读模式下正常交互浏览
    if (el.closest('#curriculumTableWrap')) return;
    el.disabled = !canEdit;
    el.style.opacity = !canEdit ? '0.55' : '';
  });
  document.querySelectorAll('#user-pane-user-location input, #user-pane-user-location button').forEach((el) => {
    // 全局常用位置预设池与地图选点搜索对所有用户开放使用（除他人预设的编辑/删除在列表内单独控制）
    if (el.closest('#locationPresetsList')) return;
    if (el.getAttribute('onclick')?.includes('applyMapPointToUserDefault') || el.getAttribute('onclick')?.includes('saveUserProfileConfig')) {
      el.disabled = !canEdit;
      el.style.opacity = !canEdit ? '0.55' : '';
    }
  });
  ['profDefAddress', 'profDefLat', 'profDefLng'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = !canEdit;
  });
}

function switchMainModule(mod) {
  document.querySelectorAll('#adminApp .module-pane').forEach((p) => (p.style.display = 'none'));
  const target = document.getElementById(`module-${mod}`);
  if (target) target.style.display = 'block';
  document.querySelectorAll('#mainModuleTabs .tab-btn').forEach((b) => {
    b.classList.toggle('active', b.getAttribute('data-main') === mod);
  });
  document.querySelectorAll('#winDesktopSidebar .win-nav-item').forEach((b) => {
    b.classList.toggle('active', b.getAttribute('data-main') === mod);
  });
  document.querySelectorAll('#androidBottomNav .android-tab-item').forEach((b) => {
    b.classList.toggle('active', b.getAttribute('data-main') === mod);
  });
  const scroller = document.querySelector('#adminApp .app-content-scroll');
  if (scroller) scroller.scrollTop = 0;

  const hintEl = document.getElementById('moduleScopeHint');
  if (hintEl) {
    if (mod === 'global') {
      hintEl.textContent = '仪表盘';
      updateWinTopbarTitle('实时仪表盘');
    } else if (mod === 'bounty') {
      hintEl.textContent = '签到悬赏与大师榜';
      updateWinTopbarTitle('签到悬赏');
      updateNotifyPermButtonText();
    } else if (mod === 'user') {
      const curAcc = (state.status?.accounts || []).find((a) => String(a.uid) === String(state.selectedUid));
      hintEl.textContent = curAcc ? `当前配置账号：${curAcc.name} (${curAcc.uid})` : '按账号独立配置课程、课表与专属位置';
      const activeSub = document.querySelector('#userSubTabs .tab-btn.active')?.getAttribute('data-sub') || 'courses';
      if (activeSub === 'user-location') setTimeout(() => initMainLeafletMap(), 80);
    } else if (mod === 'settings') {
      hintEl.textContent = '与 ISHIT 有关的设置';
    }
  }
}

function switchUserSubTab(sub) {
  switchMainModule('user');
  document.querySelectorAll('#module-user .sub-pane').forEach((p) => (p.style.display = 'none'));
  const target = document.getElementById(`user-pane-${sub}`);
  if (target) target.style.display = 'block';
  document.querySelectorAll('#userSubTabs .tab-btn').forEach((b) => {
    b.classList.toggle('active', b.getAttribute('data-sub') === sub);
  });
  document.querySelectorAll('#winSubNavUser .win-subnav-item').forEach((b) => {
    b.classList.toggle('active', b.getAttribute('data-sub') === sub);
  });
  const userSubLabels = { courses: '我的课程', schedule: '我的课表与 DIY', 'user-location': '位置与共享预设' };
  updateWinTopbarTitle('账号工作台', userSubLabels[sub] || '');
  if (sub === 'user-location') {
    setTimeout(() => initMainLeafletMap(), 80);
  }
}

function switchSettingsSubTab(sub) {
  if ((sub === 'napcat' || sub === 'bounty-admin') && !isCurrentPanelAdmin()) {
    sub = 'polling';
  }
  switchMainModule('settings');
  document.querySelectorAll('#module-settings .sub-pane').forEach((p) => (p.style.display = 'none'));
  const target = document.getElementById(`settings-pane-${sub}`);
  if (target) target.style.display = 'block';
  document.querySelectorAll('#settingsSubTabs .tab-btn').forEach((b) => {
    b.classList.toggle('active', b.getAttribute('data-sub') === sub);
  });
  document.querySelectorAll('#winSubNavSettings .win-subnav-item').forEach((b) => {
    b.classList.toggle('active', b.getAttribute('data-sub') === sub);
  });
  const settingsSubLabels = {
    polling: '轮询与防钓鱼',
    accounts: '学习通账号池',
    'bounty-admin': '签到悬赏',
    napcat: 'NapCat 推送',
    security: '用户与权限',
  };
  updateWinTopbarTitle('系统设置', settingsSubLabels[sub] || '');
  if (sub === 'bounty-admin') {
    loadAdminBountyOverview(false);
  }
}

function switchTab(tab) {
  if (tab === 'overview' || tab === 'global') {
    switchMainModule('global');
  } else if (tab === 'bounty') {
    switchMainModule('bounty');
  } else if (tab === 'courses') {
    switchUserSubTab('courses');
  } else if (tab === 'schedule') {
    switchUserSubTab('schedule');
  } else if (tab === 'locations' || tab === 'user-location') {
    switchUserSubTab('user-location');
  } else if (tab === 'polling') {
    switchSettingsSubTab('polling');
  } else if (tab === 'accounts') {
    switchSettingsSubTab('accounts');
  } else if (tab === 'bounty-admin') {
    switchSettingsSubTab('bounty-admin');
  } else if (tab === 'napcat') {
    switchSettingsSubTab('napcat');
  } else if (tab === 'security') {
    switchSettingsSubTab('security');
  }
}

function showPanelLoginScreen() {
  applyPlatformLayoutClass();
  if (state.statusPollTimer) {
    clearInterval(state.statusPollTimer);
    state.statusPollTimer = null;
  }
  document.getElementById('adminApp').style.display = 'none';
  document.getElementById('helperApp').style.display = 'none';
  document.getElementById('panelLoginApp').style.display = '';
}

function syncAndroidNativeDaemonState(usernameOverride = '') {
  if (window.IshitAndroidBridge && typeof window.IshitAndroidBridge.syncAuthState === 'function') {
    try {
      const tk = localStorage.getItem('ishit_panel_token') || '';
      const base = getApiBaseUrl() || 'http://47.117.27.75';
      const uname = usernameOverride || state.panelUsername || state.status?.panelAuth?.username || '';
      window.IshitAndroidBridge.syncAuthState(String(tk), String(base), String(uname));
    } catch (_) {}
  }
}

function enterAdminPanel() {
  applyPlatformLayoutClass();
  document.getElementById('panelLoginApp').style.display = 'none';
  document.getElementById('helperApp').style.display = 'none';
  document.getElementById('adminApp').style.display = '';
  syncAndroidNativeDaemonState();
  refreshStatus(true);
  scheduleAdaptiveStatusPolling(3500);
  updateNotifyPermButtonText();
}

async function submitPanelLogin() {
  const username = document.getElementById('panelAuthUsername').value.trim();
  const password = document.getElementById('panelAuthPassword').value;
  const errEl = document.getElementById('panelAuthError');
  if (!username || !password) {
    if (errEl) errEl.textContent = '请输入后台账号与访问密码';
    showToast('请输入后台账号与访问密码');
    return;
  }
  if (errEl) errEl.textContent = '正在连接服务器验证...';
  try {
    const res = await api('/api/auth/login', 'POST', { username, password });
    if (res && res.ok) {
      if (res.token) localStorage.setItem('ishit_panel_token', res.token);
      state.panelRole = res.role || 'admin';
      state.panelUsername = res.username || '';
      state.selectedUid = null;
      document.getElementById('panelAuthPassword').value = '';
      if (errEl) errEl.textContent = '登录成功';
      showToast('已登录 ISHIT');
      enterAdminPanel();
    } else {
      const msg = (res && res.msg) || '账号或密码错误';
      if (errEl) errEl.textContent = msg;
      showToast(msg);
    }
  } catch (err) {
    const errMsg = '连接后端失败 (' + (getApiBaseUrl() || '47.117.27.75') + ')：' + (err.message || '网络异常');
    if (errEl) errEl.textContent = errMsg;
    showToast(errMsg);
  }
}

async function doPanelLogout() {
  await api('/api/auth/logout', 'POST', {});
  localStorage.removeItem('ishit_panel_token');
  syncAndroidNativeDaemonState('');
  showToast('已退出登录');
  showPanelLoginScreen();
}

function populateSecurityInputs(panelAuth) {
  if (!panelAuth) return;
  applyPanelRolePermissionsUi(panelAuth);
  const uEl = document.getElementById('secNewUsername');
  if (uEl && document.activeElement !== uEl) uEl.value = panelAuth.username || '';
  const tagEl = document.getElementById('secActiveSessionsTag');
  if (tagEl) tagEl.textContent = `在线会话 ${panelAuth.activeSessionCount || 1}`;
  if (panelAuth.role === 'admin') {
    renderPanelUsersList(panelAuth.users || [], panelAuth.username);
  }
}

function renderPanelUsersList(users, currentUsername) {
  const box = document.getElementById('panelUsersListContainer');
  if (!box) return;
  if (!users || users.length === 0) {
    setHtmlIfChanged(box, `<div class="empty">暂无网站用户</div>`);
    return;
  }
  const usersHtml = users
    .map((u) => {
      const isAdmin = u.role === 'admin' || u.username === 'ishit';
      const boundAccs = u.boundAccounts || [];
      const boundText =
        boundAccs.length > 0
          ? `已绑定学习通 (${boundAccs.length})：${boundAccs.map((a) => `${a.name}(${a.uid})`).join('、')}`
          : '暂未绑定学习通账号';
      const isProtected = u.username === 'ishit' || u.username === currentUsername;
      return `
        <div class="list-row" style="padding:8px 10px;">
          <div style="min-width:0; flex:1; padding-right:8px;">
            <div class="row" style="gap:6px;">
              <span style="font-weight:600; font-size:13px;">${escapeHtml(u.username)}</span>
              <span class="tag ${isAdmin ? 'solid' : ''}">${isAdmin ? 'Admin' : 'User'}</span>
              ${u.username === currentUsername ? '<span class="tag">当前登录</span>' : ''}
            </div>
            <div style="font-size:11px; color:var(--muted); margin-top:2px;">${escapeHtml(boundText)}</div>
          </div>
          <div class="row" style="gap:6px; flex-shrink:0;">
            <button type="button" class="btn btn-ghost btn-sm" onclick="openEditPanelUserModal('${escapeHtml(u.username)}','${isAdmin ? 'admin' : 'user'}')">修改</button>
            ${!isProtected ? `<button type="button" class="btn btn-ghost btn-sm" onclick="deletePanelUser('${escapeHtml(u.username)}')">删除</button>` : ''}
          </div>
        </div>
      `;
    })
    .join('');
  setHtmlIfChanged(box, usersHtml);
}

async function createPanelUser() {
  const username = document.getElementById('newPanelUserName')?.value.trim();
  const password = document.getElementById('newPanelUserPass')?.value || '';
  const role = document.getElementById('newPanelUserRole')?.value || 'user';
  if (!username) return showToast('请输入新用户的用户名');
  if (!password || password.length < 4) return showToast('初始密码长度不能少于 4 位');
  const res = await api('/api/auth/users', 'POST', {
    action: 'add',
    username,
    password,
    role,
  });
  if (res.ok) {
    document.getElementById('newPanelUserName').value = '';
    document.getElementById('newPanelUserPass').value = '';
    showToast(res.msg || '已创建用户');
    refreshStatus(true);
  } else {
    showToast(res.msg || '添加失败');
  }
}

function openEditPanelUserModal(username, role) {
  document.getElementById('editPanelTargetUsername').value = username;
  document.getElementById('editPanelNewUsername').value = username;
  document.getElementById('editPanelNewPassword').value = '';
  const roleSel = document.getElementById('editPanelRoleSelect');
  if (roleSel) {
    roleSel.value = username === 'ishit' ? 'admin' : role;
    roleSel.disabled = username === 'ishit';
  }
  openModal('editPanelUserModal');
}

async function saveEditedPanelUser() {
  const targetUsername = document.getElementById('editPanelTargetUsername').value.trim();
  const newUsername = document.getElementById('editPanelNewUsername').value.trim();
  const newPassword = document.getElementById('editPanelNewPassword').value;
  const role = document.getElementById('editPanelRoleSelect').value;
  if (!newUsername) return showToast('用户名不能为空');
  if (newPassword && newPassword.length < 4) return showToast('新密码长度不能少于 4 位');

  const res = await api('/api/auth/users', 'POST', {
    action: 'update',
    targetUsername,
    newUsername,
    newPassword,
    role,
  });
  if (res.ok) {
    closeModal('editPanelUserModal');
    showToast(res.msg || '用户信息已修改');
    refreshStatus(true);
  } else {
    showToast(res.msg || '修改失败');
  }
}

async function deletePanelUser(username) {
  const res = await api('/api/auth/users', 'POST', {
    action: 'delete',
    username,
  });
  if (res.ok) {
    showToast(res.msg || '已删除用户');
    refreshStatus(true);
  } else {
    showToast(res.msg || '删除失败');
  }
}

async function savePanelAuthCredentials() {
  const newUsername = document.getElementById('secNewUsername').value.trim();
  const currentPassword = document.getElementById('secCurrentPassword').value;
  const newPassword = document.getElementById('secNewPassword').value;
  if (!currentPassword) return showToast('请输入当前旧密码以校验身份');
  if (!newUsername) return showToast('登录账号不能为空');
  if (!newPassword || newPassword.length < 4) return showToast('新密码长度不能少于 4 位');

  const res = await api('/api/auth/update', 'POST', {
    currentPassword,
    newUsername,
    newPassword,
  });
  if (res.ok) {
    if (res.token) localStorage.setItem('ishit_panel_token', res.token);
    syncAndroidNativeDaemonState(newUsername);
    document.getElementById('secCurrentPassword').value = '';
    document.getElementById('secNewPassword').value = '';
    showToast(res.msg || '账号密码已更新');
    refreshStatus(true);
  } else {
    showToast(res.msg || '修改失败');
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  applyPlatformLayoutClass();
  await loadExternalConfigJson();
  initPatternGrid('manualPatternGrid', 'manualSignCode');
  initPatternGrid('helpPatternGrid', 'helpSignCode');

  const params = new URLSearchParams(location.search);
  const helpToken = params.get('help');
  if (helpToken) {
    state.helperToken = helpToken;
    initHelperMode(helpToken);
    return;
  }

  try {
    const auth = await api('/api/auth/check');
    if (auth.ok && (!auth.authRequired || auth.authenticated)) {
      enterAdminPanel();
    } else {
      showPanelLoginScreen();
    }
  } catch (_) {
    showPanelLoginScreen();
  }
});

async function onSelectConfigUser(uid) {
  state.selectedUid = uid;
  await refreshStatus(true);
  const activeMain = document.querySelector('#mainModuleTabs .tab-btn.active')?.getAttribute('data-main');
  if (activeMain === 'user') {
    const curAcc = (state.status?.accounts || []).find((a) => String(a.uid) === String(uid));
    const hintEl = document.getElementById('moduleScopeHint');
    if (hintEl && curAcc) hintEl.textContent = `当前配置账号：${curAcc.name} (${curAcc.uid})`;
  }
}

async function refreshStatus(syncInputs = false) {
  try {
    const q = state.selectedUid ? `?uid=${encodeURIComponent(state.selectedUid)}` : '';
    const data = await api(`/api/status${q}`);
    if (!data.ok) return;
    state.status = data;
    if (!state.selectedUid && data.selectedUid) state.selectedUid = data.selectedUid;
    state.courses = data.courses || [];
    syncAndroidNativeDaemonState(data.panelAuth?.username || '');

    renderTopStatus(data);
    renderUserSwitcher(data);
    renderOverview(data, syncInputs);
    renderBountyAndLeaderboard(data);
    processRealtimeSignAlerts(data);
    adjustAdaptivePollingFromData(data);
    renderCoursesList(state.courses);
    renderAccountsList(data.accounts || [], data.currentUid);
    renderLocationPresets(data.locationPresets || []);
    populateSecurityInputs(data.panelAuth);
    if (syncInputs) {
      const uEl = document.getElementById('secNewUsername');
      if (uEl && data.panelAuth?.username) uEl.value = data.panelAuth.username;
      populateScheduleAndProfileInputs(data);
      if (data.panelAuth?.role === 'admin' && data.napcat) populateNapCatInputs(data.napcat);
    }
  } catch (_) {}
}

function renderTopStatus(data) {
  const badge = document.getElementById('classStatusBadge');
  if (!badge) return;
  const active = Boolean(data.inClass || data.schedule?.forcePolling);
  badge.className = `status-dot ${active ? 'active' : ''}`;
  const uid = state.selectedUid || data.currentUid;
  const accSt = uid && data.perAccountStatus ? data.perAccountStatus[uid] : null;
  const reason = accSt?.reason || (active ? '监测中' : '非上课时间');
  badge.textContent = active ? `监测中 · ${reason}` : `待机 · ${reason}`;
  const lp = document.getElementById('lastPollText');
  if (lp) lp.textContent = data.lastPollTime ? `上次扫描 ${data.lastPollTime.slice(11, 19)}` : '未扫描';
}

function renderUserSwitcher(data) {
  const accounts = data.accounts || [];
  const html =
    accounts.length === 0
      ? `<option value="">未登录账号</option>`
      : accounts
          .map((a) => {
            const ownerTag = a.ownerUsername ? ` · 归属:${a.ownerUsername}` : '';
            return `<option value="${escapeHtml(a.uid)}" ${a.uid === state.selectedUid ? 'selected' : ''}>${escapeHtml(a.name)} (${escapeHtml(a.uid)}${escapeHtml(ownerTag)})</option>`;
          })
          .join('');
  const sel = document.getElementById('globalUserSelect');
  if (sel && document.activeElement !== sel) setHtmlIfChanged(sel, html);
  const winSel = document.getElementById('winSidebarUserSelect');
  if (winSel && document.activeElement !== winSel) setHtmlIfChanged(winSel, html);
}

function renderOverview(data, syncInputs) {
  if (data.schedule) {
    const masterEl = document.getElementById('masterEnabledToggle');
    const ovMasterEl = document.getElementById('overviewMasterToggle');
    if (masterEl && syncInputs) masterEl.checked = Boolean(data.schedule.masterEnabled);
    if (ovMasterEl) ovMasterEl.checked = Boolean(data.schedule.masterEnabled);
    renderPollingModeButtons(Boolean(data.schedule.forcePolling));
    const pToggle = document.getElementById('protectThresholdToggle');
    const pInput = document.getElementById('protectThresholdInput');
    if (pToggle && syncInputs) pToggle.checked = Boolean(data.schedule.signThresholdEnabled);
    if (pInput && syncInputs && data.schedule.signThresholdRatio !== undefined) {
      pInput.value = Number(data.schedule.signThresholdRatio || 0.3);
    }
    const modeSummaryEl = document.getElementById('overviewModeSummaryText');
    if (modeSummaryEl) {
      const mText = data.schedule.forcePolling ? '持续轮询模式' : '课表轮询模式';
      const pText = data.schedule.signThresholdEnabled
        ? ` · 人数保护 >=${Math.round(Number(data.schedule.signThresholdRatio || 0.3) * 100)}% (含临期抢签)`
        : ' · 发现即签';
      const effSecDisp = data.effectiveIntervalSeconds || data.schedule.intervalSeconds || 15;
      modeSummaryEl.textContent = `当前策略：${mText}（间隔 ${effSecDisp}s${pText}）`;
    }
    const adminEffTag = document.getElementById('adminBountyEffectivePollTag');
    if (adminEffTag && data.effectiveIntervalSeconds) {
      const bSync = data.bountyConfig?.bountySyncSeconds || 3.5;
      adminEffTag.textContent = `当前生效 ${data.effectiveIntervalSeconds}s · 同步 ${bSync}s`;
    }
  }
  renderOverviewTestCourses(isCurrentPanelAdmin() ? (data.courses || []) : (data.myOwnedCourses || []));

  // 待验证滑块
  const capSec = document.getElementById('pendingCaptchaSection');
  const capList = document.getElementById('pendingCaptchaList');
  const caps = data.pendingCaptchas || [];
  if (caps.length > 0) {
    capSec.style.display = 'block';
    const capHtml = caps
      .map(
        (c) => `
      <div class="list-row">
        <div>
          <div style="font-weight:500;">${escapeHtml(c.userName)} · 《${escapeHtml(c.courseName)}》</div>
          <div style="font-size:12px; color:var(--muted);">触发防作弊滑块验证 (${escapeHtml(c.activeName)})</div>
        </div>
        <div class="row">
          <button class="btn btn-sm" onclick="openSlideCaptchaModal('${escapeHtml(c.key)}')">完成验证</button>
          <button class="btn btn-ghost btn-sm" onclick="openHelperCreateModal({mode:'captcha', captchaKey:'${escapeHtml(c.key)}', courseName:'${escapeHtml(c.courseName)}', title:'协助完成滑块验证'})">转发协助</button>
        </div>
      </div>`
      )
      .join('');
    setHtmlIfChanged(capList, capHtml);
  } else {
    capSec.style.display = 'none';
  }

  // 活动监测列表（与签到悬赏池双向 SSOT 高同步，已签/截止实时剔除防重签，签名防抖杜绝闪烁）
  const radarEl = document.getElementById('activeRadarList');
  const actives = data.lastDetectedActives || [];
  if (actives.length === 0) {
    setHtmlIfChanged(radarEl, `<div class="empty">暂无待处理签到活动（已签或截止活动自动下榜防重签）</div>`, 'empty');
  } else {
    const radarSig = JSON.stringify(
      actives.map((item) => {
        const act = item.active || item;
        return [
          act.id,
          item.courseId,
          item.classId,
          act.signedCount ?? act.attendNum ?? 0,
          act.totalCount || 0,
          Boolean(act.waitingThreshold),
          act.endTimeMs || 0,
          item.helperToken || '',
          item.pendingNames || [],
          item.succeededNames || [],
        ];
      })
    );
    const radarHtml = actives
      .map((item) => {
        const act = item.active || item;
        const signedNum = act.signedCount ?? act.attendNum ?? 0;
        const totalNum = act.totalCount || 0;
        const ratioStr = totalNum > 0
          ? `班级已签: ${signedNum}/${totalNum} 人 (${Math.round((signedNum / totalNum) * 100)}%)`
          : `班级已签: ${signedNum} 人`;
        const waitBadge = act.waitingThreshold
          ? `<span class="tag" style="margin-left:6px; background:#fef3c7; color:#92400e; border-color:#fde68a;">等待达标(${Math.round((act.thresholdRatio || 0.3) * 100)}%)</span>`
          : '';
        const remainSec = act.endTimeMs && act.endTimeMs > Date.now()
          ? Math.max(0, Math.round((act.endTimeMs - Date.now()) / 1000))
          : null;
        const remainBadge = remainSec !== null
          ? `<span class="tag js-remain-tag" data-end-ms="${Number(act.endTimeMs || 0)}" style="margin-left:6px; color:#dc2626; border-color:#fecaca;">剩余 ${remainSec >= 60 ? Math.floor(remainSec / 60) + '分' + (remainSec % 60) + '秒' : remainSec + '秒'}</span>`
          : '';
        const pendingNames = Array.isArray(item.pendingNames) ? item.pendingNames : [];
        const succeededNames = Array.isArray(item.succeededNames) ? item.succeededNames : [];
        const pillsHtml = (pendingNames.length > 0 || succeededNames.length > 0)
          ? `<div class="bounty-student-pills">
              ${pendingNames.map((n) => `<span class="student-pill pending">待签: ${escapeHtml(n)}</span>`).join('')}
              ${succeededNames.map((n) => `<span class="student-pill done">已签: ${escapeHtml(n)}</span>`).join('')}
            </div>`
          : '';
        const ctx = {
          courseId: item.courseId,
          classId: item.classId,
          cpi: item.cpi,
          courseName: item.courseName,
          id: act.id,
          name: act.name || act.nameOne,
          signType: act.signType || 'normal',
          signTypeName: SIGN_TYPE_LABELS[act.signType] || act.signType || '签到',
          signedCount: signedNum,
          totalCount: totalNum,
        };
        const directHelpBtn = item.helperToken
          ? `<button class="btn btn-sm" onclick="openInAppBountyAssist('${escapeHtml(item.helperToken)}', 'global')">帮签</button>`
          : `<button class="btn btn-sm" onclick='openManualSignModal(${JSON.stringify(ctx).replace(/'/g, "&#39;")})'>签到</button>`;
        return `
      <div class="list-row" style="align-items:flex-start;">
        <div style="flex:1; min-width:0;">
          <div style="font-weight:600;">${escapeHtml(ctx.courseName)} · ${escapeHtml(ctx.name)}${waitBadge}${remainBadge}</div>
          <div style="font-size:11px; color:var(--muted); margin-top:2px;">类型: ${escapeHtml(ctx.signTypeName)} | ${escapeHtml(ratioStr)}</div>
          ${pillsHtml}
        </div>
        <div class="row" style="flex-shrink:0;">
          ${directHelpBtn}
          ${item.helperToken ? `<button class="btn btn-ghost btn-sm" onclick='openManualSignModal(${JSON.stringify(ctx).replace(/'/g, "&#39;")})'>弹窗签</button>` : ''}
          <button class="btn btn-ghost btn-sm" onclick='openHelperCreateModal(${JSON.stringify({ mode: "sign", courseId: ctx.courseId, classId: ctx.classId, cpi: ctx.cpi, courseName: ctx.courseName, activeId: ctx.id, activeName: ctx.name, signType: ctx.signType }).replace(/'/g, "&#39;")})'>分享链接</button>
        </div>
      </div>`;
      })
      .join('');
    if (!setHtmlIfChanged(radarEl, radarHtml, radarSig)) {
      updateRemainTagsInPlace(radarEl);
    }
  }

  // 历史记录
  const histEl = document.getElementById('historyList');
  const hist = data.history || [];
  const histHtml = hist.length
    ? hist
        .map((h) => {
          const summary = (h.results || []).map((r) => `${r.name}:${r.msg}`).join(' / ');
          return `<div class="list-row">
            <div>
              <div style="font-weight:500;">${escapeHtml(h.courseName)} · ${escapeHtml(h.activeName)}</div>
              <div style="font-size:11px; color:var(--muted);">${escapeHtml(summary)}</div>
            </div>
            <span class="tag">${escapeHtml((h.time || '').slice(11, 19))}</span>
          </div>`;
        })
        .join('')
    : `<div class="empty">暂无记录</div>`;
  setHtmlIfChanged(histEl, histHtml);

  // 运行日志
  const logsEl = document.getElementById('logsBox');
  const logList = data.logs || [];
  const logsHtml = logList.length
    ? logList
        .map((l) =>
          typeof l === "string"
            ? `<div class="log-item">${escapeHtml(l)}</div>`
            : `<div class="log-item">${escapeHtml(l.line || `[${l.time}] [${l.tag}] ${l.msg}`)}</div>`
        )
        .join('')
    : `<div class="empty">暂无相关日志</div>`;
  setHtmlIfChanged(logsEl, logsHtml);
}

function renderPollingModeButtons(isContinuous) {
  const btnCur = document.getElementById('modeBtnCurriculum');
  const btnCon = document.getElementById('modeBtnContinuous');
  const sBtnCur = document.getElementById('schedModeBtnCurriculum');
  const sBtnCon = document.getElementById('schedModeBtnContinuous');
  if (btnCur) btnCur.classList.toggle('active', !isContinuous);
  if (btnCon) btnCon.classList.toggle('active', isContinuous);
  if (sBtnCur) sBtnCur.classList.toggle('active', !isContinuous);
  if (sBtnCon) sBtnCon.classList.toggle('active', isContinuous);
  const desc = document.getElementById('pollingModeDesc');
  if (desc) {
    desc.textContent = isContinuous
      ? '持续轮询：任何时间段对所有课程进行轮询（单门课程轮询开关已锁定）'
      : '课表轮询：根据课表时段开启轮询，未勾选轮询的课程即使在课表中也不轮询';
  }
}

async function setPollingMode(mode) {
  const forcePolling = mode === 'continuous';
  await api('/api/schedule', 'POST', { uid: state.selectedUid, masterEnabled: true, forcePolling });
  if (!forcePolling && state.selectedUid) {
    await api('/api/user/profile', 'POST', { uid: state.selectedUid, useCurriculumSchedule: true });
  }
  showToast(forcePolling ? '已切换为持续轮询模式' : '已切换为课表轮询模式');
  await refreshStatus(true);
}

async function quickSaveScheduleToggle(explicitChecked) {
  const masterEnabled =
    typeof explicitChecked === 'boolean'
      ? explicitChecked
      : Boolean(document.getElementById('masterEnabledToggle')?.checked);
  const m1 = document.getElementById('masterEnabledToggle');
  const m2 = document.getElementById('overviewMasterToggle');
  if (m1) m1.checked = masterEnabled;
  if (m2) m2.checked = masterEnabled;
  await api('/api/schedule', 'POST', { uid: state.selectedUid, masterEnabled });
  showToast(masterEnabled ? '自动轮询已开启' : '自动轮询已暂停');
  refreshStatus(false);
}

async function saveGlobalIntervalConfig() {
  const intervalSeconds = Math.max(3, Math.min(300, Number(document.getElementById('cfgIntervalSeconds')?.value || 6)));
  const inp = document.getElementById('cfgIntervalSeconds');
  if (inp) inp.value = intervalSeconds;
  const res = await api('/api/schedule', 'POST', { uid: state.selectedUid, intervalSeconds });
  if (res.ok) {
    showToast(`全局轮询间隔已设为 ${intervalSeconds} 秒`);
    refreshStatus(false);
  }
}

async function saveProtectThresholdConfig() {
  const signThresholdEnabled = Boolean(document.getElementById('protectThresholdToggle')?.checked);
  let signThresholdRatio = Number(document.getElementById('protectThresholdInput')?.value || 0.3);
  if (Number.isNaN(signThresholdRatio) || signThresholdRatio <= 0) signThresholdRatio = 0.3;
  signThresholdRatio = Math.max(0.01, Math.min(0.99, Number(signThresholdRatio.toFixed(2))));
  const inp = document.getElementById('protectThresholdInput');
  if (inp) inp.value = signThresholdRatio;
  const res = await api('/api/schedule', 'POST', {
    uid: state.selectedUid,
    signThresholdEnabled,
    signThresholdRatio,
  });
  if (res.ok) {
    showToast(
      signThresholdEnabled
        ? `人数比例保护已开启：满 ${(signThresholdRatio * 100).toFixed(0)}% 自动签到`
        : '人数比例保护已关闭'
    );
    refreshStatus(false);
  }
}
async function triggerQuickSign(forceAll) {
  showToast(isCurrentPanelAdmin() ? '正在扫描全部账号签到活动...' : '正在扫描您的账号签到活动...');
  const res = await api('/api/sign/quick', 'POST', { forceAll });
  if (res.ok) {
    showToast(`扫描完成，发现 ${res.detected?.length || 0} 个进行中签到`);
    refreshStatus(false);
  } else {
    showToast(res.msg || '快速签到扫描失败');
  }
}

// 课程与预设
async function loadCourses(force = false) {
  if (force && !canEditSelectedAccount()) {
    showToast('只读模式：不可同步其他用户的课程');
    return;
  }
  const uid = state.selectedUid || '';
  const res = await api(`/api/courses?refresh=${force ? '1' : '0'}&uid=${encodeURIComponent(uid)}`);
  if (res.ok) {
    state.courses = res.courses || [];
    renderCoursesList(state.courses);
    if (force) showToast('课程已同步');
  } else {
    showToast(res.msg || '加载课程失败');
  }
}

function renderOverviewTestCourses(courses) {
  const box = document.getElementById('overviewTestCoursesBox');
  if (!box) return;
  const seenCourseIds = new Set();
  const testCourses = (courses || []).filter((c) => {
    if (!c.settings?.isTestCourse) return false;
    const cid = String(c.courseId);
    if (seenCourseIds.has(cid)) return false;
    seenCourseIds.add(cid);
    return true;
  });
  if (testCourses.length === 0) {
    setHtmlIfChanged(box, `<div class="list-row" style="padding:8px 0;">
      <span style="font-size:11px; color:var(--muted);">测试课程：暂未设置（在「课程」列表中将课程设为测试课程后，不受轮询模式与课表限制，可随时独立开关轮询）</span>
    </div>`);
    return;
  }
  const testHtml = testCourses
    .map((c) => {
      const cName = c.name || c.courseName || '未知课程';
      const testEnabled = c.settings?.testPollingEnabled !== false;
      return `<div class="list-row" style="padding:8px 0;">
        <div class="row" style="gap:6px;">
          <span class="tag solid">测试课程</span>
          <span style="font-weight:500;">${escapeHtml(cName)}</span>
          <span style="font-size:11px; color:var(--muted);">持续轮询</span>
        </div>
        <div class="row" style="gap:8px;">
          <span style="font-size:11px; color:var(--muted);">${testEnabled ? '测试轮询中' : '已关闭'}</span>
          <label class="switch" title="独立开启或关闭该测试课程的全天候轮询">
            <input type="checkbox" ${testEnabled ? 'checked' : ''} onchange="toggleTestCoursePolling('${escapeHtml(c.courseId)}', this.checked)" />
            <span class="slider"></span>
          </label>
        </div>
      </div>`;
    })
    .join('');
  setHtmlIfChanged(box, testHtml);
}

function renderCoursesList(courses) {
  const box = document.getElementById('coursesListContainer');
  if (!box) return;
  if (!courses || courses.length === 0) {
    setHtmlIfChanged(box, `<div class="empty">暂无课程，请先登录账号或点击同步课程</div>`);
    return;
  }
  const canEdit = canEditSelectedAccount();
  const isContinuous = Boolean(state.status?.schedule?.forcePolling);
  const btnSync = document.getElementById('btnSyncCourses');
  if (btnSync) {
    btnSync.disabled = !canEdit;
    btnSync.style.opacity = !canEdit ? '0.45' : '1';
    btnSync.title = !canEdit ? '只读模式：不可同步他人课程' : '从学习通重新拉取该账号的课程列表';
  }
  const btnBatchOn = document.getElementById('btnBatchEnablePolling');
  const btnBatchOff = document.getElementById('btnBatchDisablePolling');
  if (btnBatchOn) {
    btnBatchOn.disabled = isContinuous || !canEdit;
    btnBatchOn.style.opacity = isContinuous || !canEdit ? '0.45' : '1';
    btnBatchOn.title = !canEdit
      ? '只读模式：不可修改他人课程'
      : isContinuous
      ? '持续轮询模式下常规课程已锁定开启'
      : '一键开启所有常规课程的课表轮询';
  }
  if (btnBatchOff) {
    btnBatchOff.disabled = isContinuous || !canEdit;
    btnBatchOff.style.opacity = isContinuous || !canEdit ? '0.45' : '1';
    btnBatchOff.title = !canEdit
      ? '只读模式：不可修改他人课程'
      : isContinuous
      ? '持续轮询模式下常规课程不可关闭'
      : '一键关闭所有常规课程的课表轮询（测试课程不受影响）';
  }
  const modeBanner = isContinuous
    ? `<div class="list-row" style="background:var(--surface-sub); margin-bottom:10px;">
        <span style="font-size:12px; color:var(--muted);">当前处于「持续轮询」模式，常规课程均强制参与全天候轮询，无法单独修改常规课程轮询开关（被设为「测试课程」的课程仍可随时独立开启或关闭）。</span>
        ${canEdit ? `<button class="btn btn-ghost btn-sm" onclick="setPollingMode('curriculum')">切回课表轮询</button>` : ''}
      </div>`
    : '';

  const sorted = [...courses].sort((a, b) => Number(Boolean(b.settings?.isTestCourse)) - Number(Boolean(a.settings?.isTestCourse)));

  const coursesHtml =
    modeBanner +
    sorted
      .map((c) => {
        const cName = c.name || c.courseName || '未知课程';
        const cTeacher = c.teacher || c.teacherfactor || '';
        const isTest = Boolean(c.settings?.isTestCourse);
        const testEnabled = c.settings?.testPollingEnabled !== false;
        const regEnabled = isContinuous ? true : c.settings?.pollingEnabled !== false;
        const randOn = c.settings?.randomOffsetEnabled !== false;
        const randM = Number.isFinite(Number(c.settings?.randomOffsetMeters)) ? Number(c.settings.randomOffsetMeters) : 15;
        const randSuffix = randOn && randM > 0 ? ` (±${randM}m随机)` : '';
        const locText = (c.settings?.location?.address ? `预设位置: ${c.settings.location.address}` : '使用默认位置') + randSuffix;

        const switchControl = isTest
          ? `<span style="font-size:12px; font-weight:500;">测试轮询</span>
             <label class="switch ${!canEdit ? 'disabled' : ''}" title="${!canEdit ? '只读模式：无法修改他人课程' : '测试课程不受轮询模式与课表限制，可随时独立开启或关闭'}">
               <input type="checkbox" ${testEnabled ? 'checked' : ''} ${!canEdit ? 'disabled' : ''} onchange="toggleTestCoursePolling('${escapeHtml(c.courseId)}', this.checked)" />
               <span class="slider"></span>
             </label>`
          : `<span style="font-size:12px; color:var(--muted);">${isContinuous ? '持续轮询中(锁定)' : '是否轮询'}</span>
             <label class="switch ${isContinuous || !canEdit ? 'disabled' : ''}" title="${!canEdit ? '只读模式：无法修改他人课程' : isContinuous ? '持续轮询模式下常规课程不可修改' : '开启或关闭该课程轮询'}">
               <input type="checkbox" ${regEnabled ? 'checked' : ''} ${isContinuous || !canEdit ? 'disabled' : ''} onchange="toggleCoursePolling('${escapeHtml(c.courseId)}', this.checked)" />
               <span class="slider"></span>
             </label>`;

        const editBtnsHtml = canEdit
          ? `<button class="btn btn-ghost btn-sm" onclick='copyCourseObjectToClipboard(${JSON.stringify({ courseId: c.courseId, classId: c.classId, name: cName, teacherName: cTeacher, className: c.note || "" }).replace(/'/g, "&#39;")})'>复制课程</button>
             <button class="btn ${isTest ? '' : 'btn-ghost'} btn-sm" onclick="toggleTestCourse('${escapeHtml(c.courseId)}', ${!isTest})">${isTest ? '取消测试课' : '设为测试课'}</button>
             <button class="btn btn-ghost btn-sm" onclick='openCourseSettingModal(${JSON.stringify(c).replace(/'/g, "&#39;")})'>预设</button>`
          : `<button class="btn btn-ghost btn-sm" onclick='copyCourseObjectToClipboard(${JSON.stringify({ courseId: c.courseId, classId: c.classId, name: cName, teacherName: cTeacher, className: c.note || "" }).replace(/'/g, "&#39;")})'>复制课程</button>
             <span class="tag">只读</span>`;

        return `<div class="list-row" style="${isTest ? 'background:var(--surface-sub); padding-left:10px; padding-right:10px; border-radius:6px;' : ''}">
        <div>
          <div class="row" style="gap:6px;">
            <span style="font-weight:500;">${escapeHtml(cName)}</span>
            ${isTest ? '<span class="tag solid">测试课程</span>' : ''}
          </div>
          <div style="font-size:11px; color:var(--muted);">${escapeHtml(cTeacher)}${c.note ? ` · 班级: ${escapeHtml(c.note)}` : ''} · ${escapeHtml(locText)}</div>
        </div>
        <div class="row">
          ${switchControl}
          ${editBtnsHtml}
          <button class="btn btn-sm" onclick='inspectCourseActives(${JSON.stringify(c).replace(/'/g, "&#39;")})'>活动</button>
        </div>
      </div>`;
      })
      .join('');
  setHtmlIfChanged(box, coursesHtml);
}

async function batchToggleCoursePolling(pollingEnabled) {
  if (state.status?.schedule?.forcePolling) {
    showToast('持续轮询模式下无法修改常规课程轮询开关');
    return;
  }
  const res = await api('/api/courses/settings/batch', 'POST', {
    uid: state.selectedUid,
    pollingEnabled: Boolean(pollingEnabled),
  });
  if (res.ok) {
    showToast(pollingEnabled ? `已一键开启 ${res.updatedCount || 0} 门课程轮询` : `已一键关闭 ${res.updatedCount || 0} 门课程轮询`);
    await refreshStatus(false);
  } else {
    showToast(res.msg || '批量操作失败');
  }
}

async function toggleCoursePolling(courseId, pollingEnabled) {
  if (state.status?.schedule?.forcePolling) {
    showToast('持续轮询模式下无法修改常规课程轮询开关');
    refreshStatus(false);
    return;
  }
  await api('/api/courses/settings', 'POST', { uid: state.selectedUid, courseId, pollingEnabled });
  showToast(pollingEnabled ? '已开启该课轮询' : '已关闭该课轮询');
  refreshStatus(false);
}

async function toggleTestCourse(courseId, isTestCourse) {
  await api('/api/courses/settings', 'POST', {
    uid: state.selectedUid,
    courseId,
    isTestCourse: Boolean(isTestCourse),
    testPollingEnabled: true,
  });
  showToast(isTestCourse ? '已设为测试课程（不受模式与课表限制，随时轮询）' : '已恢复为常规课程');
  refreshStatus(false);
}

async function toggleTestCoursePolling(courseId, testPollingEnabled) {
  const targetUid = isCurrentPanelAdmin()
    ? state.selectedUid
    : (state.status?.myOwnedUid || state.selectedUid);
  const res = await api('/api/courses/settings', 'POST', {
    uid: targetUid,
    courseId,
    testPollingEnabled: Boolean(testPollingEnabled),
  });
  if (res.ok) {
    showToast(testPollingEnabled ? '测试课程轮询已开启' : '测试课程轮询已关闭');
  } else {
    showToast(res.msg || '操作失败');
  }
  refreshStatus(false);
}

function openCourseSettingModal(course) {
  state.currentCsCourse = course;
  const cName = course.name || course.courseName || '';
  document.getElementById('csModalTitle').textContent = `课程预设 · ${cName}`;
  populatePresetSelect('csPresetSelect');
  const loc = course.settings?.location || {};
  document.getElementById('csAddress').value = loc.address || '';
  document.getElementById('csLat').value = loc.latitude ?? '';
  document.getElementById('csLng').value = loc.longitude ?? '';
  const eff = state.status?.effectiveProfile || {};
  const defaultOffsetOn = eff.locationRandomOffsetEnabled !== false;
  const defaultOffsetM = Number.isFinite(Number(eff.locationRandomOffsetMeters)) ? Number(eff.locationRandomOffsetMeters) : 15;
  const csEnabledEl = document.getElementById('csRandomOffsetEnabled');
  const csMetersEl = document.getElementById('csRandomOffsetMeters');
  if (csEnabledEl) {
    csEnabledEl.checked = course.settings?.randomOffsetEnabled !== undefined ? Boolean(course.settings.randomOffsetEnabled) : defaultOffsetOn;
  }
  if (csMetersEl) {
    csMetersEl.value =
      course.settings?.randomOffsetMeters !== undefined && Number.isFinite(Number(course.settings.randomOffsetMeters))
        ? Number(course.settings.randomOffsetMeters)
        : defaultOffsetM;
  }
  renderCsPhotoList(course.settings?.imageObjectIds || []);
  openModal('courseSettingModal');
}

function renderCsPhotoList(ids) {
  const el = document.getElementById('csPhotoList');
  el.innerHTML = (ids || [])
    .map((id, i) => `<span class="tag">${escapeHtml(id)} <a href="javascript:void(0)" onclick="removeCsPhoto(${i})" style="margin-left:4px;color:var(--danger);">×</a></span>`)
    .join('');
}

function removeCsPhoto(idx) {
  if (!state.currentCsCourse) return;
  state.currentCsCourse.settings.imageObjectIds.splice(idx, 1);
  renderCsPhotoList(state.currentCsCourse.settings.imageObjectIds);
}

async function uploadCoursePhoto(input) {
  const file = input.files?.[0];
  if (!file || !state.currentCsCourse) return;
  const reader = new FileReader();
  reader.onload = async () => {
    showToast('正在上传图片...');
    const res = await api('/api/courses/uploadPhoto', 'POST', {
      uid: state.selectedUid,
      courseId: state.currentCsCourse.courseId,
      base64Image: reader.result,
    });
    if (res.ok) {
      state.currentCsCourse.settings.imageObjectIds = state.currentCsCourse.settings.imageObjectIds || [];
      state.currentCsCourse.settings.imageObjectIds.push(res.objectId);
      renderCsPhotoList(state.currentCsCourse.settings.imageObjectIds);
      showToast('上传成功');
    } else {
      showToast(res.msg || '上传失败');
    }
  };
  reader.readAsDataURL(file);
}

async function saveCourseSettingModal() {
  const c = state.currentCsCourse;
  if (!c) return;
  const address = document.getElementById('csAddress').value.trim();
  const lat = document.getElementById('csLat').value.trim();
  const lng = document.getElementById('csLng').value.trim();
  const location = address || lat || lng ? { address, latitude: Number(lat || 30.8328), longitude: Number(lng || 121.5035) } : null;
  const csEnabledEl = document.getElementById('csRandomOffsetEnabled');
  const csMetersEl = document.getElementById('csRandomOffsetMeters');
  const randomOffsetEnabled = csEnabledEl ? Boolean(csEnabledEl.checked) : true;
  const rawMeters = csMetersEl ? Number(csMetersEl.value) : 15;
  const randomOffsetMeters = Number.isFinite(rawMeters) && rawMeters >= 0 ? Math.min(500, rawMeters) : 15;

  await api('/api/courses/settings', 'POST', {
    uid: state.selectedUid,
    courseId: c.courseId,
    location,
    randomOffsetEnabled,
    randomOffsetMeters,
    imageObjectIds: c.settings?.imageObjectIds || [],
  });
  closeModal('courseSettingModal');
  showToast('课程预设已保存');
  refreshStatus(false);
}
async function inspectCourseActives(course) {
  const cName = course.name || course.courseName || '';
  document.getElementById('modalCourseTitle').textContent = `课程活动 · ${cName}`;
  const listEl = document.getElementById('modalActivesList');
  listEl.innerHTML = `<div class="empty">加载中...</div>`;
  openModal('courseActivesModal');

  const res = await api(
    `/api/courses/actives?courseId=${encodeURIComponent(course.courseId)}&classId=${encodeURIComponent(course.classId)}&cpi=${encodeURIComponent(course.cpi || '')}&uid=${encodeURIComponent(state.selectedUid || '')}`
  );
  const actives = res.actives || [];
  if (actives.length === 0) {
    listEl.innerHTML = `<div class="empty">无近期签到活动</div>`;
    return;
  }
  listEl.innerHTML = actives
    .map((a) => {
      const aName = a.name || a.nameOne || '课堂活动';
      const sLabel = SIGN_TYPE_LABELS[a.signType] || a.signType || '活动';
      const signedNum = a.signedCount ?? a.attendNum ?? 0;
      const totalNum = a.totalCount || 0;
      const attendStr = totalNum > 0 ? `已签: ${signedNum}/${totalNum} 人` : `已签: ${signedNum} 人`;
      const ctx = {
        ...a,
        name: aName,
        signTypeName: sLabel,
        courseId: course.courseId,
        classId: course.classId,
        cpi: course.cpi,
        courseName: cName,
        signedCount: signedNum,
        totalCount: totalNum,
      };
      return `<div class="list-row">
        <div>
          <div style="font-weight:500;">${escapeHtml(aName)}</div>
          <div style="font-size:11px; color:var(--muted);">类型: ${escapeHtml(sLabel)} | ${escapeHtml(attendStr)} | 状态: ${a.status ? '进行中' : '已结束'}</div>
        </div>
        <div class="row">
          <button class="btn btn-sm" onclick='openManualSignModal(${JSON.stringify(ctx).replace(/'/g, "&#39;")})'>签到</button>
          <button class="btn btn-ghost btn-sm" onclick='openHelperCreateModal(${JSON.stringify({ mode: "sign", courseId: course.courseId, classId: course.classId, cpi: course.cpi, courseName: cName, activeId: a.id, activeName: aName, signType: a.signType }).replace(/'/g, "&#39;")})'>协助</button>
        </div>
      </div>`;
    })
    .join('');
}

function populatePresetSelect(selectId) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const presets = state.status?.locationPresets || [];
  sel.innerHTML =
    `<option value="">从常用位置预设选择...</option>` +
    presets.map((p, idx) => `<option value="${idx}">${escapeHtml(p.name)} (${escapeHtml(p.address)})</option>`).join('');
}

function applyPresetToInputs(idxStr, addrId, latId, lngId) {
  if (idxStr === '') return;
  const p = (state.status?.locationPresets || [])[Number(idxStr)];
  if (!p) return;
  document.getElementById(addrId).value = p.address || p.name || '';
  document.getElementById(latId).value = p.latitude ?? '';
  document.getElementById(lngId).value = p.longitude ?? '';
}

function closeManualSignModal() {
  stopCameraQrScanner();
  closeModal('manualSignModal');
}

function applyManualModalSections(signType, needPhoto, needLocation, designatedPlace, locationRange) {
  const isCode = signType === 'code';
  const isPattern = signType === 'pattern';
  const isQr = signType === 'qrCode';
  const isLoc = signType === 'location' || Boolean(needLocation);
  const isPhoto = Boolean(needPhoto);
  const isPlainNormal = !isCode && !isPattern && !isQr && !isLoc && !isPhoto;

  document.getElementById('manualSectionNormal').style.display = isPlainNormal ? 'block' : 'none';
  document.getElementById('manualSectionCode').style.display = isCode || isPattern ? 'block' : 'none';
  document.getElementById('manualPatternWrap').style.display = isPattern ? 'block' : 'none';
  document.getElementById('manualCodeLabel').textContent = isPattern ? '手势序列（点击下方九宫格或直接输入数字）' : '签到码';
  document.getElementById('manualSignCode').placeholder = isPattern ? '点击九宫格生成手势序列' : '输入教师公布的签到码';

  document.getElementById('manualSectionQr').style.display = isQr ? 'block' : 'none';
  document.getElementById('manualSectionLocation').style.display = isLoc ? 'block' : 'none';
  document.getElementById('manualSectionPhoto').style.display = isPhoto ? 'block' : 'none';

  const locLabel = document.getElementById('manualLocationLabel');
  if (locLabel) {
    locLabel.textContent = designatedPlace
      ? `签到位置（要求：${designatedPlace}${locationRange ? ` · ${locationRange}m内` : ''}）`
      : '签到位置';
  }
  const quickBtn = document.getElementById('manualQuickReqLocBtn');
  if (quickBtn) {
    const reqLoc = state.currentManualCtx?.requiredLocation;
    const hasReq = Boolean(designatedPlace || (reqLoc && reqLoc.latitude && reqLoc.longitude));
    quickBtn.style.display = isLoc && hasReq ? 'inline-flex' : 'none';
  }
}

function formatAttendStatsBanner(signedCount, totalCount) {
  const s = Math.max(0, Number(signedCount || 0));
  const t = Math.max(0, Number(totalCount || 0));
  if (t > 0) {
    const pct = ((s / t) * 100).toFixed(1);
    return `当前已签人数：${s} / ${t} 人 (${pct}%)`;
  }
  return `当前已签人数：${s} 人`;
}

async function refreshManualAttendStats() {
  const ctx = state.currentManualCtx;
  if (!ctx) return;
  const activeId = ctx.id || ctx.activeId;
  if (!activeId) return;
  const statEl = document.getElementById('manualAttendStatsText');
  if (statEl) statEl.textContent = '当前已签人数：刷新中...';
  try {
    const info = await api(
      `/api/courses/activeInfo?activeId=${encodeURIComponent(activeId)}&courseId=${encodeURIComponent(ctx.courseId || '')}&classId=${encodeURIComponent(ctx.classId || '')}&uid=${encodeURIComponent(state.selectedUid || '')}`
    );
    if (info.ok && statEl) {
      statEl.textContent = formatAttendStatsBanner(info.signedCount, info.totalCount);
    }
  } catch (_) {
    if (statEl) statEl.textContent = '当前已签人数：查询失败';
  }
}

async function refreshHelpAttendStats() {
  const hs = state.helperSession;
  if (!hs || !hs.activeId) return;
  const statEl = document.getElementById('helpAttendStatsText');
  if (statEl) statEl.textContent = '已签人数：刷新中...';
  try {
    const info = await api(
      `/api/courses/activeInfo?activeId=${encodeURIComponent(hs.activeId)}&courseId=${encodeURIComponent(hs.courseId || '')}&classId=${encodeURIComponent(hs.classId || '')}`
    );
    if (info.ok && statEl) {
      statEl.textContent = formatAttendStatsBanner(info.signedCount, info.totalCount);
    }
  } catch (_) {
    if (statEl) statEl.textContent = '已签人数：查询失败';
  }
}

async function applyRequiredLocationQuick(mode = 'manual') {
  const isHelp = mode === 'help';
  const addrId = isHelp ? 'helpAddress' : 'manualAddress';
  const latId = isHelp ? 'helpLat' : 'manualLat';
  const lngId = isHelp ? 'helpLng' : 'manualLng';
  const reqLoc = isHelp ? state.helperRequiredLocation : state.currentManualCtx?.requiredLocation;
  if (!reqLoc) {
    showToast('当前签到未提供要求位置信息');
    return;
  }
  const placeText = reqLoc.designatedPlace || '';
  if (reqLoc.latitude && reqLoc.longitude) {
    // 附带微小随机偏移 (< 4米)，防止多账号完全重叠且精准落在要求范围内
    const jitterLat = Number((Number(reqLoc.latitude) + (Math.random() - 0.5) * 0.00003).toFixed(6));
    const jitterLng = Number((Number(reqLoc.longitude) + (Math.random() - 0.5) * 0.00003).toFixed(6));
    if (document.getElementById(addrId)) {
      document.getElementById(addrId).value = placeText || document.getElementById(addrId).value || '要求签到位置';
    }
    if (document.getElementById(latId)) document.getElementById(latId).value = jitterLat;
    if (document.getElementById(lngId)) document.getElementById(lngId).value = jitterLng;
    showToast(`已一键填入要求位置：${placeText || `${jitterLat}, ${jitterLng}`}`);
    return;
  }
  if (placeText) {
    showToast('正在根据要求地点名称检索坐标...');
    const res = await api(`/api/geo/search?q=${encodeURIComponent(placeText)}`);
    const first = res.list?.[0];
    if (first) {
      if (document.getElementById(addrId)) document.getElementById(addrId).value = placeText;
      if (document.getElementById(latId)) document.getElementById(latId).value = Number(first.latitude).toFixed(6);
      if (document.getElementById(lngId)) document.getElementById(lngId).value = Number(first.longitude).toFixed(6);
      showToast(`已根据要求地点匹配坐标：${placeText}`);
    } else {
      if (document.getElementById(addrId)) document.getElementById(addrId).value = placeText;
      showToast('已填入要求地点名称，请配合地图选点微调坐标');
    }
  }
}

async function openManualSignModal(ctx) {
  stopCameraQrScanner();
  state.currentManualCtx = ctx;
  const cName = ctx.courseName || ctx.name || '';
  const aName = ctx.name || ctx.nameOne || ctx.activeName || '';
  const signType = ctx.signType || 'normal';
  const sLabel = ctx.signTypeName || SIGN_TYPE_LABELS[signType] || signType || '签到';
  document.getElementById('manualSignTitle').textContent = `手动签到 · ${cName}`;
  document.getElementById('manualSignMeta').textContent = `${aName} (${sLabel})`;
  const statEl = document.getElementById('manualAttendStatsText');
  if (statEl) {
    statEl.textContent =
      ctx.signedCount !== undefined
        ? formatAttendStatsBanner(ctx.signedCount, ctx.totalCount)
        : '当前已签人数：查询中...';
  }
  clearPattern('manualSignCode', 'manualPatternGrid');
  document.getElementById('manualQrUrl').value = '';
  document.getElementById('manualObjectId').value = '';
  document.getElementById('manualSignResult').innerHTML = '';

  populatePresetSelect('manualPresetSelect');
  const courseObj = (state.courses || []).find((c) => String(c.courseId) === String(ctx.courseId));
  const defLoc = courseObj?.settings?.location || state.status?.effectiveProfile?.defaultLocation || {};
  document.getElementById('manualAddress').value = defLoc.address || '';
  document.getElementById('manualLat').value = defLoc.latitude ?? '';
  document.getElementById('manualLng').value = defLoc.longitude ?? '';

  // 先按已知类型立即展示所需区块，隐藏无关项
  applyManualModalSections(signType, false, signType === 'location', '', '');
  openModal('manualSignModal');

  // 异步查询该活动的详细要求（如手势/二维码是否同时开启了位置要求、普通签到是否开启了拍照）
  const activeId = ctx.id || ctx.activeId;
  if (activeId) {
    try {
      const info = await api(
        `/api/courses/activeInfo?activeId=${encodeURIComponent(activeId)}&courseId=${encodeURIComponent(ctx.courseId || '')}&classId=${encodeURIComponent(ctx.classId || '')}&uid=${encodeURIComponent(state.selectedUid || '')}`
      );
      if (info.ok && state.currentManualCtx && String(state.currentManualCtx.id || state.currentManualCtx.activeId) === String(activeId)) {
        const realType = info.signType || signType;
        state.currentManualCtx.signType = realType;
        state.currentManualCtx.requiredLocation = {
          designatedPlace: info.designatedPlace || '',
          locationRange: info.locationRange || '',
          latitude: info.requiredLatitude || null,
          longitude: info.requiredLongitude || null,
        };
        if (statEl) {
          statEl.textContent = formatAttendStatsBanner(info.signedCount, info.totalCount);
        }
        const realLabel = info.needPhoto && realType === 'normal' ? '拍照签到' : (SIGN_TYPE_LABELS[realType] || sLabel);
        document.getElementById('manualSignMeta').textContent = `${aName} (${realLabel})${info.designatedPlace ? ` · 要求地点: ${info.designatedPlace}` : ''}`;
        applyManualModalSections(realType, info.needPhoto, info.needLocation, info.designatedPlace, info.locationRange);
      }
    } catch (_) {}
  }
}

async function uploadManualSignPhoto(input) {
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    showToast('正在上传签到图片...');
    const res = await api('/api/courses/uploadPhoto', 'POST', {
      uid: state.selectedUid,
      courseId: state.currentManualCtx?.courseId || '',
      base64Image: reader.result,
    });
    if (res.ok && res.objectId) {
      document.getElementById('manualObjectId').value = res.objectId;
      showToast('照片上传成功');
    } else {
      showToast(res.msg || '照片上传失败');
    }
  };
  reader.readAsDataURL(file);
}

async function submitManualSign() {
  const ctx = state.currentManualCtx;
  if (!ctx) return;
  const box = document.getElementById('manualSignResult');
  box.innerHTML = `<div class="tag">正在提交签到...</div>`;

  const res = await api('/api/sign/execute', 'POST', {
    courseId: ctx.courseId,
    classId: ctx.classId,
    cpi: ctx.cpi,
    courseName: ctx.courseName,
    activeId: ctx.id || ctx.activeId,
    activeName: ctx.name || ctx.nameOne || ctx.activeName,
    signCode: document.getElementById('manualSignCode').value.trim() || null,
    qrUrl: document.getElementById('manualQrUrl').value.trim() || null,
    address: document.getElementById('manualAddress').value.trim() || null,
    latitude: document.getElementById('manualLat').value.trim(),
    longitude: document.getElementById('manualLng').value.trim(),
    objectId: document.getElementById('manualObjectId').value.trim() || null,
    triggerSource: '面板手动签到',
  });

  if (res.ok && res.record) {
    const lines = res.record.results.map((r) => `${escapeHtml(r.name)}: ${escapeHtml(r.msg)}`).join('<br/>');
    box.innerHTML = `<div class="list-row" style="background:var(--surface-sub);"><div>${lines}</div></div>`;
    const needCap = res.record.results.find((r) => r.needCaptcha && r.captchaKey);
    if (needCap) {
      closeManualSignModal();
      openSlideCaptchaModal(needCap.captchaKey);
    }
    refreshStatus(false);
  } else {
    box.innerHTML = `<div class="tag">${escapeHtml(res.msg || '执行失败')}</div>`;
  }
}

function createHelpFromManualModal() {
  const ctx = state.currentManualCtx;
  if (!ctx) return;
  closeManualSignModal();
  openHelperCreateModal({
    mode: 'sign',
    courseId: ctx.courseId,
    classId: ctx.classId,
    cpi: ctx.cpi,
    courseName: ctx.courseName,
    activeId: ctx.id || ctx.activeId,
    activeName: ctx.name || ctx.nameOne || ctx.activeName,
    signType: ctx.signType || 'normal',
    title: `协助签到《${ctx.courseName}》`,
  });
}

// 课表与用户配置继承
function populateScheduleAndProfileInputs(data) {
  const raw = data.userProfile || {};
  const eff = data.effectiveProfile || {};
  const accounts = data.accounts || [];

  const inhSel = document.getElementById('profInheritSelect');
  if (inhSel) {
    inhSel.innerHTML =
      `<option value="">独立配置（不沿用其他用户）</option>` +
      accounts
        .filter((a) => a.uid !== state.selectedUid)
        .map((a) => `<option value="${escapeHtml(a.uid)}" ${raw.inheritFromUid === a.uid ? 'selected' : ''}>沿用 ${escapeHtml(a.name)} (${escapeHtml(a.uid)})</option>`)
        .join('');
  }

  document.getElementById('cfgIntervalSeconds').value = data.schedule?.intervalSeconds || 25;
  document.getElementById('profBufferMins').value = eff.curriculumBufferMinutes ?? 10;
  if (document.getElementById('profUseCurriculum')) document.getElementById('profUseCurriculum').checked = eff.useCurriculumSchedule !== false;

  document.getElementById('profDefAddress').value = eff.defaultLocation?.address || '';
  document.getElementById('profDefLat').value = eff.defaultLocation?.latitude ?? '';
  document.getElementById('profDefLng').value = eff.defaultLocation?.longitude ?? '';

  const offsetOn = eff.locationRandomOffsetEnabled !== false;
  const offsetM = Number.isFinite(Number(eff.locationRandomOffsetMeters)) ? Number(eff.locationRandomOffsetMeters) : 15;
  ['profRandomOffsetEnabled', 'locRandomOffsetEnabled'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.checked = offsetOn;
  });
  ['profRandomOffsetMeters', 'locRandomOffsetMeters'].forEach((id) => {
    const el = document.getElementById(id);
    if (el && document.activeElement !== el) el.value = offsetM;
  });

  state._editingDiyLessons = JSON.parse(JSON.stringify(eff.diyLessons || []));
  renderDiyLessonsList(state._editingDiyLessons);
  renderCurriculumView(eff.effectiveCurriculum || eff.curriculumCache, state._editingDiyLessons);
}

function formatWeeksCompact(weeks) {
  if (!Array.isArray(weeks) || weeks.length === 0) return '全周';
  const sorted = [...new Set(weeks.map(Number))].sort((a, b) => a - b);
  const ranges = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const cur = sorted[i];
    if (cur === prev + 1) {
      prev = cur;
    } else {
      ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
      start = cur;
      prev = cur;
    }
  }
  return `${ranges.join(',')}周`;
}

function changeCurriculumWeek(week) {
  state.viewingWeek = Number(week);
  const eff = state.status?.effectiveProfile || {};
  renderCurriculumView(eff.effectiveCurriculum || eff.curriculumCache, state._editingDiyLessons || eff.diyLessons || []);
}

function toggleShowNonCurrentWeek(checked) {
  state.showNonCurrentWeek = Boolean(checked);
  const eff = state.status?.effectiveProfile || {};
  renderCurriculumView(eff.effectiveCurriculum || eff.curriculumCache, state._editingDiyLessons || eff.diyLessons || []);
}

function onClickWakeupLesson(courseId, name, diyId = '') {
  if (!canEditSelectedAccount()) {
    showToast(`只读预览：${name}`);
    return;
  }
  if (diyId) {
    const list = state._editingDiyLessons || state.status?.effectiveProfile?.diyLessons || [];
    const idx = list.findIndex((d) => String(d.id) === String(diyId));
    if (idx >= 0) {
      openDiyLessonModal(idx);
      return;
    }
  }
  const course = (state.courses || []).find(
    (c) => String(c.courseId) === String(courseId) || (c.name || c.courseName) === name
  );
  if (course) {
    openCourseSettingModal(course);
  } else {
    showToast(`课程：${name}`);
  }
}

function renderCurriculumView(cur, diyLessons = []) {
  const meta = document.getElementById('curriculumMetaText');
  const wrap = document.getElementById('curriculumTableWrap');
  const importedLessons = (cur && Array.isArray(cur.lessons)) ? cur.lessons : [];
  const activeDiyLessons = (Array.isArray(diyLessons) ? diyLessons : []).map((d) => ({
    ...d,
    isDiy: true,
  }));
  const allLessons = [...importedLessons, ...activeDiyLessons];

  if (allLessons.length === 0) {
    if (meta) meta.textContent = '暂未同步学习通课表，可点击右上方同步按钮读取，或在下方新增 DIY 课程';
    if (wrap) wrap.innerHTML = `<div class="empty">未读取到排课数据，可同步学习通课表或新增 DIY 课程</div>`;
    return;
  }

  const realWeek = Number(cur?.realCurrentWeek || 1);
  if (!state.viewingWeek) state.viewingWeek = realWeek;
  if (state.showNonCurrentWeek === undefined) state.showNonCurrentWeek = true;
  const activeWeek = state.viewingWeek;

  const syncTime = cur?.updatedAt ? new Date(cur.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '';
  if (meta) {
    meta.textContent = `当前第 ${realWeek} 周 · 导入排课 ${importedLessons.length} 门 + DIY 排课 ${activeDiyLessons.length} 门（点击卡片可配置预设或编辑 DIY 规则）${syncTime ? ` · 同步于 ${syncTime}` : ''}`;
  }

  const timeCfg =
    cur && Array.isArray(cur.lessonTimeConfigArray) && cur.lessonTimeConfigArray.length > 0
      ? cur.lessonTimeConfigArray
      : [
          '08:00-08:50', '09:00-09:50', '10:10-11:00', '11:10-12:00',
          '14:00-14:50', '15:00-15:50', '16:10-17:00', '17:10-18:00',
          '19:00-19:50', '20:00-20:50', '21:00-21:50', '22:00-22:50',
        ];

  let maxPeriod = Math.max(10, timeCfg.length);
  for (const l of allLessons) {
    const endP = Number(l.beginNumber || 1) + Math.max(1, Number(l.length || 1)) - 1;
    if (endP > maxPeriod) maxPeriod = endP;
  }

  let maxWeek = Math.max(20, realWeek);
  for (const l of allLessons) {
    for (const w of l.weeks || []) {
      if (Number(w) > maxWeek) maxWeek = Number(w);
    }
  }

  const nowDay = new Date().getDay() === 0 ? 7 : new Date().getDay();
  const dayNames = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  let weekOptions = '';
  for (let w = 1; w <= maxWeek; w++) {
    weekOptions += `<option value="${w}" ${w === activeWeek ? 'selected' : ''}>第 ${w} 周${w === realWeek ? ' (本周)' : ''}</option>`;
  }

  // 构建网格头部：左上角 + 周一至周日
  let cellsHtml = `<div class="wk-corner" style="grid-column:1; grid-row:1;"><span style="font-size:11px; color:var(--muted);">节次</span></div>`;
  for (let d = 1; d <= 7; d++) {
    const isToday = d === nowDay && activeWeek === realWeek;
    cellsHtml += `
      <div class="wk-day-head ${isToday ? 'is-today' : ''}" style="grid-column:${d + 1}; grid-row:1;">
        <span class="wk-dname">${dayNames[d - 1]}</span>
        <span class="wk-dsub">${isToday ? '今天' : `周${dayNames[d - 1].slice(1)}`}</span>
      </div>`;
  }

  // 左侧节次时间轴 + 背景空白格
  for (let p = 1; p <= maxPeriod; p++) {
    const rawTime = (timeCfg[p - 1] || '').replace('-', '<br/>');
    cellsHtml += `
      <div class="wk-period-cell" style="grid-column:1; grid-row:${p + 1};">
        <span class="wk-period-num">${p}</span>
        <span class="wk-period-time">${rawTime}</span>
      </div>`;
    const hasClipboard = Boolean(getCopiedLessonClipboard()) && canEditSelectedAccount();
    for (let d = 1; d <= 7; d++) {
      const isTodayCol = d === nowDay && activeWeek === realWeek;
      cellsHtml += `<div class="wk-slot-bg ${isTodayCol ? 'is-today-col' : ''} ${hasClipboard ? 'can-paste-slot' : ''}" style="grid-column:${d + 1}; grid-row:${p + 1};" ${hasClipboard ? `onclick="onClickTimetableEmptySlot(${d}, ${p})" title="点击将已复制课程粘贴至${dayNames[d - 1]}第${p}节"` : ''}></div>`;
    }
  }

  // 按 (dayOfWeek, beginNumber, length) 分组处理同槽位多课程/单双周课程
  const slotGroups = {};
  for (const l of allLessons) {
    const inThisWeek = !Array.isArray(l.weeks) || l.weeks.length === 0 || l.weeks.includes(activeWeek);
    if (!inThisWeek && !state.showNonCurrentWeek) continue;
    const day = Number(l.dayOfWeek || 1);
    const begin = Number(l.beginNumber || 1);
    const len = Math.max(1, Number(l.length || 1));
    const key = `${day}_${begin}_${len}`;
    if (!slotGroups[key]) slotGroups[key] = { day, begin, len, items: [] };
    slotGroups[key].items.push({ ...l, inThisWeek });
  }

  const effSettings = state.status?.effectiveProfile?.courseSettings || {};

  for (const group of Object.values(slotGroups)) {
    // 优先展示本周课程在前
    group.items.sort((a, b) => Number(b.inThisWeek) - Number(a.inThisWeek));
    const cardsInner = group.items
      .map((item) => {
        const isContinuous = Boolean(state.status?.schedule?.forcePolling);
        const matchedCourse = (state.courses || []).find((c) => String(c.courseId) === String(item.courseId) || (c.name || c.courseName) === item.name);
        const st = effSettings[item.courseId] || (matchedCourse ? effSettings[matchedCourse.courseId] : null);
        const isTest = Boolean(st && st.isTestCourse);
        const diyPaused = Boolean(item.isDiy && (item.enabled === false || item.pollingEnabled === false));
        const paused = diyPaused || (isTest ? st.testPollingEnabled === false : (!isContinuous && st && st.pollingEnabled === false));
        const weekRangeStr = formatWeeksCompact(item.weeks);
        const locStr = item.location ? `@${item.location}` : '';
        const teacherStr = item.teacherName || item.teacher || '';
        const diyTag = item.isDiy ? '[DIY] ' : '';
        const copyPayloadJson = JSON.stringify({
          name: item.name || '',
          courseId: item.courseId || matchedCourse?.courseId || '',
          classId: item.classId || matchedCourse?.classId || '',
          className: item.className || matchedCourse?.note || '',
          teacherName: teacherStr || matchedCourse?.teacher || '',
          location: item.location || '',
          dayOfWeek: Number(item.dayOfWeek || 1),
          beginNumber: Number(item.beginNumber || 1),
          length: Math.max(1, Number(item.length || 2)),
          startTime: item.startTime || '08:00',
          endTime: item.endTime || '09:50',
          weeks: Array.isArray(item.weeks) ? item.weeks : [],
        }).replace(/'/g, "&#39;");
        return `
          <div class="wk-course-card ${item.inThisWeek ? 'in-week' : 'out-week'} ${paused ? 'is-paused' : ''}"
               onclick="onClickWakeupLesson('${escapeHtml(item.courseId || '')}', '${escapeHtml(item.name)}', '${escapeHtml(item.isDiy ? item.id || '' : '')}')"
               title="${escapeHtml(diyTag + item.name)} (${escapeHtml(weekRangeStr)} | ${escapeHtml(item.startTime || '')}-${escapeHtml(item.endTime || '')}) 点击${item.isDiy ? '编辑DIY排课规则' : '配置课程预设'}">
            <button type="button" class="wk-copy-mini-btn" onclick='event.stopPropagation(); copyCourseObjectToClipboard(${copyPayloadJson})' title="复制该课程排课信息">复制</button>
            <div>
              <div class="wk-cname">${escapeHtml(diyTag + item.name)}</div>
              <div class="wk-cmeta">
                ${locStr ? `<span>${escapeHtml(locStr)}</span>` : ''}
                ${teacherStr ? `<span>${escapeHtml(teacherStr)}</span>` : ''}
              </div>
            </div>
            <div class="wk-badge-row">
              <span>${escapeHtml(weekRangeStr)}</span>
              <span>${item.isDiy ? (paused ? 'DIY(关)' : 'DIY(开)') : isTest ? (paused ? '测试课(关)' : '测试课(开)') : (paused ? '已暂停' : (item.inThisWeek ? '本周' : '非本周'))}</span>
            </div>
          </div>`;
      })
      .join('');

    cellsHtml += `
      <div class="wk-card-wrap" style="grid-column:${group.day + 1}; grid-row:${group.begin + 1} / span ${group.len};">
        ${cardsInner}
      </div>`;
  }

  const clipItem = getCopiedLessonClipboard();
  const pasteBannerHtml = clipItem && canEditSelectedAccount()
    ? `<div class="wk-paste-banner">
         <span>已复制课程《<strong>${escapeHtml(clipItem.name || '课程')}</strong>》${clipItem.courseId ? `(courseId:${escapeHtml(clipItem.courseId)})` : ''} · 点击课表任意空白格可直接粘贴到对应星期与节次，或点击下方「粘贴课程」</span>
         <div class="row" style="gap:6px;">
           <button type="button" class="btn btn-sm" onclick="pasteCopiedLessonToDiy()">直接粘贴为 DIY 课程</button>
           <button type="button" class="btn btn-ghost btn-sm" onclick="clearCopiedLessonClipboard()">取消复制</button>
         </div>
       </div>`
    : '';
  syncDiyPasteButtonsUi();
  wrap.innerHTML = `
    ${pasteBannerHtml}
    <div class="wk-toolbar">
      <div class="wk-week-nav">
        <button class="btn btn-ghost btn-sm" onclick="changeCurriculumWeek(${Math.max(1, activeWeek - 1)})">上一周</button>
        <select onchange="changeCurriculumWeek(this.value)" style="width:140px; padding:4px 8px;">${weekOptions}</select>
        <button class="btn btn-ghost btn-sm" onclick="changeCurriculumWeek(${Math.min(maxWeek, activeWeek + 1)})">下一周</button>
        ${activeWeek !== realWeek ? `<button class="btn btn-sm" onclick="changeCurriculumWeek(${realWeek})">回到本周(第${realWeek}周)</button>` : ''}
      </div>
      <div class="row" style="gap:14px; font-size:12px; color:var(--muted);">
        <label style="margin:0; display:inline-flex; align-items:center; gap:6px; cursor:pointer; color:var(--text);">
          <input type="checkbox" style="width:auto;" ${state.showNonCurrentWeek ? 'checked' : ''} onchange="toggleShowNonCurrentWeek(this.checked)" />
          显示非本周课程
        </label>
        <span>深色实心：本周排课</span>
        <span>浅色虚线：非本周排课</span>
      </div>
    </div>
    <div style="overflow-x:auto;">
      <div class="wk-board">${cellsHtml}</div>
    </div>`;
}

async function syncCurriculum() {
  showToast('正在同步学习通课表...');
  const res = await api('/api/curriculum/sync', 'POST', { uid: state.selectedUid });
  if (res.ok) {
    showToast(`同步完成，共 ${res.curriculum?.lessons?.length || 0} 门排课`);
    refreshStatus(true);
  } else {
    showToast(res.msg || '同步课表失败');
  }
}

const DEFAULT_PERIOD_TIMES = [
  ['08:00', '08:50'],
  ['09:00', '09:50'],
  ['10:10', '11:00'],
  ['11:10', '12:00'],
  ['14:00', '14:50'],
  ['15:00', '15:50'],
  ['16:10', '17:00'],
  ['17:10', '18:00'],
  ['19:00', '19:50'],
  ['20:00', '20:50'],
  ['21:00', '21:50'],
  ['22:00', '22:50'],
];

function parseWeeksExpression(str) {
  const raw = String(str || '').trim().replace(/周/g, '');
  if (!raw) return [];
  const set = new Set();
  for (const part of raw.split(/[,，\s]+/)) {
    if (!part) continue;
    if (part.includes('-')) {
      const [a, b] = part.split('-').map((n) => Number(n.trim()));
      if (a > 0 && b >= a) {
        for (let w = a; w <= Math.min(30, b); w++) set.add(w);
      }
    } else {
      const w = Number(part);
      if (w > 0) set.add(w);
    }
  }
  return [...set].sort((a, b) => a - b);
}

function getCopiedLessonClipboard() {
  if (state.copiedLessonClipboard && typeof state.copiedLessonClipboard === 'object') {
    return state.copiedLessonClipboard;
  }
  try {
    const raw = localStorage.getItem('ishit_copied_lesson_v1');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.name) {
        state.copiedLessonClipboard = parsed;
        return parsed;
      }
    }
  } catch (_) {}
  return null;
}

function syncDiyPasteButtonsUi() {
  const clip = getCopiedLessonClipboard();
  const canEdit = canEditSelectedAccount();
  const btn = document.getElementById('btnPasteDiyLesson');
  if (btn) {
    if (clip && canEdit) {
      btn.style.display = 'inline-flex';
      btn.textContent = `粘贴课程（${clip.name.slice(0, 10)}）`;
    } else {
      btn.style.display = 'none';
    }
  }
  const modalBtn = document.getElementById('diyModalPasteBtn');
  if (modalBtn) {
    modalBtn.style.display = clip ? 'inline-flex' : 'none';
    if (clip) modalBtn.textContent = `粘贴《${clip.name.slice(0, 8)}》`;
  }
}

function copyCourseObjectToClipboard(rawItem) {
  if (!rawItem || typeof rawItem !== 'object') return;
  const matchedCourse = (state.courses || []).find(
    (c) =>
      (rawItem.courseId && String(c.courseId) === String(rawItem.courseId)) ||
      (rawItem.name && (c.name || c.courseName) === rawItem.name)
  );
  const clip = {
    name: String(rawItem.name || matchedCourse?.name || matchedCourse?.courseName || '自定义课程').trim(),
    courseId: String(rawItem.courseId || matchedCourse?.courseId || '').trim(),
    classId: String(rawItem.classId || matchedCourse?.classId || '').trim(),
    className: String(rawItem.className || matchedCourse?.note || '').trim(),
    teacherName: String(rawItem.teacherName || matchedCourse?.teacher || '').trim(),
    location: String(rawItem.location || '').trim(),
    dayOfWeek: Number(rawItem.dayOfWeek || 1),
    beginNumber: Math.max(1, Number(rawItem.beginNumber || 1)),
    length: Math.max(1, Number(rawItem.length || 2)),
    startTime: String(rawItem.startTime || '08:00').trim(),
    endTime: String(rawItem.endTime || '09:50').trim(),
    weeks: Array.isArray(rawItem.weeks) ? rawItem.weeks : [],
  };
  state.copiedLessonClipboard = clip;
  try {
    localStorage.setItem('ishit_copied_lesson_v1', JSON.stringify(clip));
  } catch (_) {}
  syncDiyPasteButtonsUi();
  const eff = state.status?.effectiveProfile || {};
  renderCurriculumView(eff.effectiveCurriculum || eff.curriculumCache, state._editingDiyLessons || eff.diyLessons || []);
  showToast(`已复制课程《${clip.name}》，可点击课表空白格或「粘贴课程」粘贴至 DIY 课表`);
}

function clearCopiedLessonClipboard() {
  state.copiedLessonClipboard = null;
  try {
    localStorage.removeItem('ishit_copied_lesson_v1');
  } catch (_) {}
  syncDiyPasteButtonsUi();
  const eff = state.status?.effectiveProfile || {};
  renderCurriculumView(eff.effectiveCurriculum || eff.curriculumCache, state._editingDiyLessons || eff.diyLessons || []);
  showToast('已清除复制的课程剪贴板');
}

function copyDiyLessonByIndex(idx) {
  const list = state._editingDiyLessons || state.status?.effectiveProfile?.diyLessons || [];
  const item = list[idx];
  if (!item) return;
  copyCourseObjectToClipboard(item);
}

function copyCurrentCourseFromSettingModal() {
  const c = state.currentCsCourse;
  if (!c) return;
  copyCourseObjectToClipboard({
    name: c.name || c.courseName || '',
    courseId: c.courseId || '',
    classId: c.classId || '',
    className: c.note || '',
    teacherName: c.teacher || '',
    location: document.getElementById('csAddress')?.value.trim() || c.settings?.location?.address || '',
  });
}

function fillDiyModalFromClipboard() {
  const clip = getCopiedLessonClipboard();
  if (!clip) {
    showToast('剪贴板暂无已复制的课程信息');
    return;
  }
  populateDiyCourseBindSelect(clip.courseId || '', clip.classId || '');
  document.getElementById('diyLessonName').value = clip.name || '';
  document.getElementById('diyCourseId').value = clip.courseId || '';
  document.getElementById('diyClassId').value = clip.classId || '';
  document.getElementById('diyTeacherName').value = clip.teacherName || '';
  document.getElementById('diyLocation').value = clip.location || '';
  document.getElementById('diyDayOfWeek').value = String(clip.dayOfWeek || 1);
  const bNum = Math.max(1, Number(clip.beginNumber || 1));
  const eNum = Math.min(14, bNum + Math.max(1, Number(clip.length || 2)) - 1);
  document.getElementById('diyBeginNumber').value = bNum;
  document.getElementById('diyEndNumber').value = eNum;
  document.getElementById('diyStartTime').value = clip.startTime || '08:00';
  document.getElementById('diyEndTime').value = clip.endTime || '09:50';
  document.getElementById('diyWeeksInput').value =
    Array.isArray(clip.weeks) && clip.weeks.length > 0
      ? formatWeeksCompact(clip.weeks).replace(/周$/, '')
      : '';
  showToast(`已填入课程《${clip.name}》信息`);
}

async function pasteCopiedLessonToDiy(targetDay = null, targetBeginPeriod = null) {
  if (!canEditSelectedAccount()) {
    showToast('只读模式无法修改他人课表');
    return;
  }
  const clip = getCopiedLessonClipboard();
  if (!clip) {
    showToast('请先在课表或课程列表点击「复制」');
    return;
  }
  const day = targetDay ? Number(targetDay) : Number(clip.dayOfWeek || 1);
  const beginNumber = targetBeginPeriod ? Math.max(1, Number(targetBeginPeriod)) : Math.max(1, Number(clip.beginNumber || 1));
  const length = Math.max(1, Number(clip.length || 2));
  const endNumber = Math.min(14, beginNumber + length - 1);
  const eff = state.status?.effectiveProfile || {};
  const curCfg = eff.effectiveCurriculum?.lessonTimeConfigArray || [];
  const startPair = (curCfg[beginNumber - 1] && curCfg[beginNumber - 1].split('-')) || DEFAULT_PERIOD_TIMES[beginNumber - 1] || ['08:00', '08:50'];
  const endPair = (curCfg[endNumber - 1] && curCfg[endNumber - 1].split('-')) || DEFAULT_PERIOD_TIMES[endNumber - 1] || ['09:00', '09:50'];
  const startTime = targetBeginPeriod ? (startPair[0] || '08:00').trim() : (clip.startTime || (startPair[0] || '08:00').trim());
  const endTime = targetBeginPeriod ? (endPair[1] || '09:50').trim() : (clip.endTime || (endPair[1] || '09:50').trim());

  state._editingDiyLessons = Array.isArray(state._editingDiyLessons)
    ? state._editingDiyLessons
    : [...(eff.diyLessons || [])];

  const newItem = {
    id: `diy_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    isDiy: true,
    enabled: true,
    pollingEnabled: true,
    courseId: clip.courseId || '',
    classId: clip.classId || '',
    className: clip.className || '',
    name: clip.name || '自定义课程',
    teacherName: clip.teacherName || '',
    location: clip.location || '',
    dayOfWeek: day,
    beginNumber,
    length: endNumber - beginNumber + 1,
    startTime,
    endTime,
    weeks: Array.isArray(clip.weeks) ? [...clip.weeks] : [],
  };

  state._editingDiyLessons.push(newItem);
  const dayNames = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  await persistDiyLessonsNow(`已粘贴《${newItem.name}》至 ${dayNames[day - 1] || '周一'} 第${beginNumber}-${endNumber}节`);
}

function onClickTimetableEmptySlot(day, period) {
  if (!canEditSelectedAccount()) return;
  const clip = getCopiedLessonClipboard();
  if (!clip) return;
  pasteCopiedLessonToDiy(day, period);
}

function renderDiyLessonsList(diyList) {
  syncDiyPasteButtonsUi();
  const box = document.getElementById('diyLessonsContainer');
  if (!box) return;
  const list = Array.isArray(diyList) ? diyList : [];
  const dayNames = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  if (list.length === 0) {
    box.innerHTML = `<div class="empty">暂无 DIY 自定义课程排课，点击右上角「新增 DIY 课程」可在现导入课程基础上添加排课及指定班级轮询规则</div>`;
    return;
  }
  box.innerHTML = list
    .map((item, idx) => {
      const dayStr = dayNames[Math.max(0, Math.min(6, Number(item.dayOfWeek || 1) - 1))];
      const endNum = Number(item.beginNumber || 1) + Math.max(1, Number(item.length || 1)) - 1;
      const periodStr = `第${item.beginNumber || 1}-${endNum}节 (${item.startTime || '08:00'}-${item.endTime || '09:50'})`;
      const weekStr = formatWeeksCompact(item.weeks);
      const ruleText = item.courseId
        ? `绑定规则: courseId=${item.courseId}${item.classId ? ` / classId=${item.classId}` : ''}${item.className ? ` (${item.className})` : ''}`
        : '按课程名匹配轮询';
      const enabled = item.enabled !== false && item.pollingEnabled !== false;
      return `<div class="list-row">
        <div>
          <div class="row" style="gap:6px;">
            <span class="tag solid">DIY 排课</span>
            <span style="font-weight:500;">${escapeHtml(item.name || '自定义课程')}</span>
            <span class="tag">${escapeHtml(dayStr)} · ${escapeHtml(periodStr)}</span>
            <span class="tag">${escapeHtml(weekStr)}</span>
          </div>
          <div style="font-size:11px; color:var(--muted); margin-top:3px;">
            ${escapeHtml(ruleText)}${item.teacherName ? ` · 教师/备注: ${escapeHtml(item.teacherName)}` : ''}${item.location ? ` · 地点: ${escapeHtml(item.location)}` : ''}
          </div>
        </div>
        <div class="row" style="gap:8px;">
          <span style="font-size:11px; color:var(--muted);">${enabled ? '参与轮询' : '已暂停'}</span>
          <label class="switch ${!canEditSelectedAccount() ? 'disabled' : ''}" title="启用或暂停该条 DIY 排课轮询规则">
            <input type="checkbox" ${enabled ? 'checked' : ''} ${!canEditSelectedAccount() ? 'disabled' : ''} onchange="toggleDiyLessonEnabled(${idx}, this.checked)" />
            <span class="slider"></span>
          </label>
          <button class="btn btn-ghost btn-sm" onclick="copyDiyLessonByIndex(${idx})">复制</button>
          ${canEditSelectedAccount()
            ? `<button class="btn btn-ghost btn-sm" onclick="openDiyLessonModal(${idx})">编辑规则</button>
               <button class="btn btn-ghost btn-sm" onclick="removeDiyLesson(${idx})">删除</button>`
            : `<span class="tag">只读</span>`}
        </div>
      </div>`;
    })
    .join('');
}

function populateDiyCourseBindSelect(selectedCourseId = '', selectedClassId = '') {
  const sel = document.getElementById('diyCourseBindSelect');
  if (!sel) return;
  const courses = state.courses || [];
  let html = `<option value="">-- 手动填写或从已导入的课程-班级中选择 --</option>`;
  courses.forEach((c, idx) => {
    const cName = c.name || c.courseName || '课程';
    const clsNote = c.note ? ` [班级: ${c.note}]` : '';
    const isSel =
      String(c.courseId) === String(selectedCourseId) &&
      (!selectedClassId || String(c.classId) === String(selectedClassId));
    html += `<option value="${idx}" ${isSel ? 'selected' : ''}>${escapeHtml(cName)}${escapeHtml(clsNote)} (courseId:${escapeHtml(c.courseId)} / classId:${escapeHtml(c.classId)})</option>`;
  });
  sel.innerHTML = html;
}

function onSelectDiyCourseBind(idxStr) {
  if (idxStr === '') return;
  const c = (state.courses || [])[Number(idxStr)];
  if (!c) return;
  document.getElementById('diyLessonName').value = c.name || c.courseName || '';
  document.getElementById('diyCourseId').value = c.courseId || '';
  document.getElementById('diyClassId').value = c.classId || '';
  document.getElementById('diyTeacherName').value = [c.teacher, c.note].filter(Boolean).join(' · ');
}

function onChangeDiyPeriodNumbers() {
  const b = Math.max(1, Math.min(14, Number(document.getElementById('diyBeginNumber').value || 1)));
  const e = Math.max(b, Math.min(14, Number(document.getElementById('diyEndNumber').value || b)));
  document.getElementById('diyBeginNumber').value = b;
  document.getElementById('diyEndNumber').value = e;
  const eff = state.status?.effectiveProfile || {};
  const curCfg = eff.effectiveCurriculum?.lessonTimeConfigArray || [];
  const startPair = (curCfg[b - 1] && curCfg[b - 1].split('-')) || DEFAULT_PERIOD_TIMES[b - 1] || ['08:00', '08:50'];
  const endPair = (curCfg[e - 1] && curCfg[e - 1].split('-')) || DEFAULT_PERIOD_TIMES[e - 1] || ['09:00', '09:50'];
  if (startPair[0]) document.getElementById('diyStartTime').value = startPair[0].trim();
  if (endPair[1]) document.getElementById('diyEndTime').value = endPair[1].trim();
}

function openDiyLessonModal(editIdx = null) {
  state._editingDiyIndex = editIdx;
  const list = state._editingDiyLessons || [];
  const existing = editIdx !== null && editIdx !== undefined ? list[editIdx] : null;

  document.getElementById('diyModalTitle').textContent = existing ? '编辑 DIY 排课与班级规则' : '新增 DIY 排课与班级规则';
  populateDiyCourseBindSelect(existing?.courseId || '', existing?.classId || '');

  document.getElementById('diyLessonName').value = existing?.name || '';
  document.getElementById('diyCourseId').value = existing?.courseId || '';
  document.getElementById('diyClassId').value = existing?.classId || '';
  document.getElementById('diyTeacherName').value = existing?.teacherName || '';
  document.getElementById('diyLocation').value = existing?.location || '';
  document.getElementById('diyDayOfWeek').value = String(existing?.dayOfWeek || 1);
  const bNum = Number(existing?.beginNumber || 1);
  const eNum = bNum + Math.max(1, Number(existing?.length || 2)) - 1;
  document.getElementById('diyBeginNumber').value = bNum;
  document.getElementById('diyEndNumber').value = eNum;
  document.getElementById('diyStartTime').value = existing?.startTime || '08:00';
  document.getElementById('diyEndTime').value = existing?.endTime || '09:50';
  document.getElementById('diyWeeksInput').value =
    existing && Array.isArray(existing.weeks) && existing.weeks.length > 0
      ? formatWeeksCompact(existing.weeks).replace(/周$/, '')
      : '';
  document.getElementById('diyPollingEnabled').checked = existing ? (existing.enabled !== false && existing.pollingEnabled !== false) : true;
  const delBtn = document.getElementById('diyDeleteBtn');
  if (delBtn) delBtn.style.display = existing ? 'inline-flex' : 'none';

  syncDiyPasteButtonsUi();
  openModal('diyLessonModal');
}

async function persistDiyLessonsNow(toastMsg = 'DIY 课表已保存') {
  const res = await api('/api/user/profile', 'POST', {
    uid: state.selectedUid,
    diyLessons: state._editingDiyLessons || [],
  });
  if (res.ok) {
    showToast(toastMsg);
    await refreshStatus(true);
  } else {
    showToast(res.msg || '保存失败');
  }
}

async function saveDiyLessonModal() {
  const name = document.getElementById('diyLessonName').value.trim();
  if (!name) return showToast('请填写课程名称或从下拉框选择已导入课程');
  const courseId = document.getElementById('diyCourseId').value.trim();
  const classId = document.getElementById('diyClassId').value.trim();
  const matchedCourse = (state.courses || []).find(
    (c) => String(c.courseId) === courseId && (!classId || String(c.classId) === classId)
  );
  const beginNumber = Math.max(1, Number(document.getElementById('diyBeginNumber').value || 1));
  const endNumber = Math.max(beginNumber, Number(document.getElementById('diyEndNumber').value || beginNumber));
  const length = endNumber - beginNumber + 1;
  const weeks = parseWeeksExpression(document.getElementById('diyWeeksInput').value);
  const enabled = Boolean(document.getElementById('diyPollingEnabled').checked);

  state._editingDiyLessons = state._editingDiyLessons || [];
  const idx = state._editingDiyIndex;
  const prev = idx !== null && idx !== undefined ? state._editingDiyLessons[idx] : null;

  const item = {
    id: prev?.id || `diy_${Date.now()}`,
    isDiy: true,
    enabled,
    pollingEnabled: enabled,
    courseId,
    classId,
    className: matchedCourse?.note || prev?.className || '',
    name,
    teacherName: document.getElementById('diyTeacherName').value.trim(),
    location: document.getElementById('diyLocation').value.trim(),
    dayOfWeek: Number(document.getElementById('diyDayOfWeek').value || 1),
    beginNumber,
    length,
    startTime: document.getElementById('diyStartTime').value || '08:00',
    endTime: document.getElementById('diyEndTime').value || '09:50',
    weeks,
  };

  if (idx !== null && idx !== undefined && state._editingDiyLessons[idx]) {
    state._editingDiyLessons[idx] = item;
  } else {
    state._editingDiyLessons.push(item);
  }

  closeModal('diyLessonModal');
  await persistDiyLessonsNow('DIY 排课规则已保存并同步至课表');
}

async function toggleDiyLessonEnabled(idx, checked) {
  state._editingDiyLessons = state._editingDiyLessons || [];
  if (!state._editingDiyLessons[idx]) return;
  state._editingDiyLessons[idx].enabled = Boolean(checked);
  state._editingDiyLessons[idx].pollingEnabled = Boolean(checked);
  await persistDiyLessonsNow(checked ? '已启用该条 DIY 排课轮询' : '已暂停该条 DIY 排课轮询');
}

async function removeDiyLesson(idx) {
  state._editingDiyLessons = state._editingDiyLessons || [];
  state._editingDiyLessons.splice(idx, 1);
  await persistDiyLessonsNow('已删除 DIY 排课规则');
}

async function deleteCurrentDiyLesson() {
  const idx = state._editingDiyIndex;
  if (idx === null || idx === undefined) return;
  closeModal('diyLessonModal');
  await removeDiyLesson(idx);
}

function syncProfileRandomOffsetInputs(source = 'sched') {
  const fromSwitch = document.getElementById(source === 'loc' ? 'locRandomOffsetEnabled' : 'profRandomOffsetEnabled');
  const toSwitch = document.getElementById(source === 'loc' ? 'profRandomOffsetEnabled' : 'locRandomOffsetEnabled');
  if (fromSwitch && toSwitch) toSwitch.checked = fromSwitch.checked;

  const fromInput = document.getElementById(source === 'loc' ? 'locRandomOffsetMeters' : 'profRandomOffsetMeters');
  const toInput = document.getElementById(source === 'loc' ? 'profRandomOffsetMeters' : 'locRandomOffsetMeters');
  if (fromInput && toInput) toInput.value = fromInput.value;
}

async function saveUserProfileConfig() {
  const intervalSeconds = Number(document.getElementById('cfgIntervalSeconds').value || 25);
  await api('/api/schedule', 'POST', { intervalSeconds });

  const offsetEnabledEl = document.getElementById('profRandomOffsetEnabled') || document.getElementById('locRandomOffsetEnabled');
  const offsetMetersEl = document.getElementById('profRandomOffsetMeters') || document.getElementById('locRandomOffsetMeters');
  const rawOffsetM = offsetMetersEl ? Number(offsetMetersEl.value) : 15;
  const locationRandomOffsetMeters = Number.isFinite(rawOffsetM) && rawOffsetM >= 0 ? Math.min(500, rawOffsetM) : 15;

  const body = {
    uid: state.selectedUid,
    inheritFromUid: document.getElementById('profInheritSelect').value || null,
    useCurriculumSchedule: true,
    curriculumBufferMinutes: Number(document.getElementById('profBufferMins').value || 10),
    defaultLocation: {
      address: document.getElementById('profDefAddress').value.trim(),
      latitude: Number(document.getElementById('profDefLat').value || 30.8328),
      longitude: Number(document.getElementById('profDefLng').value || 121.5035),
    },
    locationRandomOffsetEnabled: offsetEnabledEl ? Boolean(offsetEnabledEl.checked) : true,
    locationRandomOffsetMeters,
    diyLessons: state._editingDiyLessons || [],
  };
  const res = await api('/api/user/profile', 'POST', body);
  if (res.ok) {
    showToast('用户配置已保存');
    refreshStatus(true);
  }
}

async function copyProfileFromSelected() {
  const fromUid = document.getElementById('profInheritSelect').value;
  if (!fromUid) return showToast('请先在下拉框选择要复制的用户');
  const res = await api('/api/user/profile', 'POST', {
    uid: state.selectedUid,
    inheritFromUid: null,
    copyFromUid: fromUid,
  });
  if (res.ok) {
    showToast('已复制该用户的配置副本');
    refreshStatus(true);
  }
}

// 位置与地图选点（国内高德瓦片 GCJ-02 <-> WGS-84 双向坐标转换）
function isOutOfChina(lat, lng) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function deltaGcj(lat, lng) {
  const a = 6378245.0;
  const ee = 0.00669342162296594323;
  const x = lng - 105.0;
  const y = lat - 35.0;
  let dLat = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  dLat += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  dLat += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
  dLat += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;

  let dLng = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  dLng += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  dLng += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
  dLng += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;

  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((a * (1 - ee)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180.0) / ((a / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return { dLat, dLng };
}

function wgs84ToGcj02(lat, lng) {
  const nLat = Number(lat);
  const nLng = Number(lng);
  if (!Number.isFinite(nLat) || !Number.isFinite(nLng) || isOutOfChina(nLat, nLng)) {
    return [nLat, nLng];
  }
  const { dLat, dLng } = deltaGcj(nLat, nLng);
  return [nLat + dLat, nLng + dLng];
}

function gcj02ToWgs84(lat, lng) {
  const nLat = Number(lat);
  const nLng = Number(lng);
  if (!Number.isFinite(nLat) || !Number.isFinite(nLng) || isOutOfChina(nLat, nLng)) {
    return [nLat, nLng];
  }
  const { dLat, dLng } = deltaGcj(nLat, nLng);
  return [nLat - dLat, nLng - dLng];
}

function createDomesticTileLayer() {
  if (typeof L !== 'undefined' && L.Icon && L.Icon.Default) {
    L.Icon.Default.imagePath = 'vendor/leaflet/images/';
  }
  const layer = L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', {
    subdomains: ['1', '2', '3', '4'],
    maxZoom: 18,
    minZoom: 3,
    attribution: '© 高德地图',
  });
  let errCount = 0;
  let switched = false;
  layer.on('tileerror', () => {
    errCount += 1;
    if (!switched && errCount >= 3) {
      switched = true;
      layer.setUrl('https://wprd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&style=7&x={x}&y={y}&z={z}&scl=1&ltype=11');
    }
  });
  return layer;
}

function initMainLeafletMap() {
  if (typeof L === 'undefined') return;
  const def = state.status?.effectiveProfile?.defaultLocation || { latitude: 30.8328, longitude: 121.5035, address: '上海应用技术大学(奉贤校区)' };
  const [gcjLat, gcjLng] = wgs84ToGcj02(def.latitude, def.longitude);
  if (!state.mainMap) {
    state.mainMap = L.map('mainLeafletMap').setView([gcjLat, gcjLng], 16);
    createDomesticTileLayer().addTo(state.mainMap);
    state.mainMarker = L.marker([gcjLat, gcjLng]).addTo(state.mainMap);
    state.mainMap.on('click', async (e) => {
      const [wgsLat, wgsLng] = gcj02ToWgs84(e.latlng.lat, e.latlng.lng);
      setMainMapPoint(wgsLat, wgsLng, null, true);
    });
    setMainMapPoint(def.latitude, def.longitude, def.address, false);
    setTimeout(() => { if (state.mainMap) state.mainMap.invalidateSize(); }, 180);
  } else {
    state.mainMap.invalidateSize();
  }
}

async function setMainMapPoint(lat, lng, addr = null, doReverse = false) {
  const latFixed = Number(lat).toFixed(6);
  const lngFixed = Number(lng).toFixed(6);
  document.getElementById('mapPickLat').value = latFixed;
  document.getElementById('mapPickLng').value = lngFixed;
  if (state.mainMarker && state.mainMap) {
    const [gcjLat, gcjLng] = wgs84ToGcj02(lat, lng);
    state.mainMarker.setLatLng([gcjLat, gcjLng]);
    state.mainMap.panTo([gcjLat, gcjLng]);
  }
  if (addr) {
    document.getElementById('mapPickAddress').value = addr;
  } else if (doReverse) {
    const rev = await api(`/api/geo/reverse?lat=${latFixed}&lng=${lngFixed}`);
    if (rev.ok && rev.address) document.getElementById('mapPickAddress').value = rev.address;
  }
}

async function searchMainMap() {
  const q = document.getElementById('mapSearchInput').value.trim();
  if (!q) return showToast('请输入搜索关键词');
  const box = document.getElementById('mapSearchResults');
  box.innerHTML = `<span class="tag">搜索中...</span>`;
  const res = await api(`/api/geo/search?q=${encodeURIComponent(q)}`);
  const list = res.list || [];
  state.lastMainSearchList = list;
  if (list.length === 0) {
    box.innerHTML = `<span class="tag">无搜索结果</span>`;
    return;
  }
  box.innerHTML = list
    .map(
      (item, idx) =>
        `<button class="btn btn-ghost btn-sm" onclick="selectMainSearchIdx(${idx})">${escapeHtml(item.name)}</button>`
    )
    .join('');
  selectMainSearchIdx(0);
}

function selectMainSearchIdx(idx) {
  const item = (state.lastMainSearchList || [])[idx];
  if (!item) return;
  selectMainSearchPoint(item.latitude, item.longitude, item.name, item.address);
}

function selectMainSearchPoint(lat, lng, name, address) {
  document.getElementById('mapPickName').value = name || '';
  setMainMapPoint(lat, lng, address || name, false);
}

function locateBrowserOnMainMap() {
  if (!navigator.geolocation) return showToast('浏览器不支持定位');
  navigator.geolocation.getCurrentPosition(
    (pos) => setMainMapPoint(pos.coords.latitude, pos.coords.longitude, null, true),
    () => showToast('获取定位失败')
  );
}

async function addCurrentMapPointToPresets() {
  const name = document.getElementById('mapPickName').value.trim() || document.getElementById('mapPickAddress').value.trim() || '常用地点';
  const address = document.getElementById('mapPickAddress').value.trim() || name;
  const latitude = Number(document.getElementById('mapPickLat').value || 30.8328);
  const longitude = Number(document.getElementById('mapPickLng').value || 121.5035);

  const res = await api('/api/locations/presets', 'POST', {
    action: 'add',
    preset: { name, address, latitude, longitude },
  });
  if (res.ok) {
    showToast('已加入常用位置预设');
    refreshStatus(false);
  }
}

function applyMapPointToUserDefault() {
  document.getElementById('profDefAddress').value = document.getElementById('mapPickAddress').value.trim();
  document.getElementById('profDefLat').value = document.getElementById('mapPickLat').value.trim();
  document.getElementById('profDefLng').value = document.getElementById('mapPickLng').value.trim();
  saveUserProfileConfig();
}

function renderLocationPresets(presets) {
  const box = document.getElementById('locationPresetsList');
  if (!box) return;
  if (!presets || presets.length === 0) {
    setHtmlIfChanged(box, `<div class="empty">暂无常用预设</div>`);
    return;
  }
  const isAdmin = isCurrentPanelAdmin();
  const curUser = getCurrentPanelUsername();
  const canEditSelected = canEditSelectedAccount();

  const presetsHtml = presets
    .map((p) => {
      const creator = p.createdBy || 'ishit';
      const canModifyPreset = isAdmin || !p.createdBy || p.createdBy === curUser;
      return `
    <div class="list-row">
      <div>
        <div class="row" style="gap:6px;">
          <span style="font-weight:500;">${escapeHtml(p.name)}</span>
          <span class="tag">创建者: ${escapeHtml(creator)}</span>
        </div>
        <div style="font-size:11px; color:var(--muted); margin-top:2px;">${escapeHtml(p.address)} (${p.latitude}, ${p.longitude})</div>
      </div>
      <div class="row">
        ${canEditSelected ? `<button class="btn btn-ghost btn-sm" onclick="usePresetAsUserDefault('${escapeHtml(p.address)}',${p.latitude},${p.longitude})">设为默认</button>` : ''}
        ${canModifyPreset ? `<button class="btn btn-ghost btn-sm" onclick="openEditLocationPresetModal('${escapeHtml(p.id)}')">编辑</button>` : ''}
        ${canModifyPreset ? `<button class="btn btn-ghost btn-sm" onclick="deleteLocationPreset('${escapeHtml(p.id)}')">删除</button>` : ''}
      </div>
    </div>`;
    })
    .join('');
  setHtmlIfChanged(box, presetsHtml);
}

function openEditLocationPresetModal(id) {
  const presets = state.status?.locationPresets || [];
  const p = presets.find((item) => String(item.id) === String(id));
  if (!p) return;
  document.getElementById('editPresetId').value = p.id;
  document.getElementById('editPresetName').value = p.name || '';
  document.getElementById('editPresetAddress').value = p.address || '';
  document.getElementById('editPresetLat').value = p.latitude ?? '';
  document.getElementById('editPresetLng').value = p.longitude ?? '';
  openModal('editPresetModal');
}

async function saveEditedLocationPreset() {
  const id = document.getElementById('editPresetId').value;
  if (!id) return;
  const name = document.getElementById('editPresetName').value.trim();
  const address = document.getElementById('editPresetAddress').value.trim() || name;
  const latitude = Number(document.getElementById('editPresetLat').value || 30.8328);
  const longitude = Number(document.getElementById('editPresetLng').value || 121.5035);
  if (!name) return showToast('请输入预设名称');

  const res = await api('/api/locations/presets', 'POST', {
    action: 'update',
    id,
    preset: { id, name, address, latitude, longitude },
  });
  if (res.ok) {
    closeModal('editPresetModal');
    showToast('位置预设已更新');
    refreshStatus(false);
  } else {
    showToast(res.msg || '更新失败');
  }
}

function usePresetAsUserDefault(address, lat, lng) {
  document.getElementById('profDefAddress').value = address;
  document.getElementById('profDefLat').value = lat;
  document.getElementById('profDefLng').value = lng;
  saveUserProfileConfig();
}

async function deleteLocationPreset(id) {
  await api('/api/locations/presets', 'POST', { action: 'delete', id });
  showToast('已删除预设');
  refreshStatus(false);
}

// 通用弹窗地图选点
function openMapPicker(addrId, latId, lngId) {
  state.modalTargetIds = { addrId, latId, lngId };
  const initLat = Number(document.getElementById(latId)?.value || state.status?.effectiveProfile?.defaultLocation?.latitude || 30.8328);
  const initLng = Number(document.getElementById(lngId)?.value || state.status?.effectiveProfile?.defaultLocation?.longitude || 121.5035);
  const initAddr = document.getElementById(addrId)?.value || '';

  document.getElementById('modalMapAddress').value = initAddr;
  document.getElementById('modalMapLat').value = initLat.toFixed(6);
  document.getElementById('modalMapLng').value = initLng.toFixed(6);
  openModal('mapPickerModal');

  setTimeout(() => {
    if (typeof L === 'undefined') return;
    const [gcjLat, gcjLng] = wgs84ToGcj02(initLat, initLng);
    if (!state.modalMap) {
      state.modalMap = L.map('modalLeafletMap').setView([gcjLat, gcjLng], 16);
      createDomesticTileLayer().addTo(state.modalMap);
      state.modalMarker = L.marker([gcjLat, gcjLng]).addTo(state.modalMap);
      state.modalMap.on('click', async (e) => {
        const [wgsLat, wgsLng] = gcj02ToWgs84(e.latlng.lat, e.latlng.lng);
        setModalMapPoint(wgsLat, wgsLng, null, true);
      });
    } else {
      state.modalMap.invalidateSize();
      state.modalMap.setView([gcjLat, gcjLng], 16);
      setModalMapPoint(initLat, initLng, initAddr, false);
    }
  }, 100);
}

async function setModalMapPoint(lat, lng, addr = null, doReverse = false) {
  const latFixed = Number(lat).toFixed(6);
  const lngFixed = Number(lng).toFixed(6);
  document.getElementById('modalMapLat').value = latFixed;
  document.getElementById('modalMapLng').value = lngFixed;
  if (state.modalMarker && state.modalMap) {
    const [gcjLat, gcjLng] = wgs84ToGcj02(lat, lng);
    state.modalMarker.setLatLng([gcjLat, gcjLng]);
    state.modalMap.panTo([gcjLat, gcjLng]);
  }
  if (addr) {
    document.getElementById('modalMapAddress').value = addr;
  } else if (doReverse) {
    const rev = await api(`/api/geo/reverse?lat=${latFixed}&lng=${lngFixed}`);
    if (rev.ok && rev.address) document.getElementById('modalMapAddress').value = rev.address;
  }
}

async function searchModalMap() {
  const q = document.getElementById('modalMapSearchInput').value.trim();
  if (!q) return showToast('请输入搜索关键词');
  const box = document.getElementById('modalMapSearchResults');
  box.innerHTML = `<span class="tag">搜索中...</span>`;
  const res = await api(`/api/geo/search?q=${encodeURIComponent(q)}`);
  const list = res.list || [];
  state.lastModalSearchList = list;
  if (list.length === 0) {
    box.innerHTML = `<span class="tag">无搜索结果</span>`;
    return;
  }
  box.innerHTML = list
    .map(
      (item, idx) =>
        `<button class="btn btn-ghost btn-sm" onclick="selectModalSearchIdx(${idx})">${escapeHtml(item.name)}</button>`
    )
    .join('');
  selectModalSearchIdx(0);
}

function selectModalSearchIdx(idx) {
  const item = (state.lastModalSearchList || [])[idx];
  if (!item) return;
  setModalMapPoint(item.latitude, item.longitude, item.address || item.name, false);
}

function confirmModalMapPick() {
  const t = state.modalTargetIds;
  if (t) {
    if (document.getElementById(t.addrId)) document.getElementById(t.addrId).value = document.getElementById('modalMapAddress').value.trim();
    if (document.getElementById(t.latId)) document.getElementById(t.latId).value = document.getElementById('modalMapLat').value.trim();
    if (document.getElementById(t.lngId)) document.getElementById(t.lngId).value = document.getElementById('modalMapLng').value.trim();
  }
  closeModal('mapPickerModal');
}

async function saveModalMapPickAsPreset() {
  const address = document.getElementById('modalMapAddress').value.trim() || '选定位置';
  const latitude = Number(document.getElementById('modalMapLat').value || 30.8328);
  const longitude = Number(document.getElementById('modalMapLng').value || 121.5035);
  await api('/api/locations/presets', 'POST', {
    action: 'add',
    preset: { name: address.slice(0, 18), address, latitude, longitude },
  });
  showToast('已保存为常用预设');
  confirmModalMapPick();
  refreshStatus(false);
}

function fillBrowserGps(latId, lngId, addrId) {
  if (!navigator.geolocation) return showToast('不支持浏览器定位');
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const lat = pos.coords.latitude.toFixed(6);
      const lng = pos.coords.longitude.toFixed(6);
      document.getElementById(latId).value = lat;
      document.getElementById(lngId).value = lng;
      const rev = await api(`/api/geo/reverse?lat=${lat}&lng=${lng}`);
      if (rev.ok && rev.address && document.getElementById(addrId)) {
        document.getElementById(addrId).value = rev.address;
      }
    },
    () => showToast('定位失败')
  );
}

// 账号管理与扫码登录修复
function switchLoginMode(mode, btn) {
  document.getElementById('loginBoxPwd').style.display = mode === 'pwd' ? 'block' : 'none';
  document.getElementById('loginBoxQr').style.display = mode === 'qr' ? 'block' : 'none';
  document.getElementById('loginBoxSms').style.display = mode === 'sms' ? 'block' : 'none';
  document.querySelectorAll('#adminLoginPanel .tab-btn').forEach((b) => b.classList.remove('active'));
  if (btn) btn.classList.add('active');

  clearInterval(state.qrPollTimer);
  if (mode === 'qr') startQrLogin();
}

async function doWebLogin() {
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value.trim();
  if (!username || !password) return showToast('请输入账号和密码');
  showToast('正在登录...');
  const res = await api('/api/accounts/login', 'POST', { username, password });
  if (res.ok) {
    showToast(`登录成功: ${res.user.name}`);
    state.selectedUid = res.user.uid;
    if (!state.helperToken) refreshStatus(true);
  } else {
    showToast(res.msg || '登录失败');
  }
}

async function startQrLogin() {
  clearInterval(state.qrPollTimer);
  const statusEl = document.getElementById('qrStatusText');
  const imgEl = document.getElementById('qrLoginImg');
  if (statusEl) statusEl.textContent = '正在获取二维码...';
  const tempKey = `__qr_${Date.now()}`;
  const res = await api('/api/accounts/qr/create', 'POST', { tempKey });
  if (!res.ok || !res.qrImageUrl) {
    if (statusEl) statusEl.textContent = '获取二维码失败，请点击刷新';
    return;
  }
  imgEl.src = res.qrImageUrl;
  imgEl.style.display = 'block';
  statusEl.textContent = '请使用学习通客户端扫码';

  state.qrPollTimer = setInterval(async () => {
    const p = await api('/api/accounts/qr/poll', 'POST', {
      uuid: res.uuid,
      enc: res.enc,
      tempKey: res.tempKey || tempKey,
    });
    if (p.loggedIn && p.user) {
      clearInterval(state.qrPollTimer);
      statusEl.textContent = `登录成功: ${p.user.name}`;
      showToast(`扫码登录成功: ${p.user.name}`);
      state.selectedUid = p.user.uid;
      if (!state.helperToken) refreshStatus(true);
    } else if (p.expired) {
      clearInterval(state.qrPollTimer);
      statusEl.textContent = '二维码已过期，请点击刷新';
    } else if (p.statusText) {
      statusEl.textContent = p.statusText;
    }
  }, 2200);
}

async function doSendSms() {
  const phone = document.getElementById('smsPhone').value.trim();
  if (!phone) return showToast('请输入手机号');
  const res = await api('/api/accounts/sms/send', 'POST', { phone });
  showToast(res.msg || '已发送');
}

async function doSmsLogin() {
  const phone = document.getElementById('smsPhone').value.trim();
  const code = document.getElementById('smsCode').value.trim();
  const res = await api('/api/accounts/sms/login', 'POST', { phone, code });
  if (res.ok) {
    showToast(`登录成功: ${res.user.name}`);
    state.selectedUid = res.user.uid;
    if (!state.helperToken) refreshStatus(true);
  } else {
    showToast(res.msg || '登录失败');
  }
}

function renderAccountsList(accounts, currentUid) {
  const box = document.getElementById('accountsListContainer');
  if (!box) return;
  if (!accounts || accounts.length === 0) {
    setHtmlIfChanged(box, `<div class="empty">暂无已登录账号</div>`);
    return;
  }
  const isAdmin = isCurrentPanelAdmin();
  const curUser = getCurrentPanelUsername();

  const accountsHtml = accounts
    .map((a) => {
      const owner = a.ownerUsername || 'ishit';
      const isMine = isAdmin || owner === curUser;
      const hasFace = Boolean(a.cachedFaceObjectId);
      const faceTag = hasFace
        ? '<span class="tag" title="已缓存本人人脸底图，支持机房环境直接过人脸签到">人脸已就绪</span>'
        : '<span class="tag" style="opacity:0.75;" title="云服务器环境请点击右侧「人脸照片」上传一张本人正脸照">待绑人脸照</span>';
      return `
    <div class="list-row">
      <div>
        <div class="row" style="gap:6px; flex-wrap:wrap;">
          <span style="font-weight:500;">${escapeHtml(a.name)}</span>
          <span class="tag ${owner === curUser ? 'solid' : ''}">归属用户: ${escapeHtml(owner)}</span>
          ${faceTag}
          ${isAdmin && a.uid === currentUid ? '<span class="tag solid">主账号</span>' : ''}
        </div>
        <div style="font-size:11px; color:var(--muted); margin-top:2px;">${escapeHtml(a.school || a.schoolname || '')} · UID: ${escapeHtml(a.uid)}</div>
      </div>
      <div class="row">
        <button class="btn btn-ghost btn-sm" onclick="onSelectConfigUser('${escapeHtml(a.uid)}');switchUserSubTab('courses')">${isMine ? '进入工作台' : '查看课程/课表'}</button>
        ${isMine ? `<label class="btn btn-ghost btn-sm" style="margin:0; cursor:pointer;" title="上传本人正脸照片用于通过人脸识别签到">${hasFace ? '更新人脸' : '上传人脸'}<input type="file" accept="image/*" style="display:none;" onchange="uploadAccountFacePhoto('${escapeHtml(a.uid)}', this)" /></label>` : ''}
        ${isAdmin && a.uid !== currentUid ? `<button class="btn btn-ghost btn-sm" onclick="accountAction('setPrimary','${escapeHtml(a.uid)}')">设为主号</button>` : ''}
        ${isMine ? `<button class="btn btn-ghost btn-sm" onclick="accountAction('delete','${escapeHtml(a.uid)}')">移除</button>` : ''}
      </div>
    </div>`;
    })
    .join('');
  setHtmlIfChanged(box, accountsHtml);
}

async function uploadAccountFacePhoto(uid, inputEl) {
  const file = inputEl?.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    showToast('正在上传人脸底图到超星云盘...');
    const res = await api('/api/accounts/action', 'POST', {
      action: 'uploadFace',
      uid,
      base64Image: reader.result,
    });
    if (res.ok) {
      showToast('人脸底图已绑定，自动人脸识别已就绪');
      refreshStatus(false);
    } else {
      showToast(res.msg || '上传人脸底图失败');
    }
  };
  reader.readAsDataURL(file);
}

async function accountAction(action, uid) {
  await api('/api/accounts/action', 'POST', { action, uid });
  refreshStatus(true);
}

async function refreshAllAccounts() {
  showToast('正在校验所有账号状态...');
  await api('/api/accounts/action', 'POST', { action: 'refreshAll' });
  showToast('校验完成');
  refreshStatus(false);
}

// NapCat 推送与群聊二级菜单（QQ 绑定学习通账号，1 个学习通账号支持绑定多个 QQ）
function parseQqListInput(strOrArr) {
  const arr = Array.isArray(strOrArr)
    ? strOrArr
    : String(strOrArr || '').split(/[\s,，;；\n]+/);
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const clean = String(item || '').trim();
    if (/^\d{5,13}$/.test(clean) && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

function populateNapCatInputs(nc) {
  state.napcatGroupBindings = JSON.parse(JSON.stringify(nc.groupBindings || {}));
  document.getElementById('napEnabled').checked = Boolean(nc.enabled);
  document.getElementById('napHttpUrl').value = nc.httpUrl || 'http://127.0.0.1:6099/plugin/napcat-plugin-qce/api';
  document.getElementById('napToken').value = nc.accessToken || '';
  document.getElementById('napPublicUrl').value = (nc.publicBaseUrl || 'https://ishit.pw').replace(/^http:\/\/ishit\.pw\b/i, 'https://ishit.pw');
  state.napcatGroups = (nc.groups || nc.groupIds || []).map((g) => String(g).trim()).filter(Boolean);
  state.napcatPrivates = (nc.privateUsers || nc.privateIds || []).map((u) => String(u).trim()).filter(Boolean);
  renderNapCatGroupsList(state.napcatGroups);
  renderNapCatPrivatesList(state.napcatPrivates);
}

function getCurrentNapGroupsFromUi() {
  if (Array.isArray(state.napcatGroups)) return [...state.napcatGroups];
  const nc = state.status?.napcat || {};
  return (nc.groups || nc.groupIds || []).map((g) => String(g).trim()).filter(Boolean);
}

function getCurrentNapPrivatesFromUi() {
  if (Array.isArray(state.napcatPrivates)) return [...state.napcatPrivates];
  const nc = state.status?.napcat || {};
  return (nc.privateUsers || nc.privateIds || []).map((u) => String(u).trim()).filter(Boolean);
}

function addNapCatGroupFromInput() {
  const inp = document.getElementById('napNewGroupInput');
  const raw = String(inp?.value || '').trim();
  const newGids = parseQqListInput(raw);
  if (newGids.length === 0) {
    showToast('请输入有效的 QQ 群号');
    return;
  }
  const groups = getCurrentNapGroupsFromUi();
  for (const gid of newGids) {
    if (!groups.includes(gid)) groups.push(gid);
  }
  state.napcatGroups = groups;
  if (inp) inp.value = '';
  renderNapCatGroupsList(groups);
  saveNapCatConfig();
}

function removeNapCatGroup(gid) {
  const groups = getCurrentNapGroupsFromUi().filter((g) => g !== String(gid));
  state.napcatGroups = groups;
  renderNapCatGroupsList(groups);
  saveNapCatConfig();
}

function addNapCatPrivateFromInput() {
  const inp = document.getElementById('napNewPrivateInput');
  const raw = String(inp?.value || '').trim();
  const newQqs = parseQqListInput(raw);
  if (newQqs.length === 0) {
    showToast('请输入有效的私聊 QQ 号');
    return;
  }
  const privs = getCurrentNapPrivatesFromUi();
  for (const qq of newQqs) {
    if (!privs.includes(qq)) privs.push(qq);
  }
  state.napcatPrivates = privs;
  if (inp) inp.value = '';
  renderNapCatPrivatesList(privs);
  saveNapCatConfig();
}

function removeNapCatPrivate(qq) {
  const privs = getCurrentNapPrivatesFromUi().filter((u) => u !== String(qq));
  state.napcatPrivates = privs;
  renderNapCatPrivatesList(privs);
  saveNapCatConfig();
}

function renderNapCatPrivatesList(privatesInput) {
  const box = document.getElementById('napPrivatesListBox');
  if (!box) return;
  const privs = Array.isArray(privatesInput) ? privatesInput : getCurrentNapPrivatesFromUi();
  if (privs.length === 0) {
    box.innerHTML = `<div class="empty" style="padding:12px;">暂无配置私聊 QQ，请在上方输入 QQ 号添加</div>`;
    return;
  }
  box.innerHTML = privs
    .map(
      (qq) => `
        <div class="list-row" style="padding:8px 10px;">
          <div style="min-width:0; flex:1; padding-right:8px;">
            <div style="font-weight:600; font-size:13px;">QQ：${escapeHtml(qq)}</div>
          </div>
          <div class="row" style="gap:6px; flex-shrink:0;">
            <button type="button" class="btn btn-ghost btn-sm" onclick="removeNapCatPrivate('${escapeHtml(qq)}')">移除</button>
          </div>
        </div>
      `
    )
    .join('');
}

function renderNapCatGroupsList(groupsInput) {
  const box = document.getElementById('napGroupsListBox');
  if (!box) return;
  const groups = Array.isArray(groupsInput) ? groupsInput : getCurrentNapGroupsFromUi();
  if (groups.length === 0) {
    box.innerHTML = `<div class="empty" style="padding:12px;">暂无配置群聊，请在上方输入群号添加</div>`;
    return;
  }
  const allAccounts = state.status?.accounts || [];
  const bindingsRoot = state.napcatGroupBindings || state.status?.napcat?.groupBindings || {};

  box.innerHTML = groups
    .map((gid) => {
      const gMap = bindingsRoot[String(gid)] || {};
      const boundSummaryParts = [];
      let totalQqCount = 0;
      for (const acc of allAccounts) {
        const qqs = parseQqListInput(gMap[String(acc.uid)]);
        if (qqs.length > 0) {
          totalQqCount += qqs.length;
          boundSummaryParts.push(`${acc.name || acc.uid}: @${qqs.join(', @')}`);
        }
      }
      const summaryText =
        boundSummaryParts.length > 0
          ? `已绑定 ${boundSummaryParts.length} 个账号 (${totalQqCount} 个 QQ)：${boundSummaryParts.join(' ｜ ')}`
          : '未设置账号 @ 绑定（点击右侧按钮配置）';
      return `
        <div class="list-row" style="padding:8px 10px;">
          <div style="min-width:0; flex:1; padding-right:8px;">
            <div style="font-weight:600; font-size:13px;">群号：${escapeHtml(gid)}</div>
            <div style="font-size:11px; color:var(--muted); margin-top:2px; word-break:break-all;">${escapeHtml(summaryText)}</div>
          </div>
          <div class="row" style="gap:6px; flex-shrink:0;">
            <button type="button" class="btn btn-sm" onclick="openNapGroupBindModal('${escapeHtml(gid)}')">@ 绑定设置</button>
            <button type="button" class="btn btn-ghost btn-sm" onclick="removeNapCatGroup('${escapeHtml(gid)}')">移除</button>
          </div>
        </div>
      `;
    })
    .join('');
}

let tempModalGroupBindings = {}; // uid -> string[]

function openNapGroupBindModal(gid) {
  const cleanGid = String(gid || '').trim();
  if (!cleanGid) return;
  document.getElementById('napGroupBindGid').value = cleanGid;
  document.getElementById('napGroupBindTitle').textContent = `群聊 ${cleanGid} · 学习通账号绑定 QQ`;
  const bindingsRoot = state.napcatGroupBindings || state.status?.napcat?.groupBindings || {};
  const existing = bindingsRoot[cleanGid] || {};
  tempModalGroupBindings = {};
  const accounts = state.status?.accounts || [];
  for (const acc of accounts) {
    tempModalGroupBindings[String(acc.uid)] = parseQqListInput(existing[String(acc.uid)]);
  }
  renderNapGroupBindModalAccounts();
  openModal('napGroupBindModal');
}

function renderNapGroupBindModalAccounts() {
  const box = document.getElementById('napGroupBindAccountsList');
  if (!box) return;
  const accounts = state.status?.accounts || [];
  if (accounts.length === 0) {
    box.innerHTML = `<div class="empty">当前尚未登录任何学习通账号，请先在「系统设置 -> 学习通账号」中添加账号</div>`;
    return;
  }
  box.innerHTML = accounts
    .map((acc) => {
      const uid = String(acc.uid);
      const qqs = tempModalGroupBindings[uid] || [];
      const tagsHtml =
        qqs.length > 0
          ? qqs
              .map(
                (qq) => `
              <span class="tag" style="display:inline-flex; align-items:center; gap:5px; padding:3px 8px; font-size:12px;">
                @${escapeHtml(qq)}
                <span style="cursor:pointer; font-weight:700; opacity:0.75;" title="移除该 QQ" onclick="removeQqFromAccountInModal('${escapeHtml(uid)}','${escapeHtml(qq)}')">×</span>
              </span>
            `
              )
              .join('')
          : `<span style="font-size:11px; color:var(--muted);">暂未绑定 QQ（收到该用户的消息时不额外 @）</span>`;

      return `
        <div class="list-row" style="flex-direction:column; align-items:stretch; gap:8px; padding:10px 12px;">
          <div class="row" style="justify-content:space-between;">
            <div>
              <span style="font-weight:600; font-size:13px;">${escapeHtml(acc.name || acc.uid)}</span>
              <span style="font-size:11px; color:var(--muted); margin-left:6px;">UID: ${escapeHtml(uid)} ${acc.phone ? `· ${escapeHtml(acc.phone)}` : ''}</span>
            </div>
            <span class="tag">已绑 ${qqs.length} 个 QQ</span>
          </div>
          <div class="row" style="flex-wrap:wrap; gap:6px;">
            ${tagsHtml}
          </div>
          <div class="row" style="gap:6px;">
            <input
              id="bindQqInput_${escapeHtml(uid)}"
              placeholder="输入要绑定的 QQ 号（支持空格或逗号分隔多个 QQ）"
              style="flex:1;"
              onkeydown="if(event.key==='Enter')addQqToAccountInModal('${escapeHtml(uid)}')"
            />
            <button type="button" class="btn btn-ghost btn-sm" onclick="addQqToAccountInModal('${escapeHtml(uid)}')">+ 添加绑定 QQ</button>
          </div>
        </div>
      `;
    })
    .join('');
}

function addQqToAccountInModal(uid) {
  const inp = document.getElementById(`bindQqInput_${uid}`);
  if (!inp) return;
  const newQqs = parseQqListInput(inp.value);
  if (newQqs.length === 0) {
    showToast('请输入有效的 QQ 号（5~13 位数字）');
    return;
  }
  const current = tempModalGroupBindings[String(uid)] || [];
  const merged = parseQqListInput([...current, ...newQqs]);
  tempModalGroupBindings[String(uid)] = merged;
  inp.value = '';
  renderNapGroupBindModalAccounts();
}

function removeQqFromAccountInModal(uid, qq) {
  const current = tempModalGroupBindings[String(uid)] || [];
  tempModalGroupBindings[String(uid)] = current.filter((item) => item !== String(qq));
  renderNapGroupBindModalAccounts();
}

async function saveNapGroupBindModal() {
  const gid = document.getElementById('napGroupBindGid').value.trim();
  if (!gid) return;
  // 若输入框中还有未点击“+ 添加”的 QQ 号，一并自动收入
  const accounts = state.status?.accounts || [];
  for (const acc of accounts) {
    const uid = String(acc.uid);
    const inp = document.getElementById(`bindQqInput_${uid}`);
    if (inp && inp.value.trim()) {
      const extra = parseQqListInput(inp.value);
      tempModalGroupBindings[uid] = parseQqListInput([...(tempModalGroupBindings[uid] || []), ...extra]);
      inp.value = '';
    }
  }
  if (!state.napcatGroupBindings) state.napcatGroupBindings = {};
  state.napcatGroupBindings[gid] = { ...tempModalGroupBindings };
  await saveNapCatConfig();
  renderNapCatGroupsList();
  closeModal('napGroupBindModal');
  showToast(`群 ${gid} 的账号 @ 绑定已保存`);
}

async function saveNapCatConfig() {
  const groups = getCurrentNapGroupsFromUi();
  const privateUsers = getCurrentNapPrivatesFromUi();
  const body = {
    enabled: document.getElementById('napEnabled').checked,
    httpUrl: document.getElementById('napHttpUrl').value.trim(),
    accessToken: document.getElementById('napToken').value.trim(),
    publicBaseUrl: document.getElementById('napPublicUrl').value.trim(),
    groups,
    privateUsers,
    groupBindings: state.napcatGroupBindings || state.status?.napcat?.groupBindings || {},
  };
  const res = await api('/api/napcat', 'POST', body);
  if (res.ok && state.status) {
    state.status.napcat = res.napcat;
  }
  renderNapCatGroupsList(groups);
  renderNapCatPrivatesList(privateUsers);
  showToast('推送设置已保存');
}

async function testNapCatPush() {
  await saveNapCatConfig();
  const res = await api('/api/napcat/test', 'POST', {});
  showToast(res.ok ? '测试消息已发送' : `发送失败: ${res.reason || '请检查地址或群号'}`);
}

// 防作弊滑块验证码弹窗
async function openSlideCaptchaModal(key) {
  state.currentCaptchaKey = key;
  openModal('slideCaptchaModal');
  await loadCaptchaStage(key);
}

async function loadCaptchaStage(key) {
  const res = await api(`/api/captcha/get?key=${encodeURIComponent(key)}`);
  const cap = res.pending?.captcha || res.captcha;
  if (!cap) {
    showToast('获取验证码失败');
    return;
  }
  document.getElementById('capBgImg').src = cap.shadeImageUrl || cap.shadeImage || '';
  const cut = document.getElementById('capCutImg');
  cut.src = cap.cutoutImageUrl || cap.cutoutImage || '';
  cut.style.left = '0px';
  document.getElementById('capRangeInput').value = 0;
}

function onCaptchaSlideMove(val) {
  const cut = document.getElementById('capCutImg');
  if (cut) cut.style.left = `${val}px`;
}

async function onCaptchaSlideRelease(val) {
  if (!state.currentCaptchaKey) return;
  showToast('正在校验滑块...');
  const res = await api('/api/captcha/verify', 'POST', {
    key: state.currentCaptchaKey,
    xValue: Number(val),
  });
  if (res.ok) {
    closeModal('slideCaptchaModal');
    const msg = res.record?.results?.[0]?.msg || '验证通过并已完成重签';
    showToast(msg);
    if (state.helperToken) {
      document.getElementById('helpCaptchaMount').innerHTML = `<div class="list-row"><span>验证通过: ${escapeHtml(msg)}</span></div>`;
    } else {
      refreshStatus(false);
    }
  } else {
    showToast(res.msg || '未对齐，请重试');
    if (res.pending?.captcha) {
      document.getElementById('capBgImg').src = res.pending.captcha.shadeImageUrl || res.pending.captcha.shadeImage || '';
      const cut = document.getElementById('capCutImg');
      cut.src = res.pending.captcha.cutoutImageUrl || res.pending.captcha.cutoutImage || '';
      cut.style.left = '0px';
      document.getElementById('capRangeInput').value = 0;
    }
  }
}

// 协助链接与外部协助页面
function openHelperCreateModal(payload) {
  state.currentHelpPayload = payload;
  document.getElementById('hsTitleInput').value = payload.title || (payload.mode === 'login' ? '协助添加账号' : `协助签到《${payload.courseName || ''}》`);
  document.getElementById('hsGeneratedBox').style.display = 'none';
  openModal('helperShareModal');
}

async function confirmCreateHelperLink() {
  const payload = {
    ...(state.currentHelpPayload || { mode: 'login' }),
    title: document.getElementById('hsTitleInput').value.trim(),
    broadcastToNapCat: document.getElementById('hsBroadcastCheck').checked,
  };
  const res = await api('/api/helper/create', 'POST', payload);
  if (res.ok) {
    document.getElementById('hsUrlOutput').value = res.shareUrl;
    document.getElementById('hsGeneratedBox').style.display = 'block';
    showToast('协助链接已生成');
  }
}

function scheduleAdaptiveStatusPolling(intervalMs = 5000) {
  const targetMs = Math.max(2500, Number(intervalMs || 5000));
  if (state.statusPollTimer && state.lastPollIntervalMs === targetMs) return;
  if (state.statusPollTimer) clearInterval(state.statusPollTimer);
  state.lastPollIntervalMs = targetMs;
  state.statusPollTimer = setInterval(() => {
    if (document.getElementById('adminApp')?.style.display !== 'none') {
      refreshStatus(false);
    }
  }, targetMs);
}

function adjustAdaptivePollingFromData(data) {
  const activeTab = document.querySelector('#mainModuleTabs .tab-btn.active')?.getAttribute('data-main');
  const hasBounties = Array.isArray(data?.bounties) && data.bounties.length > 0;
  const hasActives = Array.isArray(data?.lastDetectedActives) && data.lastDetectedActives.length > 0;
  if (activeTab === 'bounty' || hasBounties || hasActives) {
    scheduleAdaptiveStatusPolling(3000);
  } else {
    scheduleAdaptiveStatusPolling(5000);
  }
}

async function forceSyncBountyBoard() {
  const btn = document.getElementById('forceSyncBountyBtn');
  const tag = document.getElementById('bountySyncStatusTag');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '同步中...';
  }
  if (tag) tag.textContent = '同步中';
  try {
    await api('/api/bounties/sync', 'POST', {});
    await refreshStatus(false);
    showToast('已与学习通实时同步（已签与截止活动已剔除）');
  } catch (e) {
    showToast('同步请求完成');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '同步状态';
    }
    if (tag) tag.textContent = '实时同步';
  }
}

function renderBountyAndLeaderboard(data) {
  const bounties = Array.isArray(data.bounties) ? data.bounties : [];
  const leaderboard = Array.isArray(data.leaderboard) ? data.leaderboard : [];

  ['winBountyBadge', 'webBountyBadge', 'androidBountyBadge'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (bounties.length > 0) {
      el.style.display = 'inline-flex';
      el.textContent = String(bounties.length);
    } else {
      el.style.display = 'none';
    }
  });

  const countTag = document.getElementById('bountyActiveCountTag');
  if (countTag) countTag.textContent = `${bounties.length} 项`;
  const lbTag = document.getElementById('leaderboardCountTag');
  if (lbTag) lbTag.textContent = `${leaderboard.length} 人`;

  const bountyBox = document.getElementById('bountyBoardList');
  if (bountyBox) {
    if (bounties.length === 0) {
      setHtmlIfChanged(bountyBox, `<div class="empty" style="padding:24px 14px;">暂无未完成签到</div>`, 'empty');
    } else {
      const bountySig = JSON.stringify(
        bounties.map((b) => [
          b.token,
          b.activeId,
          b.includesMe,
          b.isMyCourse,
          b.signType,
          b.signedCount || 0,
          b.totalCount || 0,
          b.endTimeMs || 0,
          b.designatedPlace || '',
          b.locationRange || '',
          b.failReason || '',
          b.pendingNames || [],
          b.succeededNames || [],
        ])
      );
      const bountyHtml = bounties
        .map((b) => {
          const cardCls = b.includesMe
            ? 'bounty-card bounty-mine'
            : b.isMyCourse
            ? 'bounty-card bounty-my-course'
            : 'bounty-card';
          const priorityBadge = b.includesMe
            ? `<span class="tag bounty-badge-urgent">本人待签</span>`
            : b.isMyCourse
            ? `<span class="tag bounty-badge-course">同课程</span>`
            : `<span class="tag">全站互助</span>`;
          const typeLabel = SIGN_TYPE_LABELS[b.signType] || b.signType || '课堂签到';
          const statsStr = b.totalCount > 0
            ? `班级已签 ${b.signedCount || 0}/${b.totalCount} 人`
            : b.signedCount > 0
            ? `班级已签 ${b.signedCount} 人`
            : '等待现场信息';
          const remainSec = b.endTimeMs && b.endTimeMs > Date.now()
            ? Math.max(0, Math.round((b.endTimeMs - Date.now()) / 1000))
            : null;
          const remainHtml = remainSec !== null
            ? `<span class="tag js-remain-tag" data-end-ms="${Number(b.endTimeMs || 0)}" style="color:#dc2626; border-color:#fecaca;">剩余 ${remainSec >= 60 ? Math.floor(remainSec / 60) + '分' + (remainSec % 60) + '秒' : remainSec + '秒'}</span>`
            : '';
          const placeHtml = b.designatedPlace
            ? `<div style="font-size:12px; color:#b45309; margin-top:4px; font-weight:600;">要求位置：${escapeHtml(b.designatedPlace)}${b.locationRange ? `（${escapeHtml(String(b.locationRange))}m内）` : ''}</div>`
            : '';
          const reasonHtml = b.failReason
            ? `<div style="font-size:12px; color:var(--muted); margin-top:3px;">原因：${escapeHtml(b.failReason)}</div>`
            : '';
          const pendingNames = Array.isArray(b.pendingNames) ? b.pendingNames : [];
          const succeededNames = Array.isArray(b.succeededNames) ? b.succeededNames : [];
          const fullShareUrl = b.shareUrl && b.shareUrl.startsWith('http')
            ? b.shareUrl
            : `${location.origin}/?help=${encodeURIComponent(b.token)}`;

          return `
          <div class="${cardCls}">
            <div class="row" style="justify-content:space-between; align-items:flex-start; gap:8px;">
              <div>
                <div class="row" style="gap:6px; align-items:center; flex-wrap:wrap;">
                  ${priorityBadge}
                  <span class="tag solid">${escapeHtml(typeLabel)}</span>
                  ${remainHtml}
                </div>
                <div style="font-weight:700; font-size:15px; margin-top:6px;">《${escapeHtml(b.courseName || '未知课程')}》 · ${escapeHtml(b.activeName || '课堂签到')}</div>
                <div style="font-size:11px; color:var(--muted); margin-top:2px;">${escapeHtml(statsStr)} · 悬赏分值：+${pendingNames.length || 1} 分</div>
                ${placeHtml}
                ${reasonHtml}
              </div>
            </div>
            <div class="bounty-student-pills">
              ${pendingNames.map((n) => `<span class="student-pill pending">待签: ${escapeHtml(n)}</span>`).join('')}
              ${succeededNames.map((n) => `<span class="student-pill done">已签: ${escapeHtml(n)}</span>`).join('')}
            </div>
            <div class="row" style="margin-top:10px; gap:8px; flex-wrap:wrap;">
              <button type="button" class="btn btn-sm" style="flex:2; min-height:36px; font-weight:700;" onclick="openInAppBountyAssist('${escapeHtml(b.token)}', 'bounty')">帮签 (+${pendingNames.length || 1}分)</button>
              <button type="button" class="btn btn-ghost btn-sm" style="flex:1; min-height:36px;" onclick="copyTextValue('${escapeHtml(fullShareUrl)}', '链接已复制')">复制链接</button>
            </div>
          </div>`;
        })
        .join('');
      if (!setHtmlIfChanged(bountyBox, bountyHtml, bountySig)) {
        updateRemainTagsInPlace(bountyBox);
      }
    }
  }

  const lbBox = document.getElementById('masterLeaderboardList');
  if (lbBox) {
    if (leaderboard.length === 0) {
      setHtmlIfChanged(lbBox, `<div class="empty" style="padding:24px 14px;">暂无排行记录</div>`, 'empty');
    } else {
      const lbSig = JSON.stringify(
        leaderboard.map((item, idx) => [
          item.key || '',
          item.rank || idx + 1,
          item.displayName || '',
          item.cxName || '',
          item.studentId || '',
          item.school || '',
          item.avatar || '',
          Number(item.score || 0),
          item.lastCourseName || '',
          item.names || [],
        ])
      );
      const lbHtml = leaderboard
        .map((item, idx) => {
          const rank = item.rank || idx + 1;
          const rankCls = rank <= 3 ? `leaderboard-rank rank-${rank}` : 'leaderboard-rank';
          const medal = String(rank);
          const avatarHtml = item.avatar
            ? `<img src="${escapeHtml(item.avatar)}" class="leaderboard-avatar" alt="" onerror="this.style.display='none'" />`
            : `<div class="leaderboard-avatar" style="display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;">${escapeHtml((item.displayName || '侠').slice(0, 1))}</div>`;
          const aliases = Array.isArray(item.names) && item.names.length > 1
            ? `<div style="font-size:11px; color:var(--muted); margin-top:2px;">曾用称号：${item.names.map((n) => escapeHtml(n)).join(' / ')}</div>`
            : '';
          const cxMeta = [
            item.cxName ? `学习通：${item.cxName}` : '',
            item.studentId ? `学号：${item.studentId}` : '',
            item.school ? item.school : '',
          ]
            .filter(Boolean)
            .join(' · ');
          const lastDesc = item.lastCourseName ? `最近帮签：《${item.lastCourseName}》` : '';

          return `
          <div class="leaderboard-row">
            <div class="row" style="gap:10px; align-items:center; min-width:0; flex:1;">
              <span class="${rankCls}">${medal}</span>
              ${avatarHtml}
              <div style="min-width:0; flex:1;">
                <div style="font-weight:700; font-size:14px;">${escapeHtml(item.displayName || item.cxName || '热心同学')}</div>
                <div style="font-size:11px; color:var(--muted);">${escapeHtml(cxMeta || '匿名大侠')}</div>
                ${aliases}
                ${lastDesc ? `<div style="font-size:11px; color:var(--muted);">${escapeHtml(lastDesc)}</div>` : ''}
              </div>
            </div>
            <div class="leaderboard-score-box">
              <div class="leaderboard-score-num">+${Number(item.score || 0)} 分</div>
              <div style="font-size:11px; color:var(--muted);">成功帮签 ${Number(item.score || 0)} 人次</div>
            </div>
          </div>`;
        })
        .join('');
      setHtmlIfChanged(lbBox, lbHtml, lbSig);
    }
  }

  // 渲染【完成记录】（协助者、签到者、加分情况、留言及图片）
  const bountyHistory = Array.isArray(data.bountyHistory) ? data.bountyHistory : [];
  const histCountTag = document.getElementById('bountyHistoryCountTag');
  if (histCountTag) histCountTag.textContent = `${bountyHistory.length} 条`;
  const histBox = document.getElementById('bountyHistoryList');
  if (histBox) {
    if (bountyHistory.length === 0) {
      setHtmlIfChanged(histBox, `<div class="empty" style="padding:20px 14px;">暂无悬赏完成记录</div>`, 'empty');
    } else {
      const histSig = JSON.stringify(
        bountyHistory.map((h) => [
          h.id || h.claimToken || '',
          h.helperName || '',
          h.helperStudentId || '',
          h.helperAvatar || '',
          h.courseName || '',
          h.activeName || '',
          h.signedNames || [],
          Number(h.earnedPoints || 0),
          Boolean(h.pointsClaimed),
          h.commentText || '',
          h.commentImage || '',
          Number(h.timeMs || 0),
        ])
      );
      const histHtml = bountyHistory
        .map((h) => {
          const timeStr = h.timeMs ? new Date(h.timeMs).toLocaleString('zh-CN', { hour12: false }) : '';
          const avatarHtml = h.helperAvatar
            ? `<img src="${escapeHtml(resolveAssetUrl(h.helperAvatar))}" class="leaderboard-avatar" style="width:32px; height:32px;" alt="" onerror="this.style.display='none'" />`
            : '';
          const helperMeta = h.helperStudentId ? `（学号：${escapeHtml(h.helperStudentId)}）` : '';
          const signedPills = (Array.isArray(h.signedNames) ? h.signedNames : [])
            .map((n) => `<span class="student-pill done">${escapeHtml(n)}</span>`)
            .join('');
          const ptsNum = Number(h.earnedPoints || 0);
          const ptsBadge = ptsNum > 0
            ? `<span class="tag solid" style="background:#16a34a; border-color:#16a34a;">+${ptsNum} 分${h.pointsClaimed ? ' · 已入榜' : ' · 待认领'}</span>`
            : `<span class="tag">协助完成</span>`;
          const imgFullUrl = h.commentImage ? resolveAssetUrl(h.commentImage) : '';
          const hasComment = Boolean((h.commentText && h.commentText.trim()) || imgFullUrl);
          const commentHtml = hasComment
            ? `<div class="bounty-history-comment">
                 <div style="font-size:11px; color:var(--muted); margin-bottom:2px;">协助者留言：</div>
                 ${h.commentText ? `<div style="white-space:pre-wrap; word-break:break-word;">${escapeHtml(h.commentText)}</div>` : ''}
                 ${imgFullUrl ? `<div><img src="${escapeHtml(imgFullUrl)}" class="bounty-history-img" alt="留言图片" onclick="openImagePreviewModal('${escapeHtml(imgFullUrl)}')" /></div>` : ''}
               </div>`
            : '';
          return `
          <div class="bounty-history-item">
            <div class="row" style="justify-content:space-between; align-items:flex-start; gap:10px; flex-wrap:wrap;">
              <div class="row" style="gap:8px; align-items:center; min-width:0;">
                ${avatarHtml}
                <div>
                  <div class="row" style="gap:6px; flex-wrap:wrap;">
                    <span style="font-size:12px; color:var(--muted);">协助者：</span>
                    <strong style="font-size:13px;">${escapeHtml(h.helperName || '热心同学')}</strong>
                    <span style="font-size:11px; color:var(--muted);">${helperMeta}</span>
                    ${ptsBadge}
                  </div>
                  <div style="font-size:12px; color:var(--muted); margin-top:3px;">
                    课程：《${escapeHtml(h.courseName || '课程')}》 · ${escapeHtml(h.activeName || '课堂签到')}
                  </div>
                </div>
              </div>
              <span style="font-size:11px; color:var(--muted);">${escapeHtml(timeStr)}</span>
            </div>
            <div class="row" style="gap:6px; margin-top:8px; flex-wrap:wrap; align-items:center;">
              <span style="font-size:12px; color:var(--muted);">签到者：</span>
              <div class="bounty-student-pills" style="margin:0;">${signedPills || '<span class="tag">已完成</span>'}</div>
            </div>
            ${commentHtml}
          </div>`;
        })
        .join('');
      setHtmlIfChanged(histBox, histHtml, histSig);
    }
  }
}

function copyTextValue(text, toastMsg = '已复制到剪贴板') {
  try {
    if (window.IshitAndroidBridge && typeof window.IshitAndroidBridge.copyToClipboard === 'function') {
      window.IshitAndroidBridge.copyToClipboard(String(text));
      showToast(toastMsg);
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(String(text)).then(() => showToast(toastMsg)).catch(() => {});
      return;
    }
  } catch (_) {}
  const ta = document.createElement('textarea');
  ta.value = String(text);
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
  showToast(toastMsg);
}

function playSignAlertSound(eventType = 'sign_detected') {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const notes =
      eventType === 'sign_success'
        ? [523.25, 659.25, 783.99]
        : eventType === 'sign_failed'
        ? [880, 440, 880]
        : [587.33, 880];
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = eventType === 'sign_failed' ? 'sawtooth' : 'sine';
      osc.frequency.setValueAtTime(freq, now + idx * 0.13);
      gain.gain.setValueAtTime(0.14, now + idx * 0.13);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.13 + 0.12);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + idx * 0.13);
      osc.stop(now + idx * 0.13 + 0.125);
    });
  } catch (_) {}
}

function updateNotifyPermButtonText() {
  const btn = document.getElementById('notifyPermBtn');
  if (!btn) return;
  const plat = detectPlatformType();
  if (plat === 'android') {
    let batteryExempt = true;
    if (window.IshitAndroidBridge && typeof window.IshitAndroidBridge.isIgnoringBatteryOptimizations === 'function') {
      try {
        batteryExempt = Boolean(window.IshitAndroidBridge.isIgnoringBatteryOptimizations());
      } catch (_) {}
    }
    btn.textContent = batteryExempt ? '后台常驻已开启' : '开启后台保活通知';
    return;
  }
  if (plat === 'windows') {
    btn.textContent = '通知已开启';
    return;
  }
  if (!('Notification' in window)) {
    btn.textContent = '横幅提醒已开启';
    return;
  }
  if (Notification.permission === 'granted') {
    btn.textContent = '通知已开启';
  } else if (Notification.permission === 'denied') {
    btn.textContent = '已启用横幅提醒';
  } else {
    btn.textContent = '开启通知';
  }
}

async function requestCrossPlatformNotificationPermission() {
  const plat = detectPlatformType();
  if (plat === 'android' && window.IshitAndroidBridge) {
    try {
      if (typeof window.IshitAndroidBridge.requestNotifyPermission === 'function') {
        window.IshitAndroidBridge.requestNotifyPermission();
      }
      syncAndroidNativeDaemonState();
      if (
        typeof window.IshitAndroidBridge.isIgnoringBatteryOptimizations === 'function' &&
        !window.IshitAndroidBridge.isIgnoringBatteryOptimizations() &&
        typeof window.IshitAndroidBridge.requestIgnoreBatteryOptimizations === 'function'
      ) {
        window.IshitAndroidBridge.requestIgnoreBatteryOptimizations();
        showToast('请允许“忽略电池优化/无限制后台”，确保锁屏与划掉卡片后仍能秒推');
      } else {
        showToast('Android 后台常驻签到守护已激活');
        testCrossPlatformNotification();
      }
      setTimeout(updateNotifyPermButtonText, 1200);
    } catch (_) {}
    return;
  }
  if ('Notification' in window && Notification.permission !== 'granted') {
    try {
      const perm = await Notification.requestPermission();
      updateNotifyPermButtonText();
      if (perm === 'granted') {
        showToast('系统级签到通知已开启！');
        testCrossPlatformNotification();
      } else {
        showToast('将使用顶部强提醒横幅与提示音通知您');
      }
      return;
    } catch (_) {}
  }
  updateNotifyPermButtonText();
  testCrossPlatformNotification();
}

function testCrossPlatformNotification() {
  const sampleAlert = {
    id: 'test_' + Date.now(),
    eventType: 'sign_detected',
    title: '通知测试：签到提醒已就绪',
    body: '发现签到、签到成功或签到失败时将推送通知。',
    courseName: '测试课程',
    activeName: '通知通路自检',
    helperToken: state.status?.bounties?.[0]?.token || '',
    timeMs: Date.now(),
  };
  dispatchCrossPlatformSignAlert(sampleAlert);
}

function processRealtimeSignAlerts(data) {
  const alerts = Array.isArray(data.recentAlerts) ? data.recentAlerts : [];
  const nowMs = Date.now();

  if (!state.initialAlertsSeeded) {
    state.initialAlertsSeeded = true;
    let latestUrgent = null;
    for (const al of alerts) {
      if (!al || !al.id) continue;
      state.seenAlertIds.add(String(al.id));
      if (
        !latestUrgent &&
        nowMs - Number(al.timeMs || 0) <= 60 * 1000 &&
        (al.eventType === 'sign_failed' || al.eventType === 'sign_detected')
      ) {
        latestUrgent = al;
      }
    }
    if (latestUrgent) {
      showLiveSignAlertBanner(latestUrgent);
    }
    return;
  }

  const freshAlerts = alerts
    .filter((al) => al && al.id && !state.seenAlertIds.has(String(al.id)))
    .sort((a, b) => Number(a.timeMs || 0) - Number(b.timeMs || 0));

  for (const al of freshAlerts) {
    state.seenAlertIds.add(String(al.id));
    dispatchCrossPlatformSignAlert(al);
  }
}

function dispatchCrossPlatformSignAlert(alertObj) {
  if (!alertObj) return;
  showLiveSignAlertBanner(alertObj);
  playSignAlertSound(alertObj.eventType);

  const title = alertObj.title || 'ISHIT 签到提醒';
  const body = alertObj.body || `《${alertObj.courseName || '课程'}》${alertObj.activeName || '签到'}`;
  const payloadJson = JSON.stringify({
    alertId: String(alertObj.id || ''),
    eventType: alertObj.eventType || 'sign_detected',
    helperToken: alertObj.helperToken || '',
    activeId: alertObj.activeId || '',
    courseId: alertObj.courseId || '',
    classId: alertObj.classId || '',
    courseName: alertObj.courseName || '',
  });

  if (detectPlatformType() === 'windows') {
    sendWinHostCmd('win:notify:' + JSON.stringify({ title, body, payload: payloadJson }));
  }

  if (window.IshitAndroidBridge && typeof window.IshitAndroidBridge.showNotification === 'function') {
    try {
      window.IshitAndroidBridge.showNotification(String(title), String(body), payloadJson);
    } catch (_) {}
  }

  if (detectPlatformType() === 'web' && 'Notification' in window && Notification.permission === 'granted') {
    try {
      const n = new Notification(title, {
        body,
        icon: 'favicon.png?v=8',
        tag: String(alertObj.id || Date.now()),
      });
      n.onclick = () => {
        try { window.focus(); } catch (_) {}
        n.close();
        handleAlertDirectJump(alertObj);
      };
    } catch (_) {}
  }
}

function showLiveSignAlertBanner(alertObj) {
  state.currentLiveAlert = alertObj;
  const banner = document.getElementById('liveSignAlertBanner');
  const badge = document.getElementById('liveSignAlertBadge');
  const titleEl = document.getElementById('liveSignAlertTitle');
  const descEl = document.getElementById('liveSignAlertDesc');
  const btn = document.getElementById('liveSignAlertActionBtn');
  if (!banner) return;

  banner.classList.remove('alert-failed', 'alert-success', 'alert-detected');
  if (alertObj.eventType === 'sign_failed') {
    banner.classList.add('alert-failed');
    if (badge) badge.textContent = '签到未通过';
    if (btn) btn.textContent = alertObj.helperToken ? '前往处理' : '查看悬赏';
  } else if (alertObj.eventType === 'sign_success') {
    banner.classList.add('alert-success');
    if (badge) badge.textContent = '签到成功';
    if (btn) btn.textContent = '查看签到记录';
  } else {
    banner.classList.add('alert-detected');
    if (badge) badge.textContent = '发现签到';
    if (btn) btn.textContent = alertObj.helperToken ? '前往签到' : '查看详情';
  }

  if (titleEl) titleEl.textContent = alertObj.title || `《${alertObj.courseName || '课程'}》${alertObj.activeName || '签到'}`;
  if (descEl) descEl.textContent = alertObj.body || '';
  banner.style.display = 'flex';

  clearTimeout(banner._autoHideTimer);
  const holdMs = alertObj.eventType === 'sign_success' ? 12000 : 28000;
  banner._autoHideTimer = setTimeout(() => {
    banner.style.display = 'none';
  }, holdMs);
}

function dismissLiveSignAlert() {
  const banner = document.getElementById('liveSignAlertBanner');
  if (banner) banner.style.display = 'none';
}

function onClickLiveSignAlertAction() {
  const al = state.currentLiveAlert;
  dismissLiveSignAlert();
  if (al) handleAlertDirectJump(al);
}

function handleAlertDirectJump(alertObj) {
  if (!alertObj) return;
  if (alertObj.eventType === 'sign_success') {
    if (document.getElementById('helperApp')?.style.display !== 'none' && state.inAppHelperReturn) {
      exitInAppHelperMode('global');
    } else {
      switchMainModule('global');
    }
    const histEl = document.getElementById('historyList');
    if (histEl) histEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  if (alertObj.helperToken) {
    openInAppBountyAssist(alertObj.helperToken, 'bounty');
    return;
  }

  const matchBounty = (state.status?.bounties || []).find(
    (b) => String(b.activeId) === String(alertObj.activeId)
  );
  if (matchBounty && matchBounty.token) {
    openInAppBountyAssist(matchBounty.token, 'bounty');
    return;
  }

  switchMainModule('bounty');
}

window.onNativeNotificationClick = function (rawPayload) {
  try {
    const parsed = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload;
    if (parsed) handleAlertDirectJump(parsed);
  } catch (_) {
    switchMainModule('bounty');
  }
};

function openInAppBountyAssist(token, returnModule = 'bounty') {
  if (!token) return;
  state.inAppHelperReturn = true;
  state.inAppReturnModule = returnModule || 'bounty';
  state.helperToken = token;
  initHelperMode(token);
}

function exitInAppHelperMode(targetMod = null) {
  stopCameraQrScanner();
  document.getElementById('helperApp').style.display = 'none';
  document.getElementById('adminApp').style.display = '';
  const dest = targetMod || state.inAppReturnModule || 'bounty';
  state.inAppHelperReturn = false;
  switchMainModule(dest);
  refreshStatus(false);
}

async function initHelperMode(token) {
  state.helperToken = token;
  document.getElementById('adminApp').style.display = 'none';
  document.getElementById('panelLoginApp').style.display = 'none';
  document.getElementById('helperApp').style.display = 'block';

  const backBtn = document.getElementById('helpBackToAdminBtn');
  if (backBtn) {
    backBtn.style.display = state.inAppHelperReturn ? 'inline-flex' : 'none';
  }

  const resBox = document.getElementById('helpResultBox');
  if (resBox) resBox.innerHTML = '';
  const codeEl = document.getElementById('helpSignCode');
  if (codeEl) codeEl.value = '';
  const qrEl = document.getElementById('helpQrUrl');
  if (qrEl) qrEl.value = '';

  const res = await api(`/api/helper/info?token=${encodeURIComponent(token)}`);
  if (!res.ok) {
    document.getElementById('helpTitle').textContent = res.msg || '该签到已完成或协助链接已失效';
    document.getElementById('helpSignBox').style.display = 'none';
    if (resBox) {
      resBox.innerHTML = `<div class="empty">${escapeHtml(res.msg || '该签到已全部完成或已截止')}</div>`;
    }
    return;
  }

  state.helperSession = res.session;
  state.helperLoggedIn = Boolean(res.helperLoggedIn);
  state.helperPrimaryAccount = res.helperPrimaryAccount || null;
  if (!state.status) state.status = {};
  state.status.locationPresets = res.locationPresets || [];

  document.getElementById('helpTitle').textContent = res.session.title || '课堂签到互助';

  const idBanner = document.getElementById('helpIdentityBanner');
  if (idBanner) {
    if (res.helperPrimaryAccount) {
      const p = res.helperPrimaryAccount;
      idBanner.innerHTML = `当前辅助账号：<strong>${escapeHtml(p.name)}</strong>${p.studentId ? `（${escapeHtml(p.studentId)}）` : ''}，签到成功后可修改名称并计分。`;
    } else {
      idBanner.innerHTML = `按成功帮签人数计分，签到成功后将弹窗填写辅助人名称与学号。`;
    }
  }

  if (res.session.mode === 'login') {
    document.getElementById('helpLoginBox').style.display = 'block';
    document.getElementById('helpCaptchaBox').style.display = 'none';
    document.getElementById('helpSignBox').style.display = 'none';
    document.getElementById('helpLoginMount').appendChild(document.getElementById('adminLoginPanel'));
  } else if (res.session.mode === 'captcha' && res.pendingCaptcha) {
    document.getElementById('helpCaptchaBox').style.display = 'block';
    document.getElementById('helpLoginBox').style.display = 'none';
    document.getElementById('helpSignBox').style.display = 'none';
    state.currentCaptchaKey = res.session.captchaKey;
    document.getElementById('helpCaptchaMount').appendChild(document.getElementById('captchaContainer'));
    await loadCaptchaStage(state.currentCaptchaKey);
  } else {
    document.getElementById('helpLoginBox').style.display = 'none';
    document.getElementById('helpCaptchaBox').style.display = 'none';
    document.getElementById('helpSignBox').style.display = 'block';

    const sType = res.session.signType || 'normal';
    document.getElementById('helpCourseName').textContent = res.session.courseName || '课程签到';
    document.getElementById('helpActiveName').textContent = res.session.activeName || '签到活动';
    document.getElementById('helpSignType').textContent = SIGN_TYPE_LABELS[sType] || sType;

    renderHelperTargetStatusStrip(res.session);

    const applyHelpSections = (type, needLoc, place, range) => {
      const isCode = type === 'code';
      const isPattern = type === 'pattern';
      const isQr = type === 'qrCode';
      const isLoc = type === 'location' || Boolean(needLoc);
      document.getElementById('helpSectionCode').style.display = isCode || isPattern ? 'block' : 'none';
      document.getElementById('helpPatternWrap').style.display = isPattern ? 'block' : 'none';
      document.getElementById('helpCodeLabel').textContent = isPattern
        ? '手势签到（点击九宫格或输入数字序列）'
        : '签到码';
      document.getElementById('helpSectionQr').style.display = isQr ? 'block' : 'none';
      document.getElementById('helpSectionLocation').style.display = isLoc ? 'block' : 'none';
      const locLbl = document.getElementById('helpLocationLabel');
      if (locLbl) {
        locLbl.textContent = place
          ? `签到位置（要求：${place}${range ? ` · ${range}m内` : ''}）`
          : '签到位置';
      }
      const quickBtn = document.getElementById('helpQuickReqLocBtn');
      if (quickBtn) {
        const reqLoc = state.helperRequiredLocation;
        const hasReq = Boolean(place || (reqLoc && reqLoc.latitude && reqLoc.longitude));
        quickBtn.style.display = isLoc && hasReq ? 'inline-flex' : 'none';
      }
    };

    const hasPendingStudents = (sess) => {
      if (!sess || sess.completed) return false;
      const pList = Array.isArray(sess.pendingNames) ? sess.pendingNames : Array.isArray(sess.targetNames) ? sess.targetNames : [];
      return pList.length > 0;
    };

    applyHelpSections(sType, sType === 'location', res.session.designatedPlace || '', res.session.locationRange || '');
    if (sType === 'qrCode' && hasPendingStudents(res.session)) {
      startCameraQrScanner('help', { auto: true, retryFailedOnly: false });
    }
    if (res.session.activeId) {
      try {
        const info = await api(
          `/api/courses/activeInfo?activeId=${encodeURIComponent(res.session.activeId)}&courseId=${encodeURIComponent(res.session.courseId || '')}&classId=${encodeURIComponent(res.session.classId || '')}&helperToken=${encodeURIComponent(token)}`
        );
        if (info.ok) {
          const finalType = info.signType || sType;
          if (state.helperSession) state.helperSession.signType = finalType;
          state.helperRequiredLocation = {
            designatedPlace: info.designatedPlace || '',
            locationRange: info.locationRange || '',
            latitude: info.requiredLatitude || null,
            longitude: info.requiredLongitude || null,
          };
          const statEl = document.getElementById('helpAttendStatsText');
          if (statEl) {
            statEl.textContent = formatAttendStatsBanner(info.signedCount, info.totalCount);
          }
          applyHelpSections(finalType, info.needLocation, info.designatedPlace, info.locationRange);
          if (finalType === 'qrCode' && hasPendingStudents(state.helperSession)) {
            startCameraQrScanner('help', { auto: true, retryFailedOnly: false });
          } else if (finalType && finalType !== 'qrCode') {
            stopCameraQrScanner();
          }
          if (info.needLocation && (info.requiredLatitude || info.designatedPlace)) {
            const latEl = document.getElementById('helpLat');
            const lngEl = document.getElementById('helpLng');
            const addrEl = document.getElementById('helpAddress');
            if (latEl && !latEl.value && info.requiredLatitude) latEl.value = info.requiredLatitude;
            if (lngEl && !lngEl.value && info.requiredLongitude) lngEl.value = info.requiredLongitude;
            if (addrEl && !addrEl.value && info.designatedPlace) addrEl.value = info.designatedPlace;
          }
        }
      } catch (_) {}
    }
  }
}

function renderHelperTargetStatusStrip(sess) {
  const strip = document.getElementById('helpTargetStatusStrip');
  if (!strip || !sess) return;
  const pendingNames = Array.isArray(sess.pendingNames)
    ? sess.pendingNames
    : Array.isArray(sess.targetNames)
    ? sess.targetNames
    : [];
  const succeededNames = Array.isArray(sess.succeededNames) ? sess.succeededNames : [];

  strip.innerHTML = `
    <div class="bounty-student-pills">
      ${pendingNames.map((n) => `<span class="student-pill pending">待签: ${escapeHtml(n)}</span>`).join('')}
      ${succeededNames.map((n) => `<span class="student-pill done">已签: ${escapeHtml(n)}</span>`).join('')}
    </div>
  `;
}

async function submitHelperSign(retryFailedOnly = false) {
  const isQrMode =
    state.helperSession?.signType === 'qrCode' ||
    document.getElementById('helpSectionQr')?.style.display !== 'none';
  if (!isQrMode) {
    stopCameraQrScanner();
  } else {
    _camSubmitting = true;
    setHelpCamOverlayTip('已捕获二维码，正在提交签到...');
  }

  const submitBtn = document.getElementById('helpMainSubmitBtn');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = '提交中...';
  }
  const box = document.getElementById('helpResultBox');
  if (box) {
    box.innerHTML = `<div class="helper-battle-report">正在提交签到，请稍候...</div>`;
  }

  let shouldKeepQrCamOpen = false;
  let nextRetryFailedOnly = Boolean(retryFailedOnly);
  let remainingCountForCam = 0;

  try {
    const savedName = localStorage.getItem('ishit_helper_name') || state.helperPrimaryAccount?.name || '热心同学';
    const res = await api('/api/helper/submit', 'POST', {
      token: state.helperToken,
      retryFailedOnly: Boolean(retryFailedOnly),
      helperName: savedName,
      signCode: document.getElementById('helpSignCode')?.value.trim() || null,
      qrUrl: document.getElementById('helpQrUrl')?.value.trim() || null,
      address: document.getElementById('helpAddress')?.value.trim() || null,
      latitude: document.getElementById('helpLat')?.value.trim(),
      longitude: document.getElementById('helpLng')?.value.trim(),
    });

    if (!res.ok || !res.record) {
      if (box) {
        box.innerHTML = `<div class="helper-battle-report report-fail"><strong>提交失败：</strong>${escapeHtml(res.msg || '请检查签到信息后重试')}</div>`;
      }
      if (isQrMode) {
        shouldKeepQrCamOpen = true;
      }
      showToast(res.msg || '提交失败');
      return;
    }

    if (res.session) {
      state.helperSession = res.session;
      renderHelperTargetStatusStrip(res.session);
    }

    const results = res.record.results || [];
    const okList = results.filter((r) => r.ok);
    const failList = results.filter((r) => !r.ok);
    const remainingNames = Array.isArray(res.remainingNames) ? res.remainingNames : failList.map((r) => r.name);
    const allDone = remainingNames.length === 0 && (okList.length > 0 || (res.allSucceededNames || []).length > 0);

    if (isQrMode) {
      if (allDone) {
        shouldKeepQrCamOpen = false;
        stopCameraQrScanner();
      } else {
        shouldKeepQrCamOpen = true;
        remainingCountForCam = remainingNames.length;
        nextRetryFailedOnly = okList.length > 0 || (res.allSucceededNames || []).length > 0;
      }
    }

    let reportCls = 'helper-battle-report report-fail';
    let headline = '暂未签上，请核对签到信息后重试';
    if (allDone) {
      reportCls = 'helper-battle-report report-all-ok';
      headline = `全部签到成功（共 ${(res.allSucceededNames || okList).length} 人）`;
      playSignAlertSound('sign_success');
    } else if (okList.length > 0) {
      reportCls = 'helper-battle-report report-partial';
      headline = `部分已签上（成功 ${okList.length} 人，未签 ${remainingNames.length} 人）`;
      playSignAlertSound('sign_detected');
    } else {
      playSignAlertSound('sign_failed');
    }

    const rowsHtml = results
      .map((r) => {
        const icon = r.ok ? '[已签]' : '[未签]';
        const pillCls = r.ok ? 'student-pill done' : 'student-pill pending';
        return `
        <div class="list-row" style="padding:7px 0;">
          <span style="font-weight:700;">${icon} ${escapeHtml(r.name)}</span>
          <span class="${pillCls}">${escapeHtml(r.msg || (r.ok ? '签到成功' : '未签上，需重试'))}</span>
        </div>`;
      })
      .join('');

    const retryBtnHtml =
      remainingNames.length > 0
        ? `<button type="button" class="btn helper-giant-btn" style="width:100%; margin-top:10px; background:#dc2626; border-color:#dc2626;" onclick="submitHelperSign(true)">重试未签账号（${remainingNames.map((n) => escapeHtml(n)).join(' / ')}）</button>`
        : '';

    const isHelperLogged = Boolean(res.helperLoggedIn || state.helperLoggedIn);
    const lockedName = res.lockedHelperInfo?.name || res.creditedEntry?.displayName || state.helperPrimaryAccount?.name || '';
    const lockedSid = res.lockedHelperInfo?.studentId || res.creditedEntry?.studentId || state.helperPrimaryAccount?.studentId || '';

    let pointsCardHtml = '';
    if (allDone && res.claimToken && (Number(res.earnedPoints || 0) > 0 || okList.length > 0 || (res.allSucceededNames || []).length > 0)) {
      if (isHelperLogged) {
        pointsCardHtml = `
        <div class="helper-claim-card" id="helperClaimCardBox" style="background:#f0fdf4; border-color:#86efac;">
          <div class="row" style="justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
            <div>
              <div style="font-weight:700; color:#166534;">${Number(res.earnedPoints || 0) > 0 ? `全部同学已安全签上 · 积分 +${res.earnedPoints} 已归入你的账号` : '全部同学已安全签上'}</div>
              <div style="font-size:12px; color:#15803d; margin-top:3px;">
                已锁定辅助人：<strong>${escapeHtml(lockedName || '当前登录账号')}</strong>${lockedSid ? `（学号：${escapeHtml(lockedSid)}）` : ''}${res.creditedEntry?.score !== undefined ? ` · 总分：<strong>${res.creditedEntry.score} 分</strong>` : ''}
              </div>
            </div>
            <button type="button" class="btn btn-sm" onclick="openHelperClaimModal('${escapeHtml(res.claimToken)}', ${Number(res.earnedPoints || 0)}, true, '${escapeHtml(lockedName)}', '${escapeHtml(lockedSid)}', true)">写留言 / 传图</button>
          </div>
        </div>`;
      } else {
        pointsCardHtml = `
        <div class="helper-claim-card" id="helperClaimCardBox">
          <div class="row" style="justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
            <div>
              <div style="font-weight:700; font-size:13px;">${Number(res.earnedPoints || 0) > 0 ? `全部同学已安全签上 · 累计帮签 +${res.earnedPoints} 人` : '全部同学已安全签上'}</div>
              <div style="font-size:11px; color:var(--muted); margin-top:2px;">填写名称与学号计入排行榜，并可附带留言与图片</div>
            </div>
            <button type="button" class="btn btn-sm" onclick="openHelperClaimModal('${escapeHtml(res.claimToken)}', ${Number(res.earnedPoints || 0)}, false, '', '', false)">填写名称与留言${Number(res.earnedPoints || 0) > 0 ? ` (+${res.earnedPoints}分)` : ''}</button>
          </div>
        </div>`;
      }
    } else if (!allDone && remainingNames.length > 0 && (okList.length > 0 || Number(res.pendingPoints || 0) > 0)) {
      const pendingPts = Number(res.pendingPoints || okList.length || 0);
      pointsCardHtml = `
      <div class="helper-claim-card" style="background:#fffbeb; border-color:#fde68a;">
        <div style="font-weight:700; font-size:12px; color:#b45309;">
          已暂存帮签进度（累计 ${pendingPts} 人）· 还有 ${remainingNames.length} 名同学未签上，请先点击上方按钮重试，确保全部同学安全后再统一弹出加分与留言
        </div>
      </div>`;
    }

    if (box) {
      box.innerHTML = `
      <div class="${reportCls}">
        <div style="font-weight:800; font-size:15px; margin-bottom:8px;">${headline}</div>
        <div>${rowsHtml}</div>
        ${retryBtnHtml}
        ${pointsCardHtml}
      </div>`;
    }
    showToast(allDone ? '全部签到成功' : remainingNames.length > 0 ? `还有 ${remainingNames.length} 名同学未签上，请先重试确保全员安全` : '提交完成');

    // 仅当全部同学安全签上（allDone === true）时，才弹出签后加分与留言窗口
    if (allDone && res.claimToken && (Number(res.earnedPoints || 0) > 0 || okList.length > 0 || (res.allSucceededNames || []).length > 0)) {
      openHelperClaimModal(
        res.claimToken,
        Number(res.earnedPoints || 0),
        Boolean(res.autoCredited),
        lockedName,
        lockedSid,
        isHelperLogged
      );
    }
  } finally {
    _camSubmitting = false;
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = '提交签到';
    }
    if (shouldKeepQrCamOpen && isQrMode) {
      const tipText =
        remainingCountForCam > 0
          ? `还有 ${remainingCountForCam} 名同学未签上，相机已就绪，请对准最新二维码自动继续扫码`
          : '暂未全部签上，相机保持开启，请对准课堂二维码继续扫码重试';
      await startCameraQrScanner('help', {
        auto: true,
        retryFailedOnly: nextRetryFailedOnly,
        cooldownMs: 1200,
        tipText,
      });
    }
  }
}

function clearClaimCommentImage() {
  state.claimCommentImageUrl = '';
  state.claimCommentUploading = false;
  const inp = document.getElementById('claimCommentImageInput');
  if (inp) inp.value = '';
  const wrap = document.getElementById('claimCommentImagePreviewWrap');
  if (wrap) wrap.style.display = 'none';
  const img = document.getElementById('claimCommentImagePreview');
  if (img) img.src = '';
}

async function compressAndUploadClaimImageFile(file) {
  if (!file) return;
  const statusEl = document.getElementById('claimCommentImageStatus');
  const wrap = document.getElementById('claimCommentImagePreviewWrap');
  const previewImg = document.getElementById('claimCommentImagePreview');
  state.claimCommentUploading = true;
  if (wrap) wrap.style.display = 'flex';
  if (statusEl) statusEl.textContent = '正在压缩并上传图片...';

  try {
    const imgEl = await loadFileAsImageElement(file);
    const srcW = imgEl.naturalWidth || imgEl.width || 800;
    const srcH = imgEl.naturalHeight || imgEl.height || 600;
    const maxSide = 1280;
    const scale = Math.max(srcW, srcH) > maxSide ? maxSide / Math.max(srcW, srcH) : 1;
    const dstW = Math.max(32, Math.round(srcW * scale));
    const dstH = Math.max(32, Math.round(srcH * scale));
    const canvas = document.createElement('canvas');
    canvas.width = dstW;
    canvas.height = dstH;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, dstW, dstH);
    ctx.drawImage(imgEl, 0, 0, dstW, dstH);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.86);
    if (previewImg) previewImg.src = dataUrl;

    const res = await api('/api/helper/uploadImage', 'POST', { base64Image: dataUrl });
    if (res.ok && res.imageUrl) {
      state.claimCommentImageUrl = res.imageUrl;
      if (previewImg) previewImg.src = resolveAssetUrl(res.imageUrl);
      if (statusEl) statusEl.textContent = '图片上传完成';
    } else {
      clearClaimCommentImage();
      showToast(res.msg || '图片上传失败');
    }
  } catch (e) {
    clearClaimCommentImage();
    showToast('图片处理失败，请重试');
  } finally {
    state.claimCommentUploading = false;
  }
}

function onSelectClaimCommentImage(input) {
  const file = input?.files?.[0];
  if (!file) return;
  compressAndUploadClaimImageFile(file);
}

function bindClaimCommentPasteOnce() {
  const ta = document.getElementById('claimModalCommentText');
  if (!ta || ta._pasteBound) return;
  ta._pasteBound = true;
  ta.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items || [];
    for (const it of items) {
      if (it.type && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) {
          e.preventDefault();
          compressAndUploadClaimImageFile(f);
          break;
        }
      }
    }
  });
}

function openHelperClaimModal(claimToken, earnedPoints = 1, isAutoCredited = false, defaultName = '', defaultSid = '', isLoggedInHelper = false) {
  state._claimModalIsLogged = Boolean(isLoggedInHelper);
  const tokenEl = document.getElementById('claimModalTokenInput');
  const titleEl = document.getElementById('claimModalTitle');
  const sumEl = document.getElementById('claimModalSummaryText');
  const lockedBanner = document.getElementById('claimLockedIdentityBanner');
  const gridEl = document.getElementById('claimPostGrid');
  const idCol = document.getElementById('claimIdentityCol');
  const dialogEl = document.getElementById('helperClaimDialog');
  const nameEl = document.getElementById('claimModalHelperName');
  const sidEl = document.getElementById('claimModalStudentId');
  const cmtEl = document.getElementById('claimModalCommentText');

  if (tokenEl) tokenEl.value = claimToken || '';
  if (cmtEl) cmtEl.value = '';
  clearClaimCommentImage();
  bindClaimCommentPasteOnce();

  if (isLoggedInHelper) {
    // 已登录：填名区域默认锁定为自己，只显示留言区域
    if (titleEl) titleEl.textContent = '协助完成 · 留言互动';
    if (sumEl) {
      sumEl.textContent = earnedPoints > 0
        ? `成功帮签 +${earnedPoints} 人，积分已自动归入你的账号`
        : '协助签到已完成';
    }
    if (lockedBanner) {
      lockedBanner.style.display = 'block';
      lockedBanner.innerHTML = `辅助人已默认锁定为自己：<strong>${escapeHtml(defaultName || '当前账号')}</strong>${defaultSid ? `（学号：${escapeHtml(defaultSid)}）` : ''}`;
    }
    if (idCol) idCol.style.display = 'none';
    if (gridEl) gridEl.classList.add('single-col');
    if (dialogEl) dialogEl.style.maxWidth = '460px';
    if (nameEl) nameEl.value = defaultName || '';
    if (sidEl) sidEl.value = defaultSid || '';
  } else {
    // 未登录：左侧填名区域 + 右侧留言区域并排展示
    if (titleEl) titleEl.textContent = '签到完成 · 填写名称与留言';
    if (sumEl) {
      sumEl.textContent = earnedPoints > 0
        ? `成功帮签 +${earnedPoints} 人，可填写名称与学号计入排行榜，并在右侧留言：`
        : '协助签到已完成，可填写名称并在右侧留言：';
    }
    if (lockedBanner) lockedBanner.style.display = 'none';
    if (idCol) idCol.style.display = 'block';
    if (gridEl) gridEl.classList.remove('single-col');
    if (dialogEl) dialogEl.style.maxWidth = '650px';
    const savedName = localStorage.getItem('ishit_helper_name') || defaultName || '';
    const savedSid = defaultSid || localStorage.getItem('ishit_helper_sid') || '';
    if (nameEl) nameEl.value = savedName;
    if (sidEl) {
      sidEl.value = savedSid;
      sidEl.readOnly = false;
    }
  }

  openModal('helperClaimModal');
  setTimeout(() => {
    if (isLoggedInHelper) {
      if (cmtEl) cmtEl.focus();
    } else if (nameEl) {
      nameEl.focus();
    }
  }, 60);
}

async function submitHelperPointClaim(explicitToken) {
  if (state.claimCommentUploading) {
    showToast('图片正在上传中，请稍候...');
    return;
  }
  const isLogged = Boolean(state._claimModalIsLogged);
  const claimToken = explicitToken || document.getElementById('claimModalTokenInput')?.value.trim() || '';
  const helperName = document.getElementById('claimModalHelperName')?.value.trim() || '';
  const studentId = document.getElementById('claimModalStudentId')?.value.trim() || '';
  const commentText = document.getElementById('claimModalCommentText')?.value.trim() || '';
  const commentImage = state.claimCommentImageUrl || '';

  if (isLogged && !commentText && !commentImage) {
    closeModal('helperClaimModal');
    showToast('积分已自动归入你的账号');
    return;
  }

  if (!isLogged && !studentId && !commentText && !commentImage && !helperName) {
    showToast('请填写学号认领积分，或输入留言内容');
    return;
  }

  if (!isLogged) {
    if (helperName) localStorage.setItem('ishit_helper_name', helperName);
    if (studentId) localStorage.setItem('ishit_helper_sid', studentId);
  }

  const btn = document.getElementById('claimModalSubmitBtn');
  if (btn) btn.disabled = true;
  try {
    const res = await api('/api/helper/claim', 'POST', {
      claimToken,
      helperName: helperName || '热心同学',
      studentId,
      commentText,
      commentImage,
    });
    const card = document.getElementById('helperClaimCardBox');
    if (res.ok) {
      closeModal('helperClaimModal');
      if (card) {
        card.style.background = '#f0fdf4';
        card.style.borderColor = '#86efac';
        const cmtDone = commentText || commentImage ? ' · 留言已发布至完成记录' : '';
        if (res.entry) {
          card.innerHTML = `
            <div style="font-weight:700; color:#166534;">已同步至签到大师榜${escapeHtml(cmtDone)}</div>
            <div style="font-size:12px; color:#15803d; margin-top:3px;">
              辅助人：<strong>${escapeHtml(res.entry.displayName)}</strong> · 学号：<strong>${escapeHtml(res.entry.studentId)}</strong> · 累计总分：<strong>${res.entry.score} 分</strong>
            </div>`;
        } else {
          card.innerHTML = `<div style="font-weight:700; color:#166534;">协助留言已发布至悬赏完成记录</div>`;
        }
      }
      if (state.status && Array.isArray(res.bountyHistory)) {
        state.status.bountyHistory = res.bountyHistory;
        if (Array.isArray(res.leaderboard)) state.status.leaderboard = res.leaderboard;
        renderBountyAndLeaderboard(state.status);
      }
      showToast(res.commentSavedOnly ? '留言已发布至完成记录' : '提交成功，已同步排行榜与完成记录');
    } else {
      showToast(res.msg || '提交失败');
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ============================================================================
// 实时相机扫码 & 本地图片二维码解析（支持 jsQR + BarcodeDetector 双引擎）
// ============================================================================
let _camStream = null;
let _camScanRaf = null;
let _camActiveMode = null;
let _camSubmitting = false;
let _camScanPausedUntil = 0;
let _camRetryFailedOnly = false;

function setHelpCamOverlayTip(text) {
  const tipEl = document.getElementById('helpCamOverlayTip');
  if (tipEl && text) tipEl.textContent = text;
}

function setHelpCamFallbackTip(text) {
  const el = document.getElementById('helpCamFallbackTip');
  if (!el) return;
  if (text) {
    el.textContent = text;
    el.style.display = 'block';
  } else {
    el.textContent = '';
    el.style.display = 'none';
  }
}

function stopCameraQrScanner() {
  if (_camScanRaf) {
    cancelAnimationFrame(_camScanRaf);
    _camScanRaf = null;
  }
  if (_camStream) {
    try {
      _camStream.getTracks().forEach((t) => t.stop());
    } catch (_) {}
    _camStream = null;
  }
  ['manual', 'help'].forEach((prefix) => {
    const stage = document.getElementById(`${prefix}CamStage`);
    const video = document.getElementById(`${prefix}CamVideo`);
    const btn = document.getElementById(`${prefix}CamBtn`);
    if (stage) stage.style.display = 'none';
    if (video) video.srcObject = null;
    if (btn) btn.textContent = '打开相机扫码';
  });
  _camActiveMode = null;
  _camSubmitting = false;
  _camScanPausedUntil = 0;
  _camRetryFailedOnly = false;
}

async function openCameraStreamWithFallback() {
  const constraintsList = [
    { video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
    { video: { facingMode: "environment" }, audio: false },
    { video: true, audio: false },
  ];
  let lastErr = null;
  for (const c of constraintsList) {
    try {
      return await navigator.mediaDevices.getUserMedia(c);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Camera access failed");
}

async function startCameraQrScanner(prefix = "manual", opts = {}) {
  const isAuto = Boolean(opts.auto);
  if (opts.retryFailedOnly !== undefined) {
    _camRetryFailedOnly = Boolean(opts.retryFailedOnly);
  }
  if (opts.cooldownMs && Number(opts.cooldownMs) > 0) {
    _camScanPausedUntil = Date.now() + Number(opts.cooldownMs);
  }
  if (prefix === "help") {
    setHelpCamFallbackTip('');
    setHelpCamOverlayTip(
      opts.tipText ||
        (_camRetryFailedOnly
          ? '还有同学未签上：请将最新二维码对准画面，自动重试未签账号'
          : '相机常驻扫码中：将二维码对准画面，识别后立即自动提交签到')
    );
  }

  const stage = document.getElementById(`${prefix}CamStage`);
  const video = document.getElementById(`${prefix}CamVideo`);
  const btn = document.getElementById(`${prefix}CamBtn`);
  const targetInputId = prefix === "help" ? "helpQrUrl" : "manualQrUrl";

  const hasLiveTrack =
    _camStream &&
    typeof _camStream.getVideoTracks === 'function' &&
    _camStream.getVideoTracks().some((t) => t.readyState === 'live');
  if (_camActiveMode === prefix && hasLiveTrack && stage && video) {
    stage.style.display = "block";
    if (btn) btn.textContent = "关闭相机";
    try {
      if (video.paused) await video.play();
    } catch (_) {}
    return true;
  }

  stopCameraQrScanner();
  if (opts.retryFailedOnly !== undefined) {
    _camRetryFailedOnly = Boolean(opts.retryFailedOnly);
  }
  if (opts.cooldownMs && Number(opts.cooldownMs) > 0) {
    _camScanPausedUntil = Date.now() + Number(opts.cooldownMs);
  }

  if (!isStandaloneClientEnv() && location.protocol === "http:" && String(location.hostname || "").toLowerCase() === "ishit.pw") {
    showToast("正在切换 HTTPS 安全环境以启用相机扫码...");
    location.href = "https://ishit.pw" + location.pathname + location.search + location.hash;
    return false;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    if (isAuto && prefix === "help") {
      setHelpCamFallbackTip("当前浏览器环境不支持直接调起摄像头，请点击下方「拍照 / 相册识码」上传或拍摄二维码");
      return false;
    }
    showToast("当前浏览器限制直接调起摄像头，已为您打开拍照/选图识别");
    const section = document.getElementById(prefix === "help" ? "helpSectionQr" : "manualSectionQr");
    const fileInput = section ? section.querySelector('input[type="file"]') : null;
    if (fileInput) fileInput.click();
    return false;
  }

  try {
    _camStream = await openCameraStreamWithFallback();
    _camActiveMode = prefix;
    video.setAttribute("playsinline", "true");
    video.setAttribute("webkit-playsinline", "true");
    video.muted = true;
    video.srcObject = _camStream;
    stage.style.display = "block";
    if (btn) btn.textContent = "关闭相机";
    await video.play();

    const canvas = document.createElement("canvas");
    const ctx2d = canvas.getContext("2d", { willReadFrequently: true });
    let nativeDetector = null;
    if ("BarcodeDetector" in window) {
      try {
        nativeDetector = new BarcodeDetector({ formats: ["qr_code"] });
      } catch (_) {}
    }

    let frameCount = 0;
    const scanTick = async () => {
      if (!_camStream || _camActiveMode !== prefix) return;
      if (!_camSubmitting && Date.now() >= _camScanPausedUntil && video.readyState >= video.HAVE_ENOUGH_DATA && video.videoWidth > 0) {
        frameCount++;
        let qrText = null;
        if (typeof window.jsQR === "function") {
          const vw = video.videoWidth;
          const vh = video.videoHeight;
          canvas.width = vw;
          canvas.height = vh;
          ctx2d.drawImage(video, 0, 0, vw, vh);
          const imgData = ctx2d.getImageData(0, 0, vw, vh);
          const code = window.jsQR(imgData.data, imgData.width, imgData.height, { inversionAttempts: "attemptBoth" });
          if (code && code.data) {
            qrText = code.data.trim();
          } else if (frameCount % 2 === 0) {
            const cropSize = Math.floor(Math.min(vw, vh) * 0.62);
            const sx = Math.floor((vw - cropSize) / 2);
            const sy = Math.floor((vh - cropSize) / 2);
            canvas.width = 520;
            canvas.height = 520;
            ctx2d.fillStyle = "#ffffff";
            ctx2d.fillRect(0, 0, 520, 520);
            ctx2d.drawImage(video, sx, sy, cropSize, cropSize, 20, 20, 480, 480);
            const subData = ctx2d.getImageData(0, 0, 520, 520);
            const subCode = window.jsQR(subData.data, subData.width, subData.height, { inversionAttempts: "attemptBoth" });
            if (subCode && subCode.data) qrText = subCode.data.trim();
          }
        }
        if (!qrText && nativeDetector) {
          try {
            const codes = await nativeDetector.detect(video);
            if (codes.length > 0 && codes[0].rawValue) qrText = codes[0].rawValue.trim();
          } catch (_) {}
        }
        if (qrText) {
          const targetEl = document.getElementById(targetInputId);
          if (targetEl) targetEl.value = qrText;
          if (prefix === "help") {
            _camSubmitting = true;
            _camScanPausedUntil = Date.now() + 1800;
            setHelpCamOverlayTip("已捕获二维码，正在自动提交签到...");
            showToast("扫码成功，正在自动提交签到...");
            submitHelperSign(_camRetryFailedOnly);
          } else {
            stopCameraQrScanner();
            showToast("扫码成功，正在自动提交签到...");
            submitManualSign();
            return;
          }
        }
      }
      _camScanRaf = requestAnimationFrame(scanTick);
    };

    _camScanRaf = requestAnimationFrame(scanTick);
    return true;
  } catch (err) {
    stopCameraQrScanner();
    if (prefix === "help") {
      setHelpCamFallbackTip("未授予摄像头权限或无法直接调起相机，请点击「打开相机扫码」授权或使用「拍照 / 相册识码」");
    }
    if (!isAuto) {
      showToast("无法直接调起摄像头，请使用右侧「拍照/相册识别」");
    }
    return false;
  }
}

async function toggleCameraQrScanner(prefix = "manual") {
  if (_camActiveMode === prefix && _camStream) {
    stopCameraQrScanner();
    return;
  }
  await startCameraQrScanner(prefix, { auto: false, retryFailedOnly: _camRetryFailedOnly });
}

function loadFileAsImageElement(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function binarizeImageDataInPlace(imgData, factor = 1.0) {
  const d = imgData.data;
  const n = imgData.width * imgData.height;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) {
    sum += (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  }
  const thresh = (sum / Math.max(1, n)) * factor;
  for (let i = 0; i < d.length; i += 4) {
    const lum = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    const v = lum < thresh ? 0 : 255;
    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
    d[i + 3] = 255;
  }
  return imgData;
}

function tryClientCanvasQrDecode(source, srcW, srcH) {
  if (typeof window.jsQR !== "function") return null;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const maxSide = Math.max(srcW, srcH);

  // 1. 多分辨率 + 白边静区（Quiet Zone）扫描
  const targetMaxList = [1000, 640, 1440, 440, maxSide];
  const tried = new Set();
  for (const targetMax of targetMaxList) {
    const scale = targetMax >= maxSide ? 1 : targetMax / maxSide;
    const dw = Math.max(64, Math.round(srcW * scale));
    const dh = Math.max(64, Math.round(srcH * scale));
    if (dw > 2200 || dh > 2200) continue;
    const key = `${dw}x${dh}`;
    if (tried.has(key)) continue;
    tried.add(key);

    for (const pad of [0, 28]) {
      canvas.width = dw + pad * 2;
      canvas.height = dh + pad * 2;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(source, 0, 0, srcW, srcH, pad, pad, dw, dh);
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let code = window.jsQR(imgData.data, imgData.width, imgData.height, { inversionAttempts: "attemptBoth" });
      if (code && code.data) return code.data.trim();

      for (const f of [1.0, 0.88, 1.12]) {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(source, 0, 0, srcW, srcH, pad, pad, dw, dh);
        const binData = binarizeImageDataInPlace(ctx.getImageData(0, 0, canvas.width, canvas.height), f);
        code = window.jsQR(binData.data, binData.width, binData.height, { inversionAttempts: "dontInvert" });
        if (code && code.data) return code.data.trim();
      }
    }
  }

  // 2. 局部裁剪扫描（应对手机拍摄大屏二维码占比小的情况）
  for (const ratio of [0.75, 0.55]) {
    const cw = Math.round(srcW * ratio);
    const ch = Math.round(srcH * ratio);
    for (const [fx, fy] of [[0.5, 0.5], [0.5, 0.35], [0.35, 0.5], [0.65, 0.5]]) {
      const sx = Math.max(0, Math.min(srcW - cw, Math.round(srcW * fx - cw / 2)));
      const sy = Math.max(0, Math.min(srcH - ch, Math.round(srcH * fy - ch / 2)));
      const dstW = Math.min(800, cw);
      const dstH = Math.min(800, ch);
      canvas.width = dstW + 40;
      canvas.height = dstH + 40;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(source, sx, sy, cw, ch, 20, 20, dstW, dstH);
      const subData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let code = window.jsQR(subData.data, subData.width, subData.height, { inversionAttempts: "attemptBoth" });
      if (code && code.data) return code.data.trim();
      const binSub = binarizeImageDataInPlace(subData, 0.95);
      code = window.jsQR(binSub.data, binSub.width, binSub.height, { inversionAttempts: "dontInvert" });
      if (code && code.data) return code.data.trim();
    }
  }
  return null;
}

async function decodeQrImage(input, targetInputId, autoSubmit = false) {
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;

  showToast("正在识别图片中的二维码...");
  let qrText = null;
  let imgSource = null;
  let srcW = 0;
  let srcH = 0;

  try {
    if (typeof createImageBitmap === "function") {
      try {
        const bmp = await createImageBitmap(file);
        imgSource = bmp;
        srcW = bmp.width;
        srcH = bmp.height;
      } catch (_) {}
    }
    if (!imgSource) {
      const imgEl = await loadFileAsImageElement(file);
      imgSource = imgEl;
      srcW = imgEl.naturalWidth || imgEl.width;
      srcH = imgEl.naturalHeight || imgEl.height;
    }

    if (imgSource && srcW > 0 && srcH > 0) {
      qrText = tryClientCanvasQrDecode(imgSource, srcW, srcH);

      if (!qrText && "BarcodeDetector" in window) {
        try {
          const det = new BarcodeDetector({ formats: ["qr_code"] });
          const codes = await det.detect(imgSource);
          if (codes.length > 0 && codes[0].rawValue) {
            qrText = codes[0].rawValue.trim();
          }
        } catch (_) {}
      }

      // 3. 后端高精度多尺度自适应阈值兜底识别（彻底解决复杂光线、摩尔纹或前端解码失败）
      if (!qrText) {
        try {
          const upCanvas = document.createElement("canvas");
          const maxUp = 1280;
          const upScale = Math.max(srcW, srcH) > maxUp ? maxUp / Math.max(srcW, srcH) : 1;
          upCanvas.width = Math.max(64, Math.round(srcW * upScale));
          upCanvas.height = Math.max(64, Math.round(srcH * upScale));
          const upCtx = upCanvas.getContext("2d");
          upCtx.fillStyle = "#ffffff";
          upCtx.fillRect(0, 0, upCanvas.width, upCanvas.height);
          upCtx.drawImage(imgSource, 0, 0, upCanvas.width, upCanvas.height);
          const dataUrl = upCanvas.toDataURL("image/jpeg", 0.9);
          const resp = await api("/api/qr/decode", "POST", { base64Image: dataUrl });
          if (resp && resp.ok && resp.qrText) {
            qrText = String(resp.qrText).trim();
          }
        } catch (_) {}
      }
    }
  } catch (_) {}

  if (qrText) {
    const targetEl = document.getElementById(targetInputId);
    if (targetEl) targetEl.value = qrText;
    if (autoSubmit || targetInputId === "helpQrUrl") {
      showToast("二维码解析成功，正在自动提交签到...");
      submitHelperSign(_camRetryFailedOnly);
    } else {
      showToast("二维码解析成功，已填入签到框");
    }
    return;
  }

  showToast("未识别到清晰二维码，请尽量截取二维码区域后重试");
}


// ============================================================================
// Admin 专属：系统设置 -> 签到悬赏（轮询时长 / 排行榜积分编辑重置 / 所有签到记录删改）
// ============================================================================
async function loadAdminBountyOverview(showToastFlag = false) {
  if (!isCurrentPanelAdmin()) return;
  try {
    const res = await api('/api/admin/bounty/overview');
    if (!res || !res.ok) {
      if (showToastFlag) showToast(res?.msg || '加载签到悬赏设置失败');
      return;
    }
    state.adminBountyData = res;
    renderAdminBountyOverview(true);
    if (showToastFlag) showToast('签到悬赏与记录数据已刷新');
  } catch (e) {
    if (showToastFlag) showToast('加载签到悬赏设置失败');
  }
}

function renderAdminBountyOverview(syncPollingInputs = false) {
  const data = state.adminBountyData;
  if (!data) return;

  // 1. 轮询与同步时长
  const polling = data.polling || {};
  const effSec = Number(polling.effectiveIntervalSeconds || polling.globalIntervalSeconds || 15);
  const syncSec = Number(polling.bountySyncSeconds || 3.5);
  const effTag = document.getElementById('adminBountyEffectivePollTag');
  if (effTag) effTag.textContent = `当前生效 ${effSec}s · 同步 ${syncSec}s`;
  if (syncPollingInputs) {
    const pollInp = document.getElementById('adminBountyPollIntervalInput');
    if (pollInp) pollInp.value = effSec;
    const syncInp = document.getElementById('adminBountySyncIntervalInput');
    if (syncInp) syncInp.value = syncSec;
    const cfgInp = document.getElementById('cfgIntervalSeconds');
    if (cfgInp) cfgInp.value = effSec;
  }

  // 2. 签到大师排行榜管理列表
  const lbBox = document.getElementById('adminBountyLeaderboardList');
  if (lbBox) {
    const lb = Array.isArray(data.leaderboard) ? data.leaderboard : [];
    if (lb.length === 0) {
      lbBox.innerHTML = '<div class="empty-hint" style="padding:18px 0;">排行榜暂无数据，可点击右上角“新增上榜用户”</div>';
    } else {
      lbBox.innerHTML = lb
        .map((item) => {
          const key = String(item.key || item.studentId || item.boundUid || '');
          const safeKey = escapeHtml(key);
          const namesStr = Array.isArray(item.names) && item.names.length > 0 ? item.names.join(' / ') : '';
          return `
            <div class="list-row" style="align-items:center; gap:10px; padding:8px 0;">
              <div style="flex:1; min-width:0;">
                <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                  <span class="tag">#${Number(item.rank || 1)}</span>
                  <span style="font-weight:600;">${escapeHtml(item.displayName || item.cxName || key)}</span>
                  ${item.cxName && item.cxName !== item.displayName ? `<span style="font-size:11px; color:var(--muted);">(${escapeHtml(item.cxName)})</span>` : ''}
                  ${item.studentId ? `<span style="font-size:11px; color:var(--muted);">学号: ${escapeHtml(item.studentId)}</span>` : ''}
                </div>
                <div style="font-size:11px; color:var(--muted); margin-top:2px;">
                  积分：<strong style="color:var(--primary);">${Number(item.score || 0)}</strong> 分 · 累计帮签：${Number(item.assistCount || 0)} 次
                  ${namesStr ? ` · 曾用名：${escapeHtml(namesStr)}` : ''}
                </div>
              </div>
              <div class="row" style="gap:6px; flex-shrink:0;">
                <button type="button" class="btn btn-ghost btn-sm" data-lb-key="${safeKey}" onclick="openAdminLeaderboardEditModal(this.getAttribute('data-lb-key'))">编辑</button>
                <button type="button" class="btn btn-ghost btn-sm" style="color:var(--danger);" data-lb-key="${safeKey}" onclick="deleteAdminLeaderboardEntry(this.getAttribute('data-lb-key'))">删除</button>
              </div>
            </div>
          `;
        })
        .join('');
    }
  }

  // 3. 签到记录管理列表（根据当前选中的 tab）
  renderAdminBountyRecordsList();
}

function switchAdminBountyRecordTab(rtype) {
  state.adminRecordTab = rtype || 'bountyHistory';
  document.querySelectorAll('#adminRecordTypeTabs .tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-rtype') === state.adminRecordTab);
  });
  renderAdminBountyRecordsList();
}

function renderAdminBountyRecordsList() {
  const box = document.getElementById('adminBountyRecordsContainer');
  if (!box) return;
  const data = state.adminBountyData || {};
  const rtype = state.adminRecordTab || 'bountyHistory';

  if (rtype === 'bountyHistory') {
    const list = Array.isArray(data.bountyHistory) ? data.bountyHistory : [];
    if (list.length === 0) {
      box.innerHTML = '<div class="empty-hint" style="padding:24px 0;">暂无悬赏完成记录</div>';
      return;
    }
    box.innerHTML = list
      .map((h) => {
        const recId = String(h.id || h.claimToken || '');
        const safeId = escapeHtml(recId);
        const timeStr = h.timeMs ? new Date(Number(h.timeMs)).toLocaleString('zh-CN', { hour12: false }) : '';
        const signedNames = Array.isArray(h.signedNames) ? h.signedNames.join('、') : '';
        const imgUrl = h.commentImage ? resolveAssetUrl(h.commentImage) : '';
        return `
          <div class="list-row" style="flex-direction:column; align-items:stretch; gap:6px; padding:10px 0;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
              <div style="min-width:0; flex:1;">
                <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                  <span style="font-weight:600;">${escapeHtml(h.courseName || '协助课程')}</span>
                  <span class="tag">${escapeHtml(h.activeName || '课堂签到')}</span>
                  <span class="tag" style="color:var(--ok);">+${Number(h.earnedPoints || 0)} 分</span>
                  <span style="font-size:11px; color:var(--muted);">${escapeHtml(timeStr)}</span>
                </div>
                <div style="font-size:12px; color:var(--muted); margin-top:3px;">
                  协助者：<strong>${escapeHtml(h.helperName || '热心同学')}</strong>
                  ${h.helperStudentId ? `(${escapeHtml(h.helperStudentId)})` : ''}
                  · 被帮同学：${escapeHtml(signedNames || '无')}
                </div>
                ${
                  h.commentText || imgUrl
                    ? `<div style="margin-top:5px; padding:6px 8px; background:var(--panel-sub, rgba(127,127,127,0.08)); border-radius:6px; font-size:12px;">
                        ${h.commentText ? `<div>留言：${escapeHtml(h.commentText)}</div>` : ''}
                        ${imgUrl ? `<div style="margin-top:4px;"><img src="${escapeHtml(imgUrl)}" style="max-height:72px; border-radius:4px; cursor:pointer;" onclick="openImagePreviewModal(this.src)" /></div>` : ''}
                       </div>`
                    : '<div style="font-size:11px; color:var(--muted); margin-top:2px;">无留言</div>'
                }
              </div>
              <div class="row" style="gap:6px; flex-shrink:0;">
                <button type="button" class="btn btn-ghost btn-sm" data-rec-id="${safeId}" onclick="openAdminRecordEditModal('bountyHistory', this.getAttribute('data-rec-id'))">编辑</button>
                <button type="button" class="btn btn-ghost btn-sm" style="color:var(--danger);" data-rec-id="${safeId}" onclick="deleteAdminRecordItem('bountyHistory', this.getAttribute('data-rec-id'))">删除</button>
              </div>
            </div>
          </div>
        `;
      })
      .join('');
    return;
  }

  if (rtype === 'signHistory') {
    const list = Array.isArray(data.signHistory) ? data.signHistory : [];
    if (list.length === 0) {
      box.innerHTML = '<div class="empty-hint" style="padding:24px 0;">暂无系统签到记录</div>';
      return;
    }
    box.innerHTML = list
      .map((h, idx) => {
        const recId = String(h.id || '');
        const safeId = escapeHtml(recId);
        const results = Array.isArray(h.results) ? h.results : [];
        const okCount = results.filter((r) => r && r.ok).length;
        const summary = results.map((r) => `${r.name || r.uid}:${r.ok ? '成功' : '失败'}`).join('，');
        return `
          <div class="list-row" style="align-items:flex-start; justify-content:space-between; gap:8px; padding:10px 0;">
            <div style="min-width:0; flex:1;">
              <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                <span style="font-weight:600;">${escapeHtml(h.courseName || '未知课程')}</span>
                <span class="tag">${escapeHtml(h.signTypeLabel || h.activeName || '签到')}</span>
                <span class="tag">${okCount}/${results.length} 成功</span>
                <span style="font-size:11px; color:var(--muted);">${escapeHtml(h.time || '')} · ${escapeHtml(h.triggerSource || '')}</span>
              </div>
              <div style="font-size:11px; color:var(--muted); margin-top:3px; word-break:break-all;">
                ${escapeHtml(summary || '无明细')}
              </div>
            </div>
            <div class="row" style="gap:6px; flex-shrink:0;">
              ${recId ? `<button type="button" class="btn btn-ghost btn-sm" data-rec-id="${safeId}" onclick="openAdminRecordEditModal('signHistory', this.getAttribute('data-rec-id'))">编辑</button>` : ''}
              <button type="button" class="btn btn-ghost btn-sm" style="color:var(--danger);" data-rec-id="${safeId}" data-rec-idx="${idx}" onclick="deleteAdminRecordItem('signHistory', this.getAttribute('data-rec-id'), Number(this.getAttribute('data-rec-idx')))">删除</button>
            </div>
          </div>
        `;
      })
      .join('');
    return;
  }

  if (rtype === 'helperSessions') {
    const list = Array.isArray(data.helperSessions) ? data.helperSessions : [];
    if (list.length === 0) {
      box.innerHTML = '<div class="empty-hint" style="padding:24px 0;">暂无协助任务会话</div>';
      return;
    }
    box.innerHTML = list
      .map((s) => {
        const tk = String(s.token || '');
        const safeTk = escapeHtml(tk);
        const timeStr = s.createdAt ? new Date(Number(s.createdAt)).toLocaleString('zh-CN', { hour12: false }) : '';
        const targetNames = Array.isArray(s.targetNames) ? s.targetNames.join('、') : '';
        return `
          <div class="list-row" style="align-items:center; justify-content:space-between; gap:8px; padding:10px 0;">
            <div style="min-width:0; flex:1;">
              <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                <span style="font-weight:600;">${escapeHtml(s.courseName || s.title || '协助任务')}</span>
                <span class="tag">${escapeHtml(s.activeName || s.signType || '签到')}</span>
                <span class="tag" style="color:${s.completed ? 'var(--ok)' : 'var(--warn)'};">${s.completed ? '已完成' : '待协助/进行中'}</span>
                <span style="font-size:11px; color:var(--muted);">${escapeHtml(timeStr)}</span>
              </div>
              <div style="font-size:11px; color:var(--muted); margin-top:3px;">
                目标同学：${escapeHtml(targetNames || '无')} · Token: ${escapeHtml(tk.slice(0, 10))}...
              </div>
            </div>
            <div class="row" style="gap:6px; flex-shrink:0;">
              <button type="button" class="btn btn-ghost btn-sm" data-tk="${safeTk}" data-done="${s.completed ? '1' : '0'}" onclick="toggleAdminHelperSession(this.getAttribute('data-tk'), this.getAttribute('data-done') !== '1')">
                ${s.completed ? '设为未完成' : '标记完成'}
              </button>
              <button type="button" class="btn btn-ghost btn-sm" style="color:var(--danger);" data-tk="${safeTk}" onclick="deleteAdminRecordItem('helperSessions', this.getAttribute('data-tk'))">删除</button>
            </div>
          </div>
        `;
      })
      .join('');
  }
}

async function saveAdminBountyPollingConfig() {
  const intervalSeconds = Math.max(3, Math.min(300, Number(document.getElementById('adminBountyPollIntervalInput')?.value || 6)));
  const bountySyncSeconds = Math.max(1, Math.min(60, Number(document.getElementById('adminBountySyncIntervalInput')?.value || 3.5)));
  const syncAllUsers = Boolean(document.getElementById('adminBountySyncAllUsersToggle')?.checked);

  const res = await api('/api/admin/bounty/config', 'POST', {
    intervalSeconds,
    bountySyncSeconds,
    syncAllUsers,
  });
  if (res && res.ok) {
    state.adminBountyData = res;
    renderAdminBountyOverview(true);
    showToast(`悬赏检测轮询已设为 ${intervalSeconds}s（看板同步 ${bountySyncSeconds}s）`);
    refreshStatus(false);
  } else {
    showToast(res?.msg || '保存配置失败');
  }
}

function openAdminLeaderboardEditModal(keyOrNull) {
  const lb = Array.isArray(state.adminBountyData?.leaderboard) ? state.adminBountyData.leaderboard : [];
  const item = keyOrNull ? lb.find((e) => String(e.key || e.studentId || '') === String(keyOrNull)) : null;

  const titleEl = document.getElementById('adminLbModalTitle');
  if (titleEl) titleEl.textContent = item ? '编辑排行榜用户' : '新增排行榜用户';
  document.getElementById('adminLbOrigKey').value = item ? String(item.key || item.studentId || '') : '';
  document.getElementById('adminLbStudentId').value = item ? String(item.studentId || item.key || '') : '';
  document.getElementById('adminLbDisplayName').value = item ? String(item.displayName || '') : '';
  document.getElementById('adminLbCxName').value = item ? String(item.cxName || '') : '';
  document.getElementById('adminLbScore').value = item ? Number(item.score || 0) : 1;
  document.getElementById('adminLbAssistCount').value = item ? Number(item.assistCount || 1) : 1;
  document.getElementById('adminLbNames').value = item && Array.isArray(item.names) ? item.names.join(', ') : '';
  openModal('adminLeaderboardEditModal');
}

async function submitAdminLeaderboardEdit() {
  const origKey = document.getElementById('adminLbOrigKey')?.value.trim() || '';
  const studentId = document.getElementById('adminLbStudentId')?.value.trim() || '';
  const displayName = document.getElementById('adminLbDisplayName')?.value.trim() || '';
  const cxName = document.getElementById('adminLbCxName')?.value.trim() || '';
  const score = Math.max(0, Number(document.getElementById('adminLbScore')?.value || 0));
  const assistCount = Math.max(0, Math.floor(Number(document.getElementById('adminLbAssistCount')?.value || 0)));
  const namesRaw = document.getElementById('adminLbNames')?.value || '';
  const names = namesRaw
    .split(/[,，/、]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (!studentId && !displayName && !origKey) {
    return showToast('请填写学号或显示称号');
  }

  const res = await api('/api/admin/bounty/leaderboard', 'POST', {
    action: 'upsert',
    origKey,
    studentId,
    displayName,
    cxName,
    score,
    assistCount,
    names,
  });
  if (res && res.ok) {
    state.adminBountyData = res;
    renderAdminBountyOverview(false);
    closeModal('adminLeaderboardEditModal');
    showToast('排行榜用户信息已保存');
    refreshStatus(false);
  } else {
    showToast(res?.msg || '保存失败');
  }
}

async function deleteAdminLeaderboardEntry(key) {
  if (!key) return;
  if (!confirm(`确定要从排行榜中删除 "${key}" 吗？`)) return;
  const res = await api('/api/admin/bounty/leaderboard', 'POST', {
    action: 'delete',
    key,
  });
  if (res && res.ok) {
    state.adminBountyData = res;
    renderAdminBountyOverview(false);
    showToast('已删除该排行榜用户');
    refreshStatus(false);
  } else {
    showToast(res?.msg || '删除失败');
  }
}

async function resetAdminLeaderboard() {
  if (!confirm('确定要清空并重置整个【签到大师排行榜】的所有分数数据吗？此操作不可撤销！')) return;
  const res = await api('/api/admin/bounty/leaderboard', 'POST', { action: 'reset' });
  if (res && res.ok) {
    state.adminBountyData = res;
    renderAdminBountyOverview(false);
    showToast('签到大师排行榜已重置');
    refreshStatus(false);
  } else {
    showToast(res?.msg || '重置失败');
  }
}

function openAdminRecordEditModal(rtype, id) {
  const data = state.adminBountyData || {};
  document.getElementById('adminRecEditType').value = rtype;
  document.getElementById('adminRecEditId').value = id;

  const bountyFields = document.getElementById('adminRecBountyFields');
  const signFields = document.getElementById('adminRecSignHistoryFields');

  if (rtype === 'bountyHistory') {
    const rec = (data.bountyHistory || []).find((h) => String(h.id || h.claimToken || '') === String(id));
    if (!rec) return showToast('未找到该条悬赏完成记录');
    document.getElementById('adminRecModalTitle').textContent = '编辑悬赏完成记录';
    if (bountyFields) bountyFields.style.display = 'block';
    if (signFields) signFields.style.display = 'none';

    document.getElementById('adminRecCourseName').value = rec.courseName || '';
    document.getElementById('adminRecActiveName').value = rec.activeName || '';
    document.getElementById('adminRecHelperName').value = rec.helperName || '';
    document.getElementById('adminRecHelperSid').value = rec.helperStudentId || '';
    document.getElementById('adminRecEarnedPoints').value = Number(rec.earnedPoints || 0);
    document.getElementById('adminRecSignedNames').value = Array.isArray(rec.signedNames) ? rec.signedNames.join(', ') : '';
    document.getElementById('adminRecCommentText').value = rec.commentText || '';
    document.getElementById('adminRecCommentImage').value = rec.commentImage || '';
    openModal('adminRecordEditModal');
    return;
  }

  if (rtype === 'signHistory') {
    const rec = (data.signHistory || []).find((h) => String(h.id || '') === String(id));
    if (!rec) return showToast('未找到该条系统签到记录');
    document.getElementById('adminRecModalTitle').textContent = '编辑系统签到记录';
    if (bountyFields) bountyFields.style.display = 'none';
    if (signFields) signFields.style.display = 'block';

    document.getElementById('adminRecCourseName').value = rec.courseName || '';
    document.getElementById('adminRecActiveName').value = rec.activeName || '';
    document.getElementById('adminRecSignTypeLabel').value = rec.signTypeLabel || '';
    document.getElementById('adminRecTriggerSource').value = rec.triggerSource || '';
    const lines = (rec.results || []).map((r) => `${r.name || r.uid}|${r.ok ? 'ok' : 'fail'}|${r.msg || ''}`);
    document.getElementById('adminRecResultsText').value = lines.join('\n');
    openModal('adminRecordEditModal');
  }
}

async function onAdminSelectRecordImage(input) {
  const file = input?.files?.[0];
  if (!file) return;
  try {
    showToast('正在压缩并上传图片...');
    const imgEl = await loadFileAsImageElement(file);
    const srcW = imgEl.naturalWidth || imgEl.width || 800;
    const srcH = imgEl.naturalHeight || imgEl.height || 600;
    const maxSide = 1280;
    const scale = Math.max(srcW, srcH) > maxSide ? maxSide / Math.max(srcW, srcH) : 1;
    const dstW = Math.max(32, Math.round(srcW * scale));
    const dstH = Math.max(32, Math.round(srcH * scale));
    const canvas = document.createElement('canvas');
    canvas.width = dstW;
    canvas.height = dstH;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, dstW, dstH);
    ctx.drawImage(imgEl, 0, 0, dstW, dstH);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.86);
    const res = await api('/api/helper/uploadImage', 'POST', { base64Image: dataUrl });
    if (res && res.ok && res.imageUrl) {
      const inp = document.getElementById('adminRecCommentImage');
      if (inp) inp.value = res.imageUrl;
      showToast('留言图片已上传');
    } else {
      showToast(res?.msg || '上传图片失败');
    }
  } catch (e) {
    showToast('上传图片失败');
  } finally {
    input.value = '';
  }
}

async function submitAdminRecordEdit() {
  const recordType = document.getElementById('adminRecEditType')?.value || 'bountyHistory';
  const id = document.getElementById('adminRecEditId')?.value || '';
  const courseName = document.getElementById('adminRecCourseName')?.value.trim() || '';
  const activeName = document.getElementById('adminRecActiveName')?.value.trim() || '';

  const payload = {
    recordType,
    action: 'update',
    id,
    courseName,
    activeName,
  };

  if (recordType === 'bountyHistory') {
    payload.helperName = document.getElementById('adminRecHelperName')?.value.trim() || '';
    payload.helperStudentId = document.getElementById('adminRecHelperSid')?.value.trim() || '';
    payload.earnedPoints = Math.max(0, Number(document.getElementById('adminRecEarnedPoints')?.value || 0));
    payload.signedNames = document.getElementById('adminRecSignedNames')?.value || '';
    payload.commentText = document.getElementById('adminRecCommentText')?.value || '';
    payload.commentImage = document.getElementById('adminRecCommentImage')?.value.trim() || '';
  } else if (recordType === 'signHistory') {
    payload.signTypeLabel = document.getElementById('adminRecSignTypeLabel')?.value.trim() || '';
    payload.triggerSource = document.getElementById('adminRecTriggerSource')?.value.trim() || '';
    const rawLines = (document.getElementById('adminRecResultsText')?.value || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    payload.results = rawLines.map((line) => {
      const parts = line.split('|');
      const name = (parts[0] || '').trim();
      const status = (parts[1] || 'ok').trim().toLowerCase();
      const msg = parts.slice(2).join('|').trim() || (status === 'ok' ? '签到成功' : '签到失败');
      return { uid: '', name, ok: status === 'ok' || status === 'true' || status === '1', already: false, msg };
    });
  }

  const res = await api('/api/admin/bounty/records', 'POST', payload);
  if (res && res.ok) {
    state.adminBountyData = res;
    renderAdminBountyOverview(false);
    closeModal('adminRecordEditModal');
    showToast('签到记录已更新');
    refreshStatus(false);
  } else {
    showToast(res?.msg || '更新记录失败');
  }
}

async function deleteAdminRecordItem(recordType, id, index = -1) {
  if (!confirm('确定要删除这条记录吗？')) return;
  const payload = { recordType, action: 'delete', id, token: id, index };
  const res = await api('/api/admin/bounty/records', 'POST', payload);
  if (res && res.ok) {
    state.adminBountyData = res;
    renderAdminBountyOverview(false);
    showToast('已删除该条记录');
    refreshStatus(false);
  } else {
    showToast(res?.msg || '删除失败');
  }
}

async function toggleAdminHelperSession(token, completed) {
  const res = await api('/api/admin/bounty/records', 'POST', {
    recordType: 'helperSessions',
    action: 'toggleComplete',
    token,
    completed: Boolean(completed),
  });
  if (res && res.ok) {
    state.adminBountyData = res;
    renderAdminBountyOverview(false);
    showToast(completed ? '已标记为完成（从悬赏榜移除）' : '已重新设为未完成');
    refreshStatus(false);
  } else {
    showToast(res?.msg || '操作失败');
  }
}

async function clearCurrentAdminRecords() {
  const rtype = state.adminRecordTab || 'bountyHistory';
  const labelMap = {
    bountyHistory: '悬赏完成记录',
    signHistory: '系统签到记录',
    helperSessions: '协助任务会话',
  };
  if (!confirm(`确定要清空全部【${labelMap[rtype] || rtype}】吗？此操作不可恢复！`)) return;
  const action = rtype === 'helperSessions' ? 'clearAll' : 'clear';
  const res = await api('/api/admin/bounty/records', 'POST', { recordType: rtype, action });
  if (res && res.ok) {
    state.adminBountyData = res;
    renderAdminBountyOverview(false);
    showToast(`已清空${labelMap[rtype] || '记录'}`);
    refreshStatus(false);
  } else {
    showToast(res?.msg || '清空失败');
  }
}
