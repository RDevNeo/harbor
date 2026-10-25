package dev.harbor.app;

import android.content.Intent;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.style.ForegroundColorSpan;
import android.text.style.LineBackgroundSpan;
import android.view.Gravity;
import android.view.View;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URLEncoder;

/** One pull request or issue, as the desktop's side panel shows it (GET /v1/prs/view,
 *  /v1/issues/view): repo and number, title, author and state; for a PR the branches and the
 *  diff size, then Summary (reviewers, labels, description, checks, comments), Timeline and
 *  Code; for an issue assignees, labels, milestone, the description and the comments. Actions:
 *  Merge or Fix with the agent (a chat on the PC), Ready for review, Close / Reopen, and a menu
 *  (refresh, open on GitHub, copy, review with an agent). */
public class GhItem extends Base {
    private boolean pr;
    private String url;
    private JSONObject row, full;
    private JSONArray projects;
    private LinearLayout head, tabBar, body;
    private String tab = "summary";
    private JSONObject diff;
    private boolean diffLoading, busy;
    private Render md;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        if (noHub()) return;
        pr = !GhList.ISSUES.equals(getIntent().getStringExtra("kind"));
        try { row = new JSONObject(getIntent().getStringExtra("row")); } catch (Exception e) { row = new JSONObject(); }
        try { projects = new JSONArray(getIntent().getStringExtra("projects")); } catch (Exception e) { projects = new JSONArray(); }
        url = row.optString("url");
        md = new Render(this, null);
        LinearLayout root = frame("#" + row.optInt("number"), true);
        sub(row.optString("repo").toLowerCase(), Ui.G700);
        action(Ui.I_EXTERNAL, v -> openWeb()).setContentDescription("Open on GitHub");
        action(Ui.I_MENU, v -> more()).setContentDescription("More");
        ScrollView sv = new ScrollView(this);
        LinearLayout col = Ui.col(this);
        col.setPadding(0, 0, 0, Ui.dp(32));
        head = Ui.col(this);
        head.setPadding(Ui.dp(20), Ui.dp(4), Ui.dp(20), Ui.dp(4));
        col.addView(head, Ui.fill());
        tabBar = Ui.row(this);
        col.addView(tabBar, Ui.margins(Ui.fill(), 20, 10, 20, 4));
        body = Ui.col(this);
        body.setPadding(Ui.dp(20), Ui.dp(4), Ui.dp(20), 0);
        col.addView(body, Ui.fill());
        sv.addView(col);
        root.addView(sv, new LinearLayout.LayoutParams(-1, 0, 1));
        drawHead();
        load();
    }

    private void load() {
        String p = "/v1/" + (pr ? "prs" : "issues") + "/view?url=" + enc(url);
        Hub h = hub;
        Ui.pool.execute(() -> {
            JSONObject r = null;
            String err = null;
            try { r = h.call("GET", p, null, 40_000); } catch (Exception e) { err = Hub.why(e); }
            final JSONObject fr = r; final String fe = err;
            Ui.main.post(() -> {
                if (isFinishing()) return;
                if (fr != null) full = fr;
                else if (full == null) { body.removeAllViews(); body.addView(Ui.text(this, fe, 14, Ui.RED)); return; }
                else Ui.toast(this, fe);
                drawHead();
                draw();
            });
        });
    }

    private static String enc(String s) {
        try { return URLEncoder.encode(s, "UTF-8"); } catch (Exception e) { return s; }
    }

    /** What's known: the full answer, else the list's row. */
    private JSONObject it() { return full != null ? full : row; }

    private String projectId() {
        String repo = it().optString("repo", row.optString("repo"));
        for (int i = 0; i < projects.length(); i++) {
            JSONObject p = projects.optJSONObject(i);
            if (p != null && p.optString("repo").equalsIgnoreCase(repo)) return p.optString("id");
        }
        return null;
    }

    private boolean open() { return "open".equals(it().optString("state")); }

    // ---- header and actions ----

    private void drawHead() {
        head.removeAllViews();
        JSONObject it = it();
        Object[] look = GhList.stateLook(pr, it);
        LinearLayout chip = Ui.row(this);
        chip.setPadding(Ui.dp(10), Ui.dp(4), Ui.dp(12), Ui.dp(4));
        chip.setBackground(Ui.round(Ui.G100, 0, 12));
        chip.addView(Ui.icon(this, (String) look[0], 14, (Integer) look[1]));
        chip.addView(Ui.text(this, (String) look[2], 13, Ui.FG), Ui.margins(Ui.wrap(), 6, 0, 0, 0));
        head.addView(chip, Ui.wrap());
        TextView title = Ui.bold(this, it.optString("title"), 20, Ui.FG);
        title.setOnLongClickListener(v -> { Ui.copy(this, it.optString("title")); return true; });
        head.addView(title, Ui.margins(Ui.fill(), 0, 10, 0, 0));
        long upd = it.optLong("updated_ms");
        head.addView(Ui.text(this, it.optString("author") + (upd > 0 ? " · updated " + Ui.ago(upd) + " ago" : ""), 13, Ui.G700),
                Ui.margins(Ui.fill(), 0, 4, 0, 0));
        if (pr && full != null) {
            LinearLayout br = Ui.row(this);
            TextView base = Ui.text(this, full.optString("base"), 12, full.optBoolean("conflicting") ? Ui.AMBER : Ui.G700);
            base.setTypeface(Ui.mono);
            br.addView(base);
            br.addView(Ui.text(this, "  ←  ", 12, Ui.G600));
            TextView headRef = Ui.subtitle(Ui.text(this, full.optString("head"), 12, Ui.G700));
            headRef.setTypeface(Ui.mono);
            headRef.setOnClickListener(v -> Ui.copy(this, full.optString("head")));
            br.addView(headRef, Ui.weight());
            head.addView(br, Ui.margins(Ui.fill(), 0, 8, 0, 0));
            SpannableStringBuilder s = new SpannableStringBuilder();
            span(s, "+" + full.optLong("adds"), Ui.GREEN);
            s.append("  ");
            span(s, "−" + full.optLong("dels"), Ui.RED);
            s.append("  ·  ").append(String.valueOf(full.optLong("files"))).append(full.optLong("files") == 1 ? " file" : " files");
            TextView size = Ui.text(this, s, 12, Ui.G700);
            size.setTypeface(Ui.mono);
            head.addView(size, Ui.margins(Ui.fill(), 0, 4, 0, 0));
            if (full.optBoolean("conflicting")) head.addView(Ui.text(this, "Has conflicts with " + full.optString("base"), 13, Ui.AMBER), Ui.margins(Ui.fill(), 0, 4, 0, 0));
        }

        // Actions, as the desktop's header has them.
        LinearLayout acts = Ui.row(this);
        String agent = full == null ? "" : full.optString("agent", "");
        boolean project = projectId() != null;
        if (open() && project && full != null) {
            TextView go = Ui.button(this, (pr ? "Merge with " : "Fix with ") + (agent.isEmpty() ? "an agent" : agent), true, v -> agentThread());
            go.setPadding(Ui.dp(16), Ui.dp(9), Ui.dp(16), Ui.dp(9));
            acts.addView(go, Ui.margins(Ui.wrap(), 0, 0, 8, 0));
        }
        if (pr && open() && it.optBoolean("draft")) acts.addView(small(busy ? "Marking ready…" : "Ready for review", () -> post("ready")), Ui.margins(Ui.wrap(), 0, 0, 8, 0));
        if (!pr && full != null) acts.addView(small(open() ? "Close" : "Reopen", () -> post(open() ? "close" : "reopen")), Ui.margins(Ui.wrap(), 0, 0, 8, 0));
        if (acts.getChildCount() > 0) head.addView(acts, Ui.margins(Ui.fill(), 0, 14, 0, 0));
        if (open() && !project && full != null)
            head.addView(Ui.text(this, "Add this repo as a project on the PC to let an agent work on it.", 12, Ui.G700), Ui.margins(Ui.fill(), 0, 8, 0, 0));
        drawTabs();
    }

    private static void span(SpannableStringBuilder s, String text, int color) {
        int a = s.length();
        s.append(text);
        s.setSpan(new ForegroundColorSpan(color), a, s.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
    }

    private TextView small(String label, Runnable on) {
        TextView t = Ui.button(this, label, false, v -> on.run());
        t.setPadding(Ui.dp(16), Ui.dp(9), Ui.dp(16), Ui.dp(9));
        t.setAlpha(busy ? 0.5f : 1f);
        return t;
    }

    private void drawTabs() {
        tabBar.removeAllViews();
        if (!pr) return;
        LinearLayout box = Ui.row(this);
        box.setBackground(Ui.round(Ui.G100, 0, 12));
        box.setPadding(Ui.dp(3), Ui.dp(3), Ui.dp(3), Ui.dp(3));
        for (String[] o : new String[][]{{"summary", "Summary"}, {"timeline", "Timeline"}, {"code", "Code"}}) {
            boolean on = o[0].equals(tab);
            TextView t = on ? Ui.bold(this, o[1], 14, Ui.FG) : Ui.text(this, o[1], 14, Ui.G700);
            t.setGravity(Gravity.CENTER);
            t.setPadding(0, Ui.dp(6), 0, Ui.dp(6));
            t.setBackground(on ? Ui.round(Ui.CARD, Ui.dark ? 0 : Ui.LINE, 10) : Ui.press(0, 0, 10));
            t.setOnClickListener(v -> { tab = o[0]; drawTabs(); draw(); });
            box.addView(t, new LinearLayout.LayoutParams(0, -2, 1));
        }
        tabBar.addView(box, Ui.weight());
    }

    private void openWeb() {
        try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception e) { Ui.copy(this, url); }
    }

    private void more() {
        Sheet s = new Sheet(this, (pr ? "Pull request #" : "Issue #") + it().optInt("number"));
        LinearLayout c = s.card();
        c.addView(Ui.cardRow(this, Ui.I_REFRESH, "Refresh", null, Ui.FG, v -> { s.dismiss(); diff = null; load(); }), Ui.fill());
        c.addView(Ui.gap(this));
        c.addView(Ui.cardRow(this, Ui.I_EXTERNAL, "Open on GitHub", null, Ui.FG, v -> { s.dismiss(); openWeb(); }), Ui.fill());
        c.addView(Ui.gap(this));
        c.addView(Ui.cardRow(this, Ui.I_LINK, "Copy link", null, Ui.FG, v -> { s.dismiss(); Ui.copy(this, url); }), Ui.fill());
        c.addView(Ui.gap(this));
        c.addView(Ui.cardRow(this, Ui.I_COPY, pr ? "Copy PR number" : "Copy issue number", null, Ui.FG, v -> { s.dismiss(); Ui.copy(this, String.valueOf(it().optInt("number"))); }), Ui.fill());
        if (pr) {
            c.addView(Ui.gap(this));
            c.addView(Ui.cardRow(this, Ui.I_TERMINAL, "Copy checkout command", "gh pr checkout " + it().optInt("number"), Ui.FG,
                    v -> { s.dismiss(); Ui.copy(this, "gh pr checkout " + it().optInt("number")); }), Ui.fill());
            String project = projectId();
            if (project != null) {
                LinearLayout c2 = s.card();
                c2.addView(Ui.cardRow(this, Ui.I_SPARKLES, "Review with an agent", "a new chat in the project, ready to send", Ui.FG, v -> {
                    s.dismiss();
                    int n = it().optInt("number");
                    String text = "Review PR #" + n + " (" + it().optString("title") + "). Read it with `gh pr view " + n + "` and `gh pr diff " + n
                            + "`, then list concrete problems by severity.";
                    startActivity(new Intent(this, NewChat.class).putExtra("hub", hub.id).putExtra("project", project).putExtra("text", text));
                }), Ui.fill());
            }
        }
        s.show();
    }

    /** Ready for review, close, reopen: on GitHub through the PC, then a fresh look. */
    private void post(String what) {
        if (busy) return;
        busy = true;
        drawHead();
        String path = "/v1/" + (pr ? "prs" : "issues") + "/" + what;
        JSONObject b = new JSONObject();
        try { b.put("url", url); } catch (Exception ignored) { }
        Hub h = hub;
        Ui.pool.execute(() -> {
            String err = null;
            try { h.call("POST", path, b, 40_000); } catch (Exception e) { err = Hub.why(e); }
            final String fe = err;
            Ui.main.post(() -> {
                busy = false;
                if (isFinishing()) return;
                if (fe != null) Ui.toast(this, fe);
                else GhList.stale = true;
                load();
            });
        });
    }

    /** Merge with… / Fix with…: a chat on the PC where the agent does it, with the user's own
     *  instructions if they write some. */
    private void agentThread() {
        String agent = full == null ? "" : full.optString("agent", "an agent");
        EditText e = Ui.input(this, "Instructions (optional)", true);
        e.setMinLines(3);
        FrameLayout f = new FrameLayout(this);
        f.setPadding(Ui.dp(20), Ui.dp(8), Ui.dp(20), 0);
        f.addView(e);
        String what = pr ? "It rebases the branch, fixes checks and reviews, then merges it (gh pr merge)."
                : "It looks for the cause, fixes it on a new branch and opens a pull request.";
        Ui.dialog(this).setTitle((pr ? "Merge with " : "Fix with ") + agent + "?").setMessage("A new chat on the PC. " + what).setView(f)
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Start", (d, w) -> {
                    JSONObject b = new JSONObject();
                    try { b.put("url", url).put("extra", e.getText().toString().trim()); } catch (Exception ignored) { }
                    Ui.bg(this, () -> hub.call("POST", "/v1/" + (pr ? "prs/merge" : "issues/fix"), b), r -> {
                        String id = r.optString("id");
                        if (!id.isEmpty()) Chat.open(this, hub, id);
                    });
                }).show();
    }

    // ---- the body ----

    private void draw() {
        body.removeAllViews();
        if (full == null) {
            body.addView(Ui.text(this, "Loading…", 14, Ui.G700), Ui.margins(Ui.fill(), 0, 16, 0, 0));
            return;
        }
        if (!pr || "summary".equals(tab)) summary();
        else if ("timeline".equals(tab)) timeline();
        else code();
    }

    private TextView header(String s) {
        TextView t = Ui.bold(this, s, 15, Ui.FG);
        t.setPadding(0, Ui.dp(18), 0, Ui.dp(6));
        return t;
    }

    /** "Reviewers  a ✓  b …", "Labels  ●bug" and the like. */
    private void field(String glyph, String name, View value) {
        LinearLayout r = Ui.row(this);
        r.setGravity(Gravity.TOP);
        r.setPadding(0, Ui.dp(6), 0, Ui.dp(6));
        r.addView(Ui.icon(this, glyph, 15, Ui.G700), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(18), Ui.dp(18)), 0, 1, 8, 0));
        r.addView(Ui.text(this, name, 13, Ui.G700), new LinearLayout.LayoutParams(Ui.dp(84), -2));
        r.addView(value, Ui.weight());
        body.addView(r, Ui.fill());
    }

    private TextView none() { return Ui.text(this, "None", 14, Ui.G600); }

    private void summary() {
        JSONObject f = full;
        if (pr) {
            JSONArray rv = f.optJSONArray("reviewers");
            if (rv == null || rv.length() == 0) field(Ui.I_USERS, "Reviewers", none());
            else {
                LinearLayout c = Ui.col(this);
                for (int i = 0; i < rv.length(); i++) {
                    JSONObject x = rv.optJSONObject(i);
                    if (x == null) continue;
                    Object[] tone = reviewTone(x.optString("state"));
                    LinearLayout r = Ui.row(this);
                    r.addView(Ui.text(this, x.optString("login"), 14, Ui.FG));
                    r.addView(Ui.icon(this, (String) tone[0], 13, (Integer) tone[1]), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(16), Ui.dp(16)), 6, 0, 4, 0));
                    r.addView(Ui.text(this, (String) tone[2], 12, Ui.G700));
                    c.addView(r);
                }
                field(Ui.I_USERS, "Reviewers", c);
            }
        } else {
            JSONArray as = f.optJSONArray("assignees");
            field(Ui.I_USER, "Assignees", as == null || as.length() == 0 ? none() : Ui.text(this, join(as), 14, Ui.FG));
        }
        JSONArray ls = f.optJSONArray("labels");
        field(Ui.I_TAG, "Labels", ls == null || ls.length() == 0 ? none() : wrapLabels(ls));
        if (!pr) {
            String m = f.isNull("milestone") ? "" : f.optString("milestone", "");
            field(Ui.I_MILESTONE, "Milestone", m.isEmpty() ? none() : Ui.text(this, m, 14, Ui.FG));
        }

        body.addView(header("Description"));
        JSONArray bl = f.optJSONArray("blocks");
        if (f.optString("body").trim().isEmpty() || bl == null) body.addView(Ui.text(this, "No description provided.", 14, Ui.G700));
        else {
            LinearLayout d = Ui.col(this);
            md.blocks(d, bl);
            body.addView(d, Ui.fill());
        }

        if (pr) {
            JSONArray ch = f.optJSONArray("checks");
            int n = ch == null ? 0 : ch.length(), fail = 0, pend = 0;
            for (int i = 0; i < n; i++) {
                String s = ch.optJSONObject(i) == null ? "" : ch.optJSONObject(i).optString("state");
                if ("fail".equals(s)) fail++;
                else if ("pending".equals(s)) pend++;
            }
            String sum = n == 0 ? "No checks reported" : fail > 0 ? fail + " of " + n + (n == 1 ? " check failing" : " checks failing")
                    : pend > 0 ? pend + (pend == 1 ? " check running" : " checks running") : "All checks passed";
            int col = n == 0 ? Ui.G700 : fail > 0 ? Ui.RED : pend > 0 ? Ui.AMBER : Ui.GREEN;
            LinearLayout h = Ui.row(this);
            h.setPadding(0, Ui.dp(18), 0, Ui.dp(6));
            h.addView(Ui.bold(this, "Checks", 15, Ui.FG));
            h.addView(Ui.text(this, "  " + sum, 13, col));
            body.addView(h, Ui.fill());
            for (int i = 0; i < n; i++) {
                JSONObject c = ch.optJSONObject(i);
                if (c == null) continue;
                Object[] tone = checkTone(c.optString("state"));
                LinearLayout r = Ui.row(this);
                r.setPadding(Ui.dp(4), Ui.dp(6), Ui.dp(4), Ui.dp(6));
                r.setBackground(Ui.press(0, 0, 8));
                r.addView(Ui.icon(this, (String) tone[0], 15, (Integer) tone[1]), new LinearLayout.LayoutParams(Ui.dp(18), Ui.dp(18)));
                r.addView(Ui.subtitle(Ui.text(this, c.optString("name"), 14, Ui.FG)), Ui.margins(Ui.weight(), 8, 0, 0, 0));
                String u = c.optString("url");
                if (Render.web(u)) r.setOnClickListener(v -> { try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(u))); } catch (Exception e) { Ui.copy(this, u); } });
                body.addView(r, Ui.fill());
            }
        }

        JSONArray cs = f.optJSONArray("comments");
        int nc = cs == null ? 0 : cs.length();
        body.addView(header("Comments (" + nc + ")"));
        if (nc == 0) body.addView(Ui.text(this, "No comments yet.", 14, Ui.G700));
        // Newest first, as the desktop lists them.
        for (int i = nc - 1; i >= 0; i--) {
            JSONObject c = cs.optJSONObject(i);
            if (c != null) body.addView(note(c.optString("author"), "commented", c.optLong("at_ms"), c.optJSONArray("blocks"), c.optString("body")), Ui.margins(Ui.fill(), 0, 0, 0, 8));
        }
    }

    private String join(JSONArray a) {
        StringBuilder s = new StringBuilder();
        for (int i = 0; i < a.length(); i++) s.append(i > 0 ? ", " : "").append(a.optString(i));
        return s.toString();
    }

    /** Label chips that wrap onto more lines. */
    private View wrapLabels(JSONArray ls) {
        LinearLayout c = Ui.col(this);
        for (int i = 0; i < ls.length(); i += 2) {
            JSONArray two = new JSONArray();
            two.put(ls.opt(i));
            if (i + 1 < ls.length()) two.put(ls.opt(i + 1));
            c.addView(GhList.labels(this, two, 2), Ui.margins(Ui.fill(), 0, i == 0 ? 0 : 4, 0, 0));
        }
        return c;
    }

    /** A comment card: who, what and when, then the markdown. */
    private View note(String who, String what, long at, JSONArray blocks, String text) {
        LinearLayout card = Ui.col(this);
        card.setBackground(Ui.round(Ui.CARD, Ui.LINE, 14));
        card.setPadding(Ui.dp(14), Ui.dp(10), Ui.dp(14), Ui.dp(12));
        LinearLayout h = Ui.row(this);
        h.addView(Ui.bold(this, who, 14, Ui.FG));
        h.addView(Ui.subtitle(Ui.text(this, "  " + what + " · " + Ui.ago(at), 13, Ui.G700)), Ui.weight());
        card.addView(h);
        if (blocks != null && !text.trim().isEmpty()) {
            LinearLayout b = Ui.col(this);
            new Render(this, v -> { Ui.copy(this, text); return true; }).blocks(b, blocks);
            card.addView(b, Ui.margins(Ui.fill(), 0, 6, 0, 0));
        }
        return card;
    }

    static Object[] reviewTone(String s) {
        switch (s) {
            case "APPROVED": return new Object[]{Ui.I_CIRCLE_CHECK, Ui.GREEN, "approved"};
            case "CHANGES_REQUESTED": return new Object[]{Ui.I_CIRCLE_X, Ui.AMBER, "requested changes"};
            case "COMMENTED": return new Object[]{Ui.I_CHAT, Ui.G700, "commented"};
            case "DISMISSED": return new Object[]{Ui.I_CIRCLE_SLASH, Ui.G600, "review dismissed"};
            default: return new Object[]{Ui.I_CIRCLE_DASHED, Ui.G600, "review requested"};
        }
    }

    static Object[] checkTone(String s) {
        switch (s) {
            case "pass": return new Object[]{Ui.I_CIRCLE_CHECK, Ui.GREEN};
            case "fail": return new Object[]{Ui.I_CIRCLE_X, Ui.RED};
            case "skipped": return new Object[]{Ui.I_CIRCLE_SLASH, Ui.G600};
            default: return new Object[]{Ui.I_CIRCLE_DASHED, Ui.AMBER};
        }
    }

    private void timeline() {
        JSONArray t = full.optJSONArray("timeline");
        if (t == null || t.length() == 0) { body.addView(Ui.text(this, "Nothing yet.", 14, Ui.G700), Ui.margins(Ui.fill(), 0, 12, 0, 0)); return; }
        for (int i = 0; i < t.length(); i++) {
            JSONObject e = t.optJSONObject(i);
            if (e == null) continue;
            String k = e.optString("kind"), who = e.optString("who");
            long at = e.optLong("at_ms");
            boolean hasBody = !e.optString("body").trim().isEmpty();
            if ("comment".equals(k) || ("review".equals(k) && hasBody)) {
                String what = "comment".equals(k) ? "commented" : (String) reviewTone(e.optString("state"))[2];
                body.addView(note(who, what, at, e.optJSONArray("blocks"), e.optString("body")), Ui.margins(Ui.fill(), 0, 6, 0, 6));
                continue;
            }
            String glyph; int col; String text; boolean mono = false;
            if ("opened".equals(k)) { glyph = Ui.I_PR_OPEN; col = Ui.GREEN; text = who + " opened this pull request"; }
            else if ("commit".equals(k)) { glyph = Ui.I_BRANCH; col = Ui.G700; text = e.optString("sha") + "  " + e.optString("headline"); mono = true; }
            else { Object[] tone = reviewTone(e.optString("state")); glyph = (String) tone[0]; col = (Integer) tone[1]; text = who + " " + tone[2]; }
            LinearLayout r = Ui.row(this);
            r.setMinimumHeight(Ui.dp(32));
            r.addView(Ui.icon(this, glyph, 14, col), new LinearLayout.LayoutParams(Ui.dp(18), Ui.dp(18)));
            TextView tv = Ui.subtitle(Ui.text(this, text, mono ? 12.5f : 14, Ui.FG));
            if (mono) tv.setTypeface(Ui.mono);
            r.addView(tv, Ui.margins(Ui.weight(), 8, 0, 8, 0));
            r.addView(Ui.text(this, Ui.ago(at), 12, Ui.G700));
            body.addView(r, Ui.fill());
        }
    }

    private void code() {
        if (diff == null) {
            body.addView(Ui.text(this, "Loading the diff…", 14, Ui.G700), Ui.margins(Ui.fill(), 0, 12, 0, 0));
            if (diffLoading) return;
            diffLoading = true;
            String p = "/v1/prs/diff?url=" + enc(url);
            Hub h = hub;
            Ui.pool.execute(() -> {
                JSONObject r = null;
                String err = null;
                try { r = h.call("GET", p, null, 40_000); } catch (Exception e) { err = Hub.why(e); }
                final JSONObject fr = r; final String fe = err;
                Ui.main.post(() -> {
                    diffLoading = false;
                    if (isFinishing()) return;
                    if (fr == null) { Ui.toast(this, fe); return; }
                    diff = fr;
                    if ("code".equals(tab)) draw();
                });
            });
            return;
        }
        JSONArray lines = diff.optJSONArray("lines");
        if (lines == null || lines.length() == 0) { body.addView(Ui.text(this, "No changes.", 14, Ui.G700), Ui.margins(Ui.fill(), 0, 12, 0, 0)); return; }
        // One block per file: its name and counts, then its lines (scrolling sideways).
        SpannableStringBuilder s = null;
        for (int i = 0; i <= lines.length(); i++) {
            JSONObject l = i < lines.length() ? lines.optJSONObject(i) : null;
            String t = l == null ? "file" : l.optString("t");
            if ("file".equals(t)) {
                if (s != null) body.addView(codeBox(s), Ui.margins(Ui.fill(), 0, 0, 0, 12));
                if (l == null) break;
                LinearLayout fh = Ui.row(this);
                fh.addView(Ui.icon(this, Ui.I_FILE, 13, Ui.G700), new LinearLayout.LayoutParams(Ui.dp(16), Ui.dp(16)));
                TextView name = Ui.subtitle(Ui.bold(this, l.optString("text"), 13, Ui.FG));
                fh.addView(name, Ui.margins(Ui.weight(), 6, 0, 6, 0));
                SpannableStringBuilder n = new SpannableStringBuilder();
                span(n, "+" + l.optInt("adds"), Ui.GREEN);
                n.append(" ");
                span(n, "−" + l.optInt("dels"), Ui.RED);
                TextView cnt = Ui.text(this, n, 12, Ui.G700);
                cnt.setTypeface(Ui.mono);
                fh.addView(cnt);
                body.addView(fh, Ui.margins(Ui.fill(), 0, 6, 0, 4));
                s = new SpannableStringBuilder();
                continue;
            }
            if (s == null) s = new SpannableStringBuilder();
            int a = s.length();
            String text = l.optString("text").replace("\t", "    ");
            switch (t) {
                case "hunk": s.append(text); break;
                case "add": s.append("+ ").append(text); break;
                case "del": s.append("- ").append(text); break;
                default: s.append("  ").append(text);
            }
            int z = s.length();
            s.append('\n');
            int bg = "add".equals(t) ? (Ui.dark ? 0x3346a758 : 0x2246a758) : "del".equals(t) ? (Ui.dark ? 0x33e5484d : 0x22e5484d) : "hunk".equals(t) ? (Ui.dark ? 0x2252a8ff : 0x1a2d7ff0) : 0;
            // Short of the newline: a span that ends on it colours the next line too.
            if (bg != 0) s.setSpan(new Band(bg), a, z, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            if ("hunk".equals(t)) s.setSpan(new ForegroundColorSpan(Ui.BLUE), a, z, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            else if ("ctx".equals(t)) s.setSpan(new ForegroundColorSpan(Ui.G700), a, z, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        }
        if (diff.optBoolean("clipped")) body.addView(Ui.text(this, "The diff is longer: open it on GitHub for the rest.", 13, Ui.G700));
    }

    /** A diff line's colour across the whole width, not just under its text. */
    static final class Band implements LineBackgroundSpan {
        private final int color;
        Band(int color) { this.color = color; }
        @Override public void drawBackground(Canvas c, Paint p, int left, int right, int top, int baseline, int bottom,
                                             CharSequence text, int start, int end, int line) {
            int old = p.getColor();
            p.setColor(color);
            c.drawRect(left, top, right, bottom, p);
            p.setColor(old);
        }
    }

    private View codeBox(SpannableStringBuilder s) {
        HorizontalScrollView h = new HorizontalScrollView(this);
        h.setHorizontalScrollBarEnabled(false);
        h.setBackground(Ui.round(Ui.CARD, Ui.LINE, 10));
        if (s.length() > 0 && s.charAt(s.length() - 1) == '\n') s.delete(s.length() - 1, s.length());
        TextView t = Ui.text(this, s, 12, Ui.FG);
        t.setTypeface(Ui.mono, Typeface.NORMAL);
        t.setLineSpacing(0, 1.05f);
        t.setPadding(Ui.dp(10), Ui.dp(8), Ui.dp(10), Ui.dp(8));
        t.setTextIsSelectable(true);
        // As wide as the box at least, so a line's colour reaches its edge.
        t.setMinWidth(getResources().getDisplayMetrics().widthPixels - Ui.dp(42));
        h.addView(t);
        return h;
    }
}
