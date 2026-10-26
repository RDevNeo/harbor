package dev.harbor.app;

import android.app.Activity;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.List;

/** The two chips under the composer, the desktop's workspace and branch bar (src/worktree.rs):
 *  where the agent works (Current checkout, New worktree, or the chat's worktree) and its branch,
 *  each with a bottom sheet. The PC reads git, ranks the branches and does the switching
 *  (android/PROTOCOL.md, GET /v1/workspace). Hidden outside a git project, and on hubs without it. */
final class WorkBar {
    final LinearLayout view;
    private final Activity a;
    private final Hub hub;
    /** Lucide folder-git (src/icons.rs FOLDER_GIT), in the same font. */
    static final String I_FOLDER_GIT = "\ue40a";
    private final LinearLayout ws, br;
    /** The chat it's for; null: a new chat (then `project`, `worktree` and `base` are its picks). */
    String chat;
    String project = "";
    boolean worktree;
    String base = "";
    private JSONObject info;
    private int gen;

    WorkBar(Activity a, Hub hub) {
        this.a = a;
        this.hub = hub;
        view = Ui.row(a);
        view.setGravity(Gravity.CENTER_VERTICAL);
        view.setPadding(Ui.dp(6), Ui.dp(2), Ui.dp(6), 0);
        ws = chip(Ui.I_FOLDER);
        br = chip(Ui.I_BRANCH);
        ws.setOnClickListener(v -> pickWorkspace());
        br.setOnClickListener(v -> pickBranch());
        view.addView(ws, new LinearLayout.LayoutParams(-2, Ui.dp(34)));
        view.addView(new View(a), new LinearLayout.LayoutParams(0, 1, 1));
        view.addView(br, new LinearLayout.LayoutParams(-2, Ui.dp(34)));
        view.setVisibility(View.GONE);
    }

