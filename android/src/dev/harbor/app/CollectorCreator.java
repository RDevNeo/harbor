package dev.harbor.app;

import android.app.AlertDialog;
import android.content.Context;
import android.text.InputType;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.widget.EditText;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Locale;

/** Collector's screens over the tab: {@link Detail} (a lead's detail), {@link Compose} (Send message) and the bar
 *  they share. */
final class CollectorCreator {
    private CollectorCreator() { }

    static String join(String sep, String... parts) {
        StringBuilder b = new StringBuilder();
        for (String p : parts) {
            if (p == null || p.isEmpty() || "null".equals(p)) continue;
            if (b.length() > 0) b.append(sep);
            b.append(p);
        }
        return b.toString();
    }

    /** A screen's bar over the tab: back, the title (child 1), room on the right. */
    static LinearLayout topBar(Collector a, String title, Runnable back) {
        LinearLayout bar = Ui.row(a);
        bar.setPadding(Ui.dp(6), Ui.dp(6), Ui.dp(6), Ui.dp(6));
        bar.setMinimumHeight(Ui.dp(56));
        TextView x = Ui.iconButton(a, Ui.I_LEFT, Ui.FG, v -> back.run());
        x.setContentDescription("Back");
        bar.addView(x);
        TextView t = Ui.subtitle(Ui.bold(a, title, 17, Ui.FG));
        t.setGravity(Gravity.CENTER);
        bar.addView(t, Ui.weight());
        bar.addView(new View(a), new LinearLayout.LayoutParams(Ui.dp(44), Ui.dp(44)));
        return bar;
    }

    // ---------- Send message ----------

    /** Send message: a template (the last used first), the channel (the Creators Gmail or WhatsApp in Persons; one
     *  that can't send says why), To, Subject (email), the message, the CRM's guards (30 new emails a day, already
     *  written to). Send asks first, then POST /v1/collector/send: a real send, only on that tap. The creator then
     *  is a person in Persons › Creators. */
    static final class Compose implements Collector.Screen {
        private final Collector a;
        private final Hub h;
        private final String id;
        private final LinearLayout root, body;
        private JSONObject c;
        private EditText to, subject, text;
        private boolean sending;
        /** "email" or "whatsapp": the channel it opens on (a lead's Reach), else the usual pick. */
        private final String kind;

        Compose(Collector a, String id, String name) { this(a, id, name, ""); }

        Compose(Collector a, String id, String name, String kind) {
            this.a = a;
            this.kind = kind == null ? "" : kind;
            this.h = a.hub;
            this.id = id;
            root = Ui.col(a);
            root.setBackgroundColor(Ui.BG);
            root.addView(topBar(a, name.isEmpty() ? "Send message" : "Send message · " + name, a::pop), Ui.fill());
            ScrollView sv = new ScrollView(a);
            body = Ui.col(a);
            body.setPadding(Ui.dp(16), Ui.dp(4), Ui.dp(16), Ui.dp(24));
            sv.addView(body);
            root.addView(sv, new LinearLayout.LayoutParams(-1, 0, 1));
            body.addView(Ds.empty(a, "Loading…"), Ui.fill());
            load("", "", false);
        }

        @Override public View view() { return root; }

        @Override public void shown() { }

        private String template() { return c == null ? "" : c.optString("template"); }
        private String channel() { return c == null ? "" : c.optString("channel"); }
        private boolean email() { return c == null || !"whatsapp".equals(c.optString("kind")); }

        /** GET compose: the message for this template and channel; keep = the typed message stays (a channel switch). */
        private void load(String template, String channel, boolean keep) {
            if (h == null) return;
            final String keepText = keep && text != null ? text.getText().toString() : null;
            final String keepSubject = keep && subject != null ? subject.getText().toString() : null;
            Ui.bg(a, () -> h.get("/v1/collector/compose?id=" + Collector.q(id) + "&template=" + Collector.q(template) + "&channel=" + Collector.q(channel) + (channel.isEmpty() ? "&kind=" + Collector.q(kind) : "")), r -> {
                c = r;
                draw();
                if (keepText != null && text != null) text.setText(keepText);
                if (keepSubject != null && subject != null && !keepSubject.isEmpty()) subject.setText(keepSubject);
            });
        }

