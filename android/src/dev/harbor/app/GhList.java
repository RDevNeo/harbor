package dev.harbor.app;

import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.text.Editable;
import android.text.TextUtils;
import android.text.TextWatcher;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.List;

/** The PC's Pull requests or Issues page (GET /v1/prs, /v1/issues): a search, the state, Sort
 *  and Filters, then the desktop's sections (Authored, Review requested… or Assigned,
 *  Authored, Mentioned…) with one row per item. The PC filters, sorts and groups the list as
 *  the desktop does; a row opens GhItem. The picks are kept per PC. Issues come from every PC
 *  of the mesh, each with its own GitHub account: with several, an Account chip picks one. */
public class GhList extends Base {
    static final String PRS = "prs", ISSUES = "issues";
    /** Set by GhItem after a change on GitHub: the next resume fetches anew. */
    static boolean stale;

    String kind;
    private LinearLayout list, states;
    private TextView note, filtersBtn;
    private EditText search;
    private JSONObject page; // the last answer
    private JSONObject f;    // the picks: state, sort and each filter
    private boolean loading, again, againRefresh;
    private final Runnable typed = () -> load(false);

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        if (noHub()) return;
        kind = ISSUES.equals(getIntent().getStringExtra("kind")) ? ISSUES : PRS;
        try { f = new JSONObject(prefs().getString("picks", "{}")); } catch (Exception e) { f = new JSONObject(); }
        LinearLayout root = frame(prs() ? "Pull requests" : "Issues", menuButton(), true);
        action(Ui.I_REFRESH, v -> load(true)).setContentDescription("Refresh");
        action(Ui.I_SORT, v -> pickSort()).setContentDescription("Sort");

