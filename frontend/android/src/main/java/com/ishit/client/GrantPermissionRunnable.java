package com.ishit.client;

import android.webkit.PermissionRequest;

public class GrantPermissionRunnable implements Runnable {
    private final PermissionRequest request;
    public GrantPermissionRunnable(PermissionRequest request) {
        this.request = request;
    }
    @Override
    public void run() {
        request.grant(request.getResources());
    }
}
