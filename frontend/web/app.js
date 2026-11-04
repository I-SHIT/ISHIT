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
  mainMap: null,
  mainMarker: null,
  modalMap: null,
  modalMarker: null,
  modalTargetIds: null,
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

  const activeSettingSub = document.querySelector('#settingsSubTabs .tab-btn.active')?.getAttribute('data-sub');
  if (!isAdmin && activeSettingSub === 'napcat') {
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
  if (sub === 'napcat' && !isCurrentPanelAdmin()) {
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
  const settingsSubLabels = { polling: '轮询与防钓鱼', accounts: '学习通账号池', napcat: 'NapCat 推送', security: '用户与权限' };
  updateWinTopbarTitle('系统设置', settingsSubLabels[sub] || '');
}

function switchTab(tab) {
  if (tab === 'overview' || tab === 'global') {
    switchMainModule('global');
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

function enterAdminPanel() {
  applyPlatformLayoutClass();
  document.getElementById('panelLoginApp').style.display = 'none';
  document.getElementById('helperApp').style.display = 'none';
  document.getElementById('adminApp').style.display = '';
  refreshStatus(true);
  if (state.statusPollTimer) clearInterval(state.statusPollTimer);
  state.statusPollTimer = setInterval(() => refreshStatus(false), 5000);
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
    box.innerHTML = `<div class="empty">暂无网站用户</div>`;
    return;
  }
  box.innerHTML = users
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

    renderTopStatus(data);
    renderUserSwitcher(data);
    renderOverview(data, syncInputs);
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
  if (sel) sel.innerHTML = html;
  const winSel = document.getElementById('winSidebarUserSelect');
  if (winSel) winSel.innerHTML = html;
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
        ? ` · 人数保护 ≥${Math.round(Number(data.schedule.signThresholdRatio || 0.3) * 100)}% (含临期抢签)`
        : ' · 发现即签';
      modeSummaryEl.textContent = `当前策略：${mText}（间隔 ${data.schedule.intervalSeconds || 25}s${pText}）`;
    }
  }
  renderOverviewTestCourses(isCurrentPanelAdmin() ? (data.courses || []) : (data.myOwnedCourses || []));

  // 待验证滑块
  const capSec = document.getElementById('pendingCaptchaSection');
  const capList = document.getElementById('pendingCaptchaList');
  const caps = data.pendingCaptchas || [];
  if (caps.length > 0) {
    capSec.style.display = 'block';
    capList.innerHTML = caps
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
  } else {
    capSec.style.display = 'none';
  }

  // 活动监测列表
  const radarEl = document.getElementById('activeRadarList');
  const actives = data.lastDetectedActives || [];
  if (actives.length === 0) {
    radarEl.innerHTML = `<div class="empty">暂无签到活动</div>`;
  } else {
    radarEl.innerHTML = actives
      .map((item) => {
        const act = item.active || item;
        const signedNum = act.signedCount ?? act.attendNum ?? 0;
        const totalNum = act.totalCount || 0;
        const ratioStr = totalNum > 0
          ? `已签: ${signedNum}/${totalNum} 人 (${Math.round((signedNum / totalNum) * 100)}%)`
          : `已签: ${signedNum} 人`;
        const waitBadge = act.waitingThreshold
          ? `<span class="tag" style="margin-left:6px;">等待人数达标(${Math.round((act.thresholdRatio || 0.3) * 100)}%)</span>`
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
        return `
      <div class="list-row">
        <div>
          <div style="font-weight:500;">${escapeHtml(ctx.courseName)} · ${escapeHtml(ctx.name)}${waitBadge}</div>
          <div style="font-size:11px; color:var(--muted);">类型: ${escapeHtml(ctx.signTypeName)} | ${escapeHtml(ratioStr)} | 状态: ${act.status ? '进行中' : '已结束'}</div>
        </div>
        <div class="row">
          <button class="btn btn-sm" onclick='openManualSignModal(${JSON.stringify(ctx).replace(/'/g, "&#39;")})'>签到</button>
          <button class="btn btn-ghost btn-sm" onclick='openHelperCreateModal(${JSON.stringify({ mode: "sign", courseId: ctx.courseId, classId: ctx.classId, cpi: ctx.cpi, courseName: ctx.courseName, activeId: ctx.id, activeName: ctx.name, signType: ctx.signType }).replace(/'/g, "&#39;")})'>协助</button>
        </div>
      </div>`;
      })
      .join('');
  }

  // 历史记录
  const histEl = document.getElementById('historyList');
  const hist = data.history || [];
  histEl.innerHTML = hist.length
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

  // 运行日志
  const logsEl = document.getElementById('logsBox');
  const logList = data.logs || [];
  logsEl.innerHTML = logList.length
    ? logList
        .map((l) =>
          typeof l === "string"
            ? `<div class="log-item">${escapeHtml(l)}</div>`
            : `<div class="log-item">${escapeHtml(l.line || `[${l.time}] [${l.tag}] ${l.msg}`)}</div>`
        )
        .join('')
    : `<div class="empty">暂无相关日志</div>`;
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
  const intervalSeconds = Math.max(10, Number(document.getElementById('cfgIntervalSeconds')?.value || 25));
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
    box.innerHTML = `<div class="list-row" style="padding:8px 0;">
      <span style="font-size:11px; color:var(--muted);">测试课程：暂未设置（在「课程」列表中将课程设为测试课程后，不受轮询模式与课表限制，可随时独立开关轮询）</span>
    </div>`;
    return;
  }
  box.innerHTML = testCourses
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
}

