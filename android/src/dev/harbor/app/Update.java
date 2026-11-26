package dev.harbor.app;

import android.app.Activity;
import android.app.ActivityManager;
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
import android.os.SystemClock;
import android.util.Log;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

import dev.harbor.shell.Boot;
import dev.harbor.shell.Minisign;
import dev.harbor.shell.Shell;


/** Hub: updates this app from its own PC, not from GitHub (HUB.md "Updates"): the PC that
 *  follows Hub's branch builds the app's code when a push changes it, signs it with Hub's code key
 *  (Minisign.HUB_PUBKEY) and serves it under /phone/ (ts/packages/update/src/phoneota.ts):
 *  hub-app.json names what's on offer (its code and APK, as harbor-app.json did), and
 *  GET /phone/wait?have=N, held while a Hub screen is up (Listen, hold), says within a second that
 *  something new is served. Everything below then works as it did with Harbor's releases: the code
 *  goes in without an install (Shell.stage, a live restart back on the same screen: Swap), and only
 *  a new shell (or Android 8) installs the APK, which the app downloads and offers itself.
 *  Version numbers are the commit's time in seconds; names ("0.194.0+abc1234") come with the offer.
 *
 *  Harbor's notes, still true of what happens once an update is known: the
 *  latest release's harbor-app.json (signed) names the phone app it ships, and its
 *  latest release's harbor-app.json (signed) names the phone app it ships, and its
 *  harbor-android.apk is downloaded from GitHub straight into a PackageInstaller session and
 *  installed only when its minisign signature checks out with Harbor's release key (Minisign,
 *  the desktop updater's key). Needs "Install unknown apps" for Harbor once. Android 12+
 *  updates an app that installs itself without asking (UPDATE_PACKAGES_WITHOUT_USER_ACTION, a
 *  self-update, target SDK 33+); older ones show the system dialog. Google Play Protect may
 *  still ask to scan each new build (it hasn't seen it): that's the phone's setting, not
 *  something an app can skip. The same key must sign every build, or Android refuses it.
 *
 *  Updates are always automatic (no setting), and nothing about them goes through a PC or the
 *  workspace: the account service's public release news (GET /v1/release/wait, no sign-in; the
 *  release workflow tells it the moment a release is published) says within seconds that a
 *  release is out ({@link #hear}: Listen's own thread holds it, Alive's job and opening the app
 *  ask once), and GitHub's releases/latest every few minutes is the fallback. The new app is
 *  then downloaded and its signature checked at once ({@link #fetch}, into the app's storage),
 *  so installing is a copy and a commit; it installs as soon as nobody sees Harbor (Quiet: the
 *  screen off or locked, or Harbor out of sight for a few seconds), and the next start opens
 *  the chat the user had ({@link #resume}). Also gets MY_PACKAGE_REPLACED.
 *
 *  Since shell 1 (android/README.md, "Shell and code") a release also names its app code alone
 *  (harbor-app.json `phone`: harbor-phone-code.zip). On Android 9+ that's how this app updates
 *  ({@link Quiet#route}): the code is downloaded, checked and staged by the shell (Shell.stage),
 *  and runs from the next process start, which {@link #round} brings about when nobody sees
 *  Harbor (Shell.restart; Settings' Update does it at once and opens Harbor again). No install,
 *  so Play Protect has nothing to scan. The APK only installs when the newest code needs a newer
 *  shell (a new permission, screen or native library), on Android 8, or for a release that names
 *  no code. */
public class Update extends BroadcastReceiver {
    static volatile boolean busy;
    /** Settings while it's open: shown again when an install's result comes (a failure). */
    static volatile Runnable changed;

    interface Progress { void at(long done, long total); }

    static final String TAG = "harbor-update";
    static final String REPO = "https://github.com/RDevNeo/harbor";
    /** Where the PC serves the phone's updates (phoneota.ts). */
    static final String PHONE = "/phone/";
    /** How long the release news holds a question when nothing's new (seconds; the service
     *  allows 240). Each answer wakes the radio: fewer is less battery. */
    static final int HOLD_S = 240;
    static final String APK = "harbor-android.apk", MANIFEST = "hub-app.json", CODE = Boot.ASSET;
    /** Between two looks at GitHub (a HEAD of releases/latest, ~5 KB: the website, not the API
     *  with its 60 calls an hour), unless forced. */
    static final long GAP = 60_000;

    /** The newest app the latest release ships (versionCode) and the release whose files hold it
     *  (a release that didn't change the app carries an earlier one's), from the last {@link #check}:
     *  its code alone (bestKind Quiet.CODE) or its APK (Quiet.APK). */
    static volatile long bestCode;
    static volatile String bestRelease;
    static volatile int bestKind = Quiet.APK;
    private static volatile long checked;

    /** What the latest release names (harbor-app.json): its APK (versionCode, release, shell
     *  version; shell 0 before shells) and its app code (version, release, the shell it needs;
     *  code 0: none named). */
    static final class Offer {
        long apkCode, code;
        String apkRelease = "", codeRelease = "";
        int apkShell, minShell;
    }

