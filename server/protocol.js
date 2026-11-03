const {
  Constant,
  EncryptionUtil,
  store,
  saveStore,
  ensureUserProfile,
  cxRequest,
} = require('./index.js');

class CXProtocol {
  static async loginWeb(username, password, tempKey = '__login') {
    store.tempCookies[tempKey] = {};
    const unameCipher = EncryptionUtil.aesCbcEncrypt(username, Constant.webLoginKey);
    const pwdCipher = EncryptionUtil.aesCbcEncrypt(password, Constant.webLoginKey);
    return await cxRequest('https://passport2.chaoxing.com/fanyalogin', {
      method: 'POST',
      body: {
        fid: '-1',
        uname: unameCipher,
        password: pwdCipher,
        t: 'true',
        forbidotherlogin: '0',
        validate: '',
      },
      tempSessionKey: tempKey,
    });
  }

  static async sendSmsCode(phone, tempKey = '__login') {
    const timeStampMS = String(Date.now());
    const enc = EncryptionUtil.md5Hash(phone + Constant.sendCaptchaKey + timeStampMS);
    return await cxRequest('https://passport2-api.chaoxing.com/api/sendcaptcha', {
      method: 'POST',
      body: { to: phone, countrycode: '86', time: timeStampMS, enc },
      tempSessionKey: tempKey,
    });
  }

  static async loginApp(loginType, username, code, tempKey = '__login') {
    store.tempCookies[tempKey] = {};
    const loginInfo = EncryptionUtil.aesEcbEncrypt(JSON.stringify({ uname: username, code }), Constant.appLoginKey);
    const formData = {
      logininfo: loginInfo,
      loginType: String(loginType),
      roleSelect: 'true',
      entype: '1',
    };
    if (String(loginType) === '2') formData.countrycode = '86';
    return await cxRequest('https://passport2-api.chaoxing.com/v11/loginregister?cx_xxt_passport=json', {
      method: 'POST',
      body: formData,
      tempSessionKey: tempKey,
    });
  }

  // 修复扫码登录：在同一个 tempSessionKey Cookie 会话内获取 uuid + createqr 二维码流并转成 Base64 DataURL
  static async getQRCodeData(tempKey = '__qr') {
    store.tempCookies[tempKey] = {};
    const data = await cxRequest('https://passport2.chaoxing.com/refreshQRCode', {
      method: 'POST',
      tempSessionKey: tempKey,
    });
    if (data && data.uuid && data.enc) {
      const qrBuf = await cxRequest(
        `https://passport2.chaoxing.com/createqr?uuid=${encodeURIComponent(data.uuid)}&fid=-1`,
        {
          method: 'GET',
          tempSessionKey: tempKey,
          rawBuffer: true,
        }
      );
      const base64Img = Buffer.isBuffer(qrBuf)
        ? `data:image/jpeg;base64,${qrBuf.toString('base64')}`
        : `https://passport2.chaoxing.com/createqr?uuid=${encodeURIComponent(data.uuid)}&fid=-1`;
      return {
        ...data,
        qrImageUrl: base64Img,
      };
    }
    return data;
  }

  static async checkQRAuthStatus(uuid, enc, tempKey = '__qr') {
    return await cxRequest('https://passport2.chaoxing.com/getauthstatus/v2', {
      method: 'POST',
      body: { enc, uuid, doubleFactorLogin: '0', forbidotherlogin: '0' },
      tempSessionKey: tempKey,
    });
  }

