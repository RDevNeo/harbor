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
 *  Collector's tab carries a count, Persons' unread pill (Ds.pill): its runs that finished since it was last
 *  looked at, here or on the PC (GET /v1/collector/unread, as the PC's tab bar reads it). Projects' tab carries
 *  the chats that need you: their turn ended unseen and they weren't opened since, here or on the PC (their
 *  sidebar dots; GET /v1/projects/unread). */
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

    /** Collector runs finished and not looked at yet, and the chats that need you, as the PC said last; the pills
     *  that show them on every bar (each with its tab). */
    private static int collectorUnread, projectsUnread;
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

    private static int count(String tab) {
        return COLLECTOR.equals(tab) ? collectorUnread : PROJECTS.equals(tab) ? projectsUnread : 0;
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
        p.setContentDescription(PROJECTS.equals(tab)
                ? (n == 1 ? "A chat needs you" : n + " chats need you")
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
            } finally {
                asking = false;
            }
        });
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
            if (COLLECTOR.equals(t[0]) || PROJECTS.equals(t[0])) {
                // The icon with its count on the corner, as Persons' unread pill.
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
                continue;
            }
            item.addView(icon, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, Ui.dp(26)));
            item.addView(label, Ui.wrap());
            item.setBackground(Ui.press(0, 0, 0));
            item.setContentDescription(t[1]);
            final String id = t[0];
            item.setOnClickListener(v -> { if (!id.equals(current)) go(a, id); });
            bar.addView(item, Ui.weight());
        }
        return bar;
    }

    /** `content` with the bar under it, as an activity's whole screen. */
    static LinearLayout around(Activity a, View content, String current) {
        LinearLayout col = Ui.col(a);
        col.setBackgroundColor(Ui.BG);
        col.addView(content, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        View line = new View(a);
        line.setBackgroundColor(Ui.LINE);
        col.addView(line, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, Ui.dp(0.5f))));
        col.addView(bar(a, current), Ui.fill());
        return col;
    }

    /** Opens tab `id`: its screen comes back as it was (or starts). */
    static void go(Activity a, String id) {
        Class<?> to = PERSONS.equals(id) ? Persons.class : ROUTINE.equals(id) ? Routine.class : COLLECTOR.equals(id) ? Collector.class : Hubs.class;
        Intent i = new Intent(a, to).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_NO_ANIMATION);
        a.startActivity(i);
        a.overridePendingTransition(0, 0);
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
