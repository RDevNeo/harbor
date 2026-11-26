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

/** Collector's creator screen (a row tapped): who they are, their stats, bio, email (found where, or typed by hand,
 *  and a field to type one), WhatsApp, every link of their bio and where it came from, what the daily update changed,
 *  their recent uploads, Update now and Send message. It opens over the tab, in the Collector activity
 *  (Collector.push), from GET /v1/collector/creator?id=. {@link Compose} is Send message. */
final class CollectorCreator implements Collector.Screen {
    private final Collector a;
    private final Hub h;
    private final String id;
    private final LinearLayout root, body;
    private final TextView title;
    private JSONObject d;
    private EditText email;
    private boolean updating, saving;

    CollectorCreator(Collector a, String id) {
        this.a = a;
        this.h = a.hub;
        this.id = id;
        root = Ui.col(a);
        root.setBackgroundColor(Ui.BG);
        LinearLayout bar = topBar(a, "", a::pop);
        title = (TextView) bar.getChildAt(1);
        root.addView(bar, Ui.fill());
        ScrollView sv = new ScrollView(a);
        body = Ui.col(a);
        body.setPadding(Ui.dp(16), Ui.dp(4), Ui.dp(16), Ui.dp(24));
        sv.addView(body);
        root.addView(sv, new LinearLayout.LayoutParams(-1, 0, 1));
        // Send message stays under the thumb, whatever the scroll.
        LinearLayout foot = Ui.col(a);
        foot.setPadding(Ui.dp(16), Ui.dp(8), Ui.dp(16), Ui.dp(12));
        View line = new View(a);
        line.setBackgroundColor(Ui.LINE);
        root.addView(line, new LinearLayout.LayoutParams(-1, Math.max(1, Ui.dp(0.5f))));
        foot.addView(Ui.button(a, "Send message", true, v -> a.push(new Compose(a, id, d == null ? "" : d.optString("name")))), Ui.fill());
        root.addView(foot, Ui.fill());
        body.addView(Ds.empty(a, "Loading…"), Ui.fill());
        load();
    }

    @Override public View view() { return root; }

    @Override public void shown() { if (email == null || !email.hasFocus()) load(); }

    private void load() {
        if (h == null) return;
        Ui.bg(a, () -> h.get("/v1/collector/creator?id=" + Collector.q(id)), r -> { d = r; draw(); });
    }