  static async fetchUserInfo({ userId = undefined, tempSessionKey = null } = {}) {
    const deviceId = EncryptionUtil.getUniqueId();
    const deviceInfoPayload = {
      app_name: 'com.chaoxing.mobile',
      app_ver: '6.7.4',
      board: 'caiman',
      brand: 'google',
      cdid: deviceId,
      cdtype: 'Pixel 9 Pro',
      cpu_ar: 'arm64-v8a,armeabi-v7a,armeabi',
      device_id: deviceId,
      dpi: '440',
      hardware: 'caiman',
      mediaDrmId: '',
      oaid: '1004',
      os_lang: '',
      os_name: 'REL',
      os_ver: '16',
      platform: 'android',
      resolution: '1080*2243',
      time_stamp: Date.now(),
    };
    const encryptedData = EncryptionUtil.rsaEncrypt(JSON.stringify(deviceInfoPayload));
    const res = await cxRequest('https://sso.chaoxing.com/apis/login/userLogin4Uname.do', {
      method: 'POST',
      body: { data: encryptedData },
      userId,
      tempSessionKey,
    });

    if (res && res.result === 1 && res.msg) {
      const data = res.msg;
      const uid = String(data.puid || '');
      let parsedDeviceInfo = {};
      if (data.clientId) {
        const dec = EncryptionUtil.rsaDecrypt(data.clientId);
        try { parsedDeviceInfo = JSON.parse(dec); } catch (_) {}
      }
      let imAccount = null;
      if (data.accountInfo && data.accountInfo.imAccount) {
        const im = data.accountInfo.imAccount;
        imAccount = {
          userName: im.username,
          password: EncryptionUtil.desEcbDecrypt(im.password, Constant.imKey),
        };
      }
      const user = {
        uid,
        name: data.name || '未知用户',
        avatar: data.pic || `https://photo.chaoxing.com/p/${uid}_80`,
        phone: data.phone || '未知手机号',
        school: data.schoolname || '未知学校',
        platform: 'chaoxing',
        deviceInfo: parsedDeviceInfo,
        imAccount,
        status: true,
      };
      if (tempSessionKey && store.tempCookies[tempSessionKey]) {
        store.cookies[uid] = { ...(store.cookies[uid] || {}), ...store.tempCookies[tempSessionKey] };
        delete store.tempCookies[tempSessionKey];
      }
      ensureUserProfile(uid);
      return user;
    }
    return null;
  }

  // 读取学习通原生课表 (https://kb.chaoxing.com/pc/curriculum/getMyLessons)
  static async fetchCurriculum(userId = store.currentUid) {
    if (!userId) return null;
    const res = await cxRequest('https://kb.chaoxing.com/pc/curriculum/getMyLessons', { userId });
    if (!res || res.result !== 1 || !res.data) return null;

    const cur = res.data.curriculum || {};
    const timeCfg = Array.isArray(cur.lessonTimeConfigArray) && cur.lessonTimeConfigArray.length > 0
      ? cur.lessonTimeConfigArray
      : [
          '08:00-08:50', '09:00-09:50', '10:10-11:00', '11:10-12:00',
          '14:00-14:50', '15:00-15:50', '16:10-17:00', '17:10-18:00',
          '19:00-19:50', '20:00-20:50', '21:00-21:50', '22:00-22:50',
        ];

    const lessons = (res.data.lessonArray || []).map((item) => {
      const beginNum = Number(item.beginNumber || 1);
      const len = Number(item.length || 1);
      const startSec = timeCfg[beginNum - 1] || '08:00-08:50';
      const endSec = timeCfg[Math.min(timeCfg.length - 1, beginNum + len - 2)] || startSec;
      const startPart = (startSec.split('-')[0] || '08:00').trim();
      const endPart = (endSec.split('-')[1] || '09:50').trim();
      const fmtTime = (t) => t.split(':').map((n) => n.padStart(2, '0')).join(':');
      const weeks = String(item.weeks || '')
        .split(',')
        .map((w) => Number(w.trim()))
        .filter(Boolean);

      return {
        lessonId: String(item.lessonId || ''),
        courseId: String(item.courseId || ''),
        classId: String(item.classId || ''),
        name: item.name || '未知课程',
        teacherName: item.teacherName || '',
        location: item.location || '',
        dayOfWeek: Number(item.dayOfWeek || 1),
        beginNumber: beginNum,
        length: len,
        startTime: fmtTime(startPart),
        endTime: fmtTime(endPart),
        weeks,
      };
    });

    const parsed = {
      realCurrentWeek: Number(cur.realCurrentWeek || cur.currentWeek || 1),
      schoolYear: cur.schoolYear || '',
      semester: cur.semester || 1,
      lessonTimeConfigArray: timeCfg,
      lessons,
      updatedAt: Date.now(),
    };

    const prof = ensureUserProfile(userId);
    prof.curriculumCache = parsed;
    saveStore();
    return parsed;
  }

  static async getCoursesList(userId = store.currentUid) {
    if (!userId) return [];
    const data = await cxRequest(
      'https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json&getTchClazzType=1&mcode=',
      { userId }
    );
    if (!data || data.result !== 1 || !Array.isArray(data.channelList)) return [];

    const courses = [];
    for (const ch of data.channelList) {
      if (ch.content && ch.content.course && Array.isArray(ch.content.course.data) && ch.content.course.data[0]) {
        const c = ch.content;
        const cd = c.course.data[0];
        if (c.state === 0) {
          courses.push({
            courseId: String(cd.id),
            classId: String(c.id),
            cpi: String(c.cpi || ''),
            image: cd.imageurl || '',
            name: cd.name || '未知课程',
            teacher: cd.teacherfactor || '未知教师',
            schools: cd.schools || '',
            note: c.name || '',
            state: true,
          });
        }
      }
    }
    const prof = ensureUserProfile(userId);
    prof.coursesCache = courses;
    saveStore();
    return courses;
  }

