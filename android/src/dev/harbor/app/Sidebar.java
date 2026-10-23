package dev.harbor.app;

import android.content.Intent;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** One hub's chats the way the reference's drawer shows them: the wordmark and search, nav
 *  rows (Projects, PCs, Settings), then Running / Recents / Settled with a chat icon, a blue
 *  dot while a turn runs, who's typing; a round avatar (this PC) and the black "New session"
 *  pill at the bottom. Used full screen (Chats) and as the drawer inside a chat. */
final class Sidebar {
    final Base a;
    final FrameLayout view;
    private final LinearLayout list;
    private final EditText search;
    private final TextView avatar, update;
    private final String current; // the open chat (highlighted), or null
    private JSONObject st;
    private boolean showSettled;
    private String filter; // project id, "" = all

    Sidebar(Base a, String current) {
        this.a = a;
        this.current = current;
        filter = Ui.prefs(a).getString("filter-" + a.hub.id, "");
        view = new FrameLayout(a);
        view.setBackgroundColor(Ui.BG);
        LinearLayout col = Ui.col(a);

        LinearLayout head = Ui.row(a);
        head.setPadding(Ui.dp(24), Ui.dp(20), Ui.dp(12), Ui.dp(8));
        head.addView(Ui.title(a, "Harbor", 36), Ui.weight());
        update = Ui.bold(a, "Update", 14, Ui.ON_INK);
        update.setPadding(Ui.dp(14), Ui.dp(7), Ui.dp(14), Ui.dp(7));
        update.setBackground(Ui.press(Ui.INK, 0, 16));
        update.setVisibility(View.GONE);
        update.setOnClickListener(v -> settings());
        head.addView(update, Ui.margins(Ui.wrap(), 0, 0, 6, 0));
        head.addView(Ui.iconButton(a, Ui.I_SEARCH, Ui.FG, v -> toggleSearch()));
        col.addView(head, Ui.fill());

        search = Ui.input(a, "Search chats", false);
        search.setVisibility(View.GONE);
        search.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int st, int c, int af) { }
            @Override public void onTextChanged(CharSequence s, int st, int b, int c) { }
            @Override public void afterTextChanged(Editable e) { if (Sidebar.this.st != null) render(Sidebar.this.st); }
        });
        col.addView(search, Ui.margins(Ui.fill(), 20, 4, 20, 8));

        ScrollView sv = new ScrollView(a);
        list = Ui.col(a);
        list.setPadding(0, 0, 0, Ui.dp(110));
        sv.addView(list);
        col.addView(sv, new LinearLayout.LayoutParams(-1, 0, 1));
        view.addView(col, new FrameLayout.LayoutParams(-1, -1));

        // Bottom: avatar (this PC → Settings) and New session.
        avatar = Ui.bold(a, "", 20, 0xffffffff);
        avatar.setGravity(Gravity.CENTER);
        avatar.setBackground(Ui.press(0xff7a6ad8, 0, 28));
        avatar.setOnClickListener(v -> settings());
        FrameLayout.LayoutParams ap = new FrameLayout.LayoutParams(Ui.dp(56), Ui.dp(56), Gravity.BOTTOM | Gravity.START);
        ap.setMargins(Ui.dp(20), 0, 0, Ui.dp(20));
        view.addView(avatar, ap);
        TextView fab = Ui.bold(a, "+  New session", 18, Ui.ON_INK);
        fab.setGravity(Gravity.CENTER);
        fab.setPadding(Ui.dp(26), 0, Ui.dp(26), 0);
        fab.setBackground(Ui.press(Ui.INK, 0, 28));
        fab.setElevation(Ui.dp(4));
        fab.setOnClickListener(v -> newChat());
        FrameLayout.LayoutParams fp = new FrameLayout.LayoutParams(-2, Ui.dp(56), Gravity.BOTTOM | Gravity.END);
        fp.setMargins(0, 0, Ui.dp(20), Ui.dp(20));
        view.addView(fab, fp);
        label();
    }

    void label() {
        String l = a.hub.label();
        avatar.setText(l.isEmpty() ? "?" : l.substring(0, 1).toUpperCase());
    }

    private void toggleSearch() {
        boolean on = search.getVisibility() != View.VISIBLE;
        search.setVisibility(on ? View.VISIBLE : View.GONE);
        if (on) search.requestFocus(); else search.setText("");
    }

    private void settings() { a.startActivity(new Intent(a, Settings.class).putExtra("hub", a.hub.id)); }

    private void newChat() {
        a.startActivity(new Intent(a, NewChat.class).putExtra("hub", a.hub.id));
        if (current != null) a.closeDrawer();
    }

    private void open(String id) {
        if (id.equals(current)) { a.closeDrawer(); return; }
        Chat.open(a, a.hub, id);
        if (a instanceof Chat || a instanceof NewChat) a.finish(); // one chat screen at a time: back goes to the list
        else a.closeDrawer();
    }

    // ---- the list ----

    void render(JSONObject st) {
        this.st = st;
        JSONObject app = st.optJSONObject("app");
        update.setVisibility(app != null && app.optLong("version_code") > Settings.myCode(a) ? View.VISIBLE : View.GONE);
        list.removeAllViews();

        Map<String, String> projects = new HashMap<>();
        JSONArray pa = st.optJSONArray("projects");
        if (pa != null) for (int i = 0; i < pa.length(); i++) {
            JSONObject p = pa.optJSONObject(i);
            if (p != null) projects.put(p.optString("id"), p.optString("name"));
        }
        if (!filter.isEmpty() && !projects.containsKey(filter)) filter = "";

        list.addView(nav(Ui.I_LAYERS, "Projects", filter.isEmpty() ? "All projects" : projects.get(filter), v -> pickProject(projects)));
        list.addView(nav(Ui.I_MONITOR, "PCs", a.hub.label(), v -> pcs()));
        list.addView(nav(Ui.I_SETTINGS, "Settings", null, v -> settings()));
        View line = new View(a);
        line.setBackgroundColor(Ui.LINE);
        list.addView(line, Ui.margins(new LinearLayout.LayoutParams(-1, Ui.dp(1)), 20, 10, 20, 4));

        String q = search.getText().toString().trim().toLowerCase();
        String you = st.optString("you", "");
        List<JSONObject> chats = new ArrayList<>();
        JSONArray ca = st.optJSONArray("chats");
        if (ca != null) for (int i = 0; i < ca.length(); i++) {
            JSONObject c = ca.optJSONObject(i);
            if (c == null || "sub".equals(c.optString("role"))) continue; // a lead's subagents live inside its chat, as on the desktop
            String pid = c.isNull("project_id") ? "" : c.optString("project_id");
            if (!filter.isEmpty() && !filter.equals(pid)) continue;
            if (!q.isEmpty() && !c.optString("title").toLowerCase().contains(q)) continue;
            chats.add(c);
        }
        chats.sort((x, y) -> Long.compare(y.optLong("updated_ms"), x.optLong("updated_ms")));
        List<JSONObject> running = new ArrayList<>(), recent = new ArrayList<>(), settled = new ArrayList<>();
        for (JSONObject c : chats) {
            if (c.optBoolean("settled")) settled.add(c);
            else if (c.optBoolean("running") || Hub.queued(c) > 0 || typing(c, you) != null) running.add(c);
            else recent.add(c);
        }
        if (chats.isEmpty()) {
            a.hintInto(list, q.isEmpty() ? "No chats yet. Start one with New session." : "No chat matches “" + q + "”.");
            return;
        }
        if (!running.isEmpty()) {
            list.addView(Ui.section(a, "Running"));
            for (JSONObject c : running) list.addView(chatRow(c, projects, you));
        }
        if (!recent.isEmpty()) {
            list.addView(Ui.section(a, "Recents"));
            for (JSONObject c : recent) list.addView(chatRow(c, projects, you));
        }
        if (!settled.isEmpty()) {
            TextView h = Ui.section(a, "Settled · " + settled.size() + (showSettled ? "  ▾" : "  ▸"));
            h.setBackground(Ui.press(0, 0, 0));
            h.setOnClickListener(v -> { showSettled = !showSettled; render(st); });
            list.addView(h, Ui.fill());
            if (showSettled) for (JSONObject c : settled) list.addView(chatRow(c, projects, you));
        }
    }

    private View nav(String glyph, String title, String sub, View.OnClickListener on) {
        LinearLayout r = Ui.row(a);
        r.setPadding(Ui.dp(24), Ui.dp(14), Ui.dp(20), Ui.dp(14));
        r.setBackground(Ui.press(0, 0, 0));
        r.addView(Ui.icon(a, glyph, 24, Ui.FG), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(28), Ui.dp(28)), 0, 0, 20, 0));
        r.addView(Ui.text(a, title, 19, Ui.FG), Ui.wrap());
        if (sub != null) {
            TextView s = Ui.subtitle(Ui.text(a, sub, 15, Ui.G700));
            s.setGravity(Gravity.END);
            r.addView(s, Ui.margins(Ui.weight(), 12, 0, 0, 0));
        }
        r.setOnClickListener(on);
        return r;
    }

    /** Who else is typing in c (a chat, or an items reply): "Desk is typing…", or null. */
    static String typing(JSONObject c, String you) {
        JSONArray t = c.optJSONArray("typing");
        if (t == null) return null;
        for (int i = 0; i < t.length(); i++) {
            JSONObject o = t.optJSONObject(i);
            if (o == null || you.equals(o.optString("device"))) continue;
            String l = o.optString("label", "");
            return (l.isEmpty() ? ("pc".equals(o.optString("kind")) ? "A PC" : "A phone") : l) + " is typing…";
        }
        return null;
    }

    private View chatRow(JSONObject c, Map<String, String> projects, String you) {
        String id = c.optString("id");
        LinearLayout r = Ui.row(a);
        r.setPadding(Ui.dp(24), Ui.dp(10), Ui.dp(20), Ui.dp(10));
        r.setBackground(id.equals(current) ? Ui.round(Ui.G100, 0, 0) : Ui.press(0, 0, 0));
        boolean lead = "lead".equals(c.optString("role"));
        r.addView(Ui.icon(a, lead ? Ui.I_TERMINAL : Ui.I_CHAT, 20, Ui.G700), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(28), Ui.dp(28)), 0, 0, 20, 0));
        LinearLayout t = Ui.col(a);
        String title = c.optString("title");
        t.addView(Ui.subtitle(Ui.text(a, title.isEmpty() ? "New chat" : title, 18, c.optBoolean("settled") ? Ui.G700 : Ui.FG)));
        String typing = typing(c, you);
        String pid = c.isNull("project_id") ? "" : c.optString("project_id");
        int q = Hub.queued(c);
        String sub = typing != null ? typing
                : (pid.isEmpty() ? "" : projects.getOrDefault(pid, "") + " · ") + Ui.ago(c.optLong("updated_ms"))
                + (q > 0 ? " · " + q + " waiting" : "");
        t.addView(Ui.subtitle(Ui.text(a, sub, 14, typing != null ? Ui.BLUE : Ui.G700)));
        r.addView(t, Ui.weight());
        if (c.optBoolean("running") || q > 0)
            r.addView(Ui.dot(a, c.optBoolean("running") ? Ui.BLUE : Ui.AMBER, 10), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(10), Ui.dp(10)), 12, 0, 0, 0));
        r.setOnClickListener(v -> open(id));
        r.setOnLongClickListener(v -> { Chats.menu(a, a.hub, c, a::refresh, a::refresh); return true; });
        return r;
    }

    private void pickProject(Map<String, String> projects) {
        List<Sheet.Option> o = new ArrayList<>();
        o.add(new Sheet.Option("", "All projects", "", true));
        for (Map.Entry<String, String> p : projects.entrySet()) o.add(new Sheet.Option(p.getKey(), p.getValue(), "", true));
        Sheet.pick(a, "Projects", null, o, filter, id -> {
            filter = id;
            Ui.prefs(a).edit().putString("filter-" + a.hub.id, id).apply();
            if (st != null) render(st);
        });
    }

    /** Paired PCs: switch to another, or pair one more. */
    private void pcs() {
        List<Sheet.Option> o = new ArrayList<>();
        for (Hub h : Hub.all(a)) o.add(new Sheet.Option(h.id, h.label(), h.host + ":" + h.port, true));
        o.add(new Sheet.Option("+", "Pair another PC", "scan its code in Settings › Phones", true));
        Sheet.pick(a, "PCs", null, o, a.hub.id, id -> {
            if ("+".equals(id)) { a.startActivity(new Intent(a, Hubs.class).putExtra("pair", true)); return; }
            if (id.equals(a.hub.id)) return;
            Hub.setLast(a, id);
            a.startActivity(new Intent(a, Chats.class).putExtra("hub", id).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP));
            a.finish();
        });
    }
}