    private static volatile Offer offer;

    static Offer offerFrom(JSONObject manifest, String tag) {
        Offer o = new Offer();
        JSONObject apk = manifest.optJSONObject("apk"), code = manifest.optJSONObject("phone");
        if (apk != null) {
            o.apkCode = apk.optLong("code");
            o.apkRelease = apk.optString("release", tag).replaceFirst("^v", "");
            o.apkShell = apk.optInt("shell");
        }
        if (code != null) {
            o.code = code.optLong("code");
            o.codeRelease = code.optString("release", tag).replaceFirst("^v", "");
            o.minShell = code.optInt("minShell", Integer.MAX_VALUE);
        }
        return o;
    }

    /** Where this phone goes from the offer (Quiet.route): sets bestCode, bestRelease and bestKind.
     *  Code that failed here (the shell rolled it back) isn't taken again: the next release. */
    private static long pick(Context c, Offer o) {
        long mine = Settings.myCode(c);
        int r = Quiet.route(mine, Shell.VERSION, Shell.loads(), o.apkCode, o.apkShell, o.code, o.minShell);
        if (r == Quiet.CODE && Shell.bad(c, o.code)) r = Quiet.KEEP;
        if (r == Quiet.CODE) { bestRelease = o.codeRelease; bestKind = Quiet.CODE; bestCode = o.code; }
        else if (r == Quiet.APK) { bestRelease = o.apkRelease; bestKind = Quiet.APK; bestCode = o.apkCode; }
        else { bestRelease = null; bestKind = Quiet.KEEP; bestCode = mine; }
        return bestCode;
    }

    /** Looks at GitHub's latest release, at most every {@link #GAP} unless forced. Only a new tag
     *  costs more: its harbor-app.json and signature (a few KB), checked before anything is
     *  believed. Blocking; throws when GitHub can't be reached. */
    static long check(Context c, boolean force) throws IOException {
        return Rig.on() ? Rig.update(c, force) : look(c, force);
    }

    private static final Object looking = new Object(), fetching = new Object();

    static long look(Context c, boolean force) throws IOException {
        synchronized (looking) { return lookNow(c, force); }
    }

    /** Hub takes nothing from Harbor's releases: its updates come from its PC (above). */
    static final boolean OFF = false;

    private static long lookNow(Context c, boolean force) throws IOException {
        if (OFF) return 0;
        if (!force && System.currentTimeMillis() - checked < GAP) return known(c);
        checked = System.currentTimeMillis();
        SharedPreferences p = Ui.prefs(c);
        byte[] json = get(c, PHONE + MANIFEST, 1 << 20);
        byte[] sigBytes = json == null ? null : get(c, PHONE + MANIFEST + ".minisig", 4096);
        if (json == null || sigBytes == null) return known(c); // the PC serves no phone app (yet)
        String sig = new String(sigBytes, StandardCharsets.UTF_8);
        Offer o;
        String tag;
        try {
            JSONObject j = new JSONObject(new String(json, StandardCharsets.UTF_8));
            tag = j.optString("release", "");
            // Signed by Hub's code key, for the release it names.
            Minisign.check(Minisign.HUB_PUBKEY, json, sig, tag, MANIFEST);
            o = offerFrom(j, tag);
        } catch (GeneralSecurityException | org.json.JSONException e) {
            throw new IOException("the PC's " + MANIFEST + ": " + e.getMessage());
        }
        if (o.apkCode <= 0 && o.code <= 0) return known(c);
        offer = o;
        named(c, o.code, o.codeRelease);
        named(c, o.apkCode, o.apkRelease);
        p.edit().putLong("ota_have", Math.max(o.code, o.apkCode)).apply();
        // Kept for the next start: Settings and the sheet know the version on offer at once.
        p.edit().putString("gh_tag", tag).putLong("known_code", o.apkCode).putString("known_release", o.apkRelease)
                .putInt("known_shell", o.apkShell).putLong("known_phone", o.code).putString("known_phone_release", o.codeRelease)
                .putInt("known_min_shell", o.minShell).apply();
        return pick(c, o);
    }

    /** Hub's version numbers are times; the names that go with them come with the offer. */
    static void named(Context c, long code, String name) {
        if (code <= 0 || name == null || name.isEmpty()) return;
        SharedPreferences p = Ui.prefs(c);
        if (!name.equals(p.getString("code_name_" + code, null))) p.edit().putString("code_name_" + code, name).apply();
    }

    /** The name of version `code` (null: not known here). */
    static String nameOf(long code) {
        if (code == Shell.code()) return Shell.name();
        return Ui.app == null ? null : Ui.prefs(Ui.app).getString("code_name_" + code, null);
    }

    /** The PC this phone takes its updates from: the one in use, else the first. */
    static Hub pc(Context c) {
        Hub h = Hub.get(c, Hub.last(c));
        if (h == null && !Hub.all(c).isEmpty()) h = Hub.all(c).get(0);
        return h;
    }

