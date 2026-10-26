package dev.harbor.app;

import android.content.Intent;
import android.graphics.drawable.GradientDrawable;
import android.text.Editable;
import android.text.TextWatcher;
import android.util.TypedValue;
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
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** One hub's chats the way the reference's drawer shows them: a bold title and search, a few
 *  nav rows (Projects, Pull requests, Issues, PCs, Settings, and Update when there is one), a
 *  thin line, then the chats by project as the desktop's sidebar orders them (a foldable header
 *  each, thin lines between), Threads and a folded Settled: one-line rows with a chat icon and a
 *  dot while a turn runs. A round avatar (this PC) and the black "New session" pill float at
 *  the bottom.
 *  Used full screen (Chats) and as the drawer inside a chat or a GitHub list. */
final class Sidebar {
    final Base a;
    final FrameLayout view;
    private final LinearLayout list;
    private final EditText search;
    private final TextView avatar;
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
        head.setPadding(Ui.dp(20), Ui.dp(14), Ui.dp(8), Ui.dp(4));
        head.addView(Ui.heading(a, "Harbor", 26), Ui.weight());
        TextView find = Ui.iconButton(a, Ui.I_SEARCH, Ui.FG, v -> toggleSearch());
        find.setTextSize(TypedValue.COMPLEX_UNIT_DIP, 20);
        find.setContentDescription("Search chats");
        head.addView(find);
        col.addView(head, Ui.fill());

