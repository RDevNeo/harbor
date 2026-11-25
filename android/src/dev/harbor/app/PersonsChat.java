package dev.harbor.app;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.text.Editable;
import android.text.InputType;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.TextUtils;
import android.text.TextWatcher;
import android.text.style.ForegroundColorSpan;
import android.text.style.RelativeSizeSpan;
import android.text.util.Linkify;
import android.view.Gravity;
import android.view.View;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** A person's conversation, full screen (Person Hub's Chat on the phone): a header with back,
 *  their avatar, name and status and the details button; the messages with day separators, their
 *  bubbles on the left and mine on the right, reply quotes, pictures inline, voice and files as
 *  rows, email subjects, WhatsApp's ticks, "(edited)", the "N unread" line; the Person AI's notes
 *  and answers between them by time; "typing…"; and the composer. Long-press a message to Reply.
 *  Older messages load at the top. Opening it marks it read; typing tells them (every 8 s). */
final class PersonsChat {
    private static final long GROUP_MS = 7 * 60_000;

    final PersonsState p;
    final Activity a;
    final String pid, section;
    final LinearLayout view;
    private String account; // picked from `accounts`, else the chat's default

    private final FrameLayout headBox;
    private final ScrollView sv;
    private final LinearLayout content;
    private final TextView typingLine;
    private final LinearLayout box;
    private final TextView toLine, blocked;
    private final LinearLayout replyBox;
    private final TextView replyText;
    private final EditText subject, edit;
    private final HorizontalScrollView draftsScroll;
    private final LinearLayout drafts;

    private JSONObject data;
    private final List<JSONObject> msgs = new ArrayList<>();
    private JSONArray ai = new JSONArray();
    private boolean more, loading, loadingOlder, first = true, closed, toAi, toBottom;
    private String loadError;
    private String rowSig = "";
    private JSONObject replyTo;
    /** Pictures about to go: {name, type, data (base64)}, with their thumbnails. */
    private final List<JSONObject> files = new ArrayList<>();
    private final List<Bitmap> thumbs = new ArrayList<>();
    /** Sent from here, not in the chat yet: {text, files, error?}. */
    private final List<JSONObject> pending = new ArrayList<>();
    private long lastTyping;
    private long aiUntil, aiAsked;
    private String aiSig = "";

