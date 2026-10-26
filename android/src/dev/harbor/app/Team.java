package dev.harbor.app;

import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.DateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;

/** The right-hand panel of a chat: what the desktop's team panel shows for its lead (GET
 *  /v1/chats/{id}/team): agents, processes, wake-ups and webhooks, each with an empty state.
 *  Read-only; an agent opens its own chat, a long press copies a command or a URL. */
final class Team {
    final FrameLayout view;
    private final Base a;
    private final String chat;
    private final LinearLayout list;
    private final TextView sub;
    private JSONObject team;
    private boolean loading, again, showSettled;
    String lead = ""; // the lead whose team this is (the chat itself, or a subagent's lead)

    Team(Base a, String chat) {
        this.a = a;
        this.chat = chat;
        view = new FrameLayout(a);
        view.setBackgroundColor(Ui.BG);
        LinearLayout col = Ui.col(a);
        LinearLayout head = Ui.row(a);
        head.setPadding(Ui.dp(20), Ui.dp(14), Ui.dp(8), 0);
        LinearLayout t = Ui.col(a);
        t.addView(Ui.heading(a, "Team", 26));
        sub = Ui.subtitle(Ui.text(a, "", 13, Ui.G700));
        sub.setVisibility(View.GONE);
        t.addView(sub);
        head.addView(t, Ui.weight());
        TextView close = Ui.iconButton(a, Ui.I_X, Ui.FG, v -> a.closeDrawer());
        close.setContentDescription("Close");
        head.addView(close);
        col.addView(head, Ui.fill());
        ScrollView sv = new ScrollView(a);
        list = Ui.col(a);
        list.setPadding(0, Ui.dp(2), 0, Ui.dp(24));
        sv.addView(list);
        col.addView(sv, new LinearLayout.LayoutParams(-1, 0, 1));
        view.addView(col, new FrameLayout.LayoutParams(-1, -1));
        note("Loading…", Ui.G700);
    }

    void load() {
        if (loading) { again = true; return; }
        loading = true;
        Hub hub = a.hub;
        Ui.pool.execute(() -> {
            JSONObject r = null;
            String why = null;
            try { r = hub.get("/v1/chats/" + chat + "/team"); } catch (Exception e) { why = Hub.why(e); }
            final JSONObject fr = r; final String fw = why;
            Ui.main.post(() -> {
                loading = false;
                if (a.isFinishing()) return;
                if (fr != null) render(fr);
                else if (team == null) { list.removeAllViews(); note(fw, Ui.RED); }
                if (again) { again = false; load(); }
            });
        });
    }

