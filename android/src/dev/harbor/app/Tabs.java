package dev.harbor.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.List;

/** Hub's top-level tabs, at the bottom of their screens as Android apps have them: Projects (the
 *  start screen, Hubs, and the chats it opens), Persons, Routine and Collector, in that order. Each tab is a
 *  screen of its own (Hubs/Chats, Persons, Routine); switching brings the tab's screen back where
 *  it was, without an animation. Persons and Routine read and change their data on the PC (the
 *  same `v1/persons/…`, `v1/routine/…` routes Hub's window uses), the one this phone used last.
 *  Every tab carries a count on its icon's corner (Ds.pill), as WhatsApp's tabs and the PC's tab bar (the same
 *  routes): Projects the chats that need you (their turn ended unseen and they weren't opened since, here or on the
 *  PC; GET /v1/projects/unread), Persons everyone's unread messages (the drawer's section counts summed; GET
 *  /v1/persons/unread, and at once from each state the Persons tab reads), Routine today's goals still to do (GET
 *  /v1/routine/pending), Collector its runs that finished since it was last looked at (GET /v1/collector/unread).
 *  Read when a screen comes up, when the PC says its state moved, and every few seconds while Hub is in front. */
final class Tabs {
    static final String PROJECTS = "projects", PERSONS = "persons", ROUTINE = "routine", COLLECTOR = "collector";
    // Lucide: folder-kanban, users, dumbbell, funnel
    private static final String[][] TABS = {
        {PROJECTS, "Projects", ""},
        {PERSONS, "Persons", ""},
        {ROUTINE, "Routine", ""},
        {COLLECTOR, "Collector", ""},
    };

    private Tabs() {}

    /** Each tab's count as the PC said last; the pills that show them on every bar (each with its tab). */
    private static int collectorUnread, projectsUnread, personsUnread, routinePending;
    private static final List<WeakReference<TextView>> pills = new ArrayList<>();
    private static final List<String> pillTabs = new ArrayList<>();
    private static volatile boolean asking;

    /** Every bar's Collector pill says `n` (hidden at 0). UI thread. */
    static void collectorUnread(int n) {
        collectorUnread = Math.max(0, n);
        redraw();
    }

    /** Every bar's Projects pill says `n` (hidden at 0). UI thread. */
    static void projectsUnread(int n) {
        projectsUnread = Math.max(0, n);
        redraw();
    }

    /** Every bar's Persons pill says `n` (hidden at 0). UI thread. */
    static void personsUnread(int n) {
        personsUnread = Math.max(0, n);
        redraw();
    }

    /** Every bar's Routine pill says `n` (hidden at 0). UI thread. */
    static void routinePending(int n) {
        routinePending = Math.max(0, n);
        redraw();
    }

    private static int count(String tab) {
        return COLLECTOR.equals(tab) ? collectorUnread : PROJECTS.equals(tab) ? projectsUnread
                : PERSONS.equals(tab) ? personsUnread : ROUTINE.equals(tab) ? routinePending : 0;
    }

    private static void redraw() {
        for (int i = pills.size() - 1; i >= 0; i--) {
            TextView p = pills.get(i).get();
            if (p == null) { pills.remove(i); pillTabs.remove(i); continue; }
            show(p, pillTabs.get(i), count(pillTabs.get(i)));
        }
    }

    private static void show(TextView p, String tab, int n) {
        p.setText(n > 99 ? "99+" : String.valueOf(n));
        p.setContentDescription(PROJECTS.equals(tab) ? (n == 1 ? "A chat needs you" : n + " chats need you")
                : PERSONS.equals(tab) ? (n == 1 ? "An unread message" : n + " unread messages")
                : ROUTINE.equals(tab) ? (n == 1 ? "A goal left today" : n + " goals left today")
                : (n == 1 ? "A Collector run is done" : n + " Collector runs done"));
        p.setVisibility(n > 0 ? View.VISIBLE : View.GONE);
    }

