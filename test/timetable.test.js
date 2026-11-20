const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('旧配置、课表范围和活动接口拒绝响应', async t => {
  // 在仓库的临时目录中加载真实后端，以便复用依赖，同时隔离开发者的 store.json。
  const root = path.resolve(__dirname, '..');
  const build = path.join(root, '.build');
  fs.mkdirSync(build, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(build, 'timetable-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.cpSync(path.join(root, 'backend'), path.join(fixture, 'backend'), { recursive: true });
  fs.mkdirSync(path.join(fixture, 'data'));
  const uid = 'fixture';
  fs.writeFileSync(path.join(fixture, 'data', 'store.json'), JSON.stringify({
    currentUid: uid, accounts: [{ uid, ownerUsername: 'owner' }], schedule: { forcePolling: true },
    userScheduleConfigs: { owner: { forcePolling: true } },
    coursesCache: [{ courseId: 'a', classId: '1', name: '同名' }, { courseId: 'b', classId: '2', name: '同名' }],
    courseSettings: { a: { isTestCourse: true, testPollingEnabled: false }, b: { isTestCourse: true } }
  }));
  const core = require(path.join(fixture, 'backend/index.js'));
  let responses = [], requests = 0;
  core.cxRequest = async url => {
    if (url.includes('clazzperson')) return {};
    requests++;
    assert.ok(responses.length, '意外的网络请求');
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  };
  const { CXProtocol } = require(path.join(fixture, 'backend/protocol.js'));
  const engine = require(path.join(fixture, 'backend/engine.js'));
  const profile = core.ensureUserProfile(uid);
  const load = () => CXProtocol.getActiveList('a', '1', '0', uid);

  await t.test('全天轮询与测试课迁移，手动扫描也只处理当前课表', async () => {
    assert.equal('forcePolling' in core.getEffectiveScheduleForCxUid(uid), false);
    assert.equal(profile.courseSettings.a.pollingEnabled, false);
    assert.equal('isTestCourse' in profile.courseSettings.b, false);
    await engine.pollCoursesOnce({ forceAll: true });
    assert.equal(requests, 0);
    profile.diyLessons = [{ isDiy: true, courseId: 'a', name: '同名', dayOfWeek: new Date().getDay() || 7,
      startTime: '00:00', endTime: '23:59', weeks: [1] }];
    assert.equal(engine.getAccountActiveScheduleStatus(uid).inClass, false);
    profile.courseSettings.a.pollingEnabled = true;
    assert.equal(engine.getAccountActiveScheduleStatus(uid).inClass, true);
    responses.push({ result: 1, activeList: [] });
    await engine.pollCoursesOnce({ forceAll: true });
    assert.equal(requests, 1);
    profile.diyLessons[0].weeks = [2];
    assert.equal(engine.getAccountActiveScheduleStatus(uid).inClass, false);
    profile.diyLessons[0].weeks = [];
    core.store.schedule.masterEnabled = false;
    assert.equal(engine.getAccountActiveScheduleStatus(uid).inClass, false);
  });

  await t.test('未知活动和没有 ID 的任务都不参与签到', async () => {
    for (const viaWeb of [false, true]) {
      const items = [{ id: '1', activeType: 2, otherId: 0 }, { id: '2', activeType: 88 }, { activeType: 2 }];
      if (viaWeb) responses.push({}, { result: 1, data: { activeList: items } });
      else responses.push({ result: 1, activeList: items });
      const activities = await load();
      assert.deepEqual(activities.map(a => a.isSignActivity), [true, false, false]);
    }
  });

  await t.test('会话错误显示原文，黑名单和 429 停止请求', async () => {
    responses.push({ result: 0, errorMsg: '登录已失效' });
    await assert.rejects(load, /登录已失效/);
    responses.push({ result: 1, activeList: [] });
    assert.deepEqual(await load(), []);
    for (const [response, code] of [[{ result: 0, errorMsg: '当前ip已进入黑名单' }, 403],
      [Object.assign(new Error('HTTP 429'), { statusCode: 429 }), 429]]) {
      responses.push(response);
      await assert.rejects(load, e => e.statusCode === code && e.rateLimited === (code === 429));
      const count = requests;
      await assert.rejects(() => CXProtocol.getActiveList('b', '2', '0', 'another'), e => e.statusCode === code);
      assert.equal(requests, count);
      CXProtocol.activityCooldown = null;
    }
  });
});
