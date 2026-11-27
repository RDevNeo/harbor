package dev.harbor.app;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.text.Editable;
import android.text.InputType;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.TextWatcher;
import android.text.style.ForegroundColorSpan;
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
import java.util.List;

/** A SpokPay site request, full screen (SpokPay's admin request page, as the PC's Persons tab draws it): the header
 *  (the store's square logo, the subject, the status pill, "Store · SR-215" whose tap copies the link, the status
 *  chip with SpokPay's moves; Complete and Close ask first), the Request brief card, the timeline (events as centered
 *  lines, the author and time over each run's first bubble, the store's on the left, SpokPay's dark ones on the right)
 *  and the composer, the person chats' own (PersonsChat): "To <avatar> <owner>", up to 5 photos, the field "Message
 *  <owner> on SpokPay", attach / "To: AI | <owner>" / Send (to the store as SpokPay; the AI gets a note about the
 *  request in its Person AI chat on the PC). A long-press on a message: PersonsChat's menu as far as SpokPay's admin
 *  API goes (Quote, Forward to AI, Copy text, Open attachment). Read from the PC
 *  (GET /v1/persons/site-request/{ref}: opening it marks what the store wrote seen), again every 30 s while open and
 *  when its row in the list moves. Edit isn't there (SpokPay's API has no route). */
final class PersonsSr {
    final PersonsState p;
    final Activity a;
    final String ref;
    final LinearLayout view;
    private final FrameLayout headBox;
    private final ScrollView sv;
    private final LinearLayout content, bottom, thumbs;
    private final EditText edit;
    private final TextView finished, blocked, headText, headNote, toLabel, attach;
    private final LinearLayout box, head, seg, segAi, segPerson, sendPill;
    private final FrameLayout headMark, sendRound;
    private final View headLine;
    private JSONObject pane;
    private String error;
    /** The composer writes to the AI (PersonsChat's "To: AI | <person>"), each side with its own words. */
    private boolean closed, sending, moving, toBottom = true, toAi;
    private String otherDraft = "";
    /** A message forwarded to the AI (its menu's Forward to AI): quoted over the AI's field. */
    private JSONObject forwarded;
    private LinearLayout fwdBox;
    private TextView fwdText;
    private long rowAt;
    /** Photos about to go: {name, type, data (base64)}, with their thumbnails. */
    private final List<JSONObject> files = new ArrayList<>();
    private final List<Bitmap> thumbBits = new ArrayList<>();

