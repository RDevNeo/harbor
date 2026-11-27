package dev.harbor.app;

import android.app.Activity;
import android.content.SharedPreferences;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.InputMethodManager;
import android.widget.FrameLayout;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/** The Persons tab of one screen (PersonsTab is its entry): Person Hub's phone layout, one screen
 *  at a time over each other in `root`: home (the sidebar, PersonsHome), the All people list
 *  (PersonsList), a person's chat (PersonsChat) and their details (PersonsPanel). Back closes the
 *  top-most. While the tab shows, one long-poll on GET /v1/persons/state?rev=N keeps it live
 *  (ts/packages/persons/API.md). */
final class PersonsState {
    /** The tab on screen now (the last one built), for PersonsTab's static hooks. */
    static PersonsState cur;
    static volatile int unread;

    final Activity a;
    final Hub hub;
    final FrameLayout root;
    final SharedPreferences prefs;
    JSONObject st;
    private volatile long rev = -1;
    private volatile boolean haveState;
    /** Why the PC doesn't answer the Persons API now; null when it does. */
    volatile String error;
    private final Map<String, JSONObject> byId = new HashMap<>();

    final PersonsHome home;
    /** The tab's drawer: the same list as `home` (made by drawer()). */
    private PersonsHome drawerHome;
    /** Runs after a row opened a screen (the host closes its drawer). */
    Runnable navigated;
    PersonsList list;
    PersonsChat chat;
    PersonsPanel panel;
    /** A SpokPay site request's pane (the SpokPay section's Site requests). */
    PersonsSr sr;

    private volatile boolean vis;
    private int gen;
    private boolean looping;

    PersonsState(Activity a, Hub hub) {
        this.a = a;
        this.hub = hub;
        prefs = a.getSharedPreferences("persons", 0);
        root = new FrameLayout(a);
        root.setBackgroundColor(Ui.BG);
        home = new PersonsHome(this, false);
        root.addView(home.view, new FrameLayout.LayoutParams(-1, -1));
        root.addOnAttachStateChangeListener(new View.OnAttachStateChangeListener() {
            @Override public void onViewAttachedToWindow(View v) { Ui.main.removeCallbacks(tick); Ui.main.post(tick); }
            @Override public void onViewDetachedFromWindow(View v) { Ui.main.removeCallbacks(tick); vis = false; }
        });
    }

    /** The tab for this screen and PC: the one already built, else a new one. */
    static PersonsState of(Activity a, Hub hub) {
        if (cur != null && cur.a == a && cur.hub != null && hub != null && cur.hub.id.equals(hub.id)) return cur;
        if (cur != null) cur.stop();
        cur = new PersonsState(a, hub);
        return cur;
    }

    // ---- live: the long-poll runs while the tab is on screen and the screen in front ----

    private final Runnable tick = new Runnable() {
        @Override public void run() {
            boolean v = root.isAttachedToWindow() && root.isShown() && front() && !a.isDestroyed();
            vis = v;
            if (v) start(); // a no-op while the loop runs
            if (root.isAttachedToWindow()) Ui.main.postDelayed(this, 1000);
        }
    };

    private boolean front() { return a instanceof Base ? ((Base) a).front : a.hasWindowFocus(); }

    private void start() {
        if (looping || hub == null) return;
        looping = true;
        int g = ++gen;
        Ui.pool.execute(() -> loop(g));
    }

    void stop() {
        gen++;
        looping = false;
        Ui.main.removeCallbacks(tick);
    }

    private void loop(int g) {
        int fails = 0;
        try {
            while (g == gen && vis && !a.isDestroyed()) {
                long r = rev;
                long began = System.currentTimeMillis();
                try {
                    JSONObject s = hub.call("GET", "/v1/persons/state" + (haveState && r >= 0 ? "?rev=" + r : ""), null, Hub.POLL_TIMEOUT);
                    fails = 0;
                    long nr = s.optLong("rev", -1);
                    if (nr != r || !haveState || error != null) {
                        haveState = true;
                        rev = nr;
                        Ui.main.post(() -> { if (g == gen) apply(s); });
                    }
                    // A PC that answers at once with the same rev: not a busy loop.
                    if (nr == r && System.currentTimeMillis() - began < 1000) Thread.sleep(2000);
                } catch (Hub.ApiError e) {
                    String why = e.code == 404 ? "Hub on the PC has no Persons yet: update Hub there." : e.getMessage();
                    Ui.main.post(() -> { if (g == gen) failed(why); });
                    Thread.sleep(e.code == 404 ? 30_000 : 5_000);
                } catch (InterruptedException e) {
                    throw e;
                } catch (Exception e) {
                    fails++;
                    String why = Hub.why(e);
                    Ui.main.post(() -> { if (g == gen) failed(why); });
                    Thread.sleep(Math.min(15_000, 2_000L * fails));
                }
            }
        } catch (InterruptedException ignored) {
        } finally {
            Ui.main.post(() -> { if (g == gen) looping = false; });
        }
    }