        private void draw() {
            body.removeAllViews();
            to = subject = text = null;
            if (c == null) return;
            // Template.
            body.addView(head("TEMPLATE"), Ui.fill());
            LinearLayout tl = Ds.card(a);
            tl.setPadding(Ui.dp(4), Ui.dp(4), Ui.dp(4), Ui.dp(4));
            JSONArray ts = c.optJSONArray("templates");
            for (int i = 0; ts != null && i < ts.length(); i++) {
                JSONObject t = ts.optJSONObject(i);
                if (t == null) continue;
                final String tid = t.optString("id");
                boolean on = tid.equals(template());
                LinearLayout r = Ds.row(a, on);
                LinearLayout col = Ui.col(a);
                col.addView(Ds.rowTitle(a, t.optString("name"), on, Ui.FG), Ui.fill());
                if (!t.optString("description").isEmpty()) col.addView(Ui.subtitle(Ui.text(a, t.optString("description"), 12.5f, Ui.G600)), Ui.fill());
                r.addView(col, Ui.weight());
                if (on) r.addView(Ui.icon(a, Ui.I_CHECK, 16, Ui.FG), new LinearLayout.LayoutParams(Ui.dp(22), Ui.dp(22)));
                r.setOnClickListener(on ? null : v -> load(tid, channel(), false));
                tl.addView(r, Ui.fill());
            }
            body.addView(tl, Ui.fill());
            // Channel.
            body.addView(head("SEND ON"), Ui.fill());
            HorizontalScrollView hs = new HorizontalScrollView(a);
            hs.setHorizontalScrollBarEnabled(false);
            LinearLayout chips = Ui.row(a);
            JSONArray chs = c.optJSONArray("channels");
            JSONObject picked = null;
            for (int i = 0; chs != null && i < chs.length(); i++) {
                JSONObject ch = chs.optJSONObject(i);
                if (ch == null) continue;
                final String cid = ch.optString("id");
                boolean on = cid.equals(channel());
                if (on) picked = ch;
                boolean ok = ch.optBoolean("connected");
                final String why = ch.optString("why");
                String label = "whatsapp".equals(ch.optString("kind")) ? "WhatsApp" : "Email";
                TextView chip = Ds.chip(a, label, on, on ? null : ok ? v -> load(template(), cid, true) : v -> Ui.toast(a, why));
                if (!ok) chip.setAlpha(0.45f);
                chips.addView(chip, Ui.margins(Ui.wrap(), 0, 0, 6, 0));
            }
            hs.addView(chips);
            body.addView(hs, Ui.fill());
            if (chs == null || chs.length() == 0)
                body.addView(Collector.pad(Ui.text(a, "Nothing to send on: sign in to Gmail or WhatsApp in Persons › Creators.", 12.5f, Ui.AMBER), 2), Ui.fill());
            if (chs != null) for (int i = 0; i < chs.length(); i++) {
                JSONObject ch = chs.optJSONObject(i);
                if (ch != null && !ch.optBoolean("connected") && !ch.optString("why").isEmpty())
                    body.addView(Collector.pad(Ui.text(a, ch.optString("why"), 12.5f, Ui.G600), 6), Ui.fill());
            }
            if (picked != null) {
                String acc = picked.optString("account", "");
                if (!acc.isEmpty() && !"null".equals(acc)) body.addView(Collector.pad(Ui.text(a, "From " + acc, 12.5f, Ui.G700), 6), Ui.fill());
                if (picked.optBoolean("connected") && !picked.optString("why").isEmpty())
                    body.addView(Collector.pad(Ui.text(a, picked.optString("why"), 12.5f, Ui.AMBER), 2), Ui.fill());
            }
            // To, Subject, the message.
            boolean em = email();
            body.addView(label("To"), Ui.fill());
            to = Ui.input(a, em ? "name@example.com" : "+55 11 91234-5678", false);
            to.setInputType(em ? InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS : InputType.TYPE_CLASS_PHONE);
            to.setTypeface(Ui.sans);
            to.setText(c.optString("to"));
            body.addView(to, Ui.fill());
            if (em) {
                body.addView(label("Subject"), Ui.fill());
                subject = Ui.input(a, "Subject", false);
                subject.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
                subject.setText(c.optString("subject"));
                body.addView(subject, Ui.fill());
            }
            body.addView(label("Message"), Ui.fill());
            text = Ui.input(a, "Write the message", true);
            text.setMinLines(8);
            text.setGravity(Gravity.TOP | Gravity.START);
            text.setText(c.optString("text"));
            body.addView(text, Ui.fill());
            // The guards.
            JSONObject g = c.optJSONObject("guard");
            boolean blocked = false;
            if (g != null) {
                int limit = g.optInt("limit"), sent = g.optInt("sentToday");
                if (limit > 0) {
                    blocked = sent >= limit;
                    body.addView(Collector.pad(Ui.text(a, sent + "/" + limit + " sent in the last 24 h" + (blocked ? ": try again later" : ""), 12.5f, blocked ? Ui.RED : Ui.G600), 10), Ui.fill());
                }
                String already = g.optString("already", "");
                if (!already.isEmpty() && !"null".equals(already)) body.addView(Collector.pad(Ui.text(a, already, 12.5f, Ui.AMBER), 2), Ui.fill());
                if (g.optBoolean("justSent")) {
                    blocked = true;
                    body.addView(Collector.pad(Ui.text(a, "Just sent to them: wait a couple of minutes before another.", 12.5f, Ui.RED), 2), Ui.fill());
                }
            }
            // Edit template, Send.
            LinearLayout btns = Ui.row(a);
            btns.addView(Ui.button(a, "Edit template", false, v -> editTemplate()), Ui.wrap());
            boolean can = picked != null && picked.optBoolean("connected") && !blocked && !sending;
            TextView send = Ui.button(a, sending ? "Sending…" : "Send", true, can ? v -> confirm() : null);
            if (!can) send.setAlpha(0.5f);
            btns.addView(send, Ui.margins(Ui.weight(), 8, 0, 0, 0));
            body.addView(btns, Ui.margins(Ui.fill(), 0, 14, 0, 0));
        }

        private TextView head(String s) {
            TextView t = Ds.caps(a, s, false);
            t.setPadding(Ui.dp(4), Ui.dp(16), 0, Ui.dp(6));
            return t;
        }

        private TextView label(String s) {
            TextView t = Ui.text(a, s, 13, Ui.G700);
            t.setPadding(Ui.dp(2), Ui.dp(12), 0, Ui.dp(6));
            return t;
        }

        /** Asks before the real send: to whom, on what, the subject and the start of the message. */
        private void confirm() {
            if (c == null || to == null || text == null) return;
            final String dest = to.getText().toString().trim();
            final String subj = subject == null ? "" : subject.getText().toString().trim();
            final String msg = text.getText().toString().trim();
            final boolean em = email();
            if (dest.isEmpty()) { Ui.toast(a, em ? "Type their email address." : "Type their WhatsApp number."); return; }
            if (msg.isEmpty()) { Ui.toast(a, "The message is empty."); return; }
            if (em && subj.isEmpty()) { Ui.toast(a, "Add a subject."); return; }
            String preview = msg.length() > 280 ? msg.substring(0, 280) + "…" : msg;
            Ui.dialog(a).setTitle(em ? "Send this email to " + dest + "?" : "Send this WhatsApp message to " + dest + "?")
                    .setMessage((em ? "Subject: " + subj + "\n\n" : "") + preview)
                    .setPositiveButton("Send", (dlg, w) -> send(dest, subj, msg))
                    .setNegativeButton("Cancel", null)
                    .show();
        }

        private void send(String dest, String subj, String msg) {
            if (h == null || sending) return;
            sending = true;
            final String keepTo = dest, keepSubject = subj, keepText = msg;
            draw();
            restore(keepTo, keepSubject, keepText);
            JSONObject b = new JSONObject();
            try {
                b.put("id", id).put("channel", channel()).put("to", dest).put("subject", subj).put("text", msg).put("template", template());
            } catch (Exception ignored) { }
            Ui.pool.execute(() -> {
                try {
                    h.call("POST", "/v1/collector/send", b, 90_000);
                    Ui.main.post(() -> {
                        sending = false;
                        Ui.toast(a, "Sent. They're in Persons › Creators.");
                        if (!a.isDestroyed()) a.pop();
                    });
                } catch (Exception e) {
                    Ui.main.post(() -> {
                        sending = false;
                        Ui.toast(a, h.whyDown(e));
                        if (a.isDestroyed()) return;
                        draw();
                        restore(keepTo, keepSubject, keepText);
                    });
                }
            });
        }

        private void restore(String dest, String subj, String msg) {
            if (to != null) to.setText(dest);
            if (subject != null) subject.setText(subj);
            if (text != null) text.setText(msg);
        }