  static async getActiveList(courseId, classId, cpi, userId = store.currentUid) {
    if (!userId) return [];
    CXProtocol._activeCooldowns = CXProtocol._activeCooldowns || {};
    CXProtocol._joinTimeCache = CXProtocol._joinTimeCache || {};
    CXProtocol._signTypeCache = CXProtocol._signTypeCache || {};

    const cdKey = userId + '_' + courseId + '_' + classId;
    const signTypeMap = { 0: 'normal', 2: 'qrCode', 3: 'pattern', 4: 'location', 5: 'code' };

    const inferSignTypeFromName = (nameOne) => {
      const s = String(nameOne || '');
      if (s.includes('二维码') || s.includes('扫码')) return 'qrCode';
      if (s.includes('位置')) return 'location';
      if (s.includes('手势')) return 'pattern';
      if (s.includes('签到码')) return 'code';
      return null;
    };

    // 1. 优先走移动端加密接口 ppt/activeAPI/taskactivelist（带 DES 签名 _ext + enc，几乎无频控限制）
    let joinClassTime = CXProtocol._joinTimeCache[cdKey] || '';
    if (!joinClassTime) {
      try {
        const joinRes = await cxRequest('https://mooc1-api.chaoxing.com/gas/clazzperson', {
          params: {
            courseid: courseId,
            clazzid: classId,
            userid: userId,
            personid: cpi,
            view: 'json',
            fields: 'clazzid,popupagreement,personid,clazzname,createtime',
          },
          userId,
        });
        joinClassTime = joinRes?.data?.[0]?.createtime || '';
        if (joinClassTime) CXProtocol._joinTimeCache[cdKey] = joinClassTime;
      } catch (_) {}
    }

    const appParams = EncryptionUtil.getEncParams({
      courseId: String(courseId),
      classId: String(classId),
      uid: String(userId),
      cpi: String(cpi),
      joinclasstime: String(joinClassTime),
    });

    let taskData = null;
    try {
      taskData = await cxRequest('https://mobilelearn.chaoxing.com/ppt/activeAPI/taskactivelist', {
        params: appParams,
        userId,
      });
    } catch (_) {}

    const appRateLimited =
      Boolean(taskData?.errorMsg && String(taskData.errorMsg).includes('频繁')) ||
      (typeof taskData === 'string' && taskData.includes('频繁')) ||
      (taskData && Number(taskData.result) === 0 && Boolean(taskData.errorMsg));

    if (
      taskData &&
      !appRateLimited &&
      Number(taskData.result ?? 1) !== 0 &&
      Array.isArray(taskData.activeList)
    ) {
      delete CXProtocol._activeCooldowns[cdKey];
      const result = [];
      for (const item of taskData.activeList) {
        const id = String(item.id);
        const activeType = Number(item.activeType || 0);
        const status = Number(item.status) === 1;
        const isSignActivity = [2, 54, 74].includes(activeType);
        let signType = null;
        if (isSignActivity) {
          if (item.otherId !== undefined && item.otherId !== null) {
            signType = signTypeMap[Number(item.otherId)] || 'normal';
            CXProtocol._signTypeCache[id] = signType;
          } else if (CXProtocol._signTypeCache[id]) {
            signType = CXProtocol._signTypeCache[id];
          } else {
            signType = inferSignTypeFromName(item.nameOne);
            // 若该活动正在进行中，或历史活动名称为自定义名称无法直接看出类型，调用一次无频控的 getActiveInfoWeb 精确补全并缓存
            if (!signType && status) {
              try {
                const info = await this.getActiveInfoWeb(id, userId);
                if (info && info.otherId !== undefined && info.otherId !== null) {
                  signType = signTypeMap[Number(info.otherId)] || 'normal';
                  CXProtocol._signTypeCache[id] = signType;
                }
              } catch (_) {}
            }
            if (!signType) signType = 'normal';
          }
        }

        result.push({
          id,
          type: activeType,
          isSignActivity,
          name: item.nameOne || '课堂活动',
          description: item.nameTwo || item.nameFour || '',
          url: item.url || '',
          startTime: item.startTime || 0,
          attendNum: item.attendNum || 0,
          status,
          signType,
        });
      }
      return result;
    }

    // 2. 当移动端接口异常时，才回退调用 Web 端 v2/apis/active/student/activelist
    const now = Date.now();
    const cooldownUntil = CXProtocol._activeCooldowns[cdKey] || 0;
    if (cooldownUntil > now) {
      const remainSec = Math.ceil((cooldownUntil - now) / 1000);
      const err = new Error('学习通接口频控冷却中(剩余' + remainSec + 's)');
      err.rateLimited = true;
      err.inCooldown = true;
      throw err;
    }

    let webTaskData = null;
    try {
      webTaskData = await cxRequest('https://mobilelearn.chaoxing.com/v2/apis/active/student/activelist', {
        params: {
          fid: '0',
          courseId: String(courseId),
          classId: String(classId),
          showNotStartedActive: '0',
          _: String(Date.now()),
        },
        userId,
      });
    } catch (_) {}

    const webRateLimited =
      Boolean(webTaskData?.errorMsg && String(webTaskData.errorMsg).includes('频繁')) ||
      (typeof webTaskData === 'string' && webTaskData.includes('频繁'));

    if (webRateLimited) {
      CXProtocol._activeCooldowns[cdKey] = Date.now() + 95 * 1000;
      const err = new Error('学习通接口触发频控(请勿频繁操作)，已自动进入 95s 退避冷却');
      err.rateLimited = true;
      throw err;
    }

    if (webTaskData && webTaskData.result === 1 && Array.isArray(webTaskData?.data?.activeList)) {
      delete CXProtocol._activeCooldowns[cdKey];
      const result = [];
      for (const w of webTaskData.data.activeList) {
        const id = String(w.id);
        const activeType = Number(w.activeType ?? w.type ?? 0);
        const status = Number(w.status) === 1;
        const isSignActivity = [2, 54, 74].includes(activeType);
        let signType = null;
        if (isSignActivity) {
          signType =
            w.otherId !== undefined && w.otherId !== null
              ? signTypeMap[Number(w.otherId)] || 'normal'
              : 'normal';
          CXProtocol._signTypeCache[id] = signType;
        }
        result.push({
          id,
          type: activeType,
          isSignActivity,
          name: w.nameOne || '课堂活动',
          description: status ? w.nameFour || w.nameTwo || '' : w.nameTwo || w.nameFour || '',
          url: w.url || '',
          startTime: w.startTime || 0,
          attendNum: w.attendNum || 0,
          status,
          signType,
        });
      }
      return result;
    }

    if (appRateLimited) {
      CXProtocol._activeCooldowns[cdKey] = Date.now() + 60 * 1000;
      const err = new Error('学习通接口触发频控(请勿频繁操作)，已切换账号或进入退避冷却');
      err.rateLimited = true;
      throw err;
    }

    return [];
  }

