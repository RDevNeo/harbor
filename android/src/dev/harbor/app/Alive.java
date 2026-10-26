package dev.harbor.app;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;

/** Tells the PCs this phone is reachable while Harbor is in the background or closed, so
 *  Devices shows it online (android/PROTOCOL.md, "Background pings"). A JobScheduler job every
 *  15 minutes with a network, kept across reboots; Android runs it later in Doze or when the
 *  app is rarely used. Each paired PC gets one ping (POST /v1/alive): its pairing secret's MAC
 *  over the time, no session and no screen lock (the presence key stays for real sessions). */
public class Alive extends JobService {
    static final int JOB = 4711;
    static final long EVERY_MS = 15 * 60_000L;
    private static boolean scheduled;

    /** Schedules the job once per process (it outlives the app: persisted, periodic). */
    static synchronized void schedule(Context c) {
        if (scheduled) return;
        scheduled = true;
        try {
            JobScheduler js = c.getSystemService(JobScheduler.class);
            if (js == null) return;
            for (JobInfo j : js.getAllPendingJobs()) if (j.getId() == JOB && j.getIntervalMillis() == EVERY_MS) return;
            js.schedule(new JobInfo.Builder(JOB, new ComponentName(c, Alive.class))
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setPeriodic(EVERY_MS)
                    .setPersisted(true)
                    .build());
        } catch (Exception ignored) { }
    }

    @Override
    public boolean onStartJob(JobParameters p) {
        // Started without an activity (the app closed): Net and the pairing list need a context.
        if (Ui.app == null) Ui.app = getApplicationContext();
        Ui.pool.execute(() -> {
            for (Hub h : Hub.all(this)) {
                try { h.alive(); } catch (Exception ignored) { }
            }
            jobFinished(p, false);
        });
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters p) { return true; }
}
