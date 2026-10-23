package dev.harbor.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.widget.EditText;
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
 *  changed, so streaming text grows in place), and the composer with attachments, Send, Stop. */
public class Chat extends Base {
    private String chatId;
    private ScrollView scroll;
    private LinearLayout content, status;
    private TextView statusText, stopBtn, sendBtn;
    private EditText composer;
    private Attach attach;
    private Render render;

    /** Items drawn at first; "Show earlier" adds this many more (a long chat would otherwise
     *  keep thousands of views alive and slow down every update). */
    static final int WINDOW = 120;

    private final TreeMap<Integer, JSONObject> items = new TreeMap<>();
    private final TreeMap<Integer, View> views = new TreeMap<>(); // seq >= from only
    private final Set<Integer> expanded = new HashSet<>();
    private View hintView;   // the empty / error line
    private TextView earlier; // "Show earlier" on top
    private int from = -1;          // first seq drawn (-1: not known yet)
    private long rev;
    private boolean loading, again, loaded, sending, gone; // gone: deleted, keep no draft

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        if (noHub()) return;
        chatId = getIntent().getStringExtra("chat");
        render = new Render(this, null);
        LinearLayout root = frame("Chat", true);
        action(Ui.I_MENU, v -> {
            JSONObject c = Hub.chat(Hub.states.get(hub.id), chatId);
            if (c != null) Chats.menu(this, hub, c, this::refreshState, this::deleted);
        });
        barTitle.setOnClickListener(v -> {
            JSONObject c = Hub.chat(Hub.states.get(hub.id), chatId);
            if (c != null) Chats.rename(this, hub, c, this::refreshState);
        });

        scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        content = Ui.col(this);
        content.setPadding(0, Ui.dp(8), 0, Ui.dp(12));
        scroll.addView(content);
        root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));

        // Working / waiting line with Stop.
        status = Ui.row(this);
        status.setPadding(Ui.dp(16), Ui.dp(4), Ui.dp(8), Ui.dp(4));
        status.setBackgroundColor(Ui.BG2);
        statusText = Ui.text(this, "", 13, Ui.G900);
        status.addView(statusText, Ui.weight());
        stopBtn = Ui.bold(this, "Stop", 13, Ui.FG);
        stopBtn.setPadding(Ui.dp(14), Ui.dp(6), Ui.dp(14), Ui.dp(6));
        stopBtn.setBackground(Ui.press(Ui.G200, Ui.G400, 14));
        stopBtn.setOnClickListener(v -> stop());
        status.addView(stopBtn);
        status.setVisibility(View.GONE);
        root.addView(status, Ui.fill());

        attach = new Attach(this, hub, chatId);
        root.addView(attach.view, Ui.fill());

        LinearLayout comp = Ui.row(this);
        comp.setGravity(Gravity.BOTTOM);
        comp.setPadding(Ui.dp(4), Ui.dp(6), Ui.dp(6), Ui.dp(8));
        comp.addView(Ui.iconButton(this, Ui.I_CLIP, Ui.G900, v -> attach.choose()));
        composer = Ui.input(this, "Message", true);
        composer.setMaxLines(6);
        composer.setBackground(Ui.round(Ui.G100, Ui.G400, 20));
        composer.setPadding(Ui.dp(14), Ui.dp(10), Ui.dp(14), Ui.dp(10));
        composer.setText(drafts(this).getString(draftKey(hub, chatId), ""));
        comp.addView(composer, Ui.margins(Ui.weight(), 2, 0, 6, 0));
        sendBtn = Ui.icon(this, Ui.I_SEND, 18, Ui.BG);
        sendBtn.setBackground(Ui.press(Ui.FG, 0, 22));
        sendBtn.setOnClickListener(v -> send());
        comp.addView(sendBtn, new LinearLayout.LayoutParams(Ui.dp(44), Ui.dp(44)));
        root.addView(comp, Ui.fill());

        showChat(Hub.chat(Hub.states.get(hub.id), chatId));
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (hub == null) return;
        load(!loaded);
        refreshState();
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (composer == null || gone) return;
        String d = composer.getText().toString();
        if (d.trim().isEmpty()) drafts(this).edit().remove(draftKey(hub, chatId)).apply();
        else drafts(this).edit().putString(draftKey(hub, chatId), d).apply();
    }

    @Override
    void onEvents(Set<String> changed, boolean stateChanged, boolean reconnect) {
        if (reconnect || changed.contains(chatId)) load(reconnect);
        if (stateChanged) refreshState();
    }

    @Override
    void onOffline(boolean off, String why) {
        if (off) sub(why, Ui.RED); else { showChat(Hub.chat(Hub.states.get(hub.id), chatId)); load(true); }
    }

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
                });
            } catch (Exception ignored) { }
        });
    }

    /** Title, and the chat's fixed settings as one grey line. */
    private void showChat(JSONObject c) {
        if (c == null) return;
        String t = c.optString("title");
        barTitle.setText(t.isEmpty() ? "New chat" : t);
        JSONObject st = Hub.states.get(hub.id);
        sub(info(st, c), Ui.G700);
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
        for (int seq : touched) if (seq >= from && items.containsKey(seq)) place(seq);
        earlierButton();
        if (items.isEmpty()) { hintView = hint("No messages yet."); content.addView(hintView); }
        if (r.has("running") || r.has("queued")) showStatus(r.optBoolean("running"), Hub.queued(r));
        if (atBottom) toEnd();
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

    private void showStatus(boolean running, int queued) {
        String s = running ? "Working…" : "";
        if (queued > 0) s += (s.isEmpty() ? "" : "  ·  ") + queued + (queued == 1 ? " message waiting" : " messages waiting");
        statusText.setText(s);
        statusText.setTextColor(running ? Ui.GREEN : Ui.AMBER);
        stopBtn.setVisibility(running ? View.VISIBLE : View.GONE);
        status.setVisibility(s.isEmpty() ? View.GONE : View.VISIBLE);
    }

    private View itemView(JSONObject it) {
        String kind = it.optString("kind");
        LinearLayout wrap = Ui.col(this);
        wrap.setPadding(Ui.dp(16), Ui.dp(6), Ui.dp(16), Ui.dp(6));
        int seq = it.optInt("seq");
        switch (kind) {
            case "user": {
                wrap.setGravity(Gravity.END);
                LinearLayout bubble = Ui.col(this);
                bubble.setBackground(Ui.round(Ui.G300, 0, 14));
                bubble.setPadding(Ui.dp(14), Ui.dp(10), Ui.dp(14), Ui.dp(10));
                String text = it.optString("text");
                if (!text.isEmpty()) {
                    TextView t = Ui.text(this, text, 15, Ui.FG);
                    t.setMaxWidth(maxBubble());
                    bubble.addView(t);
                }
                JSONArray files = it.optJSONArray("files");
                if (files != null) for (int i = 0; i < files.length(); i++) {
                    String n = files.optString(i);
                    n = n.substring(n.lastIndexOf('/') + 1);
                    TextView f = Ui.text(this, (Attach.isImage(n) ? "▣ " : "▤ ") + n, 13, Ui.G900);
                    f.setMaxWidth(maxBubble());
                    bubble.addView(f);
                }
                bubble.setOnLongClickListener(v -> { itemMenu(it, text, false); return true; });
                wrap.addView(bubble, Ui.wrap());
                wrap.setPadding(Ui.dp(48), Ui.dp(8), Ui.dp(16), Ui.dp(8));
                break;
            }
            case "text": {
                String md = it.optString("markdown");
                View.OnLongClickListener lp = v -> { itemMenu(it, md, true); return true; };
                Render r = new Render(this, lp);
                View body = r.text(it);
                body.setOnLongClickListener(lp);
                wrap.setOnLongClickListener(lp);
                wrap.addView(body, Ui.fill());
                break;
            }
            case "thinking":
                fold(wrap, seq, Ui.I_BRAIN, "Thinking", "", Ui.G700, () -> {
                    TextView t = Ui.text(this, it.optString("text"), 14, Ui.G700);
                    t.setOnLongClickListener(v -> { Ui.copy(this, it.optString("text")); return true; });
                    return t;
                });
                break;
            case "tool": {
                boolean done = it.optBoolean("done", true);
                int tint = it.optBoolean("is_error") ? Ui.RED : done ? Ui.G700 : Ui.AMBER;
                fold(wrap, seq, Ui.I_HAMMER, it.optString("name"), it.optString("summary"), tint, () -> {
                    LinearLayout c = Ui.col(this);
                    String in = json(it.opt("input"));
                    if (!in.isEmpty()) {
                        c.addView(Ui.text(this, "Input", 12, Ui.G700));
                        c.addView(render.code(null, clip(in)), Ui.margins(Ui.fill(), 0, 4, 0, 8));
                    }
                    String res = json(it.opt("result"));
                    if (!res.isEmpty()) {
                        c.addView(Ui.text(this, "Result", 12, Ui.G700));
                        c.addView(render.code(null, clip(res)), Ui.margins(Ui.fill(), 0, 4, 0, 0));
                    } else if (!done) c.addView(Ui.text(this, "Running…", 13, Ui.AMBER));
                    return c;
                });
                break;
            }
            case "error": {
                TextView t = Ui.text(this, it.optString("text", it.optString("message")), 14, Ui.RED);
                t.setBackground(Ui.round(Ui.RED_BG, 0xff561a1e, 6));
                t.setPadding(Ui.dp(12), Ui.dp(8), Ui.dp(12), Ui.dp(8));
                t.setOnLongClickListener(v -> { Ui.copy(this, t.getText().toString()); return true; });
                wrap.addView(t, Ui.fill());
                break;
            }
            case "notice": {
                TextView t = Ui.text(this, it.optString("text", it.optString("message")), 12, Ui.G700);
                t.setGravity(Gravity.CENTER);
                wrap.addView(t, Ui.fill());
                String detail = it.optString("detail", "");
                if (!detail.isEmpty()) {
                    // e.g. an agent-to-agent message: the line, and its body on tap
                    TextView d = Ui.text(this, detail, 13, Ui.G900);
                    d.setVisibility(expanded.contains(seq) ? View.VISIBLE : View.GONE);
                    d.setOnLongClickListener(v -> { Ui.copy(this, detail); return true; });
                    wrap.addView(d, Ui.margins(Ui.fill(), 0, 4, 0, 0));
                    t.setText(t.getText() + "  ›");
                    wrap.setOnClickListener(v -> {
                        boolean open = !expanded.remove(seq);
                        if (open) expanded.add(seq);
                        d.setVisibility(open ? View.VISIBLE : View.GONE);
                    });
                }
                break;
            }
            default:
                wrap.setVisibility(View.GONE); // a kind this version doesn't know
        }
        return wrap;
    }

    interface Body { View make(); }

    /** A one-line row (icon, name, summary) that expands to body on tap, like the desktop. */
    private void fold(LinearLayout wrap, int seq, String glyph, String name, String summary, int tint, Body body) {
        LinearLayout head = Ui.row(this);
        head.setPadding(Ui.dp(8), Ui.dp(6), Ui.dp(8), Ui.dp(6));
        head.setBackground(Ui.press(0, Ui.G300, 6));
        head.addView(Ui.icon(this, glyph, 14, tint));
        TextView n = Ui.bold(this, name, 13, Ui.G900);
        n.setSingleLine(true);
        head.addView(n, Ui.margins(Ui.wrap(), 8, 0, 0, 0));
        TextView s = Ui.subtitle(Ui.text(this, summary, 13, Ui.G700));
        head.addView(s, Ui.margins(Ui.weight(), 8, 0, 4, 0));
        TextView chev = Ui.icon(this, expanded.contains(seq) ? Ui.I_DOWN : Ui.I_RIGHT, 14, Ui.G600);
        head.addView(chev);
        wrap.addView(head, Ui.fill());
        final View[] open = {null};
        Runnable show = () -> {
            open[0] = body.make();
            wrap.addView(open[0], Ui.margins(Ui.fill(), 8, 6, 0, 0));
        };
        if (expanded.contains(seq)) show.run();
        head.setOnClickListener(v -> {
            if (expanded.remove(seq)) {
                if (open[0] != null) wrap.removeView(open[0]);
                chev.setText(Ui.I_RIGHT);
            } else {
                expanded.add(seq);
                show.run();
                chev.setText(Ui.I_DOWN);
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
        // The hub forks only at the last reply of a finished turn: the item right before its
        // "result" notice.
        JSONObject next = items.get(it.optInt("seq") + 1);
        if (canFork && next != null && "notice".equals(next.optString("kind")) && "result".equals(next.optString("icon")))
            opts.add("Fork from here");
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
        sendBtn.setAlpha(0.4f);
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
                sendBtn.setAlpha(1f);
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
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        attach.result(req, res, data);
    }
}
