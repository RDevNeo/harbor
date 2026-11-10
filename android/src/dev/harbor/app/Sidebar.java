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
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** One hub's chats the way the reference's drawer shows them: a bold title and search, a few
 *  nav rows (Projects, Settings, and Update when there is one), a
 *  thin line, then the chats by project as the desktop's sidebar orders them (a foldable header
 *  each, thin lines between), Threads and a folded Settled: one-line rows with a chat icon and a
 *  dot while a turn runs. A round avatar (your photo, else the workspace's initial), the round light/dark button beside
 *  it and the black "New session" pill float at the bottom. The title row's workspace button narrows the list to some of the account's
 *  workspaces, as the desktop sidebar's does.
 *  Used full screen (Chats) and as the drawer inside a chat or a GitHub list. */
final class Sidebar {
    final Base a;
    final FrameLayout view;
    private final LinearLayout list;
    private final EditText search;
    private final TextView avatar, wsBtn;
    private final String current; // the open chat (highlighted), or null
    private JSONObject st;
    private boolean showSettled;
    private String filter; // project id, "" = all
    private WsFilter scope = new WsFilter(new ArrayList<>(), "", null, new HashMap<>()); // as last drawn
    /** Where Move to workspace… put each project, by id ("": not moved; hubs before 0.120 send none). */
    private final Map<String, String> projectWs = new HashMap<>();
    /** Share with workspace…: the workspaces each project is shared with (hubs before 0.122 send none). */
    private final Map<String, List<String>> projectShared = new HashMap<>();
    /** The PC a project's folder is on when it isn't the answering PC's ("": none known); absent: the answering PC's. */
    private final Map<String, String> projectPc = new HashMap<>();
    /** Snoozed projects, as last drawn: when each wakes ("": a hub before 0.161 doesn't say). */
    private final Map<String, String> snoozedProjects = new HashMap<>();
    /** The account's workspaces by id, as last drawn (for the shared mark's line). */
    private Map<String, String> wsNames = new HashMap<>();

    /** A JSON list of strings; none for anything else. */
    static List<String> strings(JSONArray arr) {
        List<String> out = new ArrayList<>();
        for (int i = 0; arr != null && i < arr.length(); i++) {
            String s = arr.optString(i, "");
            if (!s.isEmpty()) out.add(s);
        }
        return out;
    }

    /** The shared mark (the desktop row's link glyph): blue when the filter shows the row only
     *  because it's shared; a tap says owner and shares ("Owned by X · shared with Y"). */
    private void sharedMark(LinearLayout r, int at, String owner, List<String> shared) {
        String kind = scope.mark(owner, shared);
        if (kind.isEmpty()) return;
        String line = WsFilter.line(wsNames, owner, shared);
        String say = "here".equals(kind) ? "Shown here because it's shared. " + line : line;
        TextView m = Ui.icon(a, Ui.I_LINK, 13, "here".equals(kind) ? Ui.BLUE : Ui.G600);
        m.setContentDescription(say);
        m.setOnClickListener(v -> Ui.toast(a, say));
        LinearLayout.LayoutParams lp = Ui.margins(new LinearLayout.LayoutParams(Ui.dp(18), Ui.dp(18)), 8, 0, 0, 0);
        if (at < 0 || at > r.getChildCount()) r.addView(m, lp);
        else r.addView(m, at, lp);
    }

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
        // Which workspace's chats show; hidden until `render` knows there are any.
        wsBtn = Ui.iconButton(a, Ui.I_USERS, Ui.FG, v -> pickWorkspaces());
        wsBtn.setTextSize(TypedValue.COMPLEX_UNIT_DIP, 20);
        wsBtn.setVisibility(View.GONE);
        head.addView(wsBtn);
        // Add project (the desktop sidebar's folder-plus beside its filters).
        TextView addBtn = Ui.iconButton(a, Ui.I_FOLDER_PLUS, Ui.FG, v -> addProject());
        addBtn.setTextSize(TypedValue.COMPLEX_UNIT_DIP, 20);
        addBtn.setContentDescription("Add project");
        head.addView(addBtn);
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

        // Bottom: avatar (your photo → Settings) and New session.
        avatar = Ui.bold(a, "", 16, 0xffffffff);
        avatar.setGravity(Gravity.CENTER);
        avatar.setBackground(Ui.press(0xff7a6ad8, 0, 20));
        avatar.setOnClickListener(v -> settings());
        FrameLayout.LayoutParams ap = new FrameLayout.LayoutParams(Ui.dp(40), Ui.dp(40), Gravity.BOTTOM | Gravity.START);
        ap.setMargins(Ui.dp(16), 0, 0, Ui.dp(18));
        view.addView(avatar, ap);
        // Beside it (apart from it, so a tap meant for one never lands on the other), one round
        // light/dark button: a sun in dark, a moon in light; a tap flips the theme at once.
        TextView themeBtn = Ui.icon(a, Ui.dark ? Ui.I_SUN : Ui.I_MOON, 19, Ui.FG);
        themeBtn.setBackground(Ui.press(Ui.G200, Ui.LINE, 20));
        themeBtn.setContentDescription(Ui.dark ? "Light theme" : "Dark theme");
        themeBtn.setOnClickListener(v -> a.flipTheme());
        FrameLayout.LayoutParams tp = new FrameLayout.LayoutParams(Ui.dp(40), Ui.dp(40), Gravity.BOTTOM | Gravity.START);
        tp.setMargins(Ui.dp(68), 0, 0, Ui.dp(18));
        view.addView(themeBtn, tp);
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

    /** Your photo (Settings › Account), else the workspace's initial on purple. */
    void label() {
        String l = a.hub.label(), photo = Account.photo(a);
        avatar.setContentDescription("Settings");
        if (!photo.isEmpty() && photo.equals(avatar.getTag())) return; // already showing it
        avatar.setTag(null);
        avatar.setBackground(Ui.press(0xff7a6ad8, 0, 20));
        avatar.setText(l.isEmpty() ? "?" : l.substring(0, 1).toUpperCase());
        Avatars.into(avatar, avatar, photo);
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

    private void addProject() {
        NewProject.open(a, a.hub);
        a.closeDrawer();
    }

    private void newChat() { newChat(null, false); }

    /** New chat, in `project` when given; `main`: it starts that project's main chat. */
    private void newChat(String project, boolean main) {
        Intent i = new Intent(a, NewChat.class).putExtra("hub", a.hub.id);
        if (project != null) i.putExtra("project", project).putExtra("main", main);
        a.startActivity(i);
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
        label(); // your photo may have come with a newer directory
        this.st = st;
        list.removeAllViews();

        Map<String, String> projects = new LinkedHashMap<>(); // in the desktop sidebar's order
        projectWs.clear();
        projectShared.clear();
        projectPc.clear();
        snoozedProjects.clear();
        JSONArray pa = st.optJSONArray("projects");
        if (pa != null) for (int i = 0; i < pa.length(); i++) {
            JSONObject p = pa.optJSONObject(i);
            if (p != null) {
                projects.put(p.optString("id"), p.optString("name"));
                projectWs.put(p.optString("id"), p.optString("workspace", ""));
                projectShared.put(p.optString("id"), strings(p.optJSONArray("shared")));
                // Where its folder is when it isn't the answering PC's (`here`, `pc`); a hub that doesn't say: the answering PC's.
                if (!p.optBoolean("here", true)) projectPc.put(p.optString("id"), p.optString("pc", ""));
            }
        }
        if (!filter.isEmpty() && !projects.containsKey(filter)) filter = "";
        Map<String, String> workspaces = Account.workspaces(a);
        wsNames = workspaces;
        List<String> shown = WsFilter.picked(wsChoice(), workspaces.keySet());
        drawWsBtn(workspaces, shown);
        Map<String, String> pcs = Account.pcWorkspaces(a);
        String hubId = st.optString("hub_id");
        scope = new WsFilter(shown, hubId, pcs.containsKey(hubId) ? pcs.get(hubId) : Account.wsOf(a.hub), pcs);

        if (offTitle != null) {
            TextView icon = Ui.icon(a, Ui.I_MONITOR, 18, Ui.RED);
            icon.setBackground(Ui.round(Ui.G100, 0, 10));
            list.addView(banner(icon, offTitle, offBody, "Try again", true, offRetry, null, null, null), Ui.inset());
        }
        // Their Update buttons need the PC: not while it doesn't answer.
        if (offTitle == null) banners(st);
        list.addView(nav(Ui.I_LAYERS, "Projects", filter.isEmpty() ? null : projects.get(filter), Ui.FG, v -> pickProject(projects)), Ui.inset());
        // No Browser row (a link in a chat opens it), no PCs row (Settings lists the workspace's PCs), and no
        // Pull requests or Issues rows (the search's pages and a project's sheet open them).
        list.addView(nav(Ui.I_SETTINGS, "Settings", null, Ui.FG, v -> settings()), Ui.inset());
        // A newer app on GitHub: a sheet says so, once per version (Update.prompt); Settings › App keeps it.
        long offered = Update.known(a);
        if (offered > Settings.myCode(a)) Ui.main.post(() -> Update.prompt(a, offered));
        View line = new View(a);
        line.setBackgroundColor(Ui.LINE);
        list.addView(line, Ui.margins(new LinearLayout.LayoutParams(-1, Ui.dp(1)), 20, 8, 20, 2));

        String q = search.getText().toString().trim().toLowerCase();
        String you = st.optString("you", "");
        // The chats that pass the filters and the search, by id. A project's main chat stays
        // for its header whatever the workspace: the project's other chats may be in this one.
        Map<String, JSONObject> byId = new LinkedHashMap<>();
        JSONArray ca = st.optJSONArray("chats");
        if (ca != null) for (int i = 0; i < ca.length(); i++) {
            JSONObject c = ca.optJSONObject(i);
            if (c == null || "sub".equals(c.optString("role"))) continue; // a lead's subagents live inside its chat, as on the desktop
            String pid = c.isNull("project_id") ? "" : c.optString("project_id");
            String moved = c.optString("workspace", "");
            // Share with workspace…: it also shows under each workspace it's shared with (its own, its lead's, its project's).
            List<String> shared = strings(c.optJSONArray("shared"));
            if ("lead".equals(c.optString("role")) && !c.optBoolean("settled")) scope.saw(c.optString("home"), moved, shared, pid);
            if (!scope.shows(c.optString("home"), moved, shared) && !c.optBoolean("main")) continue;
            if (!filter.isEmpty() && !filter.equals(pid)) continue;
            if (!q.isEmpty() && !c.optString("title").toLowerCase().contains(q) && !projects.getOrDefault(pid, "").toLowerCase().contains(q)) continue;
            byId.put(c.optString("id"), c);
        }
        String nothing = !q.isEmpty() ? "No chat matches “" + q + "”."
                : scope.active() ? "No chats of " + (shown.size() == 1 ? workspaces.get(shown.get(0)) : "these workspaces") + " reach this PC."
                : "No chats yet. Start one with New session.";
        // No projects at all: the desktop's empty list, with its Add project.
        if (byId.isEmpty() && projects.isEmpty() && q.isEmpty() && !scope.active()) {
            TextView t = Ui.bold(a, "No projects yet", 15, Ui.FG);
            t.setPadding(Ui.dp(20), Ui.dp(16), Ui.dp(20), Ui.dp(2));
            list.addView(t, Ui.fill());
            TextView d = Ui.text(a, "Add a folder or clone a repository to start.", 14, Ui.G700);
            d.setPadding(Ui.dp(20), 0, Ui.dp(20), Ui.dp(10));
            list.addView(d, Ui.fill());
            list.addView(Ui.button(a, "Add project", false, v -> addProject()), Ui.margins(Ui.wrap(), 20, 0, 20, 8));
            return;
        }
        // By project, in the desktop sidebar's order, newest first in each; chats without a
        // project under Threads; settled chats fold into Settled at the end. Projects never
        // settle (an older hub's project `settled` is ignored).
        LinkedHashMap<String, List<JSONObject>> groups = new LinkedHashMap<>();
        // Each project's main chat (hubs from 0.88, which send `main` in `tree`): its header.
        Map<String, JSONObject> mains = new java.util.HashMap<>();
        Set<String> withMains = new HashSet<>();
        List<JSONObject> loose = new ArrayList<>(), settled = new ArrayList<>();
        JSONObject tree = st.optJSONObject("tree");
        // Hubs 0.55.2 to 0.64.0 send it with their own ids though the chats come by gid: none
        // match, so it's grouped here instead.
        if (tree != null && !placesAny(tree, byId)) tree = null;
        if (tree != null) {
            // The desktop sidebar's own placement (newer hubs): the same chats in the same
            // places. A snooze moves nothing: a snoozed project keeps its place, its header muted
            // with when it wakes (`snoozed_label`; hubs 0.78 to 0.160 only said `snoozed`).
            JSONArray tp = tree.optJSONArray("projects");
            if (tp != null) for (int i = 0; i < tp.length(); i++) {
                JSONObject p = tp.optJSONObject(i);
                if (p == null) continue;
                if (!p.isNull("snoozed_label")) snoozedProjects.put(p.optString("id"), p.optString("snoozed_label"));
                else if (p.optBoolean("snoozed")) snoozedProjects.put(p.optString("id"), "");
                groups.put(p.optString("id"), pick(byId, p.optJSONArray("chats")));
                if (p.has("main")) withMains.add(p.optString("id"));
                JSONObject m = p.isNull("main") ? null : byId.get(p.optString("main"));
                if (m != null) mains.put(p.optString("id"), m);
            }
            loose = pick(byId, tree.optJSONArray("threads"));
            settled = pick(byId, tree.optJSONArray("settled"));
            // Hubs 0.78 to 0.160 kept snoozed chats apart (`snoozed`): back in their places,
            // newest first as the rest, since a snooze moves nothing.
            List<JSONObject> apart = pick(byId, tree.optJSONArray("snoozed"));
            for (JSONObject c : apart) {
                List<JSONObject> g = groups.get(c.isNull("project_id") ? "" : c.optString("project_id"));
                (g != null ? g : loose).add(c);
            }
            if (!apart.isEmpty()) {
                java.util.Comparator<JSONObject> newest = (x, y) -> Long.compare(y.optLong("updated_ms"), x.optLong("updated_ms"));
                for (List<JSONObject> g : groups.values()) g.sort(newest);
                loose.sort(newest);
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
        boolean headed = false;
        for (Map.Entry<String, List<JSONObject>> g : groups.entrySet()) {
            JSONObject main = mains.get(g.getKey());
            // A project without chats yet shows too (hubs from 0.88: its header starts the main
            // chat), as the desktop's sidebar lists it; a search shows it when its name matches.
            boolean bare = g.getValue().isEmpty() && main == null;
            if (!scope.showsProject(g.getKey(), projectWs.getOrDefault(g.getKey(), ""), projectPc.get(g.getKey()), projectShared.get(g.getKey())) || (bare && !(withMains.contains(g.getKey()) && (filter.isEmpty() || filter.equals(g.getKey()))
                    && (q.isEmpty() || projects.getOrDefault(g.getKey(), "").toLowerCase().contains(q))))) continue;
            // The desktop's small section heads: PROJECTS over the projects, THREADS over the chats without one.
            if (!headed) list.addView(section("PROJECTS", first), Ui.fill());
            headed = true;
            first = false;
            group(g.getKey(), projects.get(g.getKey()), g.getValue(), you, q.isEmpty(), main, withMains.contains(g.getKey()));
        }
        if (!loose.isEmpty()) {
            list.addView(section("THREADS", first), Ui.fill());
            first = false;
            for (JSONObject c : loose) list.addView(chatRow(c, you), Ui.inset());
        }
        // Settled projects (hubs from 0.113), above the settled chats as on the desktop: a tap opens
        // the project, a long press its sheet (Unsettle project).
        List<String> settledProjects = new ArrayList<>();
        JSONArray sp = tree == null ? null : tree.optJSONArray("settled_projects");
        for (int i = 0; sp != null && i < sp.length(); i++) {
            String pid = sp.optString(i);
            if (!scope.showsProject(pid, projectWs.getOrDefault(pid, ""), projectPc.get(pid), projectShared.get(pid)) || (!filter.isEmpty() && !filter.equals(pid))) continue;
            if (!q.isEmpty() && !projects.getOrDefault(pid, "").toLowerCase().contains(q)) continue;
            settledProjects.add(pid);
        }
        if (!settled.isEmpty() || !settledProjects.isEmpty()) {
            if (!first) divider();
            list.addView(settledHead(settled.size() + settledProjects.size(), () -> { showSettled = !showSettled; render(st); }), Ui.fill());
            if (showSettled) {
                for (String pid : settledProjects) list.addView(settledProjectRow(pid, projects.get(pid)), Ui.inset());
                for (JSONObject c : settled) list.addView(chatRow(c, you), Ui.inset());
            }
        } else if (first) {
            none(nothing); // nothing to show, or only main chats of projects the filter left out
        }
    }

    /** The desktop's Settled header: "Settled (N)", a hairline to the edge and the fold's chevron
     *  (up while open, down while folded); a tap folds or unfolds it. */
    private View settledHead(int n, Runnable toggle) {
        LinearLayout h = Ui.row(a);
        h.setGravity(Gravity.CENTER_VERTICAL);
        h.setPadding(Ui.dp(20), Ui.dp(14), Ui.dp(18), Ui.dp(6));
        h.setBackground(Ui.press(0, 0, 0));
        h.setContentDescription("Settled, " + n + (showSettled ? ", open" : ", folded"));
        h.addView(Ui.text(a, "Settled (" + n + ")", 13, Ui.G700), Ui.wrap());
        View line = new View(a);
        line.setBackgroundColor(Ui.dark ? Ui.G400 : Ui.G300);
        h.addView(line, Ui.margins(new LinearLayout.LayoutParams(0, Math.max(1, Ui.dp(1)), 1), 12, 0, 12, 0));
        h.addView(Ui.icon(a, showSettled ? Ui.I_UP_CHEVRON : Ui.I_DOWN, 15, Ui.G600), new LinearLayout.LayoutParams(Ui.dp(20), Ui.dp(20)));
        h.setOnClickListener(v -> toggle.run());
        return h;
    }

    private void none(String text) {
        TextView t = Ui.text(a, text, 14, Ui.G700);
        t.setPadding(Ui.dp(20), Ui.dp(16), Ui.dp(20), Ui.dp(16));
        list.addView(t, Ui.fill());
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

    /** Busy as the desktop sidebar shows it: its own turn. A hub from 0.149 sends `wait` (a lead whose
     *  sub-agents still run waits on them); older ones say a lead works while they do (`working`; older
     *  still only send `running`). */
    static boolean working(JSONObject c) {
        if (c.has("wait")) return c.optBoolean("running");
        return c.optBoolean("working", c.optBoolean("running"));
    }

    /** Its turn is done but something will wake it (a process, sub-agent, wake-up or key it asked
     *  for: PROTOCOL.md `wait`), as the desktop row's amber "Waiting". */
    static boolean waiting(JSONObject c) {
        return !working(c) && c.optJSONObject("wait") != null;
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
            if (p == null) continue;
            lists.add(p.optJSONArray("chats"));
            if (!p.isNull("main") && p.has("main")) lists.add(new JSONArray().put(p.optString("main")));
        }
        lists.add(tree.optJSONArray("threads"));
        lists.add(tree.optJSONArray("settled"));
        for (JSONArray l : lists) if (!pick(byId, l).isEmpty()) return true;
        return false;
    }

    /** Projects folded on this phone, per PC ("" is Threads). */
    private Set<String> folded() { return new HashSet<>(Ui.prefs(a).getStringSet("folded-" + a.hub.id, new HashSet<>())); }

    /** A section's small head ("PROJECTS", "THREADS"), as the desktop sidebar's. */
    private TextView section(String text, boolean top) {
        TextView t = Ui.text(a, text, 11.5f, Ui.G600);
        t.setTypeface(Ui.semi);
        t.setLetterSpacing(0.06f);
        t.setPadding(Ui.dp(20), Ui.dp(top ? 6 : 16), Ui.dp(20), Ui.dp(4));
        return t;
    }

    /** A project's first letter or digit, upper case (the desktop row's icon without one of its own). */
    private static String initial(String name) {
        if (name != null) for (int i = 0; i < name.length(); i++) if (Character.isLetterOrDigit(name.charAt(i))) return name.substring(i, i + 1).toUpperCase();
        return "";
    }

    /** A project's header and its chats, as the desktop's: the fold's chevron, its letter, its name, then its main chat's
     *  status (folded: what its chats come to, else how many it holds). A tap on the chevron folds it (on this phone);
     *  with main chats (hubs from 0.88) a tap on the rest opens the main chat (none yet: New chat starts it), a long
     *  press or the ⋯ its menu. Folded, the open chat still shows; a search shows every match. The chats hang off a
     *  guide line under the chevron. */
    private void group(String key, String name, List<JSONObject> cs, String you, boolean foldable, JSONObject main, boolean mains) {
        Set<String> f = folded();
        boolean canFold = foldable && !cs.isEmpty();
        boolean fold = canFold && f.contains(key);
        LinearLayout h = Ui.row(a);
        h.setMinimumHeight(Ui.dp(44));
        h.setPadding(Ui.dp(2), Ui.dp(4), Ui.dp(8), Ui.dp(4));
        String mainId = main == null ? null : main.optString("id");
        h.setBackground(mainId != null && mainId.equals(current) ? Ui.press(Ui.G100, 0, 10) : Ui.press(0, 0, 10));
        // The chevron, in a box of its own so a tap there folds instead of opening.
        TextView chev = Ui.icon(a, fold ? Ui.I_CHEV_RIGHT : Ui.I_DOWN, 14, Ui.G600);
        chev.setVisibility(canFold ? View.VISIBLE : View.INVISIBLE);
        if (canFold) {
            chev.setBackground(Ui.press(0, 0, 14));
            chev.setContentDescription(fold ? "Unfold " + cs.size() + " chats" : "Fold its chats");
            chev.setOnClickListener(v -> {
                if (!f.remove(key)) f.add(key);
                Ui.prefs(a).edit().putStringSet("folded-" + a.hub.id, f).apply();
                render(st);
            });
        }
        h.addView(chev, new LinearLayout.LayoutParams(Ui.dp(32), Ui.dp(36)));
        // Snoozed (the desktop's muted project row): its place kept, its name and icon muted, and
        // when it wakes before its status.
        String asleep = snoozedProjects.get(key);
        TextView letter = Ui.bold(a, initial(name), 11.5f, Ui.FG);
        letter.setGravity(Gravity.CENTER);
        letter.setIncludeFontPadding(false);
        letter.setBackground(Ui.round(Ui.dark ? Ui.G300 : Ui.G200, 0, 5));
        letter.setAlpha(asleep != null ? 0.45f : 1f);
        h.addView(letter, Ui.margins(new LinearLayout.LayoutParams(Ui.dp(20), Ui.dp(20)), 0, 0, 10, 0));
        String where = Place.hint(st, key);
        int color = asleep != null ? Ui.G600 : Ui.FG;
        TextView nameView;
        if (where.isEmpty()) {
            nameView = Ui.subtitle(Ui.bold(a, name == null || name.isEmpty() ? "Project" : name, 15, color));
            h.addView(nameView, new LinearLayout.LayoutParams(0, -2, 1));
        } else h.addView(titleWithPlace(name, where, Place.elsewhere(Place.project(st, key)), color), new LinearLayout.LayoutParams(0, -2, 1));
        sharedMark(h, -1, scope.projectOwner(projectWs.getOrDefault(key, ""), projectPc.get(key)), projectShared.getOrDefault(key, new ArrayList<>()));
        // Folded, the open chat stays under it; the others are what its status sums up.
        List<JSONObject> shown = new ArrayList<>();
        if (!fold) shown.addAll(cs);
        else for (JSONObject c : cs) if (c.optString("id").equals(current)) shown.add(c);
        List<JSONObject> hidden = new ArrayList<>(cs);
        hidden.removeAll(shown);
        if (asleep != null) snoozeMark(h, asleep);
        else if (fold && (main == null || quiet(main, you))) foldedMark(h, hidden);
        else if (main != null) status(h, main, you);
        if (mains) {
            h.setContentDescription((name == null ? "Project" : name) + (where.isEmpty() ? "" : ", on " + where) + (main != null ? ", main chat" : ", start its main chat"));
            h.setOnClickListener(v -> { if (main != null) open(mainId); else newChat(key, true); });
            // The desktop row's buttons and right-click menu: a long press, or the ⋯.
            h.setOnLongClickListener(v -> { projectMenu(key, name, main); return true; });
            TextView more = Ui.bold(a, "⋯", 18, Ui.G600);
            more.setGravity(android.view.Gravity.CENTER);
            more.setBackground(Ui.press(0, 0, 14));
            more.setOnClickListener(v -> projectMenu(key, name, main));
            more.setContentDescription("Project options");
            h.addView(more, Ui.margins(new LinearLayout.LayoutParams(Ui.dp(32), Ui.dp(28)), 4, 0, 0, 0));
        } else {
            h.setContentDescription((name == null ? "Project" : name) + ", " + cs.size() + (fold ? " chats, folded" : " chats"));
            if (canFold) h.setOnClickListener(v -> chev.performClick());
        }
        list.addView(h, Ui.inset());
        for (int i = 0; i < shown.size(); i++) list.addView(chatRow(shown.get(i), you, true, i == shown.size() - 1), Ui.inset());
    }

    /** Nothing to say on its right but when it was last active. */
    private boolean quiet(JSONObject c, String you) {
        return typing(c, you) == null && !working(c) && Hub.queued(c) == 0 && !c.optBoolean("failed") && !waiting(c) && !c.optBoolean("limited") && !c.optBoolean("unread");
    }

    /** A folded project's status: a spinner while one of its chats works, amber while one waits or is limited, red when
     *  one failed, blue while one is unread, else how many chats it holds. */
    private void foldedMark(LinearLayout h, List<JSONObject> hidden) {
        boolean work = false, wait = false, fail = false, unread = false;
        for (JSONObject c : hidden) {
            work |= working(c);
            wait |= waiting(c) || c.optBoolean("limited") || Hub.queued(c) > 0;
            fail |= c.optBoolean("failed");
            unread |= c.optBoolean("unread");
        }
        if (work) h.addView(Ui.icon(a, Ui.I_LOADER, 14, Ui.BLUE), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(18), Ui.dp(18)), 8, 0, 0, 0));
        else if (wait) h.addView(Ui.dot(a, Ui.AMBER, 8), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(8), Ui.dp(8)), 10, 0, 2, 0));
        else if (fail) h.addView(Ui.icon(a, Ui.I_CIRCLE_X, 14, Ui.RED), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(18), Ui.dp(18)), 8, 0, 0, 0));
        else if (unread) h.addView(Ui.dot(a, Ui.BLUE, 7), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(7), Ui.dp(7)), 10, 0, 2, 0));
        else h.addView(Ui.text(a, String.valueOf(hidden.size()), 13, Ui.G600), Ui.margins(Ui.wrap(), 8, 0, 0, 0));
    }

    /** Project `key`'s sheet (ProjectMenu): the desktop project row's options (an older hub
     *  says to update it). */
    private void projectMenu(String key, String name, JSONObject main) {
        // Removed or settled: out of a chat of that project, else the list again.
        ProjectMenu.Gone gone = say -> {
            String of = null;
            JSONArray cs = st == null ? null : st.optJSONArray("chats");
            for (int i = 0; current != null && cs != null && i < cs.length(); i++) {
                JSONObject c = cs.optJSONObject(i);
                if (c != null && current.equals(c.optString("id"))) of = c.isNull("project_id") ? null : c.optString("project_id");
            }
            Ui.toast(a, say);
            if (key.equals(of) && a instanceof Chat) a.finish();
            else a.refresh();
        };
        ProjectMenu.show(a, a.hub, key, name, () -> newChat(key, false), a::refresh, gone);
    }

    /** A settled project under Settled (the desktop's settled project row). */
    /** A project's name and, smaller after it, the PC that holds its folder (`pc`), or the
     *  folder's parent of one of two projects with a name (Place.hint). */
    private LinearLayout titleWithPlace(String name, String where, boolean pc, int color) {
        LinearLayout t = Ui.row(a);
        t.addView(Ui.subtitle(Ui.bold(a, name == null || name.isEmpty() ? "Project" : name, 15, color)), new LinearLayout.LayoutParams(-2, -2, 0));
        t.addView(Ui.icon(a, pc ? Ui.I_MONITOR : Ui.I_FOLDER, 11, Ui.G600), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(13), Ui.dp(13)), 6, 0, 3, 0));
        TextView w = Ui.text(a, where, 11, Ui.G600);
        w.setSingleLine(true);
        w.setEllipsize(android.text.TextUtils.TruncateAt.END);
        t.addView(w, new LinearLayout.LayoutParams(0, -2, 1));
        return t;
    }

    private View settledProjectRow(String pid, String name) {
        String title = name == null || name.isEmpty() ? "Project" : name;
        String where = Place.hint(st, pid);
        if (!where.isEmpty()) title = title + " · " + where;
        LinearLayout r = Ui.listRow(a, Ui.I_FOLDER, Ui.G700, title, Ui.G700);
        r.setBackground(Ui.press(0, 0, 12));
        r.setContentDescription(title + ", settled project");
        sharedMark(r, -1, scope.projectOwner(projectWs.getOrDefault(pid, ""), projectPc.get(pid)), projectShared.getOrDefault(pid, new ArrayList<>()));
        r.setOnClickListener(v -> { Chats.openProject(a, a.hub, pid); a.closeDrawer(); });
        r.setOnLongClickListener(v -> { projectMenu(pid, name, null); return true; });
        return r;
    }

    /** A chat's status at the end of its row (or its project's header, for a main chat): who's
     *  typing, the spinner while it works, queued, failed, waiting, unread. */
    private void status(LinearLayout r, JSONObject c, String you) {
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
        } else if (waiting(c)) {
            // The desktop row's amber dot and "Waiting".
            r.addView(Ui.dot(a, Ui.AMBER, 7), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(7), Ui.dp(7)), 8, 0, 0, 0));
            TextView w = Ui.text(a, c.optJSONObject("wait").optString("label", "Waiting"), 12, Ui.AMBER);
            w.setContentDescription(c.optJSONObject("wait").optString("text", "Waiting"));
            r.addView(w, Ui.margins(Ui.wrap(), 5, 0, 0, 0));
        } else if (c.optBoolean("unread")) {
            // Finished while nobody had it open (the desktop sidebar's blue dot).
            r.addView(Ui.dot(a, Ui.BLUE, 6), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(6), Ui.dp(6)), 10, 0, 4, 0));
        }
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

    private View chatRow(JSONObject c, String you) { return chatRow(c, you, false, false); }

    /** "now", "13m ago", "2h ago", "3d ago": when it was last active, as the desktop row says it. */
    static String ago(long ms) {
        long d = Math.max(0, (System.currentTimeMillis() - ms) / 1000);
        if (d < 60) return "now";
        if (d < 3600) return (d / 60) + "m ago";
        if (d < 86400) return (d / 3600) + "h ago";
        return (d / 86400) + "d ago";
    }

    /** A chat's row, as the desktop's: its status before the title (the spinner while it works, amber while it waits or
     *  is limited, blue while unread, red when its turn failed), the title and, for a chat in its own worktree, its
     *  branch after it, small and dim (it gives way first when the title needs the room; the open chat has it on a
     *  line of its own), its PR's mark, someone else's initials or photo, then on the right Working, Waiting, Limited
     *  or Failed, else when it was last active. A project's chats (`indented`) hang off its guide line; `last` ends it. */
    private View chatRow(JSONObject c, String you, boolean indented, boolean last) {
        String id = c.optString("id");
        String title = c.optString("title");
        boolean settled = c.optBoolean("settled");
        boolean open = id.equals(current);
        boolean asleep = c.has("snoozed_until_ms") && !c.isNull("snoozed_until_ms");
        JSONObject wt = c.optJSONObject("worktree");
        String branch = c.optString("branch", "");
        if (branch.isEmpty() && wt != null) branch = wt.optString("name", "");
        boolean gone = wt != null && wt.optBoolean("gone");
        LinearLayout r = Ui.row(a);
        r.setMinimumHeight(Ui.dp(44));
        r.setPadding(Ui.dp(indented ? 6 : 12), Ui.dp(6), Ui.dp(12), Ui.dp(6));
        r.setBackground(open ? Ui.press(Ui.G100, 0, 12) : Ui.press(0, 0, 12));
        // Before the title: its status, or (a chat without a project) the chat glyph while it has none to show.
        View lead = leadMark(c, you);
        if (lead != null) r.addView(lead, Ui.margins(new LinearLayout.LayoutParams(Ui.dp(16), Ui.dp(16)), 0, 0, 10, 0));
        else if (indented) r.addView(new View(a), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(16), Ui.dp(16)), 0, 0, 10, 0));
        else r.addView(Ui.icon(a, Ui.I_CHAT, 18, asleep ? Ui.G500 : Ui.G700), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(20), Ui.dp(20)), 0, 0, 10, 0));
        int titleColor = asleep ? Ui.G600 : settled ? Ui.G700 : Ui.FG;
        android.text.SpannableStringBuilder t = new android.text.SpannableStringBuilder(title.isEmpty() ? "New chat" : title);
        boolean inline = !branch.isEmpty() && !open && wt != null;
        if (inline) branchSpan(t, branch, gone);
        TextView tv = Ui.subtitle(Ui.text(a, t, 15, titleColor));
        if (open || c.optBoolean("unread")) tv.setTypeface(Ui.semi);
        if (open && !branch.isEmpty()) {
            LinearLayout col = new LinearLayout(a);
            col.setOrientation(LinearLayout.VERTICAL);
            col.addView(tv, Ui.fill());
            android.text.SpannableStringBuilder b = new android.text.SpannableStringBuilder();
            branchSpan(b, branch, gone);
            col.addView(Ui.subtitle(Ui.text(a, b.subSequence(2, b.length()), 12, gone ? Ui.RED : Ui.G600)), Ui.fill());
            r.addView(col, new LinearLayout.LayoutParams(0, -2, 1));
        } else r.addView(tv, new LinearLayout.LayoutParams(0, -2, 1));
        // A worktree whose branch isn't known: the folder-git mark stands in.
        if (wt != null && branch.isEmpty()) {
            TextView m = Ui.icon(a, Ui.I_FOLDER_GIT, 14, gone ? Ui.RED : Ui.G700);
            m.setContentDescription("Worktree " + wt.optString("name"));
            r.addView(m, Ui.margins(new LinearLayout.LayoutParams(Ui.dp(18), Ui.dp(18)), 8, 0, 0, 0));
        }
        // Its branch's pull request (the desktop row's PR mark): the state's icon and colour; only
        // for a chat in its own worktree, as the desktop's.
        JSONObject pr = wt == null ? null : c.optJSONObject("pr");
        if (pr != null) {
            TextView m = Ui.icon(a, WorkBar.prGlyph(pr), 14, WorkBar.prColor(pr));
            m.setContentDescription(pr.optString("label"));
            r.addView(m, Ui.margins(new LinearLayout.LayoutParams(Ui.dp(18), Ui.dp(18)), 8, 0, 0, 0));
        }
        // Shared (Share with workspace…): a chat under its project's header shows it only for shares of its own.
        List<String> shared = strings(c.optJSONArray("shared"));
        String pid = c.isNull("project_id") ? "" : c.optString("project_id");
        List<String> own = new ArrayList<>(shared);
        own.removeAll(projectShared.getOrDefault(pid, new ArrayList<>()));
        if (pid.isEmpty() || settled || !own.isEmpty()) sharedMark(r, -1, scope.owner(c.optString("home"), c.optString("workspace", "")), shared);
        JSONObject owner = c.optJSONObject("owner");
        if (owner != null) ownerMark(r, owner);
        rightStatus(r, c, you, asleep);
        r.setOnClickListener(v -> open(id));
        r.setOnLongClickListener(v -> { Chats.menu(a, a.hub, c, a::refresh, a::refresh); return true; });
        if (!indented) return r;
        // The guide line down the project's chats, under the header's chevron, through to the next chat unless it's the last.
        FrameLayout box = new FrameLayout(a);
        View line = new View(a);
        line.setBackgroundColor(Ui.dark ? Ui.G300 : Ui.G200);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(Math.max(1, Ui.dp(1)), -1);
        lp.leftMargin = Ui.dp(10);
        box.addView(line, lp);
        if (last) box.setPadding(0, 0, 0, Ui.dp(2));
        FrameLayout.LayoutParams rp = new FrameLayout.LayoutParams(-1, -2);
        rp.leftMargin = Ui.dp(26);
        box.addView(r, rp);
        return box;
    }

    /** " ⎇ branch" after a title: the branch glyph and the name in mono, small and dim (red when its worktree is gone). */
    private static void branchSpan(android.text.SpannableStringBuilder t, String branch, boolean gone) {
        int color = gone ? Ui.RED : Ui.G600;
        t.append("  ");
        int s = t.length();
        t.append(Ui.I_BRANCH);
        t.setSpan(new Ui.Font(Ui.icons, 0), s, t.length(), android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        t.append(" ").append(branch);
        t.setSpan(new Ui.Font(Ui.mono, 0), s + Ui.I_BRANCH.length() + 1, t.length(), android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        t.setSpan(new android.text.style.RelativeSizeSpan(0.8f), s, t.length(), android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        t.setSpan(new android.text.style.ForegroundColorSpan(color), s, t.length(), android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
    }

    /** The status before a chat's title, or null for none. */
    private View leadMark(JSONObject c, String you) {
        if (working(c)) return Ui.icon(a, Ui.I_LOADER, 14, Ui.BLUE);
        if (c.optBoolean("failed")) return Ui.icon(a, Ui.I_CIRCLE_X, 14, Ui.RED);
        if (waiting(c) || c.optBoolean("limited") || Hub.queued(c) > 0) return centred(Ui.dot(a, Ui.AMBER, 7));
        if (c.optBoolean("unread")) return centred(Ui.dot(a, Ui.BLUE, 7));
        return null;
    }

    private View centred(View dot) {
        FrameLayout f = new FrameLayout(a);
        f.addView(dot, new FrameLayout.LayoutParams(dot.getLayoutParams().width, dot.getLayoutParams().height, Gravity.CENTER));
        return f;
    }

    /** Someone else's chat: their round photo, else their initials. */
    private void ownerMark(LinearLayout r, JSONObject o) {
        TextView m = Ui.bold(a, o.optString("mark"), 8.5f, Ui.FG);
        m.setGravity(Gravity.CENTER);
        m.setIncludeFontPadding(false);
        m.setBackground(Ui.round(Ui.dark ? Ui.G400 : Ui.G300, 0, 10));
        m.setContentDescription(o.optString("name") + "'s chat");
        r.addView(m, Ui.margins(new LinearLayout.LayoutParams(Ui.dp(20), Ui.dp(20)), 8, 0, 0, 0));
        Avatars.into(m, m, o.optString("photo"));
    }

    /** What a chat row says on its right, as the desktop's: who's typing, Working, Limited, Failed, Waiting (or queued),
     *  a snooze's clock, else when it was last active. */
    private void rightStatus(LinearLayout r, JSONObject c, String you, boolean asleep) {
        String typing = typing(c, you);
        String word = null;
        int color = Ui.G600;
        if (typing != null) { word = "typing…"; color = Ui.BLUE; }
        else if (working(c)) { word = "Working"; color = Ui.BLUE; }
        else if (c.optBoolean("limited")) { word = "Limited"; color = Ui.AMBER; }
        else if (c.optBoolean("failed")) { word = "Failed"; color = Ui.RED; }
        else if (waiting(c)) { word = c.optJSONObject("wait").optString("label", "Waiting"); color = Ui.AMBER; }
        else if (Hub.queued(c) > 0) { word = "Queued"; color = Ui.AMBER; }
        if (word == null && asleep) { snoozeMark(r, c.optString("snoozed_label")); return; }
        if (word == null) word = c.has("updated_ms") ? ago(c.optLong("updated_ms")) : "";
        if (word.isEmpty()) return;
        TextView w = Ui.text(a, word, 13, color);
        if (waiting(c)) w.setContentDescription(c.optJSONObject("wait").optString("text", "Waiting"));
        r.addView(w, Ui.margins(Ui.wrap(), 10, 0, 0, 0));
    }

    /** A snoozed row's mark: the clock glyph and when it wakes ("Tomorrow, 9:00"; "": unknown). */
    private void snoozeMark(LinearLayout r, String label) {
        TextView clock = Ui.icon(a, Ui.I_CLOCK, 13, Ui.G600);
        clock.setContentDescription(label.isEmpty() ? "Snoozed" : "Snoozed until " + label);
        r.addView(clock, Ui.margins(new LinearLayout.LayoutParams(Ui.dp(16), Ui.dp(16)), 8, 0, 0, 0));
        if (!label.isEmpty()) r.addView(Ui.text(a, label, 12, Ui.G600), Ui.margins(Ui.wrap(), 4, 0, 0, 0));
    }

    /** The workspaces picked on this phone, ids joined by commas ("": all), some maybe gone since. */
    private String wsChoice() { return Ui.prefs(a).getString("ws-filter", ""); }

    /** The title row's workspace button: only with workspaces to pick, tinted unless it's All. */
    private void drawWsBtn(Map<String, String> workspaces, List<String> shown) {
        wsBtn.setVisibility(workspaces.isEmpty() ? View.GONE : View.VISIBLE);
        wsBtn.setTextColor(shown.isEmpty() ? Ui.FG : Ui.BLUE);
        wsBtn.setBackground(Ui.press(shown.isEmpty() ? 0 : Ui.G100, 0, 22));
        List<String> names = new ArrayList<>();
        for (String id : shown) names.add(workspaces.get(id));
        wsBtn.setContentDescription("Workspace: " + (names.isEmpty() ? "all" : String.join(", ", names)));
    }

    /** The desktop sidebar's workspace menu: a checklist that stays open. */
    private void pickWorkspaces() {
        Sheet s = new Sheet(a, "Workspace");
        drawWorkspaces(s.card());
        s.show();
    }

    /** All, then the account's workspaces: a tap on one turns it on or off, and the list behind follows. */
    private void drawWorkspaces(LinearLayout c) {
        c.removeAllViews();
        Map<String, String> workspaces = Account.workspaces(a);
        List<String> shown = WsFilter.picked(wsChoice(), workspaces.keySet());
        String pc = st == null ? "" : st.optString("hub_name");
        String here = Account.pcWorkspaces(a).get(st == null ? "" : st.optString("hub_id"));
        c.addView(wsRow(c, "All", pc.isEmpty() ? "" : "Every chat on " + pc, shown.isEmpty(), ""), Ui.fill());
        for (Map.Entry<String, String> w : workspaces.entrySet()) {
            String id = w.getKey();
            c.addView(Ui.gap(a));
            String sub = id.equals(here) && !pc.isEmpty() ? pc + "'s Workspace" : "";
            c.addView(wsRow(c, w.getValue(), sub, shown.contains(id), WsFilter.toggled(wsChoice(), id, workspaces.keySet())), Ui.fill());
        }
    }

    /** One checklist row; a tap makes `then` the selection. */
    private View wsRow(LinearLayout c, String title, String sub, boolean on, String then) {
        LinearLayout r = Ui.cardRow(a, null, title, sub, Ui.FG, v -> {
            Ui.prefs(a).edit().putString("ws-filter", then).apply();
            if (st != null) render(st);
            drawWorkspaces(c);
        });
        if (on) r.addView(Ui.icon(a, Ui.I_CHECK, 20, Ui.FG), new LinearLayout.LayoutParams(Ui.dp(24), Ui.dp(24)));
        return r;
    }

    private static final String ADD = "\u0000add";

    private void pickProject(Map<String, String> projects) {
        List<Sheet.Option> o = new ArrayList<>();
        o.add(new Sheet.Option("", "All projects", "", true));
        for (Map.Entry<String, String> p : projects.entrySet()) {
            if (scope.showsProject(p.getKey(), projectWs.getOrDefault(p.getKey(), ""), projectPc.get(p.getKey()), projectShared.get(p.getKey()))) o.add(new Sheet.Option(p.getKey(), p.getValue(), Place.hint(st, p.getKey()), true));
        }
        o.add(new Sheet.Option(ADD, "Add project…", "a new folder, a folder on the PC, or a clone", true));
        Sheet.pick(a, "Projects", null, o, filter, id -> {
            if (ADD.equals(id)) { addProject(); return; }
            filter = id;
            Ui.prefs(a).edit().putString("filter-" + a.hub.id, id).apply();
            if (st != null) render(st);
        });
    }
}
