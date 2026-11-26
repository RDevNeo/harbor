package dev.harbor.app;

import android.app.AlertDialog;
import android.text.InputType;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.widget.EditText;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

/** Collector's screens over the tab: {@link Compose} (Send message) and the bar they share. */
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

        Compose(Collector a, String id, String name) {
            this.a = a;
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
            Ui.bg(a, () -> h.get("/v1/collector/compose?id=" + Collector.q(id) + "&template=" + Collector.q(template) + "&channel=" + Collector.q(channel)), r -> {
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
}