    PersonsChat(PersonsState p, String pid, String section) {
        this.p = p;
        this.pid = pid;
        this.section = section;
        a = p.a;
        view = Ui.col(a);
        view.setBackgroundColor(Ui.BG);
        view.setClickable(true);

        headBox = new FrameLayout(a);
        view.addView(headBox, Ui.fill());
        View line = new View(a);
        line.setBackgroundColor(Ui.LINE);
        view.addView(line, new LinearLayout.LayoutParams(-1, Ui.dp(1)));

        sv = new ScrollView(a);
        sv.setFillViewport(true);
        content = Ui.col(a);
        content.setPadding(0, Ui.dp(8), 0, Ui.dp(8));
        sv.addView(content, new FrameLayout.LayoutParams(-1, -2));
        sv.setOnScrollChangeListener((v, x, y, ox, oy) -> {
            if (y < Ui.dp(120) && y < oy && more && !loadingOlder && !msgs.isEmpty()) loadOlder();
        });
        view.addView(sv, new LinearLayout.LayoutParams(-1, 0, 1));

        typingLine = Ui.text(a, "", 13, Ui.G700);
        typingLine.setPadding(Ui.dp(20), Ui.dp(2), Ui.dp(20), Ui.dp(2));
        typingLine.setVisibility(View.GONE);
        view.addView(typingLine, Ui.fill());

        // The composer: who it goes to, the reply and the subject, the pictures, then + / text / send.
        box = Ui.col(a);
        box.setBackground(Ui.round(Ui.CARD, Ui.LINE, 24));
        box.setPadding(Ui.dp(6), Ui.dp(4), Ui.dp(6), Ui.dp(6));
        toLine = Ui.subtitle(Ui.text(a, "", 12, Ui.G700));
        toLine.setPadding(Ui.dp(10), Ui.dp(4), Ui.dp(10), Ui.dp(2));
        box.addView(toLine, Ui.fill());
        replyBox = Ui.row(a);
        replyBox.setPadding(Ui.dp(10), Ui.dp(4), Ui.dp(2), Ui.dp(4));
        replyBox.setBackground(Ui.round(Ui.G100, 0, 12));
        replyText = Ui.subtitle(Ui.text(a, "", 13, Ui.G700));
        replyBox.addView(replyText, Ui.weight());
        TextView noReply = Ui.icon(a, Ui.I_X, 16, Ui.G700);
        noReply.setBackground(Ui.press(0, 0, 14));
        noReply.setOnClickListener(v -> { replyTo = null; composer(); });
        noReply.setContentDescription("Cancel reply");
        replyBox.addView(noReply, new LinearLayout.LayoutParams(Ui.dp(28), Ui.dp(28)));
        box.addView(replyBox, Ui.margins(Ui.fill(), 4, 2, 4, 4));
        subject = Ui.input(a, "Subject (first email)", false);
        subject.setBackground(Ui.round(Ui.BG, Ui.LINE, 12));
        subject.setTextSize(15);
        subject.setPadding(Ui.dp(12), Ui.dp(8), Ui.dp(12), Ui.dp(8));
        box.addView(subject, Ui.margins(Ui.fill(), 4, 2, 4, 4));
        draftsScroll = new HorizontalScrollView(a);
        draftsScroll.setHorizontalScrollBarEnabled(false);
        drafts = Ui.row(a);
        draftsScroll.addView(drafts);
        box.addView(draftsScroll, Ui.margins(Ui.fill(), 4, 2, 4, 4));
        blocked = Ui.text(a, "", 13, Ui.G700);
        blocked.setPadding(Ui.dp(10), Ui.dp(6), Ui.dp(10), Ui.dp(6));
        box.addView(blocked, Ui.fill());
        LinearLayout row = Ui.row(a);
        row.setGravity(Gravity.BOTTOM);
        FrameLayout plus = Ui.roundButton(a, Ui.I_PLUS, Ui.G100, Ui.FG, 40, v -> plusMenu());
        plus.setContentDescription("More: attach a photo, ask the AI");
        row.addView(plus);
        edit = new EditText(a);
        edit.setBackground(null);
        edit.setTextColor(Ui.FG);
        edit.setHintTextColor(Ui.G600);
        edit.setTypeface(Ui.sans);
        edit.setTextSize(16);
        edit.setMaxLines(6);
        edit.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        edit.setPadding(Ui.dp(10), Ui.dp(8), Ui.dp(10), Ui.dp(8));
        edit.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int st, int c, int af) { }
            @Override public void onTextChanged(CharSequence s, int st, int b, int c) { }
            @Override public void afterTextChanged(Editable s) { if (s.toString().trim().length() > 0) typing(); }
        });
        row.addView(edit, Ui.weight());
        FrameLayout send = Ui.roundButton(a, Ui.I_UP, Ui.INK, Ui.ON_INK, 40, v -> send());
        send.setContentDescription("Send");
        row.addView(send);
        box.addView(row, Ui.fill());
        view.addView(box, Ui.margins(Ui.fill(), 10, 4, 10, 10));

        JSONObject q = p.person(pid);
        if (q != null) rowSig = sig(q);
        header();
        render();
        composer();
        load(false);
    }

    // ---- data ----

    private String base() {
        return "/v1/persons/chat/" + PersonsUi.enc(pid);
    }

    private String query() {
        return "?section=" + PersonsUi.enc(section) + (account != null ? "&account=" + PersonsUi.enc(account) : "");
    }

    /** The account the chat goes through now (the picked one, else the chat's own). */
    private String acctId() {
        if (account != null) return account;
        JSONObject ac = PersonsUi.obj(data, "account");
        return ac == null ? null : PersonsUi.s(ac, "id");
    }

    private String kind() {
        JSONObject ac = PersonsUi.obj(data, "account");
        return ac == null ? "" : PersonsUi.s(ac, "kind");
    }

    private String name() {
        JSONObject q = PersonsUi.obj(data, "person");
        String n = PersonsUi.s(q, "name");
        if (n.isEmpty()) n = PersonsUi.s(p.person(pid), "name");
        return n.isEmpty() ? "them" : n;
    }

    void load(boolean ignoredOlder) {
        if (loading || p.hub == null) return;
        loading = true;
        String path = base() + query();
        Ui.pool.execute(() -> {
            JSONObject r = null;
            String err = null;
            try { r = p.hub.get(path); } catch (Exception e) { err = Hub.why(e); }
            JSONObject fr = r;
            String fe = err;
            Ui.main.post(() -> {
                loading = false;
                if (closed || a.isDestroyed()) return;
                if (fr == null) {
                    if (first || data == null) { loadError = fe; render(); }
                    return;
                }
                loadError = null;
                loaded(fr);
            });
        });
    }

    private void loaded(JSONObject r) {
        boolean wasFirst = first;
        data = r;
        ai = PersonsUi.arr(r, "ai");
        List<JSONObject> page = PersonsHome.objs(PersonsUi.arr(r, "messages"));
        if (wasFirst) more = r.optBoolean("more");
        // Keep the older pages loaded before; the newest page replaces what it covers.
        long from = page.isEmpty() ? Long.MAX_VALUE : at(page.get(0));
        Map<String, JSONObject> byId = new LinkedHashMap<>();
        for (JSONObject m : msgs) if (at(m) < from) byId.put(PersonsUi.s(m, "id"), m);
        for (JSONObject m : page) byId.put(PersonsUi.s(m, "id"), m);
        msgs.clear();
        msgs.addAll(byId.values());
        sortMsgs();
        header();
        render();
        composer();
        first = false;
        JSONObject q = p.person(pid);
        if (wasFirst || PersonsUi.info(q, section).optInt("unread") > 0 || !PersonsUi.s(r, "unreadFrom").isEmpty()) markRead();
    }

    private void loadOlder() {
        if (loadingOlder || msgs.isEmpty() || p.hub == null) return;
        loadingOlder = true;
        render();
        String path = base() + query() + "&before=" + PersonsUi.enc(PersonsUi.s(msgs.get(0), "id"));
        Ui.pool.execute(() -> {
            JSONObject r = null;
            String err = null;
            try { r = p.hub.get(path); } catch (Exception e) { err = Hub.why(e); }
            JSONObject fr = r;
            String fe = err;
            Ui.main.post(() -> {
                loadingOlder = false;
                if (closed || a.isDestroyed()) return;
                if (fr == null) { Ui.toast(a, fe); render(); return; }
                more = fr.optBoolean("more");
                Map<String, JSONObject> byId = new LinkedHashMap<>();
                for (JSONObject m : PersonsHome.objs(PersonsUi.arr(fr, "messages"))) byId.put(PersonsUi.s(m, "id"), m);
                for (JSONObject m : msgs) byId.put(PersonsUi.s(m, "id"), m);
                msgs.clear();
                msgs.addAll(byId.values());
                sortMsgs();
                render();
            });
        });
    }

    private void sortMsgs() {
        Collections.sort(msgs, (x, y) -> Long.compare(at(x), at(y)));
    }

    private static long at(JSONObject m) { return PersonsUi.ms(PersonsUi.s(m, "at")); }

    private void markRead() {
        if (p.hub == null || !view.isShown()) return;
        JSONObject b = PersonsUi.put(new JSONObject(), "section", section);
        String ac = acctId();
        if (ac != null && !ac.isEmpty()) PersonsUi.put(b, "account", ac);
        String path = base() + "/read";
        Ui.pool.execute(() -> { try { p.hub.call("POST", path, b); } catch (Exception ignored) { } });
    }

    /** What of the person's row a change shows in: their rows, name and picture. */
    private static String sig(JSONObject q) {
        JSONObject rows = PersonsUi.obj(q, "rows");
        return (rows == null ? "" : rows.toString()) + "|" + PersonsUi.s(q, "name") + "|" + PersonsUi.s(q, "avatar");
    }

    /** A new state: reload when this person's row changed; close when they're gone. */
    void stateChanged() {
        JSONObject q = p.person(pid);
        if (q == null) {
            if (p.st != null && data != null) { Ui.toast(a, "They're no longer in Persons."); p.gone(); }
            return;
        }
        String s = sig(q);
        if (s.equals(rowSig)) return;
        rowSig = s;
        load(false);
    }

    void close() {
        closed = true;
        typingOff();
    }

    // ---- header ----

    private void header() {
        headBox.removeAllViews();
        LinearLayout r = Ui.row(a);
        r.setPadding(Ui.dp(4), Ui.dp(6), Ui.dp(6), Ui.dp(6));
        r.setMinimumHeight(Ui.dp(60));
        TextView back = Ui.iconButton(a, Ui.I_LEFT, Ui.FG, v -> p.back());
        back.setContentDescription("Back");
        r.addView(back);
        JSONObject st = p.person(pid);
        JSONObject cp = PersonsUi.obj(data, "person");
        String presence = PersonsUi.s(cp, "presence");
        if (presence.isEmpty()) presence = PersonsUi.s(PersonsUi.info(st, section), "presence");
        String av = PersonsUi.s(cp, "avatar");
        if (av.isEmpty()) av = PersonsUi.s(st, "avatar");
        r.addView(PersonsUi.avatar(a, p.hub, av, PersonsUi.s(st, "initials"), PersonsUi.color(PersonsUi.s(st, "color"), Ui.G500), 40, presence),
                Ui.margins(new LinearLayout.LayoutParams(Ui.dp(40), Ui.dp(40)), 2, 0, 10, 0));
        LinearLayout t = Ui.col(a);
        t.addView(Ui.subtitle(Ui.bold(a, name(), 16, Ui.FG)));
        String typing = PersonsUi.s(data, "typing");
        if (typing.isEmpty()) typing = PersonsUi.s(PersonsUi.info(st, section), "typing");
        JSONObject status = PersonsUi.obj(cp, "status");
        if (status == null) status = PersonsUi.obj(PersonsUi.info(st, section), "status");
        JSONObject ac = PersonsUi.obj(data, "account");
        TextView line;
        if (!typing.isEmpty()) line = Ui.text(a, "recording".equals(typing) ? "recording audio…" : "typing…", 13, PersonsUi.tone("green"));
        else if (status != null && !PersonsUi.s(status, "text").isEmpty()) line = Ui.text(a, PersonsUi.s(status, "text"), 13, PersonsUi.tone(PersonsUi.s(status, "tone")));
        else line = Ui.text(a, ac == null ? "" : PersonsUi.s(ac, "label"), 13, Ui.G700);
        if (line.getText().length() > 0) t.addView(Ui.subtitle(line));
        r.addView(t, Ui.weight());
        JSONArray accounts = PersonsUi.arr(data, "accounts");
        if (accounts.length() > 1 && ac != null) {
            LinearLayout sw = Ui.row(a);
            sw.setPadding(Ui.dp(8), Ui.dp(6), Ui.dp(8), Ui.dp(6));
            sw.setBackground(Ui.press(Ui.CARD, Ui.LINE, 16));
            sw.addView(PersonsUi.channel(a, PersonsUi.s(ac, "kind"), 16), new LinearLayout.LayoutParams(Ui.dp(16), Ui.dp(16)));
            sw.addView(Ui.icon(a, Ui.I_DOWN, 13, Ui.G700), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(14), Ui.dp(14)), 3, 0, 0, 0));
            sw.setContentDescription("Switch channel: " + PersonsUi.s(ac, "label"));
            sw.setOnClickListener(v -> switchAccount(accounts));
            r.addView(sw, Ui.margins(Ui.wrap(), 4, 0, 2, 0));
        }
        TextView details = Ui.iconButton(a, Ui.I_PANEL_RIGHT, Ui.FG, v -> p.openPanel(pid, section));
        details.setContentDescription("Details");
        r.addView(details);
        headBox.addView(r, new FrameLayout.LayoutParams(-1, -2));

        if (!typing.isEmpty()) {
            typingLine.setText(name() + " is " + ("recording".equals(typing) ? "recording audio…" : "typing…"));
            typingLine.setTextColor(Ui.BLUE);
            typingLine.setVisibility(View.VISIBLE);
        } else typingLine.setVisibility(View.GONE);
    }

    private void switchAccount(JSONArray accounts) {
        String[] labels = new String[accounts.length()];
        for (int i = 0; i < labels.length; i++) {
            JSONObject o = accounts.optJSONObject(i);
            labels[i] = o == null ? "" : PersonsUi.kindLabel(PersonsUi.s(o, "kind")) + " · " + PersonsUi.s(o, "label");
        }
        Ui.dialog(a).setTitle("Talk to them on").setItems(labels, (d, w) -> {
            JSONObject o = accounts.optJSONObject(w);
            if (o == null) return;
            typingOff();
            account = PersonsUi.s(o, "id");
            msgs.clear();
            replyTo = null;
            first = true;
            render();
            load(false);
        }).show();
    }

    // ---- the conversation ----

    private int maxW() { return (int) (a.getResources().getDisplayMetrics().widthPixels * 0.78f); }

    private void render() {
        boolean atBottom = first || toBottom || content.getHeight() == 0 || sv.getScrollY() + sv.getHeight() >= content.getHeight() - Ui.dp(80);
        int fromBottom = content.getHeight() - sv.getScrollY();
        toBottom = false;
        content.removeAllViews();
        if (more && !msgs.isEmpty()) {
            TextView older = Ui.rowButton(a, loadingOlder ? "Loading…" : "Load older", false, v -> loadOlder());
            LinearLayout.LayoutParams lp = Ui.wrap();
            lp.gravity = Gravity.CENTER_HORIZONTAL;
            content.addView(older, Ui.margins(lp, 0, 4, 0, 4));
        }
        if (msgs.isEmpty() && ai.length() == 0 && pending.isEmpty()) {
            String s = loadError != null ? loadError : data == null ? "" : acctId() == null
                    ? "No channel to talk to them here: connect Discord, Gmail or WhatsApp in the section's + menu on the PC, and give them that identifier."
                    : "No messages yet.";
            TextView t = Ui.text(a, s, 14, loadError != null ? Ui.RED : Ui.G700);
            t.setGravity(Gravity.CENTER);
            t.setPadding(Ui.dp(28), Ui.dp(40), Ui.dp(28), Ui.dp(40));
            if (loadError != null) {
                t.setText(loadError + "\nTap to try again.");
                t.setOnClickListener(v -> { loadError = null; render(); load(false); });
            }
            content.addView(t, Ui.fill());
        }
        // The conversation and the AI's thread, by time.
        List<Object[]> line = new ArrayList<>();
        for (JSONObject m : msgs) line.add(new Object[]{at(m), m, false});
        for (JSONObject e : PersonsHome.objs(ai)) line.add(new Object[]{PersonsUi.ms(PersonsUi.s(e, "at")), e, true});
        Collections.sort(line, (x, y) -> Long.compare((Long) x[0], (Long) y[0]));
        String unreadFrom = PersonsUi.s(data, "unreadFrom");
        List<String[]> gallery = new ArrayList<>();
        for (JSONObject m : msgs) for (JSONObject f : PersonsHome.objs(PersonsUi.arr(m, "files")))
            if (f.optBoolean("image")) gallery.add(new String[]{PersonsUi.s(f, "url"), PersonsUi.s(f, "name")});
        long prevDay = -1, prevAt = 0;
        JSONObject prev = null;
        String prevSubject = "";
        for (Object[] e : line) {
            long t = (Long) e[0];
            JSONObject o = (JSONObject) e[1];
            boolean broke = false;
            if (t > 0 && PersonsUi.dayOf(t) != prevDay) {
                prevDay = PersonsUi.dayOf(t);
                content.addView(divider(PersonsUi.day(t), Ui.G700, false));
                broke = true;
            }
            if ((Boolean) e[2]) {
                content.addView(aiView(o));
                prev = null;
                continue;
            }
            String id = PersonsUi.s(o, "id");
            if (!unreadFrom.isEmpty() && unreadFrom.equals(id)) {
                int n = 0;
                boolean on = false;
                for (JSONObject m : msgs) {
                    if (PersonsUi.s(m, "id").equals(unreadFrom)) on = true;
                    if (on && !m.optBoolean("fromMe")) n++;
                }
                content.addView(divider(n + " unread", Ui.BLUE, true));
                broke = true;
            }
            String subj = PersonsUi.s(o, "subject").replaceAll("(?i)^((re|fwd?|enc|res):\\s*)+", "").trim();
            if (!PersonsUi.s(o, "subject").isEmpty() && !subj.equals(prevSubject)) {
                content.addView(divider(subj.isEmpty() ? "(no subject)" : subj, Ui.G700, true));
                prevSubject = subj;
                broke = true;
            }
            boolean joined = !broke && prev != null && prev.optBoolean("fromMe") == o.optBoolean("fromMe") && t - prevAt < GROUP_MS;
            content.addView(bubble(o, joined, gallery));
            prev = o;
            prevAt = t;
        }
        for (JSONObject o : pending) content.addView(pendingView(o));
        afterLayout(() -> {
            if (atBottom) sv.scrollTo(0, content.getHeight());
            else sv.scrollTo(0, Math.max(0, content.getHeight() - fromBottom));
        });
    }

    /** Runs once the content has been laid out again (its new height known). */
    private void afterLayout(Runnable r) {
        android.view.ViewTreeObserver vto = content.getViewTreeObserver();
        vto.addOnGlobalLayoutListener(new android.view.ViewTreeObserver.OnGlobalLayoutListener() {
            @Override public void onGlobalLayout() {
                content.getViewTreeObserver().removeOnGlobalLayoutListener(this);
                r.run();
            }
        });
        content.requestLayout();
    }

    /** A centred line: a day, "N unread", an email's subject. */
    private View divider(String text, int color, boolean rule) {
        LinearLayout r = Ui.row(a);
        r.setPadding(Ui.dp(16), Ui.dp(10), Ui.dp(16), Ui.dp(4));
        if (rule) r.addView(ruleView(color), new LinearLayout.LayoutParams(0, Ui.dp(1), 1));
        TextView t = Ui.subtitle(Ui.bold(a, text, 12, color));
        t.setPadding(Ui.dp(10), Ui.dp(3), Ui.dp(10), Ui.dp(3));
        if (!rule) t.setBackground(Ui.round(Ui.G100, 0, 10));
        r.addView(t, new LinearLayout.LayoutParams(-2, -2, 0));
        if (rule) r.addView(ruleView(color), new LinearLayout.LayoutParams(0, Ui.dp(1), 1));
        r.setGravity(Gravity.CENTER);
        return r;
    }

    private View ruleView(int color) {
        View v = new View(a);
        v.setBackgroundColor(color == Ui.BLUE ? Ui.BLUE : Ui.LINE);
        return v;
    }

    private View bubble(JSONObject m, boolean joined, List<String[]> gallery) {
        boolean me = m.optBoolean("fromMe");
        long t = at(m);
        LinearLayout wrap = Ui.col(a);
        wrap.setGravity(me ? Gravity.END : Gravity.START);
        wrap.setPadding(Ui.dp(me ? 48 : 12), Ui.dp(joined ? 2 : 8), Ui.dp(me ? 12 : 48), 0);
        if (!joined) {
            String meta = (me ? "" : name() + " · ") + (t > 0 ? PersonsUi.clock(t) : "");
            TextView mt = Ui.subtitle(Ui.text(a, meta, 12, Ui.G600));
            wrap.addView(mt, Ui.margins(Ui.wrap(), 6, 0, 6, 2));
        }
        LinearLayout b = Ui.col(a);
        b.setBackground(me ? Ui.round(Ui.G100, 0, 18) : Ui.round(Ui.CARD, Ui.LINE, 18));
        b.setPadding(Ui.dp(12), Ui.dp(8), Ui.dp(12), Ui.dp(8));
        int inner = maxW() - Ui.dp(24);
        JSONObject reply = PersonsUi.obj(m, "reply");
        if (reply != null) {
            LinearLayout q = Ui.row(a);
            View bar = new View(a);
            bar.setBackgroundColor(Ui.G500);
            q.addView(bar, new LinearLayout.LayoutParams(Ui.dp(2), -1));
            SpannableStringBuilder sb = new SpannableStringBuilder();
            sb.append(reply.optBoolean("fromMe") ? "You" : name());
            sb.setSpan(new Ui.Font(Ui.semi, 0), 0, sb.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            String rt = PersonsUi.s(reply, "text");
            sb.append("  ").append(rt.isEmpty() ? "Attachment" : rt);
            TextView qt = Ui.text(a, sb, 13, Ui.G700);
            qt.setMaxLines(2);
            qt.setEllipsize(TextUtils.TruncateAt.END);
            qt.setMaxWidth(inner);
            q.addView(qt, Ui.margins(Ui.wrap(), 8, 0, 0, 0));
            b.addView(q, Ui.margins(Ui.wrap(), 0, 0, 0, 6));
        }
        String text = PersonsUi.s(m, "text");
        List<JSONObject> fs = PersonsHome.objs(PersonsUi.arr(m, "files"));
        if (!text.isEmpty() || m.optBoolean("edited") || fs.isEmpty()) {
            SpannableStringBuilder sb = new SpannableStringBuilder(text.isEmpty() && fs.isEmpty() ? "Empty message" : text);
            if (text.isEmpty() && fs.isEmpty()) sb.setSpan(new ForegroundColorSpan(Ui.G600), 0, sb.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            if (m.optBoolean("edited")) {
                int s = sb.length();
                sb.append(" (edited)");
                sb.setSpan(new ForegroundColorSpan(Ui.G600), s, sb.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                sb.setSpan(new RelativeSizeSpan(0.8f), s, sb.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            }
            TextView tv = Ui.text(a, sb, 15, Ui.FG);
            tv.setMaxWidth(inner);
            tv.setLinkTextColor(Ui.BLUE);
            Linkify.addLinks(tv, Linkify.WEB_URLS | Linkify.EMAIL_ADDRESSES);
            tv.setOnLongClickListener(v -> { menu(m); return true; });
            if (sb.length() > 0) b.addView(tv);
        }
        for (JSONObject f : fs) {
            View fv = f.optBoolean("image") ? imageView(f, inner, gallery) : fileRow(f, m.optBoolean("voice"), inner);
            b.addView(fv, Ui.margins(Ui.wrap(), 0, b.getChildCount() > 0 ? 6 : 0, 0, 0));
        }
        String status = PersonsUi.s(m, "status");
        if (me && !status.isEmpty()) b.addView(ticks(status), Ui.margins(endWrap(), 0, 2, 0, 0));
        b.setOnLongClickListener(v -> { menu(m); return true; });
        wrap.addView(b, Ui.wrap());
        return wrap;
    }

    private static LinearLayout.LayoutParams endWrap() {
        LinearLayout.LayoutParams lp = Ui.wrap();
        lp.gravity = Gravity.END;
        return lp;
    }

    /** WhatsApp's ticks on my message: ⏱ sending, ✓ sent, ✓✓ delivered, blue ✓✓ read, ! not sent. */
    private TextView ticks(String status) {
        String s;
        int c = Ui.G600;
        switch (status) {
            case "pending": s = "⏱"; break;
            case "sent": s = "✓"; break;
            case "delivered": s = "✓✓"; break;
            case "read": s = "✓✓"; c = 0xff53bdeb; break;
            case "error": s = "! Not sent"; c = Ui.RED; break;
            default: s = status;
        }
        TextView t = Ui.text(a, s, 11, c);
        t.setContentDescription(status);
        return t;
    }

    private View imageView(JSONObject f, int inner, List<String[]> gallery) {
        int w = Math.min(inner, Ui.dp(240));
        int fw = f.optInt("width"), fh = f.optInt("height");
        int h = fw > 0 && fh > 0 ? Math.max(Ui.dp(80), Math.min(Ui.dp(320), w * fh / fw)) : Ui.dp(180);
        ImageView iv = new ImageView(a);
        iv.setScaleType(ImageView.ScaleType.CENTER_CROP);
        iv.setBackground(Ui.round(Ui.G200, 0, 12));
        iv.setClipToOutline(true);
        String url = PersonsUi.s(f, "url"), name = PersonsUi.s(f, "name");
        iv.setContentDescription(name);
        iv.setLayoutParams(new LinearLayout.LayoutParams(w, h));
        PersonsUi.image(a, p.hub, url, iv, Math.max(w, h), () -> iv.setImageDrawable(null));
        iv.setOnClickListener(v -> {
            int at = 0;
            for (int i = 0; i < gallery.size(); i++) if (gallery.get(i)[0].equals(url)) at = i;
            if (gallery.isEmpty()) gallery.add(new String[]{url, name});
            PersonsUi.viewer(a, p.hub, gallery, at);
        });
        return iv;
    }

    /** A voice message or a file: its icon, name and size (or length); a tap downloads and opens it. */
    private View fileRow(JSONObject f, boolean voice, int inner) {
        String type = PersonsUi.s(f, "type"), name = PersonsUi.s(f, "name");
        boolean audio = voice || type.startsWith("audio/");
        LinearLayout r = Ui.row(a);
        r.setPadding(Ui.dp(10), Ui.dp(8), Ui.dp(12), Ui.dp(8));
        r.setBackground(Ui.press(Ui.BG, Ui.LINE, 12));
        View ic;
        if (audio) {
            ImageView iv = new ImageView(a);
            iv.setImageDrawable(new Ui.Draw(Ui.Draw.MIC, Ui.FG));
            ic = iv;
        } else ic = Ui.icon(a, Ui.I_FILE, 18, Ui.FG);
        r.addView(ic, Ui.margins(new LinearLayout.LayoutParams(Ui.dp(20), Ui.dp(20)), 0, 0, 10, 0));
        LinearLayout t = Ui.col(a);
        double dur = f.optDouble("duration", 0);
        String title = voice ? "Voice message" : name.isEmpty() ? "File" : name;
        TextView tt = Ui.subtitle(Ui.text(a, title, 14, audio ? Ui.FG : Ui.BLUE));
        tt.setMaxWidth(inner - Ui.dp(52));
        t.addView(tt);
        String meta = dur > 0 ? PersonsUi.duration(dur) : "";
        String size = PersonsUi.bytes(f.optLong("size"));
        if (!size.isEmpty()) meta = meta.isEmpty() ? size : meta + " · " + size;
        if (!meta.isEmpty()) t.addView(Ui.text(a, meta, 12, Ui.G600));
        r.addView(t, Ui.wrap());
        String url = PersonsUi.s(f, "url");
        r.setOnClickListener(v -> PersonsUi.openFile(a, p.hub, url, name.isEmpty() ? (voice ? "voice.ogg" : "file") : name, type));
        r.setContentDescription(title + (meta.isEmpty() ? "" : ", " + meta) + ": open");
        return r;
    }

    /** The Person AI's note (mine, right) or answer (left), apart from the conversation. */
    private View aiView(JSONObject e) {
        boolean mine = "user".equals(PersonsUi.s(e, "role"));
        LinearLayout wrap = Ui.col(a);
        wrap.setGravity(mine ? Gravity.END : Gravity.START);
        wrap.setPadding(Ui.dp(mine ? 48 : 12), Ui.dp(8), Ui.dp(mine ? 12 : 24), 0);
        LinearLayout b = Ui.col(a);
        GradientDrawable g = Ui.round(PersonsUi.aiFill(), 0, 18);
        g.setStroke(Ui.dp(1), PersonsUi.aiLine(), Ui.dp(4), Ui.dp(3));
        b.setBackground(g);
        b.setPadding(Ui.dp(12), Ui.dp(8), Ui.dp(12), Ui.dp(10));
        LinearLayout h = Ui.row(a);
        TextView mark = Ui.icon(a, Ui.I_SPARKLES, 11, Ui.ON_INK);
        mark.setBackground(Ui.round(Ui.INK, 0, 9));
        h.addView(mark, new LinearLayout.LayoutParams(Ui.dp(18), Ui.dp(18)));
        long t = PersonsUi.ms(PersonsUi.s(e, "at"));
        h.addView(Ui.subtitle(Ui.bold(a, mine ? "To the AI" : "AI", 13, Ui.FG)), Ui.margins(Ui.wrap(), 6, 0, 0, 0));
        h.addView(Ui.subtitle(Ui.text(a, " · Only you see this" + (t > 0 ? " · " + PersonsUi.clock(t) : ""), 12, Ui.G600)));
        b.addView(h, Ui.margins(Ui.wrap(), 0, 0, 0, 4));
        String text = PersonsUi.s(e, "text");
        TextView tv = Ui.text(a, text.isEmpty() ? "…" : text, 15, Ui.FG);
        tv.setMaxWidth(maxW());
        tv.setLinkTextColor(Ui.BLUE);
        Linkify.addLinks(tv, Linkify.WEB_URLS);
        b.addView(tv);
        View.OnLongClickListener lp = v -> { aiMenu(text, mine); return true; };
        b.setOnLongClickListener(lp);
        tv.setOnLongClickListener(lp);
        wrap.addView(b, Ui.wrap());
        return wrap;
    }

    private View pendingView(JSONObject o) {
        LinearLayout wrap = Ui.col(a);
        wrap.setGravity(Gravity.END);
        wrap.setPadding(Ui.dp(48), Ui.dp(8), Ui.dp(12), 0);
        LinearLayout b = Ui.col(a);
        b.setBackground(Ui.round(Ui.G100, 0, 18));
        b.setPadding(Ui.dp(12), Ui.dp(8), Ui.dp(12), Ui.dp(8));
        String text = PersonsUi.s(o, "text");
        int n = o.optInt("files");
        if (!text.isEmpty()) {
            TextView tv = Ui.text(a, text, 15, Ui.FG);
            tv.setMaxWidth(maxW() - Ui.dp(24));
            b.addView(tv);
        }
        if (n > 0) b.addView(Ui.text(a, n == 1 ? "1 photo" : n + " photos", 13, Ui.G700));
        String err = PersonsUi.s(o, "error");
        TextView st = Ui.text(a, err.isEmpty() ? "sending…" : "Not sent: " + err + " · tap to dismiss", 11, err.isEmpty() ? Ui.G600 : Ui.RED);
        b.addView(st, Ui.margins(endWrap(), 0, 2, 0, 0));
        if (!err.isEmpty()) b.setOnClickListener(v -> { pending.remove(o); render(); });
        else b.setAlpha(0.7f);
        wrap.addView(b, Ui.wrap());
        return wrap;
    }

    // ---- menus ----

    private void menu(JSONObject m) {
        String text = PersonsUi.s(m, "text");
        List<String> opts = new ArrayList<>();
        boolean canReply = acctId() != null;
        if (canReply) opts.add("Reply");
        if (!text.isEmpty()) opts.add("Copy text");
        if (opts.isEmpty()) return;
        Ui.dialog(a).setItems(opts.toArray(new String[0]), (d, w) -> {
            String o = opts.get(w);
            if (o.equals("Reply")) {
                replyTo = m;
                if (toAi) toAi = false;
                composer();
                edit.requestFocus();
                showKeyboard();
            } else Ui.copy(a, text);
        }).show();
    }

    private void aiMenu(String text, boolean mine) {
        List<String> opts = new ArrayList<>();
        if (!mine && acctId() != null) opts.add("Use as reply");
        if (!text.isEmpty()) opts.add("Copy text");
        if (opts.isEmpty()) return;
        Ui.dialog(a).setItems(opts.toArray(new String[0]), (d, w) -> {
            if (opts.get(w).equals("Use as reply")) {
                toAi = false;
                composer();
                edit.setText(text);
                edit.setSelection(edit.length());
                edit.requestFocus();
            } else Ui.copy(a, text);
        }).show();
    }

    private void plusMenu() {
        List<String> opts = new ArrayList<>();
        if (a instanceof Base && !toAi && acctId() != null) opts.add("Attach a photo");
        opts.add(toAi ? "Message " + name() : "Ask AI");
        Ui.dialog(a).setItems(opts.toArray(new String[0]), (d, w) -> {
            String o = opts.get(w);
            if (o.equals("Attach a photo")) ((Base) a).pickImage(this::addPhoto);
            else {
                toAi = !toAi;
                if (toAi) typingOff();
                composer();
                edit.requestFocus();
            }
        }).show();
    }

    private void showKeyboard() {
        android.view.inputmethod.InputMethodManager im = (android.view.inputmethod.InputMethodManager) a.getSystemService(Activity.INPUT_METHOD_SERVICE);
        if (im != null) im.showSoftInput(edit, 0);
    }

    // ---- the composer ----

    private boolean needSubject() { return "gmail".equals(kind()) && msgs.isEmpty() && data != null; }

    private void composer() {
        String n = name();
        boolean can = acctId() != null;
        if (toAi) {
            toLine.setText("✦ Note to the AI · never sent to " + n);
            edit.setHint("Tell the AI what to do about " + n);
            box.setBackground(dashed());
        } else {
            JSONObject ac = PersonsUi.obj(data, "account");
            toLine.setText("To " + n + (ac == null || PersonsUi.s(ac, "label").isEmpty() ? "" : " · " + PersonsUi.s(ac, "label")));
            String k = kind();
            edit.setHint("gmail".equals(k) ? "Email " + n + "…" : "Message " + n + (k.isEmpty() ? "" : " on " + PersonsUi.kindLabel(k)));
            box.setBackground(Ui.round(Ui.CARD, Ui.LINE, 24));
        }
        boolean blockedNow = !toAi && !can && data != null;
        blocked.setText(blockedNow ? "No channel to talk to " + n + " here: connect Discord, Gmail or WhatsApp on the PC, and give them that identifier. You can still Ask AI (+)." : "");
        blocked.setVisibility(blockedNow ? View.VISIBLE : View.GONE);
        edit.setEnabled(!blockedNow);
        if (!toAi && replyTo != null) {
            String rt = PersonsUi.s(replyTo, "text");
            replyText.setText("Replying to " + (replyTo.optBoolean("fromMe") ? "You" : n) + ": " + (rt.isEmpty() ? "attachment" : rt));
            replyBox.setVisibility(View.VISIBLE);
        } else replyBox.setVisibility(View.GONE);
        subject.setVisibility(!toAi && can && needSubject() ? View.VISIBLE : View.GONE);
        drafts.removeAllViews();
        for (int i = 0; i < files.size(); i++) drafts.addView(draftChip(i), Ui.margins(Ui.wrap(), 0, 0, 6, 0));
        draftsScroll.setVisibility(!toAi && !files.isEmpty() ? View.VISIBLE : View.GONE);
    }

    private GradientDrawable dashed() {
        GradientDrawable g = Ui.round(PersonsUi.aiFill(), 0, 24);
        g.setStroke(Ui.dp(1), PersonsUi.aiLine(), Ui.dp(5), Ui.dp(4));
        return g;
    }

    private View draftChip(int i) {
        JSONObject f = files.get(i);
        LinearLayout r = Ui.row(a);
        r.setPadding(Ui.dp(4), Ui.dp(4), Ui.dp(2), Ui.dp(4));
        r.setBackground(Ui.round(Ui.BG, Ui.LINE, 10));
        ImageView iv = new ImageView(a);
        iv.setScaleType(ImageView.ScaleType.CENTER_CROP);
        iv.setBackground(Ui.round(Ui.G100, 0, 6));
        iv.setClipToOutline(true);
        if (i < thumbs.size()) iv.setImageBitmap(thumbs.get(i));
        r.addView(iv, new LinearLayout.LayoutParams(Ui.dp(32), Ui.dp(32)));
        TextView n = Ui.subtitle(Ui.text(a, PersonsUi.s(f, "name"), 12, Ui.G900));
        n.setMaxWidth(Ui.dp(120));
        r.addView(n, Ui.margins(Ui.wrap(), 6, 0, 0, 0));
        TextView x = Ui.icon(a, Ui.I_X, 14, Ui.G700);
        x.setOnClickListener(v -> { files.remove(f); if (i < thumbs.size()) thumbs.remove(i); composer(); });
        x.setContentDescription("Remove " + PersonsUi.s(f, "name"));
        r.addView(x, new LinearLayout.LayoutParams(Ui.dp(26), Ui.dp(26)));
        return r;
    }

    /** A photo from the picker: scaled to 1600 px and sent as JPEG (bodies stay small). */
    private void addPhoto(Uri uri) {
        if (files.size() >= 6) { Ui.toast(a, "Up to 6 photos at once"); return; }
        Ui.bg(a, () -> {
            Bitmap b = Images.decode(a.getContentResolver(), uri, 1600);
            if (b == null) throw new java.io.IOException("Couldn't read that image");
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            b.compress(Bitmap.CompressFormat.JPEG, 85, out);
            String name = "photo.jpg";
            try (android.database.Cursor c = a.getContentResolver().query(uri, new String[]{android.provider.OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                if (c != null && c.moveToFirst() && c.getString(0) != null) name = c.getString(0).replaceAll("\\.[^.]*$", "") + ".jpg";
            } catch (RuntimeException ignored) { }
            JSONObject f = new JSONObject();
            PersonsUi.put(f, "name", name);
            PersonsUi.put(f, "type", "image/jpeg");
            PersonsUi.put(f, "data", android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP));
            Bitmap thumb = Bitmap.createScaledBitmap(b, Math.max(1, b.getWidth() * 96 / Math.max(b.getWidth(), b.getHeight())),
                    Math.max(1, b.getHeight() * 96 / Math.max(b.getWidth(), b.getHeight())), true);
            return new Object[]{f, thumb};
        }, r -> {
            if (closed) return;
            files.add((JSONObject) r[0]);
            thumbs.add((Bitmap) r[1]);
            composer();
        });
    }

    private void send() {
        String text = edit.getText().toString().trim();
        if (toAi) { askAi(text); return; }
        String ac = acctId();
        if (ac == null || data == null) return;
        if (text.isEmpty() && files.isEmpty()) return;
        boolean subj = needSubject();
        String su = subject.getText().toString().trim();
        if (subj && su.isEmpty()) { Ui.toast(a, "Add a subject for the first email"); return; }
        JSONObject b = PersonsUi.put(new JSONObject(), "section", section);
        PersonsUi.put(b, "account", ac);
        PersonsUi.put(b, "text", text);
        if (replyTo != null) PersonsUi.put(b, "replyTo", PersonsUi.s(replyTo, "id"));
        if (subj) PersonsUi.put(b, "subject", su);
        if (!files.isEmpty()) {
            JSONArray fa = new JSONArray();
            for (JSONObject f : files) fa.put(f);
            PersonsUi.put(b, "files", fa);
        }
        JSONObject pend = PersonsUi.put(new JSONObject(), "text", text);
        PersonsUi.put(pend, "files", files.size());
        pending.add(pend);
        typingOff();
        edit.setText("");
        replyTo = null;
        files.clear();
        thumbs.clear();
        composer();
        toBottom = true;
        render();
        String path = base() + "/send";
        Ui.pool.execute(() -> {
            String err = null;
            try {
                JSONObject r = p.hub.call("POST", path, b, 90_000);
                if (!r.optBoolean("ok", true)) err = r.optString("error", "not sent");
            } catch (Exception e) { err = Hub.why(e); }
            String fe = err;
            Ui.main.post(() -> {
                if (closed || a.isDestroyed()) {
                    if (fe != null) Ui.toast(a, "Not sent: " + fe);
                    return;
                }
                if (fe == null) {
                    pending.remove(pend);
                    if (subj) subject.setText("");
                    load(false);
                } else {
                    PersonsUi.put(pend, "error", fe);
                    render();
                    Ui.toast(a, "Not sent: " + fe);
                }
            });
        });
    }

    /** "Ask AI": the note goes to the Person AI of this person and section; its answer shows in
     *  `ai`, so the chat is asked again every 3 s for a while. */
    private void askAi(String text) {
        if (text.isEmpty()) return;
        JSONObject b = PersonsUi.put(new JSONObject(), "section", section);
        PersonsUi.put(b, "text", text);
        edit.setText("");
        String path = base() + "/ai";
        Ui.bg(a, () -> p.hub.call("POST", path, b, 60_000), r -> {
            if (!r.optBoolean("ok", true)) { Ui.toast(a, "AI: " + r.optString("error", "not sent")); edit.setText(text); return; }
            if (closed) return;
            aiAsked = System.currentTimeMillis();
            aiUntil = aiAsked + 180_000;
            aiSig = "";
            load(false);
            Ui.main.removeCallbacks(aiTick);
            Ui.main.postDelayed(aiTick, 3000);
        });
    }

    private final Runnable aiTick = new Runnable() {
        @Override public void run() {
            if (closed || a.isDestroyed() || System.currentTimeMillis() > aiUntil) return;
            // Done once the answer after the note stops changing.
            JSONObject last = ai.length() == 0 ? null : ai.optJSONObject(ai.length() - 1);
            String s = last == null ? "" : last.toString();
            if (last != null && "assistant".equals(PersonsUi.s(last, "role")) && PersonsUi.ms(PersonsUi.s(last, "at")) >= aiAsked - 60_000
                    && s.equals(aiSig)) return;
            aiSig = s;
            load(false);
            Ui.main.postDelayed(this, 3000);
        }
    };

    /** Typing on for them while I write, at most every 8 s. */
    private void typing() {
        if (toAi || closed || data == null || "gmail".equals(kind())) return;
        String ac = acctId();
        if (ac == null || System.currentTimeMillis() - lastTyping < 8000) return;
        lastTyping = System.currentTimeMillis();
        postTyping(ac, true);
    }

    private void typingOff() {
        if (lastTyping == 0) return;
        lastTyping = 0;
        String ac = acctId();
        if (ac != null) postTyping(ac, false);
    }

    private void postTyping(String ac, boolean on) {
        if (p.hub == null) return;
        JSONObject b = PersonsUi.put(new JSONObject(), "section", section);
        PersonsUi.put(b, "account", ac);
        PersonsUi.put(b, "on", on);
        String path = base() + "/typing";
        Ui.pool.execute(() -> { try { p.hub.call("POST", path, b); } catch (Exception ignored) { } });
    }
}
