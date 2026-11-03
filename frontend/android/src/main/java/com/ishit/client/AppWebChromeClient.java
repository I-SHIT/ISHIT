package com.ishit.client;

import android.content.Intent;
import android.net.Uri;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;

public class AppWebChromeClient extends WebChromeClient {
    private final MainActivity act;
    public AppWebChromeClient(MainActivity act) {
        this.act = act;
    }

    @Override
    public void onPermissionRequest(PermissionRequest request) {
        act.runOnUiThread(new GrantPermissionRunnable(request));
    }

    @Override
    public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
        callback.invoke(origin, true, false);
    }

    @Override
    public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
        if (act.filePathCallback != null) {
            act.filePathCallback.onReceiveValue(null);
        }
        act.filePathCallback = filePathCallback;
        try {
            Intent intent = fileChooserParams.createIntent();
            act.startActivityForResult(intent, MainActivity.FILE_CHOOSER_REQ_CODE);
        } catch (Exception e) {
            act.filePathCallback = null;
            return false;
        }
        return true;
    }
}
