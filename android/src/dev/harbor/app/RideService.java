package dev.harbor.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/** A GPS ride being recorded (Routine's ride goals): a location foreground service, so it goes on
 *  with the screen off. Pausable; each resume starts a new segment (distance and climb never cross a
 *  pause). Its state is kept in a file as fixes arrive, so a killed app loses nothing. Stop sends
 *  the track to the PC (POST /v1/routine/ride/finish: the engine filters it, measures it and logs
 *  the ride); when the PC can't be reached it's kept and sent the next time Routine opens. */
public class RideService extends Service implements LocationListener {
    private static final String CHANNEL = "ride";
    private static final int NOTE = 7301;
    // The same filter as the engine's track.ts (MAX_ACCURACY_M, MIN_STEP_M, MAX_SPEED_MS), for the live distance only.
    private static final float MAX_ACC = 25f, MIN_STEP = 4f, MAX_SPEED = 25f;

    /** What Routine shows of the ride. */
    static final class State {
        String goal, hub;
        long startedAt, accMs, runningSince; // runningSince 0 = paused
        int seg;
        double distM;
        boolean paused;
        JSONArray points = new JSONArray();

        long movingMs() { return accMs + (runningSince > 0 ? Math.max(0, System.currentTimeMillis() - runningSince) : 0); }
    }

    private static File file(Context c) { return new File(c.getFilesDir(), "ride-active.json"); }
    private static File pending(Context c) { return new File(c.getFilesDir(), "ride-pending.json"); }