        search = Ui.input(a, "Search chats", false);
        search.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        search.setPadding(Ui.dp(12), Ui.dp(9), Ui.dp(12), Ui.dp(9));
        search.setVisibility(View.GONE);
        search.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int st, int c, int af) { }
            @Override public void onTextChanged(CharSequence s, int st, int b, int c) { }
            @Override public void afterTextChanged(Editable e) { if (Sidebar.this.st != null) render(Sidebar.this.st); }
        });
        col.addView(search, Ui.margins(Ui.fill(), 16, 4, 16, 6));

        ScrollView sv = new ScrollView(a);
        list = Ui.col(a);
        list.setPadding(0, 0, 0, Ui.dp(88));
        sv.addView(list);
        col.addView(sv, new LinearLayout.LayoutParams(-1, 0, 1));
        view.addView(col, new FrameLayout.LayoutParams(-1, -1));

        // The last rows fade out under the floating buttons.
        View fade = new View(a);
        fade.setBackground(new GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, new int[]{Ui.BG, Ui.BG, Ui.BG & 0x00ffffff}));
        view.addView(fade, new FrameLayout.LayoutParams(-1, Ui.dp(84), Gravity.BOTTOM));

        // Bottom: avatar (this PC → Settings) and New session.
        avatar = Ui.bold(a, "", 16, 0xffffffff);
        avatar.setGravity(Gravity.CENTER);
        avatar.setBackground(Ui.press(0xff7a6ad8, 0, 20));
        avatar.setOnClickListener(v -> settings());
        FrameLayout.LayoutParams ap = new FrameLayout.LayoutParams(Ui.dp(40), Ui.dp(40), Gravity.BOTTOM | Gravity.START);
        ap.setMargins(Ui.dp(16), 0, 0, Ui.dp(18));
        view.addView(avatar, ap);
        TextView fab = Ui.bold(a, "+  New session", 15, Ui.ON_INK);
        fab.setGravity(Gravity.CENTER);
        fab.setPadding(Ui.dp(18), 0, Ui.dp(20), 0);
        fab.setBackground(Ui.press(Ui.INK, 0, 22));
        fab.setElevation(Ui.dp(3));
        fab.setOnClickListener(v -> newChat());
        FrameLayout.LayoutParams fp = new FrameLayout.LayoutParams(-2, Ui.dp(44), Gravity.BOTTOM | Gravity.END);
        fp.setMargins(0, 0, Ui.dp(16), Ui.dp(16));
        view.addView(fab, fp);
        label();
    }

    void label() {
        String l = a.hub.label();
        avatar.setText(l.isEmpty() ? "?" : l.substring(0, 1).toUpperCase());
        avatar.setContentDescription(l + " settings");
    }

    private void toggleSearch() {
        boolean on = search.getVisibility() != View.VISIBLE;
        search.setVisibility(on ? View.VISIBLE : View.GONE);
        if (on) search.requestFocus(); else search.setText("");
    }

    private void settings() { a.startActivity(new Intent(a, Settings.class).putExtra("hub", a.hub.id)); }

    /** The PC's pull requests or issues (GhList); from inside a list, the other one replaces it. */
    private void github(String kind) {
        if (a instanceof GhList && kind.equals(((GhList) a).kind)) { a.closeDrawer(); return; }
        a.startActivity(new Intent(a, GhList.class).putExtra("hub", a.hub.id).putExtra("kind", kind));
        if (a instanceof GhList) a.finish(); else a.closeDrawer();
    }

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
        list.removeAllViews();

        Map<String, String> projects = new LinkedHashMap<>(); // in the desktop sidebar's order
        JSONArray pa = st.optJSONArray("projects");
        if (pa != null) for (int i = 0; i < pa.length(); i++) {
            JSONObject p = pa.optJSONObject(i);
            if (p != null) projects.put(p.optString("id"), p.optString("name"));
        }
        if (!filter.isEmpty() && !projects.containsKey(filter)) filter = "";

        list.addView(nav(Ui.I_LAYERS, "Projects", filter.isEmpty() ? null : projects.get(filter), Ui.FG, v -> pickProject(projects)), Ui.inset());
        list.addView(nav(Ui.I_PR_OPEN, "Pull requests", null, Ui.FG, v -> github(GhList.PRS)), Ui.inset());
        list.addView(nav(Ui.I_CIRCLE_DOT, "Issues", null, Ui.FG, v -> github(GhList.ISSUES)), Ui.inset());
        // Which PC answers: worth a word with several paired, or when another of the mesh does.
        String via = a.hub.viaName();
        String pc = !via.isEmpty() ? a.hub.label() + " · via " + via : Hub.all(a).size() > 1 ? a.hub.label() : null;
        list.addView(nav(Ui.I_MONITOR, "PCs", pc, Ui.FG, v -> pcs()), Ui.inset());
        list.addView(nav(Ui.I_SETTINGS, "Settings", null, Ui.FG, v -> settings()), Ui.inset());
        JSONObject app = st.optJSONObject("app");
        long offered = Math.max(app == null ? 0 : app.optLong("version_code"), Update.bestCode);
        if (offered > Settings.myCode(a)) list.addView(nav(Ui.I_DOWNLOAD, "Update available", null, Ui.BLUE, v -> settings()), Ui.inset());
        View line = new View(a);
        line.setBackgroundColor(Ui.LINE);
        list.addView(line, Ui.margins(new LinearLayout.LayoutParams(-1, Ui.dp(1)), 20, 8, 20, 2));

        String q = search.getText().toString().trim().toLowerCase();
        String you = st.optString("you", "");
        List<JSONObject> chats = new ArrayList<>();
        JSONArray ca = st.optJSONArray("chats");
        if (ca != null) for (int i = 0; i < ca.length(); i++) {
            JSONObject c = ca.optJSONObject(i);
            if (c == null || "sub".equals(c.optString("role"))) continue; // a lead's subagents live inside its chat, as on the desktop
            String pid = c.isNull("project_id") ? "" : c.optString("project_id");
            if (!filter.isEmpty() && !filter.equals(pid)) continue;
            if (!q.isEmpty() && !c.optString("title").toLowerCase().contains(q) && !projects.getOrDefault(pid, "").toLowerCase().contains(q)) continue;
            chats.add(c);
        }
        if (chats.isEmpty()) {
            TextView t = Ui.text(a, q.isEmpty() ? "No chats yet. Start one with New session." : "No chat matches “" + q + "”.", 14, Ui.G700);
            t.setPadding(Ui.dp(20), Ui.dp(16), Ui.dp(20), Ui.dp(16));
            list.addView(t, Ui.fill());
            return;
        }
        chats.sort((x, y) -> Long.compare(y.optLong("updated_ms"), x.optLong("updated_ms")));
        // By project, in the desktop sidebar's order (the hub sends them so), newest first in
        // each; chats without a project under Threads, as on the desktop; settled chats fold
        // into Settled at the end. Projects never settle (an older hub's project `settled` is
        // ignored).
        LinkedHashMap<String, List<JSONObject>> groups = new LinkedHashMap<>();
        if (pa != null) for (int i = 0; i < pa.length(); i++) {
            JSONObject p = pa.optJSONObject(i);
            if (p != null) groups.put(p.optString("id"), new ArrayList<>());
        }
        List<JSONObject> loose = new ArrayList<>(), settled = new ArrayList<>();
        for (JSONObject c : chats) {
            String pid = c.isNull("project_id") ? "" : c.optString("project_id");
            if (c.optBoolean("settled")) settled.add(c);
            else if (groups.containsKey(pid)) groups.get(pid).add(c);
            else loose.add(c);
        }
        boolean first = true;
        for (Map.Entry<String, List<JSONObject>> g : groups.entrySet()) {
            if (g.getValue().isEmpty()) continue;
            if (!first) divider();
            first = false;
            group(g.getKey(), projects.get(g.getKey()), g.getValue(), you, q.isEmpty());
        }
        if (!loose.isEmpty()) {
            if (!first) divider();
            first = false;
            group("", "Threads", loose, you, q.isEmpty());
        }
        if (!settled.isEmpty()) {
            if (!first) divider();
            TextView h = Ui.label(a, "Settled · " + settled.size() + (showSettled ? "  ▾" : "  ▸"));
            h.setBackground(Ui.press(0, 0, 0));
            h.setOnClickListener(v -> { showSettled = !showSettled; render(st); });
            list.addView(h, Ui.fill());
            if (showSettled) for (JSONObject c : settled) list.addView(chatRow(c, you), Ui.inset());
        }
    }

    private void divider() {
        View line = new View(a);
        line.setBackgroundColor(Ui.LINE);
        list.addView(line, Ui.margins(new LinearLayout.LayoutParams(-1, Ui.dp(1)), 20, 6, 20, 2));
    }

    /** Projects folded on this phone, per PC ("" is Threads). */
    private Set<String> folded() { return new HashSet<>(Ui.prefs(a).getStringSet("folded-" + a.hub.id, new HashSet<>())); }

    /** A project's header (folder, name, count, chevron) and its chats. A tap folds it; a folded
     *  project with a chat at work keeps a dot on its header. Searching shows every match. */
    private void group(String key, String name, List<JSONObject> cs, String you, boolean foldable) {
        Set<String> f = folded();
        boolean fold = foldable && f.contains(key);
        LinearLayout h = Ui.row(a);
        h.setPadding(Ui.dp(12), Ui.dp(10), Ui.dp(12), Ui.dp(6));
        h.setBackground(Ui.press(0, 0, 10));
        h.addView(Ui.icon(a, key.isEmpty() ? Ui.I_CHAT : Ui.I_FOLDER, 14, Ui.G600), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(16), Ui.dp(16)), 2, 0, 8, 0));
        h.addView(Ui.subtitle(Ui.text(a, name == null || name.isEmpty() ? "Project" : name, 13, Ui.G700)), new LinearLayout.LayoutParams(0, -2, 1));
        boolean busy = false;
        for (JSONObject c : cs) busy |= c.optBoolean("running") || Hub.queued(c) > 0;
        if (fold && busy) h.addView(Ui.dot(a, Ui.BLUE, 7), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(7), Ui.dp(7)), 8, 0, 0, 0));
        h.addView(Ui.text(a, String.valueOf(cs.size()), 12, Ui.G600), Ui.margins(Ui.wrap(), 8, 0, 0, 0));
        h.addView(Ui.icon(a, fold ? Ui.I_RIGHT : Ui.I_DOWN, 13, Ui.G600), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(16), Ui.dp(16)), 6, 0, 0, 0));
        h.setContentDescription((name == null ? "Project" : name) + ", " + cs.size() + (fold ? " chats, folded" : " chats"));
        if (foldable) h.setOnClickListener(v -> {
            if (!f.remove(key)) f.add(key);
            Ui.prefs(a).edit().putStringSet("folded-" + a.hub.id, f).apply();
            render(st);
        });
        list.addView(h, Ui.inset());
        if (!fold) for (JSONObject c : cs) list.addView(chatRow(c, you), Ui.inset());
    }

    private View nav(String glyph, String title, String value, int color, View.OnClickListener on) {
        LinearLayout r = Ui.listRow(a, glyph, color, title, color);
        r.setMinimumHeight(Ui.dp(44));
        r.setBackground(Ui.press(0, 0, 12));
        if (value != null) {
            TextView s = Ui.subtitle(Ui.text(a, value, 13, Ui.G600));
            s.setMaxWidth(Ui.dp(170));
            r.addView(s, Ui.margins(Ui.wrap(), 10, 0, 0, 0));
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

    private View chatRow(JSONObject c, String you) {
        String id = c.optString("id");
        String title = c.optString("title");
        boolean settled = c.optBoolean("settled");
        LinearLayout r = Ui.listRow(a, Ui.I_CHAT, Ui.G700, title.isEmpty() ? "New chat" : title, settled ? Ui.G700 : Ui.FG);
        r.setBackground(id.equals(current) ? Ui.press(Ui.G100, 0, 12) : Ui.press(0, 0, 12));
        boolean typing = typing(c, you) != null;
        int q = Hub.queued(c);
        if (typing) {
            r.addView(Ui.text(a, "typing…", 12, Ui.BLUE), Ui.margins(Ui.wrap(), 8, 0, 0, 0));
        } else if (c.optBoolean("running") || q > 0) {
            r.addView(Ui.dot(a, c.optBoolean("running") ? Ui.BLUE : Ui.AMBER, 8), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(8), Ui.dp(8)), 10, 0, 2, 0));
        }
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
        for (Hub h : Hub.all(a)) {
            String more = h.eps.isEmpty() ? "" : " · and " + h.eps.size() + (h.eps.size() == 1 ? " more PC" : " more PCs");
            o.add(new Sheet.Option(h.id, h.label(), h.host + ":" + h.port + more, true));
        }
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
