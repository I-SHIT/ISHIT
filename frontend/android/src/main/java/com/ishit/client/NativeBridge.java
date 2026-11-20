package com.ishit.client;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.webkit.JavascriptInterface;

public class NativeBridge {
    private final MainActivity act;
    public NativeBridge(MainActivity act) {
        this.act = act;
    }

    @JavascriptInterface
    public void localRequest(String request) { act.runOnUiThread(new LocalRequest(act, request)); }

    @JavascriptInterface
    public void cancelLocalRequest(String id) { act.localTransport.cancel(id); }

    private static final class LocalRequest implements Runnable {
        private final MainActivity act;
        private final String request;
        LocalRequest(MainActivity act, String request) { this.act = act; this.request = request; }
        @Override public void run() { if (act.isLocalPage()) act.localTransport.send(request); }
    }

    @JavascriptInterface
    public void setOfflineMode(boolean enabled) {
        act.getSharedPreferences(MainActivity.PREFS_NAME, Context.MODE_PRIVATE)
            .edit().putBoolean("offline_mode", enabled).commit();
    }

    @JavascriptInterface
    public void exportOfflineConfig(final String json) {
        act.runOnUiThread(new Runnable() {
            @Override public void run() { act.exportOfflineConfig(json); }
        });
    }

    @JavascriptInterface
    public String getConfigJson() {
        return act.loadOrCreateExternalConfigJson();
    }

    @JavascriptInterface
    public void copyToClipboard(String text) {
        ClipboardManager cm = (ClipboardManager) act.getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm != null) {
            cm.setPrimaryClip(ClipData.newPlainText("ISHIT", text));
        }
    }

    @JavascriptInterface
    public void showNotification(String title, String body, String payloadJson) {
        act.postNativeNotification(title, body, payloadJson);
    }

    @JavascriptInterface
    public void requestNotifyPermission() {
        act.requestNotificationPermissionExplicit();
    }

    @JavascriptInterface
    public void syncAuthState(String token, String apiBaseUrl, String username) {
        act.syncNativeAuthState(token, apiBaseUrl, username);
    }

    @JavascriptInterface
    public boolean isIgnoringBatteryOptimizations() {
        return act.isBatteryOptimizationIgnored();
    }

    @JavascriptInterface
    public void requestIgnoreBatteryOptimizations() {
        act.requestIgnoreBatteryOptimizationExplicit();
    }

    @JavascriptInterface
    public void onBackEvalResult(String val) {
        act.runOnUiThread(new BackResultRunnable(act, val));
    }
}