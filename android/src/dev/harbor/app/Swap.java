package dev.harbor.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Process;
import android.os.SystemClock;
import android.util.Log;
import android.view.MotionEvent;
import android.view.View;
import android.widget.EditText;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import dev.harbor.shell.Restart;
import dev.harbor.shell.Shell;

/** Live updates while Harbor is on screen (android/README.md, "Live updates"): once the shell has
 *  new app code staged (Update.codeRound, from the release news within seconds of a release) and
 *  a Harbor screen is in front, this waits for a moment that loses nothing ({@link Live#why}: no
 *  sheet open, no recording, video, send or other app's answer under way, nobody touching it, a
 *  couple of seconds idle or a screen that just came up), writes down the task's screens and
 *  their places ({@link Live.Saved}: the open chat, its scroll position, the composer's text and
 *  cursor, an open side panel), and has the shell's Restart end this process and open Harbor
 *  again; the first screen of the new process ({@link #restore}, from Hubs) opens the same
 *  screens straight away, with no animation, and says "Updated to X". The new code is on trial
 *  as after any start (Shell): if it crashes, the shell rolls back and the next start comes back
 *  to the same place on the old code (the state is kept until a screen stayed up).
 *
 *  Only the app's code: it uses the shell's Restart and Shell API as shell 1 has them. */
final class Swap {
    private Swap() { }

    static final String TAG = "harbor-update";
    /** The state a live restart left (Ui.prefs). */
    static final String KEY = "live_state";
    /** The same state, written a moment after each change and when a screen leaves the front (saveNow): a crash, the
     *  system ending the process, or an APK install comes back to the same screens on the next start (restore), as a
     *  live restart does. Gone when the user backs out of the app (left). */
    static final String AUTO = "live_auto";
    /** How long after the last change the state is written. */
    static final long SAVE_MS = 800;
    /** Restores the process came back with (from the state it restored): its own saves keep the count, so new code
     *  that crashes on a screen it restores stops coming back to it after Live.MAX_TRIES. */
    private static int restoredTries;
    /** No saves before this (elapsedRealtime): a process that crashes at once doesn't overwrite what it restored. */
    private static long savesFrom = SystemClock.elapsedRealtime() + 3_000;
    private static String lastAuto;
    private static boolean startLooked;
    private static long lastAutoAt;
    private static final long HEARTBEAT_MS = 60_000;
    private static final Runnable autosave = () -> { Base a = Base.top; if (a != null) saveNow(a); };

    /** The staged code waiting for a moment (0 none), since when (elapsedRealtime). */
    private static volatile long target, armedAt;
    private static volatile long lastInput = SystemClock.elapsedRealtime();
    private static volatile boolean fingerDown, swapping;
    private static int lastField;
    private static String lastWhy;
    private static final Runnable tick = Swap::tick;

    // ---- input (Base) ----

    static void touch(MotionEvent e) {
        lastInput = SystemClock.elapsedRealtime();
        int a = e.getActionMasked();
        if (a == MotionEvent.ACTION_DOWN || a == MotionEvent.ACTION_POINTER_DOWN) fingerDown = true;
        else if (a == MotionEvent.ACTION_UP || a == MotionEvent.ACTION_CANCEL) { fingerDown = false; dirty(); }
    }

    // ---- kept all the time (a crash, an APK install) ----

    /** Something on screen changed (a tap, a key, text typed): the state is written SAVE_MS after the last one. */
    static void dirty() {
        if (swapping) return;
        Ui.main.removeCallbacks(autosave);
        Ui.main.postDelayed(autosave, SAVE_MS);
    }

    /** The task's screens as they stand, bottom to top (the order they last came to the front). */
    private static Live.Saved build(long from, long to, StringBuilder names) {
        Live.Saved s = new Live.Saved();
        s.from = from;
        s.to = to;
        s.at = System.currentTimeMillis();
        // Restored screens Android hasn't made yet are under every screen made since.
        s.screens.addAll(pending.values());
        if (names != null) for (Live.Screen sc : pending.values()) names.append(names.length() == 0 ? "" : " > ").append(sc.cls);
        List<Base> task = new ArrayList<>(Base.alive);
        java.util.Collections.sort(task, (x, y) -> Long.compare(x.frontSeq, y.frontSeq));
        for (Base b : task) {
            if (b.isFinishing()) continue;
            Live.Screen sc;
            try { sc = b.liveScreen(); } catch (RuntimeException e) { Log.w(TAG, "live: " + b.getClass().getSimpleName() + " not kept: " + e); sc = null; }
            if (sc == null || "Hubs".equals(sc.cls)) continue;
            s.screens.add(sc);
            if (names != null) names.append(names.length() == 0 ? "" : " > ").append(sc.cls);
        }
        return s;
    }

