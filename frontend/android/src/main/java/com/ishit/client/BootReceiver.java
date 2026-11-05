package com.ishit.client;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null || intent == null) return;
        Context appCtx = context.getApplicationContext();
        KeepAlivePollService.purgeLegacyGuardNotification(appCtx);

        try {
            appCtx.startService(new Intent(appCtx, KeepAlivePollService.class));
        } catch (Exception ignored) {
        }

        PendingResult pendingResult = goAsync();
        Thread worker = new Thread(new ReceiverPollRunnable(appCtx, pendingResult), "IshitReceiverPollWorker");
        worker.setDaemon(true);
        worker.start();
    }
}