  static async getActiveInfoWeb(activeId, userId = store.currentUid) {
    const res = await cxRequest(
      `https://mobilelearn.chaoxing.com/v2/apis/active/getPPTActiveInfo?activeId=${encodeURIComponent(activeId)}`,
      { userId }
    );
    return res?.result === 1 ? res.data : null;
  }

  static async getAttendInfoWeb(activeId, userId) {
    const res = await cxRequest(
      `https://mobilelearn.chaoxing.com/v2/apis/sign/getAttendInfo?activeId=${encodeURIComponent(activeId)}&moreClassAttendEnc=`,
      { userId }
    );
    return res?.result === 1 ? res.data : null;
  }

  static async checkSignCode(activeId, signCode, userId = store.currentUid) {
    const res = await cxRequest('https://mobilelearn.chaoxing.com/widget/sign/pcStuSignController/checkSignCode', {
      params: { activeId, signCode },
      userId,
    });
    return res?.errorMsg || null;
  }

  static async getSignDetail(activeId, code = null, userId = store.currentUid) {
    let url = `https://mobilelearn.chaoxing.com/newsign/signDetail?activePrimaryId=${encodeURIComponent(activeId)}&type=1`;
    if (code) url += `&msg=${encodeURIComponent(code)}`;
    return await cxRequest(url, { userId });
  }

  static async getClassStudentCount(classId, userId = store.currentUid) {
    if (!classId) return 0;
    CXProtocol._classStudentCountCache = CXProtocol._classStudentCountCache || {};
    const key = String(classId);
    const cached = CXProtocol._classStudentCountCache[key];
    if (cached && cached.count > 0 && Date.now() - cached.ts < 6 * 3600 * 1000) {
      return cached.count;
    }
    try {
      const res = await cxRequest('https://mooc1-api.chaoxing.com/gas/clazz', {
        params: {
          id: key,
          fields: 'id,name,studentcount,courseid',
          view: 'json',
        },
        userId,
      });
      const count = Number(res?.data?.[0]?.studentcount || 0);
      if (count > 0) {
        CXProtocol._classStudentCountCache[key] = { count, ts: Date.now() };
      }
      return count;
    } catch (_) {
      return cached?.count || 0;
    }
  }