        /** The picked template itself ({name} and {handle} as they are): name, description, subject, body; Save
         *  (POST template), or Save as new; the message is filled from it again. */
        private void editTemplate() {
            if (h == null || c == null) return;
            final String tid = template();
            Ui.bg(a, () -> h.get("/v1/collector/templates"), r -> {
                JSONArray ts = r.optJSONArray("templates");
                JSONObject t = null;
                for (int i = 0; ts != null && i < ts.length(); i++) {
                    JSONObject o = ts.optJSONObject(i);
                    if (o != null && tid.equals(o.optString("id"))) t = o;
                }
                if (t == null) { Ui.toast(a, "That template is gone."); return; }
                LinearLayout box = Ui.col(a);
                box.setPadding(Ui.dp(20), Ui.dp(8), Ui.dp(20), Ui.dp(8));
                final EditText name = field(box, "Name", t.optString("name"), false);
                final EditText desc = field(box, "Description", t.optString("description"), false);
                final EditText subj = field(box, "Subject", t.optString("subject"), false);
                final EditText bd = field(box, "Message", t.optString("body"), true);
                bd.setMinLines(6);
                bd.setGravity(Gravity.TOP | Gravity.START);
                TextView hint = Ui.text(a, "{name} and {handle} are filled in for each creator.", 12, Ui.G600);
                hint.setPadding(0, Ui.dp(8), 0, 0);
                box.addView(hint, Ui.fill());
                ScrollView sv = new ScrollView(a);
                sv.addView(box);
                AlertDialog dlg = Ui.dialog(a).setTitle("Edit template").setView(sv)
                        .setPositiveButton("Save", (x, w) -> saveTemplate(tid, name, desc, subj, bd))
                        .setNeutralButton("Save as new", (x, w) -> saveTemplate("", name, desc, subj, bd))
                        .setNegativeButton("Cancel", null)
                        .create();
                dlg.show();
            });
        }

        private EditText field(LinearLayout box, String label, String value, boolean multi) {
            TextView l = Ui.text(a, label, 13, Ui.G700);
            l.setPadding(Ui.dp(2), Ui.dp(10), 0, Ui.dp(4));
            box.addView(l, Ui.fill());
            EditText e = Ui.input(a, label, multi);
            e.setText(value);
            box.addView(e, Ui.fill());
            return e;
        }

        private void saveTemplate(String tid, EditText name, EditText desc, EditText subj, EditText bd) {
            JSONObject b = new JSONObject();
            try {
                if (!tid.isEmpty()) b.put("id", tid);
                b.put("name", name.getText().toString().trim())
                        .put("description", desc.getText().toString().trim())
                        .put("subject", subj.getText().toString())
                        .put("body", bd.getText().toString());
            } catch (Exception ignored) { }
            final String ch = channel();
            Ui.bg(a, () -> h.call("POST", "/v1/collector/template", b), r -> {
                JSONObject t = r.optJSONObject("template");
                Ui.toast(a, "Template saved");
                load(t == null ? tid : t.optString("id", tid), ch, false);
            });
        }
    }

    // ---------- A lead's detail ----------

    /** Reach kinds, as the SpokPay CRM has them: one way to contact a creator. */
    static final String[] REACH = {"email", "discord", "whatsapp", "instagram"};

    static String reachLabel(String k) {
        switch (k) {
            case "discord": return "Discord";
            case "whatsapp": return "WhatsApp";
            case "instagram": return "Instagram";
            default: return "Email";
        }
    }

    static int brandColor(String k) {
        switch (k) {
            case "discord": return 0xff5865f2;
            case "whatsapp": return 0xff25d366;
            case "instagram": return 0xffe1306c;
            case "youtube": return 0xffff0000;
            case "tiktok": return 0xfffe2c55;
            case "twitch": return 0xff9146ff;
            case "x": return 0xffd7dbe0;
            default: return 0xff9aa4b2;
        }
    }

    /** A colour at the CRM's tint (hex alpha 22). */
    static int tint(int color) { return (color & 0x00ffffff) | 0x22000000; }

    /** A brand's mark, `size` dp: Discord and WhatsApp as Persons' channel marks, Instagram drawn, the rest glyphs. */
    static View brand(Context c, String kind, float size, int color) {
        if ("discord".equals(kind) || "whatsapp".equals(kind)) return PersonsUi.channel(c, kind, size);
        if ("instagram".equals(kind)) {
            View v = new View(c);
            v.setBackground(new Instagram(color));
            v.setLayoutParams(new LinearLayout.LayoutParams(Ui.dp(size), Ui.dp(size)));
            return v;
        }
        TextView t = Ui.icon(c, "email".equals(kind) ? I_MAIL : Ui.I_GLOBE, size, color);
        t.setLayoutParams(new LinearLayout.LayoutParams(Ui.dp(size), Ui.dp(size)));
        return t;
    }

    static final String I_MAIL = "", I_FLAME = "", I_VIDEO = "", I_EYE = "", I_HEART = "",
            I_NOTE = "", I_PENCIL = "";

