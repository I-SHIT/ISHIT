package com.ishit.client;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
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
    private volatile boolean running = false;
    private Thread workerThread = null;
    private boolean seededOnStartup = false;

    @Override
    public void onCreate() {
        super.onCreate();
        startGuardForeground("ISHIT 签到雷达后台守护中", "正在实时监听课堂签到与悬赏状态");
        startWorkerLoop();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startGuardForeground("ISHIT 签到雷达后台守护中", "正在实时监听课堂签到与悬赏状态");
        startWorkerLoop();
        return START_STICKY;
    }

    private void startGuardForeground(String title, String text) {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null) {
                NotificationChannel ch = new NotificationChannel(
                    GUARD_CHANNEL_ID,
                    "ISHIT 后台保活守护",
                    NotificationManager.IMPORTANCE_LOW
                );
                ch.setDescription("保持 ISHIT 在锁屏或切后台时仍能秒级接收签到提醒");
                ch.enableVibration(false);
                ch.setSound(null, null);
                nm.createNotificationChannel(ch);
            }

            Intent clickIntent = new Intent(this, MainActivity.class);
            clickIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                piFlags |= PendingIntent.FLAG_IMMUTABLE;
            }
            PendingIntent pi = PendingIntent.getActivity(this, 1001, clickIntent, piFlags);

            Notification.Builder builder;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                builder = new Notification.Builder(this, GUARD_CHANNEL_ID);
            } else {
                builder = new Notification.Builder(this);
                builder.setPriority(Notification.PRIORITY_LOW);
            }

            Notification notification = builder
                .setSmallIcon(R.drawable.ic_launcher)
                .setContentTitle(title)
                .setContentText(text)
                .setOngoing(true)
                .setContentIntent(pi)
                .build();

            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(GUARD_NOTIFY_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(GUARD_NOTIFY_ID, notification);
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
            long sleepMs = 3500L;
            try {
                sleepMs = pollOnce();
            } catch (Exception ignored) {
            }
            try {
                Thread.sleep(Math.max(2000L, Math.min(15000L, sleepMs)));
            } catch (InterruptedException ignored) {
            }
        }
    }

    private long pollOnce() {
        SharedPreferences prefs = getSharedPreferences(MainActivity.PREFS_NAME, Context.MODE_PRIVATE);
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
            return 5000L;
        }

        HttpURLConnection conn = null;
        try {
            String pollUrl = baseUrl + "/api/alerts/poll?_t=" + System.currentTimeMillis();
            URL url = new URL(pollUrl);
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(6000);
            conn.setReadTimeout(6000);
            conn.setUseCaches(false);
            conn.setRequestProperty("X-Panel-Token", token.trim());
            conn.setRequestProperty("Accept", "application/json");

            int code = conn.getResponseCode();
            if (code != 200) {
                return 5000L;
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
                return 5000L;
            }

            boolean inClass = data.optBoolean("inClass", false) || data.optBoolean("forcePolling", false);
            int bountyCount = data.optInt("activeBountyCount", 0);
            JSONArray alerts = data.optJSONArray("alerts");

            if (alerts != null) {
                long nowMs = System.currentTimeMillis();
                if (!seededOnStartup) {
                    seededOnStartup = true;
                    String existingSeen = prefs.getString("seen_alert_ids", "");
                    boolean hadHistory = existingSeen != null && !existingSeen.isEmpty();
                    for (int i = 0; i < alerts.length(); i++) {
                        JSONObject al = alerts.optJSONObject(i);
                        if (al == null) continue;
                        String id = al.optString("id", "");
                        long timeMs = al.optLong("timeMs", 0L);
                        if (!id.isEmpty()) {
                            if (!hadHistory && (nowMs - timeMs > 90000L)) {
                                MainActivity.markAlertSeenStatic(this, id);
                            }
                        }
                    }
                }

                // Dispatch chronological from oldest to newest
                for (int i = alerts.length() - 1; i >= 0; i--) {
                    JSONObject al = alerts.optJSONObject(i);
                    if (al == null) continue;
                    String id = al.optString("id", "");
                    if (id.isEmpty()) continue;
                    if (MainActivity.hasAlertBeenSeenStatic(this, id)) {
                        continue;
                    }
                    MainActivity.markAlertSeenStatic(this, id);

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

                    wakeScreenBriefly();
                    MainActivity.postAlertNotificationStatic(this, title, body, payloadObj.toString(), id);
                }
            }

            return (inClass || bountyCount > 0) ? 3000L : 5000L;
        } catch (Exception ignored) {
            return 5000L;
        } finally {
            if (conn != null) {
                try { conn.disconnect(); } catch (Exception ignored) {}
            }
        }
    }

    private void wakeScreenBriefly() {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
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
        scheduleSelfRestart();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        running = false;
        scheduleSelfRestart();
        super.onDestroy();
    }

    private void scheduleSelfRestart() {
        try {
            Intent restartIntent = new Intent(getApplicationContext(), KeepAlivePollService.class);
            int piFlags = PendingIntent.FLAG_ONE_SHOT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                piFlags |= PendingIntent.FLAG_IMMUTABLE;
            }
            PendingIntent pi;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                pi = PendingIntent.getForegroundService(getApplicationContext(), 2026, restartIntent, piFlags);
            } else {
                pi = PendingIntent.getService(getApplicationContext(), 2026, restartIntent, piFlags);
            }
            AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
            if (am != null) {
                am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + 2000L, pi);
            }
        } catch (Exception ignored) {
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}