const OFFLINE_KEY = 'ishit_offline_workspace_v1';
const MODE_KEY = 'ishit_mode';
let offlineData;
let offlineTick;
const localEl = id => document.getElementById('offline-' + id);
const weekdays = ['一', '二', '三', '四', '五', '六', '日'];

function semesterStart(week) {
  const date = new Date();
  date.setDate(date.getDate() - (date.getDay() + 6) % 7 - 7 * (week - 1));
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

function createLocalProfile(status) {
  const profile = status?.effectiveProfile || {};
  const curriculum = profile.effectiveCurriculum;
  const courses = (status?.courses || []).map(c => ({
    id: JSON.stringify([String(c.courseId), String(c.classId || '')]),
    name: String(c.name || c.courseName || c.courseId),
    classroom: String(c.note || ''), enabled: c.settings?.pollingEnabled !== false
  }));
  const lessons = [];
  const imported = profile.useCurriculumSchedule === false ? [] : curriculum?.lessons || [];
  for (const l of [...imported, ...(profile.diyLessons || [])]) {
    if (!validTime(l.startTime) || !validTime(l.endTime) || l.endTime <= l.startTime || !(l.dayOfWeek >= 1 && l.dayOfWeek <= 7)) continue;
    const source = (status?.courses || []).find(c =>
      (!l.classId || String(l.classId) === String(c.classId)) &&
      (l.courseId ? String(l.courseId) === String(c.courseId) : (c.name || c.courseName) === l.name));
    const id = source ? JSON.stringify([String(source.courseId), String(source.classId || '')]) :
      JSON.stringify([String(l.courseId || l.name || '课程'), String(l.classId || '')]);
    if (!courses.some(c => c.id === id)) courses.push({ id, name: String(l.name || '课程'), classroom: String(l.location || ''), enabled: true });
    lessons.push({ course: id, day: Number(l.dayOfWeek), start: l.startTime, end: l.endTime,
      weeks: Array.isArray(l.weeks) ? [...new Set(l.weeks.map(Number).filter(w => Number.isInteger(w) && w > 0))] : [],
      enabled: l.enabled !== false && l.pollingEnabled !== false });
  }
  return {
    format: 'ishit-offline', version: 1, id: makeLocalId(), name: status?.panelAuth?.username || '本地用户',
    enabled: status?.schedule?.masterEnabled !== false, interval: Number(status?.schedule?.intervalSeconds || 25),
    buffer: Number(profile.curriculumBufferMinutes ?? 10), semester: semesterStart(Number(curriculum?.realCurrentWeek || 1)), courses, lessons
  };
}

function makeLocalId() {
  return Array.from(crypto.getRandomValues(new Uint32Array(4)), v => v.toString(16).padStart(8, '0')).join('');
}

function validTime(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function validateOffline(data) {
  const text = v => typeof v === 'string' && v.trim().length > 0;
  const integer = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
  const bool = v => typeof v === 'boolean';
  if (!data || data.format !== 'ishit-offline' || data.version !== 1 || !text(data.id) || !text(data.name) ||
      !bool(data.enabled) || !integer(data.interval, 3, 300) || !integer(data.buffer, 0, 180) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(data.semester) || !Array.isArray(data.courses) || !Array.isArray(data.lessons)) throw Error('配置格式或版本不受支持');
  const monday = new Date(data.semester + 'T00:00:00Z');
  if (monday.getUTCDay() !== 1 || monday.toISOString().slice(0, 10) !== data.semester) throw Error('学期起始日期必须为周一');
  const ids = new Set();
  for (const c of data.courses) {
    if (!c || !text(c.id) || ids.has(c.id) || !text(c.name) || typeof c.classroom !== 'string' || !bool(c.enabled)) throw Error('课程配置无效');
    ids.add(c.id);
  }
  for (const l of data.lessons) {
    if (!l || !ids.has(l.course) || !integer(l.day, 1, 7) || !validTime(l.start) || !validTime(l.end) ||
        l.end <= l.start || !bool(l.enabled) || !Array.isArray(l.weeks) ||
        !l.weeks.every(w => integer(w, 1, 100))) throw Error('排课时间、周次或课程引用无效');
  }
  return data;
}

function saveOffline(next) {
  validateOffline(next);
  localStorage.setItem(OFFLINE_KEY, JSON.stringify(next));
  offlineData = next;
}

function enterOfflineMode() {
  try {
    if (!localStorage.getItem(OFFLINE_KEY)) saveOffline(createLocalProfile(state.status));
    window.IshitAndroidBridge?.setOfflineMode?.(true);
    localStorage.setItem(MODE_KEY, 'offline');
    location.reload();
  } catch (err) { showToast(err.message); }
}

function leaveOfflineMode() {
  localStorage.removeItem(MODE_KEY);
  window.IshitAndroidBridge?.setOfflineMode?.(false);
  location.replace(location.pathname);
}

function lessonNamesNow(data, now) {
  const day = (now.getDay() + 6) % 7 + 1;
  const date = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const week = Math.floor((date - Date.parse(data.semester)) / 604800000) + 1;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const toMinutes = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  const active = data.lessons.filter(l => data.enabled && l.enabled && l.day === day &&
    (!l.weeks.length || l.weeks.includes(week)) && minutes >= toMinutes(l.start) - data.buffer &&
    minutes <= toMinutes(l.end) + data.buffer);
  return data.courses.filter(c => c.enabled && active.some(l => l.course === c.id)).map(c => c.name);
}

function updateOfflineClock() {
  clearTimeout(offlineTick);
  if (!offlineData || document.hidden || !document.hasFocus()) return;
  const names = lessonNamesNow(offlineData, new Date());
  localEl('now').textContent = !offlineData.enabled ? '课表检查已暂停' : names.length ? '当前课程 · ' + names.join('、') : '当前时段没有启用的课程';
  if (offlineData.enabled) offlineTick = setTimeout(updateOfflineClock, offlineData.interval * 1000);
}

function renderOffline() {
  const d = offlineData;
  for (const key of ['name', 'semester', 'buffer', 'interval']) localEl(key).value = d[key];
  localEl('enabled').checked = d.enabled;
  const select = localEl('course');
  const previous = select.value;
  select.replaceChildren(...d.courses.map(c => new Option(c.name + (c.classroom ? ' · ' + c.classroom : ''), c.id)));
  if (d.courses.some(c => c.id === previous)) select.value = previous;
  localEl('add-lesson').disabled = !d.courses.length;
  const list = localEl('list');
  list.replaceChildren();
  const button = (label, fn) => {
    const b = document.createElement('button');
    b.className = 'btn btn-ghost btn-sm'; b.textContent = label; b.onclick = fn;
    return b;
  };
  for (const c of d.courses) {
    const group = document.createElement('section');
    const title = document.createElement('h3'); title.textContent = c.name + (c.classroom ? ' · ' + c.classroom : '');
    group.append(title, button(c.enabled ? '暂停本课' : '启用本课', () => editOffline(n => { n.courses.find(x => x.id === c.id).enabled = !c.enabled; })),
      button('删除课程', () => {
        if (confirm('删除《' + c.name + '》及其排课？')) editOffline(n => {
          n.courses = n.courses.filter(x => x.id !== c.id); n.lessons = n.lessons.filter(x => x.course !== c.id);
        });
      }));
    d.lessons.forEach((l, index) => {
      if (l.course !== c.id) return;
      const row = document.createElement('div'); row.className = 'list-row';
      const span = document.createElement('span');
      span.textContent = '周' + weekdays[l.day - 1] + ' ' + l.start + '–' + l.end + ' · ' + (l.weeks.length ? '第 ' + l.weeks.join('、') + ' 周' : '每周') + (l.enabled ? '' : ' · 已暂停');
      row.append(span, button(l.enabled ? '暂停时段' : '启用时段', () => editOffline(n => { n.lessons[index].enabled = !l.enabled; })),
        button('移除', () => editOffline(n => n.lessons.splice(index, 1))));
      group.append(row);
    });
    list.append(group);
  }
  if (!d.courses.length) list.textContent = '尚无本地课程';
  updateOfflineClock();
}

function editOffline(change) {
  try {
    const next = JSON.parse(JSON.stringify(offlineData));
    change(next); saveOffline(next); renderOffline();
    return true;
  } catch (err) { showToast(err.message); return false; }
}

function exportOffline() {
  const json = JSON.stringify(offlineData, null, 2);
  if (window.IshitAndroidBridge?.exportOfflineConfig) {
    window.IshitAndroidBridge.exportOfflineConfig(json);
    return;
  }
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = 'ISHIT-offline.json';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function openOfflineWorkspace() {
  document.documentElement.classList.add('offline-mode');
  document.getElementById('offline-workspace').hidden = false;
  const caption = document.querySelector('#panelLoginApp .win-login-titlebar');
  if (caption) localEl('workspace').prepend(caption.cloneNode(true));
  const file = localEl('file');
  file.onchange = async () => {
    try {
      if (!file.files.length) return;
      const next = validateOffline(JSON.parse(await file.files[0].text()));
      if (offlineData && !confirm('用导入文件替换当前设备的全部离线配置？')) return;
      saveOffline(next); renderOffline(); showToast('已导入全部离线配置');
    } catch (err) { showToast('导入失败 · ' + err.message); }
    finally { file.value = ''; }
  };
  localEl('settings').onsubmit = e => {
    e.preventDefault();
    if (editOffline(n => {
      n.name = localEl('name').value.trim(); n.enabled = localEl('enabled').checked;
      n.interval = Number(localEl('interval').value); n.buffer = Number(localEl('buffer').value); n.semester = localEl('semester').value;
    })) showToast('设置已保存');
  };
  localEl('new-course').onsubmit = e => {
    e.preventDefault();
    if (editOffline(n => n.courses.push({ id: makeLocalId(), name: localEl('title').value.trim(),
      classroom: localEl('room').value.trim(), enabled: true }))) e.target.reset();
  };
  localEl('new-lesson').onsubmit = e => {
    e.preventDefault();
    const weeks = localEl('weeks').value.trim();
    editOffline(n => n.lessons.push({ course: localEl('course').value, day: Number(localEl('day').value),
      start: localEl('start').value, end: localEl('end').value, enabled: true,
      weeks: weeks ? [...new Set(weeks.split(/[,，\s]+/).map(Number))] : [] }));
  };
  document.addEventListener('visibilitychange', updateOfflineClock);
  window.addEventListener('focus', updateOfflineClock);
  window.addEventListener('blur', () => clearTimeout(offlineTick));
  try {
    const raw = localStorage.getItem(OFFLINE_KEY);
    if (raw === null) saveOffline(createLocalProfile(null));
    else offlineData = validateOffline(JSON.parse(raw));
    renderOffline();
  } catch (err) { localEl('now').textContent = '本地配置读取失败，请导入备份 · ' + err.message; }
}