    /** Lucide's arrow-down (not in the font subset), stroked: the review bar's Skip. */
    static final class ArrowDown extends android.graphics.drawable.Drawable {
        private final android.graphics.Paint p = new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);
        ArrowDown(int color) {
            p.setColor(color);
            p.setStyle(android.graphics.Paint.Style.STROKE);
            p.setStrokeCap(android.graphics.Paint.Cap.ROUND);
            p.setStrokeJoin(android.graphics.Paint.Join.ROUND);
        }
        @Override public void draw(android.graphics.Canvas c) {
            android.graphics.Rect b = getBounds();
            float s = Math.min(b.width(), b.height()) / 24f;
            c.save();
            c.translate(b.left, b.top);
            c.scale(s, s);
            p.setStrokeWidth(2);
            c.drawLine(12, 5, 12, 19, p);
            android.graphics.Path h = new android.graphics.Path();
            h.moveTo(19, 12);
            h.lineTo(12, 19);
            h.lineTo(5, 12);
            c.drawPath(h, p);
            c.restore();
        }
        @Override public void setAlpha(int a) { p.setAlpha(a); }
        @Override public void setColorFilter(android.graphics.ColorFilter f) { p.setColorFilter(f); }
        @Override public int getOpacity() { return android.graphics.PixelFormat.TRANSLUCENT; }
    }

    /** Lucide's Instagram (its font dropped it): a rounded square, the lens and the dot, stroked. */
    static final class Instagram extends android.graphics.drawable.Drawable {
        private final android.graphics.Paint p = new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);
        Instagram(int color) {
            p.setColor(color);
            p.setStyle(android.graphics.Paint.Style.STROKE);
            p.setStrokeCap(android.graphics.Paint.Cap.ROUND);
        }
        @Override public void draw(android.graphics.Canvas c) {
            android.graphics.Rect b = getBounds();
            float s = Math.min(b.width(), b.height()) / 24f;
            c.save();
            c.translate(b.left, b.top);
            c.scale(s, s);
            p.setStrokeWidth(2);
            c.drawRoundRect(new android.graphics.RectF(2, 2, 22, 22), 5, 5, p);
            c.drawCircle(12, 12, 4, p);
            c.drawPoint(17.5f, 6.5f, p);
            c.restore();
        }
        @Override public void setAlpha(int a) { p.setAlpha(a); }
        @Override public void setColorFilter(android.graphics.ColorFilter f) { p.setColorFilter(f); }
        @Override public int getOpacity() { return android.graphics.PixelFormat.TRANSLUCENT; }
    }

    /** The Reach icon on a lead's card: the brand's mark on its tint. */
    static View reachMark(Context c, String kind) {
        android.widget.FrameLayout f = new android.widget.FrameLayout(c);
        f.setBackground(Ui.round(tint(brandColor(kind)), 0, 6));
        f.addView(brand(c, kind, 14, brandColor(kind)), new android.widget.FrameLayout.LayoutParams(Ui.dp(14), Ui.dp(14), Gravity.CENTER));
        f.setContentDescription("Reach: " + reachLabel(kind));
        return f;
    }

    /** A lead's profile, full screen over the tab (the PC's detail dialog, the SpokPay CRM's creator profile, on the
     *  phone's design system). The top bar: back, the name, "3 of 121" and the previous / next lead of the list it was
     *  opened from. Then the profile: the picture, name, platform and handle, Approved / Restricted / Has contact, the
     *  stat tiles (followers, videos, views), Send message and Open channel, then Edit, Email, Approve to Persons ›
     *  Creators and Restrict as chips; then cards: Recent videos (3, a tap opens one), Bio, Contact (the email with
     *  where it was found, typed by hand with its pencil; Reach: Email, Discord, WhatsApp, Instagram, one value, Save /
     *  Clear, Send), Links, Note (private), and where it was found. At the bottom the review bar: Reject / Skip /
     *  Approve, each going on to the next lead. GET /v1/collector/creator, then POST fill (an older lead's missing data,
     *  read once). */
    static final class Detail implements Collector.Screen {
        private final Collector a;
        private final Hub h;
        private final String id, title;
        private final LinearLayout root, body;
        private final Ds.TopBar bar;
        private final TextView prev, next;
        private final java.util.List<String> queue;
        private boolean busy;
        private JSONObject d;
        private String kind = "email";
        private final java.util.Map<String, String> drafts = new java.util.HashMap<>();
        private EditText field, noteField;
        private boolean filling;
        /** The note as typed (null: as saved), kept through redraws and a live restart (Collector.liveScreen). */
        String typedNote;

        String id() { return id; }
        String title() { return title; }
        java.util.List<String> queue() { return queue; }
        EditText noteField() { return noteField; }

        Detail(Collector a, String id, String name) { this(a, id, name, new java.util.ArrayList<>()); }

        Detail(Collector a, String id, String name, java.util.List<String> queue) {
            this.a = a;
            this.h = a.hub;
            this.id = id;
            this.title = name;
            this.queue = queue;
            root = Ui.col(a);
            root.setBackgroundColor(Ui.BG);
            bar = Ds.topBar(a, Ds.backButton(a, v -> a.pop()), name);
            int pos = queue.indexOf(id);
            if (pos >= 0 && queue.size() > 1) bar.sub((pos + 1) + " of " + queue.size(), Ui.G700);
            prev = bar.action(Ui.I_UP_CHEVRON, "Previous lead", v -> step(-1));
            next = bar.action(Ui.I_DOWN, "Next lead", v -> step(1));
            boolean paged = pos >= 0 && queue.size() > 1;
            prev.setVisibility(paged ? View.VISIBLE : View.GONE);
            next.setVisibility(paged ? View.VISIBLE : View.GONE);
            prev.setAlpha(pos > 0 ? 1f : 0.3f);
            next.setAlpha(pos >= 0 && pos < queue.size() - 1 ? 1f : 0.3f);
            root.addView(bar.view, Ui.fill());
            ScrollView sv = new ScrollView(a);
            body = Ui.col(a);
            body.setPadding(Ui.dp(16), Ui.dp(8), Ui.dp(16), Ui.dp(24));
            sv.addView(body);
            root.addView(sv, new LinearLayout.LayoutParams(-1, 0, 1));
            LinearLayout foot = Ui.col(a);
            foot.setBackgroundColor(Ui.BG);
            View top = new View(a);
            top.setBackgroundColor(Ui.LINE);
            foot.addView(top, new LinearLayout.LayoutParams(-1, Math.max(1, Ui.dp(0.5f))));
            // The review bar: three equal cells, hairlines between.
            LinearLayout rb = Ui.row(a);
            rb.addView(cell(Ui.I_X, false, "Reject", Ui.RED, "reject"), new LinearLayout.LayoutParams(0, Ui.dp(56), 1));
            rb.addView(rule(), new LinearLayout.LayoutParams(Math.max(1, Ui.dp(0.5f)), -1));
            rb.addView(cell(null, true, "Skip", Ui.G700, "skip"), new LinearLayout.LayoutParams(0, Ui.dp(56), 1));
            rb.addView(rule(), new LinearLayout.LayoutParams(Math.max(1, Ui.dp(0.5f)), -1));
            rb.addView(cell(Ui.I_CHECK, false, "Approve", Ui.GREEN, "approve"), new LinearLayout.LayoutParams(0, Ui.dp(56), 1));
            foot.addView(rb, Ui.fill());
            root.addView(foot, Ui.fill());
            body.addView(Ds.empty(a, "Loading…"), Ui.fill());
            load(true);
        }

        @Override public View view() { return root; }

        @Override public void shown() { load(false); }

        /** The previous (-1) or next (+1) lead of the list, in place of this one. */
        private void step(int dir) {
            int at = queue.indexOf(id) + dir;
            if (at < 0 || at >= queue.size()) return;
            String other = queue.get(at);
            a.replace(new Detail(a, other, a.nameOf(other), queue));
        }

        private View rule() {
            View v = new View(a);
            v.setBackgroundColor(Ui.LINE);
            return v;
        }

        /** One third of the review bar: its icon (or Lucide's arrow-down, drawn) and label in its colour. */
        private View cell(String glyph, boolean down, String label, int color, String what) {
            LinearLayout c = Ui.row(a);
            c.setGravity(Gravity.CENTER);
            c.setBackground(Ui.press(Ui.BG, 0, 0));
            if (glyph != null) c.addView(Ui.icon(a, glyph, 16, color), new LinearLayout.LayoutParams(Ui.dp(18), Ui.dp(18)));
            if (down) {
                ImageView iv = new ImageView(a);
                iv.setImageDrawable(new ArrowDown(color));
                c.addView(iv, new LinearLayout.LayoutParams(Ui.dp(17), Ui.dp(17)));
            }
            TextView t = Ui.bold(a, label, 15, color);
            t.setPadding(Ui.dp(7), 0, 0, 0);
            c.addView(t, Ui.wrap());
            c.setContentDescription(label);
            c.setOnClickListener(v -> review(what));
            return c;
        }

        private void review(String what) {
            if (busy || d == null) return;
            busy = true;
            a.review(id, d.optString("name", title), what, queue);
            // The next detail replaces this one; a refusal leaves it here, usable again.
            Ui.main.postDelayed(() -> busy = false, 1500);
        }

        private void load(boolean fill) {
            if (h == null) return;
            Ui.bg(a, () -> h.get("/v1/collector/creator?id=" + Collector.q(id)), r -> {
                take(r, d == null);
                if (!fill) return;
                filling = true;
                JSONObject b = new JSONObject();
                try { b.put("id", id); } catch (Exception ignored) { }
                Ui.pool.execute(() -> {
                    JSONObject f = null;
                    try { f = h.call("POST", "/v1/collector/fill", b, 60_000); } catch (Exception ignored) { }
                    final JSONObject got = f;
                    Ui.main.post(() -> {
                        filling = false;
                        if (a.isDestroyed()) return;
                        if (got != null) take(got, false); else draw();
                    });
                });
            });
        }

        /** A fresh detail; the Reach field and the note keep what was typed unless reset. */
        private void take(JSONObject r, boolean reset) {
            String typed = field != null ? field.getText().toString() : null;
            JSONObject old = d;
            d = r;
            JSONObject dr = r.optJSONObject("drafts");
            if (reset || old == null) {
                kind = r.optString("reachKind", "email");
                drafts.clear();
                for (String k : REACH) drafts.put(k, dr == null ? "" : dr.optString(k, ""));
            } else {
                if (typed != null) drafts.put(kind, typed);
                JSONObject od = old.optJSONObject("drafts");
                for (String k : REACH) {
                    String was = od == null ? "" : od.optString(k, "");
                    if (dr != null && was.equals(drafts.get(k))) drafts.put(k, dr.optString(k, ""));
                }
            }
            draw();
        }

        /** A card with a caps head (glyph, TITLE, an optional quiet action on the right); its content goes into it. */
        private LinearLayout card(String glyph, String head, String action, View.OnClickListener on) {
            LinearLayout c = Ds.card(a);
            LinearLayout r = Ui.row(a);
            r.setGravity(Gravity.CENTER_VERTICAL);
            r.setPadding(0, 0, 0, Ui.dp(8));
            r.addView(Ui.icon(a, glyph, 13, Ui.G600), new LinearLayout.LayoutParams(Ui.dp(15), Ui.dp(15)));
            TextView t = Ui.text(a, head, Ds.T_CAPS, Ui.G600);
            t.setTypeface(Ui.semi);
            t.setLetterSpacing(0.06f);
            t.setAllCaps(true);
            t.setPadding(Ui.dp(7), 0, 0, 0);
            r.addView(t, Ui.weight());
            if (action != null) {
                TextView b = Ui.bold(a, action, 13, Ui.G900);
                b.setPadding(Ui.dp(10), Ui.dp(4), Ui.dp(4), Ui.dp(4));
                b.setBackground(Ui.press(0, 0, 10));
                b.setOnClickListener(on);
                r.addView(b, Ui.wrap());
            }
            c.addView(r, Ui.fill());
            body.addView(c, Ui.margins(Ui.fill(), 0, 12, 0, 0));
            return c;
        }

        /** A small pill under the name (Approved, Restricted, Has contact). */
        private TextView tag(String s, int tone) {
            TextView t = Ui.bold(a, s, 11.5f, tone);
            t.setIncludeFontPadding(false);
            t.setPadding(Ui.dp(9), Ui.dp(4), Ui.dp(9), Ui.dp(4));
            t.setBackground(Ui.round((tone & 0x00ffffff) | 0x24000000, 0, 10));
            return t;
        }

        private void draw() {
            body.removeAllViews();
            field = null;
            noteField = null;
            if (d == null) return;
            final String name = d.optString("name"), url = d.optString("url");
            bar.title.setText(name);
            // The profile: the picture (round), the name, platform · @handle, the tags.
            LinearLayout head = Ui.col(a);
            head.setGravity(Gravity.CENTER_HORIZONTAL);
            head.setPadding(0, Ui.dp(8), 0, 0);
            android.widget.FrameLayout pic = new android.widget.FrameLayout(a);
            TextView ini = Ui.bold(a, Collector.initials(name), 30, 0xffffffff);
            ini.setGravity(Gravity.CENTER);
            ini.setIncludeFontPadding(false);
            ini.setBackground(Ui.round(Collector.color(id), 0, 44));
            pic.addView(ini, new android.widget.FrameLayout.LayoutParams(-1, -1));
            String av = d.optString("avatarId", "");
            if (!av.isEmpty() && !"null".equals(av) && h != null) {
                ImageView iv = new ImageView(a);
                iv.setScaleType(ImageView.ScaleType.CENTER_CROP);
                iv.setOutlineProvider(Thumbs.OVAL);
                iv.setClipToOutline(true);
                pic.addView(iv, new android.widget.FrameLayout.LayoutParams(-1, -1));
                Thumbs.load(a, h, "/v1/collector/avatar?id=" + av, iv, Ui.dp(88), Ui.dp(88));
            }
            head.addView(pic, new LinearLayout.LayoutParams(Ui.dp(88), Ui.dp(88)));
            TextView nm = Ui.bold(a, name, 20, Ui.FG);
            nm.setGravity(Gravity.CENTER);
            nm.setLetterSpacing(-0.01f);
            head.addView(nm, Ui.margins(Ui.wrap(), 0, 12, 0, 0));
            String handle = d.optString("handle");
            TextView who = Ui.subtitle(Ui.text(a, join(" · ", d.optString("platform"), handle), 14, Ui.G700));
            head.addView(who, Ui.margins(Ui.wrap(), 0, 3, 0, 0));
            LinearLayout tags = Ui.row(a);
            boolean restricted = d.optBoolean("restricted"), approved = !restricted && d.optBoolean("approved");
            if (approved) tags.addView(tag("Approved", Ui.GREEN), Ui.margins(Ui.wrap(), 3, 0, 3, 0));
            if (restricted) tags.addView(tag("Restricted", Ui.RED), Ui.margins(Ui.wrap(), 3, 0, 3, 0));
            if (d.optBoolean("hasContact")) tags.addView(tag("Has contact", Ui.G900), Ui.margins(Ui.wrap(), 3, 0, 3, 0));
            if (tags.getChildCount() > 0) head.addView(tags, Ui.margins(Ui.wrap(), 0, 10, 0, 0));
            body.addView(head, Ui.fill());
            // The stat tiles (only those with data): followers, videos, views.
            JSONArray st = d.optJSONArray("stats");
            if (st != null && st.length() > 0) {
                LinearLayout tiles = Ui.row(a);
                tiles.setBaselineAligned(false);
                for (int i = 0; i < st.length(); i++) {
                    JSONObject s = st.optJSONObject(i);
                    if (s == null) continue;
                    LinearLayout t = Ui.col(a);
                    t.setGravity(Gravity.CENTER_HORIZONTAL);
                    t.setPadding(Ui.dp(8), Ui.dp(10), Ui.dp(8), Ui.dp(10));
                    t.setBackground(Ui.round(Ui.CARD, Ui.LINE, 12));
                    t.addView(Ui.bold(a, s.optString("value"), 17, Ui.FG), Ui.wrap());
                    LinearLayout l = Ui.row(a);
                    l.setGravity(Gravity.CENTER_VERTICAL);
                    String ic = s.optString("icon");
                    l.addView(Ui.icon(a, "video".equals(ic) ? I_VIDEO : "heart".equals(ic) ? I_HEART : "eye".equals(ic) ? I_EYE : Ui.I_USERS, 12, Ui.G600), new LinearLayout.LayoutParams(Ui.dp(14), Ui.dp(14)));
                    l.addView(Ui.subtitle(Ui.text(a, s.optString("label"), 12, Ui.G700)), Ui.margins(Ui.wrap(), 4, 0, 0, 0));
                    t.addView(l, Ui.margins(Ui.wrap(), 0, 2, 0, 0));
                    LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, -2, 1);
                    if (i > 0) lp.leftMargin = Ui.dp(8);
                    tiles.addView(t, lp);
                }
                body.addView(tiles, Ui.margins(Ui.fill(), 0, 16, 0, 0));
            } else if (filling) {
                TextView t = Ui.text(a, "Reading their profile…", 12.5f, Ui.G600);
                t.setGravity(Gravity.CENTER);
                body.addView(t, Ui.margins(Ui.fill(), 0, 14, 0, 0));
            }
            // Send message (primary) and Open channel; then the quieter actions as chips.
            LinearLayout acts = Ui.row(a);
            TextView send = Ui.button(a, "Send message", true, v -> a.push(new Compose(a, id, name)));
            acts.addView(send, new LinearLayout.LayoutParams(0, -2, 1));
            if (!url.isEmpty()) acts.addView(Ui.button(a, d.optString("openLabel", "Open profile"), false, v -> Ui.openUrl(a, url)), Ui.margins(new LinearLayout.LayoutParams(0, -2, 1), 8, 0, 0, 0));
            body.addView(acts, Ui.margins(Ui.fill(), 0, 16, 0, 0));
            HorizontalScrollView hs = new HorizontalScrollView(a);
            hs.setHorizontalScrollBarEnabled(false);
            LinearLayout chips = Ui.row(a);
            chips.addView(Ds.chip(a, "Edit profile", false, v -> edit()), Ui.margins(Ui.wrap(), 0, 0, 6, 0));
            if (!approved) chips.addView(Ds.chip(a, "Approve to Persons › Creators", false, v -> approveToPersons(name)), Ui.margins(Ui.wrap(), 0, 0, 6, 0));
            else chips.addView(Ds.chip(a, "Unapprove", false, v -> a.post("approve", () -> load(false), "id", id, "approved", false)), Ui.margins(Ui.wrap(), 0, 0, 6, 0));
            if (!approved) chips.addView(Ds.chip(a, restricted ? "Unrestrict" : "Restrict", false, v -> a.post("restrict", () -> load(false), "id", id, "restricted", !restricted)), Ui.margins(Ui.wrap(), 0, 0, 6, 0));
            if (!url.isEmpty()) chips.addView(Ds.chip(a, "Copy link", false, v -> Ui.copy(a, url)), Ui.wrap());
            hs.addView(chips);
            body.addView(hs, Ui.margins(Ui.fill(), 0, 10, 0, 0));
            // Recent videos: three across (16:9 for YouTube, upright for Shorts, TikTok and Reels).
            JSONArray rv = d.optJSONArray("recent");
            if (rv != null && rv.length() > 0) {
                LinearLayout c = card(I_FLAME, "Recent videos", null, null);
                LinearLayout row = Ui.row(a);
                row.setBaselineAligned(false); // tops in line, whatever their titles' lines
                row.setGravity(Gravity.TOP);
                int w = (a.getResources().getDisplayMetrics().widthPixels - Ui.dp(32) - Ui.dp(Ds.CARD_PAD_X * 2) - Ui.dp(12)) / 3;
                boolean upright = !"youtube".equals(d.optString("platformKey"));
                for (int i = 0; i < 3; i++) {
                    LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, -2, 1);
                    if (i > 0) lp.leftMargin = Ui.dp(6);
                    JSONObject v = i < rv.length() ? rv.optJSONObject(i) : null;
                    if (v == null) { row.addView(new View(a), lp); continue; }
                    row.addView(tile(v, w, upright ? w * 4 / 3 : w * 9 / 16), lp);
                }
                c.addView(row, Ui.fill());
            }
            // Bio: a few lines (a tap shows it all).
            LinearLayout bc = card(I_NOTE, "Bio", null, null);
            String bio = d.optString("bio");
            if (bio.isEmpty()) bc.addView(Ui.text(a, filling ? "Reading their profile…" : "No bio on the profile.", 13.5f, Ui.G600), Ui.fill());
            else {
                TextView t = Ui.text(a, bio, 14, Ui.G900);
                t.setLineSpacing(0, 1.15f);
                t.setMaxLines(5);
                t.setEllipsize(TextUtils.TruncateAt.END);
                t.setOnClickListener(v -> { t.setMaxLines(Integer.MAX_VALUE); t.setEllipsize(null); });
                bc.addView(t, Ui.fill());
            }
            drawContact();
            drawLinks();
            drawNote();
            // Where it came from, and what happened with them.
            String via = d.optString("foundVia"), ct = d.optString("contacted"), an = d.optString("approvedNote");
            String meta = join("\n", via.isEmpty() ? "" : "Found searching “" + via + "”", ct, an);
            if (!meta.isEmpty()) {
                TextView t = Ui.text(a, meta, 12.5f, Ui.G600);
                t.setGravity(Gravity.CENTER);
                t.setLineSpacing(0, 1.2f);
                body.addView(t, Ui.margins(Ui.fill(), 0, 16, 0, 0));
            }
        }

        /** Approve and add them to Persons › Creators (no message sent): the PC's "Approve to: Persons". */
        private void approveToPersons(String name) {
            Ui.dialog(a).setTitle("Approve " + name + "?")
                    .setMessage("They leave Available for Approved and are added to Persons › Creators. No message is sent.")
                    .setPositiveButton("Approve", (x, w) -> a.post("approve", () -> load(false), "id", id, "approved", true, "to", "persons"))
                    .setNegativeButton("Cancel", null).show();
        }

        /** One recent video: its thumbnail (w x th px), two lines of title, "yesterday · 22K views"; a tap opens it. */
        private View tile(JSONObject v, int w, int th) {
            LinearLayout t = Ui.col(a);
            t.setBackground(Ui.press(0, 0, 8));
            ImageView iv = new ImageView(a);
            iv.setScaleType(ImageView.ScaleType.CENTER_CROP);
            iv.setBackground(Ui.round(Ui.G200, 0, 8));
            iv.setClipToOutline(true);
            String tid = v.optString("thumbId", "");
            Thumbs.load(a, h, tid.isEmpty() || "null".equals(tid) ? null : "/v1/collector/avatar?id=" + tid, iv, w, th);
            t.addView(iv, new LinearLayout.LayoutParams(-1, th));
            TextView ti = Ui.text(a, v.optString("title").isEmpty() ? "Untitled" : v.optString("title"), 12, Ui.FG);
            ti.setMaxLines(2);
            ti.setEllipsize(TextUtils.TruncateAt.END);
            ti.setPadding(0, Ui.dp(6), 0, 0);
            t.addView(ti, Ui.fill());
            TextView me = Ui.subtitle(Ui.text(a, v.optString("meta"), 11, Ui.G600));
            me.setPadding(0, Ui.dp(2), 0, Ui.dp(2));
            t.addView(me, Ui.fill());
            final String u = v.optString("url");
            t.setContentDescription(v.optString("title"));
            t.setOnClickListener(x -> { if (!u.isEmpty()) Ui.openUrl(a, u); });
            return t;
        }

        /** Contact: the email (where it was found; the pencil types one by hand, which a found one never replaces),
         *  then Reach: the four kinds, the picked one's value, Save / Clear, and the saved Reach's Send. */
        private void drawContact() {
            LinearLayout c = card(I_MAIL, "Contact", null, null);
            final String email = d.optString("email"), src = d.optString("emailSource");
            LinearLayout er = Ui.row(a);
            er.setGravity(Gravity.CENTER_VERTICAL);
            er.setMinimumHeight(Ui.dp(44));
            er.setBackground(Ui.press(0, 0, 10));
            er.addView(Ui.icon(a, I_MAIL, 16, Ui.G700), new LinearLayout.LayoutParams(Ui.dp(20), Ui.dp(20)));
            LinearLayout et = Ui.col(a);
            et.setPadding(Ui.dp(10), 0, Ui.dp(6), 0);
            et.addView(Ui.subtitle(Ui.text(a, email.isEmpty() ? "No email yet" : email, 14.5f, email.isEmpty() ? Ui.G600 : Ui.FG)), Ui.fill());
            if (!src.isEmpty()) et.addView(Ui.subtitle(Ui.text(a, "typed".equals(src) ? "Typed by hand" : "Found in " + src, 12, Ui.G600)), Ui.fill());
            er.addView(et, Ui.weight());
            TextView pen = Ui.icon(a, I_PENCIL, 16, Ui.G900);
            er.addView(pen, new LinearLayout.LayoutParams(Ui.dp(36), Ui.dp(36)));
            er.setContentDescription(email.isEmpty() ? "Add email" : "Edit email");
            er.setOnClickListener(v -> a.editEmail(id, email, () -> load(false)));
            c.addView(er, Ui.fill());
            View line = new View(a);
            line.setBackgroundColor(Ui.LINE);
            c.addView(line, Ui.margins(new LinearLayout.LayoutParams(-1, Math.max(1, Ui.dp(0.5f))), 0, 8, 0, 10));
            TextView rh = Ui.text(a, "Reach: one way to contact them (its icon shows on their card).", 12.5f, Ui.G600);
            c.addView(rh, Ui.fill());
            LinearLayout kinds = Ui.row(a);
            for (final String k : REACH) {
                boolean on = k.equals(kind);
                android.widget.FrameLayout b = new android.widget.FrameLayout(a);
                b.setBackground(Ui.press(on ? tint(brandColor(k)) : Ui.G100, on ? Ui.G700 : 0, 10));
                View m = brand(a, k, 18, on ? brandColor(k) : Ui.G600);
                if (!on) m.setAlpha(0.6f);
                b.addView(m, new android.widget.FrameLayout.LayoutParams(Ui.dp(18), Ui.dp(18), Gravity.CENTER));
                b.setContentDescription(reachLabel(k));
                b.setOnClickListener(v -> {
                    if (k.equals(kind)) return;
                    if (field != null) drafts.put(kind, field.getText().toString());
                    kind = k;
                    draw();
                });
                kinds.addView(b, Ui.margins(new LinearLayout.LayoutParams(Ui.dp(44), Ui.dp(40)), 0, 0, 6, 0));
            }
            c.addView(kinds, Ui.margins(Ui.fill(), 0, 8, 0, 8));
            field = Ui.input(a, "email".equals(kind) ? "name@studio.com" : "discord".equals(kind) ? "Discord user ID (17-20 digits)" : "whatsapp".equals(kind) ? "+55 21 97570-9440" : "@handle", false);
            field.setInputType("email".equals(kind) ? InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS : "whatsapp".equals(kind) ? InputType.TYPE_CLASS_PHONE : "discord".equals(kind) ? InputType.TYPE_CLASS_NUMBER : InputType.TYPE_CLASS_TEXT);
            field.setTypeface(Ui.sans);
            String dv = drafts.get(kind);
            field.setText(dv == null ? "" : dv);
            c.addView(field, Ui.fill());
            if ("whatsapp".equals(kind)) c.addView(Collector.pad(Ui.text(a, "Country code first, like +55 21 97570-9440 (a Brazilian number without it gets +55).", 12, Ui.G600), 4), Ui.fill());
            if ("discord".equals(kind)) c.addView(Collector.pad(Ui.text(a, "Enable Developer Mode, long-press a user › Copy User ID.", 12, Ui.G600), 4), Ui.fill());
            LinearLayout btns = Ui.row(a);
            btns.addView(Ui.rowButton(a, "Save", true, v -> save(field.getText().toString().trim())), Ui.wrap());
            final String saved = d.optString("reach");
            if (!saved.isEmpty()) btns.addView(Ui.rowButton(a, "Clear", false, v -> save("")), Ui.margins(Ui.wrap(), 6, 0, 0, 0));
            btns.addView(new View(a), Ui.spacer());
            String send = d.optString("reachSend");
            if (!send.isEmpty()) btns.addView(Ui.rowButton(a, send, false, v -> go(saved, d.optString("reachValue"), d.optString("reachHref"))), Ui.wrap());
            c.addView(btns, Ui.margins(Ui.fill(), 0, 8, 0, 0));
        }

        /** Links from the profile (and typed ones): the brand's mark, the title and the address; a tap opens it, a long
         *  press copies it. */
        private void drawLinks() {
            JSONArray ls = d.optJSONArray("links");
            LinearLayout c = card(Ui.I_LINK, "Links", "Edit", v -> edit());
            if (ls == null || ls.length() == 0) {
                c.addView(Ui.text(a, "No links on the profile.", 13.5f, Ui.G600), Ui.fill());
                return;
            }
            for (int i = 0; i < ls.length(); i++) {
                JSONObject l = ls.optJSONObject(i);
                if (l == null) continue;
                final String u = l.optString("url");
                LinearLayout r = Ui.row(a);
                r.setGravity(Gravity.CENTER_VERTICAL);
                r.setMinimumHeight(Ui.dp(44));
                r.setBackground(Ui.press(0, 0, 10));
                String b = l.optString("brand");
                int col = l.optString("color").startsWith("#") ? parse(l.optString("color")) : brandColor(b);
                android.widget.FrameLayout mk = new android.widget.FrameLayout(a);
                mk.setBackground(Ui.round(tint(col), 0, 8));
                mk.addView(brand(a, b, 15, col), new android.widget.FrameLayout.LayoutParams(Ui.dp(15), Ui.dp(15), Gravity.CENTER));
                r.addView(mk, new LinearLayout.LayoutParams(Ui.dp(30), Ui.dp(30)));
                LinearLayout tx = Ui.col(a);
                tx.setPadding(Ui.dp(10), 0, Ui.dp(6), 0);
                tx.addView(Ui.subtitle(Ui.text(a, l.optString("title").isEmpty() ? u : l.optString("title"), 14, Ui.FG)), Ui.fill());
                tx.addView(Ui.subtitle(Ui.text(a, u.replaceFirst("^https?://(www\\.)?", "").replaceFirst("/$", ""), 12, Ui.G600)), Ui.fill());
                r.addView(tx, Ui.weight());
                r.addView(Ui.icon(a, Ui.I_EXTERNAL, 14, Ui.G600), new LinearLayout.LayoutParams(Ui.dp(28), Ui.dp(28)));
                r.setOnClickListener(v -> { if (!u.isEmpty()) Ui.openUrl(a, u); });
                r.setOnLongClickListener(v -> { Ui.copy(a, u); return true; });
                c.addView(r, Ui.fill());
            }
        }

        private static int parse(String hex) {
            try { return android.graphics.Color.parseColor(hex); } catch (Exception e) { return Ui.G600; }
        }

        /** A private note (never exported): saved with its button. */
        private void drawNote() {
            LinearLayout c = card(I_PENCIL, "Note", null, null);
            noteField = Ui.input(a, "A quick note about them (only you see it)", true);
            noteField.setMinLines(2);
            noteField.setGravity(Gravity.TOP | Gravity.START);
            noteField.setText(typedNote != null ? typedNote : d.optString("note"));
            final EditText nf = noteField;
            nf.addTextChangedListener(new android.text.TextWatcher() {
                @Override public void beforeTextChanged(CharSequence t, int x, int y, int z) { }
                @Override public void onTextChanged(CharSequence t, int x, int y, int z) { }
                @Override public void afterTextChanged(android.text.Editable t) { if (noteField == nf) { typedNote = t.toString(); Swap.dirty(); } }
            });
            c.addView(noteField, Ui.fill());
            LinearLayout btns = Ui.row(a);
            btns.setGravity(Gravity.END);
            btns.addView(Ui.rowButton(a, "Save note", false, v -> {
                if (h == null || noteField == null) return;
                JSONObject b = new JSONObject();
                try { b.put("id", id).put("note", noteField.getText().toString().trim()); } catch (Exception ignored) { }
                Ui.bg(a, () -> h.call("POST", "/v1/collector/note", b), r -> Ui.toast(a, "Note saved"));
            }), Ui.wrap());
            c.addView(btns, Ui.margins(Ui.fill(), 0, 6, 0, 0));
        }

        private void save(String value) {
            if (h == null) return;
            if (value.isEmpty() && d.optString("reach").isEmpty()) return;
            JSONObject b = new JSONObject();
            try { b.put("id", id).put("kind", kind).put("value", value); } catch (Exception ignored) { }
            Ui.bg(a, () -> h.call("POST", "/v1/collector/reach", b), r -> {
                Ui.toast(a, value.isEmpty() ? "Reach cleared" : "Reach saved: " + reachLabel(kind));
                take(r, true);
            });
        }

        private void go(String k, String value, String href) {
            if ("email".equals(k) || "whatsapp".equals(k)) a.push(new Compose(a, id, d.optString("name"), k));
            else if (!href.isEmpty()) Ui.openUrl(a, href);
        }

        /** Edit: name, handle, bio and links typed by hand (a link a line: Title https://…). */
        private void edit() {
            JSONObject e = d == null ? null : d.optJSONObject("edit");
            if (e == null || h == null) return;
            LinearLayout box = Ui.col(a);
            box.setPadding(Ui.dp(20), Ui.dp(8), Ui.dp(20), Ui.dp(8));
            final EditText name = field(box, "Name", e.optString("name"), false);
            final EditText handle = field(box, "Handle", e.optString("handle"), false);
            final EditText bio = field(box, "Bio", e.optString("bio"), true);
            final EditText links = field(box, "Links (one a line: Title https://…)", e.optString("links"), true);
            ScrollView sv = new ScrollView(a);
            sv.addView(box);
            Ui.dialog(a).setTitle("Edit " + d.optString("name")).setView(sv)
                    .setPositiveButton("Save", (x, w) -> {
                        JSONObject b = new JSONObject();
                        try {
                            b.put("id", id).put("name", name.getText().toString()).put("handle", handle.getText().toString())
                                    .put("description", bio.getText().toString()).put("links", links.getText().toString());
                        } catch (Exception ignored) { }
                        Ui.bg(a, () -> h.call("POST", "/v1/collector/edit", b), r -> { Ui.toast(a, "Saved"); take(r, false); });
                    })
                    .setNegativeButton("Cancel", null).show();
        }

        private EditText field(LinearLayout box, String label, String value, boolean multi) {
            TextView l = Ui.text(a, label, 13, Ui.G700);
            l.setPadding(Ui.dp(2), Ui.dp(10), 0, Ui.dp(4));
            box.addView(l, Ui.fill());
            EditText e = Ui.input(a, label, multi);
            e.setText(value);
            if (multi) { e.setMinLines(3); e.setGravity(Gravity.TOP | Gravity.START); }
            box.addView(e, Ui.fill());
            return e;
        }
    }
}
