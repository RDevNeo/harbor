package dev.harbor.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** The phone on a PC of another workspace while its own workspace's PCs are off (Fallback says
 *  which and when). The account's workspaces are each a Hub: every PC of every other one is
 *  asked for its state at once, and those that answer and let this account start chats are
 *  offered (the offline card's picker, Sidebar); Chats moves to the first by itself.
 *
 *  Moving there opens that workspace's chats with calls pinned to the PC that answered, and
 *  remembers where the phone came from: the chat list there says so, with the way back. The
 *  workspace opened last (Hub.last) stays the phone's own, so a cold start tries it first. */
final class Away {
    private Away() { }

    interface Found { void found(List<Fallback.Pc> offered); }

    /** A probe's answer is reused this long (a screen that keeps failing asks once). */
    private static final long FRESH_MS = 20_000;
    private static final Map<String, List<Fallback.Pc>> found = new HashMap<>();
    private static final Map<String, Long> foundAt = new HashMap<>();
    /** Per workspace being asked about: the screens waiting for the answer. */
    private static final Map<String, List<Found>> asking = new HashMap<>();

    private static SharedPreferences prefs(Context c) { return c.getSharedPreferences("away", Context.MODE_PRIVATE); }

    /** The workspace (hub id) the phone came from to this one, "" when it wasn't moved here. */
    static String from(Context c, String hub) { return prefs(c).getString("from-" + hub, ""); }

    /** The PC used instead last time ("hub/pid"), tried first next time. */
    private static String last(Context c) { return prefs(c).getString("last", ""); }

    /** When the user last chose to stay on workspace `hub` (0: never): no moving by itself for a while. */
    static long stayedAt(Context c, String hub) { return prefs(c).getLong("stay-" + hub, 0); }

    static void stay(Context c, String hub) { prefs(c).edit().putLong("stay-" + hub, System.currentTimeMillis()).apply(); }

    /** The account has another workspace with PCs to look at besides `down` (and the one the phone
     *  came from): without one there's nothing to offer, and the offline card stays as it was. */
    static boolean others(Context c, Hub down) {
        String home = from(c, down.id);
        for (Hub h : Hub.all(c)) if (!h.id.equals(down.id) && !h.id.equals(home)) return true;
        return false;
    }

    /** The PCs of the account's other workspaces that answer and let it start chats, best first,
     *  on the UI thread. `down` is the workspace whose PCs are off, `home` the one the phone came
     *  from (when `down` is itself a stand-in); neither is asked. */
    static void find(Context c, Hub down, Found done) {
        Context app = c.getApplicationContext();
        String key = down.id;
        long now = System.currentTimeMillis();
        synchronized (found) {
            Long at = foundAt.get(key);
            if (at != null && now - at < FRESH_MS && found.get(key) != null) {
                List<Fallback.Pc> had = found.get(key);
                Ui.main.post(() -> done.found(had));
                return;
            }
            List<Found> w = asking.get(key);
            if (w != null) { w.add(done); return; }
            w = new ArrayList<>();
            w.add(done);
            asking.put(key, w);
        }
        String home = from(app, down.id);
        Ui.pool.execute(() -> {
            List<Fallback.Pc> all = new ArrayList<>();
            List<Hub> hubs = Hub.all(app);
            List<Runnable> probes = new ArrayList<>();
            for (int i = 0; i < hubs.size(); i++) {
                Hub h = hubs.get(i);
                if (h.id.equals(down.id) || h.id.equals(home)) continue;
                List<String> eps = h.endpoints();
                for (int k = 0; k < eps.size(); k++) {
                    String v = eps.get(k);
                    // The first PC is "": not again under its mesh id.
                    if (!v.isEmpty() && v.equals(h.pid)) continue;
                    Fallback.Pc p = new Fallback.Pc(h.id, h.label(), v, h.labelOn(v), i * 100 + k);
                    all.add(p);
                    probes.add(() -> probe(h, p));
                }
            }
            CountDownLatch left = new CountDownLatch(probes.size());
            for (Runnable r : probes) Ui.pool.execute(() -> { try { r.run(); } finally { left.countDown(); } });
            try { left.await(20, TimeUnit.SECONDS); } catch (InterruptedException ignored) { }
            List<Fallback.Pc> offered = Fallback.offered(all, last(app));
            List<Found> waiting;
            synchronized (found) {
                found.put(key, offered);
                foundAt.put(key, System.currentTimeMillis());
                waiting = asking.remove(key);
            }
            if (waiting != null) for (Found f : waiting) Ui.main.post(() -> f.found(offered));
        });
    }

    /** Asks PC p of hub h for its state: whether it answers, and lets this account start chats. */
    private static void probe(Hub h, Fallback.Pc p) {
        try {
            JSONObject st = h.stateOn(p.pid);
            JSONObject g = st.optJSONObject("guest");
            boolean start = Fallback.mayStart(g == null || !g.has("start") ? null : g.optBoolean("start", true));
            // (Read after the latch: its countDown publishes these.)
            p.start = start;
            p.why = g == null || g.isNull("why") ? "" : g.optString("why", "");
            p.level = g == null ? "" : g.optString("level", "");
            p.answered = true;
            // That PC's state, so its chat list shows at once when the phone moves there.
            Hub.states.put(h.id, st);
        } catch (Exception e) {
            p.answered = false;
        }
    }

    /** Moves to PC p (its workspace's chat list, calls pinned to it) from screen `a`, on workspace
     *  `off` whose PCs are off. `auto`: by itself (a toast says so). */
    static void use(Activity a, Hub off, Fallback.Pc p, boolean auto) {
        Context app = a.getApplicationContext();
        Hub to = Hub.get(app, p.hub);
        if (to == null) return;
        // Stood in for another workspace already: the way back stays the first one.
        String home = from(app, off.id);
        if (home.isEmpty()) home = off.id;
        prefs(app).edit().putString("from-" + to.id, home).putString("off-" + to.id, off.labelOn(off.via()))
                .putString("last", p.key()).putString("level-" + to.id, p.level).remove("from-" + off.id).apply();
        to.use(p.pid);
        if (auto) Ui.toast(a, Fallback.moved(off.labelOn(off.via()), p));
        a.startActivity(new Intent(a, Chats.class).putExtra("hub", to.id).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP));
        if (a instanceof Chats) a.finish();
    }

    /** The name of the PC that was off when the phone moved to `hub` ("" when it wasn't moved). */
    static String offName(Context c, String hub) { return prefs(c).getString("off-" + hub, ""); }

    /** The level this PC's owner gave this account, as it said when the phone moved there. */
    static String level(Context c, String hub) { return prefs(c).getString("level-" + hub, ""); }

    /** Back to the workspace the phone came from (its chat list): it stays there a while even
     *  while its PCs are still off (the user chose it). */
    static void back(Activity a, String hub) {
        Context app = a.getApplicationContext();
        String home = from(app, hub);
        forget(app, hub);
        if (home.isEmpty() || Hub.get(app, home) == null) return;
        stay(app, home);
        a.startActivity(new Intent(a, Chats.class).putExtra("hub", home).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP));
        if (a instanceof Chats) a.finish();
    }

    /** No longer a stand-in: the banner goes. */
    static void forget(Context c, String hub) {
        prefs(c).edit().remove("from-" + hub).remove("off-" + hub).remove("level-" + hub).apply();
    }

    // ---- is the workspace the phone came from back? ----

    private static final Map<String, Long> homeAskedAt = new HashMap<>();
    private static final Map<String, Boolean> homeBack = new HashMap<>();

    /** Whether the workspace the phone came from answered lately (asked at most every 60 s, in
     *  the background; `changed` runs on the UI thread when that answer changes). */
    static boolean homeBack(Context c, String hub, Runnable changed) {
        String home = from(c, hub);
        if (home.isEmpty()) return false;
        Hub h = Hub.get(c, home);
        if (h == null) return false;
        long now = System.currentTimeMillis();
        boolean ask;
        synchronized (homeAskedAt) {
            Long at = homeAskedAt.get(home);
            ask = at == null || now - at > 60_000;
            if (ask) homeAskedAt.put(home, now);
        }
        if (ask) Ui.pool.execute(() -> {
            boolean up;
            try { h.state(); up = true; } catch (Exception e) { up = false; }
            Boolean was;
            synchronized (homeAskedAt) { was = homeBack.put(home, up); }
            if (was == null || was != up) Ui.main.post(changed);
        });
        synchronized (homeAskedAt) { return Boolean.TRUE.equals(homeBack.get(home)); }
    }
}