    /** A quiet chip: a Lucide glyph and a one-line label. */
    private LinearLayout chip(String glyph) {
        LinearLayout c = Ui.row(a);
        c.setGravity(Gravity.CENTER_VERTICAL);
        c.setPadding(Ui.dp(10), 0, Ui.dp(10), 0);
        c.setBackground(Ui.press(0, 0, 10));
        c.addView(Ui.icon(a, glyph, 15, Ui.G700), new LinearLayout.LayoutParams(Ui.dp(18), Ui.dp(18)));
        TextView t = Ui.text(a, "", 13, Ui.G700);
        t.setSingleLine(true);
        t.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);
        t.setMaxWidth(Ui.dp(150));
        c.addView(t, Ui.margins(new LinearLayout.LayoutParams(-2, -2), 6, 0, 0, 0));
        return c;
    }

    private static void label(LinearLayout c, String glyph, String text) {
        if (glyph != null) ((TextView) c.getChildAt(0)).setText(glyph);
        ((TextView) c.getChildAt(1)).setText(text);
    }

    private static String enc(String s) {
        try { return URLEncoder.encode(s == null ? "" : s, "UTF-8"); } catch (Exception e) { return ""; }
    }

    private String target() { return chat != null ? "chat=" + enc(chat) : "project=" + enc(project); }

    private JSONObject target(JSONObject o) throws org.json.JSONException {
        if (chat != null) o.put("chat", Hub.num(chat)); else o.put("project", project.isEmpty() ? JSONObject.NULL : Hub.num(project));
        return o;
    }

    /** Reads the bar again (the chat, or the new chat's project and picks changed). */
    void load() {
        final int my = ++gen;
        final String path = "/v1/workspace?" + target() + (chat == null ? "&worktree=" + (worktree ? 1 : 0) + "&base=" + enc(base) : "");
        if (chat == null && project.isEmpty()) { view.setVisibility(View.GONE); return; }
        Ui.pool.execute(() -> {
            JSONObject r;
            try { r = hub.get(path); } catch (Exception e) { r = null; }
            final JSONObject fr = r;
            Ui.main.post(() -> { if (my == gen) show(fr); });
        });
    }

    private void show(JSONObject r) {
        info = r;
        if (r == null || !r.optBoolean("git")) { view.setVisibility(View.GONE); return; }
        view.setVisibility(View.VISIBLE);
        boolean wt = "worktree".equals(r.optString("mode"));
        String name = r.isNull("name") ? "" : r.optString("name");
        label(ws, wt ? I_FOLDER_GIT : Ui.I_FOLDER, !name.isEmpty() ? name : wt ? "New worktree" : "Current checkout");
        String b = r.optString("branch");
        if (chat == null && wt) b = "from " + r.optString("base");
        int dirty = r.optInt("dirty");
        // Git busy on the PC for its own bar ("Creating worktree…").
        String pend = r.isNull("pending") ? "" : r.optString("pending");
        if (!pend.isEmpty()) { label(ws, Ui.I_LOADER, pend); Ui.main.postDelayed(this::load, 1500); }
        label(br, Ui.I_BRANCH, b.isEmpty() ? "…" : b + (dirty > 0 && !(chat == null && wt) ? "  ·  " + dirty + " changed" : ""));
    }

    /** A call to the PC; on failure its reason as a toast, and the chips read again. */
    private void act(Ui.Job<JSONObject> job, Ui.Done<JSONObject> done) {
        Ui.pool.execute(() -> {
            try {
                JSONObject r = job.run();
                Ui.main.post(() -> { if (!a.isFinishing()) done.ok(r); });
            } catch (Exception e) {
                Ui.main.post(() -> { if (!a.isFinishing()) { Ui.toast(a, Hub.why(e)); load(); } });
            }
        });
    }

    /** While a call runs: the chip says what git does ("Switching to main…"). */
    void pending(boolean branch, String what) {
        view.setVisibility(View.VISIBLE);
        label(branch ? br : ws, Ui.I_LOADER, what);
    }

    // ---- where it works ----

    private void pickWorkspace() {
        if (info == null) return;
        boolean wt = "worktree".equals(info.optString("mode"));
        List<Sheet.Option> opts = new ArrayList<>();
        if (chat == null) {
            opts.add(new Sheet.Option("checkout", "Current checkout", "Runs in the project's own folder", true));
            opts.add(new Sheet.Option("worktree", "New worktree", "Its own folder and branch, so parallel agents don't collide", true));
            Sheet.pick(a, "Workspace", null, opts, worktree ? "worktree" : "checkout", id -> {
                worktree = "worktree".equals(id);
                if (!worktree) base = "";
                load();
            });
            return;
        }
        if (wt) {
            opts.add(new Sheet.Option("wt", info.optString("name"), info.optString("path"), true));
            Sheet.pick(a, "Workspace", "This thread works in its own worktree. It's removed with the thread, unless it has uncommitted changes.", opts, "wt", id -> { });
            return;
        }
        boolean can = info.optBoolean("can_move");
        String why = info.isNull("move_why") ? "" : info.optString("move_why");
        opts.add(new Sheet.Option("checkout", "Current checkout", info.optString("path"), true));
        opts.add(new Sheet.Option("move", "Move to a new worktree", can ? "From the checkout's branch; the thread goes on there" : "Can't now: " + why, can));
        Sheet.pick(a, "Workspace", null, opts, "checkout", id -> {
            if (!"move".equals(id)) return;
            pending(false, "Creating worktree…");
            act(() -> hub.call("POST", "/v1/chats/" + chat + "/worktree", new JSONObject()), r -> {
                Ui.toast(a, "Moved to " + r.optString("name"));
                load();
            });
        });
    }

    // ---- its branch ----

    private void pickBranch() {
        if (info == null) return;
        final boolean forBase = chat == null && "worktree".equals(info.optString("mode"));
        Sheet s = new Sheet(a, forBase ? "Start the worktree from" : "Branch");
        TextView note = Ui.text(a, "", 14, Ui.AMBER);
        note.setPadding(Ui.dp(6), 0, Ui.dp(6), Ui.dp(10));
        note.setVisibility(View.GONE);
        s.body.addView(note);
        EditText q = Ui.input(a, "Search branches", false);
        s.body.addView(q, Ui.margins(Ui.fill(), 0, 0, 0, 10));
        LinearLayout list = Ui.col(a);
        s.body.addView(list, Ui.fill());
        final int[] my = {0};
        Runnable fetch = () -> {
            final int g = ++my[0];
            final String query = q.getText().toString();
            Ui.pool.execute(() -> {
                JSONObject r; String err = null;
                try { r = hub.get("/v1/branches?" + target() + "&q=" + enc(query)); } catch (Exception e) { r = null; err = Hub.why(e); }
                final JSONObject fr = r; final String fe = err;
                Ui.main.post(() -> {
                    if (g != my[0]) return;
                    list.removeAllViews();
                    if (fr == null) { list.addView(Ui.text(a, fe, 14, Ui.RED)); return; }
                    String lock = fr.isNull("branch_lock") ? "" : fr.optString("branch_lock");
                    String warn = fr.isNull("warning") ? "" : fr.optString("warning");
                    String chk = fr.isNull("checkout_note") ? "" : fr.optString("checkout_note");
                    String n = forBase ? "" : !lock.isEmpty() ? lock : !warn.isEmpty() ? warn + (chk.isEmpty() ? "" : "\n" + chk) : chk;
                    note.setText(n);
                    note.setTextColor(!lock.isEmpty() || !warn.isEmpty() ? Ui.AMBER : Ui.G700);
                    note.setVisibility(n.isEmpty() ? View.GONE : View.VISIBLE);
                    boolean locked = !forBase && !lock.isEmpty();
                    String current = forBase ? (base.isEmpty() ? fr.optString("current") : base) : fr.optString("current");
                    LinearLayout c = Ui.card(a);
                    JSONArray rows = fr.optJSONArray("branches");
                    int count = rows == null ? 0 : rows.length();
                    for (int i = 0; i < count; i++) {
                        JSONObject b = rows.optJSONObject(i);
                        String name = b.optString("name");
                        boolean remote = b.optBoolean("remote");
                        if (i > 0) c.addView(Ui.gap(a));
                        LinearLayout row = Ui.cardRow(a, Ui.I_BRANCH, name, remote ? "remote" : null, locked ? Ui.G600 : Ui.FG,
                                locked ? null : v -> { s.dismiss(); choose(name, remote, forBase); });
                        if (name.equals(current) && !remote) row.addView(Ui.icon(a, Ui.I_CHECK, 20, Ui.FG), new LinearLayout.LayoutParams(Ui.dp(24), Ui.dp(24)));
                        c.addView(row, Ui.fill());
                    }
                    if (count == 0) c.addView(Ui.text(a, "No branch matches", 14, Ui.G700), Ui.margins(Ui.fill(), 16, 14, 16, 14));
                    list.addView(c, Ui.margins(Ui.fill(), 0, 0, 0, 12));
                    if (!forBase && fr.optBoolean("can_create") && !locked) {
                        String name = query.trim();
                        LinearLayout cc = Ui.card(a);
                        cc.addView(Ui.cardRow(a, Ui.I_PLUS, "Create branch “" + name + "”", "From where it is now, and switch to it", Ui.FG,
                                v -> { s.dismiss(); create(name); }), Ui.fill());
                        list.addView(cc, Ui.fill());
                    }
                });
            });
        };
        q.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence x, int st, int c, int af) { }
            public void onTextChanged(CharSequence x, int st, int b, int c) { }
            public void afterTextChanged(Editable e) { Ui.main.removeCallbacks(fetch); Ui.main.postDelayed(fetch, 150); }
        });
        fetch.run();
        s.show();
    }

    private void choose(String name, boolean remote, boolean forBase) {
        if (forBase) { base = name; load(); return; }
        pending(true, "Switching to " + name + "…");
        act(() -> hub.call("POST", "/v1/branches", target(new JSONObject()).put("switch", name).put("remote", remote)), r -> {
            Ui.toast(a, "On " + r.optString("branch"));
            load();
        });
    }

    private void create(String name) {
        pending(true, "Creating " + name + "…");
        act(() -> hub.call("POST", "/v1/branches", target(new JSONObject()).put("create", name)), r -> {
            Ui.toast(a, "On " + r.optString("branch"));
            load();
        });
    }
}
