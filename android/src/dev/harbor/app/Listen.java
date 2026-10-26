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

/** "Instant notifications" (Settings › Notifications, off by default): a low-priority
 *  foreground service that keeps one ping waiting at the PC (POST /v1/alive with wait_ms, up to
 *  4 minutes), so notifications arrive within seconds even with the app closed. Android shows
 *  a silent, minimised notification while it runs. The cost: one open connection and a wake
 *  every few minutes, a little battery, and Doze may still pause it on some phones (exempt
 *  Harbor from battery optimisation for that). Off: notifications come with the 15-minute pings
 *  and the burst after leaving the app (Alive). */
public class Listen extends Service {
    private static volatile boolean running;
    private Thread loop;

    /** Starts or stops the service per the setting (from the app, in front). */
    static void apply(Context c) {
        Intent i = new Intent(c, Listen.class);
        try {
            if (Notes.instant(c)) {
                if (!running) c.startForegroundService(i);
            } else {
                c.stopService(i);
            }
        } catch (Exception ignored) { }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int id) {
        if (Ui.app == null) Ui.app = getApplicationContext();
        if (!Notes.instant(this)) { stopSelf(); return START_NOT_STICKY; }
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel("listen", "Instant notifications (running)", NotificationManager.IMPORTANCE_MIN));
        PendingIntent pi = PendingIntent.getActivity(this, 7, new Intent(this, Hubs.class), PendingIntent.FLAG_IMMUTABLE);
        Notification n = new Notification.Builder(this, "listen").setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("Listening for your PCs").setContentText("Instant notifications are on (Settings › Notifications).")
                .setContentIntent(pi).setOngoing(true).build();
        if (Build.VERSION.SDK_INT >= 34) startForeground(9, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(9, n);
        if (loop == null || !loop.isAlive()) {
            running = true;
            loop = new Thread(this::run, "listen");
            loop.start();
        }
        return START_STICKY;
    }

    private void run() {
        long backoff = 15_000;
        while (running && Notes.instant(this)) {
            java.util.List<Hub> hubs = Hub.all(this);
            boolean ok = false;
            for (int i = 0; i < hubs.size() && running; i++) {
                // One pairing waits; others (rare) answer at once, each round.
                try { hubs.get(i).alive(i == 0 ? 240_000 : 0); ok = true; } catch (Exception ignored) { }
            }
            if (hubs.isEmpty()) break;
            // Updating automatically: a new version installs while nobody sees Harbor.
            if (ok && running) Update.background(this);
            if (!ok) {
                SystemClock.sleep(backoff);
                backoff = Math.min(backoff * 2, 5 * 60_000L);
            } else {
                backoff = 15_000;
            }
        }
        running = false;
        stopSelf();
    }

    @Override
    public void onDestroy() {
        running = false;
        if (loop != null) loop.interrupt();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent i) { return null; }
}
