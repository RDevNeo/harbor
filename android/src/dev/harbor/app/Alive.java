package dev.harbor.app;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.os.SystemClock;

/** Tells the PCs this phone is reachable while Harbor is in the background or closed, so
 *  Devices shows it online, and takes their notifications (Notes; android/PROTOCOL.md,
 *  "Background pings", "Notifications"). Two JobScheduler jobs, both waiting for a network:
 *  every 15 minutes, kept across reboots (Android runs it later in Doze or when the app is
 *  rarely used); and a burst right after the user leaves the app, long-polling for a few
 *  minutes, when an answer to what was just asked is most likely. Each ping carries the
 *  account's Harbor token, like every call (Account renews it here too). After the pings, an automatic
 *  update when one is due and nobody sees Harbor (Update.background). */
public class Alive extends JobService {
    static final int JOB = 4711, BURST = 4712;
    static final long EVERY_MS = 15 * 60_000L;
    /** How long the burst after leaving the app listens (jobs may run 10 minutes). */
    static final long BURST_MS = 8 * 60_000L;
    private static boolean scheduled;
    private static volatile boolean stop;

    /** Schedules the periodic job once per process (it outlives the app: persisted). */
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

    /** The user left the app: listen for a few minutes (not with Listen running: it does). */
    static void burst(Context c) {
        if (Notes.instant(c)) return;
        try {
            JobScheduler js = c.getSystemService(JobScheduler.class);
            if (js != null) js.schedule(new JobInfo.Builder(BURST, new ComponentName(c, Alive.class))
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).build());
        } catch (Exception ignored) { }
    }

    /** Back in the app: no burst needed. */
    static void calm(Context c) {
        try {
            JobScheduler js = c.getSystemService(JobScheduler.class);
            if (js != null) js.cancel(BURST);
        } catch (Exception ignored) { }
    }

    @Override
    public boolean onStartJob(JobParameters p) {
        // Started without an activity (the app closed): Net and the pairing list need a context.
        if (Ui.app == null) Ui.app = getApplicationContext();
        boolean burst = p.getJobId() == BURST;
        stop = false;
        Ui.pool.execute(() -> {
            long until = SystemClock.elapsedRealtime() + (burst ? BURST_MS : 0);
            // A Harbor token due for renewal, and a newer directory, while the network is up.
            try { Account.renew(this, false); } catch (Exception ignored) { }
            do {
                java.util.List<Hub> hubs = Hub.all(this);
                for (int i = 0; i < hubs.size() && !stop; i++) {
                    // The burst waits on the first PC; any others answer at once.
                    int wait = burst && i == 0 ? (int) Math.min(60_000, Math.max(0, until - SystemClock.elapsedRealtime())) : 0;
                    try { hubs.get(i).alive(wait); } catch (Exception e) { if (burst) SystemClock.sleep(10_000); }
                }
                // Updating automatically: a new version installs while nobody sees Harbor.
                if (!stop) Update.background(this);
            } while (burst && !stop && Base.resumed <= 0 && SystemClock.elapsedRealtime() < until);
            jobFinished(p, false);
        });
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters p) {
        stop = true;
        return p.getJobId() == JOB;
    }
}