    /** Writes the state now (a screen leaves the front, an install is about to end the process). */
    static void saveNow(Context c) { save(c, false); }

    /** Writes the state and waits until it's on disk (any thread; at most a second): the process is about to end (an
     *  APK install, a restart by the shell). */
    static void saveBlocking(Context c) {
        if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) { save(c, true); return; }
        java.util.concurrent.CountDownLatch done = new java.util.concurrent.CountDownLatch(1);
        Ui.main.post(() -> { try { save(c, true); } finally { done.countDown(); } });
        try { done.await(1, java.util.concurrent.TimeUnit.SECONDS); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
    }

    private static void save(Context c, boolean commit) {
        Ui.main.removeCallbacks(autosave);
        if (swapping) return;
        long now = SystemClock.elapsedRealtime();
        if (now < savesFrom) { dirty(); return; }
        Live.Saved s = build(Shell.code(), Shell.code(), null);
        if (s.screens.isEmpty()) {
            // No screens in this process (Android closed them in the background): what was written stays.
            if (Base.alive.isEmpty()) return;
            // Nothing that comes back (Hub's start screen, a form): the next start is an ordinary one.
            if (!"".equals(lastAuto)) { lastAuto = ""; put(c, null, commit); }
            return;
        }
        s.tries = restoredTries;
        String text = Live.encode(s);
        // The same screens and places as the last write: only its time is renewed, once a minute (a later start
        // takes a state up to Live.FRESH_MS old).
        String same = text.replaceAll("(?m)^at=.*\\n", "");
        if (commit || !same.equals(lastAuto) || now - lastAutoAt > HEARTBEAT_MS - 5_000) {
            lastAuto = same;
            lastAutoAt = now;
            put(c, text, commit);
        }
        // While a screen is in front its time keeps being renewed.
        if (Base.top != null) Ui.main.postDelayed(autosave, HEARTBEAT_MS);
    }

    private static void put(Context c, String text, boolean commit) {
        SharedPreferences.Editor e = Ui.prefs(c).edit();
        if (text == null) e.remove(AUTO); else e.putString(AUTO, text);
        if (commit) e.commit(); else e.apply();
    }

    /** The user backed out of the app: the next start is an ordinary one. */
    static void left(Context c) {
        Ui.main.removeCallbacks(autosave);
        lastAuto = null;
        Ui.prefs(c).edit().remove(AUTO).apply();
    }

    static void input() { lastInput = SystemClock.elapsedRealtime(); }

    // ---- staged code ----

    /** The shell staged new code (Update, any thread): restart into it at the next good moment
     *  a screen is in front. */
    static void staged(Context c) {
        if (!Shell.loads()) return;
        long code = Shell.staged(c);
        Ui.main.post(() -> arm(code));
    }

    /** A screen came to the front (Base.onResume): a staged code waiting is looked for (once per
     *  process: in this process it's always armed by staged()), and a screen that just came up is
     *  a good moment. */
    private static volatile boolean looked;

    static void resumed(Base a) {
        if (!Shell.loads() || swapping) return;
        if (target > Shell.code()) { schedule(400); return; }
        if (looked) return;
        looked = true;
        Context c = a.getApplicationContext();
        Ui.pool.execute(() -> {
            long code = Shell.staged(c);
            if (code > Shell.code()) Ui.main.post(() -> arm(code));
        });
    }

    private static void arm(long code) {
        if (code <= Shell.code() || swapping) return;
        if (target != code) {
            target = code;
            armedAt = SystemClock.elapsedRealtime();
            lastWhy = null;
            Log.i(TAG, "live: code " + Settings.name(code) + " is staged; restarting into it at the next quiet moment on screen");
        }
        schedule(400);
    }

    private static void schedule(long ms) {
        Ui.main.removeCallbacks(tick);
        Ui.main.postDelayed(tick, ms);
    }

    /** Once a second while a screen is in front and code waits. */
    private static void tick() {
        if (swapping || target <= Shell.code()) return;
        Base a = Base.top;
        if (a == null) return; // Base.onResume starts it again
        Live.Moment m = moment(a);
        String why = Live.why(m);
        if (why == null) {
            go(a, m.shownMs < Live.NAV_MS ? "a screen just came up" : m.composing ? "a pause in the message" : "idle");
            return;
        }
        if (!why.equals(lastWhy)) {
            lastWhy = why;
            Log.i(TAG, "live: not yet (" + why + ")");
        }
        schedule(1_000);
    }