    /** Asks the PC for the tabs' counts (a screen came up, or the PC said its state changed). */
    static void poke(Hub h) {
        if (h == null || asking) return;
        asking = true;
        Ui.pool.execute(() -> {
            try {
                try {
                    JSONObject r = h.get("/v1/collector/unread");
                    int n = r == null ? 0 : r.optInt("unread", 0);
                    Ui.main.post(() -> collectorUnread(n));
                } catch (Exception ignored) {
                    // an older PC, or it's away: the count stays as it was
                }
                try {
                    JSONObject r = h.get("/v1/projects/unread");
                    int n = r == null ? 0 : r.optInt("unread", 0);
                    Ui.main.post(() -> projectsUnread(n));
                } catch (Exception ignored) {
                    // the same
                }
                try {
                    JSONObject r = h.get("/v1/persons/unread");
                    if (r != null && r.has("unread")) {
                        int n = r.optInt("unread", 0);
                        Ui.main.post(() -> personsUnread(n));
                    }
                } catch (Exception ignored) {
                    // the same
                }
                try {
                    JSONObject r = h.get("/v1/routine/pending");
                    if (r != null && r.has("pending")) {
                        int n = r.optInt("pending", 0);
                        Ui.main.post(() -> routinePending(n));
                    }
                } catch (Exception ignored) {
                    // the same (a PC without the route keeps the Routine tab bare)
                }
            } finally {
                asking = false;
            }
        });
    }

    /** While a Hub screen is in front, the counts are read again every few seconds (a person's message or a goal
     *  logged on the PC doesn't move the Projects state the screens listen to), as the PC's tab bar does. */
    private static boolean ticking;

    static void tick() {
        if (ticking) return;
        ticking = true;
        Ui.main.postDelayed(new Runnable() {
            @Override public void run() {
                Base b = Base.top;
                if (b == null || !b.front) { ticking = false; return; }
                poke(hub(b));
                Ui.main.postDelayed(this, 5_000);
            }
        }, 5_000);
    }

    /** The Collector tab is on screen: its runs are seen (the PC forgets the count, for its own tab bar too). */
    static void collectorSeen(Hub h) {
        collectorUnread(0);
        if (h == null) return;
        Ui.pool.execute(() -> {
            try { h.call("POST", "/v1/collector/seen", new JSONObject()); } catch (Exception ignored) { }
        });
    }

