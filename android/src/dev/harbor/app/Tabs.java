package dev.harbor.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.List;

/** Hub's top-level tabs, at the bottom of their screens as Android apps have them: Projects (the
 *  start screen, Hubs, and the chats it opens), Persons, Routine and Collector, in that order. Each tab is a
 *  screen of its own (Hubs/Chats, Persons, Routine); switching brings the tab's screen back where
 *  it was, without an animation. Persons and Routine read and change their data on the PC (the
 *  same `v1/persons/…`, `v1/routine/…` routes Hub's window uses), the one this phone used last. */
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