    private void failed(String why) {
        error = why;
        redrawHomes();
    }

    /** A new state: every open screen redraws from it. */
    void apply(JSONObject s) {
        st = s;
        error = null;
        byId.clear();
        JSONArray people = PersonsUi.arr(s, "people");
        int n = 0;
        for (int i = 0; i < people.length(); i++) {
            JSONObject p = people.optJSONObject(i);
            if (p == null) continue;
            byId.put(PersonsUi.s(p, "id"), p);
            n += PersonsUi.info(p, "").optInt("unread");
        }
        int u = s.has("unread") ? s.optInt("unread") : n;
        boolean changed = u != unread;
        unread = u;
        home.render();
        if (drawerHome != null) drawerHome.render();
        if (list != null) list.render();
        if (chat != null) chat.stateChanged();
        if (panel != null) panel.stateChanged();
        if (sr != null) sr.stateChanged();
        if (changed) PersonsTab.changed();
    }

    JSONObject person(String id) { return byId.get(id); }

    /** The tab's drawer (Base.installTab): People's list again, as Projects' drawer is its chat list. */
    View drawer() {
        if (drawerHome == null) drawerHome = new PersonsHome(this, true);
        return drawerHome.view;
    }

    /** Both lists again (a fold opened or closed in one of them). */
    void redrawHomes() {
        home.render();
        if (drawerHome != null) drawerHome.render();
    }

    /** The top bar's side-panel button on every Persons page: opens the drawer. */
    View sideButton() {
        return Ds.sideButton(a, v -> { if (a instanceof Base) ((Base) a).openDrawer(); });
    }

    private void navigated() {
        if (navigated != null) navigated.run();
    }

    /** Fetch the state again now (after a change made here), without waiting for the long-poll. */
    void refresh() {
        if (hub == null) return;
        Ui.pool.execute(() -> {
            try {
                JSONObject s = hub.get("/v1/persons/state");
                long nr = s.optLong("rev", -1);
                Ui.main.post(() -> { if (!a.isDestroyed() && nr >= rev) { rev = nr; haveState = true; apply(s); } });
            } catch (Exception ignored) { }
        });
    }

    // ---- folds kept across restarts ----

    Set<String> set(String key) { return new HashSet<>(prefs.getStringSet(key, new HashSet<>())); }

    boolean in(String key, String v) { return prefs.getStringSet(key, new HashSet<>()).contains(v); }

    void flip(String key, String v) {
        Set<String> s = set(key);
        if (!s.remove(v)) s.add(v);
        prefs.edit().putStringSet(key, s).apply();
    }

    // ---- screens ----

    private void push(View v) {
        if (v.getParent() != null) ((ViewGroup) v.getParent()).removeView(v);
        root.addView(v, new FrameLayout.LayoutParams(-1, -1));
        PersonsTab.changed();
    }

    private void pop(View v) {
        keyboard(false);
        root.removeView(v);
        PersonsTab.changed();
    }

    void keyboard(boolean show) {
        InputMethodManager im = (InputMethodManager) a.getSystemService(Activity.INPUT_METHOD_SERVICE);
        if (im != null && !show) im.hideSoftInputFromWindow(root.getWindowToken(), 0);
    }

    void openList() {
        navigated();
        if (list != null) return;
        list = new PersonsList(this);
        push(list.view);
    }

    /** A person's chat, from the row of a section ("" = All people). */
    void openChat(String id, String section) {
        navigated();
        // Their notification goes once their chat is open (read here).
        if (hub != null && id != null) Notes.clearPerson(a, hub.id, id);
        if (chat != null) closeChat();
        chat = new PersonsChat(this, id, section == null ? "" : section);
        push(chat.view);
    }

    void closeChat() {
        if (panel != null) closePanel();
        if (chat == null) return;
        chat.close();
        pop(chat.view);
        chat = null;
    }

    void openPanel(String id, String section) {
        if (panel != null) return;
        panel = new PersonsPanel(this, id, section);
        push(panel.view);
    }

    void closePanel() {
        if (panel == null) return;
        panel.close();
        pop(panel.view);
        panel = null;
    }

    /** A site request's pane, from its row in the SpokPay section. */
    void openSr(String ref) {
        navigated();
        if (sr != null) closeSr();
        sr = new PersonsSr(this, ref);
        push(sr.view);
    }

    void closeSr() {
        if (sr == null) return;
        sr.close();
        pop(sr.view);
        sr = null;
    }

    /** A person was deleted: their chat and panel go. */
    void gone() {
        closePanel();
        closeChat();
    }

    /** Android back: the top-most screen closes; false at home (the app's own back then). */
    boolean back() {
        if (panel != null) { closePanel(); return true; }
        if (chat != null) { closeChat(); return true; }
        if (sr != null) { closeSr(); return true; }
        if (list != null) { pop(list.view); list = null; return true; }
        return false;
    }

    boolean deep() { return chat != null || panel != null || sr != null; }
}
