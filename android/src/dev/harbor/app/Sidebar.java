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
import android.widget.ImageView;
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
        // Search everything (the desktop's Ctrl+K palette); a long press filters this list instead.
        TextView find = Ui.iconButton(a, Ui.I_SEARCH, Ui.FG, v -> palette());
        find.setOnLongClickListener(v -> { toggleSearch(); return true; });
        find.setTextSize(TypedValue.COMPLEX_UNIT_DIP, 20);
        find.setContentDescription("Search everything");
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

    private void palette() {
        Intent i = new Intent(a, Palette.class).putExtra("hub", a.hub.id);
        if (current != null) i.putExtra("chat", current);
        a.startActivity(i);
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

        if (offTitle != null) {
            TextView icon = Ui.icon(a, Ui.I_MONITOR, 18, Ui.RED);
            icon.setBackground(Ui.round(Ui.G100, 0, 10));
            list.addView(banner(icon, offTitle, offBody, "Try again", true, offRetry, null, null, null), Ui.inset());
        }
        // Their Update buttons need the PC: not while it doesn't answer.
        if (offTitle == null) banners(st);
        list.addView(nav(Ui.I_LAYERS, "Projects", filter.isEmpty() ? null : projects.get(filter), Ui.FG, v -> pickProject(projects)), Ui.inset());
        list.addView(nav(Ui.I_PR_OPEN, "Pull requests", null, Ui.FG, v -> github(GhList.PRS)), Ui.inset());
        list.addView(nav(Ui.I_CIRCLE_DOT, "Issues", null, Ui.FG, v -> github(GhList.ISSUES)), Ui.inset());
        if (Engine.available(a)) list.addView(nav(Ui.I_GLOBE, "Browser", null, Ui.FG, v -> Browser.open(a, "")), Ui.inset());
        // Which PC answers: worth a word with several paired, or when another of the mesh does.
        String via = a.hub.viaName();
        String pc = !via.isEmpty() ? a.hub.label() + " · via " + via : Hub.all(a).size() > 1 ? a.hub.label() : null;
        list.addView(nav(Ui.I_MONITOR, "PCs", pc, Ui.FG, v -> pcs()), Ui.inset());
        // The PC answering runs an older Harbor than this app (often a relay while the phone's
        // own PC is out of reach): newer things won't show until it's updated.
        String older = olderPc(st);
        if (older != null) {
            TextView o = Ui.text(a, older, 12, Ui.AMBER);
            o.setPadding(Ui.dp(52), 0, Ui.dp(20), Ui.dp(6));
            list.addView(o, Ui.fill());
        }
        list.addView(nav(Ui.I_SETTINGS, "Settings", null, Ui.FG, v -> settings()), Ui.inset());
        JSONObject app = st.optJSONObject("app");
        long offered = Math.max(app == null ? 0 : app.optLong("version_code"), Update.bestCode);
        // Updating automatically it installs by itself while the phone sleeps: nothing to tap.
        if (offered > Settings.myCode(a) && !Update.silent(a, offered)) list.addView(nav(Ui.I_DOWNLOAD, "Update available", null, Ui.BLUE, v -> settings()), Ui.inset());
        View line = new View(a);
        line.setBackgroundColor(Ui.LINE);
        list.addView(line, Ui.margins(new LinearLayout.LayoutParams(-1, Ui.dp(1)), 20, 8, 20, 2));

        String q = search.getText().toString().trim().toLowerCase();
        String you = st.optString("you", "");
        // The chats that pass the project filter and the search, by id.
        Map<String, JSONObject> byId = new LinkedHashMap<>();
        JSONArray ca = st.optJSONArray("chats");
        if (ca != null) for (int i = 0; i < ca.length(); i++) {
            JSONObject c = ca.optJSONObject(i);
            if (c == null || "sub".equals(c.optString("role"))) continue; // a lead's subagents live inside its chat, as on the desktop
            String pid = c.isNull("project_id") ? "" : c.optString("project_id");
            if (!filter.isEmpty() && !filter.equals(pid)) continue;
            if (!q.isEmpty() && !c.optString("title").toLowerCase().contains(q) && !projects.getOrDefault(pid, "").toLowerCase().contains(q)) continue;
            byId.put(c.optString("id"), c);
        }
        if (byId.isEmpty()) {
            TextView t = Ui.text(a, q.isEmpty() ? "No chats yet. Start one with New session." : "No chat matches “" + q + "”.", 14, Ui.G700);
            t.setPadding(Ui.dp(20), Ui.dp(16), Ui.dp(20), Ui.dp(16));
            list.addView(t, Ui.fill());
            return;
        }
        // By project, in the desktop sidebar's order, newest first in each; chats without a
        // project under Threads; settled chats fold into Settled at the end. Projects never
        // settle (an older hub's project `settled` is ignored).
        LinkedHashMap<String, List<JSONObject>> groups = new LinkedHashMap<>();
        List<JSONObject> loose = new ArrayList<>(), settled = new ArrayList<>();
        JSONObject tree = st.optJSONObject("tree");
        // Hubs 0.55.2 to 0.64.0 send it with their own ids though the chats come by gid: none
        // match, so it's grouped here instead.
        if (tree != null && !placesAny(tree, byId)) tree = null;
        if (tree != null) {
            // The desktop sidebar's own placement (newer hubs): the same chats in the same
            // places, snoozed ones left out as there.
            JSONArray tp = tree.optJSONArray("projects");
            if (tp != null) for (int i = 0; i < tp.length(); i++) {
                JSONObject p = tp.optJSONObject(i);
                if (p == null || (p.optBoolean("snoozed") && q.isEmpty())) continue;
                groups.put(p.optString("id"), pick(byId, p.optJSONArray("chats")));
            }
            loose = pick(byId, tree.optJSONArray("threads"));
            settled = pick(byId, tree.optJSONArray("settled"));
            // Snoozed chats (0.78): out of the list until they wake; a search shows them back in
            // their places, as the desktop's does.
            if (!q.isEmpty()) for (JSONObject c : pick(byId, tree.optJSONArray("snoozed"))) {
                List<JSONObject> g = groups.get(c.isNull("project_id") ? "" : c.optString("project_id"));
                (g != null ? g : loose).add(c);
            }
        } else {
            List<JSONObject> chats = new ArrayList<>(byId.values());
            chats.sort((x, y) -> Long.compare(y.optLong("updated_ms"), x.optLong("updated_ms")));
            if (pa != null) for (int i = 0; i < pa.length(); i++) {
                JSONObject p = pa.optJSONObject(i);
                if (p != null) groups.put(p.optString("id"), new ArrayList<>());
            }
            for (JSONObject c : chats) {
                String pid = c.isNull("project_id") ? "" : c.optString("project_id");
                if (c.optBoolean("settled")) settled.add(c);
                else if (groups.containsKey(pid)) groups.get(pid).add(c);
                else loose.add(c);
            }
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

    // ---- the two update banners (the desktop's pop-ups, src/notices.rs), never merged ----

    /** "Harbor X.Y.Z is available" (the hub's own update: blue sparkles, Update / What's new)
     *  and apart from it "Updates available: N providers" (the hub's CLIs: their logos, Update /
     *  Details). Closing one remembers its version(s) on this phone; the next ones show again. */
    private void banners(JSONObject st) {
        android.content.SharedPreferences pr = Ui.prefs(a);
        JSONObject hu = st.optJSONObject("hub_update");
        String v = hu == null ? "" : hu.optString("version");
        // An Update asked before the PC knew of the release: it checks first (hubs from 0.51).
        if (hu != null && hu.optBoolean("checking")) {
            TextView icon = Ui.icon(a, Ui.I_SPARKLES, 18, Ui.BLUE);
            icon.setBackground(Ui.round(Ui.G100, 0, 10));
            list.addView(banner(icon, "Looking for the newest Harbor…", a.hub.label() + " installs it when found and reloads; running agents keep going.",
                    "Updating…", false, () -> { }, null, null, null), Ui.inset());
        }
        if (!v.isEmpty() && !v.equals(pr.getString("upd-hub-" + a.hub.id, ""))) {
            boolean busy = hu.optBoolean("installing");
            TextView icon = Ui.icon(a, Ui.I_SPARKLES, 18, Ui.BLUE);
            icon.setBackground(Ui.round(Ui.G100, 0, 10));
            String notes = hu.optString("notes_url");
            list.addView(banner(icon,
                    busy ? "Updating Harbor to " + v + "…" : "Harbor " + v + " is available",
                    busy ? a.hub.label() + " reloads when it's ready; running agents keep going."
                         : a.hub.label() + " runs " + hu.optString("current") + ". Update installs it there; this app follows.",
                    busy ? "Updating…" : "Update", !busy,
                    () -> Ui.bg(a, () -> a.hub.call("POST", "/v1/hub/update", new JSONObject()), r -> Ui.toast(a, "Updating Harbor on " + a.hub.label() + "…")),
                    notes.isEmpty() ? null : "What's new",
                    () -> { try { a.startActivity(new Intent(Intent.ACTION_VIEW, android.net.Uri.parse(notes))); } catch (Exception e) { Ui.copy(a, notes); } },
                    () -> { pr.edit().putString("upd-hub-" + a.hub.id, v).apply(); render(this.st); }), Ui.inset());
        }
        // "Is this you?": the hub's detected owner, until confirmed (hubs from 0.47, src/profile.rs).
        JSONObject pc = st.optJSONObject("profile_check");
        String pk = pc == null ? "" : pc.optString("key");
        if (!pk.isEmpty() && !pk.equals(pr.getString("prof-" + a.hub.id, ""))) {
            TextView icon = Ui.icon(a, Ui.I_USERS, 18, Ui.G700);
            icon.setBackground(Ui.round(Ui.G100, 0, 10));
            list.addView(banner(icon, pc.optString("title"), a.hub.label() + ": " + pc.optString("body"), "Confirm", true,
                    () -> Ui.bg(a, () -> {
                        JSONObject b = new JSONObject();
                        b.put("op", "confirm");
                        return a.hub.call("PATCH", "/v1/people", b);
                    }, r -> { pr.edit().putString("prof-" + a.hub.id, pk).apply(); render(this.st); }),
                    "Review",
                    () -> { pr.edit().putString("prof-" + a.hub.id, pk).apply(); a.startActivity(new Intent(a, Settings.class).putExtra("hub", a.hub.id).putExtra("people", true)); },
                    () -> { pr.edit().putString("prof-" + a.hub.id, pk).apply(); render(this.st); }), Ui.inset());
        }
        JSONObject pu = st.optJSONObject("provider_updates");
        if (pu == null) return;
        JSONArray items = pu.optJSONArray("items");
        int n = items == null ? 0 : items.length();
        String key = pu.optString("key");
        boolean updating = pu.optBoolean("updating");
        String error = pu.isNull("error") ? "" : pu.optString("error");
        boolean offered = n > 0 && !key.equals(pr.getString("upd-prov-" + a.hub.id, ""));
        if (!updating && error.isEmpty() && !offered) return;
        String names = pu.optString("names");
        String title, body, primary;
        if (updating) { title = "Updating providers…"; body = "Updating " + names + " on " + a.hub.label() + ". Chats keep running."; primary = "Updating…"; }
        else if (!error.isEmpty()) { title = "A provider update failed"; body = error; primary = n > 0 ? "Try again" : null; }
        else { title = "Updates available: " + n + " provider" + (n == 1 ? "" : "s"); body = names + " can be updated on " + a.hub.label() + "."; primary = "Update"; }
        // The providers' logos, overlapping a little (at most three).
        FrameLayout icon = new FrameLayout(a);
        icon.setBackground(Ui.round(Ui.G200, 0, 10));
        int shown = Math.min(n, 3);
        for (int i = 0; i < shown; i++) {
            android.graphics.Bitmap b = Ui.logo(a, items.optJSONObject(i).optString("logo"));
            if (b == null) continue;
            ImageView iv = new ImageView(a);
            iv.setImageBitmap(b);
            int size = shown == 1 ? 22 : 18;
            iv.setTranslationX(Ui.dp((i - (shown - 1) / 2f) * 7));
            icon.addView(iv, new FrameLayout.LayoutParams(Ui.dp(size), Ui.dp(size), Gravity.CENTER));
        }
        if (icon.getChildCount() == 0) icon.addView(Ui.icon(a, Ui.I_BOT, 18, Ui.G700), new FrameLayout.LayoutParams(-1, -1));
        StringBuilder details = new StringBuilder();
        for (int i = 0; i < n; i++) {
            JSONObject it = items.optJSONObject(i);
            details.append(it.optString("label")).append("  ").append(it.optString("current")).append(" → ").append(it.optString("latest")).append('\n');
        }
        list.addView(banner(icon, title, body, primary, !updating && n > 0,
                () -> Ui.bg(a, () -> a.hub.call("POST", "/v1/providers/update", new JSONObject()), r -> { }),
                n > 0 ? "Details" : null,
                () -> Ui.dialog(a).setTitle("Provider updates on " + a.hub.label()).setMessage(details.toString().trim()).setPositiveButton("OK", null).show(),
                () -> { pr.edit().putString("upd-prov-" + a.hub.id, key).apply(); render(this.st); }), Ui.inset());
    }

    /** One banner card: an icon tile, a title and a line, a black pill and a quiet text button,
     *  and a close X. `primary` or `secondary` null: no such button. */
    private View banner(View icon, String title, String body, String primary, boolean enabled, Runnable onPrimary, String secondary, Runnable onSecondary, Runnable onClose) {
        LinearLayout card = Ui.row(a);
        card.setGravity(Gravity.TOP);
        card.setBackground(Ui.round(Ui.CARD, Ui.LINE, 14));
        card.setPadding(Ui.dp(12), Ui.dp(12), Ui.dp(4), Ui.dp(12));
        card.addView(icon, Ui.margins(new LinearLayout.LayoutParams(Ui.dp(36), Ui.dp(36)), 0, 0, 12, 0));
        LinearLayout col = Ui.col(a);
        col.addView(Ui.bold(a, title, 15, Ui.FG));
        TextView t = Ui.text(a, body, 13, Ui.G700);
        col.addView(t, Ui.margins(Ui.fill(), 0, 2, 0, 8));
        LinearLayout btns = Ui.row(a);
        if (primary != null) {
            TextView p = Ui.bold(a, primary, 14, Ui.ON_INK);
            p.setGravity(Gravity.CENTER);
            p.setPadding(Ui.dp(16), Ui.dp(8), Ui.dp(16), Ui.dp(8));
            p.setBackground(Ui.press(enabled ? Ui.INK : Ui.G500, 0, 18));
            p.setEnabled(enabled);
            p.setOnClickListener(v -> onPrimary.run());
            btns.addView(p, Ui.margins(Ui.wrap(), 0, 0, 8, 0));
        }
        if (secondary != null) {
            TextView s2 = Ui.bold(a, secondary, 14, Ui.FG);
            s2.setPadding(Ui.dp(12), Ui.dp(8), Ui.dp(12), Ui.dp(8));
            s2.setBackground(Ui.press(0, 0, 18));
            s2.setOnClickListener(v -> onSecondary.run());
            btns.addView(s2, Ui.wrap());
        }
        if (btns.getChildCount() > 0) col.addView(btns);
        card.addView(col, Ui.weight());
        if (onClose != null) {
            TextView x = Ui.iconButton(a, Ui.I_X, Ui.G700, v -> onClose.run());
            x.setContentDescription("Dismiss");
            card.addView(x, new LinearLayout.LayoutParams(Ui.dp(36), Ui.dp(36)));
        } else {
            card.setPadding(Ui.dp(12), Ui.dp(12), Ui.dp(12), Ui.dp(12));
        }
        LinearLayout wrap = Ui.col(a);
        wrap.setPadding(0, Ui.dp(4), 0, Ui.dp(6));
        wrap.addView(card, Ui.fill());
        return wrap;
    }

    /** "<PC> runs Harbor 0.28.0, older than this app: update it there", or null. */
    private String olderPc(JSONObject st) {
        String v = st == null ? "" : st.optString("version", "");
        String[] p = v.split("[.\\- ]");
        if (p.length < 2) return null;
        try {
            long pc = Long.parseLong(p[0]) * 1_000_000 + Long.parseLong(p[1]) * 1_000;
            if (pc >= Hub.appCode() / 1_000 * 1_000) return null;
        } catch (NumberFormatException e) { return null; }
        String via = a.hub.viaName();
        String name = !via.isEmpty() ? via : st.optString("hub_name", a.hub.label());
        return name + " runs Harbor " + v.split(" ")[0] + ", older than this app: some things won't show until it's updated there.";
    }

    /** Busy as the desktop sidebar shows it: its own turn, or (a lead) its sub-agents'
     *  (`working`; older PCs only send `running`). */
    static boolean working(JSONObject c) {
        return c.optBoolean("working", c.optBoolean("running"));
    }

    // ---- the hub doesn't answer ----

    private String offTitle, offBody;
    private Runnable offRetry;

    /** Shows (title non-null) or clears the card saying the PC doesn't answer, over the last
     *  list it sent: Harbor not running there, or the PC offline, with when it last answered. */
    void offline(String title, String body, Runnable retry) {
        if (title == null && offTitle == null) return;
        // "Harbor isn't running on desk. Start it there…" under the title "Harbor isn't running on desk".
        if (title != null && body != null && body.startsWith(title)) body = body.substring(title.length()).replaceFirst("^[.:]?\\s*", "");
        offTitle = title; offBody = body; offRetry = retry;
        render(st != null ? st : new JSONObject());
    }

    private void divider() {
        View line = new View(a);
        line.setBackgroundColor(Ui.LINE);
        list.addView(line, Ui.margins(new LinearLayout.LayoutParams(-1, Ui.dp(1)), 20, 6, 20, 2));
    }

    /** The chats of `ids` (a `tree` list) that are in `byId`, in that order. */
    private static List<JSONObject> pick(Map<String, JSONObject> byId, JSONArray ids) {
        List<JSONObject> out = new ArrayList<>();
        if (ids != null) for (int i = 0; i < ids.length(); i++) {
            JSONObject c = byId.get(ids.optString(i));
            if (c != null) out.add(c);
        }
        return out;
    }

    /** Whether `tree` places any chat of `byId` (it names them as the chats do). */
    private static boolean placesAny(JSONObject tree, Map<String, JSONObject> byId) {
        List<JSONArray> lists = new ArrayList<>();
        JSONArray tp = tree.optJSONArray("projects");
        for (int i = 0; tp != null && i < tp.length(); i++) {
            JSONObject p = tp.optJSONObject(i);
            if (p != null) lists.add(p.optJSONArray("chats"));
        }
        lists.add(tree.optJSONArray("threads"));
        lists.add(tree.optJSONArray("settled"));
        for (JSONArray l : lists) if (!pick(byId, l).isEmpty()) return true;
        return false;
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
        for (JSONObject c : cs) busy |= working(c) || Hub.queued(c) > 0;
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
        r.setMinimumHeight(Ui.dp(Ui.compact ? 36 : 44));
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

    /** Who else is typing in c, for the composer's corner ("Desk, Galaxy A13"), or null. */
    static String typingWho(JSONObject c, String you) {
        JSONArray t = c.optJSONArray("typing");
        StringBuilder b = new StringBuilder();
        for (int i = 0; t != null && i < t.length(); i++) {
            JSONObject o = t.optJSONObject(i);
            if (o == null || you.equals(o.optString("device"))) continue;
            String l = o.optString("label", "");
            if (l.isEmpty()) l = "pc".equals(o.optString("kind")) ? "A PC" : "A phone";
            if (b.length() > 0) b.append(", ");
            b.append(l);
        }
        return b.length() == 0 ? null : b.toString();
    }

    private View chatRow(JSONObject c, String you) {
        String id = c.optString("id");
        String title = c.optString("title");
        boolean settled = c.optBoolean("settled");
        LinearLayout r = Ui.listRow(a, Ui.I_CHAT, Ui.G700, title.isEmpty() ? "New chat" : title, settled ? Ui.G700 : Ui.FG);
        r.setBackground(id.equals(current) ? Ui.press(Ui.G100, 0, 12) : Ui.press(0, 0, 12));
        // Runs in a worktree of its own (the desktop row's folder-git mark).
        JSONObject wt = c.optJSONObject("worktree");
        if (wt != null) {
            TextView m = Ui.icon(a, Ui.I_FOLDER_GIT, 14, wt.optBoolean("gone") ? Ui.RED : Ui.G700);
            m.setContentDescription("Worktree " + wt.optString("name"));
            r.addView(m, Ui.margins(new LinearLayout.LayoutParams(Ui.dp(18), Ui.dp(18)), 8, 0, 0, 0));
        }
        // Snoozed (shown while searching): when it wakes, as the desktop row says it.
        if (!c.isNull("snoozed_until_ms")) {
            r.addView(Ui.icon(a, Ui.I_CLOCK, 13, Ui.G600), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(16), Ui.dp(16)), 8, 0, 0, 0));
            r.addView(Ui.text(a, c.optString("snoozed_label"), 12, Ui.G600), Ui.margins(Ui.wrap(), 4, 0, 0, 0));
        }
        boolean typing = typing(c, you) != null;
        int q = Hub.queued(c);
        if (typing) {
            r.addView(Ui.text(a, "typing…", 12, Ui.BLUE), Ui.margins(Ui.wrap(), 8, 0, 0, 0));
        } else if (working(c)) {
            r.addView(Ui.icon(a, Ui.I_LOADER, 14, Ui.BLUE), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(18), Ui.dp(18)), 8, 0, 0, 0));
        } else if (q > 0) {
            r.addView(Ui.dot(a, Ui.AMBER, 8), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(8), Ui.dp(8)), 10, 0, 2, 0));
        } else if (c.optBoolean("failed")) {
            r.addView(Ui.icon(a, Ui.I_CIRCLE_X, 14, Ui.RED), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(18), Ui.dp(18)), 8, 0, 0, 0));
        } else if (c.optBoolean("unread")) {
            // Finished while nobody had it open (the desktop sidebar's blue dot).
            r.addView(Ui.dot(a, Ui.BLUE, 6), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(6), Ui.dp(6)), 10, 0, 4, 0));
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

    /** Paired PCs: switch to another, or pair one more. Below, every PC they reach with its
     *  Harbor version, and Update when one is behind (the desktop's Settings › Devices). */
    private void pcs() {
        Sheet s = new Sheet(a, "PCs");
        LinearLayout c = s.card();
        boolean first = true;
        List<Hub> hubs = Hub.all(a);
        for (Hub h : hubs) {
            if (!first) c.addView(Ui.gap(a));
            first = false;
            String more = h.eps.isEmpty() ? "" : " · and " + h.eps.size() + (h.eps.size() == 1 ? " more PC" : " more PCs");
            LinearLayout r = Ui.cardRow(a, null, h.label(), h.host + ":" + h.port + more, Ui.FG, v -> {
                s.dismiss();
                if (h.id.equals(a.hub.id)) return;
                Hub.setLast(a, h.id);
                a.startActivity(new Intent(a, Chats.class).putExtra("hub", h.id).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP));
                a.finish();
            });
            Ui.wrapSub(r, 3);
            if (h.id.equals(a.hub.id)) r.addView(Ui.icon(a, Ui.I_CHECK, 20, Ui.FG), new LinearLayout.LayoutParams(Ui.dp(24), Ui.dp(24)));
            c.addView(r, Ui.fill());
        }
        if (!first) c.addView(Ui.gap(a));
        c.addView(Ui.cardRow(a, null, "Pair another PC", "scan its code in Settings › Phones", Ui.FG, v -> {
            s.dismiss();
            a.startActivity(new Intent(a, Hubs.class).putExtra("pair", true));
        }), Ui.fill());

        TextView head = Ui.text(a, "Harbor on your PCs", 14, Ui.G700);
        head.setPadding(Ui.dp(6), Ui.dp(4), Ui.dp(6), Ui.dp(8));
        s.body.addView(head);
        LinearLayout vc = s.card();
        LinearLayout actions = Ui.row(a);
        s.body.addView(actions, Ui.margins(Ui.fill(), 0, 0, 0, 4));
        vc.addView(Ui.cardRow(a, null, "Asking your PCs…", null, Ui.G600, null), Ui.fill());
        // Paired phones' apps, as the hub saw them (`GET /v1/versions`, hubs from 0.68).
        TextView ph = Ui.text(a, "Harbor on your phones", 14, Ui.G700);
        ph.setPadding(Ui.dp(6), Ui.dp(8), Ui.dp(6), Ui.dp(8));
        ph.setVisibility(View.GONE);
        s.body.addView(ph);
        LinearLayout pc = s.card();
        pc.setVisibility(View.GONE);
        phonesCard = new View[] { ph, pc };
        s.show();
        versions(s, vc, actions, new java.util.HashMap<>());
    }

    /** The PCs sheet's phones heading and card (filled with each refresh of the versions). */
    private View[] phonesCard;

    /** The hub's `GET /v1/versions` (null from a hub before 0.68, or one that's away). */
    private JSONObject knownVersions() {
        try { return a.hub.get("/v1/versions"); } catch (Exception e) { return null; }
    }

    /** What the hub last heard from a PC that doesn't answer now: one of its mesh's offline PCs
     *  by that name ("" when none). */
    private static String lastRan(JSONObject known, String name) {
        JSONArray l = known == null ? null : known.optJSONArray("pcs");
        for (int i = 0; l != null && i < l.length(); i++) {
            JSONObject p = l.optJSONObject(i);
            if (p != null && !p.optBoolean("self") && !p.optBoolean("online") && name.equals(p.optString("name"))
                    && !p.optString("version").isEmpty()) return p.optString("line");
        }
        return "";
    }

    /** One row per paired phone: its app version, when and where the hub last saw it. */
    private void fillPhones(JSONObject known) {
        if (phonesCard == null) return;
        LinearLayout card = (LinearLayout) phonesCard[1];
        card.removeAllViews();
        JSONArray l = known == null ? null : known.optJSONArray("phones");
        int n = l == null ? 0 : l.length();
        for (int i = 0; i < n; i++) {
            JSONObject p = l.optJSONObject(i);
            if (p == null) continue;
            if (card.getChildCount() > 0) card.addView(Ui.gap(a));
            LinearLayout r = Ui.cardRow(a, Ui.I_PHONE, p.optString("name"), p.optString("line"), Ui.FG, null);
            Ui.wrapSub(r, 3);
            card.addView(r, Ui.fill());
        }
        int vis = card.getChildCount() > 0 ? View.VISIBLE : View.GONE;
        phonesCard[0].setVisibility(vis);
        card.setVisibility(vis);
    }

    /** Fills the PCs sheet's version card; `asked`: PCs updating since a tap here → the version
     *  they ran (until they answer with another one, or say they're busy themselves). */
    private void versions(Sheet s, LinearLayout vc, LinearLayout actions, Map<String, String> asked) {
        JSONObject[] known = new JSONObject[1];
        Ui.bg(a, () -> { List<Update.Pc> l = Update.pcs(a); known[0] = knownVersions(); return l; }, pcs -> {
            if (!s.dialog.isShowing()) return;
            fillPhones(known[0]);
            vc.removeAllViews();
            actions.removeAllViews();
            String newest = Update.newest(pcs);
            List<Update.Pc> behind = new ArrayList<>(), asks = new ArrayList<>();
            boolean first = true, managed = false;
            for (Update.Pc p : pcs) {
                if (!first) vc.addView(Ui.gap(a));
                first = false;
                String key = p.hub.id + "/" + p.v;
                String was = asked.get(key);
                if (was != null && p.info != null && (p.busy() || !was.equals(p.version()))) asked.remove(key);
                boolean busy = p.busy() || asked.containsKey(key);
                boolean late = Update.behind(p, newest);
                managed |= p.managed();
                if (late && !busy) behind.add(p);
                String sub;
                if (p.info == null) {
                    String last = lastRan(known[0], p.name);
                    sub = last.isEmpty() ? "not answering" : "not answering · Harbor " + last;
                }
                else if (p.version().isEmpty()) sub = "an older Harbor: update it on that PC";
                else {
                    String st = busy && !p.busy() ? "updating…" : p.status();
                    sub = "Harbor " + p.version() + (st.isEmpty() ? "" : " · " + st);
                    if (late && !busy && !st.contains(newest)) sub += " · " + newest + " is out";
                    if (p.managed() && Boolean.TRUE.equals(p.auto())) sub += " · updates automatically";
                }
                if (p.asks()) asks.add(p);
                // Hubs from 0.53: a tap sets how that PC updates (its Settings › Updates).
                LinearLayout r = Ui.cardRow(a, Ui.I_MONITOR, p.name, sub, p.info == null ? Ui.G600 : Ui.FG,
                        p.managed() && p.auto() != null ? v -> pickAuto(s, vc, actions, asked, p) : null);
                Ui.wrapSub(r, 3);
                if (late) {
                    TextView b = small(busy ? "Updating…" : "Update", !busy);
                    if (!busy) b.setOnClickListener(v -> update(s, vc, actions, asked, java.util.Collections.singletonList(p)));
                    r.addView(b, Ui.margins(Ui.wrap(), 8, 0, 0, 0));
                }
                vc.addView(r, Ui.fill());
            }
            if (behind.size() > 1) {
                TextView all = Ui.button(a, "Update all (" + behind.size() + ")", true, v -> update(s, vc, actions, asked, behind));
                actions.addView(all, Ui.margins(Ui.weight(), 0, 0, 8, 0));
            }
            if (!asks.isEmpty() && behind.size() <= 1) {
                TextView all = Ui.button(a, asks.size() == 1 ? "Auto-update it" : "Auto-update all (" + asks.size() + ")", false, v -> setAuto(s, vc, actions, asked, asks, true));
                actions.addView(all, Ui.margins(Ui.weight(), 0, 0, 8, 0));
            }
            if (managed) {
                TextView check = Ui.button(a, "Check for updates", false, v -> {
                    v.setEnabled(false);
                    Ui.bg(a, () -> {
                        for (Update.Pc p : pcs) if (p.managed()) {
                            try { p.hub.callOn(p.v, "POST", "/v1/hub/check", new JSONObject()); } catch (Exception ignored) { }
                        }
                        Thread.sleep(4000); // GitHub answers in a moment
                        return true;
                    }, r -> versions(s, vc, actions, asked));
                });
                actions.addView(check, actions.getChildCount() > 0 ? Ui.weight() : Ui.fill());
            }
        });
    }

    /** Presses each PC's own Update (`POST /v1/hub/update`), then looks again as they reload. */
    private void update(Sheet s, LinearLayout vc, LinearLayout actions, Map<String, String> asked, List<Update.Pc> pcs) {
        for (Update.Pc p : pcs) asked.put(p.hub.id + "/" + p.v, p.version());
        versions(s, vc, actions, asked);
        Ui.bg(a, () -> {
            List<String> failed = new ArrayList<>();
            for (Update.Pc p : pcs) {
                try { p.hub.callOn(p.v, "POST", "/v1/hub/update", new JSONObject()); }
                catch (Exception e) { asked.remove(p.hub.id + "/" + p.v); failed.add(p.name + ": " + Hub.why(e)); }
            }
            return failed;
        }, failed -> {
            Ui.toast(a, failed.isEmpty() ? (pcs.size() == 1 ? "Updating Harbor on " + pcs.get(0).name + "…" : "Updating Harbor on " + pcs.size() + " PCs…")
                    : String.join("\n", failed));
            versions(s, vc, actions, asked);
            // They download, install and reload in place: look again meanwhile.
            for (int ms : new int[] { 8000, 25000, 60000 })
                Ui.main.postDelayed(() -> { if (s.dialog.isShowing()) versions(s, vc, actions, asked); }, ms);
        });
    }

    /** How PC p updates: Automatically or Ask me (its Settings › Updates). */
    private void pickAuto(Sheet s, LinearLayout vc, LinearLayout actions, Map<String, String> asked, Update.Pc p) {
        List<Sheet.Option> o = new ArrayList<>();
        o.add(new Sheet.Option("auto", "Automatically", "new versions install in the background and swap in while nobody uses Harbor there", true));
        o.add(new Sheet.Option("ask", "Ask me", "an Update button waits on that PC", true));
        Sheet.pick(a, "Updates on " + p.name, null, o, Boolean.TRUE.equals(p.auto()) ? "auto" : "ask",
                id -> setAuto(s, vc, actions, asked, java.util.Collections.singletonList(p), "auto".equals(id)));
    }

    /** Sets each PC's Settings › Updates (`POST /v1/hub/auto`), then looks again. */
    private void setAuto(Sheet s, LinearLayout vc, LinearLayout actions, Map<String, String> asked, List<Update.Pc> pcs, boolean on) {
        Ui.bg(a, () -> {
            List<String> failed = new ArrayList<>();
            JSONObject b = new JSONObject();
            b.put("on", on);
            for (Update.Pc p : pcs) {
                try { p.hub.callOn(p.v, "POST", "/v1/hub/auto", b); }
                catch (Exception e) { failed.add(p.name + ": " + Hub.why(e)); }
            }
            return failed;
        }, failed -> {
            if (!failed.isEmpty()) Ui.toast(a, String.join("\n", failed));
            versions(s, vc, actions, asked);
        });
    }

    /** A compact pill button for a card row. */
    private TextView small(String label, boolean primary) {
        TextView t = Ui.bold(a, label, 13, primary ? Ui.ON_INK : Ui.G700);
        t.setGravity(Gravity.CENTER);
        t.setPadding(Ui.dp(14), Ui.dp(7), Ui.dp(14), Ui.dp(7));
        t.setBackground(primary ? Ui.press(Ui.INK, 0, 18) : Ui.round(Ui.G100, 0, 18));
        return t;
    }
}
