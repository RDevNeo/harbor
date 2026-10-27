package dev.harbor.app;

import android.app.Activity;
import android.app.KeyguardManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInstaller;
import android.os.Build;
import android.os.PowerManager;
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
 *  installs itself without asking (UPDATE_PACKAGES_WITHOUT_USER_ACTION, a self-update, target
 *  SDK 33+); older ones show the system dialog. Google Play Protect may still ask to scan each
 *  new build (it hasn't seen it): that's the phone's setting, not something an app can skip.
 *  The same key must sign every build, or Android refuses the update. Gets the result too.
 *
 *  Updating automatically (Settings › Update automatically), the background jobs (Alive,
 *  Listen) install the newest app any PC offers while nobody sees Harbor (Quiet), and the next
 *  start opens the chat the user had ({@link #resume}). Also gets MY_PACKAGE_REPLACED. */
public class Update extends BroadcastReceiver {
    static volatile boolean busy;
    /** Settings while it's open: shown again when an install's result comes (a failure). */
    static volatile Runnable changed;

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
        int answered = 0; boolean auto = false;
        for (Hub h : Hub.all(c))
            for (String v : h.endpoints()) {
                try {
                    JSONObject app = h.callOn(v, "GET", "/v1/app", null);
                    long code = app.optLong("version_code");
                    if (code > best) { best = code; bh = h.id; bp = v; }
                    answered++;
                    JSONObject hub = app.optJSONObject("hub");
                    if (hub != null && hub.optBoolean("auto")) auto = true;
                } catch (Exception ignored) { } // that PC is away
            }
        bestHub = bh; bestPc = bp; bestCode = best;
        if (answered > 0) pcsAuto(c, auto);
        return best;
    }

    // ---- updating automatically ----

    /** Whether new versions install by themselves. Until it's chosen on this phone it follows
     *  the PCs: on when one of them updates automatically (Settings › Updates › Automatically
     *  there; `GET /v1/app` `hub.auto`, hubs from 0.53). */
    static boolean auto(Context c) { return Quiet.auto(autoChoice(c), Ui.prefs(c).getBoolean("pcs_auto", false)); }

    /** This phone's own choice, null when it follows the PCs. */
    static Boolean autoChoice(Context c) {
        SharedPreferences p = Ui.prefs(c);
        return p.contains("auto_update") ? p.getBoolean("auto_update", false) : null;
    }

    static void setAuto(Context c, boolean on) { Ui.prefs(c).edit().putBoolean("auto_update", on).apply(); }

    private static void pcsAuto(Context c, boolean on) {
        SharedPreferences p = Ui.prefs(c);
        if (p.getBoolean("pcs_auto", false) != on || !p.contains("pcs_auto")) p.edit().putBoolean("pcs_auto", on).apply();
    }

    /** Nobody sees Harbor now (Quiet.now): installing ends its process. */
    static boolean quiet(Context c) {
        PowerManager pm = c.getSystemService(PowerManager.class);
        KeyguardManager km = c.getSystemService(KeyguardManager.class);
        return Quiet.now(Base.resumed, pm == null || pm.isInteractive(), km != null && km.isKeyguardLocked());
    }

    /** Updating automatically, and nothing stops it (the sidebar's "Update available" then
     *  stays away): Android lets Harbor install, the verifier hasn't refused one, and the
     *  version on offer didn't fail. */
    static boolean silent(Context c, long offered) {
        if (!auto(c) || !c.getPackageManager().canRequestPackageInstalls() || blocked(c)) return false;
        return Ui.prefs(c).getLong("auto_fail_code", 0) != offered;
    }

    /** The phone's verifier (Google Play Protect) refused a background install: it wants the
     *  user there to scan each new version, so they're offered in a notification instead, until
     *  the user asks to try the background again (Settings). */
    static boolean blocked(Context c) { return Ui.prefs(c).getBoolean("auto_blocked", false); }

    static void unblock(Context c) { Ui.prefs(c).edit().remove("auto_blocked").apply(); }

    /** From the background jobs: installs the newest app any PC offers when updating
     *  automatically and nobody sees Harbor, or offers it in a notification when the background
     *  can't (Quiet.plan). Blocking. Android ends the process when it replaces the app; the
     *  next start opens where the user was. */
    static void background(Context c) {
        try {
            if (busy || !auto(c) || !c.getPackageManager().canRequestPackageInstalls()) return;
            SharedPreferences p = Ui.prefs(c);
            boolean blocked = blocked(c);
            // Installing needs nobody looking; a notification only needs Harbor out of sight
            // (in front, the sidebar and Settings say it).
            if (blocked ? Base.resumed > 0 : !quiet(c)) return;
            long best = check(c, false);
            Hub from = bestHub == null ? null : Hub.get(c, bestHub);
            if (from == null) return;
            switch (Quiet.plan(best, Settings.myCode(c), p.getLong("auto_fail_code", 0), blocked, p.getLong("offered_code", 0))) {
                case Quiet.INSTALL: install(c, from, null, true); break;
                case Quiet.OFFER: offer(c, best, from.id); break;
                default: break;
            }
        } catch (Away a) {
            // the next quiet moment
        } catch (Exception e) {
            // It didn't get as far as Android (the download): offered at the next look.
            failed(c, bestCode, Hub.why(e));
        }
    }

    /** The automatic try of `code` didn't go in: never again in the background (it's offered). */
    private static void failed(Context c, long code, String why) {
        if (code <= 0) return;
        Ui.prefs(c).edit().putLong("auto_fail_code", code).putLong("auto_fail_at", System.currentTimeMillis())
                .putString("auto_fail_why", why == null ? "" : why).apply();
    }

    /** Why the automatic update to `code` didn't go in ("" when it didn't fail). */
    static String failure(Context c, long code) {
        SharedPreferences p = Ui.prefs(c);
        return p.getLong("auto_fail_code", 0) == code ? p.getString("auto_fail_why", "") : "";
    }

    // ---- back where the user was ----

    /** Where the user is (Chats and Chat on resume): the PC, and the chat when one is open. */
    static void shown(Context c, String hub, String chat) {
        String v = (hub == null ? "" : hub) + "\n" + (chat == null ? "" : chat);
        SharedPreferences p = Ui.prefs(c);
        if (!v.equals(p.getString("shown", null))) p.edit().putString("shown", v).apply();
    }

    /** A cold start right after an update: opens the PC's chats and the chat the user had on
     *  top (its draft is kept). False: nothing to restore. */
    static boolean resume(Activity a) {
        SharedPreferences p = Ui.prefs(a);
        long from = p.getLong("resume_code", 0);
        if (from == 0) return false;
        p.edit().remove("resume_code").apply();
        if (Settings.myCode(a) == from) return false; // it didn't install
        String[] s = p.getString("shown", "").split("\n", -1);
        Hub h = s[0].isEmpty() ? null : Hub.get(a, s[0]);
        if (h == null) return false;
        Hub.setLast(a, h.id);
        a.startActivity(new Intent(a, Chats.class).putExtra("hub", h.id));
        if (s.length > 1 && !s[1].isEmpty()) a.startActivity(new Intent(a, Chat.class).putExtra("hub", h.id).putExtra("chat", s[1]));
        return true;
    }

    /** One PC this phone reaches, and what its Harbor says about itself (`GET /v1/app` `hub`,
     *  hubs from 0.51): info null = it didn't answer; info without "version" = an older Harbor. */
    static final class Pc {
        final Hub hub; final String v, name; JSONObject info;
        Pc(Hub hub, String v, String name) { this.hub = hub; this.v = v; this.name = name; }
        String version() { return info == null ? "" : info.optString("version"); }
        boolean managed() { return info != null && info.optBoolean("managed"); }
        boolean busy() { return info != null && (info.optBoolean("installing") || info.optBoolean("checking")); }
        /** Its Settings › Updates: true automatically, false asks; null before 0.53 (no say). */
        Boolean auto() { return info != null && info.has("auto") ? info.optBoolean("auto") : null; }
        /** It installs its own updates and asks first: the PCs sheet offers Auto-update. */
        boolean asks() { return managed() && Boolean.FALSE.equals(auto()); }
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

    /** Harbor came back on screen while the background's download ran: not now. */
    static final class Away extends IOException {
        Away() { super("Harbor is on screen"); }
    }

    /** Blocking: downloads and commits the session. Run off the UI thread. From the PC with the
     *  newest app when {@link #check} found one, else from the PC calls go to now. auto: the
     *  background's, which gives up quietly if Harbor came back on screen meanwhile. */
    static void install(Context c, Hub hub, Progress progress, boolean auto) throws Exception {
        if (busy) throw new IOException("already updating");
        long to = bestCode;
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
                // The download took a while: someone may be looking again. Next time, then.
                if (auto && !quiet(c)) throw new Away();
                busy = true;
                // The next start opens the chat the user had (if the version changes by then).
                Ui.prefs(c).edit().putLong("resume_code", Settings.myCode(c)).putLong("update_to", to).apply();
                int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
                // The result says whether it was the background's, and what to offer if it fails.
                Intent status = new Intent(c, Update.class).setAction("status").putExtra("auto", auto).putExtra("to", to)
                        .putExtra("hub", from != null && bestCode > Settings.myCode(c) ? from.id : hub.id);
                s.commit(PendingIntent.getBroadcast(c, id, status, flags).getIntentSender());
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
        if (Ui.app == null) Ui.app = c.getApplicationContext();
        if (Intent.ACTION_MY_PACKAGE_REPLACED.equals(i.getAction())) {
            // The new version: Android stopped the old one's jobs and service with it.
            Ui.prefs(c).edit().remove("auto_fail_code").remove("auto_fail_at").remove("auto_fail_why").apply();
            try { c.getSystemService(NotificationManager.class).cancel("update", 1); } catch (Exception ignored) { }
            Alive.schedule(c);
            Listen.apply(c);
            return;
        }
        int st = i.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        long to = i.getLongExtra("to", Ui.prefs(c).getLong("update_to", 0));
        boolean auto = i.getBooleanExtra("auto", false);
        boolean front = Base.resumed > 0;
        if (st == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            // Android 8–11, a copy whose installed version lacks the permission, or a phone that
            // wants to confirm anyway: the system asks. In front (Update tapped) at once; in the
            // background a notification, so no dialog ever jumps over what the user is doing.
            Intent confirm = i.getParcelableExtra(Intent.EXTRA_INTENT);
            busy = false;
            if (confirm == null) return;
            confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (front) {
                try { c.startActivity(confirm); return; } catch (Exception ignored) { }
            }
            failed(c, to, "Android wants you to confirm it");
            ask(c, confirm, to);
        } else {
            busy = false;
            if (st == PackageInstaller.STATUS_SUCCESS) {
                if (auto) unblock(c); // the background works on this phone again
                return;
            }
            String msg = i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
            String why = Quiet.reason(st, msg);
            failed(c, to, why);
            Runnable r = changed;
            if (r != null) Ui.main.post(r);
            if (auto) {
                // Most often Google Play Protect: it wants to ask "Scan app?" for a version it
                // hasn't seen, which it can't with nobody there (INSTALL_FAILED_VERIFICATION_FAILURE).
                // Offered instead: a tap installs it in front, where it can ask. Later versions skip
                // the doomed background try.
                if (Quiet.verifier(st, msg)) Ui.prefs(c).edit().putBoolean("auto_blocked", true).apply();
                offer(c, to, i.getStringExtra("hub"));
            } else if (front) {
                Toast.makeText(c, "Harbor couldn't update: " + why, Toast.LENGTH_LONG).show();
            }
        }
    }

    /** "Harbor X is ready: tap to install": once per version. The tap opens Settings, which
     *  installs it in front (Settings.update), where Play Protect can ask to scan it. */
    static void offer(Context c, long code, String hubId) {
        SharedPreferences p = Ui.prefs(c);
        if (code <= 0 || p.getLong("offered_code", 0) == code) return;
        Hub h = hubId == null ? null : Hub.get(c, hubId);
        if (h == null) h = Hub.get(c, Hub.last(c));
        if (h == null && !Hub.all(c).isEmpty()) h = Hub.all(c).get(0);
        if (h == null) return;
        try {
            NotificationManager nm = c.getSystemService(NotificationManager.class);
            nm.createNotificationChannel(new NotificationChannel("update", "App updates", NotificationManager.IMPORTANCE_LOW));
            // Harbor's start screen under it, so Back from Settings lands in the app.
            Intent home = new Intent(c, Hubs.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
            Intent install = new Intent(c, Settings.class).putExtra("hub", h.id).putExtra("install", code);
            PendingIntent pi = PendingIntent.getActivities(c, 12, new Intent[] { home, install }, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            Notification n = new Notification.Builder(c, "update").setSmallIcon(R.drawable.ic_stat)
                    .setContentTitle("Harbor " + Settings.name(code) + " is ready")
                    .setContentText("It couldn't install by itself: tap to install it.")
                    .setStyle(new Notification.BigTextStyle().bigText(blocked(c)
                            ? "It couldn't install by itself: tap to install it. Google Play Protect may ask to scan it first (Scan app)."
                            : "It couldn't install by itself: tap to install it."))
                    .setContentIntent(pi).setAutoCancel(true).build();
            nm.notify("update", 1, n);
            p.edit().putLong("offered_code", code).apply();
        } catch (Exception ignored) { } // notifications off: Settings › Update still shows it
    }

    /** The system's confirmation, behind a notification: tap to finish installing. */
    private static void ask(Context c, Intent confirm, long to) {
        try {
            NotificationManager nm = c.getSystemService(NotificationManager.class);
            nm.createNotificationChannel(new NotificationChannel("update", "App updates", NotificationManager.IMPORTANCE_LOW));
            PendingIntent pi = PendingIntent.getActivity(c, 11, confirm, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            String v = to > 0 ? " " + Settings.name(to) : "";
            Notification n = new Notification.Builder(c, "update").setSmallIcon(R.drawable.ic_stat)
                    .setContentTitle("Harbor" + v + " is ready")
                    .setContentText("Android asks you to confirm the update: tap to install it.")
                    .setContentIntent(pi).setAutoCancel(true).build();
            nm.notify("update", 1, n);
            if (to > 0) Ui.prefs(c).edit().putLong("offered_code", to).apply(); // offered: no second notification
        } catch (Exception ignored) { } // notifications off: Settings › Update still shows it
    }
}