    /** The bar, `current` lit. */
    static LinearLayout bar(Activity a, String current) {
        LinearLayout bar = Ui.row(a);
        bar.setBackgroundColor(Ui.BG);
        bar.setPadding(0, Ui.dp(4), 0, Ui.dp(6));
        View line = new View(a);
        line.setBackgroundColor(Ui.LINE);
        for (String[] t : TABS) {
            boolean on = t[0].equals(current);
            LinearLayout item = Ui.col(a);
            item.setGravity(Gravity.CENTER);
            item.setPadding(0, Ui.dp(6), 0, Ui.dp(4));
            TextView icon = Ui.icon(a, t[2], 22, on ? Ui.FG : Ui.G700);
            TextView label = on ? Ui.bold(a, t[1], 12, Ui.FG) : Ui.text(a, t[1], 12, Ui.G700);
            label.setGravity(Gravity.CENTER);
            // The icon with its count on the corner (every tab, as WhatsApp's).
            FrameLayout box = new FrameLayout(a);
            box.setClipChildren(false);
            item.setClipChildren(false);
            box.addView(icon, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, Ui.dp(26), Gravity.CENTER));
            TextView pill = Ds.pill(a, Math.max(1, count(t[0])), true);
            pill.setTranslationX(Ui.dp(14));
            pill.setTranslationY(-Ui.dp(3));
            box.addView(pill, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.CENTER_HORIZONTAL));
            show(pill, t[0], count(t[0]));
            pills.add(new WeakReference<>(pill));
            pillTabs.add(t[0]);
            item.addView(box, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, Ui.dp(26)));
            item.addView(label, Ui.wrap());
            item.setBackground(Ui.press(0, 0, 0));
            item.setContentDescription(t[1]);
            final String cid = t[0];
            item.setOnClickListener(v -> { if (!cid.equals(current)) go(a, cid); });
            bar.addView(item, Ui.weight());
        }
        return bar;
    }

    /** `content` with the bar under it, as an activity's whole screen. The bar stays on every page of every tab,
     *  chats too; only while the keyboard is up does it step aside (as Headquarters' tab bar), so the composer
     *  keeps the room. */
    static LinearLayout around(Activity a, View content, String current) {
        LinearLayout col = Ui.col(a);
        col.setBackgroundColor(Ui.BG);
        // A page already shown on its own (Base.frame sets it as the content view) moves under the bar.
        if (content.getParent() != null) ((ViewGroup) content.getParent()).removeView(content);
        col.addView(content, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        View line = new View(a);
        line.setBackgroundColor(Ui.LINE);
        col.addView(line, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, Ui.dp(0.5f))));
        LinearLayout bar = bar(a, current);
        col.addView(bar, Ui.fill());
        col.getViewTreeObserver().addOnGlobalLayoutListener(() -> {
            int vis = keyboardUp(col) ? View.GONE : View.VISIBLE;
            if (bar.getVisibility() != vis) {
                bar.setVisibility(vis);
                line.setVisibility(vis);
            }
        });
        return col;
    }

    /** Whether the soft keyboard covers part of the window `v` is in. */
    private static boolean keyboardUp(View v) {
        View root = v.getRootView();
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            android.view.WindowInsets in = root.getRootWindowInsets();
            if (in != null) return in.isVisible(android.view.WindowInsets.Type.ime());
        }
        android.graphics.Rect r = new android.graphics.Rect();
        root.getWindowVisibleDisplayFrame(r);
        return root.getHeight() - r.bottom > Ui.dp(120);
    }

    /** The Projects screen seen last (a chat, the chat list, a GitHub list), so the tab comes back to it. */
    private static WeakReference<Base> lastProjects;

    /** A Projects screen came to the front. */
    static void projectsShown(Base b) { lastProjects = new WeakReference<>(b); }

    /** Opens tab `id`: its screen comes back as it was (or starts). Projects comes back to the screen it showed
     *  (the chat, else the workspace's chat list), never Hub's start screen while a PC is known. */
    static void go(Activity a, String id) {
        if (PROJECTS.equals(id)) { goProjects(a); return; }
        Class<?> to = PERSONS.equals(id) ? Persons.class : ROUTINE.equals(id) ? Routine.class : Collector.class;
        reorder(a, new Intent(a, to));
        a.overridePendingTransition(0, 0);
    }

    private static void goProjects(Activity a) {
        Base last = lastProjects == null ? null : lastProjects.get();
        if (last != null && (last.isFinishing() || last.isDestroyed())) last = null;
        Hub h = last != null && last.hub != null ? last.hub : hub(a);
        if (last instanceof Chat || last instanceof GhList) {
            // The chat list under it first, so Back from the chat lands on it, as before the switch.
            reorder(a, new Intent(a, Chats.class).putExtra("hub", last.hub.id));
            reorder(a, new Intent(a, last.getClass()).putExtras(last.getIntent()));
        } else if (h != null) {
            reorder(a, new Intent(a, Chats.class).putExtra("hub", h.id));
        } else {
            reorder(a, new Intent(a, Hubs.class));
        }
        a.overridePendingTransition(0, 0);
    }

    private static void reorder(Activity a, Intent i) {
        a.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_NO_ANIMATION));
    }

    /** The PC a tab's data comes from: the one used last, else the only one paired; null when none. */
    static Hub hub(Context c) {
        String last = Hub.last(c);
        Hub h = last == null ? null : Hub.get(c, last);
        if (h != null) return h;
        List<Hub> all = Hub.all(c);
        return all.isEmpty() ? null : all.get(0);
    }
}
