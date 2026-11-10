package dev.harbor.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.SystemClock;

/** Instant notifications (always on since 0.147, no setting): a low-priority
 *  foreground service that keeps one ping waiting at the PC (POST /v1/alive with wait_ms, up to
 *  4 minutes), so notifications arrive within seconds even with the app closed. Android shows
 *  a silent, minimised notification while it runs. The cost: one open connection and a wake
 *  every few minutes, a little battery, and Doze may still pause it on some phones (exempt
 *  Harbor from battery optimisation for that). Should it not run, notifications come with the
 *  15-minute pings and the burst after leaving the app (Alive). Its second thread holds the
 *  release news (Update.hear), so a new version is downloaded within seconds of its release and
 *  installs once nobody sees Harbor: that one never talks to a PC. */
public class Listen extends Service {
    private static volatile boolean running;
    /** Bumped by each start and stop: a thread from before ends (its blocking call may outlive
     *  the service by a few minutes). */
    private static volatile int gen;
    private Thread loop, news;

    /** Starts the service (from the app, in front: Android lets it start then). */
    static void apply(Context c) {
        try {
            if (!running) c.startForegroundService(new Intent(c, Listen.class));
        } catch (Exception ignored) { }
    }

    /** It's listening (Alive's burst isn't needed then). */
    static boolean listening() { return running; }

    @Override
    public int onStartCommand(Intent intent, int flags, int id) {
        if (Ui.app == null) Ui.app = getApplicationContext();
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel("listen", "Instant notifications (running)", NotificationManager.IMPORTANCE_MIN));
        PendingIntent pi = PendingIntent.getActivity(this, 7, new Intent(this, Hubs.class), PendingIntent.FLAG_IMMUTABLE);
        Notification n = new Notification.Builder(this, "listen").setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("Listening for your PCs").setContentText("So notifications arrive within seconds.")
                .setContentIntent(pi).setOngoing(true).build();
        if (Build.VERSION.SDK_INT >= 34) startForeground(9, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(9, n);
        if (loop == null || !loop.isAlive() || news == null || !news.isAlive()) {
            running = true;
            int my = ++gen;
            loop = new Thread(() -> run(my), "listen");
            loop.start();
            // Updates have a thread of their own: nothing about them goes through a PC.
            news = new Thread(() -> news(my), "update-news");
            news.start();
        }
        return START_STICKY;
    }

    private void run(int my) {
        long backoff = 15_000;
        while (running && my == gen) {
            java.util.List<Hub> hubs = Hub.all(this);
            boolean ok = false;
            for (int i = 0; i < hubs.size() && running && my == gen; i++) {
                // One pairing waits; others (rare) answer at once, each round.
                try { hubs.get(i).alive(i == 0 ? 240_000 : 0); ok = true; } catch (Exception ignored) { }
            }
            if (hubs.isEmpty()) break;
            if (!ok) {
                SystemClock.sleep(backoff);
                backoff = Math.min(backoff * 2, 5 * 60_000L);
            } else {
                backoff = 15_000;
            }
        }
        if (my != gen) return;
        running = false;
        stopSelf();
    }

    /** Release news (Update.hear: the account service, public, no PC and no sign-in) held for a
     *  few minutes at a time; between answers the usual round (GitHub's own releases/latest at
     *  most every 5 minutes, the fallback). A release heard is downloaded and installs as soon as
     *  nobody sees Harbor. */
    private void news(int my) {
        int fails = 0;
        while (running && my == gen) {
            String v = null;
            try {
                v = Update.hear(this, Update.HOLD_S);
                fails = 0;
            } catch (Exception e) {
                fails++;
            }
            if (!running || my != gen) break;
            if (v != null) Update.news(this, v);
            else Update.round(this);
            if (fails > 0) SystemClock.sleep(Quiet.backoff(fails));
        }
    }

    @Override
    public void onDestroy() {
        running = false;
        gen++;
        if (loop != null) loop.interrupt();
        if (news != null) news.interrupt();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent i) { return null; }
}
