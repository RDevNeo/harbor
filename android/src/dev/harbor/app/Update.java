package dev.harbor.app;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.os.Build;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Installs the APK the hub serves (GET /app.apk) over this app, through a PackageInstaller
 *  session. Needs "Install unknown apps" for Harbor once. Android 12+ updates an app that
 *  installs itself without asking; older ones (or the first time) show the system dialog.
 *  The same key must sign every build, or Android refuses the update. Gets the result too. */
public class Update extends BroadcastReceiver {
    static volatile boolean busy;

    interface Progress { void at(long done, long total); }

    /** The newest app any PC of any pairing offers (versionCode, its pairing's id, the PC: ""
     *  for the paired one), from the last {@link #check}. */
    static volatile long bestCode;
    static volatile String bestHub, bestPc;
    private static volatile long checked;

    /** Asks every PC of every pairing which app it serves (GET /v1/app), at most every
     *  10 minutes unless forced: a PC that runs an older Harbor isn't the last word. Blocking. */
    static long check(Context c, boolean force) {
        if (!force && System.currentTimeMillis() - checked < 600_000) return bestCode;
        checked = System.currentTimeMillis();
        long best = 0; String bh = null, bp = null;
        for (Hub h : Hub.all(c))
            for (String v : h.endpoints()) {
                try {
                    long code = h.callOn(v, "GET", "/v1/app", null).optLong("version_code");
                    if (code > best) { best = code; bh = h.id; bp = v; }
                } catch (Exception ignored) { } // that PC is away
            }
        bestHub = bh; bestPc = bp; bestCode = best;
        return best;
    }

    /** One PC this phone reaches, and what its Harbor says about itself (`GET /v1/app` `hub`,
     *  hubs from 0.51): info null = it didn't answer; info without "version" = an older Harbor. */
    static final class Pc {
        final Hub hub; final String v, name; JSONObject info;
        Pc(Hub hub, String v, String name) { this.hub = hub; this.v = v; this.name = name; }
        String version() { return info == null ? "" : info.optString("version"); }
        boolean managed() { return info != null && info.optBoolean("managed"); }
        boolean busy() { return info != null && (info.optBoolean("installing") || info.optBoolean("checking")); }
        String status() { return info == null ? "" : info.optString("status"); }
    }

    /** Every PC of every pairing once (a PC two pairings reach is asked once), with its Harbor
     *  version. Blocking. Also notes the newest app any of them serves, as {@link #check}. */
    static List<Pc> pcs(Context c) {
        List<Pc> out = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (Hub h : Hub.all(c))
            for (String v : h.endpoints()) {
                String key = v.isEmpty() ? h.pid : v;
                if (key == null || key.isEmpty()) key = h.id + "/" + v;
                if (!seen.add(key)) continue;
                Pc pc = new Pc(h, v, h.labelOn(v));
                try {
                    JSONObject app = h.callOn(v, "GET", "/v1/app", null);
                    JSONObject hub = app.optJSONObject("hub");
                    pc.info = hub != null ? hub : new JSONObject();
                } catch (Exception ignored) { } // that PC is away
                out.add(pc);
            }
        return out;
    }

    /** The newest Harbor any PC runs or knows of ("" when none says). */
    static String newest(List<Pc> pcs) {
        String best = "";
        for (Pc p : pcs) {
            if (p.info == null) continue;
            for (String v : new String[] { p.version(), p.info.isNull("latest") ? "" : p.info.optString("latest") })
                if (code(v) > code(best)) best = v;
        }
        return best;
    }

    /** A PC that installs its own updates and runs an older Harbor than `newest`: its Update
     *  (`POST /v1/hub/update`) checks for the release itself when it hasn't yet. */
    static boolean behind(Pc p, String newest) {
        return p.managed() && !p.version().isEmpty() && code(newest) > code(p.version());
    }

    /** "0.51.1" → 49001, as versionCode (Cargo.toml): only to compare. */
    static long code(String v) {
        if (v == null) return 0;
        String[] p = v.trim().replaceFirst("^v", "").split("-")[0].split("\\.");
        long out = 0;
        for (int i = 0; i < 3; i++) {
            long n = 0;
            try { if (i < p.length) n = Long.parseLong(p[i]); } catch (NumberFormatException e) { return 0; }
            out = out * 1000 + n;
        }
        return out;
    }

    /** Blocking: downloads and commits the session. Run off the UI thread. From the PC with the
     *  newest app when {@link #check} found one, else from the PC calls go to now. */
    static void install(Context c, Hub hub, Progress progress) throws Exception {
        if (busy) throw new IOException("already updating");
        Hub from = bestHub == null ? null : Hub.get(c, bestHub);
        Net.Http http = from != null && bestCode > Settings.myCode(c) ? from.openOn(bestPc, "GET", "/app.apk", 60_000)
                : hub.open("GET", "/app.apk", 60_000, true);
        try {
            int code = http.code();
            if (code != 200) throw new IOException("the PC has no app to send (HTTP " + code + ")");
            long size = http.length();
            if (size <= 0) throw new IOException("the PC sent no size for the app");
            PackageInstaller pi = c.getPackageManager().getPackageInstaller();
            PackageInstaller.SessionParams p = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
            p.setAppPackageName(c.getPackageName());
            if (Build.VERSION.SDK_INT >= 31) p.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
            int id = pi.createSession(p);
            try (PackageInstaller.Session s = pi.openSession(id); InputStream in = http.in()) {
                try (OutputStream out = s.openWrite("app.apk", 0, size)) {
                    byte[] buf = new byte[1 << 16];
                    long done = 0;
                    while (done < size) {
                        int n = in.read(buf, 0, (int) Math.min(buf.length, size - done));
                        if (n < 0) throw new IOException("the download stopped early");
                        out.write(buf, 0, n);
                        done += n;
                        if (progress != null) progress.at(done, size);
                    }
                    s.fsync(out);
                }
                busy = true;
                int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
                s.commit(PendingIntent.getBroadcast(c, id, new Intent(c, Update.class).setAction("status"), flags).getIntentSender());
            } catch (Exception e) {
                busy = false;
                pi.abandonSession(id);
                throw e;
            }
        } finally {
            http.close();
        }
    }

    @Override
    public void onReceive(Context c, Intent i) {
        int st = i.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (st == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            // Android 8–11, or the first update of a browser-installed copy: the system asks.
            Intent confirm = i.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm != null) {
                try { c.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); return; } catch (Exception ignored) { }
            }
            busy = false;
        } else {
            busy = false;
            if (st != PackageInstaller.STATUS_SUCCESS) {
                String why = i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
                Toast.makeText(c, "Harbor couldn't update: " + (why == null ? "status " + st : why), Toast.LENGTH_LONG).show();
            }
        }
    }
}
