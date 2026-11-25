package dev.harbor.app;

import android.app.Activity;
import android.text.InputType;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

/** A person's details, full screen over their chat (Person Hub's PersonPanel on the phone): the
 *  big avatar and name (a tap renames), their identities, stores and lists, Settle / Unsettle per
 *  section, their socials with the latest uploads, notes, and Delete. GET/PATCH/DELETE
 *  /v1/persons/person/{id}. */
final class PersonsPanel {
    final PersonsState p;
    final Activity a;
    final String pid, section;
    final LinearLayout view;
    private final LinearLayout body;
    private JSONObject data;
    private EditText notes;
    private String savedNotes;
    private boolean closed;

    PersonsPanel(PersonsState p, String pid, String section) {
        this.p = p;
        this.pid = pid;
        this.section = section;
        a = p.a;
        view = Ui.col(a);
        view.setBackgroundColor(Ui.BG);
        view.setClickable(true);
        LinearLayout bar = Ui.row(a);
        bar.setPadding(Ui.dp(6), Ui.dp(6), Ui.dp(6), Ui.dp(6));
        bar.setMinimumHeight(Ui.dp(56));
        TextView x = Ui.iconButton(a, Ui.I_LEFT, Ui.FG, v -> p.back());
        x.setContentDescription("Back to the chat");
        bar.addView(x);
        TextView t = Ui.bold(a, "Details", 17, Ui.FG);
        t.setGravity(Gravity.CENTER);
        bar.addView(t, Ui.weight());
        bar.addView(new View(a), new LinearLayout.LayoutParams(Ui.dp(44), Ui.dp(44)));
        view.addView(bar, Ui.fill());
        ScrollView sv = new ScrollView(a);
        body = Ui.col(a);
        body.setPadding(Ui.dp(16), Ui.dp(4), Ui.dp(16), Ui.dp(32));
        sv.addView(body);
        view.addView(sv, new LinearLayout.LayoutParams(-1, 0, 1));
        TextView loading = Ui.text(a, "Loading…", 14, Ui.G700);
        loading.setGravity(Gravity.CENTER);
        loading.setPadding(0, Ui.dp(40), 0, 0);
        body.addView(loading, Ui.fill());
        load();
    }

    private String path() { return "/v1/persons/person/" + PersonsUi.enc(pid); }

    private void load() {
        if (p.hub == null) return;
        Ui.pool.execute(() -> {
            JSONObject r = null;
            String err = null;
            try { r = p.hub.get(path()); } catch (Exception e) { err = Hub.why(e); }
            JSONObject fr = r;
            String fe = err;
            Ui.main.post(() -> {
                if (closed || a.isDestroyed()) return;
                if (fr == null) {
                    body.removeAllViews();
                    TextView t = Ui.text(a, fe, 14, Ui.RED);
                    t.setPadding(0, Ui.dp(32), 0, 0);
                    body.addView(t, Ui.fill());
                    body.addView(Ui.button(a, "Try again", false, v -> load()), Ui.margins(Ui.fill(), 0, 16, 0, 0));
                    return;
                }
                data = fr;
                render();
            });
        });
    }

    /** A new state: the settle buttons and the name follow it (notes being typed stay). */
    void stateChanged() {
        if (data == null || p.person(pid) == null || (notes != null && notes.hasFocus())) return;
        render();
    }

    void close() {
        closed = true;
        saveNotes();
    }

    private JSONObject person() {
        JSONObject q = PersonsUi.obj(data, "person");
        return q != null ? q : new JSONObject();
    }

