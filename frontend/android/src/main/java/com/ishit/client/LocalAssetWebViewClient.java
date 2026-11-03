package com.ishit.client;

import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

public class LocalAssetWebViewClient extends WebViewClient {
    private final MainActivity act;
    public LocalAssetWebViewClient(MainActivity act) {
        this.act = act;
    }

    private WebResourceResponse interceptUri(Uri uri) {
        if (uri == null) return null;
        String scheme = uri.getScheme();
        String host = uri.getHost();
        String path = uri.getPath();

        if (path != null && path.endsWith("/config.json")) {
            try {
                String cfgJson = act.loadOrCreateExternalConfigJson();
                InputStream cfgStream = new ByteArrayInputStream(cfgJson.getBytes(StandardCharsets.UTF_8));
                Map<String, String> headers = new HashMap<String, String>();
                headers.put("Access-Control-Allow-Origin", "*");
                headers.put("Cache-Control", "no-store");
                return new WebResourceResponse("application/json", "UTF-8", 200, "OK", headers, cfgStream);
            } catch (Exception ignored) {
            }
        }

        if (host != null && ("appassets.androidplatform.net".equalsIgnoreCase(host) || "ishit.local".equalsIgnoreCase(host))) {
            String cleanPath = path;
            if (cleanPath == null || cleanPath.isEmpty() || "/".equals(cleanPath)) {
                cleanPath = "/index.html";
            }
            if (!cleanPath.startsWith("/")) {
                cleanPath = "/" + cleanPath;
            }
            String assetPath = "web" + cleanPath;
            try {
                InputStream is = act.getAssets().open(assetPath);
                String mime = MainActivity.guessMimeType(cleanPath);
                Map<String, String> headers = new HashMap<String, String>();
                headers.put("Access-Control-Allow-Origin", "*");
                headers.put("Cache-Control", "no-store");
                return new WebResourceResponse(mime, "UTF-8", 200, "OK", headers, is);
            } catch (Exception ignored) {
            }
        }
        return null;
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        if (request != null) {
            WebResourceResponse resp = interceptUri(request.getUrl());
            if (resp != null) return resp;
        }
        return super.shouldInterceptRequest(view, request);
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
        if (url != null) {
            try {
                WebResourceResponse resp = interceptUri(Uri.parse(url));
                if (resp != null) return resp;
            } catch (Exception ignored) {
            }
        }
        return super.shouldInterceptRequest(view, url);
    }

    @Override
    public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
        super.onPageStarted(view, url, favicon);
        String cfg = act.loadOrCreateExternalConfigJson();
        view.evaluateJavascript(
            "window.ISHIT_NATIVE_CLIENT = true; window.ISHIT_PLATFORM = 'android'; " +
            "try { window.ISHIT_CONFIG = " + cfg + "; } catch(e) {} " +
            "if(typeof applyPlatformLayoutClass === 'function') applyPlatformLayoutClass();",
            null
        );
    }

    @Override
    public void onPageFinished(WebView view, String url) {
        super.onPageFinished(view, url);
        String cfg = act.loadOrCreateExternalConfigJson();
        view.evaluateJavascript(
            "window.ISHIT_NATIVE_CLIENT = true; window.ISHIT_PLATFORM = 'android'; " +
            "try { window.ISHIT_CONFIG = " + cfg + "; } catch(e) {} " +
            "if(typeof applyPlatformLayoutClass === 'function') applyPlatformLayoutClass();",
            null
        );
    }
}