    PersonsSr(PersonsState p, String ref) {
        this.p = p;
        this.ref = ref;
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
        content.setPadding(Ui.dp(12), Ui.dp(12), Ui.dp(12), Ui.dp(12));
        sv.addView(content, new FrameLayout.LayoutParams(-1, -2));
        view.addView(sv, new LinearLayout.LayoutParams(-1, 0, 1));

        bottom = Ui.col(a);
        finished = Ui.text(a, "", 14, Ui.G700);
        finished.setPadding(Ui.dp(16), Ui.dp(12), Ui.dp(16), Ui.dp(14));
        bottom.addView(finished, Ui.fill());
        // The composer (PersonsChat's): who it goes to on top ("To <owner>", or "Note to the AI · never sent to them"
        // in the AI's tint), the photos, the field (or why the key can't reply), and attach / "To: AI | <owner>" / Send.
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
        HorizontalScrollView hs = new HorizontalScrollView(a);
        hs.setHorizontalScrollBarEnabled(false);
        thumbs = Ui.row(a);
        hs.addView(thumbs);
        body.addView(hs, Ui.margins(Ui.fill(), 0, 0, 0, 8));
        fwdBox = Ui.row(a);
        fwdBox.setGravity(Gravity.CENTER_VERTICAL);
        fwdBox.setPadding(Ui.dp(10), Ui.dp(2), Ui.dp(2), Ui.dp(2));
        GradientDrawable fg = Ui.round(Ui.BG, Ui.G500, 10);
        fg.setStroke(Ui.dp(1), Ui.G500, Ui.dp(4), Ui.dp(3));
        fwdBox.setBackground(fg);
        fwdBox.addView(Ui.icon(a, Ui.I_FORWARD, 14, Ui.G700), new LinearLayout.LayoutParams(Ui.dp(16), Ui.dp(16)));
        fwdText = Ui.subtitle(Ui.text(a, "", 13, Ui.G700));
        fwdBox.addView(fwdText, Ui.margins(Ui.weight(), 8, 0, 0, 0));
        TextView fx = Ui.icon(a, Ui.I_X, 16, Ui.G700);
        fx.setBackground(Ui.press(0, 0, 14));
        fx.setOnClickListener(v -> { forwarded = null; composer(); });
        fx.setContentDescription("Cancel forward");
        fwdBox.addView(fx, new LinearLayout.LayoutParams(Ui.dp(32), Ui.dp(32)));
        body.addView(fwdBox, Ui.margins(Ui.fill(), 0, 0, 0, 8));
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
            @Override public void afterTextChanged(Editable s) { sendState(); }
        });
        body.addView(edit, Ui.fill());
        LinearLayout row = Ui.row(a);
        row.setGravity(Gravity.CENTER_VERTICAL);
        attach = Ui.iconButton(a, Ui.I_CLIP, Ui.G700, v -> { if (a instanceof Base) ((Base) a).pickImage(this::addPhoto); });
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
        row.addView(new View(a), new LinearLayout.LayoutParams(Ui.dp(8), 1));
        sendPill = Ui.row(a);
        sendPill.setGravity(Gravity.CENTER);
        sendPill.setPadding(Ui.dp(14), 0, Ui.dp(12), 0);
        sendPill.addView(Ui.bold(a, "Send", 14, Ui.ON_INK));
        sendPill.addView(Ui.icon(a, Ui.I_UP, 15, Ui.ON_INK), Ui.margins(Ui.wrap(), 5, 0, 0, 0));
        sendPill.setOnClickListener(v -> send());
        sendPill.setContentDescription("Send as SpokPay");
        row.addView(sendPill, new LinearLayout.LayoutParams(-2, Ui.dp(36)));
        sendRound = Ui.roundButton(a, Ui.I_UP, Ui.CARD, Ui.FG, 36, v -> send());
        sendRound.setContentDescription("Send to the AI");
        row.addView(sendRound);
        body.addView(row, Ui.fill());
        bottom.addView(box, Ui.margins(Ui.fill(), 10, 4, 10, 10));
        view.addView(bottom, Ui.fill());

        JSONObject r = row();
        rowAt = r == null ? 0 : r.optLong("at");
        render();
        load();
        Ui.main.postDelayed(tick, 30_000);
    }

    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (closed || a.isDestroyed()) return;
            load();
            Ui.main.postDelayed(this, 30_000);
        }
    };

    void close() {
        closed = true;
        Ui.main.removeCallbacks(tick);
        Ui.main.removeCallbacks(aiTick);
    }

    /** Its row in the state's Site requests list (subject, store, icon until the pane is read). */
    private JSONObject row() {
        JSONObject sr = p.st == null ? null : p.st.optJSONObject("siteRequests");
        JSONArray rows = PersonsUi.arr(sr, "rows");
        for (int i = 0; i < rows.length(); i++) {
            JSONObject x = rows.optJSONObject(i);
            if (x != null && ref.equals(PersonsUi.s(x, "ref"))) return x;
        }
        return null;
    }

    /** A new state: the request is read again when its row moved (a message, a move). */
    void stateChanged() {
        JSONObject r = row();
        long at = r == null ? 0 : r.optLong("at");
        if (at != rowAt) {
            rowAt = at;
            load();
        }
    }

    private String path() { return "/v1/persons/site-request/" + PersonsUi.enc(ref); }

    private void load() {
        Ui.pool.execute(() -> {
            JSONObject got = null;
            String why = null;
            try { got = p.hub.call("GET", path(), null, 30_000).optJSONObject("pane"); } catch (Exception e) { why = Hub.why(e); }
            JSONObject g = got;
            String w = why;
            Ui.main.post(() -> {
                if (closed || a.isDestroyed()) return;
                if (g != null) { pane = g; error = null; } else error = w;
                render();
                if (g != null && aiBusy()) follow(0);
            });
        });
    }

    // ---- the request's turns with the Person AI (PersonsAiCard, as person chats draw them) ----

    /** Until when the newest note is followed while it has no answer yet. */
    private long aiUntil;
    private boolean aiFollowing;

    /** A note queued, or an answer being written. */
    private boolean aiBusy() {
        JSONArray ai = PersonsUi.arr(pane, "ai");
        for (int i = 0; i < ai.length(); i++) {
            JSONObject e = ai.optJSONObject(i);
            if (e != null && (e.optBoolean("streaming") || e.optBoolean("queued"))) return true;
        }
        return false;
    }

    /** Asks for the request's AI turns (GET …/ai, no SpokPay read) every 2 s while the AI works on one of its notes. */
    private void follow(long until) {
        aiUntil = Math.max(aiUntil, until);
        if (aiFollowing) return;
        aiFollowing = true;
        Ui.main.postDelayed(aiTick, 2000);
    }

    private final Runnable aiTick = new Runnable() {
        @Override public void run() {
            if (closed || a.isDestroyed()) { aiFollowing = false; return; }
            Ui.pool.execute(() -> {
                JSONObject got = null;
                try { got = p.hub.call("GET", path() + "/ai", null, 30_000); } catch (Exception ignored) { }
                JSONObject g = got;
                Ui.main.post(() -> {
                    if (closed || a.isDestroyed()) { aiFollowing = false; return; }
                    JSONArray ai = g == null ? null : g.optJSONArray("ai");
                    if (ai != null && pane != null && !ai.toString().equals(PersonsUi.arr(pane, "ai").toString())) {
                        PersonsUi.put(pane, "ai", ai);
                        if (g.has("aiChat")) PersonsUi.put(pane, "aiChat", g.opt("aiChat"));
                        // still at the end: the answer stays in sight as it grows
                        toBottom = sv.getScrollY() + sv.getHeight() >= content.getHeight() - Ui.dp(80);
                        render();
                    }
                    JSONArray now = PersonsUi.arr(pane, "ai");
                    JSONObject last = now.length() == 0 ? null : now.optJSONObject(now.length() - 1);
                    boolean answered = last != null && "assistant".equals(PersonsUi.s(last, "role"));
                    if (aiBusy() || (System.currentTimeMillis() < aiUntil && !answered)) Ui.main.postDelayed(aiTick, 2000);
                    else aiFollowing = false;
                });
            });
        }
    };

    private final PersonsAiCard.Host aiHost = new PersonsAiCard.Host() {
        @Override public void useReply(String text) {
            // into the composer to the store, as SpokPay
            switchTo(false);
            edit.setText(text);
            edit.setSelection(edit.length());
            edit.requestFocus();
        }
        @Override public void menu(String text, String use, boolean mine) {
            List<Ds.Item> items = new ArrayList<>();
            boolean canSend = pane != null && !pane.optBoolean("finished") && PersonsUi.s(pane, "writeBlocked").isEmpty();
            if (!mine && canSend) items.add(Ds.item(Ui.I_STEER, "Use as reply", () -> useReply(use)));
            items.add(Ds.sep());
            if (!text.isEmpty()) items.add(Ds.item(Ui.I_COPY, "Copy text", () -> Ui.copy(a, text)));
            Ds.menu(a, items);
        }
        @Override public void rerender() { render(); }
    };

    // ---- drawing ----

    private void render() {
        header();
        content.removeAllViews();
        if (pane == null) {
            if (error != null) {
                LinearLayout c = Ui.col(a);
                c.setGravity(Gravity.CENTER_HORIZONTAL);
                c.addView(Ui.bold(a, "Could not load " + ref, 15, Ui.FG));
                TextView t = Ui.text(a, error, 13, Ui.G700);
                t.setGravity(Gravity.CENTER);
                c.addView(t, Ui.margins(Ui.wrap(), 0, 6, 0, 10));
                c.addView(Ui.button(a, "Try again", false, v -> load()));
                content.addView(Ds.centred(a, c), new LinearLayout.LayoutParams(-1, -1));
            } else content.addView(Ds.empty(a, "Reading " + ref + "…"));
            bottom.setVisibility(View.GONE);
            return;
        }
        String note = PersonsUi.s(pane, "note");
        if (!note.isEmpty()) {
            TextView n = Ui.text(a, note, 12, Ui.AMBER);
            n.setGravity(Gravity.CENTER);
            content.addView(n, Ui.margins(Ui.fill(), 0, 0, 0, 8));
        }
        content.addView(brief(), Ui.fill());
        if (pane.optBoolean("hasMore")) {
            TextView m = Ui.text(a, "Older messages are on spokpay.com.", 12, Ui.G700);
            m.setGravity(Gravity.CENTER);
            content.addView(m, Ui.margins(Ui.fill(), 0, 6, 0, 0));
        }
        // the request's events and messages with its own turns with the Person AI, each where it was sent (a request's
        // line first when they tie): the person chats' AI card
        List<Object[]> lines = new ArrayList<>();
        JSONArray items = PersonsUi.arr(pane, "items");
        for (int i = 0; i < items.length(); i++) {
            JSONObject it = items.optJSONObject(i);
            if (it != null) lines.add(new Object[]{it.optLong("at"), lines.size(), it, false});
        }
        JSONArray ai = PersonsUi.arr(pane, "ai");
        String newestAi = "";
        for (int i = 0; i < ai.length(); i++) {
            JSONObject e = ai.optJSONObject(i);
            if (e == null) continue;
            if (!"user".equals(PersonsUi.s(e, "role"))) newestAi = PersonsUi.s(e, "id");
            lines.add(new Object[]{PersonsUi.ms(PersonsUi.s(e, "at")), lines.size(), e, true});
        }
        java.util.Collections.sort(lines, (x, y) -> x[0].equals(y[0]) ? Integer.compare((Integer) x[1], (Integer) y[1]) : Long.compare((Long) x[0], (Long) y[0]));
        int maxW = (int) (a.getResources().getDisplayMetrics().widthPixels * 0.78f);
        for (Object[] l : lines) {
            JSONObject it = (JSONObject) l[2];
            if ((Boolean) l[3]) content.addView(PersonsAiCard.view(a, it, newestAi, maxW, aiHost), Ui.fill());
            else if ("event".equals(PersonsUi.s(it, "kind"))) {
                TextView e = Ui.text(a, PersonsUi.s(it, "text"), 12, Ui.G700);
                e.setGravity(Gravity.CENTER);
                content.addView(e, Ui.margins(Ui.fill(), 0, 8, 0, 4));
            } else content.addView(line(it), Ui.fill());
        }
        composer();
        if (toBottom) {
            toBottom = false;
            sv.post(() -> sv.fullScroll(View.FOCUS_DOWN));
        }
    }

    /** ThreadHeader: back, the store's logo, the subject and the status pill, "Store · SR-215" (copies the link), the
     *  status chip (SpokPay's moves). */
    private void header() {
        headBox.removeAllViews();
        JSONObject r = row();
        LinearLayout h = Ui.row(a);
        h.setGravity(Gravity.CENTER_VERTICAL);
        // The shared top bar's frame (Ds.TopBar): the side-panel button, the store's square, the subject and its line.
        h.setPadding(Ui.dp(4), Ui.dp(6), Ui.dp(6), Ui.dp(6));
        h.setMinimumHeight(Ui.dp(Ds.BAR_H));
        View side = p.sideButton();
        h.addView(side, new LinearLayout.LayoutParams(Ui.dp(44), Ui.dp(44)));
        JSONObject face = pane != null ? pane : r;
        h.addView(logo(face == null ? "" : PersonsUi.s(face, "initials"), face == null ? "" : PersonsUi.s(face, "icon"), 32),
                Ui.margins(new LinearLayout.LayoutParams(Ui.dp(32), Ui.dp(32)), 4, 0, 8, 0));
        LinearLayout t = Ui.col(a);
        String subject = pane != null ? PersonsUi.s(pane, "subject") : r != null ? PersonsUi.s(r, "subject") : ref;
        TextView title = Ui.bold(a, subject.isEmpty() ? ref : subject, Ds.T_BAR, Ui.FG);
        title.setMaxLines(2);
        title.setEllipsize(android.text.TextUtils.TruncateAt.END);
        t.addView(title);
        LinearLayout meta = Ui.row(a);
        meta.setGravity(Gravity.CENTER_VERTICAL);
        if (pane != null) meta.addView(pill(PersonsUi.s(pane, "statusLabel"), PersonsUi.s(pane, "tone")), Ui.margins(Ui.wrap(), 0, 0, 8, 0));
        String store = pane != null ? PersonsUi.s(pane, "store") : r != null ? PersonsUi.s(r, "store") : "";
        TextView where = Ui.subtitle(Ui.text(a, (store.isEmpty() ? "" : store + " · ") + ref, Ds.T_BAR_SUB, Ui.G700));
        meta.addView(where, new LinearLayout.LayoutParams(0, -2, 1));
        meta.addView(Ui.icon(a, Ui.I_COPY, 12, Ui.G700), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(14), Ui.dp(14)), 4, 0, 0, 0));
        String url = pane != null ? PersonsUi.s(pane, "url") : r != null ? PersonsUi.s(r, "url") : "";
        meta.setOnClickListener(v -> { if (!url.isEmpty()) { Ui.copy(a, url); Ui.toast(a, "Link to " + ref + " copied"); } });
        meta.setContentDescription("Copy the request's link");
        t.addView(meta, Ui.margins(Ui.fill(), 0, 3, 0, 0));
        h.addView(t, Ui.weight());
        if (pane != null) {
            JSONArray sts = PersonsUi.arr(pane, "statuses");
            LinearLayout chip = Ui.row(a);
            chip.setGravity(Gravity.CENTER_VERTICAL);
            chip.setPadding(Ui.dp(10), Ui.dp(6), Ui.dp(8), Ui.dp(6));
            chip.setBackground(Ui.press(Ui.CARD, Ui.LINE, 10));
            chip.addView(Ui.text(a, moving ? "Moving…" : PersonsUi.s(pane, "statusLabel"), 13, Ui.FG));
            if (sts.length() > 1) chip.addView(Ui.icon(a, Ui.I_DOWN, 13, Ui.G700), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(14), Ui.dp(14)), 4, 0, 0, 0));
            chip.setEnabled(sts.length() > 1 && !moving);
            chip.setOnClickListener(v -> statusMenu());
            chip.setContentDescription("Status: " + PersonsUi.s(pane, "statusLabel"));
            h.addView(chip, Ui.margins(Ui.wrap(), 6, 0, 0, 0));
        }
        LinearLayout col = Ui.col(a);
        col.addView(h, Ui.fill());
        col.addView(Ds.hairline(a), new LinearLayout.LayoutParams(-1, Math.max(1, Ui.dp(0.5f))));
        headBox.addView(col, new FrameLayout.LayoutParams(-1, -2));
    }

    /** StoreLogo: the store's picture, else its initials, in a rounded square. */
    private View logo(String initials, String icon, int size) {
        FrameLayout f = new FrameLayout(a);
        TextView ini = Ui.text(a, initials, size >= 40 ? 14 : 12, Ui.G700);
        ini.setGravity(Gravity.CENTER);
        ini.setIncludeFontPadding(false);
        ini.setBackground(Ui.round(Ui.G100, Ui.LINE, 6));
        f.addView(ini, new FrameLayout.LayoutParams(-1, -1));
        if (!icon.isEmpty()) {
            ImageView iv = new ImageView(a);
            iv.setScaleType(ImageView.ScaleType.CENTER_CROP);
            iv.setBackground(Ui.round(0, 0, 6));
            iv.setClipToOutline(true);
            f.addView(iv, new FrameLayout.LayoutParams(-1, -1));
            PersonsUi.image(a, p.hub, icon, iv, Ui.dp(size), null);
        }
        return f;
    }

    /** SpokPay's Badge tones: blue for Working, amber for Waiting review, green for Completed, grey otherwise. */
    private TextView pill(String label, String tone) {
        int fg = "info".equals(tone) ? Ui.BLUE : "warning".equals(tone) ? Ui.AMBER : "success".equals(tone) ? Ui.GREEN : Ui.FG;
        TextView t = Ui.text(a, label, 12, fg);
        t.setPadding(Ui.dp(8), Ui.dp(1), Ui.dp(8), Ui.dp(2));
        t.setBackground(Ui.round((fg & 0x00ffffff) | 0x22000000, (fg & 0x00ffffff) | 0x66000000, 999));
        return t;
    }

    /** RequestBrief: "Request brief", "Website · Opened by SpokPay · 19 Nov 2026", the summary, the brief's parts
     *  (a small muted label over each), the pictures and files. */
    private View brief() {
        JSONObject b = PersonsUi.obj(pane, "brief");
        LinearLayout c = Ui.col(a);
        c.setBackground(Ui.round(Ui.CARD, Ui.LINE, 12));
        c.setPadding(Ui.dp(14), Ui.dp(12), Ui.dp(14), Ui.dp(14));
        c.addView(Ui.bold(a, PersonsUi.s(b, "title"), 14, Ui.FG));
        c.addView(Ui.text(a, PersonsUi.s(b, "sub"), 13, Ui.G700), Ui.margins(Ui.fill(), 0, 2, 0, 0));
        String summary = PersonsUi.s(b, "summary");
        if (!summary.isEmpty()) c.addView(linked(Ui.text(a, summary, 14, Ui.FG)), Ui.margins(Ui.fill(), 0, 10, 0, 0));
        JSONArray facts = PersonsUi.arr(b, "facts");
        if (facts.length() > 0 && !summary.isEmpty()) {
            View line = new View(a);
            line.setBackgroundColor(Ui.LINE);
            c.addView(line, Ui.margins(new LinearLayout.LayoutParams(-1, Ui.dp(1)), 0, 10, 0, 0));
        }
        for (int i = 0; i < facts.length(); i++) {
            JSONObject f = facts.optJSONObject(i);
            if (f == null) continue;
            c.addView(Ui.text(a, PersonsUi.s(f, "label"), 12, Ui.G700), Ui.margins(Ui.fill(), 0, 10, 0, 2));
            c.addView(linked(Ui.text(a, PersonsUi.s(f, "text"), 14, Ui.FG)), Ui.fill());
        }
        View g = gallery(PersonsUi.arr(b, "files"), Ui.FG);
        if (g != null) c.addView(g, Ui.margins(Ui.fill(), 0, 10, 0, 0));
        return c;
    }

    private TextView linked(TextView t) {
        t.setAutoLinkMask(Linkify.WEB_URLS);
        t.setLinkTextColor(Ui.BLUE);
        return t;
    }

    /** RequestLine: the author and time over a run's first bubble; the store's on the left with its logo, SpokPay's on
     *  the right in the dark bubble. */
    private View line(JSONObject it) {
        boolean mine = it.optBoolean("mine"), joinsPrev = it.optBoolean("joinsPrev"), joinsNext = it.optBoolean("joinsNext");
        LinearLayout r = Ui.row(a);
        r.setGravity(mine ? Gravity.END | Gravity.BOTTOM : Gravity.START | Gravity.BOTTOM);
        r.setPadding(0, Ui.dp(joinsPrev ? 2 : 10), 0, 0);
        int av = 28;
        if (!mine) {
            View logo = joinsNext ? new View(a) : logo(PersonsUi.s(pane, "initials"), PersonsUi.s(pane, "icon"), av);
            r.addView(logo, Ui.margins(new LinearLayout.LayoutParams(Ui.dp(av), Ui.dp(av)), 0, 0, 8, 0));
        }
        LinearLayout col = Ui.col(a);
        col.setGravity(mine ? Gravity.END : Gravity.START);
        if (!joinsPrev) col.addView(Ui.text(a, PersonsUi.s(it, "head"), 12, Ui.G700), Ui.margins(Ui.wrap(), 2, 0, 2, 4));
        LinearLayout bubble = Ui.col(a);
        bubble.setBackground(mine ? Ui.round(Ui.INK, 0, 10) : Ui.round(Ui.BG2, Ui.LINE, 10));
        String text = PersonsUi.s(it, "text");
        bubble.setPadding(Ui.dp(text.isEmpty() ? 4 : 12), Ui.dp(text.isEmpty() ? 4 : 8), Ui.dp(text.isEmpty() ? 4 : 12), Ui.dp(text.isEmpty() ? 4 : 8));
        if (!text.isEmpty()) {
            TextView t = linked(Ui.text(a, text, 14, mine ? Ui.ON_INK : Ui.FG));
            t.setOnLongClickListener(v -> { menu(it); return true; });
            bubble.addView(t);
        }
        View g = gallery(PersonsUi.arr(it, "files"), mine ? Ui.ON_INK : Ui.FG);
        if (g != null) {
            longPress(g, v -> { menu(it); return true; });
            bubble.addView(g, Ui.margins(Ui.wrap(), 0, text.isEmpty() ? 0 : 6, 0, 0));
        }
        int maxW = (int) (a.getResources().getDisplayMetrics().widthPixels * 0.72f);
        bubble.setLayoutParams(new LinearLayout.LayoutParams(-2, -2));
        bubble.setOnLongClickListener(v -> { menu(it); return true; });
        col.addView(bubble);
        r.addView(col, new LinearLayout.LayoutParams(-2, -2));
        if (!text.isEmpty()) ((TextView) bubble.getChildAt(0)).setMaxWidth(maxW);
        if (mine) {
            View mark = joinsNext ? new View(a) : spokpayMark(av);
            r.addView(mark, Ui.margins(new LinearLayout.LayoutParams(Ui.dp(av), Ui.dp(av)), 8, 0, 0, 0));
        }
        return r;
    }

    /** The message's menu on a long-press of its pictures and files too (they take the taps). */
    private static void longPress(View v, View.OnLongClickListener l) {
        if (v.isClickable()) v.setOnLongClickListener(l);
        if (v instanceof android.view.ViewGroup) {
            android.view.ViewGroup g = (android.view.ViewGroup) v;
            for (int i = 0; i < g.getChildCount(); i++) longPress(g.getChildAt(i), l);
        }
    }

    /** SpokPayAvatar: an "S" in a bordered circle (the mark itself is the PC's). */
    private View spokpayMark(int size) {
        TextView t = Ui.bold(a, "S", size >= 32 ? 14 : 12, Ui.FG);
        t.setGravity(Gravity.CENTER);
        t.setIncludeFontPadding(false);
        t.setBackground(Ui.round(Ui.CARD, Ui.LINE, 999));
        return t;
    }

    /** Pictures (tap: the full one in the browser) and other files (tap: opened). */
    private View gallery(JSONArray fs, int ink) {
        if (fs.length() == 0) return null;
        LinearLayout c = Ui.col(a);
        LinearLayout pics = Ui.row(a);
        for (int i = 0; i < fs.length(); i++) {
            JSONObject f = fs.optJSONObject(i);
            if (f == null) continue;
            String url = PersonsUi.s(f, "url"), src = PersonsUi.s(f, "src"), name = PersonsUi.s(f, "name");
            if (f.optBoolean("image") && !src.isEmpty()) {
                ImageView iv = new ImageView(a);
                iv.setScaleType(ImageView.ScaleType.CENTER_CROP);
                iv.setBackground(Ui.round(Ui.G200, 0, 8));
                iv.setClipToOutline(true);
                iv.setContentDescription(name);
                iv.setOnClickListener(v -> Ui.openUrl(a, url));
                pics.addView(iv, Ui.margins(new LinearLayout.LayoutParams(Ui.dp(120), Ui.dp(96)), 0, 0, 4, 0));
                PersonsUi.image(a, p.hub, src, iv, Ui.dp(240), null);
            } else {
                LinearLayout r = Ui.row(a);
                r.setGravity(Gravity.CENTER_VERTICAL);
                r.addView(Ui.icon(a, Ui.I_FILE, 13, ink), new LinearLayout.LayoutParams(Ui.dp(16), Ui.dp(16)));
                r.addView(Ui.text(a, name, 13, ink), Ui.margins(Ui.wrap(), 4, 0, 0, 0));
                r.setOnClickListener(v -> Ui.openUrl(a, url));
                c.addView(r, Ui.margins(Ui.wrap(), 0, 4, 0, 0));
            }
        }
        if (pics.getChildCount() > 0) {
            HorizontalScrollView hs = new HorizontalScrollView(a);
            hs.setHorizontalScrollBarEnabled(false);
            hs.addView(pics);
            c.addView(hs, 0);
        }
        return c;
    }

    // ---- the composer and the status ----

    /** Who the composer writes to: the person linked to the store, else its owner. */
    private String name() {
        JSONObject who = PersonsUi.obj(pane, "person");
        String n = who == null ? "" : PersonsUi.s(who, "name");
        return n.isEmpty() ? PersonsUi.s(pane, "owner") : n;
    }

    private void composer() {
        boolean fin = pane != null && pane.optBoolean("finished");
        bottom.setVisibility(pane == null ? View.GONE : View.VISIBLE);
        finished.setVisibility(fin ? View.VISIBLE : View.GONE);
        box.setVisibility(fin ? View.GONE : View.VISIBLE);
        if (pane == null) return;
        finished.setText(PersonsUi.s(pane, "finishedNote"));
        String n = name();
        String why = PersonsUi.s(pane, "writeBlocked");
        boolean blockedNow = !toAi && !why.isEmpty();
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
            JSONObject who = PersonsUi.obj(pane, "person");
            String av = who == null ? "" : PersonsUi.s(who, "avatar");
            String ini = who == null ? PersonsUi.s(pane, "initials") : PersonsUi.s(who, "initials");
            int color = who == null ? Ui.G500 : PersonsUi.color(PersonsUi.s(who, "color"), Ui.G500);
            if (av.isEmpty()) av = PersonsUi.s(pane, "icon");
            headMark.addView(PersonsUi.avatar(a, p.hub, av, ini, color, 20, ""), new FrameLayout.LayoutParams(-1, -1));
            headText.setText(quote("To", n));
            headNote.setVisibility(View.GONE);
        }
        headLine.setBackgroundColor(toAi ? PersonsUi.aiLine() : Ui.LINE);
        if (toAi) {
            GradientDrawable g = Ui.round(PersonsUi.aiFill(), 0, 24);
            g.setStroke(Ui.dp(1), PersonsUi.aiLine(), Ui.dp(5), Ui.dp(4));
            box.setBackground(g);
        } else box.setBackground(Ui.round(Ui.CARD, Ui.LINE, 20));
        // the photos (to the store), the field or why the key can't reply
        thumbs.removeAllViews();
        for (int i = 0; i < thumbBits.size(); i++) {
            int at = i;
            FrameLayout f = new FrameLayout(a);
            ImageView iv = new ImageView(a);
            iv.setImageBitmap(thumbBits.get(i));
            iv.setScaleType(ImageView.ScaleType.CENTER_CROP);
            iv.setBackground(Ui.round(Ui.G200, 0, 8));
            iv.setClipToOutline(true);
            f.addView(iv, new FrameLayout.LayoutParams(-1, -1));
            f.setOnClickListener(v -> { files.remove(at); thumbBits.remove(at); composer(); });
            f.setContentDescription("Remove this photo");
            thumbs.addView(f, Ui.margins(new LinearLayout.LayoutParams(Ui.dp(56), Ui.dp(56)), 0, 0, 6, 0));
        }
        ((View) thumbs.getParent()).setVisibility(toAi || thumbBits.isEmpty() ? View.GONE : View.VISIBLE);
        if (toAi && forwarded != null) {
            String ft = PersonsUi.s(forwarded, "text");
            fwdText.setText(quote("Forwarding", PersonsUi.s(forwarded, "author"), ft.isEmpty() ? "Photo" : ft.replace('\n', ' ')));
            fwdBox.setVisibility(View.VISIBLE);
        } else fwdBox.setVisibility(View.GONE);
        blocked.setText(blockedNow ? why : "");
        blocked.setVisibility(blockedNow ? View.VISIBLE : View.GONE);
        edit.setVisibility(blockedNow ? View.GONE : View.VISIBLE);
        edit.setHint(toAi ? (forwarded != null ? "Ask about this message (empty: \u201cWhat should I reply to this?\u201d)" : "Tell the AI what to do about " + ref) : PersonsUi.s(pane, "placeholder"));
        // attach (photos to the store), the switch, send
        attach.setVisibility(toAi ? View.GONE : View.VISIBLE);
        attach.setEnabled(!blockedNow && a instanceof Base);
        attach.setAlpha(!blockedNow ? 1f : 0.45f);
        seg.setBackground(Ui.round(Ui.BG, Ui.LINE, 17));
        paintSegment(segAi, "AI", toAi);
        paintSegment(segPerson, n, !toAi);
        sendPill.setVisibility(toAi ? View.GONE : View.VISIBLE);
        sendRound.setVisibility(toAi ? View.VISIBLE : View.GONE);
        sendRound.setBackground(Ui.round(Ui.CARD, Ui.LINE, 18));
        sendState();
    }

    private void sendState() {
        boolean has = edit.getText().toString().trim().length() > 0;
        boolean can = pane != null && (toAi ? has || forwarded != null : !sending && PersonsUi.s(pane, "writeBlocked").isEmpty() && (has || !files.isEmpty()));
        sendPill.setEnabled(can);
        sendPill.setAlpha(can ? 1f : 0.45f);
        sendPill.setBackground(Ui.round(can ? Ui.INK : Ui.G300, 0, 18));
        sendRound.setEnabled(can);
        sendRound.setAlpha(can ? 1f : 0.45f);
    }

    /** The composer writes to the owner or to the AI, each with its own words; the field keeps the focus. */
    private void switchTo(boolean ai) {
        if (ai == toAi) return;
        String now = edit.getText().toString();
        toAi = ai;
        edit.setText(otherDraft);
        otherDraft = now;
        composer();
        edit.requestFocus();
    }

    /** One side of the "To" switch: a glyph and a label in a pill (PersonsChat's). */
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

    /** "To <b>Name</b>" / "Forwarding <b>Name</b> text". */
    private CharSequence quote(String lead, String name) { return quote(lead, name, ""); }

    private CharSequence quote(String lead, String name, String text) {
        SpannableStringBuilder b = new SpannableStringBuilder(lead + " ");
        int s0 = b.length();
        b.append(name);
        b.setSpan(new ForegroundColorSpan(Ui.FG), s0, b.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        b.setSpan(new android.text.style.StyleSpan(android.graphics.Typeface.BOLD), s0, b.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        if (!text.isEmpty()) b.append("  ").append(text);
        return b;
    }

    /**
     * A message's long-press (PersonsChat's menu, as far as SpokPay's admin API goes): Quote (no reply to a message
     * there) · Forward to AI | Copy text · Open attachment. No Mark as unread: the open pane reads the request again.
     */
    private void menu(JSONObject it) {
        if (pane == null) return;
        String text = PersonsUi.s(it, "text");
        JSONArray fs = PersonsUi.arr(it, "files");
        boolean live = !pane.optBoolean("finished");
        boolean canSend = live && PersonsUi.s(pane, "writeBlocked").isEmpty();
        List<Ds.Item> items = new ArrayList<>();
        if (canSend && !text.isEmpty()) items.add(Ds.item(Ui.I_REPLY, "Quote", () -> {
            if (toAi) switchTo(false);
            StringBuilder q = new StringBuilder();
            for (String l : text.trim().split("\n")) q.append(("> " + l).replaceAll("\\s+$", "")).append('\n');
            String rest = edit.getText().toString().replaceAll("^\\s+", "");
            edit.setText(q.append('\n').append(rest).toString());
            edit.setSelection(edit.getText().length());
            edit.requestFocus();
        }));
        if (live) items.add(Ds.item(Ui.I_SPARKLES, "Forward to AI", () -> {
            forwarded = it;
            if (!toAi) switchTo(true);
            else composer();
            edit.requestFocus();
        }));
        items.add(Ds.sep());
        if (!text.isEmpty()) items.add(Ds.item(Ui.I_COPY, "Copy text", () -> Ui.copy(a, text)));
        JSONObject f = fs.optJSONObject(0);
        if (f != null && !PersonsUi.s(f, "url").isEmpty()) items.add(Ds.item(Ui.I_EXTERNAL, "Open attachment", () -> Ui.openUrl(a, PersonsUi.s(f, "url"))));
        Ds.menu(a, items);
    }

    /** A photo from the picker: scaled to 1600 px and sent as JPEG (SpokPay takes up to 5 a message). */
    private void addPhoto(Uri uri) {
        if (files.size() >= 5) { Ui.toast(a, "SpokPay takes up to 5 photos a message"); return; }
        Ui.bg(a, () -> {
            Bitmap b = Images.decode(a.getContentResolver(), uri, 1600);
            if (b == null) throw new java.io.IOException("Couldn't read that image");
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            b.compress(Bitmap.CompressFormat.JPEG, 85, out);
            JSONObject f = new JSONObject();
            PersonsUi.put(f, "name", "photo.jpg");
            PersonsUi.put(f, "type", "image/jpeg");
            PersonsUi.put(f, "data", android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP));
            Bitmap thumb = Bitmap.createScaledBitmap(b, Math.max(1, b.getWidth() * 112 / Math.max(b.getWidth(), b.getHeight())),
                    Math.max(1, b.getHeight() * 112 / Math.max(b.getWidth(), b.getHeight())), true);
            return new Object[]{f, thumb};
        }, r -> {
            if (closed) return;
            files.add((JSONObject) r[0]);
            thumbBits.add((Bitmap) r[1]);
            composer();
        });
    }

    /** "To: AI": a note about the request to its Person AI chat on the PC (the request goes along as context). */
    private void askAi() {
        String text = edit.getText().toString().trim();
        JSONObject fwd = forwarded;
        if (pane == null || (text.isEmpty() && fwd == null)) return;
        edit.setText("");
        forwarded = null;
        composer();
        JSONObject b = PersonsUi.put(new JSONObject(), "text", text);
        if (fwd != null) PersonsUi.put(b, "forward", PersonsUi.s(fwd, "id"));
        Ui.pool.execute(() -> {
            String why = null;
            JSONObject got = null;
            try {
                JSONObject r = p.hub.call("POST", path() + "/ai", b, 60_000);
                if (!r.optBoolean("ok", true) || r.has("error")) why = r.optString("error", "not sent");
                else got = r;
            } catch (Exception e) { why = Hub.why(e); }
            String w = why;
            JSONObject g = got;
            Ui.main.post(() -> {
                if (a.isDestroyed()) return;
                if (w == null) {
                    // the note shows in the timeline as its AI card, and the answer under it while the AI writes
                    if (closed || pane == null) return;
                    JSONArray ai = g == null ? null : g.optJSONArray("ai");
                    if (ai != null) PersonsUi.put(pane, "ai", ai);
                    if (g != null && g.has("chat")) PersonsUi.put(pane, "aiChat", g.opt("chat"));
                    toBottom = true;
                    render();
                    follow(System.currentTimeMillis() + 180_000);
                    return;
                }
                Ui.toast(a, "AI: " + w);
                if (!closed && toAi && edit.getText().length() == 0) edit.setText(text);
                if (!closed && toAi && forwarded == null && fwd != null) { forwarded = fwd; composer(); }
            });
        });
    }

    /** Send: the reply (and its photos) to the store as SpokPay; on a refusal both come back. */
    private void send() {
        if (toAi) { askAi(); return; }
        String text = edit.getText().toString().trim();
        if (pane == null || sending || (text.isEmpty() && files.isEmpty())) return;
        JSONObject b = PersonsUi.put(new JSONObject(), "text", text);
        JSONArray fa = new JSONArray();
        for (JSONObject f : files) fa.put(f);
        PersonsUi.put(b, "images", fa);
        PersonsUi.put(b, "key", java.util.UUID.randomUUID().toString());
        List<JSONObject> keptFiles = new ArrayList<>(files);
        List<Bitmap> keptThumbs = new ArrayList<>(thumbBits);
        sending = true;
        edit.setText("");
        files.clear();
        thumbBits.clear();
        composer();
        Ui.pool.execute(() -> {
            JSONObject got = null;
            String why = null;
            try { got = p.hub.call("POST", path() + "/reply", b, 90_000).optJSONObject("pane"); } catch (Exception e) { why = Hub.why(e); }
            JSONObject g = got;
            String w = why;
            Ui.main.post(() -> {
                sending = false;
                if (closed || a.isDestroyed()) { if (w != null) Ui.toast(a, "Not sent: " + w); return; }
                if (g != null) {
                    pane = g;
                    toBottom = true;
                    p.refresh();
                } else {
                    if (edit.getText().length() == 0) edit.setText(text);
                    if (files.isEmpty()) { files.addAll(keptFiles); thumbBits.addAll(keptThumbs); }
                    Ui.toast(a, "Not sent: " + w);
                }
                render();
            });
        });
    }

    /** The status chip: SpokPay's moves from where it is; Complete and Close are final, so they ask first. */
    private void statusMenu() {
        if (pane == null) return;
        String no = PersonsUi.s(pane, "statusBlocked");
        if (!no.isEmpty()) { Ui.toast(a, no); return; }
        JSONArray sts = PersonsUi.arr(pane, "statuses");
        List<Ds.Item> m = new ArrayList<>();
        for (int i = 0; i < sts.length(); i++) {
            JSONObject s = sts.optJSONObject(i);
            if (s == null) continue;
            String to = PersonsUi.s(s, "status"), label = PersonsUi.s(s, "label");
            boolean cur = s.optBoolean("current");
            m.add(Ds.item(cur ? Ui.I_CHECK : "", label, cur ? null : () -> {
                JSONObject words = PersonsUi.obj(PersonsUi.obj(pane, "confirms"), to);
                if (words == null) { move(to, label); return; }
                Ui.dialog(a).setTitle(PersonsUi.s(words, "title")).setMessage(PersonsUi.s(words, "text"))
                        .setPositiveButton(PersonsUi.s(words, "ok"), (d, w) -> move(to, label))
                        .setNegativeButton("Cancel", null).show();
            }));
        }
        Ds.menu(a, m);
    }

    private void move(String to, String label) {
        moving = true;
        header();
        Ui.pool.execute(() -> {
            JSONObject got = null;
            String why = null;
            try { got = p.hub.call("POST", path() + "/status", PersonsUi.put(new JSONObject(), "to", to), 60_000).optJSONObject("pane"); } catch (Exception e) { why = Hub.why(e); }
            JSONObject g = got;
            String w = why;
            Ui.main.post(() -> {
                moving = false;
                if (closed || a.isDestroyed()) return;
                if (g != null) {
                    pane = g;
                    Ui.toast(a, "Now " + label.toLowerCase());
                    p.refresh();
                } else Ui.toast(a, "Status not changed: " + w);
                render();
            });
        });
    }

    /** The reply composer (a live restart keeps its text). */
    android.widget.EditText field() { return edit; }
}
