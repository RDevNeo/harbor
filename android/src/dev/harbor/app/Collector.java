package dev.harbor.app;

import android.content.Context;
import android.os.Bundle;
import android.text.Editable;
import android.text.InputType;
import android.text.TextUtils;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** Hub's Collector tab (the Lead Collector userscript, moved into Hub): finds creators on YouTube, TikTok and
 *  Instagram, remembers everyone it ever kept (never collected twice), updates them once a day, and writes to them
 *  through Persons › Creators. The sweeps run on the PC (Hub's engine, ts/tabs/collector): this screen draws
 *  GET /v1/collector, as the PC's window does, and sends each change there; Copy puts the same JSONL on the phone's
 *  clipboard. A creator's screen and Send message (CollectorCreator) open over it, without the tab bar; Back closes
 *  them. */
public class Collector extends Base {
    private LinearLayout counts, form, run, daily, actions, list;
    private EditText query, target, cookie;
    private JSONObject view;
    private boolean loading, logOpen, confirmClear;
    private String formSig = "", note = "";
    private long typed;
    /** The screens open over the tab (a creator, Send message), the top one last. */
    private final List<Screen> stack = new ArrayList<>();
    private final Runnable poll = new Runnable() {
        @Override public void run() { if (front && busy()) load(); }
    };

    /** A screen over the tab: its view, and what it does when it shows again. */
    interface Screen {
        View view();
        void shown();
    }

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        hub = Tabs.hub(this);
        LinearLayout col = Ui.col(this);
        LinearLayout top = Ui.col(this);
        top.setPadding(Ui.dp(20), Ui.dp(14), Ui.dp(12), Ui.dp(2));
        top.addView(Ds.pageTitle(this, "Collector"), Ui.fill());
        counts = Ui.row(this);
        top.addView(counts, Ui.fill());
        col.addView(top, Ui.fill());
        ScrollView scroll = new ScrollView(this);
        LinearLayout body = Ui.col(this);
        body.setPadding(Ui.dp(16), Ui.dp(6), Ui.dp(16), Ui.dp(24));
        form = Ui.col(this);
        run = Ui.col(this);
        daily = Ui.col(this);
        actions = Ui.row(this);
        list = Ui.col(this);
        body.addView(form, Ui.fill());
        body.addView(run, Ui.fill());
        body.addView(daily, Ui.fill());
        body.addView(actions, Ui.fill());
        body.addView(list, Ui.fill());
        scroll.addView(body);
        col.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        page = Tabs.around(this, col, Tabs.COLLECTOR);
        setContentView(page);
        draw();
        // A creator (and its Send message) opened straight away: the phone screenshot rig (screen:collector-creator).
        String c = getIntent().getStringExtra("creator");
        if (c != null && !c.isEmpty()) {
            if (getIntent().getBooleanExtra("send", false)) push(new CollectorCreator.Compose(this, c, getIntent().getStringExtra("name")));
            else openCreator(c);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        hub = Tabs.hub(this);
        load();
        if (!stack.isEmpty()) stack.get(stack.size() - 1).shown();
    }

    @Override
    void refresh() { load(); }

    @Override
    public void onBackPressed() {
        if (!stack.isEmpty()) { pop(); return; }
        super.onBackPressed();
    }

    // ---------- screens over the tab ----------

    void push(Screen s) {
        hideKeyboard();
        stack.add(s);
        setContentView(s.view());
    }

    /** Closes the top screen: the one under it (or the tab) shows again, up to date. */
    void pop() {
        if (stack.isEmpty()) return;
        hideKeyboard();
        stack.remove(stack.size() - 1);
        if (stack.isEmpty()) {
            setContentView(page);
            load();
        } else {
            Screen s = stack.get(stack.size() - 1);
            setContentView(s.view());
            s.shown();
        }
    }

    private void hideKeyboard() {
        View f = getCurrentFocus();
        if (f != null) ((InputMethodManager) getSystemService(INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(f.getWindowToken(), 0);
    }

    // ---------- the PC ----------

    static String q(String s) {
        try { return URLEncoder.encode(s, "UTF-8"); } catch (Exception e) { return s; }
    }

    private boolean running() {
        JSONObject r = view == null ? null : view.optJSONObject("run");
        return r != null && r.optBoolean("running");
    }

    private boolean refreshing() {
        JSONObject r = view == null ? null : view.optJSONObject("refresh");
        return r != null && r.optBoolean("running");
    }

    /** Something moves on the PC (a run, the daily update): the screen asks again every 1.5 s. */
    private boolean busy() { return running() || refreshing(); }

    void load() {
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
    private void post(String path, Object... kv) { post(path, null, kv); }

    /** The same, then `then` once the PC took it (a refusal is a toast with its reason). */
    private void post(String path, Runnable then, Object... kv) {
        if (hub == null) return;
        final Hub h = hub;
        JSONObject body = new JSONObject();
        try { for (int i = 0; i + 1 < kv.length; i += 2) body.put((String) kv[i], kv[i + 1]); } catch (Exception ignored) { }
        Ui.pool.execute(() -> {
            try {
                JSONObject v = h.call("POST", "/v1/collector/" + path, body);
                Ui.main.post(() -> {
                    if (v != null && v.has("settings")) view = v;
                    draw();
                    if (then != null) then.run();
                });
            } catch (Exception e) {
                Ui.main.post(() -> { Ui.toast(this, h.whyDown(e)); load(); });
            }
        });
    }

    private JSONObject settings() {
        JSONObject s = view == null ? null : view.optJSONObject("settings");
        return s == null ? new JSONObject() : s;
    }

    private String platform() { return settings().optString("platform", "youtube"); }

    private JSONObject session(String platform) {
        JSONArray a = view == null ? null : view.optJSONArray("sessions");
        for (int i = 0; a != null && i < a.length(); i++) {
            JSONObject o = a.optJSONObject(i);
            if (o != null && platform.equals(o.optString("platform"))) return o;
        }
        return null;
    }

    // ---------- the screen ----------

    private void draw() {
        counts.removeAllViews();
        run.removeAllViews();
        daily.removeAllViews();
        actions.removeAllViews();
        list.removeAllViews();
        if (hub == null || view == null) {
            form.removeAllViews();
            formSig = "";
            cookie = null;
            list.addView(Ds.empty(this, hub == null ? "Pair this phone with a PC to use Collector." : note.isEmpty() ? "Loading…" : note), Ui.fill());
            return;
        }
        JSONObject c = view.optJSONObject("counts");
        int n = c == null ? 0 : c.optInt("creators");
        if (c != null) {
            List<String> parts = new ArrayList<>();
            parts.add(n + (n == 1 ? " creator" : " creators"));
            if (c.optInt("emails") > 0) parts.add(c.optInt("emails") + " with email");
            if (c.optInt("contacted") > 0) parts.add(c.optInt("contacted") + " contacted");
            if (c.optInt("remembered") > 0) parts.add(c.optInt("remembered") + " remembered");
            TextView t = Ui.text(this, TextUtils.join(" · ", parts), 13, Ui.G700);
            t.setPadding(0, Ui.dp(2), 0, Ui.dp(4));
            counts.addView(t, Ui.weight());
        }
        drawForm();
        drawRun();
        drawDaily(n);
        drawActions(n);
        drawRows();
        Ui.main.removeCallbacks(poll);
        if (busy()) Ui.main.postDelayed(poll, 1500);
    }

    /** The form: rebuilt only when what it shows changes (so typing keeps its field). */
    private void drawForm() {
        JSONObject s = settings();
        boolean going = running();
        JSONObject ig = session("instagram");
        StringBuilder sig = new StringBuilder(platform() + "|" + s.optInt("gapDays") + "|" + going);
        JSONArray src = view.optJSONArray("sources");
        for (int i = 0; src != null && i < src.length(); i++) {
            JSONObject o = src.optJSONObject(i);
            if (o != null) sig.append('|').append(o.optString("value")).append(o.optBoolean("available")).append(o.optString("why"));
        }
        if (ig != null) sig.append("|ig").append(ig.optBoolean("connected")).append(ig.optString("account"));
        String qv = s.optString("query");
        int t = s.optInt("target");
        if (sig.toString().equals(formSig) && query != null) {
            if (System.currentTimeMillis() - typed > 2000) {
                if (!query.hasFocus() && !query.getText().toString().equals(qv)) query.setText(qv);
                if (!target.hasFocus()) {
                    String tv = t > 0 ? String.valueOf(t) : "";
                    if (!target.getText().toString().equals(tv)) target.setText(tv);
                }
            }
            return;
        }
        formSig = sig.toString();
        form.removeAllViews();
        LinearLayout card = Ds.card(this);
        TextView head = Ds.caps(this, "PLATFORM", true);
        head.setPadding(0, 0, 0, Ui.dp(6));
        card.addView(head, Ui.fill());
        HorizontalScrollView hs = new HorizontalScrollView(this);
        hs.setHorizontalScrollBarEnabled(false);
        LinearLayout chips = Ui.row(this);
        String picked = platform(), pickedNote = "";
        List<String> whys = new ArrayList<>();
        for (int i = 0; src != null && i < src.length(); i++) {
            JSONObject o = src.optJSONObject(i);
            if (o == null) continue;
            final String value = o.optString("value");
            boolean avail = o.optBoolean("available");
            if (value.equals(picked)) pickedNote = o.optString("note");
            if (!avail && !o.optString("why").isEmpty()) whys.add(o.optString("why"));
            // An unavailable platform can still be picked (Instagram: its session card shows then); Start says why not.
            TextView chip = Ds.chip(this, o.optString("label"), value.equals(picked), going ? null : v -> post("settings", "platform", value));
            if (!avail) chip.setAlpha(0.5f);
            LinearLayout.LayoutParams lp = Ui.wrap();
            lp.rightMargin = Ui.dp(6);
            chips.addView(chip, lp);
        }
        hs.addView(chips);
        card.addView(hs, Ui.fill());
        for (String w : whys) card.addView(pad(Ui.text(this, w, 13, Ui.AMBER), 6), Ui.fill());
        if (!pickedNote.isEmpty()) card.addView(pad(Ui.text(this, pickedNote, 12.5f, Ui.G600), 6), Ui.fill());
        if ("instagram".equals(picked) && ig != null) card.addView(sessionCard(ig, going), Ui.margins(Ui.fill(), 0, 8, 0, 2));
        card.addView(pad(Ui.text(this, "Search term", 13, Ui.G700), 12), Ui.fill());
        query = Ui.input(this, "e.g. blox fruits brasil", false);
        query.setText(qv);
        query.setEnabled(!going);
        query.setImeOptions(EditorInfo.IME_ACTION_GO);
        query.setOnEditorActionListener((v, id, e) -> { start(); return true; });
        query.addTextChangedListener(new Watch(() -> post("settings", "query", query.getText().toString())));
        card.addView(query, Ui.fill());
        LinearLayout tr = Ui.row(this);
        tr.setGravity(Gravity.CENTER_VERTICAL);
        tr.setPadding(0, Ui.dp(10), 0, 0);
        LinearLayout tl = Ui.col(this);
        tl.addView(Ui.text(this, "Target", 14, Ui.G700), Ui.wrap());
        tl.addView(Ui.text(this, "New creators to find; empty = all", 12, Ui.G600), Ui.wrap());
        tr.addView(tl, Ui.weight());
        tr.addView(Ui.rowButton(this, "−", false, going ? null : v -> step(-10)));
        target = Ui.input(this, "All", false);
        target.setInputType(InputType.TYPE_CLASS_NUMBER);
        target.setGravity(Gravity.CENTER);
        target.setText(t > 0 ? String.valueOf(t) : "");
        target.setEnabled(!going);
        target.addTextChangedListener(new Watch(() -> post("settings", "target", target.getText().toString())));
        LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(Ui.dp(84), -2);
        tlp.leftMargin = Ui.dp(6);
        tlp.rightMargin = Ui.dp(6);
        tr.addView(target, tlp);
        tr.addView(Ui.rowButton(this, "+", false, going ? null : v -> step(10)));
        card.addView(tr, Ui.fill());
        card.addView(pad(Ui.text(this, "Last upload", 13, Ui.G700), 12), Ui.fill());
        HorizontalScrollView gs = new HorizontalScrollView(this);
        gs.setHorizontalScrollBarEnabled(false);
        LinearLayout gaps = Ui.row(this);
        JSONArray ga = view.optJSONArray("gaps");
        for (int i = 0; ga != null && i < ga.length(); i++) {
            JSONObject g = ga.optJSONObject(i);
            if (g == null) continue;
            final int days = g.optInt("value");
            LinearLayout.LayoutParams lp = Ui.wrap();
            lp.rightMargin = Ui.dp(6);
            gaps.addView(Ds.chip(this, g.optString("label"), days == s.optInt("gapDays"), going ? null : v -> post("settings", "gapDays", days)), lp);
        }
        gs.addView(gaps);
        card.addView(gs, Ui.fill());
        TextView go = going ? stopButton(this, "Stop", v -> post("stop")) : Ui.button(this, "Start", true, v -> start());
        LinearLayout.LayoutParams gl = Ui.fill();
        gl.topMargin = Ui.dp(14);
        card.addView(go, gl);
        form.addView(card, Ui.fill());
    }

    /** Instagram's session, when Instagram is picked: who it's signed in as (and Remove), or how to get one and a
     *  field to paste it in (hidden like a password; it stays on the PC, never shown again). */
    private View sessionCard(JSONObject ig, boolean going) {
        LinearLayout box = Ui.col(this);
        box.setBackground(Ui.round(Ui.G100, 0, 12));
        box.setPadding(Ui.dp(12), Ui.dp(10), Ui.dp(12), Ui.dp(12));
        cookie = null;
        if (ig.optBoolean("connected")) {
            LinearLayout r = Ui.row(this);
            String acc = ig.optString("account", "");
            if ("null".equals(acc)) acc = "";
            r.addView(Ui.icon(this, Ui.I_CIRCLE_CHECK, 16, Ui.GREEN), new LinearLayout.LayoutParams(Ui.dp(20), Ui.dp(20)));
            TextView who = Ui.text(this, acc.isEmpty() ? "Instagram session saved" : "Signed in as @" + acc, 14, Ui.FG);
            who.setPadding(Ui.dp(8), 0, 0, 0);
            r.addView(who, Ui.weight());
            r.addView(Ui.danger(Ui.rowButton(this, "Remove", false, going ? null : v ->
                    post("session-clear", () -> Ui.toast(this, "Instagram session removed"), "platform", "instagram"))));
            box.addView(r, Ui.fill());
            return box;
        }
        box.addView(Ui.bold(this, "Instagram session", 14, Ui.FG), Ui.fill());
        TextView help = Ui.text(this, ig.optString("help"), 12.5f, Ui.G700);
        help.setPadding(0, Ui.dp(4), 0, Ui.dp(8));
        box.addView(help, Ui.fill());
        final EditText f = Ui.input(this, "sessionid=…; csrftoken=…", false);
        f.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        f.setTypeface(Ui.sans);
        cookie = f;
        box.addView(f, Ui.fill());
        TextView save = Ui.button(this, "Save", true, null);
        save.setOnClickListener(v -> {
            String val = f.getText().toString().trim();
            if (val.isEmpty()) { Ui.toast(this, "Paste the cookies first."); return; }
            save.setEnabled(false);
            save.setText("Checking…");
            if (hub == null) return;
            final Hub h = hub;
            JSONObject b = new JSONObject();
            try { b.put("platform", "instagram").put("cookie", val); } catch (Exception ignored) { }
            Ui.pool.execute(() -> {
                try {
                    JSONObject r = h.call("POST", "/v1/collector/session", b, 60_000);
                    Ui.main.post(() -> {
                        if (r != null && r.has("settings")) view = r;
                        Ui.toast(this, "Instagram session saved");
                        draw();
                    });
                } catch (Exception e) {
                    Ui.main.post(() -> {
                        save.setEnabled(true);
                        save.setText("Save");
                        Ui.toast(this, h.whyDown(e));
                    });
                }
            });
        });
        box.addView(save, Ui.margins(Ui.fill(), 0, 8, 0, 0));
        return box;
    }

    private void start() {
        if (running() || query == null) return;
        typed = 0;
        hideKeyboard();
        post("start", "query", query.getText().toString().trim(), "target", target.getText().toString());
    }

    private void step(int d) {
        int cur = 0;
        try { cur = Integer.parseInt(target.getText().toString().trim()); } catch (Exception ignored) { }
        int next = Math.max(0, cur + d);
        target.setText(next > 0 ? String.valueOf(next) : "");
        typed = 0;
        post("settings", "target", next);
    }

    /** The run: what's going (or went), its clock, found / target, passed over, the log's tail. */
    private void drawRun() {
        JSONObject r = view.optJSONObject("run");
        if (r == null) return;
        boolean going = r.optBoolean("running");
        LinearLayout card = Ds.card(this);
        LinearLayout head = Ui.row(this);
        head.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = Ui.bold(this, r.optString("label") + " · “" + r.optString("query") + "”", 15, Ui.FG);
        Ui.subtitle(title);
        head.addView(title, Ui.weight());
        head.addView(Ui.text(this, clock(r.optInt("elapsed")), 13, Ui.G700));
        card.addView(head, Ui.fill());
        int found = r.optInt("found"), tgt = r.optInt("target");
        float frac = tgt > 0 ? Math.min(1f, found / (float) tgt) : going ? 0f : 1f;
        card.addView(bar(this, frac, going), barLp());
        String status = tgt > 0 ? found + " of " + tgt + " creators" : found + (found == 1 ? " creator" : " creators");
        card.addView(Ui.text(this, status, 13.5f, Ui.FG), Ui.fill());
        List<String> meta = new ArrayList<>();
        if (r.optInt("considered") > 0) meta.add(r.optInt("considered") + " checked");
        if (r.optInt("dropped") > 0) meta.add(r.optInt("dropped") + " dropped");
        if (r.optInt("known") > 0) meta.add(r.optInt("known") + " passed over (seen before)");
        if (!meta.isEmpty()) card.addView(Ui.text(this, TextUtils.join(" · ", meta), 12.5f, Ui.G700), Ui.fill());
        String st = r.optString("status");
        if (!st.isEmpty()) card.addView(pad(Ui.text(this, st, 12.5f, Ui.G600), 2), Ui.fill());
        LinearLayout tg = Ui.row(this);
        TextView toggle = Ui.text(this, logOpen ? "Hide log" : "Show log", 13, Ui.FG);
        toggle.setPadding(0, Ui.dp(10), Ui.dp(16), Ui.dp(4));
        toggle.setOnClickListener(v -> { logOpen = !logOpen; draw(); });
        tg.addView(toggle, Ui.wrap());
        if (logOpen && !going) {
            TextView cl = Ui.text(this, "Clear log", 13, Ui.G700);
            cl.setPadding(0, Ui.dp(10), 0, Ui.dp(4));
            cl.setOnClickListener(v -> post("clear-log"));
            tg.addView(cl, Ui.wrap());
        }
        card.addView(tg, Ui.fill());
        if (logOpen) {
            JSONArray log = view.optJSONArray("log");
            int from = log == null ? 0 : Math.max(0, log.length() - 40);
            for (int i = from; log != null && i < log.length(); i++) {
                JSONObject l = log.optJSONObject(i);
                if (l == null) continue;
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

    /** The daily update: on/off, how far it is, when it ran and runs next, Update all now / Stop. */
    private void drawDaily(int n) {
        JSONObject r = view.optJSONObject("refresh");
        if (r == null) return;
        boolean going = r.optBoolean("running");
        LinearLayout card = Ds.card(this);
        LinearLayout head = Ui.row(this);
        LinearLayout ht = Ui.col(this);
        ht.addView(Ui.bold(this, "Daily update", 15, Ui.FG), Ui.wrap());
        ht.addView(Ui.text(this, "Stats, links and emails of everyone collected, once a day", 12.5f, Ui.G600), Ui.wrap());
        head.addView(ht, Ui.weight());
        Switch sw = new Switch(this);
        sw.setChecked(r.optBoolean("daily"));
        sw.setOnCheckedChangeListener((b, on) -> post("settings", "daily", on));
        sw.setContentDescription("Daily update");
        head.addView(sw);
        card.addView(head, Ui.fill());
        if (going) {
            int done = r.optInt("done"), total = r.optInt("total");
            card.addView(bar(this, total > 0 ? Math.min(1f, done / (float) total) : 0f, true), barLp());
            List<String> p = new ArrayList<>();
            p.add(done + " of " + total + " updated");
            if (r.optInt("changed") > 0) p.add(r.optInt("changed") + " changed");
            if (r.optInt("failed") > 0) p.add(r.optInt("failed") + " failed");
            card.addView(Ui.text(this, TextUtils.join(" · ", p), 13.5f, Ui.FG), Ui.fill());
        }
        String st = r.optString("status");
        if (!st.isEmpty()) card.addView(pad(Ui.text(this, st, 13, Ui.G700), 8), Ui.fill());
        List<String> when = new ArrayList<>();
        if (!r.optString("last").isEmpty()) when.add("Last full update " + r.optString("last"));
        if (r.optBoolean("daily") && !r.optString("next").isEmpty()) when.add("next " + r.optString("next"));
        if (r.optInt("due") > 0) when.add(r.optInt("due") + " due");
        if (!r.optBoolean("daily")) when.add("Off: nobody is updated by itself");
        if (!when.isEmpty()) card.addView(pad(Ui.text(this, TextUtils.join(" · ", when), 12.5f, Ui.G600), 4), Ui.fill());
        TextView b = going ? stopButton(this, "Stop", v -> post("refresh", "stop", true))
                : Ui.button(this, "Update all now", false, n == 0 ? null : v -> post("refresh"));
        if (!going && n == 0) b.setAlpha(0.5f);
        card.addView(b, Ui.margins(Ui.fill(), 0, 10, 0, 0));
        LinearLayout.LayoutParams cl = Ui.fill();
        cl.topMargin = Ui.dp(12);
        daily.addView(card, cl);
    }

    private void drawActions(int n) {
        if (n == 0) return;
        actions.setPadding(0, Ui.dp(16), 0, Ui.dp(4));
        actions.setGravity(Gravity.CENTER_VERTICAL);
        TextView head = Ds.caps(this, n + (n == 1 ? " CREATOR" : " CREATORS"), false);
        head.setPadding(Ui.dp(4), 0, 0, 0);
        actions.addView(head, Ui.weight());
        actions.addView(Ui.rowButton(this, "Copy JSONL", true, v -> copy()));
        LinearLayout.LayoutParams lp = Ui.wrap();
        lp.leftMargin = Ui.dp(6);
        TextView clear = Ui.rowButton(this, confirmClear ? "Clear " + n + "?" : "Clear", false, running() ? null : v -> {
            if (!confirmClear) {
                confirmClear = true;
                draw();
                Ui.main.postDelayed(() -> { if (confirmClear) { confirmClear = false; draw(); } }, 5000);
                return;
            }
            confirmClear = false;
            post("clear", () -> Ui.toast(this, "Cleared. They stay remembered, so later runs won't collect them again."));
        });
        if (confirmClear) Ui.danger(clear);
        actions.addView(clear, lp);
    }

    private void copy() {
        if (hub == null) return;
        final Hub h = hub;
        Ui.pool.execute(() -> {
            try {
                JSONObject r = h.get("/v1/collector/export");
                Ui.main.post(() -> {
                    Ui.copy(this, r.optString("text"));
                    Ui.toast(this, "Copied " + r.optInt("count") + " creator(s). Paste into SpokPayCRM → Creators → Import.");
                });
            } catch (Exception e) {
                Ui.main.post(() -> Ui.toast(this, h.whyDown(e)));
            }
        });
    }

    private void drawRows() {
        JSONArray rows = view.optJSONArray("creators");
        if (rows == null || rows.length() == 0) {
            if (!running()) list.addView(Ds.empty(this, "No creators yet. Pick a platform, search a term and press Start."), Ui.fill());
            return;
        }
        for (int i = 0; i < rows.length(); i++) {
            JSONObject r = rows.optJSONObject(i);
            if (r != null) list.addView(row(r), Ui.fill());
        }
    }

    /** One creator: avatar, name and platform, handle, stats, the email (or that there's none yet), what the daily
     *  update changed, whether they were written to. A tap opens them; a long press has the quick actions. */
    private View row(JSONObject r) {
        LinearLayout row = Ui.row(this);
        row.setGravity(Gravity.TOP);
        row.setPadding(Ui.dp(4), Ui.dp(10), Ui.dp(4), Ui.dp(10));
        row.setBackground(Ui.press(0, 0, 12));
        final String name = r.optString("name"), rid = r.optString("id"), url = r.optString("url"), email = r.optString("email");
        row.addView(avatar(this, hub, r, 44));
        LinearLayout text = Ui.col(this);
        text.setPadding(Ui.dp(12), 0, Ui.dp(4), 0);
        LinearLayout l1 = Ui.row(this);
        l1.addView(Ui.subtitle(Ui.bold(this, name, 15, Ui.FG)), new LinearLayout.LayoutParams(0, -2, 1));
        if (!r.optString("platform").isEmpty()) l1.addView(badge(this, r.optString("platform"), Ui.G700), Ui.margins(Ui.wrap(), 6, 0, 0, 0));
        text.addView(l1, Ui.fill());
        String sub = r.optString("sub");
        if (!sub.isEmpty()) text.addView(Ui.subtitle(Ui.text(this, sub, 12.5f, Ui.G700)), Ui.fill());
        LinearLayout l3 = Ui.row(this);
        String stats = r.optString("stats");
        if (!stats.trim().isEmpty()) l3.addView(Ui.subtitle(Ui.text(this, stats, 12.5f, Ui.G600)), new LinearLayout.LayoutParams(0, -2, 1));
        else l3.addView(new View(this), new LinearLayout.LayoutParams(0, 0, 1));
        if (r.optBoolean("discord")) l3.addView(badge(this, "Discord", Ui.BLUE), Ui.margins(Ui.wrap(), 6, 0, 0, 0));
        text.addView(l3, Ui.fill());
        TextView em = email.isEmpty() ? Ui.text(this, "No email yet", 12.5f, Ui.G600)
                : Ui.text(this, email + (r.optString("emailSource").isEmpty() ? "" : "  · " + r.optString("emailSource")), 12.5f, Ui.FG);
        Ui.subtitle(em);
        text.addView(em, Ui.fill());
        String changed = r.optString("changed");
        if (!changed.isEmpty()) {
            TextView ch = Ui.text(this, changed, 12.5f, Ui.AMBER);
            ch.setMaxLines(2);
            ch.setEllipsize(TextUtils.TruncateAt.END);
            text.addView(ch, Ui.fill());
        }
        String upd = r.optString("updated");
        if (upd.startsWith("Update failed")) text.addView(Ui.subtitle(Ui.text(this, upd, 12, Ui.RED)), Ui.fill());
        LinearLayout l5 = Ui.row(this);
        String meta = r.optString("meta");
        l5.addView(Ui.subtitle(Ui.text(this, meta, 12, Ui.G600)), new LinearLayout.LayoutParams(0, -2, 1));
        if (!r.optString("contacted").isEmpty()) l5.addView(badge(this, r.optString("contacted"), Ui.GREEN), Ui.margins(Ui.wrap(), 6, 0, 0, 0));
        if (!meta.isEmpty() || l5.getChildCount() > 1) text.addView(l5, Ui.margins(Ui.fill(), 0, 2, 0, 0));
        row.addView(text, Ui.weight());
        row.setOnClickListener(v -> openCreator(rid));
        row.setOnLongClickListener(v -> {
            List<Ds.Item> items = new ArrayList<>(Arrays.asList(
                    Ds.item(Ui.I_SEND, "Send message", () -> push(new CollectorCreator.Compose(this, rid, name))),
                    Ds.item(Ui.I_EXTERNAL, "Open profile", () -> { if (!url.isEmpty()) Ui.openUrl(this, url); }),
                    Ds.item(Ui.I_COPY, "Copy link", () -> Ui.copy(this, url))));
            if (!email.isEmpty()) items.add(Ds.item(Ui.I_COPY, "Copy email", () -> Ui.copy(this, email)));
            items.add(Ds.item(Ui.I_REFRESH, "Update now", () -> updateOne(rid)));
            items.add(Ds.sep());
            items.add(Ds.danger(Ui.I_TRASH, "Remove from the list", () -> post("remove", () -> Ui.toast(this, name + " removed. They stay remembered."), "id", rid)));
            Ds.menu(this, items);
            return true;
        });
        return row;
    }

    void openCreator(String id) { push(new CollectorCreator(this, id)); }

    /** POST refresh {id}: one creator now (from the row's menu). */
    private void updateOne(String id) {
        if (hub == null) return;
        final Hub h = hub;
        Ui.toast(this, "Updating…");
        JSONObject b = new JSONObject();
        try { b.put("id", id); } catch (Exception ignored) { }
        Ui.pool.execute(() -> {
            try {
                JSONObject d = h.call("POST", "/v1/collector/refresh", b, 120_000);
                Ui.main.post(() -> {
                    String u = d == null ? "" : d.optString("updated");
                    Ui.toast(this, u.isEmpty() ? "Updated" : u);
                    load();
                });
            } catch (Exception e) {
                Ui.main.post(() -> Ui.toast(this, h.whyDown(e)));
            }
        });
    }

    // ---------- shared with the creator's screens ----------

    static TextView pad(TextView t, int top) {
        t.setPadding(0, Ui.dp(top), 0, Ui.dp(6));
        return t;
    }

    /** A small tag (a platform, "Emailed 25 Nov", Discord): its colour on a quiet fill. */
    static TextView badge(Context c, String s, int color) {
        TextView t = Ui.bold(c, s, 11, color);
        t.setSingleLine(true);
        t.setIncludeFontPadding(false);
        t.setPadding(Ui.dp(7), Ui.dp(3), Ui.dp(7), Ui.dp(3));
        t.setBackground(Ui.round(Ui.G200, 0, 8));
        return t;
    }

    /** A Stop control: the shared red pill. */
    static TextView stopButton(Context c, String label, View.OnClickListener on) {
        TextView t = Ui.button(c, label, true, on);
        t.setTextColor(Ui.ON_STOP);
        t.setBackground(Ui.press(Ui.STOP, 0, 24));
        return t;
    }

    static LinearLayout bar(Context c, float frac, boolean going) {
        LinearLayout bar = Ui.row(c);
        bar.setBackground(Ui.round(Ui.G200, 0, 3));
        View fill = new View(c);
        fill.setBackground(Ui.round(going ? Ui.BLUE : Ui.GREEN, 0, 3));
        bar.addView(fill, new LinearLayout.LayoutParams(0, Ui.dp(6), frac));
        bar.addView(new View(c), new LinearLayout.LayoutParams(0, Ui.dp(6), 1 - frac));
        return bar;
    }

    private static LinearLayout.LayoutParams barLp() {
        LinearLayout.LayoutParams bl = Ui.fill();
        bl.topMargin = Ui.dp(10);
        bl.bottomMargin = Ui.dp(8);
        return bl;
    }

    static String clock(int secs) {
        return (secs / 60) + ":" + String.format(java.util.Locale.ROOT, "%02d", secs % 60);
    }

    /** A creator's picture (the PC's cached copy), their initials on their colour until it's there. */
    static View avatar(Base a, Hub hub, JSONObject r, float size) {
        String id = r.optString("avatarId", "");
        String name = r.optString("name");
        return PersonsUi.avatar(a, hub, id.isEmpty() || "null".equals(id) ? null : "/v1/collector/avatar?id=" + id, initials(name), color(r.optString("id")), size, null);
    }

    static String initials(String name) {
        String[] w = name.replaceAll("[^\\p{L}\\p{N}\\s]", " ").trim().split("\\s+");
        if (w.length == 0 || w[0].isEmpty()) return "?";
        if (w.length > 1) return (w[0].substring(0, 1) + w[w.length - 1].substring(0, 1)).toUpperCase();
        return w[0].substring(0, Math.min(2, w[0].length())).toUpperCase();
    }

    private static final String[] COLORS = {"#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#06b6d4", "#ec4899", "#84cc16", "#f97316", "#8b5cf6", "#0ea5e9"};

    static int color(String id) {
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