    /** A GET to that PC (pinned TLS, as every call: Hub.open). */
    private static Net.Http pcGet(Context c, String path, int readTimeout) throws IOException {
        Hub h = pc(c);
        if (h == null) throw new IOException("no PC paired yet");
        return h.open("GET", path, readTimeout, true);
    }

    /** A small file the PC serves, whole; null when it has none. */
    private static byte[] get(Context c, String path, int max) throws IOException {
        Net.Http h = pcGet(c, path, 30_000);
        try {
            int code = h.code();
            if (code == 404) return null;
            if (code != 200) throw new IOException("the PC answered HTTP " + code);
            try (InputStream in = h.in()) {
                java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    if (out.size() > max) throw new IOException("too big: " + path);
                }
                return out.toByteArray();
            }
        } finally {
            h.close();
        }
    }

    /** The newest app known to be on offer, without asking GitHub: the last {@link #check}'s,
     *  this run's or the one before the process last ended. 0: none known. */
    static long known(Context c) {
        if (Rig.on()) {
            if (bestCode <= 0) Rig.update(c);
            return bestCode;
        }
        Offer o = offer;
        if (o == null) {
            SharedPreferences p = Ui.prefs(c);
            o = new Offer();
            o.apkCode = p.getLong("known_code", 0);
            o.apkRelease = p.getString("known_release", "");
            o.apkShell = p.getInt("known_shell", 0);
            o.code = p.getLong("known_phone", 0);
            o.codeRelease = p.getString("known_phone_release", "");
            o.minShell = p.getInt("known_min_shell", Integer.MAX_VALUE);
            if (o.apkRelease.isEmpty()) o.apkCode = 0;
            if (o.codeRelease.isEmpty()) o.code = 0;
            if (o.apkCode <= 0 && o.code <= 0) return bestCode;
            offer = o;
        }
        return pick(c, o);
    }

    /** releases/latest answers with a redirect to the latest tag's page: the tag without "v". */
    static String latestTag() throws IOException {
        HttpURLConnection h = (HttpURLConnection) new URL(REPO + "/releases/latest").openConnection();
        try {
            h.setInstanceFollowRedirects(false);
            h.setRequestMethod("HEAD");
            h.setConnectTimeout(15_000);
            h.setReadTimeout(20_000);
            h.setRequestProperty("User-Agent", "harbor-android");
            int code = h.getResponseCode();
            if (code < 300 || code >= 400) throw new IOException("GitHub answered HTTP " + code);
            return tagFrom(h.getHeaderField("Location"));
        } finally {
            h.disconnect();
        }
    }

    /** ".../releases/tag/v0.156.0" -> "0.156.0"; null for anything else. */
    static String tagFrom(String location) {
        if (location == null) return null;
        int at = location.lastIndexOf("/tag/");
        if (at < 0) return null;
        String t = location.substring(at + 5).trim();
        if (t.startsWith("v")) t = t.substring(1);
        return t.matches("\\d+\\.\\d+\\.\\d+") ? t : null;
    }

    /** A small release file, whole; null when the release doesn't have it (yet). */
    private static byte[] get(String url, int max) throws IOException {
        HttpURLConnection h = open(url);
        try {
            int code = h.getResponseCode();
            if (code == 404) return null;
            if (code != 200) throw new IOException("GitHub answered HTTP " + code);
            try (InputStream in = h.getInputStream()) {
                java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    if (out.size() > max) throw new IOException("too big: " + url);
                }
                return out.toByteArray();
            }
        } finally {
            h.disconnect();
        }
    }

    /** What went wrong talking to GitHub, said plainly. */
    static String why(Throwable e) {
        if (e instanceof java.net.UnknownHostException || e instanceof java.net.ConnectException || e instanceof java.net.SocketTimeoutException) return "Your PC isn't answering (Hub updates come from it). Try again soon.";
        if (e instanceof javax.net.ssl.SSLException) return "Couldn't set up the encrypted connection to your PC: " + e.getMessage();
        String m = e.getMessage();
        return m == null || m.isEmpty() ? e.getClass().getSimpleName() : m;
    }

    // ---- release news (no PC, no sign-in) ----

    /** Blocking: asks the account service's public release news (worker/src/release.js) whether
     *  a release newer than the newest this phone knows of is out: held up to holdS seconds (0:
     *  answers at once). The release it names (only a reason to look at GitHub: nothing it says
     *  is believed), or null when nothing newer came within the hold. Throws when it can't be
     *  reached. */
    static String hear(Context c, int holdS) throws IOException {
        if (OFF) return null;
        SharedPreferences p = Ui.prefs(c);
        long have = p.getLong("ota_have", 0);
        Net.Http h = pcGet(c, PHONE + "wait?have=" + have + "&wait=" + holdS, holdS * 1000 + 30_000);
        try {
            int code = h.code();
            if (code != 200) throw new IOException("update news: HTTP " + code);
            JSONObject r;
            try {
                r = new JSONObject(Hub.read(h.in()));
            } catch (org.json.JSONException e) {
                throw new IOException("update news: " + e.getMessage());
            }
            if (!r.optBoolean("changed")) return null;
            JSONObject o = r.optJSONObject("offer");
            return o == null ? "?" : o.optString("release", "?");
        } finally {
            h.close();
        }
    }

    /** Release `v` is out (the news): GitHub's latest release is read now (a few tries while it
     *  still names the one before), then the new app is downloaded and installed when it may be
     *  (round). Blocking. */
    static void news(Context c, String v) {
        long t0 = SystemClock.elapsedRealtime();
        Log.i(TAG, "release " + v + " is out (news)");
        // Hub: the PC serves it already (the manifest is written last): one look.
        try { check(c, true); } catch (IOException e) { Log.i(TAG, "the PC: " + why(e)); }
        Log.i(TAG, "the PC offers " + Ui.prefs(c).getString("gh_tag", "?") + ", app " + bestCode + " (" + (SystemClock.elapsedRealtime() - t0) + " ms)");
        round(c);
    }

    /** Asks the news once, without waiting (Alive's job, opening the app). Blocking. */
    static void catchUp(Context c) {
        try {
            String v = hear(c, 0);
            if (v != null) news(c, v);
        } catch (Exception ignored) { } // offline: Listen's thread or the next job
    }

    private static final ExecutorService worker = Executors.newSingleThreadExecutor();
    private static volatile long openedAt;

    /** A Harbor screen came on screen with none before (Base.onStart): what's new, at once, and
     *  the news held while a screen is up when Listen isn't holding it. */
    static void opened(Context c) {
        long now = SystemClock.elapsedRealtime();
        if (Rig.on()) return;
        hold(c);
        if (openedAt != 0 && now - openedAt < 30_000) return;
        openedAt = now;
        worker.execute(() -> catchUp(c));
    }

    private static final AtomicBoolean holding = new AtomicBoolean();

    /** The release news held (as Listen's thread does) while a Harbor screen is up and Listen
     *  doesn't run (Android refused its start, no PC yet): a release is heard within seconds and
     *  its code goes in live (codeRound, Swap). Ends once no screen is up (after the answer it
     *  waits for, at most HOLD_S). */
    private static void hold(Context c) {
        if (Listen.listening() || !holding.compareAndSet(false, true)) return;
        Thread t = new Thread(() -> {
            int fails = 0;
            try {
                while (Base.started > 0 && !Listen.listening()) {
                    String v = null;
                    try {
                        v = hear(c, HOLD_S);
                        fails = 0;
                    } catch (Exception e) {
                        fails++;
                    }
                    if (Base.started <= 0 || Listen.listening()) break;
                    if (v != null) news(c, v);
                    else round(c);
                    if (fails > 0) SystemClock.sleep(Quiet.backoff(fails));
                }
            } finally {
                holding.set(false);
            }
        }, "update-news-front");
        t.setDaemon(true);
        t.start();
    }

    /** The last Harbor screen went out of sight (Base.onStop): a round once the screen is off
     *  and again after the grace, when the update waiting for that installs. */
    static void left(Context c) {
        Ui.main.postDelayed(() -> soon(c), 1_500);
        Ui.main.postDelayed(() -> soon(c), Quiet.GRACE_MS + 500);
    }

    /** A {@link #round} off the caller's thread. */
    static void soon(Context c) {
        worker.execute(() -> round(c));
    }

    /** A GET that follows GitHub's redirect to its file host (HTTPS to HTTPS). */
    private static HttpURLConnection open(String url) throws IOException {
        HttpURLConnection h = (HttpURLConnection) new URL(url).openConnection();
        h.setInstanceFollowRedirects(true);
        h.setConnectTimeout(15_000);
        h.setReadTimeout(60_000);
        h.setRequestProperty("User-Agent", "harbor-android");
        return h;
    }

    // ---- the sheet that says an update is ready ----

    /** "Hub X is ready" over the chats, once per version (Quiet.prompt; Later or the X keeps
     *  it away until a newer one): Update installs it now, in front, through Settings (the same
     *  direct path as its row: no new check). Settings › App keeps the update for later. */
    static void prompt(Base a, long offered) {
        SharedPreferences p = Ui.prefs(a);
        if (!a.front || a.isFinishing() || busy || !Quiet.prompt(offered, Settings.myCode(a), p.getLong("prompt_code", 0))) return;
        // App code goes in by itself, also while Harbor is open (Swap): nothing to ask.
        if (code(a) && silent(a, offered)) return;
        p.edit().putLong("prompt_code", offered).apply();
        Sheet s = new Sheet(a, "Update available");
        // Installed → new; a second line only when it says something useful (the rig's phone can't
        // allow installs, so it shows the silent phones' line).
        String hint = !failure(a, offered).isEmpty() ? "It didn't install by itself."
                : !code(a) && blocked(a) ? "Google Play Protect may ask to scan it first."
                : silent(a, offered) || Rig.on() ? "Or it installs by itself once you leave Hub."
                : "";
        LinearLayout c = s.card();
        LinearLayout row = Ui.cardRow(a, Ui.I_DOWNLOAD, "Hub",
                Settings.myName(a) + " → " + Settings.name(offered) + (hint.isEmpty() ? "" : "\n" + hint), Ui.FG, null);
        Ui.wrapSub(row, 3);
        c.addView(row, Ui.fill());
        LinearLayout btns = Ui.row(a);
        LinearLayout.LayoutParams half = new LinearLayout.LayoutParams(0, -2, 1);
        btns.addView(Ui.button(a, "Later", false, v -> s.dismiss()), half);
        btns.addView(new View(a), new LinearLayout.LayoutParams(Ui.dp(10), 1));
        btns.addView(Ui.button(a, "Update", true, v -> {
            s.dismiss();
            a.startActivity(new Intent(a, Settings.class).putExtra("hub", a.hub.id).putExtra("install", offered));
        }), new LinearLayout.LayoutParams(0, -2, 1));
        s.body.addView(btns, Ui.margins(Ui.fill(), 2, 0, 2, 6));
        s.show();
    }

    // ---- updating automatically ----

    /** Nobody sees Harbor now (Quiet.now): installing ends its process. */
    static boolean quiet(Context c) {
        PowerManager pm = c.getSystemService(PowerManager.class);
        KeyguardManager km = c.getSystemService(KeyguardManager.class);
        long left = Base.leftAt;
        long away = left == 0 ? Long.MAX_VALUE : SystemClock.elapsedRealtime() - left;
        return Quiet.now(seen(c), pm == null || pm.isInteractive(), km != null && km.isKeyguardLocked(), away);
    }

    /** A Harbor screen is on screen: one of this process's (Base.started), the user is in another
     *  app Harbor asked for an answer (a photo, a file: Base.outFor, given 10 minutes), or another
     *  of the app's processes is in front. */
    static boolean seen(Context c) {
        if (Base.started > 0) return true;
        long out = Base.outFor;
        if (out != 0 && SystemClock.elapsedRealtime() - out < 10 * 60_000) return true;
        try {
            ActivityManager am = c.getSystemService(ActivityManager.class);
            java.util.List<ActivityManager.RunningAppProcessInfo> ps = am == null ? null : am.getRunningAppProcesses();
            if (ps != null) for (ActivityManager.RunningAppProcessInfo p : ps) {
                if (p.pid == android.os.Process.myPid() || p.processName == null || !p.processName.startsWith(c.getPackageName())) continue;
                if (p.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
                        || p.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE) return true;
            }
        } catch (Exception ignored) { }
        return false;
    }

    /** Nothing stops the automatic install (the sidebar's "Update available" then
     *  stays away): Android lets Harbor install, the verifier hasn't refused one, and the
     *  version on offer didn't fail. */
    static boolean silent(Context c, long offered) {
        if (code(c)) return Ui.prefs(c).getLong("auto_fail_code", 0) != offered;
        if (!c.getPackageManager().canRequestPackageInstalls() || blocked(c)) return false;
        return Ui.prefs(c).getLong("auto_fail_code", 0) != offered;
    }

    /** The phone's verifier (Google Play Protect) refused a background install: it wants the
     *  user there to scan each new version, so they're offered in a notification instead, until
     *  the user asks to try the background again (Settings). */
    static boolean blocked(Context c) { return Ui.prefs(c).getBoolean("auto_blocked", false); }

    static void unblock(Context c) { Ui.prefs(c).edit().remove("auto_blocked").apply(); }

    private static final AtomicBoolean rounding = new AtomicBoolean();
    private static volatile boolean again;

    /** The automatic update, from Listen's news thread, Alive's job and Harbor leaving the screen:
     *  a newer app on offer (GitHub's latest release, looked at every GAP) is downloaded and
     *  checked at once (fetch), then installed when nobody sees Harbor, or offered in a
     *  notification when the background can't (Quiet.plan). Blocking; a call while one runs makes
     *  that one go round again. Android ends the process when it replaces the app; the next start
     *  opens where the user was. */
    static void round(Context c) {
        if (Rig.on() || OFF) return; // the rig's offer is made up, and its APK is signed with another key
        if (!rounding.compareAndSet(false, true)) { again = true; return; }
        try {
            do { again = false; roundOnce(c); } while (again);
        } finally {
            rounding.set(false);
        }
    }

    private static void roundOnce(Context c) {
        long best = 0;
        try {
            if (busy) return;
            if (codeRound(c)) return;
            if (!c.getPackageManager().canRequestPackageInstalls()) return;
            SharedPreferences p = Ui.prefs(c);
            boolean blocked = blocked(c);
            try { best = check(c, false); } catch (IOException e) { return; } // GitHub away: the next round
            long mine = Settings.myCode(c);
            if (best <= mine) { drop(c, null); return; }
            int plan = Quiet.plan(best, mine, p.getLong("auto_fail_code", 0), blocked, p.getLong("offered_code", 0));
            if (plan == Quiet.NONE) return;
            // Downloaded and checked now, not when it installs: the install is then a copy and a
            // commit, and the notification's tap installs at once.
            File apk;
            try {
                apk = fetch(c, null);
            } catch (Bad e) {
                throw e;
            } catch (IOException e) {
                Log.i(TAG, "download: " + why(e));
                if (plan == Quiet.OFFER && !seen(c)) offer(c, best); // a tap downloads it in front
                return; // the network: the next round
            }
            // A notification only needs Harbor out of sight (in front, the sidebar and Settings say it).
            if (plan == Quiet.OFFER) {
                if (!seen(c)) offer(c, best);
                return;
            }
            if (!quiet(c)) return; // installs when Harbor leaves the screen (left) or the next round
            commit(c, apk, true);
        } catch (Away a) {
            // the next quiet moment
        } catch (Exception e) {
            // The app downloaded isn't the release's, or Android couldn't take it: offered instead.
            failed(c, best > 0 ? best : bestCode, why(e));
        }
    }

    /** The latest release's update is its app code (Quiet.CODE): downloaded and staged now, run
     *  from a restart once nobody sees Harbor (Quiet.restart). False: it's not, the APK's round
     *  goes on. Blocking. */
    private static boolean codeRound(Context c) {
        long best;
        try { best = check(c, false); } catch (IOException e) { return true; } // GitHub away: the next round
        if (bestKind != Quiet.CODE || best <= Settings.myCode(c)) return false;
        if (Ui.prefs(c).getLong("auto_fail_code", 0) == best) return true; // didn't check out: the next release
        try {
            if (Shell.staged(c) != best) stage(c, null);
        } catch (Bad e) {
            Log.i(TAG, "code " + best + ": " + e.getMessage());
            failed(c, best, why(e));
            return true;
        } catch (IOException e) {
            Log.i(TAG, "download: " + why(e));
            return true; // the network: the next round
        }
        long waited = System.currentTimeMillis() - Shell.stagedAt(c);
        if (Quiet.restart(quiet(c), Listen.listening(), canRelisten(c), waited)) restartFor(c, false);
        // On screen: a live restart at the next quiet moment there (Swap), back on the same screen.
        else Swap.staged(c);
        return true;
    }

    /** The update on offer is app code, not an APK. */
    static boolean code(Context c) {
        known(c);
        return bestKind == Quiet.CODE;
    }

    /** Android lets Listen start again from the background after a restart: before 12, or with
     *  Harbor exempt from battery optimisation. */
    private static boolean canRelisten(Context c) {
        if (Build.VERSION.SDK_INT < 31) return true;
        PowerManager pm = c.getSystemService(PowerManager.class);
        return pm != null && pm.isIgnoringBatteryOptimizations(c.getPackageName());
    }

    /** Blocking: the app code on offer, downloaded from its GitHub release and handed to the shell,
     *  which checks it against Harbor's release key and keeps it for the next start (Shell.stage):
     *  at once when it already is. Throws Bad when it isn't the release key's, or can't run here. */
    static void stage(Context c, Progress progress) throws IOException {
        synchronized (fetching) {
            long to = known(c);
            String release = bestRelease;
            if (bestKind != Quiet.CODE || to <= Settings.myCode(c) || release == null) throw new IOException("no newer version is known");
            if (Shell.staged(c) == to) {
                if (progress != null) progress.at(1, 1);
                return;
            }
            File d = dir(c), part = new File(d, "code-" + to + ".part");
            drop(c, null);
            if (!d.isDirectory() && !d.mkdirs()) throw new IOException("can't make " + d);
            long t0 = SystemClock.elapsedRealtime();
            byte[] sigBytes = get(c, PHONE + CODE + ".minisig", 4096);
            if (sigBytes == null) throw new IOException("the PC has no signature for the app code");
            Net.Http http = pcGet(c, PHONE + CODE, 120_000);
            try {
                int code = http.code();
                if (code != 200) throw new IOException("the PC has no app code to send (HTTP " + code + ")");
                long size = http.length();
                if (size <= 0) throw new IOException("the PC sent no size for the app code");
                try (InputStream in = http.in(); FileOutputStream out = new FileOutputStream(part)) {
                    byte[] buf = new byte[1 << 16];
                    long done = 0;
                    while (done < size) {
                        int n = in.read(buf, 0, (int) Math.min(buf.length, size - done));
                        if (n < 0) throw new IOException("the download stopped early");
                        out.write(buf, 0, n);
                        done += n;
                        if (progress != null) progress.at(done, size);
                    }
                    out.getFD().sync();
                }
                // The shell checks it (Harbor's release key, this release, this shell) and keeps it.
                try {
                    Shell.stage(c, part, new String(sigBytes, StandardCharsets.UTF_8), release);
                } catch (GeneralSecurityException e) {
                    throw new Bad("the downloaded app code isn't Hub's (" + e.getMessage() + ")");
                } catch (Boot.Unusable e) {
                    throw new Bad(e.getMessage());
                }
                Log.i(TAG, "app code " + to + " downloaded and staged (" + size + " bytes, " + (SystemClock.elapsedRealtime() - t0) + " ms)");
            } finally {
                http.close();
                part.delete();
            }
        }
    }

    /** Ends the process for the staged code: the next start opens the chat the user had (resume).
     *  reopen: from a screen (Settings' Update), Harbor opens again at once, on the same screens
     *  (Swap). */
    private static void restartFor(Context c, boolean reopen) {
        // From a screen: a live restart, back on that screen (Swap).
        if (reopen && Swap.now(c)) return;
        Ui.prefs(c).edit().putLong("resume_code", Settings.myCode(c)).putLong("update_to", Shell.staged(c)).commit();
        Shell.restart(c, reopen);
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

    /** Harbor came back on screen while the background's download ran: not now. */
    static final class Away extends IOException {
        Away() { super("Hub is on screen"); }
    }

    /** The download isn't what Harbor's release key signed (not a network failure). */
    static final class Bad extends IOException {
        Bad(String m) { super(m); }
    }

    /** Where downloaded updates wait (the app's own storage: nothing else can write there). */
    private static File dir(Context c) { return new File(c.getNoBackupFilesDir(), "update"); }

    /** Deletes downloaded updates other than `keep`. */
    static void drop(Context c, File keep) {
        File[] fs = dir(c).listFiles();
        if (fs != null) for (File f : fs) if (keep == null || !f.equals(keep)) f.delete();
    }

    /** The versionCode a downloaded update holds ("harbor-7001.apk"). */
    private static long codeOf(File apk) {
        String n = apk.getName();
        try { return Long.parseLong(n.substring(7, n.length() - 4)); } catch (Exception e) { return 0; }
    }

    /** Blocking: the newest app on offer, downloaded from its GitHub release into the app's
     *  storage and checked against Harbor's release key (BLAKE2b while it streams, minisign
     *  before it's kept); at once when it already is. Throws Bad when the download isn't the
     *  release key's. */
    static File fetch(Context c, Progress progress) throws IOException {
        synchronized (fetching) {
            long to = known(c);
            String release = bestRelease;
            if (bestKind != Quiet.APK || to <= Settings.myCode(c) || release == null) throw new IOException("no newer version is known");
            File d = dir(c), apk = new File(d, "harbor-" + to + ".apk"), part = new File(d, "harbor-" + to + ".part");
            SharedPreferences p = Ui.prefs(c);
            if (apk.isFile() && apk.length() == p.getLong("apk_size", -1) && (to + "@" + release).equals(p.getString("apk_ready", ""))) {
                if (progress != null) progress.at(apk.length(), apk.length());
                return apk;
            }
            drop(c, null);
            if (!d.isDirectory() && !d.mkdirs()) throw new IOException("can't make " + d);
            long t0 = SystemClock.elapsedRealtime();
            byte[] sigBytes = get(c, PHONE + APK + ".minisig", 4096);
            if (sigBytes == null) throw new IOException("the PC has no signature for the app");
            Minisign.Sig sig;
            try {
                sig = Minisign.parse(new String(sigBytes, StandardCharsets.UTF_8));
                Minisign.signedFor(sig, release, APK);
            } catch (GeneralSecurityException e) {
                throw new Bad("the app's signature: " + e.getMessage());
            }
            Net.Http http = pcGet(c, PHONE + APK, 300_000);
            try {
                int code = http.code();
                if (code != 200) throw new IOException("the PC has no app to send (HTTP " + code + ")");
                long size = http.length();
                if (size <= 0) throw new IOException("the PC sent no size for the app");
                Minisign.Blake2b hash = new Minisign.Blake2b();
                try (InputStream in = http.in(); FileOutputStream out = new FileOutputStream(part)) {
                    byte[] buf = new byte[1 << 16];
                    long done = 0;
                    while (done < size) {
                        int n = in.read(buf, 0, (int) Math.min(buf.length, size - done));
                        if (n < 0) throw new IOException("the download stopped early");
                        out.write(buf, 0, n);
                        hash.update(buf, 0, n);
                        done += n;
                        if (progress != null) progress.at(done, size);
                    }
                    out.getFD().sync();
                }
                // Nothing is kept (or goes to Android) that Harbor's release key didn't sign.
                try {
                    Minisign.verify(Minisign.HUB_PUBKEY, hash.digest(), sig);
                } catch (GeneralSecurityException e) {
                    throw new Bad("the downloaded app isn't Hub's (" + e.getMessage() + ")");
                }
                if (!part.renameTo(apk)) throw new IOException("can't keep the download");
                p.edit().putString("apk_ready", to + "@" + release).putLong("apk_size", size).apply();
                Log.i(TAG, "app " + to + " downloaded and checked (" + size + " bytes, " + (SystemClock.elapsedRealtime() - t0) + " ms)");
                return apk;
            } finally {
                http.close();
                part.delete();
            }
        }
    }

    /** Blocking: the latest release's app, downloaded and checked (fetch: at once when the
     *  background already did), into a session and committed. Run off the UI thread. auto: the
     *  background's, which gives up quietly if Harbor came back on screen meanwhile. */
    static void install(Context c, Progress progress, boolean auto) throws Exception {
        if (busy) throw new IOException("already updating");
        if (code(c)) {
            stage(c, progress);
            restartFor(c, !auto);
            return;
        }
        commit(c, fetch(c, progress), auto);
    }

    /** Hands a downloaded, checked app to Android: a copy into a session (about a second), and
     *  the commit. */
    private static void commit(Context c, File apk, boolean auto) throws Exception {
        if (busy) throw new IOException("already updating");
        long to = codeOf(apk), t0 = SystemClock.elapsedRealtime();
        PackageInstaller pi = c.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams sp = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        sp.setAppPackageName(c.getPackageName());
        if (Build.VERSION.SDK_INT >= 31) sp.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
        int id = pi.createSession(sp);
        try (PackageInstaller.Session s = pi.openSession(id)) {
            try (InputStream in = new FileInputStream(apk); OutputStream out = s.openWrite("app.apk", 0, apk.length())) {
                byte[] buf = new byte[1 << 16];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                s.fsync(out);
            }
            // Someone may have come back meanwhile. Next time, then.
            if (auto && !quiet(c)) throw new Away();
            busy = true;
            // The next start opens the chat the user had (if the version changes by then).
            Ui.prefs(c).edit().putLong("resume_code", Settings.myCode(c)).putLong("update_to", to).apply();
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            // The result says whether it was the background's, and what to offer if it fails.
            Intent status = new Intent(c, Update.class).setAction("status").putExtra("auto", auto).putExtra("to", to);
            Log.i(TAG, "installing app " + to + (auto ? " by itself" : "") + " (copied in " + (SystemClock.elapsedRealtime() - t0) + " ms)");
            s.commit(PendingIntent.getBroadcast(c, id, status, flags).getIntentSender());
        } catch (Exception e) {
            busy = false;
            pi.abandonSession(id);
            throw e;
        }
    }

    @Override
    public void onReceive(Context c, Intent i) {
        if (Ui.app == null) Ui.app = c.getApplicationContext();
        if (Intent.ACTION_MY_PACKAGE_REPLACED.equals(i.getAction())) {
            // The new version: Android stopped the old one's jobs and service with it.
            // A Play Protect refusal is forgotten too: the next version tries the background once
            // more (another refusal blocks it again, and offers it in a notification).
            Ui.prefs(c).edit().remove("auto_fail_code").remove("auto_fail_at").remove("auto_fail_why").remove("auto_blocked").apply();
            try { c.getSystemService(NotificationManager.class).cancel("update", 1); } catch (Exception ignored) { }
            drop(c, null); // the download it came from
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
                offer(c, to);
            } else if (front) {
                Toast.makeText(c, "Hub couldn't update: " + why, Toast.LENGTH_LONG).show();
            }
        }
    }

    /** "Hub X is ready: tap to install": once per version. The tap opens Settings, which
     *  installs it in front (Settings.update), where Play Protect can ask to scan it. */
    static void offer(Context c, long code) {
        SharedPreferences p = Ui.prefs(c);
        if (code <= 0 || p.getLong("offered_code", 0) == code) return;
        // Settings opens on a workspace; the update itself has nothing to do with it.
        Hub h = Hub.get(c, Hub.last(c));
        if (h == null && !Hub.all(c).isEmpty()) h = Hub.all(c).get(0);
        if (h == null) return;
        try {
            NotificationManager nm = c.getSystemService(NotificationManager.class);
            nm.createNotificationChannel(new NotificationChannel("update", "App updates", NotificationManager.IMPORTANCE_LOW));
            // Harbor's start screen under it, so Back from Settings lands in the app.
            Intent home = new Intent(c, Hubs.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
            Intent install = new Intent(c, Settings.class).putExtra("hub", h.id).putExtra("install", code);
            PendingIntent pi = PendingIntent.getActivities(c, 12, new Intent[] { home, install }, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            Notification n = new Notification.Builder(c, "update").setSmallIcon(Ui.statIcon(c))
                    .setContentTitle("Hub " + Settings.name(code) + " is ready")
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
            Notification n = new Notification.Builder(c, "update").setSmallIcon(Ui.statIcon(c))
                    .setContentTitle("Hub" + v + " is ready")
                    .setContentText("Android asks you to confirm the update: tap to install it.")
                    .setContentIntent(pi).setAutoCancel(true).build();
            nm.notify("update", 1, n);
            if (to > 0) Ui.prefs(c).edit().putLong("offered_code", to).apply(); // offered: no second notification
        } catch (Exception ignored) { } // notifications off: Settings › Update still shows it
    }
}
