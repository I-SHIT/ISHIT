package com.ishit.client;

import android.app.job.JobParameters;
import android.app.job.JobService;
import android.content.Context;
import android.content.Intent;

public class KeepAliveJobService extends JobService implements Runnable {
    private volatile JobParameters activeParams = null;

    @Override
    public boolean onStartJob(JobParameters params) {
        this.activeParams = params;
        Context appCtx = getApplicationContext();
        KeepAlivePollService.purgeLegacyGuardNotification(appCtx);
        try {
            appCtx.startService(new Intent(appCtx, KeepAlivePollService.class));
        } catch (Exception ignored) {
        }
        Thread worker = new Thread(this, "IshitJobPollWorker");
        worker.setDaemon(true);
        worker.start();
        return true;
    }

    @Override
    public void run() {
        Context appCtx = getApplicationContext();
        long nextDelay = 3500L;
        try {
            nextDelay = KeepAlivePollService.pollOnceStatic(appCtx);
        } catch (Exception ignored) {
        } finally {
            KeepAlivePollService.scheduleResurrectionRelay(appCtx, nextDelay);
            JobParameters p = this.activeParams;
            if (p != null) {
                try {
                    jobFinished(p, false);
                } catch (Exception ignored) {
                }
            }
        }
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        KeepAlivePollService.scheduleResurrectionRelay(getApplicationContext(), 2500L);
        return true;
    }
}
