package com.ishit.client;

import android.content.BroadcastReceiver;
import android.content.Context;

public class ReceiverPollRunnable implements Runnable {
    private final Context appCtx;
    private final BroadcastReceiver.PendingResult pendingResult;

    public ReceiverPollRunnable(Context appCtx, BroadcastReceiver.PendingResult pendingResult) {
        this.appCtx = appCtx;
        this.pendingResult = pendingResult;
    }

    @Override
    public void run() {
        long nextDelay = 3500L;
        try {
            nextDelay = KeepAlivePollService.pollOnceStatic(appCtx);
        } catch (Exception ignored) {
        } finally {
            KeepAlivePollService.scheduleResurrectionRelay(appCtx, nextDelay);
            if (pendingResult != null) {
                try {
                    pendingResult.finish();
                } catch (Exception ignored) {
                }
            }
        }
    }
}