    private void render() {
        String keep = notes != null ? notes.getText().toString() : null;
        if (notes != null) notes.setOnFocusChangeListener(null);
        body.removeAllViews();
        JSONObject q = person(), st = p.person(pid);
        String name = PersonsUi.s(st, "name");
        if (name.isEmpty()) name = PersonsUi.s(q, "name");

        // The avatar and name.
        String big = PersonsUi.s(data, "avatarBig");
        if (big.isEmpty()) big = PersonsUi.s(st, "avatar");
        FrameLayout av = PersonsUi.avatar(a, p.hub, big, PersonsUi.s(st, "initials"), PersonsUi.color(PersonsUi.s(st, "color"), Ui.G500), 88, "");
        LinearLayout.LayoutParams ap = new LinearLayout.LayoutParams(Ui.dp(88), Ui.dp(88));
        ap.gravity = Gravity.CENTER_HORIZONTAL;
        ap.topMargin = Ui.dp(8);
        body.addView(av, ap);
        LinearLayout nr = Ui.row(a);
        nr.setGravity(Gravity.CENTER);
        nr.setPadding(Ui.dp(10), Ui.dp(6), Ui.dp(10), Ui.dp(6));
        nr.setBackground(Ui.press(0, 0, 14));
        TextView nt = Ui.heading(a, name, 24);
        nt.setGravity(Gravity.CENTER);
        nr.addView(nt, new LinearLayout.LayoutParams(-2, -2, 0));
        nr.addView(Ui.icon(a, Ui.I_PEN, 15, Ui.G600), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(18), Ui.dp(18)), 8, 0, 0, 0));
        String fname = name;
        nr.setOnClickListener(v -> PersonsHome.rename(p, pid, fname));
        nr.setContentDescription("Rename " + name);
        LinearLayout.LayoutParams np = Ui.wrap();
        np.gravity = Gravity.CENTER_HORIZONTAL;
        np.topMargin = Ui.dp(6);
        body.addView(nr, np);
        List<String> handle = new ArrayList<>();
        if (!PersonsUi.s(q, "discordUsername").isEmpty()) handle.add("@" + PersonsUi.s(q, "discordUsername"));
        String dn = PersonsUi.s(q, "displayName");
        if (!dn.isEmpty() && !dn.equals(name)) handle.add(dn);
        if (!handle.isEmpty()) {
            TextView h = Ui.text(a, TextUtils.join(" · ", handle), 14, Ui.G700);
            h.setGravity(Gravity.CENTER);
            body.addView(h, Ui.fill());
        }

        // Accounts.
        List<JSONObject> ids = PersonsHome.objs(PersonsUi.arr(data, "identities"));
        if (ids.isEmpty()) {
            if (!PersonsUi.s(q, "discordId").isEmpty()) ids.add(ident("discord", PersonsUi.s(q, "discordId"), ""));
            if (!PersonsUi.s(q, "whatsapp").isEmpty()) ids.add(ident("whatsapp", "+" + PersonsUi.s(q, "whatsapp"), ""));
            if (!PersonsUi.s(q, "email").isEmpty()) ids.add(ident("gmail", PersonsUi.s(q, "email"), ""));
        }
        if (!ids.isEmpty()) {
            body.addView(label("Accounts"));
            LinearLayout card = Ui.card(a);
            boolean firstRow = true;
            for (JSONObject i : ids) {
                if (!firstRow) card.addView(Ui.gap(a));
                firstRow = false;
                String kind = PersonsUi.s(i, "kind"), value = PersonsUi.s(i, "value"), lab = PersonsUi.s(i, "label");
                String sec = PersonsUi.s(i, "section");
                String title = lab.isEmpty() ? value : lab;
                String sub = (lab.isEmpty() || lab.equals(value) ? "" : value) + (sec.isEmpty() ? "" : (lab.isEmpty() || lab.equals(value) ? "" : " · ") + PersonsUi.sectionLabel(sec));
                LinearLayout r = Ui.cardRow(a, PersonsUi.channel(a, kind, 22), title, sub, Ui.FG, v -> Ui.copy(a, value));
                r.setMinimumHeight(Ui.dp(52));
                r.addView(Ui.icon(a, Ui.I_COPY, 16, Ui.G600), new LinearLayout.LayoutParams(Ui.dp(22), Ui.dp(22)));
                r.setContentDescription(PersonsUi.kindLabel(kind) + " " + title + ": copy");
                card.addView(r, Ui.fill());
            }
            body.addView(card, Ui.fill());
        }

        // Stores and lists.
        List<JSONObject> stores = PersonsHome.objs(PersonsUi.arr(data, "stores"));
        body.addView(label("Stores"));
        body.addView(chips(stores, "Not in any store."), Ui.fill());
        List<JSONObject> lists = PersonsHome.objs(PersonsUi.arr(data, "lists"));
        if (lists.isEmpty() && st != null) {
            JSONArray li = PersonsUi.arr(st, "listIds");
            for (JSONObject l : PersonsHome.objs(PersonsUi.arr(p.st, "lists")))
                if (PersonsUi.has(li, PersonsUi.s(l, "id"))) lists.add(l);
        }
        body.addView(label("Lists"));
        body.addView(chips(lists, "In no list."), Ui.fill());

        // Settle / Unsettle in each section they're in.
        List<String> secs = sections(st, stores, lists);
        if (!secs.isEmpty() && st != null) {
            body.addView(label("Settled"));
            LinearLayout card = Ui.card(a);
            boolean firstRow = true;
            for (String s : secs) {
                if (!firstRow) card.addView(Ui.gap(a));
                firstRow = false;
                boolean done = PersonsHome.settled(st, s);
                String lab = (done ? "Unsettle in " : "Settle in ") + PersonsUi.sectionLabel(s);
                LinearLayout r = Ui.cardRow(a, Ui.I_ARCHIVE, lab, done ? "Settled: in the section's Settled fold" : "Leaves the section's list for its Settled fold", Ui.FG,
                        v -> PersonsHome.settle(p, pid, s, !done));
                r.setMinimumHeight(Ui.dp(56));
                card.addView(r, Ui.fill());
            }
            body.addView(card, Ui.fill());
        }

        // Socials.
        List<JSONObject> socials = PersonsHome.objs(PersonsUi.arr(data, "socials"));
        if (!socials.isEmpty()) {
            body.addView(label("Socials"));
            for (JSONObject so : socials) body.addView(social(so), Ui.margins(Ui.fill(), 0, 0, 0, 10));
        }

        // SpokPay, as the PC gives it.
        JSONObject sp = PersonsUi.obj(data, "spokpay");
        if (sp != null && sp.length() > 0) {
            body.addView(label("SpokPay"));
            LinearLayout c = Ui.card(a);
            c.setPadding(Ui.dp(16), Ui.dp(10), Ui.dp(16), Ui.dp(10));
            for (Iterator<String> it = sp.keys(); it.hasNext(); ) {
                String k = it.next();
                Object v = sp.opt(k);
                if (v == null || v == JSONObject.NULL || v instanceof JSONObject || v instanceof JSONArray) continue;
                c.addView(Ui.text(a, k + ": " + v, 14, Ui.G900), Ui.margins(Ui.fill(), 0, 2, 0, 2));
            }
            if (c.getChildCount() > 0) body.addView(c, Ui.fill());
        }

        // Notes.
        body.addView(label("Notes"));
        notes = Ui.input(a, "Add a note…", true);
        notes.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        notes.setMinLines(3);
        notes.setGravity(Gravity.TOP | Gravity.START);
        if (savedNotes == null) savedNotes = PersonsUi.s(q, "notes");
        notes.setText(keep != null ? keep : savedNotes);
        notes.setOnFocusChangeListener((v, has) -> { if (!has) saveNotes(); });
        body.addView(notes, Ui.fill());

        // Delete.
        TextView del = Ui.danger(Ui.button(a, "Delete person", false, v -> confirmDelete(fname)));
        body.addView(del, Ui.margins(Ui.fill(), 0, 28, 0, 0));
    }

    private static JSONObject ident(String kind, String value, String section) {
        JSONObject o = PersonsUi.put(new JSONObject(), "kind", kind);
        PersonsUi.put(o, "value", value);
        PersonsUi.put(o, "section", section);
        return o;
    }

    private TextView label(String s) {
        TextView t = Ui.text(a, s, 13, Ui.G700);
        t.setPadding(Ui.dp(6), Ui.dp(20), Ui.dp(6), Ui.dp(6));
        return t;
    }

    /** Names as chips that wrap onto as many lines as they need. */
    private View chips(List<JSONObject> items, String none) {
        if (items.isEmpty()) {
            TextView t = Ui.text(a, none, 14, Ui.G700);
            t.setPadding(Ui.dp(6), 0, Ui.dp(6), 0);
            return t;
        }
        LinearLayout col = Ui.col(a);
        int avail = a.getResources().getDisplayMetrics().widthPixels - Ui.dp(32);
        LinearLayout row = null;
        int used = 0;
        for (JSONObject o : items) {
            TextView c = Ui.text(a, PersonsUi.s(o, "name"), 14, Ui.FG);
            c.setPadding(Ui.dp(12), Ui.dp(5), Ui.dp(12), Ui.dp(5));
            c.setBackground(Ui.round(Ui.CARD, Ui.LINE, 14));
            c.setSingleLine(true);
            c.setEllipsize(TextUtils.TruncateAt.END);
            c.setMaxWidth(avail);
            int w = (int) c.getPaint().measureText(c.getText().toString()) + Ui.dp(32);
            if (row == null || used + w > avail) {
                row = Ui.row(a);
                col.addView(row, Ui.margins(Ui.fill(), 0, 0, 0, 6));
                used = 0;
            }
            row.addView(c, Ui.margins(Ui.wrap(), 0, 0, 6, 0));
            used += w;
        }
        return col;
    }

    /** The sections they're in: Stores (a member or an owner), and each section list. */
    private List<String> sections(JSONObject st, List<JSONObject> stores, List<JSONObject> lists) {
        List<String> out = new ArrayList<>();
        boolean inStore = !stores.isEmpty() || (st != null && PersonsUi.arr(st, "storeIds").length() > 0);
        if (!inStore && p.st != null) for (JSONObject s : PersonsHome.objs(PersonsUi.arr(p.st, "stores")))
            if (pid.equals(PersonsUi.s(s, "ownerId"))) inStore = true;
        if (inStore) out.add("stores");
        JSONArray li = PersonsUi.arr(st, "listIds");
        for (String s : new String[]{"creators", "spokpay"}) {
            boolean in = PersonsUi.has(li, s);
            for (JSONObject l : lists) if (s.equals(PersonsUi.s(l, "id"))) in = true;
            if (in) out.add(s);
        }
        return out;
    }

    /** A profile: platform and handle (a tap opens it), then its latest uploads. */
    private View social(JSONObject so) {
        LinearLayout c = Ui.card(a);
        String url = PersonsUi.s(so, "url"), platform = PersonsUi.s(so, "platform"), handle = PersonsUi.s(so, "handle");
        String title = platform.isEmpty() ? url : Character.toUpperCase(platform.charAt(0)) + platform.substring(1);
        LinearLayout head = Ui.cardRow(a, Ui.I_GLOBE, title, handle.isEmpty() ? url : (handle.startsWith("@") ? handle : "@" + handle), Ui.FG,
                url.isEmpty() ? null : v -> Ui.openUrl(a, url));
        head.setMinimumHeight(Ui.dp(52));
        if (!url.isEmpty()) head.addView(Ui.icon(a, Ui.I_EXTERNAL, 16, Ui.G600), new LinearLayout.LayoutParams(Ui.dp(22), Ui.dp(22)));
        c.addView(head, Ui.fill());
        for (JSONObject u : PersonsHome.objs(PersonsUi.arr(so, "uploads"))) {
            c.addView(Ui.gap(a));
            c.addView(upload(u), Ui.fill());
        }
        return c;
    }

    /** One upload: a 16:9 thumbnail, the title, "22d ago · 140K views"; a tap opens it. */
    private View upload(JSONObject u) {
        LinearLayout r = Ui.row(a);
        r.setPadding(Ui.dp(14), Ui.dp(10), Ui.dp(14), Ui.dp(10));
        String url = PersonsUi.s(u, "url");
        if (!url.isEmpty()) {
            r.setBackground(Ui.press(0, 0, 0));
            r.setOnClickListener(v -> Ui.openUrl(a, url));
        }
        ImageView iv = new ImageView(a);
        iv.setScaleType(ImageView.ScaleType.CENTER_CROP);
        iv.setBackground(Ui.round(Ui.G200, 0, 8));
        iv.setClipToOutline(true);
        String thumb = PersonsUi.s(u, "thumb");
        if (!thumb.isEmpty()) PersonsUi.image(a, p.hub, thumb, iv, Ui.dp(120), null);
        r.addView(iv, new LinearLayout.LayoutParams(Ui.dp(112), Ui.dp(63)));
        LinearLayout t = Ui.col(a);
        String title = PersonsUi.s(u, "title");
        TextView tt = Ui.text(a, title.isEmpty() ? "Untitled" : title, 14, Ui.FG);
        tt.setMaxLines(2);
        tt.setEllipsize(TextUtils.TruncateAt.END);
        t.addView(tt);
        List<String> meta = new ArrayList<>();
        String ag = PersonsUi.age(PersonsUi.ms(PersonsUi.s(u, "at")));
        if (!ag.isEmpty()) meta.add(ag);
        if (u.has("views") && !u.isNull("views")) meta.add(PersonsUi.count(u.optDouble("views")) + " views");
        if (!meta.isEmpty()) t.addView(Ui.text(a, TextUtils.join(" · ", meta), 12, Ui.G600), Ui.margins(Ui.wrap(), 0, 2, 0, 0));
        r.addView(t, Ui.margins(Ui.weight(), 12, 0, 0, 0));
        return r;
    }

    private void saveNotes() {
        if (notes == null || data == null) return;
        String now = notes.getText().toString();
        if (now.equals(savedNotes == null ? "" : savedNotes)) return;
        savedNotes = now;
        PersonsHome.patch(p, pid, PersonsUi.put(new JSONObject(), "notes", now), null);
    }

    private void confirmDelete(String name) {
        Ui.dialog(a).setTitle("Delete " + name + "?")
                .setMessage("They leave Persons: their stores, lists and notes here. Their conversations stay on Discord, Gmail and WhatsApp.")
                .setPositiveButton("Delete", (d, w) -> Ui.bg(a, () -> p.hub.call("DELETE", path(), null), r -> {
                    if (!r.optBoolean("ok", true)) { Ui.toast(a, r.optString("error", "Couldn't delete them")); return; }
                    notes = null; // nothing to save for someone deleted
                    p.gone();
                    p.refresh();
                    Ui.toast(a, name + " deleted");
                }))
                .setNegativeButton("Cancel", null).show();
    }
}