    private void render(JSONObject t) {
        team = t;
        lead = t.optString("lead", "");
        list.removeAllViews();
        JSONObject st = Hub.states.get(a.hub.id);
        String project = "";
        JSONArray pa = st == null ? null : st.optJSONArray("projects");
        if (pa != null && !t.isNull("project_id")) for (int i = 0; i < pa.length(); i++) {
            JSONObject p = pa.optJSONObject(i);
            if (p != null && p.optString("id").equals(t.optString("project_id"))) project = p.optString("name");
        }
        String home = t.optString("home", "");
        String s = project.isEmpty() ? "No project" : project;
        if (!home.isEmpty()) s += " · runs on " + home;
        sub.setText(s);
        sub.setVisibility(View.VISIBLE);

        // ---- agents (working or queued ones never count as settled)
        List<JSONObject> active = new ArrayList<>(), settled = new ArrayList<>();
        JSONArray ag = t.optJSONArray("agents");
        if (ag != null) for (int i = 0; i < ag.length(); i++) {
            JSONObject o = ag.optJSONObject(i);
            if (o != null) (o.optBoolean("settled") ? settled : active).add(o);
        }
        header(Ui.I_BOT, "Agents", active.size());
        if (active.isEmpty()) note(settled.isEmpty() ? "The lead spawns subagents here as it delegates work." : "No agents working. Earlier ones are under Settled.", Ui.G700);
        for (JSONObject o : active) list.addView(agent(o), Ui.inset());
        if (!settled.isEmpty()) {
            TextView h = Ui.label(a, "Settled · " + settled.size() + (showSettled ? "  ▾" : "  ▸"));
            h.setBackground(Ui.press(0, 0, 0));
            h.setOnClickListener(v -> { showSettled = !showSettled; render(team); });
            list.addView(h, Ui.fill());
            if (showSettled) for (JSONObject o : settled) list.addView(agent(o), Ui.inset());
        }

        // ---- processes
        JSONArray pr = t.optJSONArray("processes");
        int np = pr == null ? 0 : pr.length();
        header(Ui.I_ACTIVITY, "Processes", np);
        if (np == 0) note(home.isEmpty() ? "No processes running. Dev servers and watchers the agents start show here." : "Its processes run on " + home + ".", Ui.G700);
        for (int i = 0; i < np; i++) {
            JSONObject p = pr.optJSONObject(i);
            if (p == null) continue;
            String url = p.isNull("url") ? "" : p.optString("url", "");
            String cmd = p.optString("cmd");
            LinearLayout r = card(Ui.I_ACTIVITY, Ui.GREEN, p.optString("name"), "up " + since(p.optLong("started_ms")), Ui.G700);
            if (!url.isEmpty()) r.addView(line(url, 12, Ui.BLUE, true));
            r.addView(line(cmd, 12, Ui.G700, true));
            r.setOnLongClickListener(v -> { Ui.copy(a, url.isEmpty() ? cmd : url); return true; });
            list.addView(r, Ui.inset());
        }

        // ---- wake-ups
        JSONArray wk = t.optJSONArray("wakeups");
        int nw = wk == null ? 0 : wk.length();
        header(Ui.I_CLOCK, "Wake-ups", nw);
        if (nw == 0) note(home.isEmpty() ? "Ask the lead to check back later, e.g. “look at the deploy in 20 minutes”." : "Its wake-ups are on " + home + ".", Ui.G700);
        for (int i = 0; i < nw; i++) {
            JSONObject w = wk.optJSONObject(i);
            if (w == null) continue;
            long at = w.optLong("at_ms");
            LinearLayout r = card(Ui.I_CLOCK, Ui.G700, DateFormat.getTimeInstance(DateFormat.SHORT).format(new Date(at)), until(at), Ui.G700);
            String reason = w.optString("reason");
            if (!reason.isEmpty()) r.addView(line(reason, 13, Ui.G900, false));
            list.addView(r, Ui.inset());
        }

        // ---- webhooks (they belong to a project)
        JSONArray hk = t.optJSONArray("webhooks");
        int nh = hk == null ? 0 : hk.length();
        header(Ui.I_WEBHOOK, "Webhooks", nh);
        if (nh == 0) note(!home.isEmpty() ? "Its webhooks are on " + home + "."
                : t.isNull("project_id") ? "Webhooks belong to a project, and this chat has none."
                : "Ask the lead for a webhook to react to GitHub, Vercel, Stripe…", Ui.G700);
        for (int i = 0; i < nh; i++) {
            JSONObject h = hk.optJSONObject(i);
            if (h == null) continue;
            boolean pub = h.optBoolean("public");
            LinearLayout r = card(Ui.I_WEBHOOK, Ui.G700, h.optString("name"), pub ? "Public" : "Local", pub ? Ui.GREEN : Ui.G700);
            long last = h.optLong("last_ms");
            long hits = h.optLong("hits");
            r.addView(line(hits + (hits == 1 ? " call" : " calls") + (last > 0 ? " · last " + Ui.ago(last) : ""), 12, Ui.G700, false));
            String desc = h.optString("description");
            if (!desc.isEmpty()) r.addView(line(desc, 13, Ui.G900, false));
            String url = h.optString("url");
            r.setOnLongClickListener(v -> { Ui.copy(a, url); return true; });
            list.addView(r, Ui.inset());
        }
    }

