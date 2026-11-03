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
    public void onBackEvalResult(String val) {
        act.runOnUiThread(new BackResultRunnable(act, val));
    }
}