function renderCoursesList(courses) {
  const box = document.getElementById('coursesListContainer');
  if (!box) return;
  if (!courses || courses.length === 0) {
    box.innerHTML = `<div class="empty">暂无课程，请先登录账号或点击同步课程</div>`;
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

  box.innerHTML =
    modeBanner +
    sorted
      .map((c) => {
        const cName = c.name || c.courseName || '未知课程';
        const cTeacher = c.teacher || c.teacherfactor || '';
        const isTest = Boolean(c.settings?.isTestCourse);
        const testEnabled = c.settings?.testPollingEnabled !== false;
        const regEnabled = isContinuous ? true : c.settings?.pollingEnabled !== false;
        const locText = c.settings?.location?.address ? `预设位置: ${c.settings.location.address}` : '使用默认位置';

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
          ? `<button class="btn ${isTest ? '' : 'btn-ghost'} btn-sm" onclick="toggleTestCourse('${escapeHtml(c.courseId)}', ${!isTest})">${isTest ? '取消测试课' : '设为测试课'}</button>
             <button class="btn btn-ghost btn-sm" onclick='openCourseSettingModal(${JSON.stringify(c).replace(/'/g, "&#39;")})'>预设</button>`
          : `<span class="tag">只读</span>`;

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

  await api('/api/courses/settings', 'POST', {
    uid: state.selectedUid,
    courseId: c.courseId,
    location,
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
    for (let d = 1; d <= 7; d++) {
      const isTodayCol = d === nowDay && activeWeek === realWeek;
      cellsHtml += `<div class="wk-slot-bg ${isTodayCol ? 'is-today-col' : ''}" style="grid-column:${d + 1}; grid-row:${p + 1};"></div>`;
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
        return `
          <div class="wk-course-card ${item.inThisWeek ? 'in-week' : 'out-week'} ${paused ? 'is-paused' : ''}"
               onclick="onClickWakeupLesson('${escapeHtml(item.courseId || '')}', '${escapeHtml(item.name)}', '${escapeHtml(item.isDiy ? item.id || '' : '')}')"
               title="${escapeHtml(diyTag + item.name)} (${escapeHtml(weekRangeStr)} | ${escapeHtml(item.startTime || '')}-${escapeHtml(item.endTime || '')}) 点击${item.isDiy ? '编辑DIY排课规则' : '配置课程预设'}">
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

  wrap.innerHTML = `
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

function renderDiyLessonsList(diyList) {
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

async function saveUserProfileConfig() {
  const intervalSeconds = Number(document.getElementById('cfgIntervalSeconds').value || 25);
  await api('/api/schedule', 'POST', { intervalSeconds });

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
    box.innerHTML = `<div class="empty">暂无常用预设</div>`;
    return;
  }
  const isAdmin = isCurrentPanelAdmin();
  const curUser = getCurrentPanelUsername();
  const canEditSelected = canEditSelectedAccount();

  box.innerHTML = presets
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
    box.innerHTML = `<div class="empty">暂无已登录账号</div>`;
    return;
  }
  const isAdmin = isCurrentPanelAdmin();
  const curUser = getCurrentPanelUsername();

  box.innerHTML = accounts
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

async function initHelperMode(token) {
  document.getElementById('adminApp').style.display = 'none';
  document.getElementById('helperApp').style.display = 'block';
  const res = await api(`/api/helper/info?token=${encodeURIComponent(token)}`);
  if (!res.ok) {
    document.getElementById('helpTitle').textContent = res.msg || '协助链接已失效';
    return;
  }
  state.helperSession = res.session;
  state.status = { locationPresets: res.locationPresets || [] };
  document.getElementById('helpTitle').textContent = res.session.title || '协助任务';

  if (res.session.mode === 'login') {
    document.getElementById('helpLoginBox').style.display = 'block';
    document.getElementById('helpLoginMount').appendChild(document.getElementById('adminLoginPanel'));
  } else if (res.session.mode === 'captcha' && res.pendingCaptcha) {
    document.getElementById('helpCaptchaBox').style.display = 'block';
    state.currentCaptchaKey = res.session.captchaKey;
    document.getElementById('helpCaptchaMount').appendChild(document.getElementById('captchaContainer'));
    await loadCaptchaStage(state.currentCaptchaKey);
  } else {
    document.getElementById('helpSignBox').style.display = 'block';
    const sType = res.session.signType || 'normal';
    const tNames = Array.isArray(res.session.targetNames) && res.session.targetNames.length > 0
      ? res.session.targetNames.join('/')
      : '';
    document.getElementById('helpCourseName').textContent = res.session.courseName || '课程签到';
    document.getElementById('helpActiveName').textContent = tNames
      ? `${res.session.activeName || '签到活动'} · 帮 ${tNames} 一并完成签到`
      : (res.session.activeName || '签到活动');
    document.getElementById('helpSignType').textContent = SIGN_TYPE_LABELS[sType] || sType;

    // 按协助任务类型仅显示对应操作项
    const applyHelpSections = (type, needLoc, place, range) => {
      const isCode = type === 'code';
      const isPattern = type === 'pattern';
      const isQr = type === 'qrCode';
      const isLoc = type === 'location' || Boolean(needLoc);
      document.getElementById('helpSectionCode').style.display = isCode || isPattern ? 'block' : 'none';
      document.getElementById('helpPatternWrap').style.display = isPattern ? 'block' : 'none';
      document.getElementById('helpCodeLabel').textContent = isPattern ? '手势序列（点击下方九宫格或直接输入）' : '签到码';
      document.getElementById('helpSectionQr').style.display = isQr ? 'block' : 'none';
      document.getElementById('helpSectionLocation').style.display = isLoc ? 'block' : 'none';
      const locLbl = document.getElementById('helpLocationLabel');
      if (locLbl && place) {
        locLbl.textContent = `签到位置（要求：${place}${range ? ` · ${range}m内` : ''}）`;
      }
      const quickBtn = document.getElementById('helpQuickReqLocBtn');
      if (quickBtn) {
        const reqLoc = state.helperRequiredLocation;
        const hasReq = Boolean(place || (reqLoc && reqLoc.latitude && reqLoc.longitude));
        quickBtn.style.display = isLoc && hasReq ? 'inline-flex' : 'none';
      }
    };

    applyHelpSections(sType, sType === 'location', '', '');
    if (res.session.activeId) {
      try {
        const info = await api(
          `/api/courses/activeInfo?activeId=${encodeURIComponent(res.session.activeId)}&courseId=${encodeURIComponent(res.session.courseId || '')}&classId=${encodeURIComponent(res.session.classId || '')}`
        );
        if (info.ok) {
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
          applyHelpSections(info.signType || sType, info.needLocation, info.designatedPlace, info.locationRange);
        }
      } catch (_) {}
    }
  }
}

async function submitHelperSign() {
  stopCameraQrScanner();
  const res = await api('/api/helper/submit', 'POST', {
    token: state.helperToken,
    helperName: document.getElementById('helpHelperName').value.trim(),
    signCode: document.getElementById('helpSignCode').value.trim() || null,
    qrUrl: document.getElementById('helpQrUrl').value.trim() || null,
    address: document.getElementById('helpAddress').value.trim() || null,
    latitude: document.getElementById('helpLat').value.trim(),
    longitude: document.getElementById('helpLng').value.trim(),
  });
  const box = document.getElementById('helpResultBox');
  if (res.ok && res.record) {
    box.innerHTML = res.record.results.map((r) => `<div class="list-row"><span>${escapeHtml(r.name)}</span><span class="tag">${escapeHtml(r.msg)}</span></div>`).join('');
  } else {
    box.innerHTML = `<div class="tag">${escapeHtml(res.msg || '提交失败')}</div>`;
  }
}

// ============================================================================
// 实时相机扫码 & 本地图片二维码解析（支持 jsQR + BarcodeDetector 双引擎）
// ============================================================================
let _camStream = null;
let _camScanRaf = null;
let _camActiveMode = null;

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

async function toggleCameraQrScanner(prefix = "manual") {
  if (_camActiveMode === prefix && _camStream) {
    stopCameraQrScanner();
    return;
  }
  stopCameraQrScanner();

  if (!isStandaloneClientEnv() && location.protocol === "http:" && String(location.hostname || "").toLowerCase() === "ishit.pw") {
    showToast("正在切换 HTTPS 安全环境以启用相机扫码...");
    location.href = "https://ishit.pw" + location.pathname + location.search + location.hash;
    return;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast("当前浏览器限制直接调起摄像头，已为您打开拍照/选图识别");
    const section = document.getElementById(prefix === "help" ? "helpSectionQr" : "manualSectionQr");
    const fileInput = section ? section.querySelector('input[type="file"]') : null;
    if (fileInput) fileInput.click();
    return;
  }

  const stage = document.getElementById(`${prefix}CamStage`);
  const video = document.getElementById(`${prefix}CamVideo`);
  const btn = document.getElementById(`${prefix}CamBtn`);
  const targetInputId = prefix === "help" ? "helpQrUrl" : "manualQrUrl";

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
      if (video.readyState >= video.HAVE_ENOUGH_DATA && video.videoWidth > 0) {
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
            // 中心区域放大裁剪识别（应对远距离拍摄屏幕小二维码）
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
          document.getElementById(targetInputId).value = qrText;
          stopCameraQrScanner();
          showToast("扫码成功，正在自动提交签到...");
          if (prefix === "help") submitHelperSign();
          else submitManualSign();
          return;
        }
      }
      _camScanRaf = requestAnimationFrame(scanTick);
    };

    _camScanRaf = requestAnimationFrame(scanTick);
  } catch (err) {
    stopCameraQrScanner();
    showToast("无法直接调起摄像头，请使用右侧「拍照/相册识别」");
  }
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
      submitHelperSign();
    } else {
      showToast("二维码解析成功，已填入签到框");
    }
    return;
  }

  showToast("未识别到清晰二维码，请尽量截取二维码区域后重试");
}
