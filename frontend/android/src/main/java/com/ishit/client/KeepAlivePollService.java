package com.ishit.client;

import android.app.AlarmManager;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public class KeepAlivePollService extends Service implements Runnable {
    public static final String GUARD_CHANNEL_ID = "ishit_guard_channel";
    public static final int GUARD_NOTIFY_ID = 1001;
    public static final int LEGACY_GUARD_NOTIFY_ID = 9901;
    public static final int JOB_ID_KEEPALIVE = 7701;
    public static final String ACTION_ALARM_POLL_TICK = "com.ishit.client.ALARM_POLL_TICK";

    private volatile boolean running = false;
    private Thread workerThread = null;
    private static volatile boolean sSeededOnStartup = false;
    private static volatile int sLastBountyCount = -1;

    @Override
    public void onCreate() {
        super.onCreate();
        purgeLegacyGuardNotification(this);
        scheduleResurrectionRelay(this, 4000L);
        startWorkerLoop();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        purgeLegacyGuardNotification(this);
        scheduleResurrectionRelay(this, 4000L);
        startWorkerLoop();
        return START_STICKY;
    }

    public static void purgeLegacyGuardNotification(Context ctx) {
        if (ctx == null) return;
        try {
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                nm.cancel(GUARD_NOTIFY_ID);
                nm.cancel(LEGACY_GUARD_NOTIFY_ID);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    nm.deleteNotificationChannel(GUARD_CHANNEL_ID);
                }
            }
        } catch (Exception ignored) {
        }
    }

    public static void scheduleResurrectionRelay(Context ctx, long delayMs) {
        if (ctx == null) return;
        long safeDelay = Math.max(2500L, Math.min(15000L, delayMs));
        Context appCtx = ctx.getApplicationContext();

        // 1. JobScheduler (persisted in system_server, survives swipe-away task kill)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            try {
                JobScheduler js = (JobScheduler) appCtx.getSystemService(Context.JOB_SCHEDULER_SERVICE);
                if (js != null) {
                    ComponentName comp = new ComponentName(appCtx, KeepAliveJobService.class);
                    JobInfo.Builder jb = new JobInfo.Builder(JOB_ID_KEEPALIVE, comp)
                        .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                        .setMinimumLatency(safeDelay)
                        .setOverrideDeadline(safeDelay + 4000L)
                        .setPersisted(true);
                    js.schedule(jb.build());
                }
            } catch (Exception ignored) {
            }
        }

        // 2. AlarmManager -> BroadcastReceiver (PendingIntent.getBroadcast is allowed in background on Android 8+)
        try {
            Intent alarmIntent = new Intent(appCtx, BootReceiver.class);
            alarmIntent.setAction(ACTION_ALARM_POLL_TICK);
            int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                piFlags |= PendingIntent.FLAG_IMMUTABLE;
            }
            PendingIntent pi = PendingIntent.getBroadcast(appCtx, 2027, alarmIntent, piFlags);
            AlarmManager am = (AlarmManager) appCtx.getSystemService(Context.ALARM_SERVICE);
            if (am != null) {
                long triggerAt = SystemClock.elapsedRealtime() + safeDelay;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    try {
                        am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi);
                    } catch (SecurityException se) {
                        am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi);
                    }
                } else {
                    am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi);
                }
            }
        } catch (Exception ignored) {
        }
    }

    private synchronized void startWorkerLoop() {
        if (running && workerThread != null && workerThread.isAlive()) {
            return;
        }
        running = true;
        workerThread = new Thread(this, "IshitKeepAlivePollThread");
        workerThread.setDaemon(true);
        workerThread.start();
    }

    @Override
    public void run() {
        while (running) {
            long sleepMs = 3000L;
            try {
                sleepMs = pollOnceStatic(this);
            } catch (Exception ignored) {
            }
            scheduleResurrectionRelay(this, sleepMs + 1500L);
            try {
                Thread.sleep(Math.max(2000L, Math.min(8000L, sleepMs)));
            } catch (InterruptedException ignored) {
            }
        }
    }

    public static long pollOnceStatic(Context ctx) {
        if (ctx == null) return 4000L;
        Context appCtx = ctx.getApplicationContext();
        SharedPreferences prefs = appCtx.getSharedPreferences(MainActivity.PREFS_NAME, Context.MODE_PRIVATE);
        String token = prefs.getString("panel_token", "");
        String baseUrl = prefs.getString("api_base_url", "http://47.117.27.75");
        if (baseUrl == null || baseUrl.trim().isEmpty()) {
            baseUrl = "http://47.117.27.75";
        }
        baseUrl = baseUrl.trim();
        while (baseUrl.endsWith("/")) {
            baseUrl = baseUrl.substring(0, baseUrl.length() - 1);
        }

        if (token == null || token.trim().isEmpty()) {
            return 4500L;
        }

        HttpURLConnection conn = null;
        try {
            String pollUrl = baseUrl + "/api/alerts/poll?_t=" + System.currentTimeMillis();
            URL url = new URL(pollUrl);
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(5000);
            conn.setUseCaches(false);
            conn.setRequestProperty("X-Panel-Token", token.trim());
            conn.setRequestProperty("Accept", "application/json");

            int code = conn.getResponseCode();
            if (code != 200) {
                return 4000L;
            }

            InputStream is = conn.getInputStream();
            BufferedReader reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line);
            }
            reader.close();

            JSONObject data = new JSONObject(sb.toString());
            if (!data.optBoolean("ok", false)) {
                return 4000L;
            }

            boolean inClass = data.optBoolean("inClass", false) || data.optBoolean("forcePolling", false);
            int bountyCount = data.optInt("activeBountyCount", 0);
            JSONArray alerts = data.optJSONArray("alerts");
            boolean dispatchedNewAlert = false;

            if (alerts != null) {
                long nowMs = System.currentTimeMillis();
                if (!sSeededOnStartup) {
                    sSeededOnStartup = true;
                    String existingSeen = prefs.getString("seen_alert_ids", "");
                    boolean hadHistory = existingSeen != null && !existingSeen.isEmpty();
                    for (int i = 0; i < alerts.length(); i++) {
                        JSONObject al = alerts.optJSONObject(i);
                        if (al == null) continue;
                        String id = al.optString("id", "");
                        long timeMs = al.optLong("timeMs", 0L);
                        if (!id.isEmpty()) {
                            if (!hadHistory && (nowMs - timeMs > 90000L)) {
                                MainActivity.markAlertSeenStatic(appCtx, id);
                            }
                        }
                    }
                }

                for (int i = alerts.length() - 1; i >= 0; i--) {
                    JSONObject al = alerts.optJSONObject(i);
                    if (al == null) continue;
                    String id = al.optString("id", "");
                    if (id.isEmpty()) continue;
                    if (MainActivity.hasAlertBeenSeenStatic(appCtx, id)) {
                        continue;
                    }
                    MainActivity.markAlertSeenStatic(appCtx, id);

                    String title = al.optString("title", "ISHIT 签到提醒");
                    String courseName = al.optString("courseName", "课程");
                    String activeName = al.optString("activeName", "签到");
                    String body = al.optString("body", "《" + courseName + "》" + activeName);

                    JSONObject payloadObj = new JSONObject();
                    payloadObj.put("alertId", id);
                    payloadObj.put("eventType", al.optString("eventType", "sign_detected"));
                    payloadObj.put("helperToken", al.optString("helperToken", ""));
                    payloadObj.put("activeId", al.optString("activeId", ""));
                    payloadObj.put("courseId", al.optString("courseId", ""));
                    payloadObj.put("classId", al.optString("classId", ""));
                    payloadObj.put("courseName", courseName);

                    wakeScreenBrieflyStatic(appCtx);
                    MainActivity.postAlertNotificationStatic(appCtx, title, body, payloadObj.toString(), id);
                    dispatchedNewAlert = true;
                }
            }

            if (dispatchedNewAlert || (sLastBountyCount != -1 && sLastBountyCount != bountyCount)) {
                MainActivity.notifyWebViewPollTickStatic();
            }
            sLastBountyCount = bountyCount;

            return (inClass || bountyCount > 0) ? 2500L : 3500L;
        } catch (Exception ignored) {
            return 4000L;
        } finally {
            if (conn != null) {
                try { conn.disconnect(); } catch (Exception ignored) {}
            }
        }
    }

    public static void wakeScreenBrieflyStatic(Context ctx) {
        if (ctx == null) return;
        try {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                @SuppressWarnings("deprecation")
                PowerManager.WakeLock wl = pm.newWakeLock(
                    PowerManager.PARTIAL_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP | PowerManager.ON_AFTER_RELEASE,
                    "ishit:AlertWakeLock"
                );
                wl.acquire(3000L);
            }
        } catch (Exception ignored) {
        }
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        scheduleResurrectionRelay(this, 1500L);
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        running = false;
        scheduleResurrectionRelay(this, 1500L);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