    private void draw() {
        body.removeAllViews();
        email = null;
        if (d == null) return;
        String name = d.optString("name");
        title.setText(name);
        // Who: picture, name, handle, platform, contacted.
        LinearLayout head = Ui.row(a);
        head.setPadding(0, Ui.dp(6), 0, Ui.dp(4));
        head.addView(Collector.avatar(a, h, d, 64));
        LinearLayout who = Ui.col(a);
        who.setPadding(Ui.dp(14), 0, 0, 0);
        TextView nm = Ui.bold(a, name, 20, Ui.FG);
        nm.setMaxLines(2);
        nm.setEllipsize(TextUtils.TruncateAt.END);
        who.addView(nm, Ui.fill());
        String sub = join(" · ", d.optString("handle"), d.optString("country"));
        if (!sub.isEmpty()) who.addView(Ui.subtitle(Ui.text(a, sub, 13.5f, Ui.G700)), Ui.fill());
        LinearLayout tags = Ui.row(a);
        if (!d.optString("platform").isEmpty()) tags.addView(Collector.badge(a, d.optString("platform"), Ui.G700), Ui.margins(Ui.wrap(), 0, 0, 6, 0));
        if (d.optBoolean("discord")) tags.addView(Collector.badge(a, "Discord", Ui.BLUE), Ui.margins(Ui.wrap(), 0, 0, 6, 0));
        if (!d.optString("contacted").isEmpty()) tags.addView(Collector.badge(a, d.optString("contacted"), Ui.GREEN), Ui.wrap());
        if (tags.getChildCount() > 0) who.addView(tags, Ui.margins(Ui.fill(), 0, 6, 0, 0));
        head.addView(who, Ui.weight());
        body.addView(head, Ui.fill());
        // Open profile, Update now.
        LinearLayout btns = Ui.row(a);
        final String url = d.optString("url");
        TextView open = Ui.button(a, "Open profile", false, url.isEmpty() ? null : v -> Ui.openUrl(a, url));
        btns.addView(open, Ui.weight());
        TextView upd = Ui.button(a, updating ? "Updating…" : "Update now", false, updating ? null : v -> update());
        if (updating) upd.setAlpha(0.6f);
        btns.addView(upd, Ui.margins(Ui.weight(), 8, 0, 0, 0));
        body.addView(btns, Ui.margins(Ui.fill(), 0, 12, 0, 0));
        String updated = d.optString("updated");
        if (!updated.isEmpty()) {
            boolean failed = !d.optString("updateError").isEmpty();
            body.addView(Collector.pad(Ui.text(a, updated, 12.5f, failed ? Ui.RED : Ui.G600), 8), Ui.fill());
        }
        // Stats, two to a row.
        JSONArray st = d.optJSONArray("stats");
        if (st != null && st.length() > 0) {
            LinearLayout grid = Ds.card(a);
            LinearLayout r = null;
            for (int i = 0; i < st.length(); i++) {
                JSONObject s = st.optJSONObject(i);
                if (s == null) continue;
                if (r == null || r.getChildCount() == 2) {
                    r = Ui.row(a);
                    r.setGravity(Gravity.TOP);
                    grid.addView(r, Ui.margins(Ui.fill(), 0, grid.getChildCount() == 0 ? 0 : 10, 0, 0));
                }
                LinearLayout cell = Ui.col(a);
                cell.addView(Ui.bold(a, s.optString("value"), 18, Ui.FG), Ui.wrap());
                cell.addView(Ui.text(a, s.optString("label"), 12.5f, Ui.G600), Ui.wrap());
                r.addView(cell, Ui.weight());
            }
            if (r != null && r.getChildCount() == 1) r.addView(new View(a), Ui.weight());
            body.addView(grid, Ui.margins(Ui.fill(), 0, 12, 0, 0));
        }
        // Bio.
        String bio = d.optString("description");
        if (!bio.isEmpty()) {
            body.addView(head("BIO"), Ui.fill());
            TextView b = Ui.text(a, bio, 14, Ui.FG);
            b.setTextIsSelectable(true);
            body.addView(b, Ui.fill());
        }
        drawEmail();
        // WhatsApp.
        final String wa = d.optString("whatsapp");
        if (!wa.isEmpty()) {
            body.addView(head("WHATSAPP"), Ui.fill());
            LinearLayout r = Ui.row(a);
            r.setPadding(Ui.dp(4), Ui.dp(8), Ui.dp(4), Ui.dp(8));
            r.setBackground(Ui.press(0, 0, 12));
            r.addView(Ui.bold(a, wa, 15, Ui.FG), Ui.weight());
            r.addView(Ui.icon(a, Ui.I_EXTERNAL, 16, Ui.G600), new LinearLayout.LayoutParams(Ui.dp(22), Ui.dp(22)));
            r.setOnClickListener(v -> Ui.openUrl(a, "https://wa.me/" + wa.replaceAll("[^0-9]", "")));
            r.setOnLongClickListener(v -> { Ui.copy(a, wa); return true; });
            body.addView(r, Ui.fill());
        }
        // Links.
        JSONArray links = d.optJSONArray("links");
        if (links != null && links.length() > 0) {
            body.addView(head("LINKS  " + links.length()), Ui.fill());
            for (int i = 0; i < links.length(); i++) {
                JSONObject l = links.optJSONObject(i);
                if (l != null) body.addView(link(l), Ui.fill());
            }
        }
        // Updates.
        body.addView(head("UPDATES"), Ui.fill());
        JSONArray hist = d.optJSONArray("history");
        if (hist == null || hist.length() == 0) {
            body.addView(Ui.text(a, updated.isEmpty() ? "Not updated yet. The daily update looks at them once a day." : "No changes seen yet.", 13, Ui.G700), Ui.fill());
        } else {
            for (int i = 0; i < hist.length(); i++) {
                JSONObject e = hist.optJSONObject(i);
                if (e == null) continue;
                TextView w = Ui.text(a, e.optString("when"), 12, Ui.G600);
                w.setPadding(0, Ui.dp(i == 0 ? 0 : 8), 0, Ui.dp(2));
                body.addView(w, Ui.fill());
                JSONArray ch = e.optJSONArray("changes");
                for (int j = 0; ch != null && j < ch.length(); j++) body.addView(Ui.text(a, "• " + ch.optString(j), 13.5f, Ui.FG), Ui.fill());
            }
        }
        // Recent uploads.
        JSONArray rec = d.optJSONArray("recent");
        if (rec != null && rec.length() > 0) {
            body.addView(head("Instagram".equals(d.optString("platform")) ? "RECENT POSTS" : "RECENT UPLOADS"), Ui.fill());
            for (int i = 0; i < rec.length(); i++) {
                JSONObject v = rec.optJSONObject(i);
                if (v == null) continue;
                LinearLayout r = Ui.col(a);
                r.setPadding(Ui.dp(4), Ui.dp(8), Ui.dp(4), Ui.dp(8));
                r.setBackground(Ui.press(0, 0, 12));
                TextView t = Ui.text(a, v.optString("title").isEmpty() ? "(untitled)" : v.optString("title"), 14, Ui.FG);
                t.setMaxLines(2);
                t.setEllipsize(TextUtils.TruncateAt.END);
                r.addView(t, Ui.fill());
                String m = join(" · ", v.optString("when"), v.optString("views"));
                if (!m.isEmpty()) r.addView(Ui.text(a, m, 12, Ui.G600), Ui.fill());
                final String vu = v.optString("url");
                if (!vu.isEmpty()) r.setOnClickListener(x -> Ui.openUrl(a, vu));
                body.addView(r, Ui.fill());
            }
        }
        String found = d.optString("found");
        if (!found.isEmpty()) body.addView(Collector.pad(Ui.text(a, found, 12, Ui.G600), 18), Ui.fill());
    }

