package dev.harbor.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.Switch;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.List;

/** The chips under the composer, the desktop's workspace and branch bar (src/worktree.rs):
 *  where the agent works (Current checkout, New worktree, or the chat's worktree) and its branch,
 *  each with a bottom sheet, and the branch's pull request (chat JSON `pr`, src/chatpr.rs; a tap
 *  opens it). The PC reads git, ranks the branches and does the switching (android/PROTOCOL.md,
 *  GET /v1/workspace). Hidden outside a git project, and on hubs without it. */
final class WorkBar {
    final LinearLayout view;
    private final Activity a;
    private final Hub hub;
    private final LinearLayout ws, br, prc;
    /** The chat it's for; null: a new chat (then `project`, `worktree` and `base` are its picks). */
    String chat;
    String project = "";
    boolean worktree;
    String base = "";
    private JSONObject info, marker, pr;
    private String home = "";
    private boolean loaded; // the hub has answered /v1/workspace once
    private int gen;

    WorkBar(Activity a, Hub hub) {
        this.a = a;
        this.hub = hub;
        view = Ui.row(a);
        view.setGravity(Gravity.CENTER_VERTICAL);
        view.setPadding(Ui.dp(6), Ui.dp(2), Ui.dp(6), 0);
        ws = chip(Ui.I_FOLDER);
        br = chip(Ui.I_BRANCH);
        prc = chip(Ui.I_PR_OPEN);
        ws.setOnClickListener(v -> pickWorkspace());
        br.setOnClickListener(v -> pickBranch());
        prc.setOnClickListener(v -> openPr());
        prc.setOnLongClickListener(v -> { if (pr != null) Ui.toast(a, pr.optString("label") + "\n" + pr.optString("title")); return true; });
        prc.setVisibility(View.GONE);
        // On a narrow phone the workspace's label is cut first: the PR and the branch stay whole.
        LinearLayout left = Ui.row(a);
        left.setGravity(Gravity.CENTER_VERTICAL);
        left.addView(ws, new LinearLayout.LayoutParams(-2, Ui.dp(34)));
        view.addView(left, new LinearLayout.LayoutParams(0, Ui.dp(34), 1));
        view.addView(prc, new LinearLayout.LayoutParams(-2, Ui.dp(34)));
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
        // Until it answers, a marker update doesn't redraw with another chat's answer.
        loaded = false;
        final String path = "/v1/workspace?" + target() + (chat == null ? "&worktree=" + (worktree ? 1 : 0) + "&base=" + enc(base) : "");
        if (chat == null && project.isEmpty()) { view.setVisibility(View.GONE); return; }
        Ui.pool.execute(() -> {
            JSONObject r;
            try { r = hub.get(path); } catch (Exception e) { r = null; }
            final JSONObject fr = r;
            Ui.main.post(() -> { if (my == gen) { loaded = true; show(fr); } });
        });
    }

    /** The footer, as the desktop's (worktree.rs workspace_bar): where the chat works and its
     *  branch; "Worktree gone" in red with no branch when its worktree was removed; a read-only
     *  "Worktree · <name>" for a chat whose worktree isn't on this PC (another PC's chat, one
     *  run on a device). The phone has no header chip for it. */
    private void show(JSONObject r) {
        info = r;
        boolean git = r != null && r.optBoolean("git");
        ws.setVisibility(View.VISIBLE);
        br.setVisibility(View.VISIBLE);
        showPr();
        ws.setOnClickListener(v -> pickWorkspace());
        tint(ws, Ui.G700);
        // As the desktop: "gone" only where the workspace is this PC's (a device's chat has its
        // worktree elsewhere, so it isn't here, yet not gone).
        if (git && chat != null && marker != null && marker.optBoolean("gone")) {
            view.setVisibility(View.VISIBLE);
            label(ws, Ui.I_FOLDER_GIT, "Worktree gone");
            tint(ws, Ui.RED);
            br.setVisibility(View.GONE);
            return;
        }
        if (!git && chat != null && marker != null) {
            view.setVisibility(View.VISIBLE);
            label(ws, Ui.I_FOLDER_GIT, "Worktree · " + marker.optString("name"));
            br.setVisibility(View.GONE);
            String on = home.isEmpty() ? "the PC it runs on" : home;
            ws.setOnClickListener(v -> Ui.toast(a, "Runs in its own worktree on " + on + ", " + marker.optString("name")));
            return;
        }
        // Another PC's chat in its checkout: only its PR, as the desktop's footer.
        if (!git && chat != null && pr != null) {
            view.setVisibility(View.VISIBLE);
            ws.setVisibility(View.GONE);
            br.setVisibility(View.GONE);
            return;
        }
        if (!git) { view.setVisibility(View.GONE); return; }
        view.setVisibility(View.VISIBLE);
        boolean wt = "worktree".equals(r.optString("mode"));
        String name = r.isNull("name") ? "" : r.optString("name");
        label(ws, wt ? Ui.I_FOLDER_GIT : Ui.I_FOLDER, !name.isEmpty() ? "Worktree · " + name : wt ? "New worktree" : "Current checkout");
        String b = r.optString("branch");
        if (chat == null && wt) b = "from " + r.optString("base");
        int dirty = r.optInt("dirty");
        // Git busy on the PC for its own bar ("Creating worktree…").
        String pend = r.isNull("pending") ? "" : r.optString("pending");
        if (!pend.isEmpty()) { label(ws, Ui.I_LOADER, pend); Ui.main.postDelayed(this::load, 1500); }
        label(br, Ui.I_BRANCH, b.isEmpty() ? "…" : b + (dirty > 0 && !(chat == null && wt) ? "  ·  " + dirty + " changed" : ""));
    }

