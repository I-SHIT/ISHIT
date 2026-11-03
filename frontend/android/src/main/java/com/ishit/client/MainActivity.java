package com.ishit.client;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
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
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

public class MainActivity extends Activity {
    public static final int FILE_CHOOSER_REQ_CODE = 1001;
    public static final int RUNTIME_PERM_REQ_CODE = 1002;
    public static final String LOCAL_ASSET_INDEX = "file:///android_asset/web/index.html";
    public static final String DEFAULT_CONFIG_JSON = "{\n  \"serverHost\": \"47.117.27.75\",\n  \"serverPort\": 80,\n  \"apiBaseUrl\": \"http://47.117.27.75\",\n  \"directIpUrl\": \"http://47.117.27.75\"\n}";

    public WebView webView;
    public ValueCallback<Uri[]> filePathCallback;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window window = getWindow();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            window.setStatusBarColor(Color.parseColor("#FFFFFF"));
            window.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        }

        loadOrCreateExternalConfigJson();
        requestNecessaryPermissions();

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
            String[] perms = new String[]{
                Manifest.permission.CAMERA,
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION
            };
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