  static async getSignAttendStats(activeId, courseId = '', classId = '', userId = store.currentUid) {
    if (!activeId) return { signedCount: 0, totalCount: 0, signRatio: 0 };
    let signedCount = 0;
    let totalCount = 0;
    let resolvedClassId = String(classId || '');
    let startTimeMs = 0;
    let endTimeMs = 0;
    let isOver = false;

    try {
      const detail = await this.getSignDetail(activeId, null, userId);
      if (detail && typeof detail === 'object') {
        if (detail.attendNum !== undefined && detail.attendNum !== null) {
          signedCount = Math.max(0, Number(detail.attendNum) || 0);
        }
        if (!resolvedClassId && detail.clazzId) {
          resolvedClassId = String(detail.clazzId);
        }
        if (detail.startTime && typeof detail.startTime === 'object' && detail.startTime.time) {
          startTimeMs = Number(detail.startTime.time) || 0;
        } else if (Number(detail.startTime) > 0) {
          startTimeMs = Number(detail.startTime);
        }
        if (detail.endTime && typeof detail.endTime === 'object' && detail.endTime.time) {
          endTimeMs = Number(detail.endTime.time) || 0;
        } else if (Number(detail.endTime) > 0) {
          endTimeMs = Number(detail.endTime);
        }
        if (Number(detail.status) === 2 || Number(detail.isOver) === 1) {
          isOver = true;
        }
      }
    } catch (_) {}

    if (resolvedClassId) {
      totalCount = await this.getClassStudentCount(resolvedClassId, userId);
    }

    if (totalCount <= 0 && courseId && resolvedClassId) {
      try {
        const attRes = await cxRequest('https://mobilelearn.chaoxing.com/widget/sign/pcTeaSignController/getAttendList', {
          params: {
            activeId: String(activeId),
            courseId: String(courseId),
            classId: resolvedClassId,
            fid: '0',
          },
          userId,
        });
        if (attRes && attRes.result === 1 && attRes.data) {
          const yq = Number(attRes.data.yiqian || 0);
          const wq = Number(attRes.data.weiqian || 0);
          if (yq >= 0) signedCount = Math.max(signedCount, yq);
          if (yq + wq > 0) totalCount = yq + wq;
        }
      } catch (_) {}
    }

    const signRatio = totalCount > 0 ? Number((signedCount / totalCount).toFixed(4)) : 0;
    return {
      signedCount,
      totalCount,
      signRatio,
      classId: resolvedClassId,
      startTimeMs,
      endTimeMs,
      isOver,
    };
  }
  static async getSlideCaptcha(userId, referer = 'https://mobilelearn.chaoxing.com/pptSign/stuSignajax') {
    const timestamp = Date.now();
    const confText = await cxRequest('https://captcha.chaoxing.com/captcha/get/conf', {
      params: {
        callback: 'cx_captcha_function',
        captchaId: Constant.cxCaptchaId,
        _: String(timestamp),
      },
      userId,
    });
    const confMatch = String(confText || '').match(/cx_captcha_function\((.+)\)/);
    if (!confMatch) return null;
    const conf = JSON.parse(confMatch[1]);
    const serviceTime = conf.t;
    const captchaKey = EncryptionUtil.md5Hash(`${serviceTime}${EncryptionUtil.getUuid()}`);
    const token = `${EncryptionUtil.md5Hash(`${serviceTime}${Constant.cxCaptchaId}slide${captchaKey}`)}:${serviceTime + 300000}`;
    const iv = EncryptionUtil.md5Hash(`${Constant.cxCaptchaId}slide${timestamp}${EncryptionUtil.getUuid()}`);

    const imgText = await cxRequest('https://captcha.chaoxing.com/captcha/get/verification/image', {
      params: {
        callback: 'cx_captcha_function',
        captchaId: Constant.cxCaptchaId,
        type: 'slide',
        version: '1.1.20',
        captchaKey,
        token,
        referer,
        iv,
        _: String(timestamp + 1),
      },
      userId,
    });
    const imgMatch = String(imgText || '').match(/cx_captcha_function\((.+)\)/);
    if (!imgMatch) return null;
    const imgJson = JSON.parse(imgMatch[1]);
    const shadeUrl = imgJson.imageVerificationVo?.shadeImage || '';
    const cutoutUrl = imgJson.imageVerificationVo?.cutoutImage || '';
    let shadeDataUrl = shadeUrl;
    let cutoutDataUrl = cutoutUrl;
    try {
      if (shadeUrl) {
        const sBuf = await cxRequest(shadeUrl, {
          headers: { Referer: 'https://captcha.chaoxing.com/' },
          userId,
          rawBuffer: true,
        });
        if (Buffer.isBuffer(sBuf) && sBuf.length > 64) {
          shadeDataUrl = `data:image/jpeg;base64,${sBuf.toString('base64')}`;
        }
      }
      if (cutoutUrl) {
        const cBuf = await cxRequest(cutoutUrl, {
          headers: { Referer: 'https://captcha.chaoxing.com/' },
          userId,
          rawBuffer: true,
        });
        if (Buffer.isBuffer(cBuf) && cBuf.length > 64) {
          cutoutDataUrl = `data:image/png;base64,${cBuf.toString('base64')}`;
        }
      }
    } catch (_) {}

    return {
      timestamp,
      iv,
      referer,
      token: imgJson.token,
      shadeImage: shadeDataUrl,
      cutoutImage: cutoutDataUrl,
      shadeImageUrl: shadeDataUrl,
      cutoutImageUrl: cutoutDataUrl,
    };
  }

