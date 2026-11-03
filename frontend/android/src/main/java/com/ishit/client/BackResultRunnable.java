package com.ishit.client;

public class BackResultRunnable implements Runnable {
    private final MainActivity act;
    private final String val;
    public BackResultRunnable(MainActivity act, String val) {
        this.act = act;
        this.val = val;
    }
    @Override
    public void run() {
        if (val != null && val.contains("CLOSED_MODAL")) {
            return;
        }
        if (act.webView != null && act.webView.canGoBack()) {
            act.webView.goBack();
        } else {
            act.invokeSuperBackPressed();
        }
    }
}
