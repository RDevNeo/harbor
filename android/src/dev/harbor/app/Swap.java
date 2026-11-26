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
        else if (a == MotionEvent.ACTION_UP || a == MotionEvent.ACTION_CANCEL) fingerDown = false;
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
        Live.Saved s = new Live.Saved();
        s.from = Shell.code();
        s.to = target;
        s.at = System.currentTimeMillis();
        StringBuilder names = new StringBuilder();
        for (Base b : new ArrayList<>(Base.alive)) {
            if (b.isFinishing()) continue;
            Live.Screen sc;
            try { sc = b.liveScreen(); } catch (RuntimeException e) { sc = null; }
            if (sc == null || "Hubs".equals(sc.cls)) continue;
            s.screens.add(sc);
            names.append(names.length() == 0 ? "" : " > ").append(sc.cls);
        }
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

    // ---- the next process ----

    /** The first screen of a process (Hubs.onCreate, a fresh start): when a live restart just
     *  ended the one before, opens its screens again on top, without animation. True: done (Hubs
     *  stays blank under them, or shows itself when it was the screen). */
    static boolean restore(Hubs h) {
        SharedPreferences p = Ui.prefs(h);
        String text = p.getString(KEY, null);
        if (text == null) return false;
        Live.Saved s = Live.decode(text);
        if (!Live.fresh(s, System.currentTimeMillis())) {
            p.edit().remove(KEY).apply();
            return false;
        }
        s.tries++;
        p.edit().putString(KEY, Live.encode(s)).commit();
        // No opening animation from the shell's Restart (Android 14+; older ones take it from
        // the flags and overridePendingTransition below).
        if (android.os.Build.VERSION.SDK_INT >= 34) h.overrideActivityTransition(android.app.Activity.OVERRIDE_TRANSITION_OPEN, 0, 0);
        boolean updated = Shell.code() == s.to;
        Log.i(TAG, "live: back on " + s.screens.size() + " screen(s), code " + Shell.name()
                + (updated ? "" : " (not " + Settings.name(s.to) + ": the shell kept or rolled back to this one)") + ", restore " + s.tries);
        List<Intent> is = new ArrayList<>();
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
            is.add(in);
        }
        Context app = h.getApplicationContext();
        if (updated && s.tries == 1) Ui.main.postDelayed(() -> Toast.makeText(app, "Updated to " + Shell.name(), Toast.LENGTH_SHORT).show(), 700);
        // Kept until a screen stayed up: new code that crashes before that (and is rolled back)
        // comes back to the same place.
        Ui.main.postDelayed(() -> { if (Base.resumed > 0) Ui.prefs(app).edit().remove(KEY).apply(); }, 8_000);
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