    private static void tint(LinearLayout c, int color) {
        ((TextView) c.getChildAt(0)).setTextColor(color);
        ((TextView) c.getChildAt(1)).setTextColor(color);
    }

    /** The chat's "worktree" and "pr" from the hub's state (null: none, or a hub older than
     *  0.66 / 0.83). */
    void marker(JSONObject w, JSONObject pr, String home) {
        marker = w;
        this.pr = pr;
        this.home = home;
        if (loaded) show(info);
    }

    /** A PR's state as its icon and colour (the desktop's, chatpr.rs). */
    static String prGlyph(JSONObject p) {
        switch (p.optString("state")) {
            case "merged": return Ui.I_MERGE;
            case "closed": return Ui.I_PR_CLOSED;
            case "draft": return Ui.I_PR_DRAFT;
            default: return Ui.I_PR_OPEN;
        }
    }

    static int prColor(JSONObject p) {
        switch (p.optString("state")) {
            case "merged": return GhList.purple();
            case "closed": return Ui.RED;
            case "draft": return Ui.G600;
            default: return Ui.GREEN;
        }
    }

    /** The branch's pull request: its state's icon in the state's colour and the hub's label
     *  ("PR #123 · Merged"), muted like the other chips. */
    private void showPr() {
        if (pr == null) { prc.setVisibility(View.GONE); return; }
        label(prc, prGlyph(pr), pr.optString("label"));
        ((TextView) prc.getChildAt(0)).setTextColor(prColor(pr));
        prc.setVisibility(View.VISIBLE);
    }

    private void openPr() {
        String url = pr == null ? "" : pr.optString("url");
        if (url.isEmpty()) return;
        try { a.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception e) { Ui.copy(a, url); }
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
                    // The chat's own worktree: its branch can be renamed (also while its agent works).
                    if (!forBase && info.optBoolean("can_rename")) {
                        String cur = fr.optString("current");
                        LinearLayout rc = Ui.card(a);
                        rc.addView(Ui.cardRow(a, Ui.I_PEN, "Rename branch…", "Its worktree folder follows", Ui.FG,
                                v -> { s.dismiss(); rename(cur); }), Ui.fill());
                        list.addView(rc, Ui.margins(Ui.fill(), 0, 12, 0, 0));
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

    /** "Rename branch", as the desktop's form (worktree.rs rename_menu): the new name, and for a
     *  pushed branch whether it's renamed on its remote too. The PC renames the branch at once
     *  and moves the worktree's folder once nothing works in it. */
    private void rename(String current) {
        Sheet s = new Sheet(a, "Rename branch");
        LinearLayout c = s.card();
        c.setPadding(Ui.dp(14), Ui.dp(14), Ui.dp(14), Ui.dp(12));
        EditText e = Ui.input(a, "New branch name", false);
        e.setText(current);
        e.setSelection(e.getText().length());
        e.setImeOptions(EditorInfo.IME_ACTION_DONE);
        c.addView(e, Ui.fill());
        String up = info == null || info.isNull("pushed") ? "" : info.optString("pushed");
        final Switch sw = up.isEmpty() ? null : new Switch(a);
        if (sw != null) {
            sw.setChecked(true);
            LinearLayout r = Ui.cardRow(a, Ui.I_BRANCH, "Also rename " + up,
                    "On GitHub it's renamed there and its pull requests follow; on other remotes the new name is pushed and the old one stays.", Ui.FG, v -> sw.toggle());
            r.addView(sw);
            c.addView(r, Ui.margins(Ui.fill(), 0, 8, 0, 0));
        }
        String waits = info == null || info.isNull("folder_waits") ? "" : info.optString("folder_waits");
        TextView n = Ui.text(a, "The worktree's folder follows the new name once nothing works in it" + (waits.isEmpty() ? "" : " (" + waits + " now)") + ".", 13, Ui.G700);
        n.setPadding(Ui.dp(4), Ui.dp(8), Ui.dp(4), Ui.dp(8));
        c.addView(n, Ui.fill());
        Runnable go = () -> {
            String name = e.getText().toString().trim();
            if (name.isEmpty() || name.equals(current)) return;
            s.dismiss();
            pending(true, "Renaming to " + name + "…");
            act(() -> hub.call("POST", "/v1/chats/" + chat + "/worktree/rename", new JSONObject().put("branch", name).put("remote", sw != null && sw.isChecked())), r -> {
                Ui.toast(a, r.optString("said", "On " + r.optString("branch")));
                load();
            });
        };
        e.setOnEditorActionListener((v, act, ev) -> { go.run(); return true; });
        c.addView(Ui.button(a, "Rename", true, v -> go.run()), Ui.margins(Ui.wrap(), 0, 4, 0, 0));
        s.show();
        e.requestFocus();
    }

    private void create(String name) {
        pending(true, "Creating " + name + "…");
        act(() -> hub.call("POST", "/v1/branches", target(new JSONObject()).put("create", name)), r -> {
            Ui.toast(a, "On " + r.optString("branch"));
            load();
        });
    }
}