        LinearLayout tools = Ui.row(this);
        tools.setPadding(Ui.dp(16), 0, Ui.dp(16), Ui.dp(8));
        search = Ui.input(this, prs() ? "Search pull requests" : "Search issues", false);
        search.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        search.setPadding(Ui.dp(12), Ui.dp(9), Ui.dp(12), Ui.dp(9));
        search.setImeOptions(EditorInfo.IME_ACTION_SEARCH);
        search.setText(f.optString("q"));
        search.setOnEditorActionListener((v, id, e) -> { Ui.main.removeCallbacks(typed); load(false); return false; });
        search.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int st, int c, int af) { }
            @Override public void onTextChanged(CharSequence s, int st, int b, int c) { }
            @Override public void afterTextChanged(Editable e) {
                put("q", e.toString().trim());
                Ui.main.removeCallbacks(typed);
                Ui.main.postDelayed(typed, 450);
            }
        });
        tools.addView(search, Ui.weight());
        filtersBtn = Ui.bold(this, "", 14, Ui.FG);
        filtersBtn.setGravity(Gravity.CENTER);
        filtersBtn.setPadding(Ui.dp(14), 0, Ui.dp(14), 0);
        filtersBtn.setBackground(Ui.press(Ui.CARD, Ui.LINE, 12));
        filtersBtn.setOnClickListener(v -> openFilters());
        tools.addView(filtersBtn, Ui.margins(new LinearLayout.LayoutParams(-2, Ui.dp(42)), 8, 0, 0, 0));
        root.addView(tools, Ui.fill());

        states = Ui.row(this);
        root.addView(states, Ui.margins(Ui.fill(), 16, 0, 16, 4));
        note = Ui.text(this, "", 13, Ui.G700);
        note.setPadding(Ui.dp(20), Ui.dp(6), Ui.dp(20), Ui.dp(2));
        root.addView(note, Ui.fill());

        ScrollView sv = new ScrollView(this);
        list = Ui.col(this);
        list.setPadding(0, 0, 0, Ui.dp(24));
        sv.addView(list);
        root.addView(sv, new LinearLayout.LayoutParams(-1, 0, 1));
        installDrawer(null);
        drawStates();
        drawFilters();
        load(false);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (stale && page != null) { stale = false; load(true); }
    }

    boolean prs() { return PRS.equals(kind); }

    private SharedPreferences prefs() { return getSharedPreferences("gh-" + hub.id + "-" + kind, MODE_PRIVATE); }

    private void put(String k, Object v) {
        try { if (v == null || "".equals(v)) f.remove(k); else f.put(k, v); } catch (Exception ignored) { }
        save();
    }

    private void save() { prefs().edit().putString("picks", f.toString()).apply(); }

    @Override
    void refresh() { load(false); }

    // ---- fetching ----

    private String path(boolean refresh) {
        StringBuilder q = new StringBuilder("/v1/").append(kind).append("?");
        String[] keys = prs() ? new String[]{"state", "involvement", "project", "author", "draft", "review", "checks", "sort", "q"}
                : new String[]{"state", "account", "involvement", "project", "author", "assignee", "milestone", "sort", "q"};
        try {
            for (String k : keys) if (!f.optString(k).isEmpty()) q.append(k).append('=').append(URLEncoder.encode(f.optString(k), "UTF-8")).append('&');
            JSONArray l = f.optJSONArray("labels");
            if (l != null) for (int i = 0; i < l.length(); i++) q.append("label=").append(URLEncoder.encode(l.optString(i), "UTF-8")).append('&');
        } catch (Exception ignored) { }
        if (refresh) q.append("refresh=1");
        return q.toString();
    }

    private void load(boolean refresh) {
        if (loading) { again = true; againRefresh |= refresh; return; }
        loading = true;
        note.setText(page == null ? "Loading from GitHub…" : refresh ? "Refreshing…" : note.getText());
        note.setTextColor(Ui.G700);
        String p = path(refresh);
        Hub h = hub;
        Ui.pool.execute(() -> {
            JSONObject r = null;
            String err = null;
            try { r = h.call("GET", p, null, 40_000); } catch (Exception e) { err = Hub.why(e); }
            final JSONObject fr = r; final String fe = err;
            Ui.main.post(() -> {
                loading = false;
                if (isFinishing()) return;
                if (fr != null) render(fr);
                else { note.setText(fe); note.setTextColor(Ui.RED); }
                if (again) { boolean rf = againRefresh; again = againRefresh = false; load(rf); }
            });
        });
    }

    // ---- the page ----

    private void render(JSONObject r) {
        page = r;
        drawStates();
        drawFilters();
        list.removeAllViews();
        JSONArray groups = r.optJSONArray("groups");
        int shown = 0;
        if (groups != null) for (int i = 0; i < groups.length(); i++) {
            JSONObject g = groups.optJSONObject(i);
            JSONArray items = g == null ? null : g.optJSONArray("items");
            if (items == null || items.length() == 0) continue;
            shown += items.length();
            String label = g.optString("label");
            if (!label.isEmpty()) list.addView(Ui.label(this, label + "  " + items.length()), Ui.fill());
            for (int j = 0; j < items.length(); j++) list.addView(row(items.optJSONObject(j)), Ui.inset());
        }
        int total = r.optInt("total");
        String what = prs() ? "pull requests" : "issues";
        note.setTextColor(Ui.G700);
        String count = shown == total ? total + " " + what : shown + " of " + total + " " + what;
        // PCs of the mesh whose part is missing (off, not signed in to GitHub).
        JSONArray notes = r.optJSONArray("notes");
        List<String> ns = new ArrayList<>();
        if (notes != null) for (int i = 0; i < notes.length(); i++) ns.add(notes.optString(i));
        note.setText(ns.isEmpty() ? count : count + "\n" + TextUtils.join(" · ", ns));
        if (shown == 0) {
            TextView t = Ui.text(this, total == 0 ? "No " + what + " here. Your projects' GitHub repos and what you're part of show up."
                    : "Nothing matches the search and filters.", 14, Ui.G700);
            t.setPadding(Ui.dp(20), Ui.dp(16), Ui.dp(20), Ui.dp(16));
            list.addView(t, Ui.fill());
        }
    }

    /** PR or issue state: its icon and colour (the desktop's). */
    static Object[] stateLook(boolean pr, JSONObject it) {
        String s = it.optString("state");
        if (pr) {
            if ("merged".equals(s)) return new Object[]{Ui.I_MERGE, purple(), "Merged"};
            if ("closed".equals(s)) return new Object[]{Ui.I_PR_CLOSED, Ui.RED, "Closed"};
            if (it.optBoolean("conflicting")) return new Object[]{Ui.I_ALERT, Ui.AMBER, "Has conflicts"};
            if (it.optBoolean("draft")) return new Object[]{Ui.I_PR_DRAFT, Ui.G600, "Draft"};
            return new Object[]{Ui.I_PR_OPEN, Ui.GREEN, "Open"};
        }
        if ("done".equals(s)) return new Object[]{Ui.I_CIRCLE_CHECK, purple(), "Closed as completed"};
        if ("not_planned".equals(s)) return new Object[]{Ui.I_CIRCLE_SLASH, Ui.G600, "Closed as not planned"};
        return new Object[]{Ui.I_CIRCLE_DOT, Ui.GREEN, "Open"};
    }

    static int purple() { return Ui.dark ? 0xffc4b5fd : 0xff7c3aed; }

    /** "+3" and friends: the labels as small dotted chips, at most three. */
    static View labels(Base a, JSONArray ls, int max) {
        LinearLayout r = Ui.row(a);
        if (ls == null) return r;
        for (int i = 0; i < ls.length(); i++) {
            if (i == max) { r.addView(Ui.text(a, "+" + (ls.length() - max), 11, Ui.G700), Ui.margins(Ui.wrap(), 2, 0, 0, 0)); break; }
            JSONObject l = ls.optJSONObject(i);
            if (l == null) continue;
            LinearLayout chip = Ui.row(a);
            chip.setPadding(Ui.dp(7), Ui.dp(2), Ui.dp(8), Ui.dp(2));
            chip.setBackground(Ui.round(0, Ui.LINE, 10));
            chip.addView(Ui.dot(a, color(l.optString("color")), 7));
            chip.addView(Ui.subtitle(Ui.text(a, l.optString("name"), 11, Ui.FG)), Ui.margins(Ui.wrap(), 5, 0, 0, 0));
            r.addView(chip, Ui.margins(Ui.wrap(), 0, 0, 4, 0));
        }
        return r;
    }

    static int color(String hex) {
        try { return 0xff000000 | Integer.parseInt(hex, 16); } catch (Exception e) { return Ui.G500; }
    }

    private View row(JSONObject it) {
        boolean pr = prs();
        LinearLayout r = Ui.row(this);
        r.setGravity(Gravity.TOP);
        r.setPadding(Ui.dp(12), Ui.dp(10), Ui.dp(12), Ui.dp(10));
        r.setBackground(Ui.press(0, 0, 12));
        Object[] look = stateLook(pr, it);
        TextView ic = Ui.icon(this, (String) look[0], 18, (Integer) look[1]);
        ic.setContentDescription((String) look[2]);
        r.addView(ic, Ui.margins(new LinearLayout.LayoutParams(Ui.dp(20), Ui.dp(20)), 0, 1, 12, 0));
        LinearLayout t = Ui.col(this);
        TextView title = Ui.text(this, it.optString("title"), 15, Ui.FG);
        title.setMaxLines(2);
        title.setEllipsize(TextUtils.TruncateAt.END);
        t.addView(title);
        String meta = "#" + it.optInt("number") + " · " + it.optString("repo").toLowerCase() + " · " + it.optString("author") + " · " + Ui.ago(it.optLong("updated_ms"));
        JSONArray acc = it.optJSONArray("accounts");
        if (severalAccounts() && acc != null && acc.length() > 0) {
            List<String> v = new ArrayList<>();
            for (int i = 0; i < acc.length(); i++) v.add(acc.optString(i));
            meta += " · " + TextUtils.join(", ", v);
        }
        t.addView(Ui.subtitle(Ui.text(this, meta, 12.5f, Ui.G700)), Ui.margins(Ui.fill(), 0, 2, 0, 0));
        JSONArray ls = it.optJSONArray("labels");
        if (ls != null && ls.length() > 0) t.addView(labels(this, ls, 3), Ui.margins(Ui.fill(), 0, 5, 0, 0));
        r.addView(t, Ui.weight());

        // Right: checks and review (PRs), comments and a fixing PR (issues).
        LinearLayout side = Ui.row(this);
        if (pr) {
            String c = it.optString("checks");
            if ("passing".equals(c)) side.addView(mark(Ui.I_CIRCLE_CHECK, Ui.GREEN, "Checks passing"));
            else if ("failing".equals(c)) side.addView(mark(Ui.I_CIRCLE_X, Ui.RED, "Checks failing"));
            else if ("pending".equals(c)) side.addView(mark(Ui.I_CIRCLE_DASHED, Ui.AMBER, "Checks running"));
            String v = it.optString("review");
            if ("approved".equals(v)) side.addView(mark(Ui.I_CIRCLE_CHECK, Ui.BLUE, "Approved"));
            else if ("changes".equals(v)) side.addView(mark(Ui.I_CIRCLE_SLASH, Ui.AMBER, "Changes requested"));
        } else {
            if (it.optBoolean("linked_pr")) side.addView(mark(Ui.I_PR_OPEN, Ui.G700, "A pull request fixes it"));
            int n = it.optInt("comments");
            if (n > 0) {
                side.addView(Ui.icon(this, Ui.I_CHAT, 14, Ui.G700), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(16), Ui.dp(16)), 6, 0, 3, 0));
                side.addView(Ui.text(this, String.valueOf(n), 12, Ui.G700));
            }
        }
        r.addView(side, Ui.margins(Ui.wrap(), 8, 2, 0, 0));
        r.setOnClickListener(v -> startActivity(new Intent(this, GhItem.class).putExtra("hub", hub.id).putExtra("kind", kind)
                .putExtra("row", it.toString()).putExtra("projects", page == null ? "[]" : String.valueOf(page.optJSONArray("projects")))));
        r.setOnLongClickListener(v -> { Ui.copy(this, it.optString("url")); return true; });
        return r;
    }

    private TextView mark(String glyph, int color, String what) {
        TextView t = Ui.icon(this, glyph, 15, color);
        t.setContentDescription(what);
        t.setLayoutParams(Ui.margins(new LinearLayout.LayoutParams(Ui.dp(17), Ui.dp(17)), 4, 0, 0, 0));
        return t;
    }

    // ---- state, sort, filters ----

    private void drawStates() {
        states.removeAllViews();
        String[][] opts = prs() ? new String[][]{{"", "Open"}, {"closed", "Closed"}, {"merged", "Merged"}, {"all", "All"}}
                : new String[][]{{"", "Open"}, {"closed", "Closed"}, {"all", "All"}};
        LinearLayout box = Ui.row(this);
        box.setBackground(Ui.round(Ui.G100, 0, 12));
        box.setPadding(Ui.dp(3), Ui.dp(3), Ui.dp(3), Ui.dp(3));
        String cur = f.optString("state");
        for (String[] o : opts) {
            boolean on = o[0].equals(cur);
            TextView t = on ? Ui.bold(this, o[1], 14, Ui.FG) : Ui.text(this, o[1], 14, Ui.G700);
            t.setGravity(Gravity.CENTER);
            t.setPadding(0, Ui.dp(6), 0, Ui.dp(6));
            t.setBackground(on ? Ui.round(Ui.CARD, Ui.dark ? 0 : Ui.LINE, 10) : Ui.press(0, 0, 10));
            t.setOnClickListener(v -> { put("state", o[0]); drawStates(); load(false); });
            box.addView(t, new LinearLayout.LayoutParams(0, -2, 1));
        }
        states.addView(box, Ui.weight());
        // Issues: which PC's GitHub account, once the list has several (the hub merges them).
        if (!prs() && (severalAccounts() || !f.optString("account").isEmpty())) {
            String acct = f.optString("account");
            LinearLayout chip = Ui.row(this);
            chip.setGravity(Gravity.CENTER_VERTICAL);
            chip.setPadding(Ui.dp(12), 0, Ui.dp(12), 0);
            chip.setBackground(Ui.press(Ui.CARD, Ui.LINE, 12));
            chip.addView(Ui.icon(this, Ui.I_USER, 15, acct.isEmpty() ? Ui.G700 : Ui.BLUE), new LinearLayout.LayoutParams(Ui.dp(17), Ui.dp(17)));
            TextView t = Ui.text(this, acct.isEmpty() ? "All accounts" : acct, 14, acct.isEmpty() ? Ui.FG : Ui.BLUE);
            t.setMaxLines(1);
            t.setEllipsize(TextUtils.TruncateAt.END);
            t.setMaxWidth(Ui.dp(130));
            chip.addView(t, Ui.margins(Ui.wrap(), 6, 0, 0, 0));
            chip.setContentDescription("Account");
            chip.setOnClickListener(v -> Sheet.pick(this, "Account", null, options("account"), f.optString("account"),
                    id -> { put("account", id); drawStates(); load(false); }));
            states.addView(chip, Ui.margins(new LinearLayout.LayoutParams(-2, -1), 8, 0, 0, 0));
        }
    }

    /** The list has more than one GitHub account (PCs of the mesh signed in as others). */
    private boolean severalAccounts() {
        JSONArray a = page == null ? null : page.optJSONArray("accounts");
        return a != null && a.length() > 1;
    }

    private void drawFilters() {
        int n = 0;
        for (String k : new String[]{"account", "involvement", "project", "author", "draft", "review", "checks", "assignee", "milestone"}) if (!f.optString(k).isEmpty()) n++;
        JSONArray l = f.optJSONArray("labels");
        if (l != null) n += l.length();
        filtersBtn.setText(n == 0 ? "Filters" : "Filters · " + n);
        filtersBtn.setTextColor(n == 0 ? Ui.FG : Ui.BLUE);
    }

    private void pickSort() {
        JSONArray s = page == null ? null : page.optJSONArray("sorts");
        if (s == null) { Ui.toast(this, "Still loading"); return; }
        List<Sheet.Option> o = new ArrayList<>();
        for (int i = 0; i < s.length(); i++) {
            JSONObject x = s.optJSONObject(i);
            if (x != null) o.add(new Sheet.Option(x.optString("id"), x.optString("label"), "", true));
        }
        String cur = f.optString("sort", s.optJSONObject(0) == null ? "" : s.optJSONObject(0).optString("id"));
        Sheet.pick(this, "Sort", null, o, cur, id -> { put("sort", id); load(false); });
    }

    /** One row per filter with its value; each opens its picker and comes back here. */
    private void openFilters() {
        if (page == null) { Ui.toast(this, "Still loading"); return; }
        Sheet s = new Sheet(this, "Filters");
        LinearLayout c = s.card();
        List<String[]> rows = new ArrayList<>();
        if (prs()) {
            rows.add(new String[]{"involvement", "Involvement", Ui.I_USERS});
            rows.add(new String[]{"project", "Project", Ui.I_LAYERS});
            rows.add(new String[]{"author", "Author", Ui.I_USER});
            rows.add(new String[]{"labels", "Labels", Ui.I_TAG});
            rows.add(new String[]{"draft", "Draft", Ui.I_PR_DRAFT});
            rows.add(new String[]{"review", "Review", Ui.I_CIRCLE_CHECK});
            rows.add(new String[]{"checks", "Checks", Ui.I_CIRCLE_DASHED});
        } else {
            if (severalAccounts() || !f.optString("account").isEmpty()) rows.add(new String[]{"account", "Account", Ui.I_USER});
            rows.add(new String[]{"involvement", "Involvement", Ui.I_USERS});
            rows.add(new String[]{"project", "Project", Ui.I_LAYERS});
            rows.add(new String[]{"author", "Author", Ui.I_USER});
            rows.add(new String[]{"assignee", "Assignee", Ui.I_USER});
            rows.add(new String[]{"labels", "Labels", Ui.I_TAG});
            rows.add(new String[]{"milestone", "Milestone", Ui.I_MILESTONE});
        }
        boolean first = true;
        for (String[] r : rows) {
            if (!first) c.addView(Ui.gap(this));
            first = false;
            LinearLayout row = Ui.cardRow(this, r[2], r[1], valueOf(r[0]), Ui.FG, v -> { s.dismiss(); pick(r[0], r[1]); });
            row.addView(Ui.chevron(this));
            c.addView(row, Ui.fill());
        }
        if (!filtersBtn.getText().toString().equals("Filters")) {
            LinearLayout c2 = s.card();
            c2.addView(Ui.cardRow(this, Ui.I_X, "Clear filters", null, Ui.RED, v -> {
                s.dismiss();
                for (String k : new String[]{"account", "involvement", "project", "author", "draft", "review", "checks", "assignee", "milestone", "labels"}) f.remove(k);
                save();
                drawStates();
                load(false);
            }), Ui.fill());
        }
        s.show();
    }

    /** What a filter is set to, as its row says it. */
    private String valueOf(String k) {
        if ("labels".equals(k)) {
            JSONArray l = f.optJSONArray("labels");
            if (l == null || l.length() == 0) return "Any";
            List<String> v = new ArrayList<>();
            for (int i = 0; i < l.length(); i++) v.add(l.optString(i));
            return TextUtils.join(", ", v);
        }
        String v = f.optString(k);
        for (Sheet.Option o : options(k)) if (o.id.equals(v)) return o.label;
        return v.isEmpty() ? "All" : v;
    }

    private List<Sheet.Option> options(String k) {
        List<Sheet.Option> o = new ArrayList<>();
        switch (k) {
            case "account": {
                o.add(new Sheet.Option("", "All accounts", "", true));
                JSONArray p = page == null ? null : page.optJSONArray("accounts");
                if (p != null) for (int i = 0; i < p.length(); i++) {
                    JSONObject x = p.optJSONObject(i);
                    if (x == null) continue;
                    int n = x.optInt("n");
                    o.add(new Sheet.Option(x.optString("login"), x.optString("login"), x.optString("pc") + " · " + n + (n == 1 ? " issue" : " issues"), true));
                }
                break;
            }
            case "involvement":
                o.add(new Sheet.Option("", "All", "", true));
                if (prs()) {
                    o.add(new Sheet.Option("reviewing", "Reviewing", "your review was asked for", true));
                    o.add(new Sheet.Option("authored", "Authored", "you opened them", true));
                } else {
                    o.add(new Sheet.Option("assigned", "Assigned", "assigned to you", true));
                    o.add(new Sheet.Option("authored", "Authored", "you opened them", true));
                    o.add(new Sheet.Option("mentioned", "Mentioned", "they mention you", true));
                }
                break;
            case "project": {
                o.add(new Sheet.Option("", "All projects", "", true));
                JSONArray p = page == null ? null : page.optJSONArray("projects");
                if (p != null) for (int i = 0; i < p.length(); i++) {
                    JSONObject x = p.optJSONObject(i);
                    if (x != null) o.add(new Sheet.Option(x.optString("repo"), x.optString("name"), x.optString("repo"), true));
                }
                break;
            }
            case "author":
            case "assignee": {
                o.add(new Sheet.Option("", "Anyone", "", true));
                if ("assignee".equals(k)) o.add(new Sheet.Option("none", "Nobody", "unassigned", true));
                JSONArray p = page == null ? null : page.optJSONArray("author".equals(k) ? "authors" : "assignees");
                if (p != null) for (int i = 0; i < p.length(); i++) {
                    JSONObject x = p.optJSONObject(i);
                    if (x == null) continue;
                    String who = x.optString("login", x.optString("name"));
                    o.add(new Sheet.Option(who, who, String.valueOf(x.optInt("n")), true));
                }
                break;
            }
            case "milestone": {
                o.add(new Sheet.Option("", "All", "", true));
                o.add(new Sheet.Option("none", "No milestone", "", true));
                JSONArray p = page == null ? null : page.optJSONArray("milestones");
                if (p != null) for (int i = 0; i < p.length(); i++) {
                    JSONObject x = p.optJSONObject(i);
                    if (x != null) o.add(new Sheet.Option(x.optString("name"), x.optString("name"), String.valueOf(x.optInt("n")), true));
                }
                break;
            }
            case "draft":
                o.add(new Sheet.Option("", "All", "", true));
                o.add(new Sheet.Option("only", "Drafts only", "", true));
                o.add(new Sheet.Option("hide", "Hide drafts", "", true));
                break;
            case "review":
                o.add(new Sheet.Option("", "All", "", true));
                o.add(new Sheet.Option("approved", "Approved", "", true));
                o.add(new Sheet.Option("changes", "Changes requested", "", true));
                o.add(new Sheet.Option("required", "Review required", "", true));
                o.add(new Sheet.Option("none", "No reviews", "", true));
                break;
            case "checks":
                o.add(new Sheet.Option("", "All", "", true));
                o.add(new Sheet.Option("passing", "Passing", "", true));
                o.add(new Sheet.Option("failing", "Failing", "", true));
                break;
        }
        return o;
    }

    private void pick(String k, String title) {
        if ("labels".equals(k)) { pickLabels(); return; }
        Sheet.pick(this, title, null, options(k), f.optString(k), id -> { put(k, id); drawStates(); load(false); openFilters(); });
    }

    /** Labels add up (every one picked must be on the item): a tap turns one on or off. */
    private void pickLabels() {
        JSONArray all = page == null ? null : page.optJSONArray("labels");
        JSONArray cur = f.optJSONArray("labels");
        List<String> on = new ArrayList<>();
        if (cur != null) for (int i = 0; i < cur.length(); i++) on.add(cur.optString(i));
        Sheet s = new Sheet(this, "Labels");
        LinearLayout c = s.card();
        if (all == null || all.length() == 0) {
            TextView t = Ui.text(this, "No labels in this list.", 14, Ui.G700);
            t.setPadding(Ui.dp(18), Ui.dp(14), Ui.dp(18), Ui.dp(14));
            c.addView(t);
        } else for (int i = 0; i < all.length(); i++) {
            JSONObject l = all.optJSONObject(i);
            if (l == null) continue;
            String name = l.optString("name");
            if (i > 0) c.addView(Ui.gap(this));
            View dot = Ui.dot(this, color(l.optString("color")), 12);
            LinearLayout r = Ui.cardRow(this, dot, name, String.valueOf(l.optInt("n")), Ui.FG, v -> {
                s.dismiss();
                if (!on.remove(name)) on.add(name);
                put("labels", on.isEmpty() ? null : new JSONArray(on));
                load(false);
                pickLabels();
            });
            if (on.contains(name)) r.addView(Ui.icon(this, Ui.I_CHECK, 20, Ui.FG), new LinearLayout.LayoutParams(Ui.dp(24), Ui.dp(24)));
            c.addView(r, Ui.fill());
        }
        s.dialog.setOnDismissListener(d -> drawFilters());
        s.show();
    }
}
