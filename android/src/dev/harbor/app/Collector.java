package dev.harbor.app;

import android.os.Bundle;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.EditText;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URLEncoder;

/** Hub's Collector tab (the Lead Collector userscript, moved into Hub): Creators (YouTube search →
 *  creator records, JSONL for SpokPayCRM → Creators → Import) and Servers (Discord invites from
 *  Discover or a channel). The sweeps run on the PC (Hub's engine, ts/tabs/collector): this screen
 *  draws GET /v1/collector, as the PC's window does, and sends each change there; Copy puts the
 *  same JSONL on the phone's clipboard. */
public class Collector extends Base {
    private LinearLayout tabs, form, run, list, actions;
    private EditText query, target;
    private JSONObject view;
    private boolean loading, logOpen, confirmClear;
    private String formSig = "", note = "";
    private long typed;
    private final Runnable poll = new Runnable() {
        @Override public void run() { if (front && running()) load(); }
    };

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        hub = Tabs.hub(this);
        LinearLayout col = Ui.col(this);
        LinearLayout top = Ui.row(this);
        top.setPadding(Ui.dp(20), Ui.dp(14), Ui.dp(12), Ui.dp(2));
        top.addView(Ds.pageTitle(this, "Collector"), Ui.weight());
        col.addView(top, Ui.fill());
        tabs = Ui.row(this);
        tabs.setPadding(Ui.dp(12), Ui.dp(4), Ui.dp(12), Ui.dp(6));
        col.addView(tabs, Ui.fill());
        ScrollView scroll = new ScrollView(this);
        LinearLayout body = Ui.col(this);
        body.setPadding(Ui.dp(16), Ui.dp(6), Ui.dp(16), Ui.dp(24));
        form = Ui.col(this);
        run = Ui.col(this);
        actions = Ui.row(this);
        list = Ui.col(this);
        body.addView(form, Ui.fill());
        body.addView(run, Ui.fill());
        body.addView(actions, Ui.fill());
        body.addView(list, Ui.fill());
        scroll.addView(body);
        col.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        page = Tabs.around(this, col, Tabs.COLLECTOR);
        setContentView(page);
        draw();
    }

    @Override
    protected void onResume() {
        super.onResume();
        hub = Tabs.hub(this);
        load();
    }

    @Override
    void refresh() { load(); }

    // ---------- the PC ----------

    private static String q(String s) {
        try { return URLEncoder.encode(s, "UTF-8"); } catch (Exception e) { return s; }
    }

    private boolean running() {
        JSONObject r = view == null ? null : view.optJSONObject("run");
        return r != null && r.optBoolean("running");
    }

    private void load() {
        if (hub == null) { draw(); return; }
        if (loading) return;
        loading = true;
        final Hub h = hub;
        Ui.pool.execute(() -> {
            try {
                JSONObject v = h.get("/v1/collector");
                Ui.main.post(() -> { loading = false; view = v; note = ""; draw(); });
            } catch (Exception e) {
                Ui.main.post(() -> { loading = false; note = h.whyDown(e); draw(); });
            }
        });
    }

    /** A change on the PC (POST /v1/collector/<path>); the screen again from its answer. */
    private void post(String path, Object... kv) {
        if (hub == null) return;
        final Hub h = hub;
        JSONObject body = new JSONObject();
        try { for (int i = 0; i + 1 < kv.length; i += 2) body.put((String) kv[i], kv[i + 1]); } catch (Exception ignored) { }
        Ui.pool.execute(() -> {
            try {
                JSONObject v = h.call("POST", "/v1/collector/" + path, body);
                Ui.main.post(() -> { if (v != null && v.has("settings")) view = v; draw(); });
            } catch (Exception e) {
                Ui.main.post(() -> { Ui.toast(this, h.whyDown(e)); load(); });
            }
        });
    }

    private JSONObject settings() { return view == null ? new JSONObject() : view.optJSONObject("settings"); }
    private String tab() { return settings().optString("tab", "creators"); }
    private boolean creators() { return "creators".equals(tab()); }
    private String queryKey() { return creators() ? "query" : "reader".equals(settings().optString("serverMode")) ? "channel" : "serverQuery"; }

    // ---------- the screen ----------

    private void draw() {
        tabs.removeAllViews();
        run.removeAllViews();
        actions.removeAllViews();
        list.removeAllViews();
        if (hub == null || view == null) {
            form.removeAllViews();
            formSig = "";
            list.addView(Ds.empty(this, hub == null ? "Pair this phone with a PC to use Collector." : note.isEmpty() ? "Loading…" : note), Ui.fill());
            return;
        }
        JSONObject counts = view.optJSONObject("counts");
        int nc = counts == null ? 0 : counts.optInt("creators"), ns = counts == null ? 0 : counts.optInt("servers");
        // Lucide: users, message-square
        tabs.addView(Ds.iconChip(this, "", "Creators" + (nc > 0 ? "  " + nc : ""), creators(), v -> { confirmClear = false; post("settings", "tab", "creators"); }));
        tabs.addView(Ds.iconChip(this, "", "Servers" + (ns > 0 ? "  " + ns : ""), !creators(), v -> { confirmClear = false; post("settings", "tab", "servers"); }));
        drawForm();
        drawRun();
        drawActions(creators() ? nc : ns);
        drawRows();
        Ui.main.removeCallbacks(poll);
        if (running()) Ui.main.postDelayed(poll, 1500);
    }

    /** The form: rebuilt only when what it shows changes (so typing keeps its field). */
    private void drawForm() {
        JSONObject s = settings();
        boolean going = running();
        JSONObject d = view.optJSONObject("discord");
        String sig = tab() + "|" + s.optString("platform") + "|" + s.optString("serverMode") + "|" + s.optInt("gapDays") + "|" + going + "|" + (d != null && d.optBoolean("connected"));
        String qv = s.optString(queryKey());
        JSONObject targets = s.optJSONObject("targets");
        int t = targets == null ? 0 : targets.optInt(tab());
        if (sig.equals(formSig) && query != null) {
            if (System.currentTimeMillis() - typed > 2000) {
                if (!query.hasFocus() && !query.getText().toString().equals(qv)) query.setText(qv);
                if (!target.hasFocus()) target.setText(t > 0 ? String.valueOf(t) : "");
            }
            return;
        }
        formSig = sig;
        form.removeAllViews();
        LinearLayout card = Ds.card(this);
        card.addView(Ds.caps(this, creators() ? "SOURCE" : "MODE", true), Ui.fill());
        HorizontalScrollView hs = new HorizontalScrollView(this);
        hs.setHorizontalScrollBarEnabled(false);
        LinearLayout chips = Ui.row(this);
        JSONArray src = view.optJSONArray(creators() ? "sources" : "modes");
        String picked = creators() ? s.optString("platform") : s.optString("serverMode");
        String why = "";
        for (int i = 0; src != null && i < src.length(); i++) {
            JSONObject o = src.optJSONObject(i);
            final String value = o.optString("value");
            boolean avail = o.optBoolean("available");
            if (value.equals(picked) && !avail) why = o.optString("why");
            TextView c = Ds.chip(this, avail ? o.optString("label") : o.optString("label") + " · soon", value.equals(picked), avail && !going ? v -> post("settings", creators() ? "platform" : "serverMode", value) : null);
            if (!avail) c.setAlpha(0.5f);
            LinearLayout.LayoutParams lp = Ui.wrap();
            lp.rightMargin = Ui.dp(6);
            chips.addView(c, lp);
        }
        hs.addView(chips);
        card.addView(hs, Ui.fill());
        if (!why.isEmpty()) card.addView(pad(Ui.text(this, why, 13, Ui.G700), 6), Ui.fill());
        boolean reader = "reader".equals(s.optString("serverMode"));
        card.addView(pad(Ui.label(this, creators() ? "Search term" : reader ? "Channel link" : "Search Discover"), 12), Ui.fill());
        query = Ui.input(this, creators() ? "e.g. blox fruits brasil" : reader ? "https://discord.com/channels/…/…" : "e.g. vendo robux", false);
        query.setText(qv);
        query.setEnabled(!going);
        query.setImeOptions(EditorInfo.IME_ACTION_GO);
        query.setOnEditorActionListener((v, id, e) -> { start(); return true; });
        query.addTextChangedListener(new Watch(() -> post("settings", queryKey(), query.getText().toString())));
        card.addView(query, Ui.fill());
        LinearLayout tr = Ui.row(this);
        tr.setGravity(Gravity.CENTER_VERTICAL);
        tr.setPadding(0, Ui.dp(10), 0, 0);
        tr.addView(Ui.text(this, "Target", 14, Ui.G700), Ui.weight());
        tr.addView(Ui.rowButton(this, "−", false, going ? null : v -> step(-10)));
        target = Ui.input(this, "All", false);
        target.setInputType(InputType.TYPE_CLASS_NUMBER);
        target.setGravity(Gravity.CENTER);
        target.setText(t > 0 ? String.valueOf(t) : "");
        target.setEnabled(!going);
        target.addTextChangedListener(new Watch(() -> post("settings", "target", target.getText().toString())));
        LinearLayout.LayoutParams tl = new LinearLayout.LayoutParams(Ui.dp(84), -2);
        tl.leftMargin = Ui.dp(6);
        tl.rightMargin = Ui.dp(6);
        tr.addView(target, tl);
        tr.addView(Ui.rowButton(this, "+", false, going ? null : v -> step(10)));
        card.addView(tr, Ui.fill());
        if (creators()) {
            card.addView(pad(Ui.label(this, "Last upload"), 12), Ui.fill());
            HorizontalScrollView gs = new HorizontalScrollView(this);
            gs.setHorizontalScrollBarEnabled(false);
            LinearLayout gaps = Ui.row(this);
            JSONArray ga = view.optJSONArray("gaps");
            for (int i = 0; ga != null && i < ga.length(); i++) {
                JSONObject g = ga.optJSONObject(i);
                final int days = g.optInt("value");
                LinearLayout.LayoutParams lp = Ui.wrap();
                lp.rightMargin = Ui.dp(6);
                gaps.addView(Ds.chip(this, g.optString("label"), days == s.optInt("gapDays"), going ? null : v -> post("settings", "gapDays", days)), lp);
            }
            gs.addView(gaps);
            card.addView(gs, Ui.fill());
        } else {
            boolean ok = d != null && d.optBoolean("connected");
            String acc = d == null ? "" : d.optString("account", "");
            card.addView(pad(Ui.text(this, ok ? "Reads through " + (acc.isEmpty() ? "the Stores Discord account" : acc) + " (Persons). Read-only: nothing is joined or sent."
                : "Servers needs Discord: sign in to the Stores Discord account in Persons first.", 13, ok ? Ui.G700 : Ui.AMBER), 10), Ui.fill());
        }
        TextView go = Ui.button(this, going ? "Stop" : "Start", !going, v -> { if (running()) post("stop"); else start(); });
        LinearLayout.LayoutParams gl = Ui.fill();
        gl.topMargin = Ui.dp(14);
        card.addView(go, gl);
        form.addView(card, Ui.fill());
    }

    private void start() {
        if (running() || query == null) return;
        typed = 0;
        post("start", queryKey(), query.getText().toString().trim(), "target", target.getText().toString());
    }

    private void step(int d) {
        int cur = 0;
        try { cur = Integer.parseInt(target.getText().toString().trim()); } catch (Exception ignored) { }
        int next = Math.max(0, cur + d);
        target.setText(next > 0 ? String.valueOf(next) : "");
        typed = 0;
        post("settings", "target", next);
    }

    /** The run: what's going (or went), its clock, found / target, the log's tail. */
    private void drawRun() {
        JSONObject r = view.optJSONObject("run");
        if (r == null || !tab().equals(r.optString("tab"))) return;
        boolean going = r.optBoolean("running");
        LinearLayout card = Ds.card(this);
        LinearLayout head = Ui.row(this);
        head.setGravity(Gravity.CENTER_VERTICAL);
        head.addView(Ui.bold(this, r.optString("label") + " · “" + r.optString("query") + "”", 15, Ui.FG), Ui.weight());
        int secs = r.optInt("elapsed");
        head.addView(Ui.text(this, (secs / 60) + ":" + String.format(java.util.Locale.ROOT, "%02d", secs % 60), 13, Ui.G700));
        card.addView(head, Ui.fill());
        int found = r.optInt("found"), tgt = r.optInt("target");
        float frac = tgt > 0 ? Math.min(1f, found / (float) tgt) : going ? 0f : 1f;
        LinearLayout bar = Ui.row(this);
        bar.setBackground(Ui.round(Ui.G200, 0, 3));
        View fill = new View(this);
        fill.setBackground(Ui.round(going ? Ui.BLUE : Ui.GREEN, 0, 3));
        bar.addView(fill, new LinearLayout.LayoutParams(0, Ui.dp(6), frac));
        bar.addView(new View(this), new LinearLayout.LayoutParams(0, Ui.dp(6), 1 - frac));
        LinearLayout.LayoutParams bl = Ui.fill();
        bl.topMargin = Ui.dp(10);
        bl.bottomMargin = Ui.dp(8);
        card.addView(bar, bl);
        String what = creators() ? "creators" : "invites";
        String status = going ? (tgt > 0 ? found + " of " + tgt + " " + what : found + " " + what) : r.optString("status");
        int checked = r.optInt("considered"), dropped = r.optInt("dropped");
        String meta = (checked > 0 ? checked + " checked" : "") + (dropped > 0 ? " · " + dropped + (creators() ? " dropped" : " skipped") : "");
        card.addView(Ui.text(this, status + (meta.isEmpty() ? "" : "   " + meta), 13, Ui.G700), Ui.fill());
        TextView toggle = Ui.text(this, logOpen ? "Hide log" : "Show log", 13, Ui.FG);
        toggle.setPadding(0, Ui.dp(10), 0, Ui.dp(4));
        toggle.setOnClickListener(v -> { logOpen = !logOpen; draw(); });
        card.addView(toggle, Ui.wrap());
        if (logOpen) {
            JSONArray log = view.optJSONArray("log");
            int from = log == null ? 0 : Math.max(0, log.length() - 30);
            for (int i = from; log != null && i < log.length(); i++) {
                JSONObject l = log.optJSONObject(i);
                String tone = l.optString("tone");
                TextView t = Ui.text(this, l.optString("text"), 11.5f, "ok".equals(tone) ? Ui.GREEN : "error".equals(tone) ? Ui.RED : "info".equals(tone) ? Ui.FG : Ui.G600);
                t.setTypeface(android.graphics.Typeface.MONOSPACE);
                card.addView(t, Ui.fill());
            }
        }
        LinearLayout.LayoutParams cl = Ui.fill();
        cl.topMargin = Ui.dp(12);
        run.addView(card, cl);
    }

    private void drawActions(int n) {
        if (n == 0) return;
        actions.setPadding(0, Ui.dp(16), 0, Ui.dp(4));
        actions.setGravity(Gravity.CENTER_VERTICAL);
        actions.addView(Ds.caps(this, creators() ? "COLLECTED CREATORS" : "COLLECTED INVITES", false), Ui.weight());
        actions.addView(Ui.rowButton(this, creators() ? "Copy JSONL" : "Copy URLs", true, v -> copy()));
        LinearLayout.LayoutParams lp = Ui.wrap();
        lp.leftMargin = Ui.dp(6);
        TextView clear = Ui.rowButton(this, confirmClear ? "Clear " + n + "?" : "Clear", false, running() ? null : v -> {
            if (!confirmClear) { confirmClear = true; draw(); return; }
            confirmClear = false;
            post("clear", "tab", tab());
        });
        if (confirmClear) Ui.danger(clear);
        actions.addView(clear, lp);
    }

    private void copy() {
        if (hub == null) return;
        final Hub h = hub;
        final String t = tab();
        Ui.pool.execute(() -> {
            try {
                JSONObject r = h.get("/v1/collector/export?tab=" + q(t));
                Ui.main.post(() -> {
                    Ui.copy(this, r.optString("text"));
                    Ui.toast(this, "creators".equals(t) ? "Copied " + r.optInt("count") + " creator(s). Paste into SpokPayCRM → Creators → Import." : "Copied " + r.optInt("count") + " invite URL(s).");
                });
            } catch (Exception e) {
                Ui.main.post(() -> Ui.toast(this, h.whyDown(e)));
            }
        });
    }

    private void drawRows() {
        JSONArray rows = view.optJSONArray(creators() ? "creators" : "servers");
        if (rows == null || rows.length() == 0) {
            if (!running()) list.addView(Ds.empty(this, creators() ? "No creators yet. Search a term and press Start." : "No invites yet. Search Discover, or paste a channel link in Reader."), Ui.fill());
            return;
        }
        for (int i = 0; i < rows.length(); i++) {
            JSONObject r = rows.optJSONObject(i);
            LinearLayout row = Ui.row(this);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding(Ui.dp(4), Ui.dp(8), Ui.dp(4), Ui.dp(8));
            row.setBackground(Ui.press(0, 0, 12));
            String id = r.optString("avatarId", "");
            String name = r.optString("name");
            row.addView(PersonsUi.avatar(this, hub, id.isEmpty() || "null".equals(id) ? null : "/v1/collector/avatar?id=" + id, initials(name), color(r.optString("id")), 42, null));
            LinearLayout text = Ui.col(this);
            text.setPadding(Ui.dp(12), 0, Ui.dp(6), 0);
            TextView title = Ui.bold(this, name, 15, Ui.FG);
            title.setSingleLine(true);
            title.setEllipsize(android.text.TextUtils.TruncateAt.END);
            text.addView(title, Ui.fill());
            String sub = r.optString("sub");
            if (!sub.isEmpty()) {
                TextView st = Ui.text(this, sub, 12.5f, Ui.G700);
                st.setSingleLine(true);
                st.setEllipsize(android.text.TextUtils.TruncateAt.END);
                text.addView(st, Ui.fill());
            }
            String stats = r.optString("stats") + (creators() && r.optBoolean("discord") ? "  · Discord" : "");
            if (!stats.trim().isEmpty()) text.addView(Ui.text(this, stats, 12.5f, Ui.G600), Ui.fill());
            String meta = r.optString("meta");
            if (!meta.isEmpty()) text.addView(Ui.text(this, meta, 12, Ui.G600), Ui.fill());
            row.addView(text, Ui.weight());
            final String url = r.optString("url"), rid = r.optString("id");
            row.setOnClickListener(v -> { if (!url.isEmpty()) Ui.openUrl(this, url); });
            row.setOnLongClickListener(v -> {
                Ds.menu(this, java.util.Arrays.asList(
                    Ds.item("", "Copy link", () -> Ui.copy(this, url)),
                    Ds.danger("", "Remove from the list", () -> post("remove", "tab", tab(), "id", rid))));
                return true;
            });
            list.addView(row, Ui.fill());
        }
    }

    private static TextView pad(TextView t, int top) {
        t.setPadding(0, Ui.dp(top), 0, Ui.dp(6));
        return t;
    }

    private static String initials(String name) {
        String[] w = name.replaceAll("[^\\p{L}\\p{N}\\s]", " ").trim().split("\\s+");
        if (w.length == 0 || w[0].isEmpty()) return "?";
        if (w.length > 1) return (w[0].substring(0, 1) + w[w.length - 1].substring(0, 1)).toUpperCase();
        return w[0].substring(0, Math.min(2, w[0].length())).toUpperCase();
    }

    private static final String[] COLORS = {"#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#06b6d4", "#ec4899", "#84cc16", "#f97316", "#8b5cf6", "#0ea5e9"};

    private static int color(String id) {
        int h = 0;
        for (int i = 0; i < id.length(); i++) h = h * 31 + id.charAt(i);
        return android.graphics.Color.parseColor(COLORS[Math.abs(h % COLORS.length)]);
    }

    /** Typing in a field: saved on the PC once it settles (0.6 s). */
    private final class Watch implements TextWatcher {
        private final Runnable save;
        private final Runnable later = new Runnable() { @Override public void run() { save.run(); } };
        Watch(Runnable save) { this.save = save; }
        @Override public void beforeTextChanged(CharSequence s, int a, int b, int c) { }
        @Override public void onTextChanged(CharSequence s, int a, int b, int c) { }
        @Override public void afterTextChanged(Editable e) {
            View f = getCurrentFocus();
            if (f != query && f != target) return; // set by the screen, not typed
            typed = System.currentTimeMillis();
            Ui.main.removeCallbacks(later);
            Ui.main.postDelayed(later, 600);
        }
    }
}