  static async submitSlideCaptcha({ userId, xValue, token, iv, timestamp, referer }) {
    const resText = await cxRequest('https://captcha.chaoxing.com/captcha/check/verification/result', {
      params: {
        callback: 'cx_captcha_function',
        captchaId: Constant.cxCaptchaId,
        type: 'slide',
        token,
        textClickArr: `[{"x":${Math.round(Number(xValue))}}]`,
        coordinate: '[]',
        runEnv: '10',
        version: '1.1.20',
        t: 'a',
        iv,
        _: String(Number(timestamp) + 2),
      },
      headers: { Referer: referer || 'https://mobilelearn.chaoxing.com/pptSign/stuSignajax' },
      userId,
    });
    const match = String(resText || '').match(/cx_captcha_function\((.+)\)/);
    if (!match) return null;
    const parsed = JSON.parse(match[1]);
    if (parsed.error === 0 && parsed.result === true && parsed.extraData) {
      const extra = JSON.parse(parsed.extraData);
      return extra.validate || null;
    }
    return null;
  }

  // 国测局/国际坐标转换：OpenStreetMap & 浏览器 GPS (WGS-84) -> GCJ-02 -> 百度地图 (BD-09)
  static _transformLat(x, y) {
    const PI = Math.PI;
    let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
    ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
    ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0;
    return ret;
  }

  static _transformLng(x, y) {
    const PI = Math.PI;
    let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
    ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
    ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0;
    return ret;
  }

  static isInsideChina(lat, lng) {
    const la = Number(lat);
    const ln = Number(lng);
    return ln >= 72.004 && ln <= 137.8347 && la >= 0.8293 && la <= 55.8271;
  }

  static wgs84ToGcj02(lat, lng) {
    const la = Number(lat);
    const ln = Number(lng);
    if (!this.isInsideChina(la, ln)) return { lat: la, lng: ln };
    const PI = Math.PI;
    const A = 6378245.0;
    const EE = 0.00669342162296594323;
    let dLat = this._transformLat(ln - 105.0, la - 35.0);
    let dLng = this._transformLng(ln - 105.0, la - 35.0);
    const radLat = (la / 180.0) * PI;
    let magic = Math.sin(radLat);
    magic = 1 - EE * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
    dLng = (dLng * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI);
    return { lat: la + dLat, lng: ln + dLng };
  }

  static gcj02ToBd09(lat, lng) {
    const X_PI = (Math.PI * 3000.0) / 180.0;
    const z = Math.sqrt(lng * lng + lat * lat) + 0.00002 * Math.sin(lat * X_PI);
    const theta = Math.atan2(lat, lng) + 0.000003 * Math.cos(lng * X_PI);
    return {
      lat: z * Math.sin(theta) + 0.006,
      lng: z * Math.cos(theta) + 0.0065,
    };
  }

  static wgs84ToBd09(lat, lng) {
    const gcj = this.wgs84ToGcj02(Number(lat), Number(lng));
    return this.gcj02ToBd09(gcj.lat, gcj.lng);
  }