    private static Live.Moment moment(Base a) {
        long now = SystemClock.elapsedRealtime();
        Live.Moment m = new Live.Moment();
        m.front = a.front && !a.isFinishing();
        m.focused = a.hasWindowFocus();
        m.restorable = Live.keep(a.getClass().getSimpleName()) != null;
        m.recording = Voice.anyActive();
        m.playing = Video.anyPlaying();
        m.writing = Hub.writes.get() > 0;
        m.outForAnswer = Base.outFor != 0;
        m.fingerDown = fingerDown;
        View f = a.getCurrentFocus();
        if (f instanceof EditText) {
            CharSequence t = ((EditText) f).getText();
            int h = System.identityHashCode(f) * 31 + (t == null ? 0 : t.toString().hashCode());
            if (h != lastField) { lastField = h; lastInput = now; } // typed on the keyboard since the last tick
            if (t != null && t.length() > 0) {
                if (f == a.liveField()) m.composing = true;
                else m.typingField = true;
            }
        }
        m.idleMs = now - lastInput;
        m.shownMs = now - a.resumedAt;
        m.armedMs = now - armedAt;
        return m;
    }

    /** Settings' Update (any thread): the staged code at once, back on the same screen. False
     *  when no Harbor screen is in front (the caller restarts the usual way). */
    static boolean now(Context c) {
        if (!Shell.loads() || Base.top == null) return false;
        long code = Shell.staged(c);
        if (code <= Shell.code()) return false;
        Ui.main.post(() -> {
            target = code;
            Base a = Base.top;
            if (a != null) go(a, "Update tapped");
            else Shell.restart(c, true);
        });
        return true;
    }

