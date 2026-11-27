package dev.harbor.app;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.text.Editable;
import android.text.InputType;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.TextUtils;
import android.text.TextWatcher;
import android.text.style.AbsoluteSizeSpan;
import android.text.style.DynamicDrawableSpan;
import android.text.style.ForegroundColorSpan;
import android.text.style.ImageSpan;
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
    private final ChatFlow.Jump jump;
    private final ChatFlow.DayPill dayPill;
    /** The first render with the chat's messages placed it (where it was left, its unread line, else its end). */
    private boolean positioned;
    /** Add friend tapped: the friend request is on its way. */
    private boolean friending;
    /** How many times placeFirst ran (a correction queued before it is let go). */
    private int placed;
    /** The chat is at its end and stays there while its content grows (pictures and AI notes lay out after the first
     *  placement; without this the newest messages ended up below the fold and that spot was kept as "scrolled up").
     *  Off once the finger scrolls it up; on again at the end. */
    private boolean stickEnd = true;
    /** The finger is on the transcript, or let go of it in the last moment (a fling). */
    private long touchedAt;
    private boolean touching;
    /** Placed at a remembered message (placeFirst): for a moment it stays `holdBelow` px above the transcript's bottom
     *  edge whatever lays out or resizes (pictures and AI notes above it, the keyboard and the composer coming back
     *  after a restore), until the finger moves the chat. */
    private View holdView;
    /** A restart left the chat at its very end: it comes back there (not at an unread line still marked). */
    private boolean liveEnd;
    private int holdBelow;
    private long holdStart, holdUntil;
    /** Their messages that came in while scrolled up, the first of them (the "↓" counts them and goes there). */
    private int unseen;
    private String firstUnseen = "";
    private final LinearLayout box, head, replyBox, fwdBox, seg, segAi, segPerson, sendPill;
    private final FrameLayout headMark, sendRound;
    private final View headLine;
    private final TextView headText, headNote, blocked, replyText, fwdText, toLabel, attach;
    private final EditText subject, edit;
    /** A message forwarded to the AI (Forward to AI): quoted in the AI composer, sent with the next note. */
    private JSONObject forwarded;
    private final HorizontalScrollView draftsScroll;
    private final LinearLayout drafts;

    private JSONObject data;
    private final List<JSONObject> msgs = new ArrayList<>();
    private JSONArray ai = new JSONArray();
    /** The AI answers the user folded (true) or opened (false) by tapping their header, by id: kept for the session
     *  (the app's process). Otherwise the newest answer is open and older ones fold (the PC's view.ts aiFolds). */
    /** The newest answer's id in this chat: it starts open. */
    private String newestAi = "";
    private boolean more, loading, loadingOlder, first = true, closed, toAi, toBottom;
    /** Marked unread here: not marked read again while this chat stays open (its reload follows the row going unread). */
    private boolean holdUnread;
    /** The unread line this chat opened with: it stays while the chat is open (as WhatsApp's), not dropped by the
     *  reload that marking it read brings (that moved everything under it up by its height), and none comes up while
     *  it's open (the "↓" counts those); a message sent ends it. */
    private String keptUnread = "";
    private String loadError;
    private String rowSig = "";
    private JSONObject replyTo;
    private final Runnable keepDraft = this::keepDraft;
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
        sv.setOnTouchListener((v, e) -> {
            int act = e.getActionMasked();
            if (act == android.view.MotionEvent.ACTION_DOWN || act == android.view.MotionEvent.ACTION_MOVE) { touching = true; holdView = null; }
            else if (act == android.view.MotionEvent.ACTION_UP || act == android.view.MotionEvent.ACTION_CANCEL) touching = false;
            touchedAt = android.os.SystemClock.uptimeMillis();
            return false;
        });
        sv.setOnScrollChangeListener((v, x, y, ox, oy) -> {
            if (y < Ui.dp(120) && y < oy && more && !loadingOlder && !msgs.isEmpty()) loadOlder();
            // Only the user's own scroll leaves the end (a finger, or its fling); reaching the end sticks again.
            boolean byUser = touching || android.os.SystemClock.uptimeMillis() - touchedAt < 2_000;
            if (byUser && positioned) stickEnd = ChatFlow.atEnd(sv, content, Ui.dp(80));
            scrolled(y != oy);
        });
        // The content grew or shrank (a picture or an AI note laid out, a message in): at the end it stays there.
        content.addOnLayoutChangeListener((v, l, top, r, bottom, ol, oldTop, or, oldBottom) -> {
            if (holding()) { if (bottom - top != oldBottom - oldTop) hold(); return; }
            if (!positioned || !stickEnd || bottom - top == oldBottom - oldTop) return;
            ChatFlow.beforeDraw(sv, () -> { if (stickEnd) sv.scrollTo(0, Math.max(0, content.getHeight() - sv.getHeight())); });
        });
        // The keyboard (or the composer growing) shrinks the transcript: what was at its bottom stays there.
        sv.addOnLayoutChangeListener((v, l, top, r, bottom, ol, oldTop, or, oldBottom) -> {
            int was = oldBottom - oldTop, now = bottom - top;
            if (holding()) { if (now != was) hold(); return; }
            if (was > 0 && now != was && positioned) {
                // (not when the chat was placed meanwhile, in this same layout: that place is already exact)
                int g = placed;
                ChatFlow.beforeDraw(sv, () -> { if (g == placed) sv.scrollBy(0, was - now); });
            }
        });
        // The transcript, the day pill floating on its top and the "↓" over its lower right corner (ChatFlow).
        FrameLayout stage = new FrameLayout(a);
        stage.addView(sv, new FrameLayout.LayoutParams(-1, -1));
        dayPill = new ChatFlow.DayPill(a);
        stage.addView(dayPill.view, dayPill.params());
        jump = new ChatFlow.Jump(a, v -> jumpDown());
        stage.addView(jump.view, jump.params());
        view.addView(stage, new LinearLayout.LayoutParams(-1, 0, 1));

        typingLine = Ui.text(a, "", 13, Ui.G700);
        typingLine.setPadding(Ui.dp(20), Ui.dp(2), Ui.dp(20), Ui.dp(2));
        typingLine.setVisibility(View.GONE);
        view.addView(typingLine, Ui.fill());

        // The composer (Person Hub's): who it goes to on top ("To <person>", or "Note to the AI · never sent to them"
        // in the AI's tint), then the first email's subject, the reply or the forwarded message, the photos, the
        // field (or why it can't write to them), and attach / "To: AI | <person>" / Send.
        box = Ui.col(a);
        head = Ui.row(a);
        head.setGravity(Gravity.CENTER_VERTICAL);
        head.setMinimumHeight(Ui.dp(40));
        head.setPadding(Ui.dp(14), 0, Ui.dp(14), 0);
        headMark = new FrameLayout(a);
        head.addView(headMark, new LinearLayout.LayoutParams(Ui.dp(20), Ui.dp(20)));
        headText = Ui.subtitle(Ui.text(a, "", 13, Ui.G700));
        head.addView(headText, Ui.margins(Ui.weight(), 8, 0, 0, 0));
        headNote = Ui.subtitle(Ui.text(a, "", 11.5f, Ui.G600));
        head.addView(headNote, Ui.margins(Ui.wrap(), 8, 0, 0, 0));
        box.addView(head, Ui.fill());
        headLine = new View(a);
        box.addView(headLine, new LinearLayout.LayoutParams(-1, Ui.dp(1)));
        LinearLayout body = Ui.col(a);
        body.setPadding(Ui.dp(8), Ui.dp(8), Ui.dp(8), Ui.dp(6));
        box.addView(body, Ui.fill());
        subject = Ui.input(a, "Subject (first email)", false);
        subject.setBackground(Ui.round(Ui.BG, Ui.LINE, 10));
        subject.setTextSize(15);
        subject.setPadding(Ui.dp(12), Ui.dp(8), Ui.dp(12), Ui.dp(8));
        body.addView(subject, Ui.margins(Ui.fill(), 0, 0, 0, 8));
        replyText = Ui.subtitle(Ui.text(a, "", 13, Ui.G700));
        replyBox = quoteRow(Ui.I_REPLY, replyText, "Cancel reply", () -> { replyTo = null; composer(); }, false);
        body.addView(replyBox, Ui.margins(Ui.fill(), 0, 0, 0, 8));
        fwdText = Ui.subtitle(Ui.text(a, "", 13, Ui.G700));
        fwdBox = quoteRow(Ui.I_FORWARD, fwdText, "Cancel forward", () -> { forwarded = null; composer(); }, true);
        body.addView(fwdBox, Ui.margins(Ui.fill(), 0, 0, 0, 8));
        draftsScroll = new HorizontalScrollView(a);
        draftsScroll.setHorizontalScrollBarEnabled(false);
        drafts = Ui.row(a);
        draftsScroll.addView(drafts);
        body.addView(draftsScroll, Ui.margins(Ui.fill(), 0, 0, 0, 8));
        blocked = Ui.text(a, "", 13, Ui.G700);
        blocked.setPadding(Ui.dp(4), Ui.dp(4), Ui.dp(4), Ui.dp(8));
        body.addView(blocked, Ui.fill());
        edit = new EditText(a);
        edit.setBackground(null);
        edit.setTextColor(Ui.FG);
        edit.setHintTextColor(Ui.G600);
        edit.setTypeface(Ui.sans);
        edit.setTextSize(16);
        edit.setMaxLines(6);
        edit.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        edit.setPadding(Ui.dp(4), Ui.dp(4), Ui.dp(4), Ui.dp(6));
        edit.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int st, int c, int af) { }
            @Override public void onTextChanged(CharSequence s, int st, int b, int c) { }
            @Override public void afterTextChanged(Editable s) {
                if (s.toString().trim().length() > 0) typing();
                sendState();
                Ui.main.removeCallbacks(keepDraft);
                Ui.main.postDelayed(keepDraft, 500);
                Swap.dirty();
            }
        });
        body.addView(edit, Ui.fill());
        LinearLayout row = Ui.row(a);
        row.setGravity(Gravity.CENTER_VERTICAL);
        attach = Ui.iconButton(a, Ui.I_CLIP, Ui.G700, v -> { if (a instanceof Base) ((Base) a).pickMedia(this::addPhoto); });
        attach.setContentDescription("Attach a photo");
        row.addView(attach, new LinearLayout.LayoutParams(Ui.dp(40), Ui.dp(40)));
        toLabel = Ui.text(a, "To", 13, Ui.G700);
        row.addView(toLabel, Ui.margins(Ui.wrap(), 4, 0, 6, 0));
        seg = Ui.row(a);
        seg.setGravity(Gravity.CENTER_VERTICAL);
        seg.setPadding(Ui.dp(2), Ui.dp(2), Ui.dp(2), Ui.dp(2));
        segAi = segment(Ui.I_SPARKLES, v -> switchTo(true));
        segPerson = segment(Ui.I_MESSAGE, v -> switchTo(false));
        seg.addView(segAi);
        seg.addView(segPerson, Ui.margins(new LinearLayout.LayoutParams(0, -2, 1), 2, 0, 0, 0));
        row.addView(seg, new LinearLayout.LayoutParams(0, -2, 1));
        View gap = new View(a);
        row.addView(gap, new LinearLayout.LayoutParams(Ui.dp(8), 1));
        sendPill = Ui.row(a);
        sendPill.setGravity(Gravity.CENTER);
        sendPill.setPadding(Ui.dp(14), 0, Ui.dp(12), 0);
        sendPill.addView(Ui.bold(a, "Send", 14, Ui.ON_INK));
        sendPill.addView(Ui.icon(a, Ui.I_UP, 15, Ui.ON_INK), Ui.margins(Ui.wrap(), 5, 0, 0, 0));
        sendPill.setOnClickListener(v -> send());
        sendPill.setContentDescription("Send");
        row.addView(sendPill, new LinearLayout.LayoutParams(-2, Ui.dp(36)));
        sendRound = Ui.roundButton(a, Ui.I_UP, Ui.CARD, Ui.FG, 36, v -> send());
        sendRound.setContentDescription("Send to the AI");
        row.addView(sendRound);
        body.addView(row, Ui.fill());
        view.addView(box, Ui.margins(Ui.fill(), 10, 4, 10, 10));

        JSONObject q = p.person(pid);
        if (q != null) rowSig = sig(q);
        // What was typed here last time (kept per person, section and recipient: draftKey).
        edit.setText(p.prefs.getString(draftKey(false), ""));
        edit.setSelection(edit.length());
        header();
        render();
        composer();
        load(false);
    }

    // ---- drafts (kept per chat and recipient) and a live restart's place ----

    /** The draft's key: the PC, the person, the section and the recipient (the person or their AI), as the PC's
     *  Persons tab keeps its drafts. */
    private String draftKey(boolean ai) {
        return "draft\n" + (p.hub == null ? "" : p.hub.id) + "\n" + pid + "\n" + section + "\n" + (ai ? "ai" : "person");
    }

    /** The composer's text written down for its chat and recipient (empty: forgotten). */
    private void keepDraft() {
        Ui.main.removeCallbacks(keepDraft);
        String t = edit.getText().toString();
        String k = draftKey(toAi);
        if (t.trim().isEmpty()) { if (p.prefs.contains(k)) p.prefs.edit().remove(k).apply(); }
        else if (!t.equals(p.prefs.getString(k, null))) p.prefs.edit().putString(k, t).apply();
    }

    /** The composer goes to the AI (true) or the person: each keeps its own draft. */
    private void setMode(boolean ai) {
        if (ai == toAi) return;
        keepDraft();
        toAi = ai;
        edit.setText(p.prefs.getString(draftKey(ai), ""));
        edit.setSelection(edit.length());
    }

    /** The chat as a live restart (or a crash) keeps it (Swap): the composer (text, cursor, recipient, reply or
     *  forward, the first email's subject, the channel picked) and the conversation's place: the end, or the message
     *  at the top of the screen and its offset. */
    void live(java.util.Map<String, String> st) {
        String t = edit.getText().toString();
        if (!t.isEmpty()) {
            st.put("text", t);
            st.put("selStart", Integer.toString(edit.getSelectionStart()));
            st.put("selEnd", Integer.toString(edit.getSelectionEnd()));
        }
        if (toAi) st.put("ai", "1");
        if (replyTo != null) st.put("reply", replyTo.toString());
        if (forwarded != null) st.put("fwd", forwarded.toString());
        String su = subject.getText().toString();
        if (!su.isEmpty()) st.put("subject", su);
        if (account != null) st.put("account", account);
        boolean ime = edit.hasFocus();
        if (ime && android.os.Build.VERSION.SDK_INT >= 30 && edit.getRootWindowInsets() != null)
            ime = edit.getRootWindowInsets().isVisible(android.view.WindowInsets.Type.ime());
        if (ime) st.put("focus", "1");
        // The place is ChatFlow's (where this chat was left, per run): the lowest message on screen and how far its
        // bottom is above the transcript's bottom edge.
        if (data == null) return;
        savePlace(true);
        ChatFlow.Pos pos = ChatFlow.place(posKey());
        if (pos != null && pos.end) st.put("end", "1");
        if (pos == null || pos.end) return;
        st.put("anchor", pos.anchor);
        st.put("below", Integer.toString(pos.off));
    }

    /** Back as live() left it (right after the chat was made). */
    void restore(java.util.Map<String, String> st) {
        String ac = st.get("account");
        if (ac != null && !ac.isEmpty()) account = ac;
        if ("1".equals(st.get("ai"))) setMode(true);
        String t = st.get("text");
        if (t != null) {
            edit.setText(t);
            int len = t.length();
            int a0 = clamp(st.get("selStart"), len), a1 = clamp(st.get("selEnd"), len);
            edit.setSelection(Math.min(a0, a1), Math.max(a0, a1));
        }
        replyTo = json(st.get("reply"));
        forwarded = json(st.get("fwd"));
        String su = st.get("subject");
        if (su != null) subject.setText(su);
        // Its place goes back into ChatFlow's memory, which the first render puts the chat at (placeFirst).
        // (Older code wrote "off", from the top: not comparable, so such a place is let go.)
        String an = st.get("anchor"), below = st.get("below");
        if (an != null && !an.isEmpty() && below != null) {
            int off;
            try { off = Integer.parseInt(below); } catch (Exception e) { off = 0; }
            ChatFlow.place(posKey(), new ChatFlow.Pos(false, an, off, 0));
        }
        liveEnd = "1".equals(st.get("end"));
        if ("1".equals(st.get("focus"))) {
            // The keyboard was up on the composer: up again (the place is held by its bottom, so it lands as it was).
            edit.requestFocus();
            a.getWindow().setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE
                    | android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        }
        composer();
    }

    private static int clamp(String v, int len) {
        try { return Math.max(0, Math.min(len, Integer.parseInt(v))); } catch (Exception e) { return len; }
    }

    private static JSONObject json(String v) {
        if (v == null || v.isEmpty()) return null;
        try { return new JSONObject(v); } catch (Exception e) { return null; }
    }

    /** The text field a live restart keeps (Swap: a pause in the message is a good moment). */
    View liveField() { return edit; }

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
        if (!holdUnread && (wasFirst || PersonsUi.info(q, section).optInt("unread") > 0 || !PersonsUi.s(r, "unreadFrom").isEmpty())) markRead();
    }

    private void loadOlder() { loadOlder(null); }

    /** The page before the oldest message shown; `done` runs after it came in (true) or failed (false). */
    private void loadOlder(java.util.function.Consumer<Boolean> done) {
        if (loadingOlder || msgs.isEmpty() || p.hub == null) { if (done != null) done.accept(false); return; }
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
                if (fr == null) { Ui.toast(a, fe); render(); if (done != null) done.accept(false); return; }
                more = fr.optBoolean("more");
                Map<String, JSONObject> byId = new LinkedHashMap<>();
                for (JSONObject m : PersonsHome.objs(PersonsUi.arr(fr, "messages"))) byId.put(PersonsUi.s(m, "id"), m);
                for (JSONObject m : msgs) byId.put(PersonsUi.s(m, "id"), m);
                msgs.clear();
                msgs.addAll(byId.values());
                sortMsgs();
                render();
                if (done != null) done.accept(true);
            });
        });
    }

    // ---- a reply's quote tapped: to the message it replies to (WhatsApp's) ----

    /** Older pages read at most while looking for it (Discord's are 50 messages each). */
    private static final int JUMP_PAGES = 40;
    /** The message flashing (its row tinted, fading out) and when it started. */
    private String flashId = "";
    private long flashAt;
    /** Each tap's own search: a newer tap (or another chat) ends an older one. */
    private int jumpSeq;

    /** Scrolls to the message `id` and flashes it; one not loaded yet is looked for in older pages. */
    private void jumpTo(String id) {
        if (id.isEmpty()) return;
        int seq = ++jumpSeq;
        jumpStep(id, seq, 0);
    }

    private void jumpStep(String id, int seq, int pages) {
        if (seq != jumpSeq || closed || a.isDestroyed()) return;
        if (rows.containsKey(id)) { flash(id); return; }
        boolean loaded = false;
        for (JSONObject m : msgs) if (id.equals(PersonsUi.s(m, "id"))) { loaded = true; break; }
        if (loaded) { flash(id); return; }
        if (!more || pages >= JUMP_PAGES) { Ui.toast(a, "Original message not available"); return; }
        int n = msgs.size();
        loadOlder(ok -> {
            if (seq != jumpSeq) return;
            if (!ok || msgs.size() == n) { Ui.toast(a, "Original message not available"); return; }
            jumpStep(id, seq, pages + 1);
        });
    }

    /** The row comes into view at about 40% of the height, tinted, fading out over ~1.5 s. */
    private void flash(String id) {
        flashId = id;
        flashAt = android.os.SystemClock.uptimeMillis();
        View row = rows.get(id);
        if (row == null) return;
        tint(row);
        afterLayout(() -> {
            View v = rows.get(id);
            if (v == null) return;
            int y = v.getTop() + v.getHeight() / 2 - (int) (sv.getHeight() * 0.4f);
            sv.smoothScrollTo(0, Math.max(0, Math.min(y, content.getHeight() - sv.getHeight())));
        });
    }

    /** The tint holds, then fades. A test build (the screenshot rig) holds it 6 s, so a shot taken once the screen is
     *  still shows it. */
    private static final long FLASH_HOLD = Rig.on() ? 6000 : 400, FLASH_FADE = 1100;

    /** A flashing row's tint for what's left of its flash (a render in between keeps it going). */
    private void tint(View row) {
        long gone = android.os.SystemClock.uptimeMillis() - flashAt;
        if (gone >= FLASH_HOLD + FLASH_FADE) return;
        int on = (Ui.BLUE & 0x00ffffff) | ((Ui.dark ? 0x3a : 0x2c) << 24);
        android.animation.ValueAnimator va = android.animation.ValueAnimator.ofArgb(on, on & 0x00ffffff);
        va.setDuration(FLASH_FADE);
        va.setStartDelay(Math.max(0, FLASH_HOLD - gone));
        if (gone > FLASH_HOLD) va.setCurrentPlayTime(gone - FLASH_HOLD);
        va.setInterpolator(new android.view.animation.DecelerateInterpolator());
        va.addUpdateListener(x -> row.setBackgroundColor((Integer) x.getAnimatedValue()));
        row.setBackgroundColor(on);
        va.start();
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
        savePlace();
        keepDraft();
        closed = true;
        typingOff();
        PersonsAudio.stop();
    }

    // ---- header ----

    private void header() {
        headBox.removeAllViews();
        // The shared top bar: the side-panel button (People's list as the drawer), the person's avatar, name and
        // status line, then the channel switch and Details.
        Ds.TopBar bar = Ds.topBar(a, p.sideButton(), name());
        JSONObject st = p.person(pid);
        JSONObject cp = PersonsUi.obj(data, "person");
        String presence = PersonsUi.s(cp, "presence");
        if (presence.isEmpty()) presence = PersonsUi.s(PersonsUi.info(st, section), "presence");
        String av = PersonsUi.s(cp, "avatar");
        if (av.isEmpty()) av = PersonsUi.s(st, "avatar");
        bar.mark(PersonsUi.avatar(a, p.hub, av, PersonsUi.s(st, "initials"), PersonsUi.color(PersonsUi.s(st, "color"), Ui.G500), 32, presence), 32);
        String typing = PersonsUi.s(data, "typing");
        if (typing.isEmpty()) typing = PersonsUi.s(PersonsUi.info(st, section), "typing");
        JSONObject status = PersonsUi.obj(cp, "status");
        if (status == null) status = PersonsUi.obj(PersonsUi.info(st, section), "status");
        JSONObject ac = PersonsUi.obj(data, "account");
        if (!typing.isEmpty()) bar.sub("recording".equals(typing) ? "recording audio…" : "typing…", PersonsUi.tone("green"));
        else if (status != null && !PersonsUi.s(status, "text").isEmpty()) bar.sub(PersonsUi.s(status, "text"), PersonsUi.tone(PersonsUi.s(status, "tone")));
        else bar.sub(ac == null ? "" : PersonsUi.s(ac, "label"), Ui.G700);
        JSONArray accounts = PersonsUi.arr(data, "accounts");
        if (accounts.length() > 1 && ac != null) {
            LinearLayout sw = Ui.row(a);
            sw.setGravity(Gravity.CENTER_VERTICAL);
            sw.setPadding(Ui.dp(8), Ui.dp(6), Ui.dp(8), Ui.dp(6));
            sw.setBackground(Ui.press(Ui.CARD, Ui.LINE, 16));
            sw.addView(PersonsUi.channel(a, PersonsUi.s(ac, "kind"), 16), new LinearLayout.LayoutParams(Ui.dp(16), Ui.dp(16)));
            sw.addView(Ui.icon(a, Ui.I_DOWN, 13, Ui.G700), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(14), Ui.dp(14)), 3, 0, 0, 0));
            sw.setContentDescription("Switch channel: " + PersonsUi.s(ac, "label"));
            sw.setOnClickListener(v -> switchAccount(accounts));
            bar.actions.addView(sw, Ui.margins(Ui.wrap(), 4, 0, 4, 0));
        }
        // Discord, not friends yet: Add friend (a DM to a stranger with no shared server bounces); Request sent waits
        String rel = PersonsUi.s(data, "relation");
        if (!rel.isEmpty() && !"friend".equals(rel) && !"blocked".equals(rel)) {
            boolean sent = "sent".equals(rel);
            String label = sent ? "Request sent" : friending ? "Sending…" : "incoming".equals(rel) ? "Accept friend" : "Add friend";
            LinearLayout fr = Ui.row(a);
            fr.setGravity(Gravity.CENTER_VERTICAL);
            fr.setPadding(Ui.dp(10), Ui.dp(6), Ui.dp(12), Ui.dp(6));
            fr.setBackground(Ui.press(Ui.CARD, Ui.LINE, 16));
            fr.addView(Ui.icon(a, sent ? Ui.I_USER_CHECK : Ui.I_PLUS, 14, Ui.FG), new LinearLayout.LayoutParams(Ui.dp(14), Ui.dp(14)));
            TextView ft = Ui.bold(a, label, 13, Ui.FG);
            ft.setPadding(Ui.dp(5), 0, 0, 0);
            fr.addView(ft);
            fr.setContentDescription(label);
            if (sent || friending) fr.setAlpha(0.5f);
            else fr.setOnClickListener(v -> addFriend());
            bar.actions.addView(fr, Ui.margins(Ui.wrap(), 4, 0, 4, 0));
        }
        bar.action(Ui.I_PANEL_RIGHT, "Details", v -> p.openPanel(pid, section));
        headBox.addView(bar.view, new FrameLayout.LayoutParams(-1, -2));

        if (!typing.isEmpty()) {
            typingLine.setText(name() + " is " + ("recording".equals(typing) ? "recording audio…" : "typing…"));
            typingLine.setTextColor(Ui.BLUE);
            typingLine.setVisibility(View.VISIBLE);
        } else typingLine.setVisibility(View.GONE);
    }

    /** Add friend (Discord): a friend request to the person, sent by the PC; the tap is the user's go-ahead. */
    private void addFriend() {
        if (friending || p.hub == null) return;
        friending = true;
        header();
        JSONObject b = PersonsUi.put(new JSONObject(), "section", section);
        String ac = acctId();
        if (ac != null) PersonsUi.put(b, "account", ac);
        String path = base() + "/friend";
        Ui.bg(a, () -> {
            try {
                return p.hub.call("POST", path, b);
            } catch (Exception e) {
                return PersonsUi.put(PersonsUi.put(new JSONObject(), "ok", false), "error", Hub.why(e));
            }
        }, r -> {
            friending = false;
            if (!r.optBoolean("ok", false)) Ui.toast(a, r.optString("error", "The friend request didn't go"));
            else Ui.toast(a, "friend".equals(r.optString("relation")) ? "You're friends on Discord now" : "Friend request sent");
            load(false);
        });
    }

    private void switchAccount(JSONArray accounts) {
        String[] labels = new String[accounts.length()];
        for (int i = 0; i < labels.length; i++) {
            JSONObject o = accounts.optJSONObject(i);
            String to = o == null ? "" : PersonsUi.s(o, "to");
            labels[i] = o == null ? "" : PersonsUi.s(o, "label") + (to.contains(" · ") ? " → " + to.substring(to.indexOf(" · ") + 3) : "");
        }
        // every chat shows in the one timeline: this picks where the next message goes
        Ui.dialog(a).setTitle("Send on").setItems(labels, (d, w) -> {
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

    /** Each message's row as drawn now, by id (a reply's quote scrolls to it). */
    private final Map<String, View> rows = new java.util.HashMap<>();

    /** The views drawn last time by key ("m:<id>", "d:<day>", "ai:<id>", …), with what they were drawn from: a render
     *  keeps those whose data didn't change and only builds, moves or drops the others, so a new message is one view
     *  added at the end (no flash of the whole list, pictures not loaded again). */
    private final Map<String, View> drawn = new java.util.HashMap<>();
    private final Map<String, String> drawnSig = new java.util.HashMap<>();
    /** The keys on screen after the last render, also when `drawn` was let go (a rebuilt row isn't a new one). */
    private final java.util.Set<String> shownKeys = new java.util.HashSet<>();
    /** What every view depends on beside its own data (their name, the width): a change draws everything anew. */
    private String drawnAll = "";
    /** The AI's cards fold by a tap (rerender): they're built anew on the next render. */
    private boolean dropAi;
    /** Every picture in the chat, in order (the viewer's gallery): the same list across renders, refilled each time. */
    private final List<String[]> gallery = new ArrayList<>();
    /** The day lines drawn now, top to bottom, with their labels (the floating day pill). */
    private final List<View> dayViews = new ArrayList<>();

    private View keep(Map<String, View> next, Map<String, String> nextSig, String key, String sig, java.util.function.Supplier<View> make, java.util.Set<View> fresh) {
        View v = drawn.get(key);
        if (v == null || !sig.equals(drawnSig.get(key)) || next.containsKey(key)) {
            v = make.get();
            fresh.add(v);
        }
        next.put(key, v);
        nextSig.put(key, sig);
        return v;
    }

    private void render() {
        rows.clear();
        boolean atBottom = !positioned || toBottom || stickEnd || (!holding() && ChatFlow.atEnd(sv, content, Ui.dp(80)));
        if (toBottom) stickEnd = true;
        boolean sent = toBottom;
        toBottom = false;
        // What's at the top of the screen now and how far down: it stays there (older pages above, new ones below).
        View anchor = null;
        int anchorOff = 0;
        if (positioned && !atBottom) {
            int y = sv.getScrollY();
            for (int i = 0; i < content.getChildCount(); i++) {
                View c = content.getChildAt(i);
                if (c.getBottom() > y) { anchor = c; anchorOff = c.getTop() - y; break; }
            }
        }
        String all = name() + "|" + maxW() + "|" + PersonsUi.arr(data, "accounts").length() + "|" + Ui.dark;
        if (!all.equals(drawnAll)) { drawn.clear(); drawnSig.clear(); drawnAll = all; }
        Map<String, View> next = new java.util.HashMap<>();
        Map<String, String> nextSig = new java.util.HashMap<>();
        java.util.Set<View> fresh = new java.util.HashSet<>();
        List<View> want = new ArrayList<>();
        dayViews.clear();
        if (more && !msgs.isEmpty()) {
            // older pages: a small spinner on top while one loads (the view stays where it is)
            want.add(keep(next, nextSig, "older", String.valueOf(loadingOlder), () -> {
                if (loadingOlder) {
                    android.widget.ProgressBar pb = new android.widget.ProgressBar(a);
                    pb.setIndeterminate(true);
                    FrameLayout f = new FrameLayout(a);
                    f.addView(pb, new FrameLayout.LayoutParams(Ui.dp(22), Ui.dp(22), Gravity.CENTER));
                    f.setLayoutParams(new LinearLayout.LayoutParams(-1, Ui.dp(40)));
                    return f;
                }
                TextView older = Ui.rowButton(a, "Load older", false, v -> loadOlder());
                LinearLayout.LayoutParams lp = Ui.wrap();
                lp.gravity = Gravity.CENTER_HORIZONTAL;
                older.setLayoutParams(Ui.margins(lp, 0, 4, 0, 4));
                return older;
            }, fresh));
        }
        if (msgs.isEmpty() && ai.length() == 0 && pending.isEmpty()) {
            String s = loadError != null ? loadError : data == null ? "" : acctId() == null
                    ? "No channel to talk to them here: connect Discord, Gmail or WhatsApp in the section's + menu on the PC, and give them that identifier."
                    : "No messages yet.";
            boolean err = loadError != null;
            want.add(keep(next, nextSig, "empty", err + s, () -> {
                TextView t = Ui.text(a, s, 14, err ? Ui.RED : Ui.G700);
                t.setGravity(Gravity.CENTER);
                t.setPadding(Ui.dp(28), Ui.dp(40), Ui.dp(28), Ui.dp(40));
                if (err) {
                    t.setText(s + "\nTap to try again.");
                    t.setOnClickListener(v -> { loadError = null; render(); load(false); });
                }
                t.setLayoutParams(Ui.fill());
                return t;
            }, fresh));
        }
        newestAi = "";
        for (JSONObject e : PersonsHome.objs(ai)) if (!"user".equals(PersonsUi.s(e, "role"))) newestAi = PersonsUi.s(e, "id");
        // The conversation and the AI's thread, by time.
        List<Object[]> line = new ArrayList<>();
        for (JSONObject m : msgs) line.add(new Object[]{at(m), m, "msg"});
        for (JSONObject e : PersonsHome.objs(ai)) line.add(new Object[]{PersonsUi.ms(PersonsUi.s(e, "at")), e, "ai"});
        // SpokPay site requests proposed from a message, and those the agent is still drafting
        for (JSONObject e : PersonsHome.objs(PersonsUi.arr(data, "proposals"))) line.add(new Object[]{PersonsUi.ms(PersonsUi.s(e, "at")), e, "proposal"});
        for (JSONObject e : PersonsHome.objs(PersonsUi.arr(data, "proposing"))) line.add(new Object[]{PersonsUi.ms(PersonsUi.s(e, "at")), e, "proposing"});
        Collections.sort(line, (x, y) -> Long.compare((Long) x[0], (Long) y[0]));
        String unreadFrom = PersonsUi.s(data, "unreadFrom");
        if (!positioned) keptUnread = unreadFrom;
        if (sent) keptUnread = "";
        unreadFrom = keptUnread;
        gallery.clear();
        for (JSONObject m : msgs) for (JSONObject f : PersonsHome.objs(PersonsUi.arr(m, "files")))
            if (f.optBoolean("image")) gallery.add(new String[]{PersonsUi.s(f, "url"), PersonsUi.s(f, "name")});
        long prevDay = -1, prevAt = 0;
        JSONObject prev = null;
        String prevSubject = "";
        View unreadLine = null;
        // Their messages new since the last render (drawn at the end): counted while scrolled up.
        List<String> arrived = new ArrayList<>();
        int ai0 = 0;
        boolean dropAiNow = dropAi;
        dropAi = false;
        for (Object[] e : line) {
            long t = (Long) e[0];
            JSONObject o = (JSONObject) e[1];
            boolean broke = false;
            if (t > 0 && PersonsUi.dayOf(t) != prevDay) {
                prevDay = PersonsUi.dayOf(t);
                String label = PersonsUi.day(t);
                View dv = keep(next, nextSig, "d:" + prevDay, label, () -> divider(label, Ui.G700, false), fresh);
                dv.setTag(label);
                dayViews.add(dv);
                want.add(dv);
                broke = true;
            }
            if (!"msg".equals(e[2])) {
                String kind = (String) e[2];
                String key = kind + ":" + ("ai".equals(kind) ? PersonsUi.s(o, "id") : PersonsUi.s(o, "id").isEmpty() ? PersonsUi.s(o, "messageId") + ":" + (ai0++) : PersonsUi.s(o, "id"));
                if ("ai".equals(kind) && dropAiNow) drawn.remove(key);
                String sig = o.toString() + ("ai".equals(kind) ? "|" + newestAi : "");
                want.add(keep(next, nextSig, key, sig, () -> "ai".equals(kind) ? aiView(o) : siteCard(o, "proposing".equals(kind)), fresh));
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
                String label = n == 1 ? "1 unread message" : n + " unread messages";
                unreadLine = keep(next, nextSig, "u:" + id, label, () -> divider(label, Ui.BLUE, true), fresh);
                want.add(unreadLine);
                broke = true;
            }
            String subj = PersonsUi.s(o, "subject").replaceAll("(?i)^((re|fwd?|enc|res):\\s*)+", "").trim();
            if (!PersonsUi.s(o, "subject").isEmpty() && !subj.equals(prevSubject)) {
                String label = subj.isEmpty() ? "(no subject)" : subj;
                want.add(keep(next, nextSig, "s:" + id, label, () -> divider(label, Ui.G700, true), fresh));
                prevSubject = subj;
                broke = true;
            }
            boolean joined = !broke && prev != null && prev.optBoolean("fromMe") == o.optBoolean("fromMe") && t - prevAt < GROUP_MS && chanOf(prev).equals(chanOf(o));
            boolean newOne = positioned && !drawn.containsKey("m:" + id);
            View row = keep(next, nextSig, "m:" + id, joined + "|" + o, () -> bubble(o, joined, gallery), fresh);
            if (newOne && !o.optBoolean("fromMe")) arrived.add(id);
            rows.put(id, row);
            if (id.equals(flashId)) tint(row);
            want.add(row);
            prev = o;
            prevAt = t;
        }
        for (JSONObject o : pending) {
            String key = "p:" + System.identityHashCode(o);
            want.add(keep(next, nextSig, key, PersonsUi.s(o, "error") + "|" + o.optBoolean("retrying"), () -> pendingView(o), fresh));
        }
        // Put the views in order touching only what changed: kept ones stay, new ones go in, gone ones go.
        int lastKept = -1;
        for (int i = 0; i < want.size(); i++) if (!fresh.contains(want.get(i))) lastKept = i;
        for (int i = 0; i < want.size(); i++) {
            View w = want.get(i);
            if (content.getChildAt(i) == w) continue;
            if (w.getParent() instanceof android.view.ViewGroup) ((android.view.ViewGroup) w.getParent()).removeView(w);
            content.addView(w, Math.min(i, content.getChildCount()));
        }
        while (content.getChildCount() > want.size()) content.removeViewAt(content.getChildCount() - 1);
        drawn.clear();
        drawn.putAll(next);
        drawnSig.clear();
        drawnSig.putAll(nextSig);
        // A message new at the end (theirs, or mine on its way) comes in with WhatsApp's short entry. Only one that
        // wasn't on screen: a row built anew (its data or the chat's name changed, a reload) stays still.
        java.util.Set<View> brandNew = new java.util.HashSet<>();
        for (Map.Entry<String, View> e : next.entrySet()) if (!shownKeys.contains(e.getKey())) brandNew.add(e.getValue());
        shownKeys.clear();
        shownKeys.addAll(next.keySet());
        if (positioned) for (int i = lastKept + 1; i < want.size(); i++) {
            View w = want.get(i);
            if (!fresh.contains(w) || !brandNew.contains(w)) continue;
            boolean mine = false;
            for (Map.Entry<String, View> r : rows.entrySet()) if (r.getValue() == w) {
                for (JSONObject m : msgs) if (PersonsUi.s(m, "id").equals(r.getKey())) mine = m.optBoolean("fromMe");
            }
            if (!mine) ChatFlow.enter(w);
        }
        boolean wasPositioned = positioned;
        boolean hasData = data != null || loadError != null;
        if (!wasPositioned && hasData) positioned = true;
        View anchorV = anchor;
        int anchorO = anchorOff;
        View unreadV = unreadLine;
        if (!atBottom && !arrived.isEmpty()) {
            if (unseen == 0) firstUnseen = arrived.get(0);
            unseen += arrived.size();
            jump.count(unseen);
        }
        afterLayout(() -> {
            if (!wasPositioned) {
                if (positioned) placeFirst(unreadV);
                else sv.scrollTo(0, content.getHeight());
            } else if (atBottom) {
                int end = Math.max(0, content.getHeight() - sv.getHeight());
                if (sent || end - sv.getScrollY() < sv.getHeight() * 2) sv.smoothScrollTo(0, end);
                else sv.scrollTo(0, end);
            } else if (anchorV != null && anchorV.getParent() == content) {
                sv.scrollTo(0, Math.max(0, anchorV.getTop() - anchorO));
            }
            scrolled(false);
        });
    }

    /** The first time the messages are here: where this chat was left (this run of the app), else the unread line
     *  near the top, else the end. At once, before the first frame (no visible scroll). */
    private void placeFirst(View unreadLine) {
        placed++;
        ChatFlow.Pos was = ChatFlow.place(posKey());
        View at = was != null && !was.end ? rows.get(was.anchor) : null;
        if (unreadLine != null && !liveEnd && (was == null || was.end || at == null)) {
            stickEnd = false;
            sv.scrollTo(0, Math.max(0, unreadLine.getTop() - Ui.dp(24)));
        } else if (at != null) {
            stickEnd = false;
            holdView = at;
            holdBelow = was.off;
            holdStart = android.os.SystemClock.uptimeMillis();
            holdUntil = holdStart + 2_500;
            sv.scrollTo(0, holdY());
        } else {
            stickEnd = true;
            sv.scrollTo(0, content.getHeight());
        }
    }

    private String posKey() { return p.hub == null ? pid + "|" + section : p.hub.id + "|" + pid + "|" + section; }

    /** The place being held (placeFirst): its message still here, the finger not on the chat, within its moment. A
     *  change in what lays out keeps it a little longer (the keyboard and composer coming back), at most 6 s. */
    private boolean holding() {
        return holdView != null && holdView.getParent() == content && android.os.SystemClock.uptimeMillis() < holdUntil;
    }

    /** Where the held message's bottom is `holdBelow` px above the transcript's bottom edge. */
    private int holdY() { return Math.max(0, holdView.getBottom() + holdBelow - sv.getHeight()); }

    /** Back to the held place once this layout is done (the transcript's or the content's new size known). */
    private void hold() {
        long now = android.os.SystemClock.uptimeMillis();
        holdUntil = Math.min(holdStart + 6_000, Math.max(holdUntil, now + 1_000));
        View hv = holdView;
        ChatFlow.beforeDraw(sv, () -> { if (holdView == hv && hv.getParent() == content) sv.scrollTo(0, holdY()); });
    }

    /** Where it's left now: at the end, or the lowest message on screen and how far its bottom is above the
     *  transcript's bottom edge (negative: cut off by it). By the bottom, as WhatsApp: what was just above the
     *  composer comes back just above it, whatever the transcript's height is while it's placed (the keyboard and the
     *  composer coming back after a restore resize it from the bottom). */
    private void savePlace() { savePlace(false); }

    /** exact: a restart's, which comes back to the very pixel; only the very end counts as the end (else a spot a
     *  little short of it, e.g. at the unread line, came back at the end). Leaving the chat: near the end is the end. */
    private void savePlace(boolean exact) {
        if (!positioned) return;
        if (exact ? ChatFlow.atEnd(sv, content, Ui.dp(2)) : stickEnd || ChatFlow.atEnd(sv, content, Ui.dp(80))) { ChatFlow.place(posKey(), new ChatFlow.Pos(true, "", 0, 0)); return; }
        int y = sv.getScrollY(), b = y + sv.getHeight();
        String best = null;
        int top = Integer.MIN_VALUE, bot = 0;
        for (Map.Entry<String, View> r : rows.entrySet()) {
            View v = r.getValue();
            if (v.getParent() != content || v.getHeight() == 0 || v.getBottom() <= y || v.getTop() >= b) continue;
            if (v.getTop() > top) { top = v.getTop(); bot = v.getBottom(); best = r.getKey(); }
        }
        ChatFlow.place(posKey(), best == null ? null : new ChatFlow.Pos(false, best, b - bot, 0));
    }

    /** After a scroll (or a render): the "↓" (more than a screen up, or new messages unseen), the unseen count
     *  cleared at the end, the floating day pill while the finger moves it. */
    private void scrolled(boolean moved) {
        if (!positioned) return;
        int up = ChatFlow.fromEnd(sv, content);
        if (up < Ui.dp(80) && unseen > 0) { unseen = 0; firstUnseen = ""; jump.count(0); }
        jump.show(up > sv.getHeight() || (unseen > 0 && up >= Ui.dp(80)));
        if (!moved) return;
        int y = sv.getScrollY();
        String day = "";
        for (View d : dayViews) {
            if (d.getParent() != content) continue;
            if (d.getTop() <= y + Ui.dp(4)) day = (String) d.getTag();
            else break;
        }
        // its own line is on screen near the top: no pill over it
        dayPill.show(y < Ui.dp(8) ? "" : day);
    }

    /** The "↓": to their first message that came in unseen when it's more than a screen up, else the end. */
    private void jumpDown() {
        View first = firstUnseen.isEmpty() ? null : rows.get(firstUnseen);
        int end = Math.max(0, content.getHeight() - sv.getHeight());
        int y = first != null && first.getParent() == content ? Math.min(end, Math.max(0, first.getTop() - Ui.dp(24))) : end;
        holdView = null;
        sv.smoothScrollTo(0, y);
        stickEnd = y >= end;
        unseen = 0;
        firstUnseen = "";
        jump.count(0);
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
            // the channel it came or went on, once the page shows more than one chat (a linked person's)
            String chan = chanOf(m);
            if (!chan.isEmpty()) {
                LinearLayout mr = Ui.row(a);
                mr.setGravity(Gravity.CENTER_VERTICAL);
                View mark = PersonsUi.channel(a, chan, 12);
                mark.setAlpha(0.8f);
                mr.addView(mark, Ui.margins(new LinearLayout.LayoutParams(Ui.dp(12), Ui.dp(12)), 0, 0, 5, 0));
                mr.addView(mt);
                wrap.addView(mr, Ui.margins(Ui.wrap(), 6, 0, 6, 2));
            } else wrap.addView(mt, Ui.margins(Ui.wrap(), 6, 0, 6, 2));
        }
        LinearLayout b = Ui.col(a);
        b.setBackground(me ? Ui.round(Ui.G100, 0, 18) : Ui.round(Ui.CARD, Ui.LINE, 18));
        b.setPadding(Ui.dp(12), Ui.dp(8), Ui.dp(12), Ui.dp(8));
        int inner = maxW() - Ui.dp(24);
        JSONObject reply = PersonsUi.obj(m, "reply");
        if (reply != null) {
            LinearLayout q = Ui.row(a);
            // a tap scrolls to the message it replies to and flashes it
            String rid = PersonsUi.s(reply, "id");
            if (!rid.isEmpty()) {
                q.setBackground(Ui.press(0, 0, 4));
                q.setOnClickListener(v -> jumpTo(rid));
            }
            View bar = new View(a);
            bar.setBackgroundColor(Ui.BLUE);
            q.addView(bar, new LinearLayout.LayoutParams(Ui.dp(2), -1));
            SpannableStringBuilder sb = new SpannableStringBuilder();
            sb.append(reply.optBoolean("fromMe") ? "You" : name());
            sb.setSpan(new Ui.Font(Ui.semi, 0), 0, sb.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            String rt = PersonsEmoji.plain(PersonsUi.s(reply, "text"));
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
            // Discord's custom emoji show as :name: until their pictures are here; 1-3 emoji alone are drawn big
            List<PersonsEmoji.Custom> emo = PersonsEmoji.customs(text);
            boolean big = PersonsEmoji.jumbo(text, 3) > 0;
            List<int[]> spots = new ArrayList<>();
            SpannableStringBuilder sb = new SpannableStringBuilder();
            if (text.isEmpty() && fs.isEmpty()) sb.append("Empty message");
            else {
                int last = 0;
                for (PersonsEmoji.Custom c : emo) {
                    sb.append(text, last, c.start);
                    int s0 = sb.length();
                    sb.append(":").append(c.name).append(":");
                    spots.add(new int[] { s0, sb.length() });
                    last = c.end;
                }
                sb.append(text.substring(last));
            }
            if (text.isEmpty() && fs.isEmpty()) sb.setSpan(new ForegroundColorSpan(Ui.G600), 0, sb.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            if (m.optBoolean("edited")) {
                int s = sb.length();
                sb.append(" (edited)");
                sb.setSpan(new ForegroundColorSpan(Ui.G600), s, sb.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                sb.setSpan(big ? new AbsoluteSizeSpan(12, true) : new RelativeSizeSpan(0.8f), s, sb.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            }
            TextView tv = Ui.text(a, sb, big ? 40 : 15, Ui.FG);
            tv.setMaxWidth(inner);
            tv.setLinkTextColor(Ui.BLUE);
            Linkify.addLinks(tv, Linkify.WEB_URLS | Linkify.EMAIL_ADDRESSES);
            if (!emo.isEmpty()) emojiPictures(tv, sb, emo, spots, big ? Ui.dp(48) : Math.round(tv.getTextSize() * 1.375f));
            tv.setOnLongClickListener(v -> { menu(m); return true; });
            // plain text gets its own width (its widest line, at most the bubble's): a long message right under a
            // one-letter one of mine once came out one letter wide on a phone (Android 13)
            if (sb.length() > 0) b.addView(tv, emo.isEmpty() ? textWidth(tv, sb, inner) : Ui.wrap());
        }
        for (JSONObject f : fs) {
            boolean audio = "audio".equals(PersonsUi.s(f, "kind")) || (m.optBoolean("voice") && !f.optBoolean("image"));
            View fv = f.optBoolean("image") ? imageView(f, inner, gallery)
                    : f.optBoolean("video") ? videoView(f, inner)
                    : audio ? PersonsAudio.view(a, p.hub, f, me, fileAccount(f), inner, () -> load(false))
                    : fileRow(f, m.optBoolean("voice"), inner);
            // a picture's or video's tile keeps the size it was made with (its ratio, before it loads): wrap_content
            // here made it 0 px high until the picture came, which moved everything as a chat opened
            android.view.ViewGroup.LayoutParams own = fv.getLayoutParams();
            LinearLayout.LayoutParams lp = own != null && own.width > 0 && own.height > 0 ? new LinearLayout.LayoutParams(own.width, own.height) : Ui.wrap();
            b.addView(fv, Ui.margins(lp, 0, b.getChildCount() > 0 ? 6 : 0, 0, 0));
        }
        String status = PersonsUi.s(m, "status");
        if (me && !status.isEmpty()) b.addView(ticks(status), Ui.margins(endWrap(), 0, 2, 0, 0));
        b.setOnLongClickListener(v -> { menu(m); return true; });
        wrap.addView(b, Ui.wrap());
        return wrap;
    }

    /** Discord's custom emoji in a message's text as their pictures, `px` high, each over its `:name:` once it's here
     *  (through the PC's picture cache). */
    private void emojiPictures(TextView tv, SpannableStringBuilder sb, List<PersonsEmoji.Custom> emo, List<int[]> spots, int px) {
        int size = px > Ui.dp(32) ? 96 : 48;
        for (int i = 0; i < emo.size(); i++) {
            int[] at = spots.get(i);
            PersonsUi.bitmap(a, p.hub, PersonsEmoji.route(emo.get(i), size), px, b -> {
                if (b == null || b.getHeight() <= 0) return;
                BitmapDrawable d = new BitmapDrawable(a.getResources(), b);
                d.setBounds(0, 0, Math.max(1, px * b.getWidth() / b.getHeight()), px);
                sb.setSpan(new ImageSpan(d, DynamicDrawableSpan.ALIGN_BOTTOM), at[0], at[1], Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                tv.setText(sb);
                Linkify.addLinks(tv, Linkify.WEB_URLS | Linkify.EMAIL_ADDRESSES);
            });
        }
    }

    /** A message's channel kind when the page shows more than one chat ("" otherwise: no marks). */
    private String chanOf(JSONObject m) {
        if (PersonsUi.arr(data, "accounts").length() < 2) return "";
        JSONObject c = PersonsUi.obj(m, "channel");
        return c == null ? "" : PersonsUi.s(c, "kind");
    }

    /** The connection an attachment came through (its file route's `account`). */
    private String fileAccount(JSONObject f) {
        try {
            String v = Uri.parse("http://hub" + PersonsUi.s(f, "url")).getQueryParameter("account");
            if (v != null) return v;
        } catch (Exception ignored) { }
        String ac = acctId();
        return ac == null ? "" : ac;
    }

    /** A message's text at the width it needs (its widest line, at most `max`), not left to wrap_content's measure. */
    private static LinearLayout.LayoutParams textWidth(TextView tv, CharSequence text, int max) {
        int w = (int) Math.ceil(android.text.Layout.getDesiredWidth(text, tv.getPaint())) + tv.getCompoundPaddingLeft() + tv.getCompoundPaddingRight();
        return new LinearLayout.LayoutParams(Math.max(1, Math.min(max, w)), LinearLayout.LayoutParams.WRAP_CONTENT);
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
            case "pending": s = "🕓"; break;
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

    /** Videos whose tile fetches its poster by itself (the PC downloads the video for it); a larger one shows ▶ alone. */
    private static final long POSTER_AUTO = 48L << 20;

    /** A video as WhatsApp draws it: its first frame (the PC's poster), ▶ in a dark disc and its length in the corner,
     *  sized like a picture (its ratio, else 16:9). A tap has the PC download it (a spinner in the disc meanwhile),
     *  then plays it in the viewer ({@link Images#view}: MediaPlayer, streamed from the PC by Range, seek, mute). */
    private View videoView(JSONObject f, int inner) {
        int w = Math.min(inner, Ui.dp(240));
        int fw = f.optInt("width"), fh = f.optInt("height");
        int h = fw > 0 && fh > 0 ? Math.max(Ui.dp(80), Math.min(Ui.dp(320), w * fh / fw)) : w * 9 / 16;
        FrameLayout box = new FrameLayout(a);
        box.setBackground(Ui.round(0xff181818, 0, 12));
        box.setClipToOutline(true);
        box.setLayoutParams(new LinearLayout.LayoutParams(w, h));
        ImageView iv = new ImageView(a);
        iv.setScaleType(ImageView.ScaleType.CENTER_CROP);
        box.addView(iv, new FrameLayout.LayoutParams(-1, -1));
        String url = PersonsUi.s(f, "url"), name = PersonsUi.s(f, "name"), poster = PersonsUi.s(f, "poster");
        long size = f.optLong("size");
        if (!poster.isEmpty() && (size <= 0 || size <= POSTER_AUTO)) PersonsUi.image(a, p.hub, poster, iv, Math.max(w, h), () -> iv.setImageDrawable(null));
        FrameLayout disc = new FrameLayout(a);
        disc.setBackground(Ui.round(0x99000000, 0, 24));
        TextView play = Ui.icon(a, Ui.I_PLAY, 22, 0xffffffff);
        play.setGravity(Gravity.CENTER);
        play.setPadding(Ui.dp(3), 0, 0, 0);
        disc.addView(play, new FrameLayout.LayoutParams(-1, -1));
        android.widget.ProgressBar spin = new android.widget.ProgressBar(a);
        spin.setIndeterminate(true);
        spin.setIndeterminateTintList(android.content.res.ColorStateList.valueOf(0xffffffff));
        spin.setVisibility(View.GONE);
        disc.addView(spin, new FrameLayout.LayoutParams(Ui.dp(30), Ui.dp(30), Gravity.CENTER));
        box.addView(disc, new FrameLayout.LayoutParams(Ui.dp(48), Ui.dp(48), Gravity.CENTER));
        double dur = f.optDouble("duration", 0);
        String meta = dur > 0 ? PersonsUi.duration(dur) : PersonsUi.bytes(size);
        if (!meta.isEmpty()) {
            TextView badge = Ui.text(a, meta, 11.5f, 0xfff0f0f0);
            badge.setBackground(Ui.round(0x99000000, 0, 6));
            badge.setPadding(Ui.dp(6), Ui.dp(1), Ui.dp(6), Ui.dp(2));
            box.addView(badge, Ui.margins(new FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM | Gravity.START), 6, 0, 0, 6));
        }
        box.setContentDescription("Video " + name + (dur > 0 ? ", " + PersonsUi.duration(dur) : "") + ": play");
        box.setOnClickListener(v -> {
            if (spin.getVisibility() == View.VISIBLE) return;
            spin.setVisibility(View.VISIBLE);
            play.setVisibility(View.INVISIBLE);
            Runnable done = () -> { spin.setVisibility(View.GONE); play.setVisibility(View.VISIBLE); };
            Ui.pool.execute(() -> {
                String path = null, why = null;
                try {
                    // the PC downloads it first (a large one from WhatsApp takes a while)
                    JSONObject r = p.hub.call("GET", url + (url.contains("?") ? "&" : "?") + "path=1", null, 180_000);
                    path = PersonsUi.s(r, "path");
                } catch (Exception e) { why = Hub.why(e); }
                String got = path, err = why;
                Ui.main.post(() -> {
                    if (a.isDestroyed()) return;
                    done.run();
                    if (got == null || got.isEmpty()) { Ui.toast(a, err != null ? err : "Couldn't download that video"); return; }
                    // the picture's poster again, now that the video is on the PC
                    if (iv.getDrawable() == null && !poster.isEmpty()) PersonsUi.image(a, p.hub, poster, iv, Math.max(w, h), null);
                    String q = android.net.Uri.encode(got);
                    List<Images.Src> one = new ArrayList<>();
                    one.add(new Images.Src(p.hub, "/v1/media?path=" + q, name, "/v1/image?path=" + q + "&max=2048"));
                    Images.view(a, one, 0);
                });
            });
        });
        return box;
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

    /** The Person AI's note (mine, right) or answer (left), apart from the conversation (PersonsAiCard, also the site
     *  request pane's). */
    private View aiView(JSONObject e) {
        return PersonsAiCard.view(a, e, newestAi, maxW(), aiHost);
    }

    private final PersonsAiCard.Host aiHost = new PersonsAiCard.Host() {
        @Override public void useReply(String text) { PersonsChat.this.useReply(text); }
        @Override public void menu(String text, String use, boolean mine) { aiMenu(text, use, mine); }
        @Override public void rerender() { dropAi = true; render(); }
    };

    /** A draft into the composer, to send to the person. */
    private void useReply(String text) {
        setMode(false);
        composer();
        edit.setText(text);
        edit.setSelection(edit.length());
        edit.requestFocus();
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
            b.addView(tv, textWidth(tv, text, maxW() - Ui.dp(24)));
        }
        if (n > 0) b.addView(Ui.text(a, n == 1 ? "1 attachment" : n + " attachments", 13, Ui.G700));
        // WhatsApp's: a clock while it goes; not sent: red, a tap sends it again, a long press drops it
        String err = PersonsUi.s(o, "error");
        // not sent: why (Discord's "not friends, no shared server…"), then Tap to retry
        boolean why = !err.isEmpty() && !"not sent".equalsIgnoreCase(err);
        TextView st = err.isEmpty() ? ticks("pending") : Ui.text(a, "⚠ " + (why ? err : "Not sent") + " · Tap to retry", 11.5f, Ui.RED);
        if (why) { st.setMaxWidth(maxW() - Ui.dp(24)); st.setGravity(Gravity.END); }
        b.addView(st, Ui.margins(endWrap(), 0, 2, 0, 0));
        if (!err.isEmpty()) {
            b.setBackground(Ui.round(Ui.G100, Ui.RED, 18));
            b.setOnClickListener(v -> retry(o));
            b.setOnLongClickListener(v -> { pending.remove(o); render(); return true; });
            b.setContentDescription("Not sent: " + err + ". Tap to retry, long-press to remove.");
        }
        wrap.addView(b, Ui.wrap());
        return wrap;
    }

    // ---- menus ----

    /** A message's long-press menu (Person Hub's, as the PC's menus.ts): Reply · Forward to AI · Open Site Request |
     *  Copy text | Mark as unread. Open Site Request where the person panel has site requests (SpokPay people and store
     *  owners, SpokPay connected), from the chat's `siteRequests`. */
    private void menu(JSONObject m) {
        String text = PersonsUi.s(m, "text");
        String id = PersonsUi.s(m, "id");
        boolean mine = m.optBoolean("fromMe");
        boolean drafting = false;
        for (JSONObject q : PersonsHome.objs(PersonsUi.arr(data, "proposing")))
            if (id.equals(PersonsUi.s(q, "messageId")) && PersonsUi.s(q, "error").isEmpty()) drafting = true;
        List<Ds.Item> items = new ArrayList<>();
        if (blockedNote() == null) items.add(Ds.item(Ui.I_REPLY, "Reply", () -> {
            replyTo = m;
            setMode(false);
            composer();
            edit.requestFocus();
            showKeyboard();
        }));
        if (aiOn()) items.add(Ds.item(Ui.I_SPARKLES, "Forward to AI", () -> {
            forwarded = m;
            setMode(true);
            typingOff();
            composer();
            edit.requestFocus();
            showKeyboard();
        }));
        if (data != null && data.optBoolean("siteRequests") && !drafting) items.add(Ds.item(Ui.I_FILE_PLUS, "Open Site Request", () -> siteRequest(id)));
        items.add(Ds.sep());
        if (!text.isEmpty()) items.add(Ds.item(Ui.I_COPY, "Copy text", () -> Ui.copy(a, text)));
        items.add(Ds.sep());
        if (!mine) items.add(Ds.item(Ui.I_MAIL_WARNING, "Mark as unread", () -> markUnread(id)));
        Ds.menu(a, items);
    }

    private void markUnread(String id) {
        String ac = acctId();
        if (ac == null || p.hub == null) return;
        holdUnread = true;
        JSONObject b = PersonsUi.put(new JSONObject(), "section", section);
        PersonsUi.put(b, "account", ac);
        PersonsUi.put(b, "messageId", id);
        String path = base() + "/unread";
        Ui.bg(a, () -> p.hub.call("POST", path, b), r -> Ui.toast(a, "Marked as unread"));
    }

    // ---- SpokPay site requests ----

    /** Open Site Request: SpokPay's agent drafts it from this message on the PC; its card shows in the chat. */
    private void siteRequest(String messageId) {
        JSONObject b = PersonsUi.put(new JSONObject(), "section", section);
        PersonsUi.put(b, "account", acctId());
        PersonsUi.put(b, "messageId", messageId);
        String path = base() + "/site-request";
        Ui.bg(a, () -> p.hub.call("POST", path, b), r -> {
            if (r.has("error")) Ui.toast(a, r.optString("error"));
            load(false);
            pollCards();
        });
    }

    /** Asks the chat again every 4 s while a site request is being drafted or opened. */
    private void pollCards() {
        Ui.main.removeCallbacks(cardTick);
        Ui.main.postDelayed(cardTick, 4000);
    }

    private final Runnable cardTick = new Runnable() {
        @Override public void run() {
            if (closed || a.isDestroyed() || data == null) return;
            boolean busy = false;
            for (JSONObject q : PersonsHome.objs(PersonsUi.arr(data, "proposing"))) if (PersonsUi.s(q, "error").isEmpty()) busy = true;
            for (JSONObject q : PersonsHome.objs(PersonsUi.arr(data, "proposals"))) if ("opening".equals(PersonsUi.s(PersonsUi.obj(q, "state"), "kind"))) busy = true;
            if (!busy) return;
            load(false);
            Ui.main.postDelayed(this, 4000);
        }
    };

    /** A site request card (Headquarters' ProposalCard): proposed from a message, or the agent still drafting it. */
    private View siteCard(JSONObject o, boolean drafting) {
        LinearLayout wrap = Ui.col(a);
        wrap.setPadding(Ui.dp(12), Ui.dp(8), Ui.dp(24), 0);
        LinearLayout c = Ds.card(a);
        JSONObject st = PersonsUi.obj(o, "state");
        String kind = drafting ? (PersonsUi.s(o, "error").isEmpty() ? "drafting" : "failed") : PersonsUi.s(st, "kind");
        LinearLayout h = Ui.row(a);
        h.setGravity(Gravity.CENTER_VERTICAL);
        h.addView(Ui.icon(a, Ui.I_FILE_PLUS, 12, Ui.G600));
        String label = drafting ? ("failed".equals(kind) ? "SITE REQUEST · NOT DRAFTED" : "SITE REQUEST · DRAFTING…")
                : "opened".equals(kind) ? "SITE REQUEST · OPENED" : "opening".equals(kind) ? "SITE REQUEST · OPENING…" : "failed".equals(kind) ? "SITE REQUEST · NOT OPENED" : "SITE REQUEST · PROPOSED";
        TextView lt = Ui.bold(a, label, 11.5f, Ui.G600);
        lt.setLetterSpacing(0.06f);
        h.addView(lt, Ui.margins(Ui.wrap(), 6, 0, 0, 0));
        c.addView(h);
        if (drafting) {
            String err = PersonsUi.s(o, "error");
            c.addView(Ui.text(a, err.isEmpty() ? "The SpokPay agent is drafting a site request…" : "The SpokPay agent couldn't draft it: " + err, 14, err.isEmpty() ? Ui.G700 : Ui.RED), Ui.margins(Ui.fill(), 0, 6, 0, 0));
            String mid = PersonsUi.s(o, "messageId");
            LinearLayout acts = Ui.row(a);
            acts.addView(Ds.chip(a, "Use the message", !err.isEmpty(), v -> cardCall("POST", "/v1/persons/proposing/" + PersonsUi.enc(mid) + "/local", PersonsUi.put(PersonsUi.put(PersonsUi.put(new JSONObject(), "personId", pid), "section", section), "account", acctId()))));
            acts.addView(Ds.chip(a, err.isEmpty() ? "Cancel" : "Dismiss", false, v -> cardCall("DELETE", "/v1/persons/proposing/" + PersonsUi.enc(mid), null)), Ui.margins(Ui.wrap(), 8, 0, 0, 0));
            c.addView(acts, Ui.margins(Ui.fill(), 0, 10, 0, 0));
        } else {
            String id = PersonsUi.s(o, "id");
            c.addView(Ui.bold(a, PersonsUi.s(o, "subject"), 16, Ui.FG), Ui.margins(Ui.fill(), 0, 6, 0, 0));
            JSONObject store = PersonsUi.obj(o, "store");
            int imgs = o.optInt("images");
            String sub = (store == null ? "No store picked" : PersonsUi.s(store, "name").isEmpty() ? PersonsUi.s(store, "slug") : PersonsUi.s(store, "name"))
                    + " · " + category(PersonsUi.s(o, "category")) + (imgs > 0 ? " · " + imgs + (imgs == 1 ? " image" : " images") : "");
            c.addView(Ui.text(a, sub, 13, Ui.G700), Ui.margins(Ui.fill(), 0, 2, 0, 0));
            String det = PersonsUi.s(o, "details");
            if (!det.isEmpty()) c.addView(Ui.text(a, det, 14, Ui.FG), Ui.margins(Ui.fill(), 0, 6, 0, 0));
            String why = PersonsUi.s(o, "why");
            c.addView(Ui.text(a, PersonsUi.s(o, "from") + (why.isEmpty() ? "" : ": " + why), 12.5f, Ui.G600), Ui.margins(Ui.fill(), 0, 6, 0, 0));
            String note = "opened".equals(kind) ? "Opened as " + PersonsUi.s(st, "ref") : "failed".equals(kind) ? "Not opened: " + PersonsUi.s(st, "reason") : "opening".equals(kind) ? "Opening…" : store == null ? "Pick the store on the PC (Edit) before opening it." : "";
            if (!note.isEmpty()) c.addView(Ui.text(a, note, 13, "opened".equals(kind) ? PersonsUi.tone("green") : "failed".equals(kind) ? Ui.RED : Ui.G700), Ui.margins(Ui.fill(), 0, 6, 0, 0));
            if (!"opened".equals(kind) && !"opening".equals(kind)) {
                LinearLayout acts = Ui.row(a);
                acts.addView(Ds.chip(a, "failed".equals(kind) ? "Try again" : "Open site request", true, v -> {
                    if (store == null) { Ui.toast(a, "Pick the store on the PC first"); return; }
                    cardCall("POST", "/v1/persons/proposal/" + PersonsUi.enc(id) + "/open", new JSONObject());
                }));
                acts.addView(Ds.chip(a, "Discard", false, v -> cardCall("DELETE", "/v1/persons/proposal/" + PersonsUi.enc(id), null)), Ui.margins(Ui.wrap(), 8, 0, 0, 0));
                c.addView(acts, Ui.margins(Ui.fill(), 0, 10, 0, 0));
            }
        }
        wrap.addView(c, new LinearLayout.LayoutParams(maxW() + Ui.dp(24), LinearLayout.LayoutParams.WRAP_CONTENT));
        return wrap;
    }

    private static String category(String c) {
        switch (c) {
            case "catalog": return "Catalog";
            case "delivery": return "Delivery";
            case "dashboard": return "Dashboard";
            case "other": return "Other";
            default: return "Website";
        }
    }

    private void cardCall(String method, String path, JSONObject body) {
        if (p.hub == null) return;
        Ui.bg(a, () -> p.hub.call(method, path, body, 90_000), r -> {
            if (r.has("error")) Ui.toast(a, r.optString("error"));
            JSONObject st = PersonsUi.obj(r, "state");
            if ("opened".equals(PersonsUi.s(st, "kind"))) Ui.toast(a, "Site request " + PersonsUi.s(st, "ref") + " opened");
            load(false);
            pollCards();
        });
    }

    private void aiMenu(String text, String use, boolean mine) {
        List<Ds.Item> items = new ArrayList<>();
        if (!mine && acctId() != null) items.add(Ds.item(Ui.I_STEER, "Use as reply", () -> useReply(use)));
        items.add(Ds.sep());
        if (!text.isEmpty()) items.add(Ds.item(Ui.I_COPY, "Copy text", () -> Ui.copy(a, text)));
        Ds.menu(a, items);
    }

    /** The composer writes to the person or to their AI (Person Hub's switch); the field keeps the focus. */
    private void switchTo(boolean ai) {
        if (ai == toAi) return;
        setMode(ai);
        if (toAi) typingOff();
        composer();
        edit.requestFocus();
    }

    /** A line over the field: the message replied to, or the one forwarded to the AI, with its ×. */
    private LinearLayout quoteRow(String glyph, TextView text, String closeLabel, Runnable close, boolean dashed) {
        LinearLayout r = Ui.row(a);
        r.setGravity(Gravity.CENTER_VERTICAL);
        r.setPadding(Ui.dp(10), Ui.dp(2), Ui.dp(2), Ui.dp(2));
        GradientDrawable g = Ui.round(Ui.BG, dashed ? Ui.G500 : Ui.LINE, 10);
        if (dashed) g.setStroke(Ui.dp(1), Ui.G500, Ui.dp(4), Ui.dp(3));
        r.setBackground(g);
        r.addView(Ui.icon(a, glyph, 14, Ui.G700), new LinearLayout.LayoutParams(Ui.dp(16), Ui.dp(16)));
        r.addView(text, Ui.margins(Ui.weight(), 8, 0, 0, 0));
        TextView x = Ui.icon(a, Ui.I_X, 16, Ui.G700);
        x.setBackground(Ui.press(0, 0, 14));
        x.setOnClickListener(v -> close.run());
        x.setContentDescription(closeLabel);
        r.addView(x, new LinearLayout.LayoutParams(Ui.dp(32), Ui.dp(32)));
        return r;
    }

    /** One side of the "To" switch: a glyph and a label in a pill. */
    private LinearLayout segment(String glyph, View.OnClickListener on) {
        LinearLayout s = Ui.row(a);
        s.setGravity(Gravity.CENTER_VERTICAL);
        s.setPadding(Ui.dp(10), 0, Ui.dp(12), 0);
        s.setMinimumHeight(Ui.dp(30));
        s.addView(Ui.icon(a, glyph, 13, Ui.G700), new LinearLayout.LayoutParams(Ui.dp(15), Ui.dp(15)));
        s.addView(Ui.subtitle(Ui.bold(a, "", 13, Ui.G700)), Ui.margins(Ui.wrap(), 5, 0, 0, 0));
        s.setOnClickListener(on);
        return s;
    }

    private void paintSegment(LinearLayout s, String label, boolean on) {
        s.setBackground(on ? Ui.round(Ui.FG, 0, 15) : Ui.press(0, 0, 15));
        ((TextView) s.getChildAt(0)).setTextColor(on ? Ui.BG : Ui.G700);
        TextView t = (TextView) s.getChildAt(1);
        t.setText(label);
        t.setTextColor(on ? Ui.BG : Ui.G700);
        s.setContentDescription("To " + label + (on ? ", selected" : ""));
    }

    /** "Replying to <b>Name</b> text" / "Forwarding <b>Name</b> text". */
    private CharSequence quote(String lead, String name, String text) {
        SpannableStringBuilder b = new SpannableStringBuilder(lead.isEmpty() ? "" : lead + " ");
        int s0 = b.length();
        b.append(name);
        b.setSpan(new ForegroundColorSpan(Ui.FG), s0, b.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        b.setSpan(new android.text.style.StyleSpan(android.graphics.Typeface.BOLD), s0, b.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        if (!text.isEmpty()) b.append("  ").append(text.replace('\n', ' '));
        return b;
    }

    private boolean aiOn() { return data == null || data.optBoolean("aiOn", true); }

    /** Why the composer can't write to the person (null: it can), Person Hub's notes. */
    private String blockedNote() {
        if (data == null) return null;
        JSONObject ac = PersonsUi.obj(data, "account");
        String k = kind();
        String app = "gmail".equals(k) ? "Gmail" : "whatsapp".equals(k) ? "WhatsApp" : "instagram".equals(k) ? "Instagram" : "Discord";
        String what = "gmail".equals(k) ? "email address" : "whatsapp".equals(k) ? "WhatsApp number" : "instagram".equals(k) ? "Instagram account" : "Discord account";
        if (ac == null) return "No channel to talk to " + name() + " here: connect Discord, Gmail or WhatsApp on the PC, and give them that identifier.";
        if (PersonsUi.s(data, "peer").isEmpty()) return "Add their " + what + " on the PC (Edit) to message them here.";
        if (!ac.optBoolean("connected", true)) return "Sign in to " + app + " on the PC to message.";
        return null;
    }

    private void sendState() {
        boolean has = edit.getText().toString().trim().length() > 0;
        boolean can = toAi ? has || forwarded != null : blockedNote() == null && (has || !files.isEmpty());
        sendPill.setEnabled(can);
        sendPill.setAlpha(can ? 1f : 0.45f);
        sendPill.setBackground(Ui.round(can ? Ui.INK : Ui.G300, 0, 18));
        sendRound.setEnabled(can);
        sendRound.setAlpha(can ? 1f : 0.45f);
    }

    private void showKeyboard() {
        android.view.inputmethod.InputMethodManager im = (android.view.inputmethod.InputMethodManager) a.getSystemService(Activity.INPUT_METHOD_SERVICE);
        if (im != null) im.showSoftInput(edit, 0);
    }

    // ---- the composer ----

    private boolean needSubject() { return "gmail".equals(kind()) && msgs.isEmpty() && data != null; }

    private void composer() {
        String n = name();
        if (!aiOn()) toAi = false;
        String note = blockedNote();
        boolean blockedNow = !toAi && note != null;
        // who it goes to
        headMark.removeAllViews();
        if (toAi) {
            TextView mark = Ui.icon(a, Ui.I_SPARKLES, 11, Ui.BG);
            mark.setBackground(Ui.round(Ui.FG, 0, 10));
            headMark.addView(mark, new FrameLayout.LayoutParams(-1, -1));
            headText.setText("Note to the AI");
            headNote.setText("Never sent to " + n);
            headNote.setVisibility(View.VISIBLE);
        } else {
            JSONObject st = p.person(pid);
            JSONObject cp = PersonsUi.obj(data, "person");
            String av = PersonsUi.s(cp, "avatar");
            if (av.isEmpty()) av = PersonsUi.s(st, "avatar");
            headMark.addView(PersonsUi.avatar(a, p.hub, av, PersonsUi.s(st, "initials"), PersonsUi.color(PersonsUi.s(st, "color"), Ui.G500), 20, ""), new FrameLayout.LayoutParams(-1, -1));
            headText.setText(quote("To", n, ""));
            headNote.setVisibility(View.GONE);
        }
        headLine.setBackgroundColor(toAi ? PersonsUi.aiLine() : Ui.LINE);
        if (toAi) box.setBackground(dashed());
        else box.setBackground(Ui.round(Ui.CARD, Ui.LINE, 20));
        // the first email's subject, the reply or the forward, the photos
        subject.setVisibility(!toAi && note == null && needSubject() ? View.VISIBLE : View.GONE);
        if (!toAi && replyTo != null) {
            String rt = PersonsEmoji.plain(PersonsUi.s(replyTo, "text"));
            replyText.setText(quote("Replying to", replyTo.optBoolean("fromMe") ? "You" : n, rt.isEmpty() ? "📎 attachment" : rt));
            replyBox.setVisibility(View.VISIBLE);
        } else replyBox.setVisibility(View.GONE);
        if (toAi && forwarded != null) {
            String ft = PersonsUi.s(forwarded, "text");
            fwdText.setText(quote("Forwarding", forwarded.optBoolean("fromMe") ? "You" : n, ft.isEmpty() ? "Message" : ft));
            fwdBox.setVisibility(View.VISIBLE);
        } else fwdBox.setVisibility(View.GONE);
        drafts.removeAllViews();
        for (int i = 0; i < files.size(); i++) drafts.addView(draftChip(i), Ui.margins(Ui.wrap(), 0, 0, 6, 0));
        draftsScroll.setVisibility(!toAi && !files.isEmpty() ? View.VISIBLE : View.GONE);
        // the field, or why it can't write to them
        blocked.setText(blockedNow ? note : "");
        blocked.setVisibility(blockedNow ? View.VISIBLE : View.GONE);
        edit.setVisibility(blockedNow ? View.GONE : View.VISIBLE);
        String k = kind();
        edit.setHint(toAi ? (forwarded != null ? "Ask about this message (empty: \u201cWhat should I reply to this?\u201d)" : "Tell the AI what to do about " + n)
                : "gmail".equals(k) ? "Email " + n + "…" : "Message " + n + (k.isEmpty() ? "" : " on " + PersonsUi.kindLabel(k)));
        // attach (photos to the person), the switch, send
        attach.setVisibility(toAi ? View.GONE : View.VISIBLE);
        attach.setEnabled(!blockedNow && a instanceof Base);
        attach.setAlpha(!blockedNow ? 1f : 0.45f);
        boolean sw = aiOn();
        toLabel.setVisibility(sw ? View.VISIBLE : View.GONE);
        seg.setVisibility(sw ? View.VISIBLE : View.INVISIBLE);
        seg.setBackground(Ui.round(Ui.BG, Ui.LINE, 17));
        paintSegment(segAi, "AI", toAi);
        paintSegment(segPerson, n, !toAi);
        sendPill.setVisibility(toAi ? View.GONE : View.VISIBLE);
        sendRound.setVisibility(toAi ? View.VISIBLE : View.GONE);
        GradientDrawable ring = Ui.round(Ui.CARD, Ui.LINE, 18);
        sendRound.setBackground(ring);
        sendState();
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

    /** Videos the phone sends: WhatsApp's own limit. */
    private static final long MAX_VIDEO = 100L << 20;

    /** A video from the picker: sent ahead to the PC (POST /v1/upload, streamed from the picker's file), then goes
     *  with the message as {name, type, upload}; its chip shows its first frame (MediaMetadataRetriever). */
    private void addVideo(Uri uri, String type) {
        if (files.size() >= 6) { Ui.toast(a, "Up to 6 files at once"); return; }
        Ui.toast(a, "Getting the video ready…");
        Ui.bg(a, () -> {
            String name = "video.mp4";
            long len = -1;
            try (android.database.Cursor c = a.getContentResolver().query(uri, new String[]{android.provider.OpenableColumns.DISPLAY_NAME, android.provider.OpenableColumns.SIZE}, null, null, null)) {
                if (c != null && c.moveToFirst()) {
                    if (c.getString(0) != null) name = c.getString(0);
                    if (!c.isNull(1)) len = c.getLong(1);
                }
            } catch (RuntimeException ignored) { }
            if (len <= 0) throw new java.io.IOException("Couldn't read that video");
            if (len > MAX_VIDEO) throw new java.io.IOException("Videos up to 100 MB");
            Bitmap thumb = null;
            android.media.MediaMetadataRetriever r = new android.media.MediaMetadataRetriever();
            try {
                r.setDataSource(a, uri);
                Bitmap b = r.getFrameAtTime(0);
                if (b != null) thumb = Bitmap.createScaledBitmap(b, Math.max(1, b.getWidth() * 96 / Math.max(b.getWidth(), b.getHeight())),
                        Math.max(1, b.getHeight() * 96 / Math.max(b.getWidth(), b.getHeight())), true);
            } catch (RuntimeException ignored) {
            } finally {
                try { r.release(); } catch (Exception ignored) { }
            }
            JSONObject up;
            try (java.io.InputStream in = a.getContentResolver().openInputStream(uri)) {
                if (in == null) throw new java.io.IOException("Couldn't read that video");
                up = p.hub.upload(name, null, in, len);
            }
            String id = PersonsUi.s(up, "id");
            if (id.isEmpty()) throw new java.io.IOException("The PC didn't take the video");
            JSONObject f = new JSONObject();
            PersonsUi.put(f, "name", name);
            PersonsUi.put(f, "type", type);
            PersonsUi.put(f, "upload", id);
            return new Object[]{f, thumb != null ? thumb : Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)};
        }, r -> {
            if (closed) return;
            files.add((JSONObject) r[0]);
            thumbs.add((Bitmap) r[1]);
            composer();
        });
    }

    /** A photo from the picker: scaled to 1600 px and sent as JPEG (bodies stay small); a video goes as it is. */
    private void addPhoto(Uri uri) {
        String type = a.getContentResolver().getType(uri);
        if (type != null && type.startsWith("video/")) { addVideo(uri, type); return; }
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
        if (ac == null || data == null || blockedNote() != null) return;
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
        PersonsUi.put(pend, "body", b);
        PersonsUi.put(pend, "subj", subj);
        deliver(pend);
    }

    /** Sends a message on its way (`pending`): once it's in, the chat is read again (its bubble takes the clock's
     *  place, with the channel's ticks); not sent, it turns red with Tap to retry. */
    private void deliver(JSONObject pend) {
        JSONObject b = pend.optJSONObject("body");
        boolean subj = pend.optBoolean("subj");
        if (b == null) return;
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

    private void retry(JSONObject pend) {
        if (pend.optJSONObject("body") == null) return;
        pend.remove("error");
        toBottom = true;
        render();
        deliver(pend);
    }

    /** "Ask AI": the note goes to the Person AI of this person and section; its answer shows in
     *  `ai`, so the chat is asked again every 3 s for a while. */
    private void askAi(String text) {
        JSONObject fwd = forwarded;
        if (text.isEmpty() && fwd == null) return;
        JSONObject b = PersonsUi.put(new JSONObject(), "section", section);
        PersonsUi.put(b, "text", text);
        if (acctId() != null) PersonsUi.put(b, "account", acctId());
        if (fwd != null) PersonsUi.put(b, "forward", PersonsUi.s(fwd, "id"));
        edit.setText("");
        forwarded = null;
        composer();
        String path = base() + "/ai";
        Ui.bg(a, () -> p.hub.call("POST", path, b, 60_000), r -> {
            if (!r.optBoolean("ok", true) || r.has("error")) { Ui.toast(a, "AI: " + r.optString("error", "not sent")); edit.setText(text); forwarded = fwd; composer(); return; }
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