  static bd09ToGcj02(bdLat, bdLng) {
    const X_PI = (Math.PI * 3000.0) / 180.0;
    const x = Number(bdLng) - 0.0065;
    const y = Number(bdLat) - 0.006;
    const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * X_PI);
    const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * X_PI);
    return {
      lat: z * Math.sin(theta),
      lng: z * Math.cos(theta),
    };
  }

  static gcj02ToWgs84(gcjLat, gcjLng) {
    const lat = Number(gcjLat);
    const lng = Number(gcjLng);
    if (!this.isInsideChina(lat, lng)) return { lat, lng };
    const d = this.wgs84ToGcj02(lat, lng);
    return {
      lat: lat * 2 - d.lat,
      lng: lng * 2 - d.lng,
    };
  }

  static bd09ToWgs84(bdLat, bdLng) {
    const gcj = this.bd09ToGcj02(Number(bdLat), Number(bdLng));
    return this.gcj02ToWgs84(gcj.lat, gcj.lng);
  }
  static buildLocationPayload(user, address, latitude, longitude, coordSystem = 'wgs84') {
    let lat = Number(latitude);
    let lng = Number(longitude);
    if (coordSystem === 'wgs84') {
      const bd = this.wgs84ToBd09(lat, lng);
      lat = Number(bd.lat.toFixed(6));
      lng = Number(bd.lng.toFixed(6));
    } else if (coordSystem === 'gcj02') {
      const bd = this.gcj02ToBd09(lat, lng);
      lat = Number(bd.lat.toFixed(6));
      lng = Number(bd.lng.toFixed(6));
    } else {
      lat = Number(lat.toFixed(6));
      lng = Number(lng.toFixed(6));
    }
    const timeStampMS = String(Date.now());
    const cxcid = user?.deviceInfo?.cid || '';
    const sc = user?.deviceInfo?.sc || '';

    const signConfigMap = {
      cxcid,
      cxtime: timeStampMS,
      data: `{"latitude":${lat},"longitude":${lng},"address":"${address}"}`,
    };
    const sortedKeys = Object.keys(signConfigMap).sort();
    let buf = '';
    for (const k of sortedKeys) buf += `${k}${signConfigMap[k]}`;
    buf += sc;
    const signToken = EncryptionUtil.md5Hash(buf);

    return {
      bdLat: lat,
      bdLng: lng,
      locationJson: JSON.stringify({ result: 1, address, longitude: lng, latitude: lat }),
      locationResultJson: JSON.stringify({
        result: 1,
        latitude: lat,
        longitude: lng,
        mockData: { strategy: 0, probability: -1 },
        locType: 161,
        address,
        signConfig: { signToken, cxcid, cxtime: timeStampMS },
      }),
    };
  }

  static async uploadImageToPan(user, imageBuffer) {
    const tokenRes = await cxRequest('https://pan-yz.chaoxing.com/api/token/uservalid', { userId: user.uid });
    const token = tokenRes?._token;
    if (!token) return null;

    const crc = EncryptionUtil.getBufferCRC(imageBuffer);
    const crcRes = await cxRequest('https://pan-yz.chaoxing.com/api/crcStorageStatus', {
      params: { puid: user.uid, crc, _token: token },
      userId: user.uid,
    });
    if (crcRes?.result && crcRes?.exist && crcRes?.data?.objectid) {
      return crcRes.data.objectid;
    }

    const boundary = `----ChaosBoundary${EncryptionUtil.getUniqueId()}`;
    const fileName = `${Date.now()}.jpg`;
    const p1 = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="puid"\r\n\r\n${user.uid}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: image/jpeg\r\n\r\n`,
      'utf8'
    );
    const p2 = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const multipartBody = Buffer.concat([p1, imageBuffer, p2]);

    const uploadRes = await cxRequest(
      `https://pan-yz.chaoxing.com/upload?_from=mobilelearn&_token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        body: multipartBody,
        userId: user.uid,
      }
    );
    return uploadRes?.data?.objectId || uploadRes?.objectId || null;
  }

  static async uploadFaceImageBuffer(user, imageBuffer) {
    if (!user || !Buffer.isBuffer(imageBuffer) || imageBuffer.length < 64) return null;
    const comment = Buffer.from(`CourseHelper_${EncryptionUtil.getUniqueId().slice(0, 10)}`, 'utf8');
    const len = comment.length + 2;
    const comSeg = Buffer.from([0xff, 0xfe, (len >> 8) & 0xff, len & 0xff, ...comment]);
    const modified = (imageBuffer[0] === 0xff && imageBuffer[1] === 0xd8)
      ? Buffer.concat([imageBuffer.subarray(0, 2), comSeg, imageBuffer.subarray(2)])
      : Buffer.concat([imageBuffer, comment]);
    const uploadedId = await this.uploadImageToPan(user, modified);
    if (!uploadedId) return null;
    user.cachedFaceObjectId = uploadedId;
    const accInStore = (store.accounts || []).find((a) => String(a.uid) === String(user.uid));
    if (accInStore) {
      accInStore.cachedFaceObjectId = uploadedId;
      saveStore();
    }
    return uploadedId;
  }

  static async getFaceParams(user, activeId, forceRefreshDevice = true) {
    try {
      const accInStore = (store.accounts || []).find((a) => String(a.uid) === String(user.uid));
      // 每次进行人脸活体协议签名前，先刷新一次最新 clientId (cxcid / sc)，防止因 SSO 令牌过期触发“[face]活体协议验证不通过”
      if (forceRefreshDevice || !user?.deviceInfo?.cid || !user?.deviceInfo?.sc) {
        try {
          const freshUser = await this.fetchUserInfo({ userId: user.uid });
          if (freshUser && freshUser.deviceInfo && freshUser.deviceInfo.cid && freshUser.deviceInfo.sc) {
            user.deviceInfo = freshUser.deviceInfo;
            if (freshUser.avatar) user.avatar = freshUser.avatar;
            if (accInStore) {
              accInStore.deviceInfo = freshUser.deviceInfo;
              if (freshUser.avatar) accInStore.avatar = freshUser.avatar;
              saveStore();
            }
          }
        } catch (_) {}
      }

      // 1. 优先尝试从 passport2-api 获取官方人脸底图 objectid，或使用已缓存/手动上传的本人人脸底图 cachedFaceObjectId
      // 注意：超星 stuSignajax 会对 currentFaceId 执行与账号底库的真实人脸特征比对，不能使用随机图案或非本人卡通头像，否则会报“[face]人脸验证不通过”
      let imageUrl = '';
      let faceId = user.cachedFaceObjectId || accInStore?.cachedFaceObjectId || '';
      try {
        const enc = EncryptionUtil.md5Hash(String(user.uid) + Constant.getFaceSalt);
        const res = await cxRequest(`https://passport2-api.chaoxing.com/api/getUserFaceid?enc=${enc}`, { userId: user.uid });
        if (res?.result === 1 && res.data) {
          imageUrl = res.data.https || res.data.http || '';
          if (res.data.objectid) {
            faceId = res.data.objectid;
            user.cachedFaceObjectId = faceId;
            if (accInStore && accInStore.cachedFaceObjectId !== faceId) {
              accInStore.cachedFaceObjectId = faceId;
              saveStore();
            }
          }
        }
      } catch (_) {}

      // 2. 若机房 IP 被 passport2-api WAF 拦截，使用已持久化的本人真实人脸底图 objectId 从超星云盘 CDN 拉取原图并重注入随机注释段上传
      if (!imageUrl && faceId) {
        imageUrl = `http://p.ananas.chaoxing.com/star3/origin/${faceId}.jpg`;
      }

      if (imageUrl) {
        try {
          const dl = await cxRequest(imageUrl, { userId: user.uid, rawBuffer: true });
          if (Buffer.isBuffer(dl) && dl.length > 64 && dl[0] === 0xff && dl[1] === 0xd8) {
            const comment = Buffer.from(`CourseHelper_${EncryptionUtil.getUniqueId().slice(0, 10)}`, 'utf8');
            const len = comment.length + 2;
            const comSeg = Buffer.from([0xff, 0xfe, (len >> 8) & 0xff, len & 0xff, ...comment]);
            const modified = Buffer.concat([dl.subarray(0, 2), comSeg, dl.subarray(2)]);
            const uploadedId = await this.uploadImageToPan(user, modified);
            if (uploadedId) faceId = uploadedId;
          }
        } catch (_) {}
      }
      if (!faceId) return {};

      const timeStampMS = String(Date.now());
      const faceResult = {
        currentFaceId: faceId,
        LiveDetectionStatus: '1',
        collectStatus: '1',
        cxcid: user?.deviceInfo?.cid || '',
        cxtime: timeStampMS,
      };
      const sorted = Object.keys(faceResult).sort();
      let buf = '';
      for (const k of sorted) buf += `${k}${faceResult[k] ?? ''}`;
      buf += user?.deviceInfo?.sc || '';
      faceResult.signToken = EncryptionUtil.md5Hash(buf);

      const checkRes = await cxRequest('https://mobilelearn.chaoxing.com/pptSign/check-face-result', {
        params: {
          DB_STRATEGY: 'PRIMARY_KEY',
          STRATEGY_PARA: 'activeId',
          activeId: String(activeId),
          faceResult: JSON.stringify(faceResult),
        },
        userId: user.uid,
      });
      return { faceId, faceEnc: checkRes?.status === 1 ? checkRes.enc : '' };
    } catch (_) {
      return {};
    }
  }
}

module.exports = { CXProtocol };