    private View agent(JSONObject o) {
        boolean running = o.optBoolean("running");
        int queued = o.optInt("queued");
        String paused = o.isNull("paused") ? "" : o.optString("paused", "");
        String status; int color;
        if (running) { status = "working " + since(o.optLong("started_ms")); color = Ui.GREEN; }
        else if (!paused.isEmpty()) { status = "paused · " + paused; color = Ui.AMBER; }
        else if (queued > 0) { status = queued + " queued"; color = Ui.AMBER; }
        else { status = "idle · " + Ui.ago(o.optLong("updated_ms")); color = Ui.G700; }
        String name = o.optString("name");
        LinearLayout r = card(Ui.I_BOT, running ? Ui.GREEN : Ui.G700, name.isEmpty() ? "agent" : name, status, color);
        String model = o.optString("model"), acc = o.optString("account");
        String m = model.isEmpty() ? acc : acc.isEmpty() ? model : model + " · " + acc;
        // Its tokens and cost so far (cost.rs), after the model.
        String usage = o.isNull("usage") ? "" : o.optString("usage", "");
        if (!usage.isEmpty()) m = m.isEmpty() ? usage : m + " · " + usage;
        if (!m.isEmpty()) r.addView(line(m, 12, Ui.G700, true));
        String task = o.optString("title");
        if (!task.isEmpty()) r.addView(line(task, 13, Ui.G900, false));
        String id = o.optString("id");
        r.setBackground(Ui.press(0, 0, 12));
        r.setOnClickListener(v -> { a.closeDrawer(); Chat.open(a, a.hub, id); });
        return r;
    }

    /** "Agents 2" with its icon, like the desktop's section headers. */
    private void header(String glyph, String title, int n) {
        LinearLayout r = Ui.row(a);
        r.setPadding(Ui.dp(20), Ui.dp(18), Ui.dp(20), Ui.dp(4));
        r.addView(Ui.icon(a, glyph, 15, Ui.G700), new LinearLayout.LayoutParams(Ui.dp(18), Ui.dp(18)));
        r.addView(Ui.text(a, title, 13, Ui.G700), Ui.margins(Ui.wrap(), 8, 0, 0, 0));
        if (n > 0) r.addView(Ui.text(a, String.valueOf(n), 13, Ui.G600), Ui.margins(Ui.wrap(), 6, 0, 0, 0));
        list.addView(r, Ui.fill());
    }

    /** A row: icon, a title and a right-aligned status; lines added under the title. */
    private LinearLayout card(String glyph, int glyphColor, String title, String status, int statusColor) {
        LinearLayout c = Ui.col(a);
        c.setPadding(Ui.dp(12), Ui.dp(8), Ui.dp(12), Ui.dp(8));
        LinearLayout top = Ui.row(a);
        top.addView(Ui.icon(a, glyph, 18, glyphColor), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(20), Ui.dp(20)), 0, 0, 14, 0));
        top.addView(Ui.subtitle(Ui.bold(a, title, 15, Ui.FG)), Ui.weight());
        TextView s = Ui.subtitle(Ui.text(a, status, 13, statusColor));
        s.setGravity(Gravity.END);
        top.addView(s, Ui.margins(Ui.wrap(), 10, 0, 0, 0));
        c.addView(top, Ui.fill());
        return c;
    }

    /** A line under a row's title, lined up with it. */
    private TextView line(String s, float sp, int color, boolean mono) {
        TextView t = Ui.subtitle(Ui.text(a, s, sp, color));
        if (mono) t.setTypeface(Ui.mono);
        t.setLayoutParams(Ui.margins(Ui.fill(), 34, 2, 0, 0));
        return t;
    }

    private void note(String s, int color) {
        TextView t = Ui.text(a, s, 13, color);
        t.setPadding(Ui.dp(20), Ui.dp(2), Ui.dp(20), Ui.dp(4));
        list.addView(t, Ui.fill());
    }

    /** "12m" since a time (ms), like the desktop's minutes. */
    private static String since(long ms) {
        long s = Math.max(0, (System.currentTimeMillis() - ms) / 1000);
        if (s < 60) return "<1m";
        if (s < 3600) return s / 60 + "m";
        return s / 3600 + "h" + String.format(java.util.Locale.ROOT, "%02d", s % 3600 / 60) + "m";
    }

    /** "in 12m" until a time (ms). */
    private static String until(long ms) {
        long s = Math.max(0, (ms - System.currentTimeMillis()) / 1000);
        if (s < 60) return "in <1m";
        if (s < 3600) return "in " + s / 60 + "m";
        return "in " + s / 3600 + "h" + String.format(java.util.Locale.ROOT, "%02d", s % 3600 / 60) + "m";
    }
}
