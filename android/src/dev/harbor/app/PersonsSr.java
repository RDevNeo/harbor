package dev.harbor.app;

import android.app.Activity;
import android.graphics.Bitmap;
import android.net.Uri;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
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
 *  and the composer ("Write to <owner>", up to 5 photos, Send as SpokPay). Read from the PC
 *  (GET /v1/persons/site-request/{ref}: opening it marks what the store wrote seen), again every 30 s while open and
 *  when its row in the list moves. Emoji come from the keyboard; Edit isn't there (SpokPay's API has no route). */
final class PersonsSr {
    final PersonsState p;
    final Activity a;
    final String ref;
    final LinearLayout view;
    private final FrameLayout headBox;
    private final ScrollView sv;
    private final LinearLayout content, bottom, thumbs;
    private final EditText edit;
    private final FrameLayout send;
    private final TextView finished, blocked;
    private final LinearLayout box;
    private JSONObject pane;
    private String error;
    private boolean closed, sending, moving, toBottom = true;
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
        box = Ui.col(a);
        box.setBackground(Ui.round(Ui.CARD, Ui.LINE, 20));
        box.setPadding(Ui.dp(8), Ui.dp(8), Ui.dp(8), Ui.dp(6));
        HorizontalScrollView hs = new HorizontalScrollView(a);
        hs.setHorizontalScrollBarEnabled(false);
        thumbs = Ui.row(a);
        hs.addView(thumbs);
        box.addView(hs, Ui.margins(Ui.fill(), 0, 0, 0, 6));
        blocked = Ui.text(a, "", 13, Ui.AMBER);
        blocked.setPadding(Ui.dp(4), Ui.dp(4), Ui.dp(4), Ui.dp(8));
        box.addView(blocked, Ui.fill());
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
        box.addView(edit, Ui.fill());
        LinearLayout row = Ui.row(a);
        row.setGravity(Gravity.CENTER_VERTICAL);
        TextView pic = Ui.iconButton(a, Ui.I_IMAGE, Ui.G700, v -> { if (a instanceof Base) ((Base) a).pickImage(this::addPhoto); });
        pic.setContentDescription("Add photos");
        row.addView(pic, new LinearLayout.LayoutParams(Ui.dp(40), Ui.dp(40)));
        row.addView(new View(a), new LinearLayout.LayoutParams(0, 1, 1));
        send = Ui.roundButton(a, Ui.I_UP, Ui.INK, Ui.ON_INK, 36, v -> send());
        send.setContentDescription("Send as SpokPay");
        row.addView(send);
        box.addView(row, Ui.fill());
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
            });
        });
    }

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
        JSONArray items = PersonsUi.arr(pane, "items");
        for (int i = 0; i < items.length(); i++) {
            JSONObject it = items.optJSONObject(i);
            if (it == null) continue;
            if ("event".equals(PersonsUi.s(it, "kind"))) {
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
        h.setPadding(Ui.dp(4), Ui.dp(8), Ui.dp(10), Ui.dp(8));
        TextView back = Ui.iconButton(a, Ui.I_LEFT, Ui.FG, v -> p.back());
        back.setContentDescription("Back to requests");
        h.addView(back);
        JSONObject face = pane != null ? pane : r;
        h.addView(logo(face == null ? "" : PersonsUi.s(face, "initials"), face == null ? "" : PersonsUi.s(face, "icon"), 40),
                Ui.margins(new LinearLayout.LayoutParams(Ui.dp(40), Ui.dp(40)), 2, 0, 10, 0));
        LinearLayout t = Ui.col(a);
        String subject = pane != null ? PersonsUi.s(pane, "subject") : r != null ? PersonsUi.s(r, "subject") : ref;
        TextView title = Ui.bold(a, subject.isEmpty() ? ref : subject, 16, Ui.FG);
        title.setMaxLines(2);
        title.setEllipsize(android.text.TextUtils.TruncateAt.END);
        t.addView(title);
        LinearLayout meta = Ui.row(a);
        meta.setGravity(Gravity.CENTER_VERTICAL);
        if (pane != null) meta.addView(pill(PersonsUi.s(pane, "statusLabel"), PersonsUi.s(pane, "tone")), Ui.margins(Ui.wrap(), 0, 0, 8, 0));
        String store = pane != null ? PersonsUi.s(pane, "store") : r != null ? PersonsUi.s(r, "store") : "";
        TextView where = Ui.subtitle(Ui.text(a, (store.isEmpty() ? "" : store + " · ") + ref, 13, Ui.G700));
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
        headBox.addView(h, new FrameLayout.LayoutParams(-1, -2));
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
            t.setTextIsSelectable(true);
            bubble.addView(t);
        }
        View g = gallery(PersonsUi.arr(it, "files"), mine ? Ui.ON_INK : Ui.FG);
        if (g != null) bubble.addView(g, Ui.margins(Ui.wrap(), 0, text.isEmpty() ? 0 : 6, 0, 0));
        int maxW = (int) (a.getResources().getDisplayMetrics().widthPixels * 0.72f);
        bubble.setLayoutParams(new LinearLayout.LayoutParams(-2, -2));
        col.addView(bubble);
        r.addView(col, new LinearLayout.LayoutParams(-2, -2));
        if (!text.isEmpty()) ((TextView) bubble.getChildAt(0)).setMaxWidth(maxW);
        if (mine) {
            View mark = joinsNext ? new View(a) : spokpayMark(av);
            r.addView(mark, Ui.margins(new LinearLayout.LayoutParams(Ui.dp(av), Ui.dp(av)), 8, 0, 0, 0));
        }
        return r;
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

    private void composer() {
        boolean fin = pane != null && pane.optBoolean("finished");
        bottom.setVisibility(pane == null ? View.GONE : View.VISIBLE);
        finished.setVisibility(fin ? View.VISIBLE : View.GONE);
        box.setVisibility(fin ? View.GONE : View.VISIBLE);
        if (pane == null) return;
        finished.setText(PersonsUi.s(pane, "finishedNote"));
        String why = PersonsUi.s(pane, "writeBlocked");
        blocked.setText(why);
        blocked.setVisibility(why.isEmpty() ? View.GONE : View.VISIBLE);
        edit.setVisibility(why.isEmpty() ? View.VISIBLE : View.GONE);
        edit.setHint(PersonsUi.s(pane, "placeholder"));
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
        ((View) thumbs.getParent()).setVisibility(thumbBits.isEmpty() ? View.GONE : View.VISIBLE);
        sendState();
    }

    private void sendState() {
        boolean can = pane != null && !sending && PersonsUi.s(pane, "writeBlocked").isEmpty() && (edit.getText().toString().trim().length() > 0 || !files.isEmpty());
        send.setAlpha(can ? 1f : 0.35f);
        send.setEnabled(can);
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

    /** Send: the reply (and its photos) to the store as SpokPay; on a refusal both come back. */
    private void send() {
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
}
