package dev.harbor.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.text.TextUtils;
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
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/** One chat: the transcript (refetched from the last revision whenever the hub says the chat
 *  changed, so streaming text grows in place), and the composer with attachments, Send, Stop.
 *  The chat list slides in from the left, its team (Team) from the right. */
public class Chat extends Base {
    private String chatId;
    private WorkBar work;
    private ScrollView scroll;
    private LinearLayout content, status;
    private TextView recapLine;     // the hub's recap in the bars, hidden while typing
    private Composer comp;
    private EditText composer;
    private Attach attach;
    private Run run;
    private long typedAt;           // last typing ping
    private String sentDraft;       // the draft that ping carried
    private final Runnable draftPing = this::pingDraft;
    private java.util.List<String[]> typingLines = new java.util.ArrayList<>(); // who else types, and what (Sidebar.typingLines)
    private JSONObject bars;        // the items reply's "status": queue, working, waiting, limit
    private TextView workingText;   // "Working… · 12s", ticking
    private Boolean stripOpen;      // the agent strip unfolded (null: the hub's default)
    private final java.util.List<TextView> stripTimes = new java.util.ArrayList<>(); // its elapsed labels
    private boolean running;
    private Render render;
    private Team team;
    private Slash slash;
    private String usageLabel = "", usageDetail = ""; // the chat's tokens and cost so far (cost.rs)
    private JSONObject shown;                         // the chat the header shows
    private Tags tags;

    /** Items drawn at first; "Show earlier" adds this many more (a long chat would otherwise
     *  keep thousands of views alive and slow down every update). */
    static final int WINDOW = 120;

    private final TreeMap<Integer, JSONObject> items = new TreeMap<>();
    private final TreeMap<Integer, View> views = new TreeMap<>(); // seq >= from only
    private final Set<Integer> expanded = new HashSet<>();
    /** Runs of tool calls opened from their chevron row, by the run's id (its `group`). */
    private final Set<Integer> openGroups = new HashSet<>();
    private View hintView;   // the empty / error line
    private TextView earlier; // "Show earlier" on top
    private int from = -1;          // first seq drawn (-1: not known yet)
    private long rev;
    private boolean loading, again, loaded, sending, gone; // gone: deleted, keep no draft
    private TextView offNote;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        if (noHub()) return;
        chatId = getIntent().getStringExtra("chat");
        render = new Render(this, null);
        LinearLayout root = frame("Chat", menuButton(), false);
        action(Ui.I_PANEL_RIGHT, v -> openRight()).setContentDescription("Team: agents, processes, wake-ups, webhooks");
        action(Ui.I_MENU, v -> {
            JSONObject c = Hub.chat(Hub.states.get(hub.id), chatId);
            if (c != null) Chats.menu(this, hub, c, this::refreshState, this::deleted);
        });
        barTitle.setOnClickListener(v -> {
            JSONObject c = Hub.chat(Hub.states.get(hub.id), chatId);
            if (c != null) Chats.rename(this, hub, c, this::refreshState);
        });
        // The desktop header's usage hover: tokens in (cached), out, cost and turns.
        barSub.setOnClickListener(v -> {
            if (!usageDetail.isEmpty()) Ui.dialog(this).setTitle("Usage").setMessage(usageDetail).setPositiveButton("Close", null).show();
        });

        scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        content = Ui.col(this);
        content.setPadding(0, Ui.dp(4), 0, Ui.dp(12));
        scroll.addView(content);
        // The bars under it grow (the agent strip unfolds, a recap arrives): the transcript keeps
        // its end in view when it was there, instead of new cards sliding under the bars.
        scroll.addOnLayoutChangeListener((v, l, top, r, bottom, ol, oldTop, or, oldBottom) -> {
            int was = oldBottom - oldTop, now = bottom - top;
            if (now < was && scroll.getScrollY() + was >= content.getHeight() - Ui.dp(120)) scroll.post(() -> scroll.scrollTo(0, content.getHeight()));
        });
        // The transcript and the bars under it; the slash menu floats over their bottom.
        FrameLayout stage = new FrameLayout(this);
        LinearLayout above = Ui.col(this);
        above.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));

        // The desktop's bars under the transcript: queued messages, working, waiting for
        // sub-agents, usage limit; and who else is typing.
        status = Ui.col(this);
        status.setPadding(Ui.dp(20), 0, Ui.dp(20), Ui.dp(6));
        above.addView(status, Ui.fill());
        stage.addView(above, frameFill());
        root.addView(stage, new LinearLayout.LayoutParams(-1, 0, 1));

        attach = new Attach(this, hub, chatId);
        comp = new Composer(this, attach, "Chat with Claude…");
        composer = comp.edit;
        slash = new Slash(this, hub, chatId, comp.edit, this::harbor);
        stage.addView(slash.view, Ui.margins(new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM), 12, 12, 12, 6));
        // `@` files and `#` issues and PRs share the composer's cursor and Back with the slash menu.
        tags = new Tags(this, hub, chatId, comp.edit);
        stage.addView(tags.view, Ui.margins(new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM), 12, 12, 12, 6));
        comp.edit.onSelection = () -> { slash.update(); tags.update(); };
        comp.edit.backOpen = () -> slash.open() || tags.open();
        comp.edit.onBack = () -> { if (!slash.back()) tags.back(); };
        // The recap steps aside while typing: the keyboard leaves little room for the transcript.
        comp.edit.getViewTreeObserver().addOnGlobalFocusChangeListener((was, now) -> recapWhileTyping());
        comp.edit.getViewTreeObserver().addOnGlobalLayoutListener(this::recapWhileTyping);
        composer.setText(drafts(this).getString(draftKey(hub, chatId), ""));
        comp.onSend = this::send;
        comp.onStop = this::stop;
        comp.onType = this::typed;
        comp.onPill = () -> {
            if (run == null) return;
            Sheet sh = new Sheet(this, "Run settings");
            run.rows(this, sh, (f, v) -> { sh.dismiss(); change(f, v); });
            sh.show();
        };
        comp.onPlus = () -> Composer.addSheet(this, attach, run, this::change);
        // The composer, and under it where the agent works and its branch (WorkBar).
        work = new WorkBar(this, hub);
        work.chat = chatId;
        LinearLayout below = Ui.col(this);
        below.addView(comp.view, Ui.fill());
        below.addView(work.view, Ui.fill());
        root.addView(below, Ui.margins(Ui.fill(), 12, 0, 12, 12));
        comp.voice(hub);
        work.load();
        // Another PC's chat while that PC is off: read-only, this note instead of the composer.
        offNote = Ui.text(this, "", 15, Ui.G700);
        offNote.setBackground(Ui.round(Ui.CARD, Ui.LINE, 20));
        offNote.setPadding(Ui.dp(18), Ui.dp(14), Ui.dp(18), Ui.dp(14));
        offNote.setVisibility(View.GONE);
        root.addView(offNote, Ui.margins(Ui.fill(), 12, 0, 12, 12));
        installDrawer(chatId);
        team = new Team(this, chatId);
        installRight(team.view);

        showChat(Hub.chat(Hub.states.get(hub.id), chatId));
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (hub == null) return;
        Update.shown(this, hub.id, chatId);
        load(!loaded);
        refreshState();
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (comp.voice != null) comp.voice.cancel();
        if (composer == null || gone) return;
        typing(false);
        String d = composer.getText().toString();
        if (d.trim().isEmpty()) drafts(this).edit().remove(draftKey(hub, chatId)).apply();
        else drafts(this).edit().putString(draftKey(hub, chatId), d).apply();
    }

    @Override
    void onEvents(Set<String> changed, boolean stateChanged, boolean reconnect) {
        if (reconnect || changed.contains(chatId)) load(reconnect);
        if (reconnect || stateChanged) work.load();
        if (stateChanged) refreshState();
        // The hub counts a change in a team as a change of its lead.
        if (rightOpen() && (reconnect || stateChanged || changed.contains(chatId) || changed.contains(team.lead))) team.load();
    }

    @Override
    void onRightOpened() { team.load(); }

    @Override
    void onOffline(boolean off, String why) {
        // The header says it, and the drawer has the same card as the chat list (Try again).
        if (side != null) {
            if (off) side.offline(hub.downTitle(offlineError), why, this::retryNow);
            else side.offline(null, null, null);
        }
        if (off) sub(why, Ui.RED); else { showChat(Hub.chat(Hub.states.get(hub.id), chatId)); load(true); }
    }

    @Override
    void refresh() { refreshState(); }

    private void deleted() {
        gone = true;
        forget(this, hub.id, chatId);
        finish();
    }

    // ---- header ----

    private void refreshState() {
        Ui.pool.execute(() -> {
            try {
                JSONObject st = hub.state();
                Ui.main.post(() -> {
                    if (isFinishing()) return;
                    JSONObject c = Hub.chat(st, chatId);
                    if (c == null) { Ui.toast(this, "This chat was deleted"); deleted(); return; }
                    showChat(c);
                    if (side != null && drawerOpen()) side.render(st);
                });
            } catch (Exception ignored) { }
        });
    }

    /** Title, and the chat's fixed settings as one grey line. */
    private void showChat(JSONObject c) {
        if (c == null) return;
        shown = c;
        String t = c.optString("title");
        barTitle.setText(t.isEmpty() ? "New chat" : t);
        JSONObject st = Hub.states.get(hub.id);
        run = new Run(st, c);
        comp.pill.setText(run.pill());
        String k = run.kind();
        composer.setHint("Chat with " + (k.isEmpty() ? "Claude" : Character.toUpperCase(k.charAt(0)) + k.substring(1)) + "…");
        String dev = run.deviceLabel(), acc = run.accountLabel();
        // A chat that runs on another PC of the mesh: that PC's name.
        String home = c.optString("home_name", "");
        if (st != null && !c.optString("home", "").isEmpty() && !c.optString("home").equals(st.optString("hub_id"))) dev = home;
        String line = dev.isEmpty() ? acc : dev + " · " + acc;
        // The desktop header's usage, dim, before the settings so it's never what gets cut off
        // (a tap on the line shows its split).
        sub(usageLabel.isEmpty() ? line : usageLabel + " · " + line, Ui.G700);
        boolean ro = c.has("writable") && !c.optBoolean("writable", true);
        offNote.setText(home + " is off. This chat runs there, so it's read-only until " + home + " is back; then it catches up.");
        offNote.setVisibility(ro ? View.VISIBLE : View.GONE);
        comp.view.setVisibility(ro ? View.GONE : View.VISIBLE);
        slash.settings(run.account + "/" + run.device + "/" + run.access + "/" + run.project, c.optString("home", ""), home);
        typingLines = Sidebar.typingLines(c, st == null ? "" : st.optString("you", ""));
        drawBars();
    }

    static String info(JSONObject st, JSONObject c) {
        List<String> parts = new ArrayList<>();
        String kind = "";
        if (st != null) {
            String dev = Hub.labelOf(st.optJSONArray("devices"), c.optString("device"));
            if (!dev.isEmpty()) parts.add(dev);
            JSONArray acc = st.optJSONArray("accounts");
            String aid = c.optString("account");
            if (acc != null) for (int i = 0; i < acc.length(); i++) {
                JSONObject a = acc.optJSONObject(i);
                if (a != null && aid.equals(a.optString("id"))) kind = a.optString("kind");
            }
            if (!aid.isEmpty()) parts.add(Hub.labelOf(acc, aid));
        }
        String m = c.optString("model");
        if (!m.isEmpty()) parts.add(st == null ? m : Hub.labelOf(byKind(st, "models", kind), m));
        String e = c.optString("effort");
        if (!e.isEmpty()) parts.add(st == null ? e : Hub.labelOf(byKind(st, "efforts", kind), e));
        String x = c.optString("access");
        if (!x.isEmpty()) parts.add(st == null ? x : Hub.labelOf(byKind(st, "access", kind), x));
        if (c.optBoolean("fast")) parts.add("fast");
        return TextUtils.join(" · ", parts);
    }

    /** state[key][kind] (models, efforts, access are keyed by provider kind). */
    static JSONArray byKind(JSONObject st, String key, String kind) {
        Object o = st.opt(key);
        if (o instanceof JSONArray) return (JSONArray) o;
        if (o instanceof JSONObject) {
            JSONArray a = ((JSONObject) o).optJSONArray(kind);
            return a != null ? a : new JSONArray();
        }
        return new JSONArray();
    }

    // ---- transcript ----

    private void load(boolean full) {
        if (loading) { again = true; return; }
        loading = true;
        final long since = full ? 0 : rev;
        Ui.pool.execute(() -> {
            JSONObject r = null;
            String err = null;
            int code = 0;
            try {
                r = hub.get("/v1/chats/" + chatId + "/items?since=" + since);
            } catch (Exception e) {
                err = Hub.why(e);
                if (e instanceof Hub.ApiError) code = ((Hub.ApiError) e).code;
            }
            final JSONObject fr = r; final String ferr = err; final int fcode = code;
            Ui.main.post(() -> {
                loading = false;
                if (isFinishing()) return;
                if (fr != null) apply(fr, full);
                else if (fcode == 404) { Ui.toast(this, "This chat was deleted"); deleted(); return; }
                else if (!loaded) { clear(); hintView = hint(ferr); content.addView(hintView); }
                if (again) { again = false; load(false); }
            });
        });
    }

    private void apply(JSONObject r, boolean full) {
        boolean atBottom = !loaded || scroll.getScrollY() + scroll.getHeight() >= content.getHeight() - Ui.dp(120);
        if (!loaded || full) clear();
        loaded = true;
        rev = Math.max(full ? 0 : rev, r.optLong("rev"));
        Set<Integer> touched = new java.util.TreeSet<>(); // in order, so each lands after its predecessors
        if (full) items.clear();
        JSONArray a = r.optJSONArray("items");
        if (a != null) for (int i = 0; i < a.length(); i++) {
            JSONObject it = a.optJSONObject(i);
            if (it == null) continue;
            int seq = it.optInt("seq");
            JSONObject old = items.get(seq);
            if (old != null && old.optLong("rev") > it.optLong("rev")) continue;
            items.put(seq, it);
            touched.add(seq);
        }
        // Undo / truncate on the PC: drop what's past the end.
        if (r.has("count")) {
            int count = r.optInt("count");
            for (Integer s : new ArrayList<>(items.tailMap(count).keySet())) {
                items.remove(s);
                View v = views.remove(s);
                if (v != null) content.removeView(v);
            }
        }
        // Drop the "No messages" / error hint before placing items by position.
        if (hintView != null) { content.removeView(hintView); hintView = null; }
        if (!items.isEmpty() && (from < 0 || from > items.lastKey())) from = Math.max(0, items.lastKey() + 1 - WINDOW);
        // A run's chevron row (on its first card) counts its tool calls and turns while one runs:
        // it's drawn again when a card of the run changes, or the chat stops or starts running.
        boolean wasRunning = running;
        if (r.has("running")) running = r.optBoolean("running");
        for (int seq : new ArrayList<>(touched)) {
            int g = items.get(seq) == null ? -1 : items.get(seq).optInt("group", -1);
            if (g >= 0 && items.containsKey(g)) touched.add(g);
        }
        if (running != wasRunning) for (Map.Entry<Integer, JSONObject> e : items.entrySet())
            if (e.getValue().optInt("group", -1) == e.getKey()) touched.add(e.getKey());
        for (int seq : touched) if (seq >= from && items.containsKey(seq)) place(seq);
        earlierButton();
        if (items.isEmpty()) { hintView = emptyView(); content.addView(hintView); }
        if (r.has("typing")) typingLines = Sidebar.typingLines(r, you());
        bars = r.optJSONObject("status");
        JSONObject u = r.optJSONObject("usage");
        String label = u == null ? "" : u.optString("label");
        usageDetail = u == null ? "" : u.optString("detail");
        if (!label.equals(usageLabel)) { usageLabel = label; showChat(shown); }
        drawBars();
        if (atBottom) toEnd();
    }

    /** An empty chat: a lead says what the desktop says ("What should we work on?" and who
     *  does the work), in the phone's serif; other chats the plain hint. */
    private View emptyView() {
        if (shown == null || !"lead".equals(shown.optString("role"))) return hint("No messages yet.");
        LinearLayout v = Ui.col(this);
        v.setGravity(Gravity.CENTER_HORIZONTAL);
        v.setPadding(Ui.dp(24), Ui.dp(96), Ui.dp(24), Ui.dp(24));
        TextView ask = Ui.title(this, "What should we work on?", 30);
        ask.setGravity(Gravity.CENTER);
        v.addView(ask, Ui.fill());
        String p = run == null ? "" : run.projectLabel();
        TextView sub = Ui.text(this, "The lead plans and delegates to subagents" + (run == null || p.equals("No project") ? "." : " in " + p + "."), 15, Ui.G700);
        sub.setGravity(Gravity.CENTER);
        v.addView(sub, Ui.margins(Ui.fill(), 0, 10, 0, 0));
        return v;
    }

    private void clear() {
        content.removeAllViews();
        views.clear();
        hintView = earlier = null;
    }

    /** (Re)draws item seq in its place among the drawn ones. */
    private void place(int seq) {
        View nv = itemView(items.get(seq));
        View ov = views.put(seq, nv);
        int idx;
        if (ov != null) {
            idx = content.indexOfChild(ov);
            content.removeView(ov);
        } else {
            Integer next = views.higherKey(seq);
            idx = next == null ? content.getChildCount() : content.indexOfChild(views.get(next));
        }
        content.addView(nv, Math.max(0, Math.min(idx, content.getChildCount())), Ui.fill());
    }

    private void earlierButton() {
        boolean want = from > 0 && !items.isEmpty();
        if (want && earlier == null) {
            earlier = Ui.button(this, "", false, v -> showEarlier());
            content.addView(earlier, 0, Ui.margins(Ui.fill(), 16, 4, 16, 8));
        } else if (!want && earlier != null) {
            content.removeView(earlier);
            earlier = null;
        }
        if (earlier != null) earlier.setText("Show " + Math.min(from, WINDOW) + " earlier");
    }

    private void showEarlier() {
        int old = from;
        from = Math.max(0, from - WINDOW);
        int before = content.getHeight(), y = scroll.getScrollY();
        for (int seq = from; seq < old; seq++) if (items.containsKey(seq)) place(seq);
        // A run of tool calls that started above: its row moves up to its first card.
        Integer next = items.ceilingKey(old);
        while (next != null && "hidden".equals(items.get(next).optString("kind"))) next = items.higherKey(next);
        if (next != null && items.get(next).has("group")) place(next);
        earlierButton();
        // Keep what was on screen where it was.
        content.getViewTreeObserver().addOnGlobalLayoutListener(new android.view.ViewTreeObserver.OnGlobalLayoutListener() {
            @Override public void onGlobalLayout() {
                content.getViewTreeObserver().removeOnGlobalLayoutListener(this);
                scroll.scrollTo(0, y + content.getHeight() - before);
            }
        });
    }

    /** Scrolls to the end once the new items are laid out. */
    private void toEnd() {
        android.view.ViewTreeObserver o = content.getViewTreeObserver();
        o.addOnGlobalLayoutListener(new android.view.ViewTreeObserver.OnGlobalLayoutListener() {
            @Override public void onGlobalLayout() {
                content.getViewTreeObserver().removeOnGlobalLayoutListener(this);
                scroll.scrollTo(0, content.getHeight());
            }
        });
        content.requestLayout();
    }

    /** The desktop's bars (PROTOCOL.md "status"), then who else is typing. */
    private void drawBars() {
        status.removeAllViews();
        workingText = null;
        JSONObject b = bars == null ? new JSONObject() : bars;
        JSONArray queue = b.optJSONArray("queue");
        if (queue != null) for (int i = 0; i < queue.length(); i++) {
            JSONObject q = queue.optJSONObject(i);
            if (q == null) continue;
            LinearLayout w = Ui.col(this);
            w.setGravity(Gravity.END);
            TextView tag = Ui.text(this, q.optBoolean("sending") ? "Sending" : "Queued", 12, Ui.G700);
            w.addView(tag);
            TextView t = Ui.text(this, q.optString("text"), 15, Ui.G900);
            t.setBackground(Ui.round(Ui.G100, Ui.LINE, 18));
            t.setPadding(Ui.dp(14), Ui.dp(8), Ui.dp(14), Ui.dp(8));
            t.setMaxWidth(maxBubble());
            w.addView(t, Ui.wrap());
            JSONArray f = q.optJSONArray("files");
            if (f != null) for (int j = 0; j < f.length(); j++) w.addView(Ui.text(this, "📎 " + f.optString(j), 12, Ui.G700));
            status.addView(w, Ui.margins(Ui.fill(), 36, 4, 0, 4));
        }
        JSONObject waiting = b.optJSONObject("waiting"), working = b.optJSONObject("working"), limit = b.optJSONObject("limit");
        // A hub with the agent strip shows waiting sub-agents there (with Stop all): no waiting bar.
        if (b.optJSONObject("agents") != null) waiting = null;
        if (waiting != null) {
            LinearLayout r = Ui.row(this);
            JSONArray ag = waiting.optJSONArray("agents");
            int n = ag == null ? 0 : ag.length();
            LinearLayout dots = Ui.row(this);
            for (int i = 0; i < Math.min(n, 3); i++) {
                String name = ag.optJSONObject(i) == null ? "?" : ag.optJSONObject(i).optString("name", "?");
                TextView d = Ui.bold(this, name.isEmpty() ? "?" : name.substring(0, 1).toUpperCase(), 11, 0xffffffff);
                d.setGravity(Gravity.CENTER);
                d.setBackground(Ui.round(new int[]{0xff7a6ad8, 0xff3f7fd6, 0xffb07a2a}[i % 3], 0, 11));
                LinearLayout.LayoutParams dp = new LinearLayout.LayoutParams(Ui.dp(22), Ui.dp(22));
                if (i > 0) dp.leftMargin = -Ui.dp(6);
                dots.addView(d, dp);
            }
            r.addView(dots);
            int q = waiting.optInt("queued");
            String text = "Waiting for " + n + (n == 1 ? " sub-agent" : " sub-agents") + " to finish" + (q > 0 ? " · " + q + " queued" : "");
            r.addView(Ui.subtitle(Ui.text(this, text, 14, Ui.G700)), Ui.margins(Ui.weight(), 10, 0, 8, 0));
            r.addView(small("Stop all", () -> post("stop_all")));
            status.addView(r, Ui.margins(Ui.fill(), 0, 4, 0, 4));
        } else if (working != null) {
            LinearLayout r = Ui.row(this);
            r.addView(Ui.icon(this, Ui.I_LOADER, 15, Ui.G700));
            workingText = Ui.subtitle(Ui.text(this, "", 14, Ui.G700));
            workingText.setTag(working);
            r.addView(workingText, Ui.margins(Ui.weight(), 8, 0, 0, 0));
            status.addView(r, Ui.margins(Ui.fill(), 0, 4, 0, 4));
            tick();
        }
        if (limit != null) {
            LinearLayout r = Ui.row(this);
            r.addView(Ui.icon(this, Ui.I_CLOCK, 15, Ui.AMBER));
            r.addView(Ui.text(this, limit.optString("text"), 14, Ui.G900), Ui.margins(Ui.weight(), 8, 0, 8, 0));
            status.addView(r, Ui.margins(Ui.fill(), 0, 4, 0, 4));
            // The chips under the line: a phone is too narrow for three beside the text.
            LinearLayout acts = Ui.row(this);
            acts.addView(small("Continue now", () -> post("continue")));
            if (limit.optBoolean("can_cancel")) acts.addView(small("Cancel", () -> post("cancel_limit")), Ui.margins(Ui.wrap(), 6, 0, 0, 0));
            // Continue on another account of the provider (hubs from 0.48 send `targets`).
            JSONArray targets = limit.optJSONArray("targets");
            if (targets != null && targets.length() > 0) acts.addView(small("Continue on…", () -> continueOn(targets)), Ui.margins(Ui.wrap(), 6, 0, 0, 0));
            status.addView(acts, Ui.margins(Ui.fill(), 23, 0, 0, 4));
        }
        for (String[] l : typingLines) {
            if (l[1] == null) {
                status.addView(Ui.subtitle(Ui.text(this, l[0], 14, Ui.BLUE)), Ui.margins(Ui.fill(), 0, 4, 0, 4));
                continue;
            }
            TextView t = Ui.text(this, l[0] + l[1], 14, Ui.BLUE);
            t.setMaxLines(2);
            status.addView(t, Ui.margins(Ui.fill(), 0, 4, 0, 4));
            t.post(() -> fitTwoLines(t, l[0], l[1]));
        }
        strip(b.optJSONObject("agents"));
        // The hub's recap over the composer, its suggestion in the empty composer (Recap.java).
        TextView recap = Recap.line(this, b);
        if (recap != null) status.addView(recap, Ui.margins(Ui.fill(), 0, 4, 0, 4));
        recapLine = recap;
        Recap.suggest(comp, b.optString("suggestion", ""));
        recapWhileTyping();
        comp.running(running);
    }

    /** Hides the recap while the composer has focus with the keyboard up (it comes back when the
     *  keyboard closes), and the bars with it when it was their only line. */
    private void recapWhileTyping() {
        boolean typing = comp.edit.hasFocus();
        if (typing && android.os.Build.VERSION.SDK_INT >= 30) {
            android.view.WindowInsets in = comp.edit.getRootWindowInsets();
            typing = in == null || in.isVisible(android.view.WindowInsets.Type.ime());
        }
        int want = typing ? View.GONE : View.VISIBLE;
        if (recapLine != null && recapLine.getVisibility() != want) recapLine.setVisibility(want);
        boolean any = false;
        for (int i = 0; i < status.getChildCount() && !any; i++) any = status.getChildAt(i).getVisibility() != View.GONE;
        int bars = any ? View.VISIBLE : View.GONE;
        if (status.getVisibility() != bars) status.setVisibility(bars);
    }

    /** The desktop's agent strip over the composer (agentstrip.rs, PROTOCOL.md "status.agents"):
     *  one row per running sub-agent, "name · doing · 2m", folded into "3 agents working" from
     *  three on. Tapping a row opens the agent; tapping the title folds or unfolds. */
    private void strip(JSONObject s) {
        stripTimes.clear();
        Ui.main.removeCallbacks(stripTicker);
        JSONArray rows = s == null ? null : s.optJSONArray("rows");
        if (rows == null || rows.length() == 0) return;
        boolean folded = s.optBoolean("folded");
        boolean open = !folded || (stripOpen != null && stripOpen);
        // The rows, and Stop all in the top row's corner (`POST stop_all`, as the waiting bar's was).
        LinearLayout outer = Ui.row(this);
        outer.setGravity(Gravity.TOP);
        outer.setBackground(Ui.round(Ui.BG2, Ui.LINE, 12));
        outer.setPadding(Ui.dp(4), Ui.dp(4), Ui.dp(4), Ui.dp(4));
        LinearLayout box = Ui.col(this);
        outer.addView(box, Ui.weight());
        TextView stop = Ui.icon(this, Ui.I_STOP, 15, Ui.G700);
        stop.setBackground(Ui.press(0, 0, 8));
        stop.setContentDescription("Stop all");
        stop.setOnClickListener(v -> post("stop_all"));
        outer.addView(stop, new LinearLayout.LayoutParams(Ui.dp(36), Ui.dp(36)));
        if (s.optBoolean("header", folded)) {
            LinearLayout h = Ui.row(this);
            h.setPadding(Ui.dp(8), Ui.dp(8), Ui.dp(10), Ui.dp(8));
            LinearLayout marks = Ui.row(this);
            for (int i = 0; i < Math.min(rows.length(), 4); i++) {
                JSONObject r = rows.optJSONObject(i);
                View m = Ui.accountMark(this, r == null ? "" : r.optString("logo"), "", 16);
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(Ui.dp(16), Ui.dp(16));
                if (i > 0) lp.leftMargin = -Ui.dp(4);
                marks.addView(m, lp);
            }
            h.addView(marks);
            StringBuilder names = new StringBuilder();
            for (int i = 0; i < rows.length(); i++) {
                JSONObject r = rows.optJSONObject(i);
                if (r != null) names.append(names.length() > 0 ? ", " : "").append(r.optString("name"));
            }
            h.addView(Ui.bold(this, s.optString("title"), 14, Ui.FG), Ui.margins(Ui.wrap(), 8, 0, 0, 0));
            h.addView(Ui.subtitle(Ui.text(this, "  ·  " + names, 14, Ui.G700)), Ui.weight());
            // Folded it unfolds; unfolded (it says what's queued) it opens the Agents panel.
            h.setBackground(Ui.press(0, 0, 8));
            if (folded) {
                h.addView(Ui.icon(this, open ? Ui.I_UP_CHEVRON : Ui.I_DOWN, 13, Ui.G700), Ui.margins(Ui.wrap(), 6, 0, 0, 0));
                h.setOnClickListener(v -> { stripOpen = !open; drawBars(); });
            } else h.setOnClickListener(v -> openRight());
            box.addView(h, Ui.fill());
        }
        if (open) for (int i = 0; i < rows.length(); i++) {
            JSONObject r = rows.optJSONObject(i);
            if (r == null) continue;
            LinearLayout row = Ui.row(this);
            row.setPadding(Ui.dp(8), Ui.dp(8), Ui.dp(10), Ui.dp(8));
            row.setBackground(Ui.press(0, 0, 8));
            row.addView(Ui.accountMark(this, r.optString("logo"), r.optString("badge"), 18));
            // Name and what it's doing first; its tokens and cost (agentstrip.rs) on a dim line
            // under them, so a narrow screen never squeezes the doing text out.
            LinearLayout text = Ui.col(this);
            LinearLayout top = Ui.row(this);
            TextView name = Ui.subtitle(Ui.bold(this, r.optString("name"), 14, Ui.FG));
            name.setMaxWidth(Ui.dp(140));
            top.addView(name, Ui.wrap());
            top.addView(Ui.subtitle(Ui.text(this, "  ·  " + r.optString("doing"), 14, Ui.G700)), Ui.weight());
            text.addView(top, Ui.fill());
            String usage = r.optString("usage");
            if (!usage.isEmpty()) {
                TextView u = Ui.subtitle(Ui.text(this, usage, 11, Ui.G600));
                u.setTypeface(Ui.mono);
                text.addView(u, Ui.fill());
            }
            row.addView(text, Ui.margins(Ui.weight(), 8, 0, 0, 0));
            TextView time = Ui.text(this, "", 12, Ui.G700);
            time.setTypeface(Ui.mono);
            time.setTag(r.optLong("since_ms"));
            stripTimes.add(time);
            row.addView(time, Ui.margins(Ui.wrap(), 8, 0, 0, 0));
            String id = r.optString("id");
            row.setOnClickListener(v -> open(this, hub, id));
            box.addView(row, Ui.fill());
        }
        status.addView(outer, Ui.margins(Ui.fill(), 0, 4, 0, 4));
        stripTick();
    }

    private final Runnable stripTicker = this::stripTick;

    /** The strip's "40s", "2m", "1h 5m" (agentstrip::short_elapsed), counted here. */
    private void stripTick() {
        Ui.main.removeCallbacks(stripTicker);
        if (stripTimes.isEmpty() || isFinishing()) return;
        for (TextView t : stripTimes) {
            long s = Math.max(0, (System.currentTimeMillis() - (Long) t.getTag()) / 1000);
            t.setText(s < 60 ? s + "s" : s < 3600 ? s / 60 + "m" : s / 3600 + "h " + s % 3600 / 60 + "m");
        }
        Ui.main.postDelayed(stripTicker, 1000);
    }

    private TextView small(String label, Runnable on) {
        TextView t = Ui.bold(this, label, 13, Ui.FG);
        t.setPadding(Ui.dp(12), Ui.dp(6), Ui.dp(12), Ui.dp(6));
        t.setBackground(Ui.press(Ui.CARD, Ui.LINE, 14));
        t.setOnClickListener(v -> on.run());
        return t;
    }

    /** "Working… · 1 sub-agent running · 12s": the elapsed part counts here, once a second. */
    private final Runnable ticker = this::tick;

    private void tick() {
        Ui.main.removeCallbacks(ticker);
        if (workingText == null || isFinishing()) return;
        JSONObject w = (JSONObject) workingText.getTag();
        long s = Math.max(0, (System.currentTimeMillis() - w.optLong("since_ms")) / 1000);
        String el = s < 60 ? s + "s" : s / 60 + "m " + s % 60 + "s";
        String text = w.optString("text", "Working…");
        workingText.setText(text + " · " + el);
        Ui.main.postDelayed(ticker, 1000);
    }

    /** The limit line's Continue on…: a sheet of the accounts the hub offers; the chat moves
     *  to the one picked and continues there (`POST continue_on`). */
    private void continueOn(JSONArray targets) {
        List<Sheet.Option> o = new ArrayList<>();
        for (int i = 0; i < targets.length(); i++) {
            JSONObject t = targets.optJSONObject(i);
            if (t == null) continue;
            String name = t.optString("name", t.optString("id"));
            int dot = name.indexOf(" · ");
            o.add(new Sheet.Option(t.optString("id"), dot > 0 ? name.substring(0, dot) : name, dot > 0 ? name.substring(dot + 3) : "", true));
        }
        Sheet.pick(this, "Continue on", "This account is at its usage limit. The chat moves to the one you pick and goes on there now.", o, null, id -> {
            JSONObject body = new JSONObject();
            try { body.put("account", id); } catch (Exception ignored) { }
            Ui.bg(this, () -> hub.call("POST", "/v1/chats/" + chatId + "/continue_on", body), r -> load(false));
        });
    }

    private void post(String action) {
        Ui.bg(this, () -> hub.call("POST", "/v1/chats/" + chatId + "/" + action, null), r -> load(false));
    }

    private String you() {
        JSONObject st = Hub.states.get(hub.id);
        return st == null ? "" : st.optString("you", "");
    }

    // ---- run settings and typing ----

    /** A run-settings pick: PATCH the chat; the hub answers with the chat as it is now. */
    private void change(String field, Object value) {
        JSONObject body = new JSONObject();
        try { body.put(field, value); } catch (Exception ignored) { }
        Ui.bg(this, () -> hub.call("PATCH", "/v1/chats/" + chatId, body), r -> {
            JSONObject c = r.optJSONObject("chat");
            if (c != null) {
                JSONObject st = Hub.states.get(hub.id);
                if (st != null) replaceChat(st, c);
                showChat(c);
            } else refreshState();
        });
    }

    /** The slash menu's Harbor commands: /model and /effort open their pickers, /new a new chat
     *  in the project; /plan, /default, /fork, /settle and /clear-queue act on the PC, as its
     *  composer does them. */
    private void harbor(String command) {
        if ("model".equals(command)) {
            if (run != null) run.pickModel(this, this::change);
            return;
        }
        if ("effort".equals(command)) {
            if (run != null) run.pickEffort(this, this::change);
            return;
        }
        if ("new".equals(command)) {
            Intent i = new Intent(this, NewChat.class).putExtra("hub", hub.id);
            if (run != null && !run.project.isEmpty()) i.putExtra("project", run.project);
            startActivity(i);
            return;
        }
        if ("fork".equals(command) || "settle".equals(command) || "clear-queue".equals(command)) {
            Ui.bg(this, () -> slash.call("POST", "/v1/chats/" + chatId + "/slash", new JSONObject().put("command", command)), r -> {
                if ("fork".equals(command)) {
                    // Its id on the PC that forked it: by the state's ids when that's another PC.
                    if (slash.elsewhere() || r.optString("id").isEmpty()) { refreshState(); Ui.toast(this, "Forked: the new chat is in the list"); }
                    else open(this, hub, r.optString("id"));
                } else if ("settle".equals(command)) {
                    refreshState();
                    Ui.toast(this, "Settled");
                } else {
                    int n = r.optInt("dropped");
                    Ui.toast(this, n == 1 ? "Dropped 1 waiting message" : "Dropped " + n + " waiting messages");
                    refreshState();
                }
            });
            return;
        }
        // To the PC that gave the menu (the one calls go to may not have it).
        Ui.bg(this, () -> slash.call("POST", "/v1/chats/" + chatId + "/slash", new JSONObject().put("command", command)), r -> {
            JSONObject c = r.optJSONObject("chat");
            // From another PC its answer has that PC's ids: the state says it with ours.
            if (c == null || slash.elsewhere()) {
                refreshState();
                Ui.toast(this, "plan".equals(command) ? "Read only: this chat reads and plans, and changes nothing" : "Back from read only");
                return;
            }
            JSONObject st = Hub.states.get(hub.id);
            if (st != null) replaceChat(st, c);
            showChat(c);
            Ui.toast(this, "plan".equals(command) ? "Read only: this chat reads and plans, and changes nothing" : "Permission: " + run.accessLabel());
        });
    }

    @Override
    public void onBackPressed() {
        if (!drawerOpen() && !rightOpen() && slash != null && (slash.back() || tags.back())) return;
        super.onBackPressed();
    }

    private static void replaceChat(JSONObject st, JSONObject c) {
        JSONArray a = st.optJSONArray("chats");
        if (a == null) return;
        for (int i = 0; i < a.length(); i++) {
            JSONObject o = a.optJSONObject(i);
            if (o != null && o.optString("id").equals(c.optString("id"))) { try { a.put(i, c); } catch (Exception ignored) { } return; }
        }
    }

    /** `head` and as much of the end of `draft` as fits in two lines, "…" in front when it's cut
     *  (TextView only ellipsizes the start of a single line). */
    private static void fitTwoLines(TextView t, String head, String draft) {
        int w = t.getWidth() - t.getPaddingLeft() - t.getPaddingRight();
        if (w <= 0) return;
        java.util.function.IntPredicate fits = from -> {
            String s = from == 0 ? head + draft : head + "…" + draft.substring(from);
            return android.text.StaticLayout.Builder.obtain(s, 0, s.length(), t.getPaint(), w).build().getLineCount() <= 2;
        };
        if (fits.test(0)) return;
        int lo = 1, hi = draft.length();
        while (lo < hi) {
            int mid = (lo + hi) / 2;
            if (fits.test(mid)) hi = mid; else lo = mid + 1;
        }
        // Not inside a surrogate pair.
        if (lo < draft.length() && Character.isLowSurrogate(draft.charAt(lo))) lo++;
        t.setText(head + "…" + draft.substring(lo));
    }

    /** The draft goes to the hub at most every 400 ms while it changes (the last one always
     *  goes), and every 3 s anyway while the user types; the hub expires it after 6 s. An
     *  emptied composer stops at once. */
    private void typed() {
        Ui.main.removeCallbacks(draftPing);
        if (composer.getText().toString().trim().isEmpty()) { typing(false); return; }
        long wait = typedAt + 400 - System.currentTimeMillis();
        if (wait <= 0) pingDraft();
        else Ui.main.postDelayed(draftPing, wait);
    }

    private void pingDraft() {
        if (composer == null || gone) return;
        String d = composer.getText().toString().trim();
        long now = System.currentTimeMillis();
        if (d.isEmpty() || d.equals(sentDraft) && now - typedAt < 3000) return;
        typedAt = now;
        sentDraft = d;
        typing(true);
    }

    private void typing(boolean on) {
        if (!on) Ui.main.removeCallbacks(draftPing);
        if (!on && typedAt == 0) return;
        if (!on) { typedAt = 0; sentDraft = null; }
        Hub h = hub;
        String id = chatId;
        // The end of the draft, as much as the hub keeps (PROTOCOL.md "Typing").
        String d = on && sentDraft != null ? sentDraft.substring(Math.max(0, sentDraft.length() - 500)) : null;
        Ui.pool.execute(() -> {
            try {
                JSONObject b = new JSONObject().put("typing", on).put("kind", "phone");
                if (d != null) b.put("text", d);
                h.call("POST", "/v1/chats/" + id + "/typing", b);
            } catch (Exception ignored) { }
        });
    }

    /** A card's `images` without those its `media` already draws large. */
    private static JSONArray notShown(JSONObject it) {
        JSONArray images = it.optJSONArray("images"), media = it.optJSONArray("media");
        if (images == null || media == null) return images;
        java.util.Set<String> shown = new java.util.HashSet<>();
        for (int i = 0; i < media.length(); i++) {
            JSONObject m = media.optJSONObject(i);
            if (m != null) shown.add(m.optString("url"));
        }
        JSONArray out = new JSONArray();
        for (int i = 0; i < images.length(); i++) {
            JSONObject im = images.optJSONObject(i);
            if (im != null && !shown.contains(im.optString("url"))) out.put(im);
        }
        return out;
    }

    /** One card of the hub's projection, drawn as the desktop draws it (PROTOCOL.md): no
     *  filtering or grouping of our own; "hidden" cards draw nothing (but their fork dividers). */
    private View itemView(JSONObject it) {
        String kind = it.optString("kind");
        LinearLayout wrap = Ui.col(this);
        wrap.setPadding(Ui.dp(20), Ui.dp(6), Ui.dp(20), Ui.dp(6));
        int seq = it.optInt("seq");
        switch (kind) {
            case "hidden":
                break;
            case "user": {
                wrap.setGravity(Gravity.END);
                LinearLayout bubble = Ui.col(this);
                bubble.setBackground(Ui.round(Ui.G100, 0, 20));
                bubble.setPadding(Ui.dp(16), Ui.dp(11), Ui.dp(16), Ui.dp(11));
                JSONArray mentions = it.optJSONArray("mentions");
                if (mentions != null) for (int i = 0; i < mentions.length(); i++) {
                    JSONObject m = mentions.optJSONObject(i);
                    if (m == null) continue;
                    String said = m.optBoolean("excerpt") ? "\u201c" + m.optString("text") + "\u201d" : m.optString("text");
                    TextView chip = Ui.subtitle(Ui.text(this, m.optString("from") + ": " + said, 13, Ui.G900));
                    chip.setBackground(Ui.round(Ui.CARD, Ui.LINE, 12));
                    chip.setPadding(Ui.dp(10), Ui.dp(4), Ui.dp(10), Ui.dp(4));
                    chip.setMaxWidth(maxBubble());
                    bubble.addView(chip, Ui.margins(Ui.wrap(), 0, 0, 0, 6));
                    String note = m.optString("note");
                    if (!note.isEmpty()) {
                        TextView n = Ui.text(this, note, 14, Ui.G900);
                        n.setMaxWidth(maxBubble());
                        bubble.addView(n, Ui.margins(Ui.wrap(), 10, 0, 0, 8));
                    }
                }
                View imgs = Images.strip(this, hub, it.optJSONArray("images"), 96);
                if (imgs != null) bubble.addView(imgs, Ui.margins(Ui.wrap(), 0, 0, 0, 6));
                String text = it.optString("text");
                if (!text.isEmpty()) {
                    TextView t = Ui.text(this, text, 16, Ui.FG);
                    t.setMaxWidth(maxBubble());
                    bubble.addView(t);
                }
                JSONArray files = it.optJSONArray("files");
                if (files != null) for (int i = 0; i < files.length(); i++) {
                    String n = files.optString(i);
                    n = n.substring(n.lastIndexOf('/') + 1);
                    TextView f = Ui.text(this, "📎 " + n, 13, Ui.G700);
                    f.setMaxWidth(maxBubble());
                    bubble.addView(f);
                }
                // Written on another PC or a phone: "from …" small in the bubble's bottom-right
                // corner (as the desktop shows it).
                String from = it.optString("sender", "");
                TextView fromView = null;
                if (!from.isEmpty()) {
                    fromView = Ui.text(this, "from " + from, 12, Ui.G700);
                    fromView.setSingleLine(true);
                    fromView.setEllipsize(TextUtils.TruncateAt.END);
                    fromView.setGravity(Gravity.END);
                    bubble.addView(fromView, Ui.margins(Ui.fill(), 0, 2, 0, 0));
                }
                bubble.setOnLongClickListener(v -> { itemMenu(it, text, false); return true; });
                // Hug the content like the desktop: as wide as the longest line (or the image
                // strip), at most maxBubble(); a wrap_content bubble cut lines short next to images.
                android.text.TextPaint tp = new android.text.TextPaint();
                tp.setTextSize(android.util.TypedValue.applyDimension(android.util.TypedValue.COMPLEX_UNIT_SP, 16, getResources().getDisplayMetrics()));
                tp.setTypeface(Ui.sans);
                float need = 0;
                for (String line : text.split("\n")) need = Math.max(need, tp.measureText(line));
                JSONArray ims = it.optJSONArray("images");
                if (ims != null && ims.length() > 0) need = Math.max(need, Math.min(ims.length(), 3) * Ui.dp(104));
                if (files != null && files.length() > 0) need = Math.max(need, Ui.dp(160));
                if (fromView != null) need = Math.max(need, fromView.getPaint().measureText(fromView.getText().toString()));
                int avail = getResources().getDisplayMetrics().widthPixels - Ui.dp(76); // the row's padding
                int w = (int) Math.min(need + Ui.dp(34), Math.min(avail, maxBubble() + Ui.dp(32)));
                wrap.addView(bubble, new LinearLayout.LayoutParams(w, -2));
                wrap.setPadding(Ui.dp(56), Ui.dp(10), Ui.dp(20), Ui.dp(10));
                break;
            }
            case "text": {
                String md = it.optString("markdown");
                boolean forkable = it.optBoolean("forkable");
                View.OnLongClickListener lp = v -> { itemMenu(it, md, forkable); return true; };
                Render r = new Render(this, lp).commits(it.optJSONObject("commits"), (sha, info) -> CommitSheet.open(this, hub, chatId, sha, info));
                View body = r.text(it);
                body.setOnLongClickListener(lp);
                wrap.setOnLongClickListener(lp);
                wrap.addView(body, Ui.fill());
                View shown = Media.list(this, hub, it.optJSONArray("media"));
                if (shown != null) wrap.addView(shown, Ui.margins(Ui.fill(), 0, 8, 0, 0));
                View imgs = Images.strip(this, hub, notShown(it), 120);
                if (imgs != null) wrap.addView(imgs, Ui.margins(Ui.fill(), 0, 8, 0, 0));
                break;
            }
            case "media": {
                // An image or video an agent showed (show_media).
                View shown = Media.list(this, hub, it.optJSONArray("media"));
                if (shown != null) wrap.addView(shown, Ui.fill());
                else wrap.addView(Ui.text(this, "Can't show this file here", 13, Ui.G700), Ui.fill());
                break;
            }
            case "thinking":
                fold(wrap, seq, Ui.I_BRAIN, Ui.G700, "Thinking", "", () -> {
                    TextView t = Ui.text(this, it.optString("text"), 15, Ui.G700);
                    t.setTypeface(Ui.sans, android.graphics.Typeface.ITALIC);
                    t.setOnLongClickListener(v -> { Ui.copy(this, it.optString("text")); return true; });
                    return t;
                });
                break;
            case "tool": {
                boolean done = it.optBoolean("done", !it.isNull("result"));
                boolean err = it.optBoolean("is_error");
                String glyph = !done ? Ui.I_LOADER : err ? Ui.I_CIRCLE_X : Ui.I_CIRCLE_CHECK;
                int tint = !done ? Ui.G900 : err ? Ui.RED : Ui.GREEN;
                fold(wrap, seq, glyph, tint, it.optString("label", it.optString("name")), it.optString("summary"), () -> {
                    LinearLayout c = Ui.col(this);
                    String in = json(it.opt("input"));
                    if (!in.isEmpty()) c.addView(render.code(null, clip(in)), Ui.margins(Ui.fill(), 0, 0, 0, 6));
                    String res = json(it.opt("result"));
                    if (!res.isEmpty()) {
                        View box = render.code(null, clip(res));
                        if (err) tint(box, Ui.RED);
                        c.addView(box, Ui.fill());
                    }
                    return c;
                });
                View vids = Media.list(this, hub, it.optJSONArray("media"));
                if (vids != null) wrap.addView(vids, Ui.margins(Ui.fill(), 30, 6, 0, 0));
                View imgs = Images.strip(this, hub, notShown(it), 96);
                if (imgs != null) wrap.addView(imgs, Ui.margins(Ui.fill(), 30, 6, 0, 0));
                break;
            }
            // "footer" (a turn's usage line, from hubs before 0.59.2): not drawn, as on the desktop.
            case "forked_from":
                wrap.addView(divider("Forked from conversation", "Open source conversation",
                        () -> open(this, hub, it.optString("chat"))), Ui.fill());
                break;
            case "chat_link": {
                // A chat an agent opened: back to the chat it came from, or on to the new one.
                String to = it.isNull("chat") ? "" : it.optString("chat", "");
                if (to.isEmpty()) {
                    TextView t = Ui.text(this, it.optString("text"), 13, Ui.G700);
                    t.setGravity(Gravity.CENTER_HORIZONTAL);
                    wrap.addView(t, Ui.fill());
                } else {
                    wrap.addView(divider(it.optString("text"), "Open chat", () -> open(this, hub, to)), Ui.fill());
                }
                break;
            }
            case "notice":
                notice(wrap, it, seq);
                break;
            case "message": {
                LinearLayout card = Ui.col(this);
                card.setBackground(Ui.round(Ui.dark ? 0xff1d2a3a : 0xffeaf2fd, Ui.dark ? 0xff2c4766 : 0xffc4dafa, 16));
                card.setPadding(Ui.dp(14), Ui.dp(10), Ui.dp(14), Ui.dp(12));
                LinearLayout head = Ui.row(this);
                head.addView(Ui.icon(this, Ui.I_CHAT, 15, Ui.BLUE));
                head.addView(Ui.bold(this, it.optString("from") + " → " + it.optString("to"), 15, Ui.BLUE), Ui.margins(Ui.wrap(), 8, 0, 0, 0));
                card.addView(head);
                String text = it.optString("text");
                card.addView(Ui.text(this, clip(text), 15, Ui.FG), Ui.margins(Ui.fill(), 0, 6, 0, 0));
                card.setOnLongClickListener(v -> { Ui.copy(this, text); return true; });
                wrap.addView(card, Ui.fill());
                break;
            }
            case "error": {
                TextView t = Ui.text(this, clip(it.optString("text")), 13, Ui.RED);
                t.setTypeface(Ui.mono);
                t.setBackground(Ui.round(Ui.RED_BG, 0, 14));
                t.setPadding(Ui.dp(14), Ui.dp(10), Ui.dp(14), Ui.dp(10));
                t.setOnLongClickListener(v -> { Ui.copy(this, t.getText().toString()); return true; });
                wrap.addView(t, Ui.fill());
                break;
            }
            default:
                break; // a card this version doesn't know
        }
        // "Conversation fork · Open fork" right after this card, once per fork.
        JSONArray forks = it.optJSONArray("forks_after");
        if (forks != null) for (int i = 0; i < forks.length(); i++) {
            String f = forks.optString(i);
            wrap.addView(divider("Conversation fork", "Open fork", () -> open(this, hub, f)), Ui.margins(Ui.fill(), 0, 6, 0, 0));
        }
        if (wrap.getChildCount() == 0) wrap.setVisibility(View.GONE);
        return grouped(it, wrap);
    }

    /** The desktop's centred notice pill; expands to its detail, or opens its link. */
    private void notice(LinearLayout wrap, JSONObject it, int seq) {
        String icon = it.optString("icon"), detail = it.optString("detail", "");
        String url = it.isNull("url") ? "" : it.optString("url", "");
        String glyph;
        switch (icon) {
            case "bot": case "report": glyph = Ui.I_BOT; break;
            case "wake": case "clock": glyph = Ui.I_CLOCK; break;
            case "webhook": glyph = Ui.I_WEBHOOK; break;
            case "alert": glyph = Ui.I_ALERT; break;
            case "fork": glyph = Ui.I_FORK; break;
            case "process": glyph = Ui.I_ACTIVITY; break;
            case "restart": glyph = Ui.I_ROTATE; break;
            case "users": glyph = Ui.I_USERS; break;
            default: glyph = Ui.I_CIRCLE_CHECK;
        }
        boolean expandable = !detail.isEmpty() && url.isEmpty();
        LinearLayout pill = Ui.row(this);
        pill.setBackground(Ui.press(Ui.G100, Ui.LINE, 16));
        pill.setPadding(Ui.dp(12), Ui.dp(6), Ui.dp(12), Ui.dp(6));
        pill.addView(Ui.icon(this, glyph, 14, Ui.G700));
        pill.addView(Ui.text(this, it.optString("text"), 14, Ui.FG), Ui.margins(Ui.wrap(), 6, 0, 0, 0));
        TextView chev = Ui.icon(this, expanded.contains(seq) ? Ui.I_UP_CHEVRON : Ui.I_DOWN, 13, Ui.G700);
        if (expandable) pill.addView(chev, Ui.margins(Ui.wrap(), 6, 0, 0, 0));
        LinearLayout.LayoutParams pp = Ui.wrap();
        pp.gravity = Gravity.CENTER_HORIZONTAL;
        wrap.addView(pill, pp);
        if (!url.isEmpty()) {
            pill.setOnClickListener(v -> {
                try { startActivity(new Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url))); } catch (Exception e) { Ui.copy(this, url); }
            });
        } else if (expandable) {
            final View[] body = {null};
            Runnable show = () -> {
                LinearLayout well = Ui.col(this);
                well.setBackground(Ui.round(Ui.G100, 0, 12));
                well.setPadding(Ui.dp(12), Ui.dp(10), Ui.dp(12), Ui.dp(10));
                if (it.optBoolean("detail_markdown")) well.addView(new Render(this, null).para(detail), Ui.fill());
                else {
                    TextView d = Ui.text(this, clip(detail), 13, Ui.FG);
                    d.setTypeface(Ui.mono);
                    well.addView(d, Ui.fill());
                }
                body[0] = well;
                wrap.addView(well, Ui.margins(Ui.fill(), 0, 8, 0, 0));
            };
            if (expanded.contains(seq)) show.run();
            pill.setOnClickListener(v -> {
                if (expanded.remove(seq)) {
                    if (body[0] != null) wrap.removeView(body[0]);
                    chev.setText(Ui.I_DOWN);
                } else {
                    expanded.add(seq);
                    show.run();
                    chev.setText(Ui.I_UP_CHEVRON);
                }
            });
            pill.setOnLongClickListener(v -> { Ui.copy(this, detail); return true; });
        }
    }

    /** A thin line with a label and a link in the middle (fork dividers). */
    private View divider(String label, String link, Runnable on) {
        LinearLayout r = Ui.row(this);
        r.setPadding(0, Ui.dp(6), 0, Ui.dp(6));
        View l = new View(this);
        l.setBackgroundColor(Ui.LINE);
        r.addView(l, new LinearLayout.LayoutParams(0, Ui.dp(1), 1));
        r.addView(Ui.text(this, label + " · ", 13, Ui.G700), Ui.margins(Ui.wrap(), 10, 0, 0, 0));
        TextView a = Ui.bold(this, link, 13, Ui.BLUE);
        a.setBackground(Ui.press(0, 0, 8));
        a.setOnClickListener(v -> on.run());
        r.addView(a, Ui.margins(Ui.wrap(), 0, 0, 10, 0));
        View l2 = new View(this);
        l2.setBackgroundColor(Ui.LINE);
        r.addView(l2, new LinearLayout.LayoutParams(0, Ui.dp(1), 1));
        return r;
    }

    private static void tint(View box, int color) {
        if (box instanceof android.view.ViewGroup) {
            android.view.ViewGroup g = (android.view.ViewGroup) box;
            for (int i = 0; i < g.getChildCount(); i++) tint(g.getChildAt(i), color);
        } else if (box instanceof TextView) ((TextView) box).setTextColor(color);
    }

    interface Body { View make(); }

    /** A one-line row (status icon, label, summary) that expands to body on tap, like the desktop. */
    /** A card in a run of tool calls (its `group`, PROTOCOL.md): the run's first card carries the
     *  chevron row ("› 5 tool calls"); the cards show only while the run is open. Opens on a tap,
     *  never by itself. Without `group` (an older hub) the card draws as it is. */
    private View grouped(JSONObject it, LinearLayout card) {
        int g = it.optInt("group", -1), seq = it.optInt("seq");
        if (g < 0) return card;
        boolean open = openGroups.contains(g);
        if (!open) card.setVisibility(View.GONE);
        // The run starts above the drawn window ("Show earlier"): its first drawn card has the row.
        boolean first = g == seq;
        if (g < from && seq >= from) {
            first = true;
            for (JSONObject m : items.subMap(from, seq).values()) if (m.optInt("group", -1) == g) first = false;
        }
        if (!first) return card;
        int calls = 0;
        boolean pending = false;
        for (JSONObject m : items.tailMap(g).values()) {
            if (m.optInt("group", -1) != g) { if (!"hidden".equals(m.optString("kind"))) break; continue; }
            if (!"tool".equals(m.optString("kind"))) continue;
            calls++;
            if (!m.optBoolean("done", !m.isNull("result"))) pending = true;
        }
        LinearLayout col = Ui.col(this);
        LinearLayout head = Ui.row(this);
        head.setPadding(Ui.dp(20), Ui.dp(4), Ui.dp(20), Ui.dp(4));
        head.addView(Ui.icon(this, open ? Ui.I_DOWN : Ui.I_RIGHT, 13, Ui.G700));
        head.addView(Ui.text(this, calls + (calls == 1 ? " tool call" : " tool calls"), 13, Ui.G700), Ui.margins(Ui.wrap(), 6, 0, 0, 0));
        if (pending && running) {
            TextView spin = Ui.icon(this, Ui.I_LOADER, 12, Ui.G700);
            android.view.animation.RotateAnimation a = new android.view.animation.RotateAnimation(0, 360,
                    android.view.animation.Animation.RELATIVE_TO_SELF, 0.5f, android.view.animation.Animation.RELATIVE_TO_SELF, 0.5f);
            a.setDuration(1200);
            a.setRepeatCount(android.view.animation.Animation.INFINITE);
            a.setInterpolator(new android.view.animation.LinearInterpolator());
            spin.startAnimation(a);
            head.addView(spin, Ui.margins(Ui.wrap(), 8, 0, 0, 0));
        }
        head.setBackground(Ui.press(0, 0, 10));
        head.setOnClickListener(v -> {
            if (!openGroups.remove(g)) openGroups.add(g);
            for (Map.Entry<Integer, JSONObject> e : new ArrayList<>(items.tailMap(g).entrySet())) {
                if (e.getValue().optInt("group", -1) != g) { if (!"hidden".equals(e.getValue().optString("kind"))) break; continue; }
                if (e.getKey() >= from) place(e.getKey());
            }
        });
        col.addView(head, Ui.wrap());
        col.addView(card, Ui.fill());
        return col;
    }

    private void fold(LinearLayout wrap, int seq, String glyph, int tint, String name, String summary, Body body) {
        LinearLayout head = Ui.row(this);
        head.setPadding(Ui.dp(10), Ui.dp(7), Ui.dp(10), Ui.dp(7));
        head.setBackground(Ui.press(expanded.contains(seq) ? Ui.BG2 : 0, 0, 12));
        head.addView(Ui.icon(this, glyph, 15, tint));
        TextView n = Ui.bold(this, name, 15, Ui.FG);
        n.setSingleLine(true);
        head.addView(n, Ui.margins(Ui.wrap(), 10, 0, 0, 0));
        TextView s = Ui.subtitle(Ui.text(this, summary, 13, Ui.G700));
        s.setTypeface(Ui.mono);
        head.addView(s, Ui.margins(Ui.weight(), 10, 0, 0, 0));
        wrap.addView(head, Ui.fill());
        final View[] open = {null};
        Runnable show = () -> {
            open[0] = body.make();
            wrap.addView(open[0], Ui.margins(Ui.fill(), 10, 6, 0, 0));
        };
        if (expanded.contains(seq)) show.run();
        head.setOnClickListener(v -> {
            if (expanded.remove(seq)) {
                if (open[0] != null) wrap.removeView(open[0]);
                head.setBackground(Ui.press(0, 0, 12));
            } else {
                expanded.add(seq);
                show.run();
                head.setBackground(Ui.press(Ui.BG2, 0, 12));
            }
        });
    }

    private int maxBubble() { return (int) (getResources().getDisplayMetrics().widthPixels * 0.78f); }

    private static String json(Object o) {
        if (o == null || o == JSONObject.NULL) return "";
        try {
            if (o instanceof JSONObject) return ((JSONObject) o).toString(2);
            if (o instanceof JSONArray) return ((JSONArray) o).toString(2);
        } catch (Exception ignored) { }
        return String.valueOf(o);
    }

    private static String clip(String s) {
        return s.length() > 20000 ? s.substring(0, 20000) + "\n… (" + (s.length() - 20000) + " more characters)" : s;
    }

    private void itemMenu(JSONObject it, String text, boolean canFork) {
        List<String> opts = new ArrayList<>();
        opts.add("Copy");
        if (canFork) opts.add("Fork from here"); // the hub's "forkable", the desktop's fork button
        Ui.dialog(this).setItems(opts.toArray(new String[0]), (d, w) -> {
            if (w == 0) Ui.copy(this, text);
            else fork(it.optInt("seq"));
        }).show();
    }

    // ---- actions ----

    private void fork(int seq) {
        Ui.bg(this, () -> hub.call("POST", "/v1/chats/" + chatId + "/fork", new JSONObject().put("seq", seq)), r -> {
            String id = r.optString("id");
            if (id.isEmpty()) return;
            Ui.toast(this, "Forked");
            open(this, hub, id);
        });
    }

    // ---- drafts ----

    /** Unsent composer text, per hub and chat: "<hub id>/<chat id>" (chat ids repeat across PCs). */
    static SharedPreferences drafts(Context c) {
        SharedPreferences p = c.getSharedPreferences("drafts", MODE_PRIVATE);
        // Older versions keyed by chat id alone: keep them only when that can't mix up PCs.
        List<Hub> hubs = null;
        SharedPreferences.Editor e = null;
        for (Map.Entry<String, ?> d : p.getAll().entrySet()) {
            if (d.getKey().contains("/")) continue;
            if (hubs == null) { hubs = Hub.all(c); e = p.edit(); }
            if (hubs.size() == 1 && d.getValue() instanceof String) e.putString(draftKey(hubs.get(0), d.getKey()), (String) d.getValue());
            e.remove(d.getKey());
        }
        if (e != null) e.apply();
        return p;
    }

    static String draftKey(Hub hub, String chat) { return hub.id + "/" + chat; }

    /** Drops a hub's drafts (unpaired), or one chat's (deleted) when chat isn't null. */
    static void forget(Context c, String hubId, String chat) {
        SharedPreferences p = c.getSharedPreferences("drafts", MODE_PRIVATE);
        SharedPreferences.Editor e = p.edit();
        for (String k : p.getAll().keySet())
            if (chat == null ? k.startsWith(hubId + "/") : k.equals(hubId + "/" + chat)) e.remove(k);
        e.apply();
    }

    static void open(Context c, Hub hub, String id) {
        c.startActivity(new Intent(c, Chat.class).putExtra("hub", hub.id).putExtra("chat", id));
    }

    private void stop() {
        Ui.bg(this, () -> hub.call("POST", "/v1/chats/" + chatId + "/stop", null), r -> {
            // Messages that waited behind the stopped turn come back: into the composer, as on
            // the desktop, ahead of whatever is being typed.
            JSONArray back = r.optJSONArray("returned");
            if (back != null && back.length() > 0) {
                StringBuilder sb = new StringBuilder();
                for (int i = 0; i < back.length(); i++) {
                    JSONObject m = back.optJSONObject(i);
                    if (m == null) continue;
                    String t = m.optString("text").trim();
                    if (!t.isEmpty()) sb.append(sb.length() > 0 ? "\n\n" : "").append(t);
                    JSONArray f = m.optJSONArray("files");
                    if (f != null) for (int j = 0; j < f.length(); j++) attach.addUploaded(f.optString(j));
                }
                String now = composer.getText().toString().trim();
                if (!now.isEmpty()) sb.append(sb.length() > 0 ? "\n\n" : "").append(now);
                composer.setText(sb);
                composer.setSelection(composer.length());
                Ui.toast(this, back.length() == 1 ? "The waiting message is back in the composer" : back.length() + " waiting messages are back in the composer");
            }
            load(false);
        });
    }

    private void send() {
        if (sending) return;
        String text = composer.getText().toString().trim();
        if (text.isEmpty() && !attach.any()) return;
        if (attach.busy()) { Ui.toast(this, "Still uploading…"); return; }
        sending = true;
        comp.busy(true);
        typing(false);
        JSONArray files = attach.ids();
        Ui.pool.execute(() -> {
            String err = null;
            try {
                hub.call("POST", "/v1/chats/" + chatId + "/send", new JSONObject().put("text", text).put("files", files));
            } catch (Exception e) {
                err = Hub.why(e);
            }
            final String fe = err;
            Ui.main.post(() -> {
                sending = false;
                comp.busy(false);
                if (isFinishing()) return;
                if (fe != null) { Ui.toast(this, fe); return; }
                composer.setText("");
                attach.clear();
                drafts(this).edit().remove(draftKey(hub, chatId)).apply();
                toEnd();
                load(false);
            });
        });
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] granted) {
        super.onRequestPermissionsResult(req, perms, granted);
        attach.permission(req, granted);
        if (comp.voice != null) comp.voice.permission(req, granted);
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        attach.result(req, res, data);
    }
}
