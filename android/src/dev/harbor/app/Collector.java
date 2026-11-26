package dev.harbor.app;

import android.content.Context;
import android.os.Bundle;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Hub's Collector tab: leads (content creators) from YouTube, TikTok and Instagram. Three views under the title,
 *  picked with chips: Collector (the search form, one line while a run goes, the leads it found), Available (every
 *  lead not Restricted, with one filter box) and Restricted. A lead is a card: picture, name, platform, handle and
 *  profile link, email (tap to type one), the 3 newest videos (tap opens), Send message (adds them to Persons ›
 *  Creators) and Restrict / Unrestrict. The runs happen on the PC (Hub's engine, ts/tabs/collector): this screen
 *  draws GET /v1/collector, as the PC's window does, and sends each change there. Send message
 *  (CollectorCreator.Compose) and a lead's detail (CollectorCreator.Detail, a tap on its card) open over the tab,
 *  without the tab bar; Back closes them. */
public class Collector extends Base {
    private LinearLayout segs, form, runRow, list;
    private EditText query, target, cookie, filter;
    private JSONObject view;
    private boolean loading;
    private String formSig = "", note = "";
    /** The view on screen: "collector", "available", "approved" or "restricted". */
    private String sel = "collector";
    private long typed;
    /** The screens open over the tab (Send message), the top one last. */
    private final List<Screen> stack = new ArrayList<>();
    private final Runnable poll = new Runnable() {
        @Override public void run() { if (front && running()) load(); }
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
        String p = getIntent().getStringExtra("page");
        if ("available".equals(p) || "approved".equals(p) || "restricted".equals(p)) sel = p;
        LinearLayout col = Ui.col(this);
        LinearLayout top = Ui.col(this);
        top.setPadding(Ui.dp(20), Ui.dp(14), Ui.dp(12), Ui.dp(2));
        top.addView(Ds.pageTitle(this, "Collector"), Ui.fill());
        segs = Ui.row(this);
        segs.setPadding(0, Ui.dp(8), 0, Ui.dp(6));
        top.addView(segs, Ui.fill());
        col.addView(top, Ui.fill());
        ScrollView scroll = new ScrollView(this);
        LinearLayout body = Ui.col(this);
        body.setPadding(Ui.dp(16), Ui.dp(6), Ui.dp(16), Ui.dp(24));
        form = Ui.col(this);
        runRow = Ui.row(this);
        filter = Ui.input(this, "Filter by name, handle, email or platform", false);
        filter.setImeOptions(EditorInfo.IME_ACTION_DONE);
        filter.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int a, int b, int c) { }
            @Override public void onTextChanged(CharSequence s, int a, int b, int c) { }
            @Override public void afterTextChanged(Editable e) { if (filter.hasFocus()) drawList(); }
        });
        list = Ui.col(this);
        body.addView(form, Ui.fill());
        body.addView(runRow, Ui.fill());
        body.addView(filter, Ui.margins(Ui.fill(), 0, 4, 0, 10));
        body.addView(list, Ui.fill());
        scroll.addView(body);
        col.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        page = Tabs.around(this, col, Tabs.COLLECTOR);
        setContentView(page);
        draw();
        // Send message or a lead's detail opened straight away: the phone screenshot rig (screen:collector-send, collector-detail).
        String c = getIntent().getStringExtra("creator");
        if (c != null && !c.isEmpty() && getIntent().getBooleanExtra("send", false)) push(new CollectorCreator.Compose(this, c, getIntent().getStringExtra("name")));
        else if (c != null && !c.isEmpty() && getIntent().getBooleanExtra("detail", false)) push(new CollectorCreator.Detail(this, c, getIntent().getStringExtra("name")));
    }

    @Override
    protected void onResume() {
        super.onResume();
        hub = Tabs.hub(this);
        // On screen: its finished runs are seen (no count on the tab, here or on the PC).
        Tabs.collectorSeen(hub);
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

    /** The top screen swapped for another (the review bar's next lead). */
    void replace(Screen s) {
        hideKeyboard();
        if (stack.isEmpty()) { push(s); return; }
        stack.set(stack.size() - 1, s);
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

    void load() {
        if (hub == null) { draw(); return; }
        if (loading) return;
        loading = true;
        final Hub h = hub;
        Ui.pool.execute(() -> {
            try {
                JSONObject v = h.get("/v1/collector");
                Ui.main.post(() -> {
                    loading = false; view = v; note = ""; draw();
                    // A run that ended while this screen is up is seen at once.
                    if (front && v != null && v.optInt("unseen", 0) > 0) Tabs.collectorSeen(h);
                });
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
        segs.removeAllViews();
        runRow.removeAllViews();
        boolean lists = !"collector".equals(sel);
        form.setVisibility(lists ? View.GONE : View.VISIBLE);
        filter.setVisibility(lists && view != null ? View.VISIBLE : View.GONE);
        if (hub == null || view == null) {
            form.removeAllViews();
            formSig = "";
            cookie = null;
            list.removeAllViews();
            list.addView(Ds.empty(this, hub == null ? "Pair this phone with a PC to use Collector." : note.isEmpty() ? "Loading…" : note), Ui.fill());
            return;
        }
        JSONObject c = view.optJSONObject("counts");
        int avail = c == null ? 0 : c.optInt("available"), appr = c == null ? 0 : c.optInt("approved"), restr = c == null ? 0 : c.optInt("restricted");
        seg("collector", running() ? "Collector · running" : "Collector");
        seg("available", "Available" + (avail > 0 ? " " + avail : ""));
        seg("approved", "Approved" + (appr > 0 ? " " + appr : ""));
        seg("restricted", "Restricted" + (restr > 0 ? " " + restr : ""));
        if (!lists) {
            drawForm();
            drawRun();
        }
        drawList();
        Ui.main.removeCallbacks(poll);
        if (running()) Ui.main.postDelayed(poll, 1500);
    }

    /** One of the four views; a tap shows it. */
    private void seg(String id, String label) {
        LinearLayout.LayoutParams lp = Ui.wrap();
        lp.rightMargin = Ui.dp(6);
        segs.addView(Ds.chip(this, label, id.equals(sel), v -> {
            if (id.equals(sel)) return;
            sel = id;
            hideKeyboard();
            draw();
        }), lp);
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
        query = Ui.input(this, "e.g. dress to impress", false);
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
        tl.addView(Ui.text(this, "Leads", 14, Ui.G700), Ui.wrap());
        tl.addView(Ui.text(this, "New leads to find; empty = all", 12, Ui.G600), Ui.wrap());
        tr.addView(tl, Ui.weight());
        tr.addView(Ui.rowButton(this, "−", false, going ? null : v -> step(-5)));
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
        tr.addView(Ui.rowButton(this, "+", false, going ? null : v -> step(5)));
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
        TextView go = going ? stopButton(this, "Stop", v -> post("stop")) : Ui.button(this, "Collect", true, v -> start());
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

    /** The run's one line: found so far and what it does while it goes; how it ended after. */
    private void drawRun() {
        JSONObject r = view.optJSONObject("run");
        if (r == null) return;
        boolean going = r.optBoolean("running");
        runRow.setGravity(Gravity.CENTER_VERTICAL);
        runRow.setPadding(Ui.dp(4), Ui.dp(12), Ui.dp(4), Ui.dp(4));
        if (going) {
            ProgressBar pb = new ProgressBar(this);
            pb.setIndeterminate(true);
            runRow.addView(pb, new LinearLayout.LayoutParams(Ui.dp(16), Ui.dp(16)));
        }
        int found = r.optInt("found"), tgt = r.optInt("target");
        String line = going ? (tgt > 0 ? found + " of " + tgt : found + " found") + " · " + (r.optString("line").isEmpty() ? "Searching…" : r.optString("line")) : r.optString("status");
        TextView t = Ui.subtitle(Ui.text(this, line, 13, going ? Ui.FG : Ui.G600));
        t.setPadding(going ? Ui.dp(8) : 0, 0, 0, 0);
        runRow.addView(t, Ui.weight());
    }

    /** Which list a lead is in: Restricted, Approved, else Available. */
    static String listOf(JSONObject o) {
        return o.optBoolean("restricted") ? "restricted" : o.optBoolean("approved") ? "approved" : "available";
    }

    /** The leads a view shows, in its order: the run's (still pending) on Collector, the others' list filtered by `f`. */
    private List<JSONObject> rowsFor(String which, String f) {
        List<JSONObject> rows = new ArrayList<>();
        if (view == null) return rows;
        JSONArray all = view.optJSONArray("creators");
        if ("collector".equals(which)) {
            JSONObject r = view.optJSONObject("run");
            Map<String, JSONObject> byId = new HashMap<>();
            for (int i = 0; all != null && i < all.length(); i++) {
                JSONObject o = all.optJSONObject(i);
                if (o != null) byId.put(o.optString("id"), o);
            }
            JSONArray ids = r == null ? null : r.optJSONArray("ids");
            for (int i = ids == null ? -1 : ids.length() - 1; ids != null && i >= 0; i--) {
                JSONObject o = byId.get(ids.optString(i));
                if (o != null && "available".equals(listOf(o))) rows.add(o);
            }
            return rows;
        }
        for (int i = 0; all != null && i < all.length(); i++) {
            JSONObject o = all.optJSONObject(i);
            if (o == null || !which.equals(listOf(o))) continue;
            String hay = (o.optString("name") + " " + o.optString("handle") + " " + o.optString("email") + " " + o.optString("platform") + " " + o.optString("short")).toLowerCase(Locale.ROOT);
            if (f.isEmpty() || hay.contains(f)) rows.add(o);
        }
        return rows;
    }

    /** The ids the view shows now (the review bar's list: it goes through them in this order). */
    List<String> rowIds() {
        List<String> ids = new ArrayList<>();
        for (JSONObject o : rowsFor(sel, filter.getText().toString().trim().toLowerCase(Locale.ROOT))) ids.add(o.optString("id"));
        return ids;
    }

    /** A lead's name from the view ("" when it's gone). */
    String nameOf(String id) {
        JSONArray all = view == null ? null : view.optJSONArray("creators");
        for (int i = 0; all != null && i < all.length(); i++) {
            JSONObject o = all.optJSONObject(i);
            if (o != null && id.equals(o.optString("id"))) return o.optString("name");
        }
        return "";
    }

    /** The lead after `current` in `queue` that is still in `live` (the review bar's next); null at the end. */
    static String nextLead(List<String> queue, String current, List<String> live) {
        int at = queue.indexOf(current);
        if (at < 0) return null;
        for (int i = at + 1; i < queue.size(); i++) if (!queue.get(i).equals(current) && live.contains(queue.get(i))) return queue.get(i);
        return null;
    }

    /** The review bar: "reject" (to Restricted), "skip" (as it is), "approve" (to `to`: "list" or "persons"); then the
     *  next lead of the list the detail was opened from, or back to the list with "All reviewed". */
    void review(String id, String name, String what, String to, List<String> queue) {
        Runnable next = () -> {
            String n = nextLead(queue, id, rowIds());
            if (n == null) {
                pop();
                Ui.toast(this, "All reviewed");
            } else replace(new CollectorCreator.Detail(this, n, nameOf(n), queue));
        };
        if ("reject".equals(what)) post("restrict", next, "id", id, "restricted", true);
        else if ("approve".equals(what)) post("approve", () -> {
            Ui.toast(this, "persons".equals(to) ? name + " approved and added to Persons › Creators" : name + " approved");
            next.run();
        }, "id", id, "approved", true, "to", to);
        else next.run();
    }

    /** The review bar's Approve to, remembered on the PC. */
    String approveTo() { return settings().optString("approveTo", "list"); }

    JSONArray approveChoices() { return view == null ? null : view.optJSONArray("approveTo"); }

    void setApproveTo(String v) {
        try { settings().put("approveTo", v); } catch (Exception ignored) { }
        post("settings", "approveTo", v);
    }

    /** The leads of the view: the run's on Collector, Available's, Approved's or Restricted's (filtered) on the others. */
    private void drawList() {
        list.removeAllViews();
        if (view == null) return;
        List<JSONObject> rows;
        String empty;
        if ("collector".equals(sel)) {
            JSONObject r = view.optJSONObject("run");
            rows = rowsFor("collector", "");
            if (r == null) empty = "Type a term and press Collect. Collector searches it for videos, as the platform shows them, and keeps each active creator once: picture, link, email when there is one, and their 3 newest videos.";
            else if (r.optBoolean("running")) empty = "";
            else empty = "Nothing new this time: everyone it found was collected before, or hasn't posted inside Last upload.";
            if (!rows.isEmpty() && r != null) {
                TextView head = Ds.caps(this, "FOUND FOR “" + r.optString("query").toUpperCase(Locale.ROOT) + "”", false);
                head.setPadding(Ui.dp(4), Ui.dp(14), 0, Ui.dp(6));
                list.addView(head, Ui.fill());
            }
        } else {
            String f = filter.getText().toString().trim().toLowerCase(Locale.ROOT);
            rows = rowsFor(sel, f);
            int total = f.isEmpty() ? rows.size() : rowsFor(sel, "").size();
            String none = "restricted".equals(sel) ? "Nobody restricted. Restrict a lead (or Reject it in its detail) to keep it out of Available; it stays remembered, so no run collects it again."
                    : "approved".equals(sel) ? "Nobody approved. Open a lead and tap Approve: approved leads leave Available and stay remembered, so no run collects them again."
                    : "No leads yet. Collect some from the Collector view.";
            empty = total == 0 ? none : "Nobody matches “" + filter.getText().toString().trim() + "”.";
        }
        if (rows.isEmpty()) {
            if (!empty.isEmpty()) list.addView(Ds.empty(this, empty), Ui.margins(Ui.fill(), 0, 12, 0, 0));
            return;
        }
        for (JSONObject o : rows) list.addView(card(o), Ui.margins(Ui.fill(), 0, 0, 0, 10));
    }

    /** One lead: picture, name and platform, handle and profile link, email, the 3 newest videos, Send and Restrict. */
    private View card(JSONObject r) {
        LinearLayout card = Ds.card(this);
        final String name = r.optString("name"), rid = r.optString("id"), url = r.optString("url"), email = r.optString("email");
        final boolean restricted = r.optBoolean("restricted"), approved = !restricted && r.optBoolean("approved");
        LinearLayout top = Ui.row(this);
        top.setGravity(Gravity.CENTER_VERTICAL);
        top.addView(avatar(this, hub, r, 44));
        LinearLayout text = Ui.col(this);
        text.setPadding(Ui.dp(12), 0, 0, 0);
        LinearLayout l1 = Ui.row(this);
        l1.setGravity(Gravity.CENTER_VERTICAL);
        l1.addView(Ui.subtitle(Ui.bold(this, name, 15, Ui.FG)), new LinearLayout.LayoutParams(0, -2, 1));
        l1.addView(badge(this, r.optString("platform"), Ui.G700), Ui.margins(Ui.wrap(), 6, 0, 0, 0));
        final String reach = r.optString("reach", "");
        if (!reach.isEmpty() && !"null".equals(reach)) {
            View m = CollectorCreator.reachMark(this, reach);
            final String rv = r.optString("reachValue", "");
            m.setOnClickListener(v -> {
                if ("email".equals(reach) || "whatsapp".equals(reach)) push(new CollectorCreator.Compose(this, rid, name, reach));
                else push(new CollectorCreator.Detail(this, rid, name));
            });
            l1.addView(m, Ui.margins(new LinearLayout.LayoutParams(Ui.dp(24), Ui.dp(24)), 6, 0, 0, 0));
        }
        text.addView(l1, Ui.fill());
        String handle = r.optString("handle");
        TextView link = Ui.subtitle(Ui.text(this, (handle.isEmpty() ? "" : handle + " · ") + r.optString("short"), 12.5f, Ui.G700));
        link.setOnClickListener(v -> { if (!url.isEmpty()) Ui.openUrl(this, url); });
        text.addView(link, Ui.fill());
        String src = r.optString("emailSource");
        TextView em = Ui.subtitle(email.isEmpty() ? Ui.text(this, "Add email", 12.5f, Ui.G600) : Ui.text(this, email + (src.isEmpty() ? "" : "  · " + src), 12.5f, Ui.FG));
        em.setPadding(0, Ui.dp(2), 0, 0);
        em.setOnClickListener(v -> editEmail(rid, email));
        text.addView(em, Ui.fill());
        top.addView(text, Ui.weight());
        card.addView(top, Ui.fill());
        JSONArray vids = r.optJSONArray("videos");
        if (vids != null && vids.length() > 0) {
            LinearLayout th = Ui.row(this);
            for (int i = 0; i < 3; i++) {
                JSONObject v = i < vids.length() ? vids.optJSONObject(i) : null;
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, Ui.dp(84), 1);
                if (i > 0) lp.leftMargin = Ui.dp(6);
                if (v == null) { th.addView(new View(this), lp); continue; }
                ImageView iv = new ImageView(this);
                iv.setScaleType(ImageView.ScaleType.CENTER_CROP);
                iv.setBackground(Ui.round(Ui.G200, 0, 8));
                iv.setClipToOutline(true);
                final String vu = v.optString("url");
                iv.setContentDescription(v.optString("title"));
                iv.setOnClickListener(x -> { if (!vu.isEmpty()) Ui.openUrl(this, vu); });
                String tid = v.optString("thumbId", "");
                if (!tid.isEmpty() && !"null".equals(tid) && hub != null) PersonsUi.image(this, hub, "/v1/collector/avatar?id=" + tid, iv, Ui.dp(160), null);
                th.addView(iv, lp);
            }
            card.addView(th, Ui.margins(Ui.fill(), 0, 10, 0, 0));
        }
        LinearLayout acts = Ui.row(this);
        acts.setGravity(Gravity.END);
        acts.addView(Ui.rowButton(this, "Send message", false, v -> push(new CollectorCreator.Compose(this, rid, name))));
        LinearLayout.LayoutParams lp = Ui.wrap();
        lp.leftMargin = Ui.dp(6);
        if (approved) acts.addView(Ui.rowButton(this, "Unapprove", false, v ->
                post("approve", () -> Ui.toast(this, name + " is back in Available"), "id", rid, "approved", false)), lp);
        else acts.addView(Ui.rowButton(this, restricted ? "Unrestrict" : "Restrict", false, v ->
                post("restrict", () -> Ui.toast(this, restricted ? name + " is back in Available" : name + " moved to Restricted"), "id", rid, "restricted", !restricted)), lp);
        card.addView(acts, Ui.margins(Ui.fill(), 0, 10, 0, 0));
        // A tap anywhere else on the card opens the lead's detail.
        card.setOnClickListener(v -> push(new CollectorCreator.Detail(this, rid, name, rowIds())));
        return card;
    }

    /** Type (or correct) a lead's email; a typed one is never replaced by one found later. Empty clears it. */
    private void editEmail(String id, String current) {
        final EditText f = Ui.input(this, "name@example.com", false);
        f.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        f.setText(current);
        LinearLayout box = Ui.col(this);
        box.setPadding(Ui.dp(20), Ui.dp(8), Ui.dp(20), 0);
        box.addView(f, Ui.fill());
        Ui.dialog(this).setTitle("Email").setView(box)
                .setPositiveButton("Save", (d, w) -> {
                    if (hub == null) return;
                    final Hub h = hub;
                    JSONObject b = new JSONObject();
                    try { b.put("id", id).put("email", f.getText().toString().trim()); } catch (Exception ignored) { }
                    Ui.pool.execute(() -> {
                        try {
                            h.call("POST", "/v1/collector/email", b);
                            Ui.main.post(() -> { Ui.toast(this, "Email saved"); load(); });
                        } catch (Exception e) {
                            Ui.main.post(() -> Ui.toast(this, h.whyDown(e)));
                        }
                    });
                })
                .setNegativeButton("Cancel", null).show();
    }

    // ---------- shared with the creator's screens ----------

    static TextView pad(TextView t, int top) {
        t.setPadding(0, Ui.dp(top), 0, Ui.dp(6));
        return t;
    }

    /** A small tag (the platform): its colour on a quiet fill. */
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
            if (f != query && f != target && f != filter) return; // set by the screen, not typed
            typed = System.currentTimeMillis();
            Ui.main.removeCallbacks(later);
            Ui.main.postDelayed(later, 600);
        }
    }
}
