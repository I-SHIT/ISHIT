package com.ishit.client;

import android.util.Base64;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.List;
import java.util.Map;
import java.util.Iterator;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class LocalTransport {
    private final MainActivity activity;
    private final ExecutorService executor = Executors.newFixedThreadPool(4);
    private final ConcurrentHashMap<String, HttpURLConnection> pending = new ConcurrentHashMap<>();
    private volatile boolean foreground = true;

    public LocalTransport(MainActivity activity) { this.activity = activity; }
    public void setForeground(boolean active) {
        foreground = active;
        if (!active) for (HttpURLConnection connection : pending.values()) connection.disconnect();
    }
    public void cancel(String id) {
        HttpURLConnection connection = pending.remove(id);
        if (connection != null) connection.disconnect();
    }
    public void close() { setForeground(false); executor.shutdownNow(); }
    public void send(final String raw) { executor.execute(new Request(raw)); }

    private final class Request implements Runnable {
        private final String raw;
        Request(String raw) { this.raw = raw; }
        @Override public void run() {
            JSONObject result = new JSONObject();
            HttpURLConnection connection = null;
            String id = "";
            try {
                JSONObject input = new JSONObject(raw);
                id = input.getString("id");
                result.put("id", id);
                if (!foreground) throw new Exception("请保持客户端在前台");
                URL url = new URL(input.getString("url"));
                if (!url.getProtocol().equals("http") && !url.getProtocol().equals("https")) throw new Exception("仅支持 HTTP 和 HTTPS 请求");
                connection = (HttpURLConnection)url.openConnection();
                pending.put(id, connection);
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(input.optInt("timeout", 15000));
                connection.setReadTimeout(input.optInt("timeout", 15000));
                connection.setRequestMethod(input.getString("method"));
                JSONObject headers = input.getJSONObject("headers");
                Iterator<String> keys = headers.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    if (!key.equalsIgnoreCase("Content-Length")) connection.setRequestProperty(key, headers.getString(key));
                }
                byte[] body = Base64.decode(input.optString("body", ""), Base64.DEFAULT);
                if (body.length > 0) {
                    connection.setDoOutput(true);
                    connection.setFixedLengthStreamingMode(body.length);
                    try (java.io.OutputStream output = connection.getOutputStream()) { output.write(body); }
                }
                int code = connection.getResponseCode();
                JSONObject responseHeaders = new JSONObject();
                for (Map.Entry<String, List<String>> item : connection.getHeaderFields().entrySet()) {
                    if (item.getKey() == null) continue;
                    String key = item.getKey().toLowerCase(java.util.Locale.ROOT);
                    if (key.equals("set-cookie")) responseHeaders.put(key, new JSONArray(item.getValue()));
                    else responseHeaders.put(key, android.text.TextUtils.join(", ", item.getValue()));
                }
                ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                InputStream stream = code >= 400 ? connection.getErrorStream() : connection.getInputStream();
                if (stream != null) try (InputStream inputStream = stream) {
                    byte[] chunk = new byte[8192];
                    int count;
                    while ((count = inputStream.read(chunk)) != -1) bytes.write(chunk, 0, count);
                }
                result.put("status", code);
                result.put("headers", responseHeaders);
                result.put("body", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP));
            } catch (Exception error) {
                try { result.put("error", error.getMessage() == null ? error.toString() : error.getMessage()); } catch (Exception ignored) {}
            } finally {
                pending.remove(id);
                if (connection != null) connection.disconnect();
            }
            activity.runOnUiThread(new Reply(result.toString()));
        }
    }

    private final class Reply implements Runnable {
        private final String json;
        Reply(String json) { this.json = json; }
        @Override public void run() {
            if (activity.webView != null && activity.isLocalPage())
                activity.webView.evaluateJavascript("window.onLocalHttpResult && window.onLocalHttpResult(" + JSONObject.quote(json) + ");", null);
        }
    }
}
