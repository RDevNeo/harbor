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
import android.widget.ListView;
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

/** Hub's Collector tab: leads (content creators) from YouTube, TikTok and Instagram. Five views, the drawer's rows:
 *  Collector (the search form, one line while a run goes, the leads it found), Available (every lead not Restricted
 *  or Approved, with the filter bar over the list), Approved, Restricted and History (every search run by day, as
 *  Headquarters' Timeline; a tap shows the leads it found, Back returns to the timeline). The leads are a recycled ListView, PAGE
 *  at a time; their pictures load only for the rows on screen, at the size drawn, cached in memory and on disk
 *  (Thumbs). A lead is a card: picture, name, platform, handle and
 *  profile link, email (tap to type one), the 3 newest videos (tap opens), Send message (adds them to Persons ›
 *  Creators) and Restrict / Unrestrict. The runs happen on the PC (Hub's engine, ts/tabs/collector): this screen
 *  draws GET /v1/collector, as the PC's window does, and sends each change there. Send message
 *  (CollectorCreator.Compose) and a lead's detail (CollectorCreator.Detail, a tap on its card) open over the tab,
 *  without the tab bar; Back closes them. */
public class Collector extends Base {
    private LinearLayout segs, form, runRow;
    /** The leads (recycled rows), and what it shows: a caps head, an empty note, the leads of this page, "Show more". */
    private ListView list;
    private final List<Item> rows = new ArrayList<>();
    /** Leads shown in the list now (more by PAGE with "Show more"); back to PAGE when the view or its filter changes. */
    private int shown = PAGE;
    private String shownFor = "";
    static final int PAGE = 40;
    private EditText query, target, cookie, filter;
    /** The lists' bar: the filter box, Sort and "Show only — platforms". */
    private LinearLayout listBar;
    private TextView sortBtn, platBtn;
    private JSONObject view;
    private boolean loading;
    private String formSig = "", note = "";
    /** The view on screen: "collector", "available", "approved", "restricted" or "history". */
    private String sel = "collector";
    /** History: the run open ("" the timeline). */
    private String histRun = "";
    /** The screenshot rig: open History's newest run that found someone, once the view is in. */
    private boolean firstRun;
    private long typed;
    /** A live restart's place in the list: the lead at its top and its offset (null: none, or reached). */
    private String liveLead;
    private int liveOff;
    private boolean keepShown;
    private int livePos = -1, livePosOff;
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
        if ("available".equals(p) || "approved".equals(p) || "sent".equals(p) || "restricted".equals(p) || "history".equals(p)) sel = p;
        firstRun = "history".equals(p) && "first".equals(getIntent().getStringExtra("run"));
        // The shared frame: the top bar (the side-panel button, the view's name), the page, the tab bar; the six
        // views (Collector, Available, Approved, Sent, Restricted with their counts, History) are the drawer's rows.
        LinearLayout col = frame("Collector", menuButton(), false);
        segs = Ui.col(this);
        segs.setPadding(0, Ui.dp(4), 0, Ui.dp(12));
        form = Ui.col(this);
        runRow = Ui.row(this);
        filter = Ui.input(this, "Filter by name, handle, email or platform", false);
        filter.setImeOptions(EditorInfo.IME_ACTION_DONE);
        filter.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int a, int b, int c) { }
            @Override public void onTextChanged(CharSequence s, int a, int b, int c) { }
            @Override public void afterTextChanged(Editable e) { if (filter.hasFocus()) drawList(); }
        });
        // The lists' bar stays over the list (it never scrolls away, and its field is never inside the recycled list).
        listBar = Ui.row(this);
        listBar.setGravity(Gravity.CENTER_VERTICAL);
        listBar.addView(filter, Ui.weight());
        sortBtn = listButton(v -> { if (!"sent".equals(sel)) pickSort(); });
        platBtn = listButton(v -> pickPlatforms());
        listBar.addView(sortBtn, Ui.margins(Ui.wrap(), 6, 0, 0, 0));
        listBar.addView(platBtn, Ui.margins(Ui.wrap(), 6, 0, 0, 0));
        col.addView(listBar, Ui.margins(Ui.fill(), 16, 8, 16, 6));
        // The leads: a recycled list (only the cards on screen exist, their pictures load as they come into view);
        // Collector's form and run line ride above them as its header.
        LinearLayout head = Ui.col(this);
        head.setPadding(Ui.dp(16), Ui.dp(6), Ui.dp(16), 0);
        head.addView(form, Ui.fill());
        head.addView(runRow, Ui.fill());
        list = new ListView(this);
        list.setDivider(null);
        list.setDividerHeight(0);
        list.setSelector(new android.graphics.drawable.ColorDrawable(0));
        list.setCacheColorHint(0);
        list.setClipToPadding(false);
        list.setPadding(0, 0, 0, Ui.dp(24));
        list.setItemsCanFocus(true);
        list.setDescendantFocusability(android.view.ViewGroup.FOCUS_AFTER_DESCENDANTS);
        list.addHeaderView(head, null, false);
        list.setAdapter(adapter);
        col.addView(list, new LinearLayout.LayoutParams(-1, 0, 1));
        ScrollView ds = new ScrollView(this);
        ds.addView(segs);
        installTab(Tabs.COLLECTOR, Ds.drawer(this, "Collector", ds));
        // Right after a live restart (Swap) or a crash: the view, its filter, the list's place, an open lead.
        String ls = Swap.state(this, b, "sel");
        if ("collector".equals(ls) || "available".equals(ls) || "approved".equals(ls) || "sent".equals(ls) || "restricted".equals(ls) || "history".equals(ls)) sel = ls;
        String lr = Swap.state(this, b, "hrun");
        if (lr != null) histRun = lr;
        String lf = Swap.state(this, b, "filter");
        if (lf != null) filter.setText(lf);
        liveLead = Swap.state(this, b, "lead");
        try { livePos = Integer.parseInt(Swap.state(this, b, "pos")); livePosOff = Integer.parseInt(Swap.state(this, b, "poff")); } catch (Exception e) { livePos = -1; }
        try { liveOff = Integer.parseInt(Swap.state(this, b, "off")); } catch (Exception e) { liveOff = 0; }
        try { shown = Math.max(PAGE, Integer.parseInt(Swap.state(this, b, "shown"))); keepShown = true; } catch (Exception ignored) { }
        draw();
        livePanel(b);
        String ld = Swap.state(this, b, "detail");
        if (ld != null && !ld.isEmpty()) {
            String lq = Swap.state(this, b, "queue");
            List<String> queue = new ArrayList<>();
            if (lq != null) for (String q : lq.split("\n")) if (!q.isEmpty()) queue.add(q);
            CollectorCreator.Detail d = new CollectorCreator.Detail(this, ld, Swap.state(this, b, "dname"), queue);
            d.typedNote = Swap.state(this, b, "note");
            push(d);
        }
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
        if ("history".equals(sel) && !histRun.isEmpty()) { closeRun(); return; }
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
            setContentView(root());
            load();
        } else {
            Screen s = stack.get(stack.size() - 1);
            setContentView(s.view());
            s.shown();
        }
    }

    /** A hardware keyboard's ← / → on a lead's detail: the previous / next lead of its list (as the PC's dialog), never
     *  while a text field has the focus (the note, Reach, Edit) or with a modifier. */
    @Override
    public boolean dispatchKeyEvent(android.view.KeyEvent e) {
        int k = e.getKeyCode();
        if ((k == android.view.KeyEvent.KEYCODE_DPAD_LEFT || k == android.view.KeyEvent.KEYCODE_DPAD_RIGHT) && !stack.isEmpty()
                && stack.get(stack.size() - 1) instanceof CollectorCreator.Detail && !(getCurrentFocus() instanceof android.widget.EditText)
                && !e.isCtrlPressed() && !e.isAltPressed() && !e.isMetaPressed() && !e.isShiftPressed()) {
            Swap.input();
            Swap.dirty();
            if (e.getAction() == android.view.KeyEvent.ACTION_DOWN)
                ((CollectorCreator.Detail) stack.get(stack.size() - 1)).step(k == android.view.KeyEvent.KEYCODE_DPAD_LEFT ? -1 : 1);
            return true;
        }
        return super.dispatchKeyEvent(e);
    }

    /** Send message went out (CollectorCreator.Compose): back to what's under it. Over a lead's detail opened from a
     *  list, on to the lead that was after it in that list (it may have just left the list for Sent: never one further),
     *  or back to the list at its end; the composer stays up until the list is read again. */
    void sent(String id) {
        int n = stack.size();
        Screen under = n >= 2 ? stack.get(n - 2) : null;
        if (!(under instanceof CollectorCreator.Detail) || !((CollectorCreator.Detail) under).id().equals(id) || !((CollectorCreator.Detail) under).queue().contains(id)) { pop(); return; }
        final List<String> queue = ((CollectorCreator.Detail) under).queue();
        final Hub h = hub;
        Runnable next = () -> {
            if (isDestroyed() || stack.size() != n) return;
            stack.remove(n - 1);
            String o = LeadNav.afterSend(queue, id, rowIds());
            if (o == null || o.isEmpty()) pop();
            else replace(new CollectorCreator.Detail(this, o, nameOf(o), queue));
        };
        if (h == null) { next.run(); return; }
        Ui.pool.execute(() -> {
            JSONObject v = null;
            try { v = h.get("/v1/collector"); } catch (Exception ignored) { }
            final JSONObject got = v;
            Ui.main.post(() -> {
                if (got != null && got.has("settings")) { view = got; draw(); }
                next.run();
            });
        });
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
    void post(String path, Runnable then, Object... kv) {
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
        boolean history = "history".equals(sel);
        form.setVisibility(lists ? View.GONE : View.VISIBLE);
        listBar.setVisibility(lists && !history && view != null ? View.VISIBLE : View.GONE);
        if (view != null) {
            sortBtn.setText("sent".equals(sel) ? "Newest sent" : sortShort(sortLabel(settings().optString("sort", "followers-desc"))) + "  ▾");
            List<String> only = platforms();
            platBtn.setText((only.isEmpty() ? "All" : only.size() == 1 ? platformLabel(only.get(0)) : only.size() + " platforms") + "  ▾");
            platBtn.setTextColor(only.isEmpty() ? Ui.G700 : Ui.FG);
        }
        if (hub == null || view == null) {
            form.removeAllViews();
            formSig = "";
            cookie = null;
            rows.clear();
            rows.add(new Item(EMPTY, hub == null ? "Pair this phone with a PC to use Collector." : note.isEmpty() ? "Loading…" : note, null));
            adapter.notifyDataSetChanged();
            return;
        }
        JSONObject c = view.optJSONObject("counts");
        int avail = c == null ? 0 : c.optInt("available"), appr = c == null ? 0 : c.optInt("approved"), restr = c == null ? 0 : c.optInt("restricted"), sentN = c == null ? 0 : c.optInt("sent");
        seg("collector", "Collector", running() ? "running" : "");
        seg("available", "Available", avail > 0 ? String.valueOf(avail) : "");
        seg("approved", "Approved", appr > 0 ? String.valueOf(appr) : "");
        seg("sent", "Sent", sentN > 0 ? String.valueOf(sentN) : "");
        seg("restricted", "Restricted", restr > 0 ? String.valueOf(restr) : "");
        seg("history", "History", "");
        if (firstRun) {
            firstRun = false;
            JSONObject r = firstRunWithLeads();
            if (r != null) histRun = r.optString("id");
        }
        // A run that's no longer in History (a restore that asks for one): back to the timeline.
        if (!histRun.isEmpty() && findRun(histRun) == null) histRun = "";
        if (!lists) {
            drawForm();
            drawRun();
        }
        drawList();
        Ui.main.removeCallbacks(poll);
        if (running()) Ui.main.postDelayed(poll, 1500);
    }

    /** One of the four views; a tap shows it. */
    private void seg(String id, String label) { seg(id, label, ""); }

    private void seg(String id, String label, String count) {
        boolean on = id.equals(sel);
        if (on) barTitle.setText(label);
        String glyph = "collector".equals(id) ? Ui.I_SEARCH : "available".equals(id) ? Ui.I_USERS
                : "approved".equals(id) ? Ui.I_CIRCLE_CHECK : "sent".equals(id) ? Ui.I_SEND : "history".equals(id) ? I_HISTORY : Ui.I_CIRCLE_SLASH;
        segs.addView(Ds.navRow(this, glyph, label, count, on, v -> {
            closeDrawer();
            if (id.equals(sel) && histRun.isEmpty()) return;
            sel = id;
            histRun = "";
            hideKeyboard();
            draw();
            list.setSelection(0);
        }), Ui.fill());
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

    /** Which list a lead is in: Restricted, Sent (a message reached them), Approved, else Available. */
    static String listOf(JSONObject o) {
        return o.optBoolean("restricted") ? "restricted" : o.optBoolean("sent") ? "sent" : o.optBoolean("approved") ? "approved" : "available";
    }

    /** The leads a view shows, in its order: the run's (still pending) on Collector, the others' list filtered by `f`. */
    private List<JSONObject> rowsFor(String which, String f) {
        List<JSONObject> rows = new ArrayList<>();
        if (view == null) return rows;
        JSONArray all = view.optJSONArray("creators");
        if ("history".equals(which)) {
            // The run open: the leads it found, in the order found, whatever list they're in now.
            JSONObject run = findRun(histRun);
            JSONArray ids = run == null ? null : run.optJSONArray("ids");
            if (ids == null) return rows;
            Map<String, JSONObject> byId = new HashMap<>();
            for (int i = 0; all != null && i < all.length(); i++) {
                JSONObject o = all.optJSONObject(i);
                if (o != null) byId.put(o.optString("id"), o);
            }
            for (int i = 0; i < ids.length(); i++) {
                JSONObject o = byId.get(ids.optString(i));
                if (o != null) rows.add(o);
            }
            return rows;
        }
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
        List<String> only = platforms();
        for (int i = 0; all != null && i < all.length(); i++) {
            JSONObject o = all.optJSONObject(i);
            if (o == null || !which.equals(listOf(o))) continue;
            if (!only.isEmpty() && !only.contains(o.optString("platformKey"))) continue;
            StringBuilder cs = new StringBuilder();
            JSONArray cl = o.optJSONArray("contacts");
            for (int j = 0; cl != null && j < cl.length(); j++) cs.append(' ').append(cl.optJSONObject(j).optString("value"));
            String hay = (o.optString("name") + " " + o.optString("handle") + " " + o.optString("email") + " " + o.optString("platform") + " " + o.optString("short") + cs).toLowerCase(Locale.ROOT);
            if (f.isEmpty() || hay.contains(f)) rows.add(o);
        }
        // Sent: the newest sent first (Sort doesn't apply there)
        if ("sent".equals(which)) {
            rows.sort((x, y) -> y.optString("sentAt").compareTo(x.optString("sentAt")));
            return rows;
        }
        return sortRows(rows, settings().optString("sort", "followers-desc"));
    }

    // ---------- History: every search run by day (Headquarters' Timeline) ----------

    /** Lucide's history glyph, as Routine's History. */
    static final String I_HISTORY = "";

    /** A run of History by its id (null when it isn't there). */
    JSONObject findRun(String id) {
        if (id == null || id.isEmpty()) return null;
        JSONArray days = view == null ? null : view.optJSONArray("history");
        for (int d = 0; days != null && d < days.length(); d++) {
            JSONObject day = days.optJSONObject(d);
            JSONArray runs = day == null ? null : day.optJSONArray("runs");
            for (int i = 0; runs != null && i < runs.length(); i++) {
                JSONObject r = runs.optJSONObject(i);
                if (r != null && id.equals(r.optString("id"))) {
                    try { r.put("dayLabel", day.optString("label")); } catch (Exception ignored) { }
                    return r;
                }
            }
        }
        return null;
    }

    /** The newest finished run that found someone (the screenshot rig's). */
    private JSONObject firstRunWithLeads() {
        JSONArray days = view == null ? null : view.optJSONArray("history");
        for (int d = 0; days != null && d < days.length(); d++) {
            JSONArray runs = days.optJSONObject(d) == null ? null : days.optJSONObject(d).optJSONArray("runs");
            for (int i = 0; runs != null && i < runs.length(); i++) {
                JSONObject r = runs.optJSONObject(i);
                if (r != null && !r.optBoolean("running") && r.optInt("found") > 0) return r;
            }
        }
        return null;
    }

    private void openRun(String id) {
        histRun = id;
        draw();
        list.setSelection(0);
    }

    private void closeRun() {
        histRun = "";
        draw();
    }

    /** The timeline: each day's head ("Today", "Yesterday", "Wed, Nov 25"), then its runs, newest first. */
    private void drawTimeline() {
        JSONArray days = view.optJSONArray("history");
        for (int d = 0; days != null && d < days.length(); d++) {
            JSONObject day = days.optJSONObject(d);
            JSONArray runs = day == null ? null : day.optJSONArray("runs");
            if (runs == null || runs.length() == 0) continue;
            rows.add(new Item(DAY, day.optString("label"), null));
            for (int i = 0; i < runs.length(); i++) rows.add(new Item(RUN, null, runs.optJSONObject(i), i == runs.length() - 1));
        }
        if (rows.isEmpty()) rows.add(new Item(EMPTY, "No searches yet. Every search you run shows here, by day: the term, the platform, how many new leads it found. Tap one to see its leads.", null));
        adapter.notifyDataSetChanged();
    }

    private TextView dayHead() {
        TextView t = Ui.text(this, "", 13, Ui.G600);
        t.setLayoutParams(new android.widget.AbsListView.LayoutParams(-1, -2));
        return t;
    }

    /** A run's tone as its dot's colour: blue going, green done, amber stopped, red failed, grey nobody new. */
    static int toneDot(String tone) {
        switch (tone) {
            case "running": return 0xff0070f7;
            case "done": return 0xff46a758;
            case "stopped": return 0xffffb224;
            case "failed": return 0xffe5484d;
            default: return 0xff7d7d7d;
        }
    }

    static int toneText(String tone) {
        return "failed".equals(tone) ? Ui.RED : "stopped".equals(tone) ? Ui.AMBER : Ui.G600;
    }

    /** One run on the timeline (Headquarters' Timeline): the time (mono, right-aligned, 52dp), its dot on the day's
     *  line, the term with the platform's mark, how it went, why it stopped early. A tap shows the leads it found. */
    private final class RunRow {
        final LinearLayout view, row, body;
        final TextView time, query, line, note;
        final View dot, rail;
        final android.widget.FrameLayout mark;
        JSONObject cur;

        RunRow() {
            Collector c = Collector.this;
            // The press fill reaches 8dp past the time and the text (Headquarters' -mx-2 px-2), 8dp in from the screen.
            view = Ui.col(c);
            view.setTag(this);
            view.setPadding(Ui.dp(8), 0, Ui.dp(8), 0);
            row = Ui.row(c);
            // The time and the dot sit on the title's line, at the top (not centred on the row).
            row.setGravity(Gravity.TOP);
            row.setPadding(Ui.dp(8), 0, Ui.dp(8), 0);
            row.setBackground(Ui.press(0, 0, 8));
            row.setOnClickListener(v -> { if (cur != null) openRun(cur.optString("id")); });
            view.addView(row, Ui.fill());
            time = Ui.text(c, "", 13, Ui.G600);
            time.setTypeface(Ui.mono);
            time.setGravity(Gravity.END);
            time.setPadding(0, Ui.dp(1), 0, 0);
            LinearLayout.LayoutParams tl = new LinearLayout.LayoutParams(Ui.dp(52), -2);
            tl.gravity = Gravity.TOP;
            row.addView(time, tl);
            LinearLayout guide = Ui.col(c);
            guide.setGravity(Gravity.CENTER_HORIZONTAL);
            dot = new View(c);
            LinearLayout.LayoutParams dl = new LinearLayout.LayoutParams(Ui.dp(10), Ui.dp(10));
            dl.topMargin = Ui.dp(6);
            guide.addView(dot, dl);
            rail = new View(c);
            rail.setBackgroundColor(Ui.G400);
            LinearLayout.LayoutParams rl = new LinearLayout.LayoutParams(Ui.dp(1), 0, 1);
            rl.topMargin = Ui.dp(6);
            guide.addView(rail, rl);
            LinearLayout.LayoutParams gl = new LinearLayout.LayoutParams(Ui.dp(10), -1);
            gl.leftMargin = Ui.dp(12);
            gl.rightMargin = Ui.dp(12);
            row.addView(guide, gl);
            body = Ui.col(c);
            body.setPadding(0, 0, 0, Ui.dp(20));
            LinearLayout top = Ui.row(c);
            top.setGravity(Gravity.CENTER_VERTICAL);
            mark = new android.widget.FrameLayout(c);
            top.addView(mark, Ui.margins(new LinearLayout.LayoutParams(Ui.dp(15), Ui.dp(15)), 0, 0, 7, 0));
            query = Ui.text(c, "", 15, Ui.FG);
            query.setSingleLine(true);
            query.setEllipsize(android.text.TextUtils.TruncateAt.END);
            top.addView(query, Ui.weight());
            body.addView(top, Ui.fill());
            line = Ui.text(c, "", 13.5f, Ui.G600);
            body.addView(line, Ui.margins(Ui.fill(), 0, 5, 0, 0));
            note = Ui.text(c, "", 13.5f, Ui.G600);
            note.setMaxLines(2);
            note.setEllipsize(android.text.TextUtils.TruncateAt.END);
            body.addView(note, Ui.margins(Ui.fill(), 0, 4, 0, 0));
            row.addView(body, Ui.weight());
        }

        void bind(JSONObject r, boolean last) {
            cur = r;
            String tone = r.optString("tone");
            boolean running = r.optBoolean("running"), dim = "empty".equals(tone);
            time.setText(r.optString("time"));
            time.setTextColor(running ? 0xff52a8ff : Ui.G600);
            int d = Ui.dp(dim ? 8 : 10);
            LinearLayout.LayoutParams dl = (LinearLayout.LayoutParams) dot.getLayoutParams();
            dl.width = d;
            dl.height = d;
            dl.topMargin = Ui.dp(dim ? 7 : 6);
            dot.setLayoutParams(dl);
            dot.setBackground(Ui.round(toneDot(tone), 0, d / 2f / Ui.density));
            rail.setVisibility(last ? View.INVISIBLE : View.VISIBLE);
            mark.removeAllViews();
            mark.addView(platMark(Collector.this, r.optString("platformKey"), 15), new android.widget.FrameLayout.LayoutParams(-1, -1));
            query.setText(r.optString("query"));
            line.setText(r.optString("platform") + " · " + r.optString("line"));
            String n = r.optString("note");
            note.setText(n);
            note.setTextColor(toneText(tone));
            note.setVisibility(n.isEmpty() ? View.GONE : View.VISIBLE);
            float a = dim ? 0.6f : 1f;
            time.setAlpha(a);
            query.setAlpha(a);
            line.setAlpha(a);
        }
    }

    /** An opened run's head: back to History, the term with its platform's mark, "YouTube · Today 08:26 · 20 new
     *  leads", why it stopped early. */
    private View runHead(JSONObject r) {
        LinearLayout w = Ui.col(this);
        w.setLayoutParams(new android.widget.AbsListView.LayoutParams(-1, -2));
        w.setPadding(Ui.dp(12), Ui.dp(4), Ui.dp(16), Ui.dp(14));
        LinearLayout back = Ui.row(this);
        back.setGravity(Gravity.CENTER_VERTICAL);
        back.setPadding(Ui.dp(4), Ui.dp(6), Ui.dp(10), Ui.dp(6));
        back.setBackground(Ui.press(0, 0, 8));
        back.addView(Ui.icon(this, Ui.I_LEFT, 16, Ui.FG));
        back.addView(Ui.bold(this, "History", 14, Ui.FG), Ui.margins(Ui.wrap(), 6, 0, 0, 0));
        back.setOnClickListener(v -> closeRun());
        w.addView(back, Ui.wrap());
        if (r == null) return w;
        LinearLayout t = Ui.row(this);
        t.setGravity(Gravity.CENTER_VERTICAL);
        t.setPadding(Ui.dp(4), Ui.dp(10), 0, 0);
        t.addView(platMark(this, r.optString("platformKey"), 18), new LinearLayout.LayoutParams(Ui.dp(18), Ui.dp(18)));
        TextView q = Ui.bold(this, r.optString("query"), 20, Ui.FG);
        q.setSingleLine(true);
        q.setEllipsize(android.text.TextUtils.TruncateAt.END);
        t.addView(q, Ui.margins(Ui.weight(), 10, 0, 0, 0));
        w.addView(t, Ui.fill());
        String when = r.optBoolean("running") ? "running now" : r.optString("dayLabel") + " " + r.optString("time");
        TextView sub = Ui.text(this, r.optString("platform") + " · " + when + " · " + r.optString("line"), 13.5f, Ui.G600);
        sub.setPadding(Ui.dp(4), Ui.dp(6), 0, 0);
        w.addView(sub, Ui.fill());
        String n = r.optString("note");
        if (!n.isEmpty()) {
            TextView nt = Ui.text(this, n, 13.5f, toneText(r.optString("tone")));
            nt.setPadding(Ui.dp(4), Ui.dp(4), 0, 0);
            w.addView(nt, Ui.fill());
        }
        return w;
    }

    /** A platform's mark in its brand colour: YouTube's and TikTok's drawn (the icon font has neither), Instagram's. */
    static View platMark(android.content.Context c, String kind, float size) {
        int color = CollectorCreator.brandColor(kind);
        if ("instagram".equals(kind)) return CollectorCreator.brand(c, kind, size, color);
        View v = new View(c);
        v.setBackground(new PlatMark(kind, color));
        v.setLayoutParams(new LinearLayout.LayoutParams(Ui.dp(size), Ui.dp(size)));
        return v;
    }

    /** Lucide's youtube (stroked, the play triangle filled) and a simple TikTok note, on a 24-unit grid. */
    static final class PlatMark extends android.graphics.drawable.Drawable {
        private final android.graphics.Paint p = new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);
        private final String kind;
        PlatMark(String kind, int color) {
            this.kind = kind;
            p.setColor(color);
            p.setStrokeCap(android.graphics.Paint.Cap.ROUND);
            p.setStrokeJoin(android.graphics.Paint.Join.ROUND);
        }
        @Override public void draw(android.graphics.Canvas c) {
            android.graphics.Rect b = getBounds();
            float s = Math.min(b.width(), b.height()) / 24f;
            c.save();
            c.translate(b.left, b.top);
            c.scale(s, s);
            if ("youtube".equals(kind)) {
                p.setStyle(android.graphics.Paint.Style.STROKE);
                p.setStrokeWidth(2);
                c.drawRoundRect(new android.graphics.RectF(2.5f, 5f, 21.5f, 19f), 4, 4, p);
                android.graphics.Path t = new android.graphics.Path();
                t.moveTo(10, 9);
                t.lineTo(15, 12);
                t.lineTo(10, 15);
                t.close();
                p.setStyle(android.graphics.Paint.Style.FILL);
                c.drawPath(t, p);
            } else {
                p.setStyle(android.graphics.Paint.Style.STROKE);
                p.setStrokeWidth(3.2f);
                c.drawCircle(9.5f, 16.5f, 4.2f, p);
                android.graphics.Path n = new android.graphics.Path();
                n.moveTo(13.7f, 16.5f);
                n.lineTo(13.7f, 2.5f);
                n.quadTo(15f, 7.5f, 20.5f, 7.8f);
                c.drawPath(n, p);
            }
            c.restore();
        }
        @Override public void setAlpha(int a) { p.setAlpha(a); }
        @Override public void setColorFilter(android.graphics.ColorFilter f) { p.setColorFilter(f); }
        @Override public int getOpacity() { return android.graphics.PixelFormat.TRANSLUCENT; }
    }

    // ---------- the lists' Sort and "Show only — platforms" (the SpokPay CRM's creator column menus) ----------

    static final String[][] LIST_PLATFORMS = {{"youtube", "YouTube"}, {"tiktok", "TikTok"}, {"instagram", "Instagram"}};

    static String platformLabel(String k) {
        for (String[] p : LIST_PLATFORMS) if (p[0].equals(k)) return p[1];
        return k;
    }

    /** The order the PC's window uses (ui.ts sortRows): followers high → low ("followers-desc") or low → high;
     *  unknown counts last either way, the view's order (newest collected first) breaks ties. */
    static List<JSONObject> sortRows(List<JSONObject> rows, String mode) {
        List<JSONObject> out = new ArrayList<>(rows);
        final Map<JSONObject, Integer> at = new java.util.IdentityHashMap<>();
        for (int i = 0; i < rows.size(); i++) at.put(rows.get(i), i);
        final int dir = "followers-asc".equals(mode) ? -1 : 1;
        out.sort((a, b) -> {
            Double x = count(a), y = count(b);
            if (x == null && y == null) return at.get(a) - at.get(b);
            if (x == null) return 1;
            if (y == null) return -1;
            int c = dir * Double.compare(y, x);
            return c != 0 ? c : at.get(a) - at.get(b);
        });
        return out;
    }

    private static Double count(JSONObject o) { return o.isNull("subs") || !o.has("subs") ? null : o.optDouble("subs"); }

    private List<String> platforms() {
        List<String> out = new ArrayList<>();
        JSONArray a = settings().optJSONArray("platforms");
        for (int i = 0; a != null && i < a.length(); i++) out.add(a.optString(i));
        return out;
    }

    private String sortLabel(String mode) {
        JSONArray a = view == null ? null : view.optJSONArray("sorts");
        for (int i = 0; a != null && i < a.length(); i++) {
            JSONObject o = a.optJSONObject(i);
            if (o != null && mode.equals(o.optString("value"))) return o.optString("label");
        }
        return "Sort";
    }

    static String sortShort(String label) {
        return label.replace(" (high → low)", " ↓").replace(" (low → high)", " ↑");
    }

    private TextView listButton(View.OnClickListener on) {
        TextView t = Ui.text(this, "", 13, Ui.FG);
        t.setGravity(Gravity.CENTER_VERTICAL);
        t.setSingleLine(true);
        t.setPadding(Ui.dp(12), Ui.dp(12), Ui.dp(12), Ui.dp(12));
        t.setBackground(Ui.press(Ui.CARD, Ui.LINE, 12));
        t.setOnClickListener(on);
        return t;
    }

    /** Sort by: Followers (high → low) or (low → high); remembered on the PC. */
    private void pickSort() {
        JSONArray a = view == null ? null : view.optJSONArray("sorts");
        if (a == null || a.length() == 0) return;
        String cur = settings().optString("sort", "followers-desc");
        String[] labels = new String[a.length()];
        int on = 0;
        for (int i = 0; i < a.length(); i++) {
            JSONObject o = a.optJSONObject(i);
            labels[i] = o == null ? "" : o.optString("label");
            if (o != null && cur.equals(o.optString("value"))) on = i;
        }
        Ui.dialog(this).setTitle("Sort by").setSingleChoiceItems(labels, on, (d, w) -> {
            JSONObject o = a.optJSONObject(w);
            d.dismiss();
            if (o == null) return;
            try { settings().put("sort", o.optString("value")); } catch (Exception ignored) { }
            draw();
            post("settings", "sort", o.optString("value"));
        }).show();
    }

    /** Show only — platforms (several at once, none = all), with each one's count on this list. */
    private void pickPlatforms() {
        final List<String> only = platforms();
        int[] n = new int[LIST_PLATFORMS.length];
        JSONArray all = view == null ? null : view.optJSONArray("creators");
        for (int i = 0; all != null && i < all.length(); i++) {
            JSONObject o = all.optJSONObject(i);
            if (o == null || !sel.equals(listOf(o))) continue;
            for (int k = 0; k < LIST_PLATFORMS.length; k++) if (LIST_PLATFORMS[k][0].equals(o.optString("platformKey"))) n[k]++;
        }
        String[] labels = new String[LIST_PLATFORMS.length + 1];
        labels[0] = (only.isEmpty() ? "✓  " : "     ") + "All platforms";
        for (int k = 0; k < LIST_PLATFORMS.length; k++) labels[k + 1] = (only.contains(LIST_PLATFORMS[k][0]) ? "✓  " : "     ") + LIST_PLATFORMS[k][1] + "  ·  " + n[k];
        Ui.dialog(this).setTitle("Show only — platforms").setItems(labels, (d, w) -> {
            List<String> next = new ArrayList<>();
            if (w > 0) {
                String k = LIST_PLATFORMS[w - 1][0];
                for (String[] p : LIST_PLATFORMS) {
                    boolean has = only.contains(p[0]);
                    if (p[0].equals(k) ? !has : has) next.add(p[0]);
                }
                if (next.size() == LIST_PLATFORMS.length) next.clear();
            }
            JSONArray v = new JSONArray();
            for (String x : next) v.put(x);
            try { settings().put("platforms", v); } catch (Exception ignored) { }
            draw();
            post("settings", "platforms", v);
        }).show();
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
    static String nextLead(List<String> queue, String current, List<String> live) { return LeadNav.nextLead(queue, current, live); }


    /** The review bar: "reject" (to Restricted), "skip" (as it is), "approve" (to the Approved list and Persons ›
     *  Creators), "neobux" (to the Approved list and Persons › Neobux); then the next
     *  lead of the list the detail was opened from, or back to the list at its end. No toast: the move is the feedback
     *  (a failed call still toasts its reason, in post). */
    void review(String id, String name, String what, List<String> queue) {
        Runnable next = () -> {
            String n = nextLead(queue, id, rowIds());
            if (n == null) pop();
            else replace(new CollectorCreator.Detail(this, n, nameOf(n), queue));
        };
        if ("reject".equals(what)) post("restrict", next, "id", id, "restricted", true);
        else if ("approve".equals(what)) post("approve", next, "id", id, "approved", true, "to", "persons");
        else if ("neobux".equals(what)) post("approve", next, "id", id, "approved", true, "to", "neobux");
        else next.run();
    }

    // ---------- the list: recycled rows ----------

    /** DAY: History's day head; RUN: one run on the timeline (`lead` is the run, `last` its day's last); RUNHEAD: an
     *  opened run's head (back, the term, how it went). */
    static final int CAPS = 0, EMPTY = 1, LEAD = 2, MORE = 3, DAY = 4, RUN = 5, RUNHEAD = 6;

    /** One row of the list. */
    static final class Item {
        final int kind;
        final String text;
        final JSONObject lead;
        final boolean last;
        Item(int kind, String text, JSONObject lead) { this(kind, text, lead, false); }
        Item(int kind, String text, JSONObject lead, boolean last) { this.kind = kind; this.text = text; this.lead = lead; this.last = last; }
    }

    private final android.widget.BaseAdapter adapter = new android.widget.BaseAdapter() {
        @Override public int getCount() { return rows.size(); }
        @Override public Object getItem(int i) { return rows.get(i); }
        @Override public long getItemId(int i) { return i; }
        @Override public int getViewTypeCount() { return 7; }
        @Override public int getItemViewType(int i) { return rows.get(i).kind; }
        @Override public boolean isEnabled(int i) { return false; }
        @Override public View getView(int i, View convert, android.view.ViewGroup parent) {
            Item it = rows.get(i);
            switch (it.kind) {
                case LEAD: {
                    LeadRow h = convert != null ? (LeadRow) convert.getTag() : new LeadRow();
                    h.bind(it.lead);
                    return h.view;
                }
                case DAY: {
                    TextView t = convert != null ? (TextView) convert : dayHead();
                    t.setText(it.text);
                    t.setPadding(Ui.dp(16), Ui.dp(i == 0 ? 8 : 24), Ui.dp(16), Ui.dp(12));
                    return t;
                }
                case RUN: {
                    RunRow h = convert != null ? (RunRow) convert.getTag() : new RunRow();
                    h.bind(it.lead, it.last);
                    return h.view;
                }
                case RUNHEAD: return runHead(it.lead);
                case CAPS: {
                    TextView t = convert != null ? (TextView) convert : Ds.caps(Collector.this, "", false);
                    t.setText(it.text);
                    t.setPadding(Ui.dp(20), Ui.dp(14), Ui.dp(16), Ui.dp(6));
                    return t;
                }
                case MORE: {
                    LinearLayout w = (LinearLayout) convert;
                    if (w == null) {
                        w = Ui.col(Collector.this);
                        w.setPadding(Ui.dp(16), Ui.dp(2), Ui.dp(16), Ui.dp(8));
                        w.addView(Ui.button(Collector.this, "", false, v -> { shown += PAGE; drawList(); }), Ui.fill());
                    }
                    ((TextView) w.getChildAt(0)).setText(it.text);
                    return w;
                }
                default: {
                    TextView t = convert != null ? (TextView) convert : Ds.empty(Collector.this, "");
                    t.setText(it.text);
                    return t;
                }
            }
        }
    };

    /** The leads of the view: the run's on Collector, Available's, Approved's or Restricted's (filtered) on the others;
     *  PAGE at a time ("Show more"). Only the rows on screen are drawn, so a poll during a run costs a handful of
     *  rebinds, not the whole list. */
    private void drawList() {
        rows.clear();
        if (view == null) { adapter.notifyDataSetChanged(); return; }
        List<JSONObject> leads;
        String empty;
        String f = filter.getText().toString().trim().toLowerCase(Locale.ROOT);
        String key = sel + "|" + f + "|" + settings().optString("sort") + "|" + platforms();
        if (!key.equals(shownFor)) { shownFor = key; if (!keepShown) shown = PAGE; keepShown = false; }
        if ("history".equals(sel)) {
            if (histRun.isEmpty()) {
                drawTimeline();
                return;
            }
            JSONObject run = findRun(histRun);
            rows.add(new Item(RUNHEAD, null, run));
            leads = rowsFor("history", "");
            JSONArray ids = run == null ? null : run.optJSONArray("ids");
            empty = ids != null && ids.length() > 0 ? "Its leads are gone: they were removed since. They stay remembered, so no run collects them again."
                    : run != null && run.optBoolean("running") ? "" : "Nothing new this time: everyone it found was collected before, or hadn't posted inside Last upload.";
        } else if ("collector".equals(sel)) {
            JSONObject r = view.optJSONObject("run");
            leads = rowsFor("collector", "");
            if (r == null) empty = "Type a term and press Collect. Collector searches it for videos, as the platform shows them, and keeps each active creator once: picture, link, email when there is one, and their 3 newest videos.";
            else if (r.optBoolean("running")) empty = "";
            else empty = "Nothing new this time: everyone it found was collected before, or hasn't posted inside Last upload.";
            if (!leads.isEmpty() && r != null) rows.add(new Item(CAPS, "FOUND FOR “" + r.optString("query").toUpperCase(Locale.ROOT) + "”", null));
        } else {
            leads = rowsFor(sel, f);
            int total = 0;
            JSONArray every = view.optJSONArray("creators");
            for (int i = 0; every != null && i < every.length(); i++) if (every.optJSONObject(i) != null && sel.equals(listOf(every.optJSONObject(i)))) total++;
            String none = "restricted".equals(sel) ? "Nobody restricted. Restrict a lead (or Reject it in its detail) to keep it out of Available; it stays remembered, so no run collects it again."
                    : "approved".equals(sel) ? "Nobody approved. Open a lead and tap Approve: approved leads leave Available and stay remembered, so no run collects them again."
                    : "sent".equals(sel) ? "Nobody written to yet. Once a message to a lead goes out (Send message, or from Persons) by email, WhatsApp, Discord or Instagram, it moves here. A failed send doesn't."
                    : "No leads yet. Collect some from the Collector view.";
            empty = total == 0 ? none : !f.isEmpty() ? "Nobody matches “" + filter.getText().toString().trim() + "”." : "Nobody here on the platforms picked.";
        }
        if (leads.isEmpty()) {
            if (!empty.isEmpty()) rows.add(new Item(EMPTY, empty, null));
        } else {
            int n = Math.min(leads.size(), shown);
            for (int i = 0; i < n; i++) rows.add(new Item(LEAD, null, leads.get(i)));
            int left = leads.size() - n;
            if (left > 0) rows.add(new Item(MORE, "Show " + Math.min(PAGE, left) + " more · " + left + " left", null));
        }
        adapter.notifyDataSetChanged();
        // Back at the lead a live restart left at the top, once the leads are in.
        if (liveLead != null || livePos >= 0) {
            String want = liveLead;
            int pos = livePos;
            liveLead = null;
            livePos = -1;
            int at = -1;
            for (int i = 0; want != null && i < rows.size(); i++) {
                JSONObject l = rows.get(i).lead;
                if (l != null && want.equals(l.optString("id"))) { at = i + list.getHeaderViewsCount(); break; }
            }
            int off = liveOff;
            if (at < 0 && pos >= 0 && pos < list.getHeaderViewsCount() + rows.size()) { at = pos; off = livePosOff; }
            if (at >= 0) {
                int fat = at, foff = off;
                // Once the form above has its height.
                list.post(() -> list.setSelectionFromTop(fat, foff));
            }
        }
    }

    // ---------- a live restart (Swap) ----------

    /** The view, its filter, the list's place (the lead at the top and its offset), an open lead's detail (its queue
     *  and the note being typed). Null while Send message is open: that form doesn't come back (Swap waits). */
    @Override
    Live.Screen liveScreen() {
        Screen top = stack.isEmpty() ? null : stack.get(stack.size() - 1);
        if (top != null && !(top instanceof CollectorCreator.Detail)) return null;
        Live.Screen s = super.liveScreen();
        if (s == null) return null;
        s.state.put("sel", sel);
        if (!histRun.isEmpty()) s.state.put("hrun", histRun);
        if (filter.length() > 0) s.state.put("filter", filter.getText().toString());
        if (shown > PAGE) s.state.put("shown", Integer.toString(shown));
        int fp = list.getFirstVisiblePosition(), heads = list.getHeaderViewsCount();
        if (list.getChildCount() > 0 && (fp > 0 || list.getChildAt(0).getTop() < 0)) {
            // The form part-way up (or a row): its position; a lead at the top is found by its id instead.
            s.state.put("pos", Integer.toString(fp));
            s.state.put("poff", Integer.toString(list.getChildAt(0).getTop()));
        }
        if (fp >= heads) {
            for (int i = 0; i < list.getChildCount(); i++) {
                int idx = fp + i - heads;
                if (idx < 0 || idx >= rows.size() || rows.get(idx).lead == null) continue;
                s.state.put("lead", rows.get(idx).lead.optString("id"));
                s.state.put("off", Integer.toString(list.getChildAt(i).getTop()));
                break;
            }
        }
        if (top != null) {
            CollectorCreator.Detail d = (CollectorCreator.Detail) top;
            s.state.put("detail", d.id());
            if (d.title() != null) s.state.put("dname", d.title());
            if (!d.queue().isEmpty()) s.state.put("queue", String.join("\n", d.queue()));
            if (d.typedNote != null) s.state.put("note", d.typedNote);
        }
        return s;
    }

    @Override
    View liveField() {
        View f = getCurrentFocus();
        if (f == null) return null;
        if (stack.isEmpty()) return f == filter ? f : null;
        Screen top = stack.get(stack.size() - 1);
        return top instanceof CollectorCreator.Detail && f == ((CollectorCreator.Detail) top).noteField() ? f : null;
    }

    /** One lead's card, made once and filled again for whichever lead its row shows: picture, name and platform,
     *  handle and profile link, email, the 3 newest videos, Send and Restrict; a tap elsewhere opens the detail. */
    private final class LeadRow {
        final LinearLayout view, card;
        final android.widget.FrameLayout avBox, reachBox;
        final TextView ini, name, badge, link, email, send, act;
        /** Their way of contact: the best one's mark and text, the others' marks, + to type another. */
        final LinearLayout contact;
        final ImageView av;
        final LinearLayout thumbs;
        final ImageView[] th = new ImageView[3];
        JSONObject cur;

        LeadRow() {
            Collector c = Collector.this;
            view = Ui.col(c);
            view.setPadding(Ui.dp(16), 0, Ui.dp(16), Ui.dp(10));
            view.setTag(this);
            card = Ds.card(c);
            view.addView(card, Ui.fill());
            LinearLayout top = Ui.row(c);
            top.setGravity(Gravity.CENTER_VERTICAL);
            avBox = new android.widget.FrameLayout(c);
            ini = Ui.bold(c, "", 0, 0xffffffff);
            ini.setTextSize(android.util.TypedValue.COMPLEX_UNIT_DIP, 44 * 0.36f);
            ini.setGravity(Gravity.CENTER);
            ini.setIncludeFontPadding(false);
            avBox.addView(ini, new android.widget.FrameLayout.LayoutParams(-1, -1));
            av = new ImageView(c);
            av.setScaleType(ImageView.ScaleType.CENTER_CROP);
            av.setOutlineProvider(Thumbs.OVAL);
            av.setClipToOutline(true);
            avBox.addView(av, new android.widget.FrameLayout.LayoutParams(-1, -1));
            top.addView(avBox, new LinearLayout.LayoutParams(Ui.dp(44), Ui.dp(44)));
            LinearLayout text = Ui.col(c);
            text.setPadding(Ui.dp(12), 0, 0, 0);
            LinearLayout l1 = Ui.row(c);
            l1.setGravity(Gravity.CENTER_VERTICAL);
            name = Ui.subtitle(Ui.bold(c, "", 15, Ui.FG));
            l1.addView(name, new LinearLayout.LayoutParams(0, -2, 1));
            badge = badge(c, "", Ui.G700);
            l1.addView(badge, Ui.margins(Ui.wrap(), 6, 0, 0, 0));
            reachBox = new android.widget.FrameLayout(c);
            l1.addView(reachBox, Ui.margins(new LinearLayout.LayoutParams(Ui.dp(24), Ui.dp(24)), 6, 0, 0, 0));
            text.addView(l1, Ui.fill());
            link = Ui.subtitle(Ui.text(c, "", 12.5f, Ui.G700));
            link.setOnClickListener(v -> { String u = cur == null ? "" : cur.optString("url"); if (!u.isEmpty()) Ui.openUrl(c, u); });
            text.addView(link, Ui.fill());
            email = Ui.subtitle(Ui.text(c, "", 12.5f, Ui.FG));
            email.setPadding(0, Ui.dp(2), 0, 0);
            text.addView(email, Ui.fill());
            contact = Ui.row(c);
            contact.setGravity(Gravity.CENTER_VERTICAL);
            text.addView(contact, Ui.margins(Ui.fill(), 0, 2, 0, 0));
            top.addView(text, Ui.weight());
            card.addView(top, Ui.fill());
            thumbs = Ui.row(c);
            thumbs.setBaselineAligned(false);
            for (int i = 0; i < 3; i++) {
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, Ui.dp(THUMB_H), 1);
                if (i > 0) lp.leftMargin = Ui.dp(6);
                ImageView iv = new ImageView(c);
                iv.setScaleType(ImageView.ScaleType.CENTER_CROP);
                iv.setBackground(Ui.round(Ui.G200, 0, 8));
                iv.setClipToOutline(true);
                final int k = i;
                iv.setOnClickListener(x -> {
                    JSONObject v = video(k);
                    String vu = v == null ? "" : v.optString("url");
                    if (!vu.isEmpty()) Ui.openUrl(c, vu);
                });
                th[i] = iv;
                thumbs.addView(iv, lp);
            }
            card.addView(thumbs, Ui.margins(Ui.fill(), 0, 10, 0, 0));
            LinearLayout acts = Ui.row(c);
            acts.setGravity(Gravity.END);
            send = Ui.rowButton(c, "Send message", false, v -> { if (cur != null) push(new CollectorCreator.Compose(c, cur.optString("id"), cur.optString("name"))); });
            acts.addView(send);
            act = Ui.rowButton(c, "Restrict", false, v -> {
                if (cur == null) return;
                final String rid = cur.optString("id"), nm = cur.optString("name");
                final boolean restricted = cur.optBoolean("restricted"), approved = !restricted && cur.optBoolean("approved");
                if (approved) post("approve", "id", rid, "approved", false);
                else post("restrict", "id", rid, "restricted", !restricted);
            });
            acts.addView(act, Ui.margins(Ui.wrap(), 6, 0, 0, 0));
            card.addView(acts, Ui.margins(Ui.fill(), 0, 10, 0, 0));
            card.setOnClickListener(v -> { if (cur != null) push(new CollectorCreator.Detail(c, cur.optString("id"), cur.optString("name"), rowIds())); });
        }

        /** The contact line: the best way to contact them (a tap opens WhatsApp, Discord or Instagram, or copies an
         *  email), up to 3 others' marks (a tap each), a + to type another; "Add contact" when none is known. */
        void bindContacts(final String rid, JSONArray list) {
            Collector c = Collector.this;
            contact.removeAllViews();
            int n = list == null ? 0 : list.length();
            if (n == 0) {
                contact.addView(Ui.icon(c, CollectorCreator.I_AT, 13, Ui.G600), Ui.wrap());
                TextView t = Ui.text(c, "Add contact", 12.5f, Ui.G600);
                contact.addView(t, Ui.margins(Ui.wrap(), 5, 0, 0, 0));
                contact.setOnClickListener(v -> addContact(rid, null));
                return;
            }
            contact.setOnClickListener(null);
            JSONObject best = list.optJSONObject(0);
            String k0 = best.optString("kind");
            View m0 = CollectorCreator.brand(c, k0, 13, CollectorCreator.brandColor(k0));
            contact.addView(m0, new LinearLayout.LayoutParams(Ui.dp(13), Ui.dp(13)));
            TextView t = Ui.subtitle(Ui.text(c, best.optString("text") + "  · " + best.optString("source"), 12.5f, Ui.FG));
            t.setOnClickListener(v -> openContact(best));
            contact.addView(t, Ui.margins(new LinearLayout.LayoutParams(0, -2, 1), 5, 0, 0, 0));
            for (int i = 1; i < Math.min(n, 4); i++) {
                final JSONObject o = list.optJSONObject(i);
                String k = o.optString("kind");
                android.widget.FrameLayout b = new android.widget.FrameLayout(c);
                b.addView(CollectorCreator.brand(c, k, 13, CollectorCreator.brandColor(k)), new android.widget.FrameLayout.LayoutParams(Ui.dp(13), Ui.dp(13), Gravity.CENTER));
                b.setContentDescription(o.optString("tip"));
                b.setOnClickListener(v -> openContact(o));
                contact.addView(b, new LinearLayout.LayoutParams(Ui.dp(26), Ui.dp(24)));
            }
            if (n > 4) contact.addView(Ui.text(c, "+" + (n - 4), 11.5f, Ui.G700), Ui.wrap());
            TextView plus = Ui.icon(c, Ui.I_PLUS, 14, Ui.G600);
            plus.setGravity(Gravity.CENTER);
            plus.setContentDescription("Add another way to contact them");
            plus.setOnClickListener(v -> addContact(rid, list));
            contact.addView(plus, new LinearLayout.LayoutParams(Ui.dp(28), Ui.dp(24)));
        }

        JSONObject video(int i) {
            JSONArray vids = cur == null ? null : cur.optJSONArray("videos");
            return vids == null || i >= vids.length() ? null : vids.optJSONObject(i);
        }

        void bind(JSONObject r) {
            Collector c = Collector.this;
            cur = r;
            final String nm = r.optString("name"), rid = r.optString("id"), mail = r.optString("email");
            final boolean restricted = r.optBoolean("restricted"), approved = !restricted && r.optBoolean("approved");
            ini.setText(initials(nm));
            ini.setBackground(Ui.round(color(rid), 0, 22));
            String aid = r.optString("avatarId", "");
            Thumbs.load(c, hub, aid.isEmpty() || "null".equals(aid) ? null : "/v1/collector/avatar?id=" + aid, av, Ui.dp(44), Ui.dp(44));
            name.setText(nm);
            badge.setText(r.optString("platform"));
            final String reach = r.optString("reach", "");
            reachBox.removeAllViews();
            if (!reach.isEmpty() && !"null".equals(reach)) {
                View m = CollectorCreator.reachMark(c, reach);
                m.setOnClickListener(v -> push(new CollectorCreator.Compose(c, rid, nm, reach)));
                reachBox.addView(m, new android.widget.FrameLayout.LayoutParams(-1, -1));
                reachBox.setVisibility(View.VISIBLE);
            } else reachBox.setVisibility(View.GONE);
            String handle = r.optString("handle");
            link.setText((handle.isEmpty() ? "" : handle + " · ") + r.optString("short"));
            bindContacts(rid, r.optJSONArray("contacts"));
            // Sent: the channel and the day it went; Approved: the Persons list Approve put them in, and the day
            String sl = r.optString("sentLine", ""), al = r.optString("approvedLine", ""), ato = r.optString("approvedTo", "");
            boolean sentLine = "sent".equals(sel) && !sl.isEmpty(), apprLine = "approved".equals(sel) && !al.isEmpty();
            email.setVisibility(sentLine || apprLine ? View.VISIBLE : View.GONE);
            if (sentLine) email.setText("Sent · " + sl);
            else if (apprLine) email.setText(ato.isEmpty() ? al : "Approved · " + al);
            JSONArray vids = r.optJSONArray("videos");
            boolean any = vids != null && vids.length() > 0;
            thumbs.setVisibility(any ? View.VISIBLE : View.GONE);
            int tw = thumbW();
            for (int i = 0; i < 3; i++) {
                JSONObject v = any && i < vids.length() ? vids.optJSONObject(i) : null;
                ImageView iv = th[i];
                iv.setVisibility(v == null ? View.INVISIBLE : View.VISIBLE);
                String tid = v == null ? "" : v.optString("thumbId", "");
                iv.setContentDescription(v == null ? null : v.optString("title"));
                Thumbs.load(c, hub, tid.isEmpty() || "null".equals(tid) ? null : "/v1/collector/avatar?id=" + tid, iv, tw, Ui.dp(THUMB_H));
            }
            act.setText(approved ? "Unapprove" : restricted ? "Unrestrict" : "Restrict");
        }
    }

    /** A card's video thumbnails: three across the card, this tall (dp). */
    static final int THUMB_H = 84;
    private int thumbW;

    private int thumbW() {
        if (thumbW == 0) {
            int w = getResources().getDisplayMetrics().widthPixels - Ui.dp(16 * 2) - Ui.dp(Ds.CARD_PAD_X * 2) - Ui.dp(12);
            thumbW = Math.max(Ui.dp(40), w / 3);
        }
        return thumbW;
    }

    /** A card's contact tapped: WhatsApp, a Discord invite or user, an Instagram open; an email (or a Discord username)
     *  is copied. */
    void openContact(JSONObject o) {
        String href = o.optString("href", "");
        if (!href.isEmpty()) Ui.openUrl(this, href);
        else {
            Ui.copy(this, o.optString("value"));
            Ui.toast(this, "Copied " + o.optString("text"));
        }
    }

    /** Add contact: the channel (Email, WhatsApp, Discord, Instagram; the first they have nothing on), then its value.
     *  A typed one is never replaced by one found later. */
    void addContact(final String id, JSONArray have) {
        final String[] kinds = {"email", "whatsapp", "discord", "instagram"};
        java.util.Set<String> got = new java.util.HashSet<>();
        for (int i = 0; have != null && i < have.length(); i++) got.add(have.optJSONObject(i).optString("kind"));
        final String[] pick = {"email"};
        for (String k : kinds) if (!got.contains(k)) { pick[0] = k; break; }
        LinearLayout box = Ui.col(this);
        box.setPadding(Ui.dp(20), Ui.dp(8), Ui.dp(20), 0);
        final LinearLayout row = Ui.row(this);
        final EditText f = Ui.input(this, "", false);
        f.setTypeface(Ui.sans);
        final Runnable[] draw = new Runnable[1];
        draw[0] = () -> {
            row.removeAllViews();
            for (final String k : kinds) {
                boolean on = k.equals(pick[0]);
                android.widget.FrameLayout b = new android.widget.FrameLayout(this);
                b.setBackground(Ui.press(on ? CollectorCreator.tint(CollectorCreator.brandColor(k)) : Ui.G100, on ? Ui.G700 : 0, 10));
                View m = CollectorCreator.brand(this, k, 18, on ? CollectorCreator.brandColor(k) : Ui.G600);
                if (!on) m.setAlpha(0.6f);
                b.addView(m, new android.widget.FrameLayout.LayoutParams(Ui.dp(18), Ui.dp(18), Gravity.CENTER));
                b.setContentDescription(CollectorCreator.reachLabel(k));
                b.setOnClickListener(v -> { pick[0] = k; draw[0].run(); });
                row.addView(b, Ui.margins(new LinearLayout.LayoutParams(Ui.dp(44), Ui.dp(40)), 0, 0, 6, 0));
            }
            String k = pick[0];
            f.setHint("email".equals(k) ? "name@studio.com" : "whatsapp".equals(k) ? "+55 21 97570-9440" : "discord".equals(k) ? "discord.gg/invite, user ID or username" : "@handle or instagram.com/handle");
            f.setInputType("email".equals(k) ? InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS : "whatsapp".equals(k) ? InputType.TYPE_CLASS_PHONE : InputType.TYPE_CLASS_TEXT);
        };
        draw[0].run();
        box.addView(row, Ui.margins(Ui.fill(), 0, 0, 0, 8));
        box.addView(f, Ui.fill());
        Ui.dialog(this).setTitle("Add contact").setView(box)
                .setPositiveButton("Save", (d, w) -> {
                    if (hub == null) return;
                    final Hub h = hub;
                    final String kind = pick[0];
                    JSONObject b = new JSONObject();
                    try { b.put("id", id).put("kind", kind).put("value", f.getText().toString().trim()); } catch (Exception ignored) { }
                    Ui.pool.execute(() -> {
                        try {
                            h.call("POST", "/v1/collector/contact", b);
                            Ui.main.post(() -> { Ui.toast(this, CollectorCreator.reachLabel(kind) + " saved"); load(); });
                        } catch (Exception e) {
                            Ui.main.post(() -> Ui.toast(this, h.whyDown(e)));
                        }
                    });
                })
                .setNegativeButton("Cancel", null).show();
    }

    /** Type (or correct) a lead's email; a typed one is never replaced by one found later. Empty clears it. */
    void editEmail(String id, String current) { editEmail(id, current, null); }

    /** The same, `then` once the PC saved it (a lead's detail draws itself again). */
    void editEmail(String id, String current, Runnable then) {
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
                            Ui.main.post(() -> { Ui.toast(this, "Email saved"); load(); if (then != null) then.run(); });
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
