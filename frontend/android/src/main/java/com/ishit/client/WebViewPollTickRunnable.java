package com.ishit.client;

public class WebViewPollTickRunnable implements Runnable {
    private final MainActivity act;

    public WebViewPollTickRunnable(MainActivity act) {
        this.act = act;
    }

    @Override
    public void run() {
        try {
            if (act != null && act.webView != null) {
                act.webView.evaluateJavascript("if(window.onNativeAlertPollTick)window.onNativeAlertPollTick();", null);
            }
        } catch (Exception ignored) {
        }
    }
}
