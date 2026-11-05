package com.ishit.client;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.FrameLayout;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

public class MainActivity extends Activity {
    public static final int FILE_CHOOSER_REQ_CODE = 1001;
    public static final int RUNTIME_PERM_REQ_CODE = 1002;
    public static final String NOTIFY_CHANNEL_ID = "ishit_sign_channel";
    public static final String LOCAL_ASSET_INDEX = "file:///android_asset/web/index.html";
    public static final String DEFAULT_CONFIG_JSON = "{\n  \"serverHost\": \"47.117.27.75\",\n  \"serverPort\": 80,\n  \"apiBaseUrl\": \"http://47.117.27.75\",\n  \"httpsApiBaseUrl\": \"https://appraisal-occurring-performance-phrase.trycloudflare.com\",\n  \"directIpUrl\": \"http://47.117.27.75\"\n}";

    public WebView webView;
    public ValueCallback<Uri[]> filePathCallback;
    public String pendingNotifyPayload = null;
    private int notifySeq = 2000;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window window = getWindow();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            window.setStatusBarColor(Color.parseColor("#FFFFFF"));
            window.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        }

        ensureNotificationChannel();
        loadOrCreateExternalConfigJson();
        requestNecessaryPermissions();

        Intent startIntent = getIntent();
        if (startIntent != null) {
            String initPayload = startIntent.getStringExtra("notify_payload");
            if (initPayload != null && !initPayload.isEmpty()) {
                pendingNotifyPayload = initPayload;
            }
        }

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#F4F4F6"));

        webView = new WebView(this);
        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setDatabaseEnabled(true);
        ws.setAllowFileAccess(true);
        ws.setAllowContentAccess(true);
        ws.setAllowFileAccessFromFileURLs(true);
        ws.setAllowUniversalAccessFromFileURLs(true);
        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setGeolocationEnabled(true);
        ws.setLoadWithOverviewMode(true);
        ws.setUseWideViewPort(true);
        ws.setTextZoom(100);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            ws.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
            CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);
        }
        CookieManager.getInstance().setAcceptCookie(true);

        webView.addJavascriptInterface(new NativeBridge(this), "IshitAndroidBridge");
        webView.setWebViewClient(new LocalAssetWebViewClient(this));
        webView.setWebChromeClient(new AppWebChromeClient(this));

        root.addView(webView, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ));
        setContentView(root);

        webView.loadUrl(LOCAL_ASSET_INDEX);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent != null) {
            String payload = intent.getStringExtra("notify_payload");
            if (payload != null && !payload.isEmpty()) {
                pendingNotifyPayload = payload;
                flushPendingNotifyPayload();
            }
        }
    }

    public void flushPendingNotifyPayload() {
        if (pendingNotifyPayload == null || pendingNotifyPayload.isEmpty() || webView == null) {
            return;
        }
        final String raw = pendingNotifyPayload;
        pendingNotifyPayload = null;
        String jsLiteral = toJsStringLiteral(raw);
        webView.evaluateJavascript(
            "if(window.onNativeNotificationClick)window.onNativeNotificationClick(" + jsLiteral + ");",
            null
        );
    }

    public static String toJsStringLiteral(String s) {
        if (s == null) return "\"\"";
        StringBuilder sb = new StringBuilder(s.length() + 16);
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '\\': sb.append("\\\\"); break;
                case '"': sb.append("\\\""); break;
                case '\r': sb.append("\\r"); break;
                case '\n': sb.append("\\n"); break;
                case '\t': sb.append("\\t"); break;
                default: sb.append(c); break;
            }
        }
        sb.append('"');
        return sb.toString();
    }

    private void ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm != null) {
                    NotificationChannel ch = new NotificationChannel(
                        NOTIFY_CHANNEL_ID,
                        "ISHIT 课堂签到通知",
                        NotificationManager.IMPORTANCE_HIGH
                    );
                    ch.setDescription("发现课堂签到、签到成功或签到失败时立即提醒并直达");
                    ch.enableVibration(true);
                    nm.createNotificationChannel(ch);
                }
            } catch (Exception ignored) {
            }
        }
    }

    public void postNativeNotification(String title, String body, String payloadJson) {
        try {
            ensureNotificationChannel();
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;

            int id = ++notifySeq;
            Intent clickIntent = new Intent(this, MainActivity.class);
            clickIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            clickIntent.putExtra("notify_payload", payloadJson != null ? payloadJson : "");

            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                flags |= PendingIntent.FLAG_IMMUTABLE;
            }
            PendingIntent pi = PendingIntent.getActivity(this, id, clickIntent, flags);

            Notification.Builder builder;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                builder = new Notification.Builder(this, NOTIFY_CHANNEL_ID);
            } else {
                builder = new Notification.Builder(this);
                builder.setPriority(Notification.PRIORITY_HIGH);
                builder.setDefaults(Notification.DEFAULT_ALL);
            }

            builder.setSmallIcon(R.drawable.ic_launcher)
                .setContentTitle(title != null && !title.isEmpty() ? title : "ISHIT 签到提醒")
                .setContentText(body != null && !body.isEmpty() ? body : "点击直达签到或悬赏大厅")
                .setAutoCancel(true)
                .setContentIntent(pi);

            nm.notify(id, builder.build());
        } catch (Exception ignored) {
        }
    }

    public void requestNotificationPermissionExplicit() {
        if (Build.VERSION.SDK_INT >= 33) {
            if (checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, RUNTIME_PERM_REQ_CODE);
            }
        }
    }

    public String loadOrCreateExternalConfigJson() {
        try {
            File dir = getExternalFilesDir(null);
            if (dir == null) {
                dir = getFilesDir();
            }
            if (!dir.exists()) {
                dir.mkdirs();
            }
            File cfgFile = new File(dir, "config.json");
            if (!cfgFile.exists() || cfgFile.length() == 0) {
                FileOutputStream fos = new FileOutputStream(cfgFile);
                fos.write(DEFAULT_CONFIG_JSON.getBytes(StandardCharsets.UTF_8));
                fos.flush();
                fos.close();
                return DEFAULT_CONFIG_JSON;
            }
            FileInputStream fis = new FileInputStream(cfgFile);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[1024];
            int n;
            while ((n = fis.read(buf)) != -1) {
                bos.write(buf, 0, n);
            }
            fis.close();
            String content = new String(bos.toByteArray(), StandardCharsets.UTF_8).trim();
            if (content.isEmpty() || content.contains("api.ishit.pw") || content.contains(":8080")) {
                FileOutputStream fos = new FileOutputStream(cfgFile);
                fos.write(DEFAULT_CONFIG_JSON.getBytes(StandardCharsets.UTF_8));
                fos.flush();
                fos.close();
                return DEFAULT_CONFIG_JSON;
            }
            return content;
        } catch (Exception e) {
            return DEFAULT_CONFIG_JSON;
        }
    }

    private void requestNecessaryPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            List<String> perms = new ArrayList<String>();
            perms.add(Manifest.permission.CAMERA);
            perms.add(Manifest.permission.ACCESS_FINE_LOCATION);
            perms.add(Manifest.permission.ACCESS_COARSE_LOCATION);
            if (Build.VERSION.SDK_INT >= 33) {
                perms.add("android.permission.POST_NOTIFICATIONS");
            }
            List<String> need = new ArrayList<String>();
            for (String p : perms) {
                if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) {
                    need.add(p);
                }
            }
            if (!need.isEmpty()) {
                requestPermissions(need.toArray(new String[0]), RUNTIME_PERM_REQ_CODE);
            }
        }
    }

    public static String guessMimeType(String path) {
        String lower = path.toLowerCase();
        if (lower.endsWith(".html")) return "text/html";
        if (lower.endsWith(".js")) return "application/javascript";
        if (lower.endsWith(".css")) return "text/css";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".json")) return "application/json";
        return "application/octet-stream";
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQ_CODE) {
            if (filePathCallback == null) return;
            Uri[] results = null;
            if (resultCode == Activity.RESULT_OK && data != null) {
                String dataString = data.getDataString();
                ClipData clipData = data.getClipData();
                if (clipData != null) {
                    results = new Uri[clipData.getItemCount()];
                    for (int i = 0; i < clipData.getItemCount(); i++) {
                        results[i] = clipData.getItemAt(i).getUri();
                    }
                } else if (dataString != null) {
                    results = new Uri[]{Uri.parse(dataString)};
                }
            }
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    public void invokeSuperBackPressed() {
        super.onBackPressed();
    }

    @Override
    public void onBackPressed() {
        if (webView != null) {
            webView.loadUrl("javascript:(function(){ var m = document.querySelectorAll('.backdrop.open'); if(m.length > 0){ m[m.length-1].classList.remove('open'); window.IshitAndroidBridge.onBackEvalResult('CLOSED_MODAL'); } else { window.IshitAndroidBridge.onBackEvalResult('NONE'); } })()");
            return;
        }
        super.onBackPressed();
    }
}