    /** The email: what's known and where it came from, and a field to type one (Save; saved empty, the daily update
     *  looks for one again). */
    private void drawEmail() {
        body.addView(head("EMAIL"), Ui.fill());
        LinearLayout card = Ds.card(a);
        final String em = d.optString("email");
        boolean manual = d.optBoolean("emailManual");
        if (!em.isEmpty()) {
            TextView t = Ui.bold(a, em, 16, Ui.FG);
            t.setOnClickListener(v -> Ui.copy(a, em));
            card.addView(t, Ui.fill());
            String src = d.optString("emailSource");
            String how = manual || "typed".equals(src) ? "typed by hand" : src.isEmpty() ? "" : "found in " + src;
            if (!how.isEmpty()) card.addView(Ui.text(a, how, 12.5f, Ui.G600), Ui.fill());
        } else {
            card.addView(Ui.text(a, "No email yet. The daily update keeps looking in their links; or type one.", 13, Ui.G700), Ui.fill());
        }
        LinearLayout r = Ui.row(a);
        email = Ui.input(a, "name@example.com", false);
        email.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        email.setTypeface(Ui.sans);
        email.setText(em);
        r.addView(email, Ui.weight());
        final EditText f = email;
        TextView save = Ui.rowButton(a, saving ? "Saving…" : "Save", true, saving ? null : v -> saveEmail(f.getText().toString().trim()));
        r.addView(save, Ui.margins(Ui.wrap(), 8, 0, 0, 0));
        card.addView(r, Ui.margins(Ui.fill(), 0, 10, 0, 0));
        if (manual) card.addView(Collector.pad(Ui.text(a, "Save it empty to let the daily update find one again.", 12, Ui.G600), 6), Ui.fill());
        body.addView(card, Ui.fill());
    }