    static synchronized State state(Context c) {
        try {
            File f = file(c);
            if (!f.exists()) return null;
            JSONObject o = new JSONObject(new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8));
            State s = new State();
            s.goal = o.getString("goal");
            s.hub = o.optString("hub");
            s.startedAt = o.optLong("startedAt");
            s.accMs = o.optLong("accMs");
            s.runningSince = o.optLong("runningSince");
            s.seg = o.optInt("seg");
            s.distM = o.optDouble("distM");
            s.paused = s.runningSince == 0;
            JSONArray p = o.optJSONArray("points");
            if (p != null) s.points = p;
            return s;
        } catch (Exception e) {
            return null;
        }
    }

    private static synchronized void save(Context c, State s) {
        try {
            JSONObject o = new JSONObject().put("goal", s.goal).put("hub", s.hub).put("startedAt", s.startedAt).put("accMs", s.accMs)
                    .put("runningSince", s.runningSince).put("seg", s.seg).put("distM", s.distM).put("points", s.points);
            File tmp = new File(c.getFilesDir(), "ride-active.tmp");
            try (FileOutputStream out = new FileOutputStream(tmp)) { out.write(o.toString().getBytes(StandardCharsets.UTF_8)); }
            tmp.renameTo(file(c));
        } catch (Exception ignored) { }
    }

    static void start(Context c, Hub hub, String goal) {
        State s = new State();
        s.goal = goal;
        s.hub = hub == null ? "" : hub.id;
        s.startedAt = System.currentTimeMillis();
        s.runningSince = s.startedAt;
        save(c, s);
        Intent i = new Intent(c, RideService.class);
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
        live(c, s);
    }

    static void pause(Context c) {
        State s = state(c);
        if (s == null || s.paused) return;
        s.accMs = s.movingMs();
        s.runningSince = 0;
        save(c, s);
        live(c, s);
    }

    static void resume(Context c) {
        State s = state(c);
        if (s == null || !s.paused) return;
        s.runningSince = System.currentTimeMillis();
        s.seg++;
        save(c, s);
        live(c, s);
    }

    /** Ends the ride: the track goes to the PC (or waits for the next try), the service stops. */
    static void stop(Context c) {
        State s = state(c);
        c.stopService(new Intent(c, RideService.class));
        if (s == null) return;
        try {
            JSONObject finish = new JSONObject().put("goal", s.goal).put("points", s.points).put("movingMs", s.movingMs()).put("at", s.startedAt).put("hub", s.hub);
            File tmp = new File(c.getFilesDir(), "ride-pending.tmp");
            try (FileOutputStream out = new FileOutputStream(tmp)) { out.write(finish.toString().getBytes(StandardCharsets.UTF_8)); }
            tmp.renameTo(pending(c));
        } catch (Exception ignored) { }
        file(c).delete();
        send(c);
    }

    /** A finished ride not yet on the PC goes now (Routine calls it when it opens). */
    static void send(Context c) {
        final Context app = c.getApplicationContext();
        Ui.pool.execute(() -> {
            File f = pending(app);
            if (!f.exists()) return;
            try {
                JSONObject body = new JSONObject(new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8));
                Hub h = Hub.get(app, body.optString("hub"));
                if (h == null) h = Tabs.hub(app);
                if (h == null) return;
                body.remove("hub");
                JSONObject r = h.call("POST", "/v1/routine/ride/finish", body);
                f.delete();
                JSONObject ride = r.optJSONObject("ride");
                if (ride != null) Ui.main.post(() -> Ui.toast(app, String.format(java.util.Locale.ROOT, "Ride saved: %.2f km", ride.optDouble("km"))));
            } catch (Exception e) {
                Ui.main.post(() -> Ui.toast(app, "The ride is kept on the phone until the PC answers"));
            }
        });
    }

    /** Tells the PC (its window shows the ride live). Best effort. */
    private static void live(Context c, State s) {
        final Context app = c.getApplicationContext();
        Ui.pool.execute(() -> {
            try {
                Hub h = Hub.get(app, s.hub);
                if (h == null) return;
                JSONObject session = new JSONObject().put("accMs", s.accMs).put("runningSince", s.runningSince == 0 ? JSONObject.NULL : s.runningSince);
                h.call("POST", "/v1/routine/ride", new JSONObject().put("active", new JSONObject().put("goalId", s.goal).put("session", session).put("distM", s.distM).put("gainM", 0)));
            } catch (Exception ignored) { }
        });
    }

    // ---------- the service ----------

    private LocationManager lm;
    private long lastLive;

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Ride", NotificationManager.IMPORTANCE_LOW));
        Intent open = new Intent(this, Routine.class).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder nb = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        Notification n = nb.setContentTitle("Recording a ride").setContentText("Routine · Hub").setSmallIcon(Ui.statIcon(this)).setOngoing(true).setContentIntent(pi).build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTE, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        else startForeground(NOTE, n);
        lm = getSystemService(LocationManager.class);
        try {
            lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000, 0, this, Looper.getMainLooper());
        } catch (SecurityException e) {
            stopSelf();
        }
    }

    @Override
    public int onStartCommand(Intent i, int flags, int id) { return START_STICKY; }

    @Override
    public void onDestroy() {
        if (lm != null) lm.removeUpdates(this);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent i) { return null; }

    @Override
    public void onLocationChanged(Location l) {
        State s = state(this);
        if (s == null) { stopSelf(); return; }
        if (s.paused) return;
        try {
            JSONObject p = new JSONObject().put("t", l.getTime()).put("lat", l.getLatitude()).put("lon", l.getLongitude()).put("acc", l.getAccuracy()).put("seg", s.seg);
            if (l.hasAltitude()) p.put("alt", l.getAltitude());
            if (Build.VERSION.SDK_INT >= 26 && l.hasVerticalAccuracy()) p.put("altAcc", l.getVerticalAccuracyMeters());
            if (l.hasSpeed()) p.put("speed", l.getSpeed());
            JSONObject last = s.points.length() > 0 ? s.points.getJSONObject(s.points.length() - 1) : null;
            if (l.getAccuracy() <= MAX_ACC && last != null && last.optInt("seg") == s.seg) {
                float[] d = new float[1];
                Location.distanceBetween(last.getDouble("lat"), last.getDouble("lon"), l.getLatitude(), l.getLongitude(), d);
                double dt = (l.getTime() - last.getLong("t")) / 1000.0;
                if (d[0] >= MIN_STEP && dt > 0 && d[0] / dt <= MAX_SPEED) s.distM += d[0];
            }
            s.points.put(p);
            save(this, s);
            long now = System.currentTimeMillis();
            if (now - lastLive > 15_000) { lastLive = now; live(this, s); }
        } catch (Exception ignored) { }
    }

    @Override public void onStatusChanged(String p, int status, Bundle extras) { }
    @Override public void onProviderEnabled(String p) { }
    @Override public void onProviderDisabled(String p) { }
}
