package dev.harbor.app;

import android.app.Activity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;

/** The desktop's Claude usage read-out (`limits` of GET /v1/usage), asked for when it opens. */
final class Limits {
    private Limits() {}

    static void show(Activity a, Hub hub) {
        Ui.bg(a, () -> hub.get("/v1/usage"), r -> {
            Sheet s = new Sheet(a, "Claude usage");
            JSONArray list = r.optJSONArray("limits");
            if (list == null) s.body.addView(note(a, "Update Harbor on this PC to see this."));
            else if (list.length() == 0) s.body.addView(note(a, "No Claude account on this PC."));
            else for (int i = 0; i < list.length(); i++) account(a, s.card(), list.optJSONObject(i));
            s.show();
        });
    }

    private static void account(Activity a, LinearLayout c, JSONObject o) {
        if (o == null) return;
        c.setPadding(Ui.dp(18), Ui.dp(14), Ui.dp(18), Ui.dp(16));
        String plan = o.optString("plan");
        long seen = o.optLong("seen_ms");
        StringBuilder sub = new StringBuilder(plan);
        if (seen > 0) sub.append(sub.length() > 0 ? " · " : "").append(Ui.ago(seen)).append(seen > System.currentTimeMillis() - 60_000 ? "" : " ago");
        c.addView(Ui.text(a, o.optString("label"), 16, Ui.FG));
        if (sub.length() > 0) c.addView(Ui.text(a, sub.toString(), 13, Ui.G700));
        JSONArray w = o.optJSONArray("windows");
        if (!o.optBoolean("signed_in", true)) c.addView(note(a, "Signed out on this PC."));
        else if (w == null || w.length() == 0) c.addView(note(a, "No usage data yet."));
        else for (int i = 0; i < w.length(); i++) window(a, c, w.optJSONObject(i));
    }

    private static void window(Activity a, LinearLayout c, JSONObject w) {
        if (w == null) return;
        LinearLayout row = Ui.row(a);
        TextView label = Ui.text(a, w.optString("label"), 13, Ui.G700);
        row.addView(label, new LinearLayout.LayoutParams(0, -2, 1));
        row.addView(Ui.text(a, w.optString("text"), 13, Ui.G700));
        c.addView(row, Ui.margins(Ui.fill(), 0, 12, 0, 6));
        c.addView(bar(a, (float) (w.optDouble("percent", 0) / 100)), new LinearLayout.LayoutParams(-1, Ui.dp(6)));
    }

    /** The desktop's `w::meter`: gray up to 60%, amber to 85%, then red. */
    private static View bar(Activity a, float used) {
        float f = Math.max(0, Math.min(1, used));
        LinearLayout track = Ui.row(a);
        track.setBackground(Ui.round(Ui.G200, 0, 3));
        View fill = new View(a);
        fill.setBackground(Ui.round(f > 0.85f ? Ui.RED : f > 0.6f ? Ui.AMBER : Ui.G900, 0, 3));
        track.addView(fill, new LinearLayout.LayoutParams(0, -1, f));
        track.addView(new View(a), new LinearLayout.LayoutParams(0, -1, 1 - f));
        return track;
    }

    private static TextView note(Activity a, String text) {
        TextView n = Ui.text(a, text, 14, Ui.G700);
        n.setPadding(Ui.dp(6), Ui.dp(6), Ui.dp(6), Ui.dp(6));
        return n;
    }
}