    private void saveEmail(String value) {
        if (h == null || saving) return;
        saving = true;
        draw();
        JSONObject b = new JSONObject();
        try { b.put("id", id).put("email", value); } catch (Exception ignored) { }
        Ui.pool.execute(() -> {
            try {
                JSONObject r = h.call("POST", "/v1/collector/email", b);
                Ui.main.post(() -> {
                    saving = false;
                    if (r != null && r.has("id")) d = r;
                    Ui.toast(a, value.isEmpty() ? "Email cleared" : "Email saved");
                    if (!a.isDestroyed()) draw();
                });
            } catch (Exception e) {
                Ui.main.post(() -> { saving = false; Ui.toast(a, h.whyDown(e)); if (!a.isDestroyed()) draw(); });
            }
        });
    }

    /** POST refresh {id}: this creator now (its answer is their details, updated). */
    private void update() {
        if (h == null || updating) return;
        updating = true;
        draw();
        JSONObject b = new JSONObject();
        try { b.put("id", id); } catch (Exception ignored) { }
        Ui.pool.execute(() -> {
            try {
                JSONObject r = h.call("POST", "/v1/collector/refresh", b, 120_000);
                Ui.main.post(() -> {
                    updating = false;
                    if (r != null && r.has("id")) d = r;
                    Ui.toast(a, r == null || r.optString("updated").isEmpty() ? "Updated" : r.optString("updated"));
                    if (!a.isDestroyed()) draw();
                });
            } catch (Exception e) {
                Ui.main.post(() -> { updating = false; Ui.toast(a, h.whyDown(e)); if (!a.isDestroyed()) draw(); });
            }
        });
    }

    /** One link: its label, the address short, where it was found; a tap opens it, a long press copies it. */
    private View link(JSONObject l) {
        LinearLayout r = Ui.row(a);
        r.setGravity(Gravity.CENTER_VERTICAL);
        r.setPadding(Ui.dp(4), Ui.dp(8), Ui.dp(4), Ui.dp(8));
        r.setBackground(Ui.press(0, 0, 12));
        r.addView(Ui.icon(a, Ui.I_LINK, 16, Ui.G600), new LinearLayout.LayoutParams(Ui.dp(22), Ui.dp(22)));
        LinearLayout t = Ui.col(a);
        t.setPadding(Ui.dp(10), 0, 0, 0);
        LinearLayout l1 = Ui.row(a);
        l1.addView(Ui.subtitle(Ui.bold(a, l.optString("label"), 14, Ui.FG)), new LinearLayout.LayoutParams(0, -2, 1));
        String kind = l.optString("kindLabel");
        if (!kind.isEmpty() && !kind.equalsIgnoreCase(l.optString("label"))) l1.addView(Collector.badge(a, kind, Ui.G700), Ui.margins(Ui.wrap(), 6, 0, 0, 0));
        t.addView(l1, Ui.fill());
        t.addView(Ui.subtitle(Ui.text(a, l.optString("short"), 12.5f, Ui.G700)), Ui.fill());
        String src = l.optString("source");
        if (!src.isEmpty()) t.addView(Ui.subtitle(Ui.text(a, "from " + src, 12, Ui.G600)), Ui.fill());
        r.addView(t, Ui.weight());
        final String u = l.optString("url");
        r.setOnClickListener(v -> Ui.openUrl(a, u));
        r.setOnLongClickListener(v -> { Ui.copy(a, u); return true; });
        return r;
    }

    private TextView head(String s) {
        TextView t = Ds.caps(a, s, false);
        t.setPadding(Ui.dp(4), Ui.dp(18), 0, Ui.dp(6));
        return t;
    }

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