    /** Writes the task's screens down and has the shell's Restart (a process of its own) end this
     *  one and open Harbor again. This screen stays as it is until then: no finish, no animation,
     *  so the next thing on screen is Harbor's own background, then the same screen. */
    private static void go(Base a, String why) {
        if (swapping) return;
        swapping = true;
        Ui.main.removeCallbacks(autosave);
        StringBuilder names = new StringBuilder();
        Live.Saved s = build(Shell.code(), target, names);
        // commit, not apply: the process ends in a moment.
        Ui.prefs(a).edit().putString(KEY, Live.encode(s)).commit();
        Log.i(TAG, "live: restarting into code " + Settings.name(s.to) + " (" + why + "), keeping " + (names.length() == 0 ? "the first screen" : names));
        Context app = a.getApplicationContext();
        try {
            a.startActivity(new Intent(a, Restart.class)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION)
                    .putExtra("pid", Process.myPid()));
            a.overridePendingTransition(0, 0);
        } catch (RuntimeException e) {
            Log.w(TAG, "live: Restart didn't open: " + e);
            Shell.restart(app, true);
        }
        // Restart ends this process within a second or so; if it never does, the shell's own way.
        Ui.main.postDelayed(() -> Shell.restart(app, true), 6_000);
    }

    /** A test build's (Rig.on; phoneshot --broadcast dev.harbor.app.RIG_LIVE_RESTART) live restart into the same
     *  code, as an update's; RIG_CRASH stands in for a crash: the process ends with no live state written (only the
     *  state kept all along) and the app opens again, as after a crash or an APK install. */
    static void rig(Context c, boolean crash) {
        if (!Rig.on()) return;
        Ui.main.post(() -> {
            Base a = Base.top;
            if (a == null) { Log.w(TAG, "live: rig: no screen in front"); return; }
            if (!crash) {
                target = Shell.code();
                go(a, "rig");
                return;
            }
            savesFrom = 0;
            save(a, true);
            swapping = true;
            Log.i(TAG, "live: rig: ending the process as a crash would");
            a.startActivity(new Intent(a, Restart.class)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION)
                    .putExtra("pid", Process.myPid()));
        });
    }

    /** A restored screen's extra: which of `pending` it is. */
    static final String LIVE_ID = "liveid";
    /** Screens a restore opened that Android hasn't made yet (under the top one, until they show), bottom to top:
     *  they stay in what's written (build) and the Projects tab finds its screen among them (projectsPending). */
    private static final Map<String, Live.Screen> pending = new java.util.LinkedHashMap<>();

    /** A screen was made (Base.onCreate): a restored one is no longer pending. */
    static void created(Intent i) {
        String id = i == null ? null : i.getStringExtra(LIVE_ID);
        if (id != null) pending.remove(id);
    }

    /** The Projects screen (a chat or a GitHub list) a restore left under the others and Android hasn't made yet, as
     *  the intent that brings it to the front (Tabs.goProjects), or null. */
    static Intent projectsPending(Context c) {
        Live.Screen last = null;
        for (Live.Screen sc : pending.values()) if ("Chat".equals(sc.cls) || "GhList".equals(sc.cls)) last = sc;
        if (last == null) return null;
        try {
            Intent in = new Intent(c, Class.forName("dev.harbor.app." + last.cls));
            for (Map.Entry<String, Object> e : last.extras.entrySet()) if (e.getValue() instanceof String) in.putExtra(e.getKey(), (String) e.getValue());
            return in;
        } catch (ClassNotFoundException e) {
            return null;
        }
    }

    // ---- the next process ----

    /** The first screen of a process (Hubs.onCreate, a fresh start): when a live restart just
     *  ended the one before, opens its screens again on top, without animation. True: done (Hubs
     *  stays blank under them, or shows itself when it was the screen). */
    static boolean restore(Hubs h) {
        SharedPreferences p = Ui.prefs(h);
        String key = KEY;
        String text = p.getString(KEY, null);
        Live.Saved s = Live.decode(text);
        if (text != null && !Live.fresh(s, System.currentTimeMillis())) {
            p.edit().remove(KEY).apply();
            text = null;
        }
        if (text == null) {
            // No live restart: a crash, the system ending the process, or an APK install: the state kept all along.
            // Only as the first screen of a process: a Hubs opened later (the Projects tab with no PC yet) isn't a start.
            if (startLooked || Base.alive.size() > 1) return false;
            startLooked = true;
            key = AUTO;
            text = p.getString(AUTO, null);
            s = Live.decode(text);
            if (text == null) return false;
            if (!Live.fresh(s, System.currentTimeMillis()) || s.screens.isEmpty()) {
                p.edit().remove(AUTO).apply();
                return false;
            }
        }
        s.tries++;
        restoredTries = s.tries;
        p.edit().putString(key, Live.encode(s)).commit();
        // The older "back to the chat after an install" (Update.resume) is covered by this.
        p.edit().remove("resume_code").apply();
        // No opening animation from the shell's Restart (Android 14+; older ones take it from
        // the flags and overridePendingTransition below).
        if (android.os.Build.VERSION.SDK_INT >= 34) h.overrideActivityTransition(android.app.Activity.OVERRIDE_TRANSITION_OPEN, 0, 0);
        boolean updated = KEY.equals(key) && Shell.code() == s.to;
        Log.i(TAG, "live: back on " + s.screens.size() + " screen(s), code " + Shell.name()
                + (!KEY.equals(key) ? " (kept as it was: a crash, an install or the system ended the last process)" : updated ? "" : " (not " + Settings.name(s.to) + ": the shell kept or rolled back to this one)") + ", restore " + s.tries);
        List<Intent> is = new ArrayList<>();
        pending.clear();
        for (Live.Screen sc : s.screens) {
            Object hub = sc.extras.get("hub");
            if (hub instanceof String && Hub.get(h, (String) hub) == null) break; // that workspace is gone
            Class<?> cls;
            try { cls = Class.forName("dev.harbor.app." + sc.cls); } catch (ClassNotFoundException e) { break; }
            Intent in = new Intent(h, cls).addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION);
            for (Map.Entry<String, Object> e : sc.extras.entrySet()) {
                Object v = e.getValue();
                if (v instanceof String) in.putExtra(e.getKey(), (String) v);
                else if (v instanceof Long) in.putExtra(e.getKey(), (long) (Long) v);
                else if (v instanceof Integer) in.putExtra(e.getKey(), (int) (Integer) v);
                else if (v instanceof Boolean) in.putExtra(e.getKey(), (boolean) (Boolean) v);
            }
            for (Map.Entry<String, String> e : sc.state.entrySet()) in.putExtra("live." + e.getKey(), e.getValue());
            if (is.isEmpty() && hub instanceof String) Hub.setLast(h, (String) hub);
            // Android makes the screens under the top one only when they show: until then they're kept as written.
            String id = "r" + is.size();
            in.putExtra(LIVE_ID, id);
            pending.put(id, sc);
            is.add(in);
        }
        Context app = h.getApplicationContext();
        if (updated && s.tries == 1) Ui.main.postDelayed(() -> Toast.makeText(app, "Updated to " + Shell.name(), Toast.LENGTH_SHORT).show(), 700);
        // Kept until a screen stayed up: new code that crashes before that (and is rolled back)
        // comes back to the same place.
        Ui.main.postDelayed(() -> { if (Base.resumed > 0) Ui.prefs(app).edit().remove(KEY).apply(); }, 8_000);
        savesFrom = SystemClock.elapsedRealtime() + 8_000;
        // Up a minute on what it restored: its own state counts afresh (a crash later is a new one).
        Ui.main.postDelayed(() -> restoredTries = 0, 60_000);
        // It was on Hub's start screen (or its screens are gone): the start goes on as a cold one, straight to the
        // workspace (Hubs.openLast), never left on that page.
        if (is.isEmpty()) return false;
        h.restoring = true;
        h.startActivities(is.toArray(new Intent[0]));
        h.overridePendingTransition(0, 0);
        return true;
    }

    /** This screen opens as a live restart left it (its "live." extras, on a fresh create only). */
    static String state(Base a, android.os.Bundle saved, String key) {
        return saved != null ? null : a.getIntent().getStringExtra("live." + key);
    }
}
