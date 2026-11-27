package dev.harbor.app;

import android.app.Activity;
import android.graphics.drawable.ColorDrawable;
import android.view.View;
import android.view.ViewGroup;
import android.widget.BaseAdapter;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

/** The Persons tab's home, Person Hub's sidebar on the phone: Stores (each store a fold with its people, the owner
 *  first with a crown), then each list (Creators, SpokPay) with its people by their last message, each section with a
 *  "Settled (N)" fold (no connection chips: only a sign-in waiting for its QR code shows; All people is the head's
 *  magnifier). A long press on a person: Rename, Settle / Unsettle, Link with…, Unlink, Move to… (SpokPay,
 *  Creators, Stores › a store or New store…).
 *  At the top of SpokPay: Headquarters' "Site requests" list (the state's siteRequests): its heading (amber dot while one
 *  waits on SpokPay, the count, the chevron), its notices, and each active request (the store's square icon, the
 *  subject, "Store replied" / "Store waiting" / "Nothing new", the ref); a tap opens its pane (PersonsSr, SpokPay's admin request page), a long
 *  press copies the link. */
final class PersonsHome {
    static final int HEAD = 1, QR = 3, NOTE = 4, STORE = 5, PERSON = 6, FOLD = 7,
            SR_HEAD = 8, SR_NOTICE = 9, SR = 10, ADD = 11;

    static final class Item {
        final int kind;
        String section = "", text = "", key = "";
        JSONObject person, store, sr;
        List<JSONObject> conns;
        /** Add contact in Stores: the stores they can go in. */
        List<JSONObject> stores;
        boolean owner, settled, open, indent;
        int count, unread;
        Item(int kind) { this.kind = kind; }
    }

    final PersonsState p;
    final Activity a;
    final LinearLayout view;
    private final TextView error;
    private final List<Item> items = new ArrayList<>();
    private final BaseAdapter adapter;

    /** The tab's page (`drawer` false: under the top bar "Persons") or the tab's drawer (the same list, on BG2). */
    PersonsHome(PersonsState p, boolean drawer) {
        this.p = p;
        a = p.a;
        view = Ui.col(a);
        view.setBackgroundColor(Ui.BG);
        view.setClickable(true);
        // The drawer's head is every tab's (Ds.drawerHead); the page has the top bar. Both search everyone (All
        // people) from their magnifier: no "All people" row in the list.
        if (drawer) {
            Ds.DrawerHead h = Ds.drawerHead(a, "Persons");
            h.action(Ui.I_SEARCH, "Search people", v -> p.openList());
            view.addView(h.view, Ui.fill());
        } else {
            Ds.TopBar bar = Ds.topBar(a, p.sideButton(), "Persons");
            bar.action(Ui.I_SEARCH, "Search people", v -> p.openList());
            view.addView(bar.view, Ui.fill());
        }
        error = Ui.text(a, "", 13, Ui.RED);
        error.setPadding(Ui.dp(20), 0, Ui.dp(20), Ui.dp(6));
        error.setVisibility(View.GONE);
        view.addView(error, Ui.fill());
        ListView lv = list(a);
        adapter = new BaseAdapter() {
            @Override public int getCount() { return items.size(); }
            @Override public Object getItem(int i) { return items.get(i); }
            @Override public long getItemId(int i) { return i; }
            @Override public boolean isEnabled(int i) { return false; }
            @Override public View getView(int i, View convert, ViewGroup parent) { return itemView(items.get(i)); }
        };
        lv.setAdapter(adapter);
        view.addView(lv, new LinearLayout.LayoutParams(-1, 0, 1));
        render();
    }

    /** A plain list: no dividers or selection drawn by the list itself (rows press themselves). */
    static ListView list(Activity a) {
        ListView lv = new ListView(a);
        lv.setDivider(null);
        lv.setDividerHeight(0);
        lv.setSelector(new ColorDrawable(0));
        lv.setCacheColorHint(0);
        lv.setClipToPadding(false);
        lv.setPadding(0, Ui.dp(4), 0, Ui.dp(24));
        lv.setVerticalScrollBarEnabled(false);
        return lv;
    }

    // ---- the items, from the state ----

    void render() {
        error.setText(p.error == null ? "" : p.error);
        error.setVisibility(p.error == null ? View.GONE : View.VISIBLE);
        items.clear();
        JSONObject st = p.st;
        if (p.hub == null) {
            note("No PC: pair one first.", false);
        } else if (st == null) {
            note(p.error == null ? "Loading…" : "", false);
        } else {
            build(st);
        }
        adapter.notifyDataSetChanged();
    }

    private void note(String s, boolean indent) {
        Item n = new Item(NOTE);
        n.text = s;
        n.indent = indent;
        items.add(n);
    }

    /** A section's Add contact row (every section, as the PC's section menus add someone to each). */
    private void addRow(String section, List<JSONObject> stores) {
        Item it = new Item(ADD);
        it.section = section;
        it.stores = stores;
        items.add(it);
    }

    private void build(JSONObject st) {
        JSONArray people = PersonsUi.arr(st, "people"), stores = PersonsUi.arr(st, "stores"),
                lists = PersonsUi.arr(st, "lists"), conns = PersonsUi.arr(st, "connections");

        // Stores: the store people are everyone in a store or owning one.
        List<JSONObject> stList = objs(stores);
        Collections.sort(stList, (x, y) -> PersonsUi.s(x, "name").compareToIgnoreCase(PersonsUi.s(y, "name")));
        List<JSONObject> storePeople = new ArrayList<>();
        for (JSONObject q : objs(people)) {
            if (PersonsUi.arr(q, "storeIds").length() > 0 || owns(stList, PersonsUi.s(q, "id"))) storePeople.add(q);
        }
        Item h = head("stores", "Stores", "stores", storePeople);
        if (h.open) {
            sectionConns("stores", conns);
            if (!stList.isEmpty()) addRow("stores", stList);
            if (stList.isEmpty()) note("No stores yet.", false);
            for (JSONObject s : stList) {
                String sid = PersonsUi.s(s, "id");
                Item si = new Item(STORE);
                si.store = s;
                si.count = s.has("count") ? s.optInt("count") : members(people, sid).size();
                si.open = p.in("stores_open", sid);
                items.add(si);
                if (!si.open) continue;
                String ownerId = PersonsUi.s(s, "ownerId");
                JSONObject owner = ownerId.isEmpty() ? null : p.person(ownerId);
                boolean any = false;
                if (owner != null && !settled(owner, "stores")) {
                    Item o = person(owner, "stores");
                    o.store = s;
                    o.owner = true;
                    o.indent = true;
                    any = true;
                }
                List<JSONObject> ms = new ArrayList<>();
                for (JSONObject q : members(people, sid)) {
                    if (!PersonsUi.s(q, "id").equals(ownerId) && !settled(q, "stores")) ms.add(q);
                }
                Collections.sort(ms, recent("stores"));
                for (JSONObject q : ms) {
                    Item m = person(q, "stores");
                    m.store = s;
                    m.indent = true;
                }
                if (!any && ms.isEmpty()) note("No one yet.", true);
            }
            fold("stores", storePeople);
        }

        for (JSONObject l : objs(lists)) {
            String lid = PersonsUi.s(l, "id");
            String section = isSection(lid) ? lid : "";
            List<JSONObject> in = new ArrayList<>();
            for (JSONObject q : objs(people)) if (PersonsUi.has(PersonsUi.arr(q, "listIds"), lid)) in.add(q);
            Item lh = head(section.isEmpty() ? "" : section, PersonsUi.s(l, "name").isEmpty() ? PersonsUi.sectionLabel(lid) : PersonsUi.s(l, "name"), "list:" + lid, in);
            if (!lh.open) continue;
            if (!section.isEmpty()) sectionConns(section, conns);
            if ("spokpay".equals(section)) siteRequests(st.optJSONObject("siteRequests"));
            if (!section.isEmpty()) addRow(section, null);
            List<JSONObject> live = new ArrayList<>();
            for (JSONObject q : in) if (section.isEmpty() || !settled(q, section)) live.add(q);
            Collections.sort(live, recent(section));
            if (in.isEmpty()) note("No one yet.", false);
            for (JSONObject q : live) person(q, section);
            if (!section.isEmpty()) fold(section, in);
        }
    }

    /** Headquarters' Home › Site requests (the engine's siteRequests), at the top of the SpokPay section. */
    private void siteRequests(JSONObject sr) {
        if (sr == null) return;
        JSONArray rows = PersonsUi.arr(sr, "rows");
        Item h = new Item(SR_HEAD);
        h.count = rows.length();
        h.owner = sr.optBoolean("waits");
        h.open = !p.in("closed", "sr");
        items.add(h);
        if (!h.open) return;
        for (JSONObject n : objs(PersonsUi.arr(sr, "notices"))) {
            Item it = new Item(SR_NOTICE);
            it.text = PersonsUi.s(n, "title");
            it.key = PersonsUi.s(n, "text");
            items.add(it);
        }
        if (rows.length() == 0) note("No site request is open at SpokPay.", false);
        for (JSONObject r : objs(rows)) {
            Item it = new Item(SR);
            it.sr = r;
            items.add(it);
        }
    }

    static boolean isSection(String s) { return "stores".equals(s) || "creators".equals(s) || "spokpay".equals(s) || "personal".equals(s); }

    /** Whether a connection serves a section: its own, or one it's shared with (Personal uses the Stores Discord and WhatsApp). */
    static boolean serves(JSONObject c, String section) {
        return section.equals(PersonsUi.s(c, "section")) || PersonsUi.has(PersonsUi.arr(c, "also"), section);
    }

    private Item head(String section, String label, String key, List<JSONObject> people) {
        Item h = new Item(HEAD);
        h.section = section;
        h.text = label;
        h.key = key;
        h.open = !p.in("closed", key);
        for (JSONObject q : people) h.unread += PersonsUi.info(q, section).optInt("unread");
        items.add(h);
        return h;
    }

    /** The section's connections as chips, and a link waiting for its QR code. */
    private void sectionConns(String section, JSONArray conns) {
        List<JSONObject> mine = new ArrayList<>();
        for (JSONObject c : objs(conns)) if (serves(c, section)) mine.add(c);
        if (mine.isEmpty()) return;
        // No connection chips under the heads (Settings has the connections); only a sign-in waiting for its QR code.
        for (JSONObject c : mine) {
            if (!PersonsUi.s(c, "qr").isEmpty() || ("signing-in".equals(PersonsUi.s(c, "status")) && "discord".equals(PersonsUi.s(c, "kind")))) {
                Item q = new Item(QR);
                q.text = PersonsUi.s(c, "label");
                q.conns = Collections.singletonList(c);
                items.add(q);
            }
        }
    }

    private Item person(JSONObject q, String section) {
        Item it = new Item(PERSON);
        it.person = q;
        it.section = section;
        items.add(it);
        return it;
    }

    /** A section's Settled (N), folded by default; its people by name. */
    private void fold(String section, List<JSONObject> people) {
        List<JSONObject> done = new ArrayList<>();
        for (JSONObject q : people) if (settled(q, section)) done.add(q);
        if (done.isEmpty()) return;
        Item f = new Item(FOLD);
        f.section = section;
        f.count = done.size();
        f.open = p.in("settled_open", section);
        items.add(f);
        if (!f.open) return;
        Collections.sort(done, (x, y) -> PersonsUi.s(x, "name").compareToIgnoreCase(PersonsUi.s(y, "name")));
        for (JSONObject q : done) person(q, section).settled = true;
    }

    static boolean settled(JSONObject q, String section) {
        JSONObject s = PersonsUi.obj(q, "settled");
        if (s == null || section.isEmpty() || !s.has(section) || s.isNull(section)) return false;
        Object v = s.opt(section);
        return !(v instanceof Boolean) || (Boolean) v;
    }

    private static boolean owns(List<JSONObject> stores, String id) {
        for (JSONObject s : stores) if (id.equals(PersonsUi.s(s, "ownerId"))) return true;
        return false;
    }

    private static List<JSONObject> members(JSONArray people, String store) {
        List<JSONObject> out = new ArrayList<>();
        for (JSONObject q : objs(people)) if (PersonsUi.has(PersonsUi.arr(q, "storeIds"), store)) out.add(q);
        return out;
    }

    static List<JSONObject> objs(JSONArray a) {
        List<JSONObject> out = new ArrayList<>();
        for (int i = 0; i < a.length(); i++) {
            JSONObject o = a.optJSONObject(i);
            if (o != null) out.add(o);
        }
        return out;
    }

    /** Newest message first in the section (no messages: last, by name). */
    static Comparator<JSONObject> recent(String section) {
        return (x, y) -> {
            long ax = PersonsUi.ms(PersonsUi.s(PersonsUi.info(x, section), "lastAt")), ay = PersonsUi.ms(PersonsUi.s(PersonsUi.info(y, section), "lastAt"));
            if (ax != ay) return Long.compare(ay, ax);
            return PersonsUi.s(x, "name").compareToIgnoreCase(PersonsUi.s(y, "name"));
        };
    }

    // ---- views ----

    private View itemView(Item it) {
        switch (it.kind) {
            case HEAD: {
                return Ds.inset(a, Ds.sectionHead(a, it.text, it.open, it.unread, v -> { p.flip("closed", it.key); p.redrawHomes(); }), 0);
            }
            case QR: {
                // a sign-in by QR code: Discord's (scanned in the Discord app on another phone) or WhatsApp's link
                JSONObject cn = it.conns.get(0);
                String kind = PersonsUi.s(cn, "kind"), cid = PersonsUi.s(cn, "id"), note = PersonsUi.s(cn, "error");
                boolean dc = "discord".equals(kind);
                LinearLayout c = Ds.card(a);
                LinearLayout t = Ui.row(a);
                t.addView(PersonsUi.channel(a, kind, 18), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(18), Ui.dp(18)), 0, 0, 8, 0));
                t.addView(Ui.bold(a, dc ? "Sign in to Discord" : "Link WhatsApp", 15, Ui.FG));
                c.addView(t);
                c.addView(Ui.text(a, (dc ? "Scan this code in the Discord app of that account (You › Scan QR code), then confirm there."
                        : "On the phone with that WhatsApp: Settings › Linked devices › Link a device, then scan this code.") + (note.isEmpty() ? "" : "\n" + note), 13, Ui.G700), Ui.margins(Ui.fill(), 0, 6, 0, 8));
                android.graphics.Bitmap bm = qrBitmap(cn.optJSONArray("qrRows"));
                if (bm != null) {
                    android.widget.ImageView iv = new android.widget.ImageView(a);
                    iv.setImageBitmap(bm);
                    iv.setBackgroundColor(0xffffffff);
                    iv.setPadding(Ui.dp(10), Ui.dp(10), Ui.dp(10), Ui.dp(10));
                    LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(Ui.dp(240), Ui.dp(240));
                    lp.gravity = android.view.Gravity.CENTER_HORIZONTAL;
                    c.addView(iv, lp);
                } else c.addView(Ui.text(a, "Getting a code…", 13, Ui.G700));
                TextView cancel = Ui.text(a, "Cancel", 14, Ui.FG);
                cancel.setPadding(Ui.dp(4), Ui.dp(10), Ui.dp(4), Ui.dp(2));
                cancel.setOnClickListener(v -> connCall("/v1/persons/connections/" + PersonsUi.enc(cid) + "/cancel"));
                c.addView(cancel);
                LinearLayout w = Ui.col(a);
                w.setPadding(Ui.dp(14), Ui.dp(2), Ui.dp(14), Ui.dp(8));
                w.addView(c, Ui.fill());
                return w;
            }
            case NOTE: {
                TextView t = Ui.text(a, it.text, 13, Ui.G700);
                t.setPadding(Ui.dp(it.indent ? 52 : 20), Ui.dp(6), Ui.dp(20), Ui.dp(6));
                return t;
            }
            case STORE: {
                LinearLayout r = Ds.row(a, false);
                r.setPadding(Ui.dp(4), Ui.dp(6), Ui.dp(14), Ui.dp(6));
                r.addView(Ds.chevron(a, it.open), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(24), Ui.dp(24)), 0, 0, 6, 0));
                r.addView(PersonsUi.storeBadge(a, p.hub, it.store, 22), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(22), Ui.dp(22)), 0, 0, 10, 0));
                String name = PersonsUi.s(it.store, "name");
                r.addView(Ds.rowTitle(a, name, true, Ui.FG), Ui.weight());
                r.addView(Ds.meta(a, String.valueOf(it.count)));
                String sid = PersonsUi.s(it.store, "id");
                r.setOnClickListener(v -> { p.flip("stores_open", sid); p.redrawHomes(); });
                r.setContentDescription(name + ", " + it.count + " people");
                return Ds.inset(a, r, 0);
            }
            case PERSON: {
                LinearLayout r = PersonsUi.row(a, p.hub, it.person, it.section, it.owner);
                if (it.settled) r.setAlpha(0.75f);
                String id = PersonsUi.s(it.person, "id");
                r.setOnClickListener(v -> p.openChat(id, it.section));
                String store = it.store == null ? "" : PersonsUi.s(it.store, "id");
                r.setOnLongClickListener(v -> { menu(p, it.person, it.section, store, it.settled); return true; });
                return Ds.inset(a, r, it.indent ? 22 : 0);
            }
            case SR_HEAD: {
                // FoldingSection's heading: label-12, fg while one waits on SpokPay (its amber dot), else subtle
                LinearLayout r = Ui.row(a);
                r.setMinimumHeight(Ui.dp(32));
                r.setPadding(Ui.dp(12), 0, Ui.dp(12), 0);
                r.setBackground(Ui.press(0, 0, 6));
                int ink = it.owner ? Ui.FG : Ui.G700;
                r.addView(Ui.text(a, "Site requests", 12, ink));
                if (it.owner) r.addView(Ui.dot(a, Ui.AMBER, 8), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(8), Ui.dp(8)), 8, 0, 0, 0));
                r.addView(new View(a), Ui.weight());
                if (it.count > 0) r.addView(Ui.text(a, String.valueOf(it.count), 12, ink), Ui.margins(Ui.wrap(), 0, 0, 4, 0));
                r.addView(Ui.icon(a, it.open ? Ui.I_DOWN : Ui.I_CHEV_RIGHT, 14, ink), new LinearLayout.LayoutParams(Ui.dp(14), Ui.dp(14)));
                r.setOnClickListener(v -> { p.flip("closed", "sr"); p.redrawHomes(); });
                r.setContentDescription("Site requests, " + it.count + (it.owner ? ", one waits on SpokPay" : "") + (it.open ? ", open" : ", folded"));
                return Ds.inset(a, r, 0);
            }
            case SR_NOTICE: {
                // NoticeRow: amber border and fill, CircleAlert, the title and the words in amber
                LinearLayout box = Ui.row(a);
                box.setGravity(android.view.Gravity.TOP);
                box.setPadding(Ui.dp(10), Ui.dp(8), Ui.dp(10), Ui.dp(8));
                box.setBackground(Ui.round((Ui.AMBER & 0x00ffffff) | 0x1f000000, (Ui.AMBER & 0x00ffffff) | 0x55000000, 6));
                box.addView(Ui.icon(a, Ui.I_ALERT, 14, Ui.AMBER), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(14), Ui.dp(14)), 0, 2, 8, 0));
                LinearLayout words = Ui.col(a);
                words.addView(Ui.text(a, it.text, 13, Ui.AMBER));
                words.addView(Ui.text(a, it.key, 13, Ui.AMBER), Ui.margins(Ui.fill(), 0, 2, 0, 0));
                box.addView(words, Ui.weight());
                LinearLayout w = Ui.col(a);
                w.setPadding(Ui.dp(Ds.ROW_INSET + 4), 0, Ui.dp(Ds.ROW_INSET + 4), Ui.dp(4));
                w.addView(box, Ui.fill());
                return w;
            }
            case SR: {
                return Ds.inset(a, siteRequestRow(it.sr), 0);
            }
            case ADD: {
                // Add contact, in every section: a WhatsApp number, a Discord or Instagram username, an email
                LinearLayout r = Ds.row(a, false);
                r.setPadding(Ui.dp(14), Ui.dp(8), Ui.dp(14), Ui.dp(8));
                r.addView(Ui.icon(a, Ui.I_PLUS, 16, Ui.G700), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(16), Ui.dp(16)), 0, 0, 10, 0));
                r.addView(Ds.rowTitle(a, "Add contact", false, Ui.G700), Ui.weight());
                r.setOnClickListener(v -> addContact(p, it.section, it.stores));
                r.setContentDescription("Add contact");
                return Ds.inset(a, r, 0);
            }
            case FOLD: {
                return Ds.foldBar(a, "Settled (" + it.count + ")", it.open, v -> { p.flip("settled_open", it.section); p.redrawHomes(); });
            }
        }
        return new View(a);
    }

    /** ChatListRow for a site request: the store's square bordered icon (initials until read), the subject, then the
     *  store's side ("Store replied" blue / "Store waiting" amber / "Nothing new") with the ref on the right. */
    private View siteRequestRow(JSONObject sr) {
        String ref = PersonsUi.s(sr, "ref"), url = PersonsUi.s(sr, "url"), subject = PersonsUi.s(sr, "subject"), icon = PersonsUi.s(sr, "icon");
        JSONObject side = sr.optJSONObject("side");
        LinearLayout r = Ui.row(a);
        r.setPadding(Ui.dp(12), Ui.dp(6), Ui.dp(12), Ui.dp(6));
        r.setBackground(Ui.press(0, 0, 6));
        android.widget.FrameLayout badge = new android.widget.FrameLayout(a);
        TextView ini = Ui.text(a, PersonsUi.s(sr, "initials"), 13, Ui.G700);
        ini.setGravity(android.view.Gravity.CENTER);
        ini.setIncludeFontPadding(false);
        ini.setBackground(Ui.round(Ui.G100, Ui.LINE, 6));
        badge.addView(ini, new android.widget.FrameLayout.LayoutParams(-1, -1));
        if (!icon.isEmpty()) {
            android.widget.ImageView iv = new android.widget.ImageView(a);
            iv.setScaleType(android.widget.ImageView.ScaleType.CENTER_CROP);
            iv.setBackground(Ui.round(0, 0, 6));
            iv.setClipToOutline(true);
            badge.addView(iv, new android.widget.FrameLayout.LayoutParams(-1, -1));
            PersonsUi.image(a, p.hub, icon, iv, Ui.dp(32), null);
        }
        r.addView(badge, Ui.margins(new LinearLayout.LayoutParams(Ui.dp(32), Ui.dp(32)), 0, 0, 10, 0));
        LinearLayout col = Ui.col(a);
        col.addView(Ui.subtitle(Ui.text(a, subject.isEmpty() ? ref : subject, 14, Ui.FG)));
        LinearLayout line = Ui.row(a);
        String tone = side == null ? "" : PersonsUi.s(side, "tone");
        int color = "info".equals(tone) ? Ui.BLUE : "warning".equals(tone) ? Ui.AMBER : Ui.G700;
        line.addView(Ui.subtitle(Ui.text(a, side == null ? "Nothing new" : PersonsUi.s(side, "text"), 12, color)), Ui.weight());
        TextView refView = Ui.text(a, ref, 12, Ui.G700);
        refView.setTypeface(Ui.mono);
        line.addView(refView, Ui.margins(Ui.wrap(), 8, 0, 0, 0));
        col.addView(line, Ui.fill());
        r.addView(col, Ui.weight());
        r.setContentDescription((subject.isEmpty() ? ref : subject) + ", " + (side == null ? "Nothing new" : PersonsUi.s(side, "text")) + ", " + ref);
        // its pane (PersonsSr) opens over the home; reading it marks what the store wrote seen
        r.setOnClickListener(v -> p.openSr(ref));
        r.setOnLongClickListener(v -> {
            List<Ds.Item> m = new ArrayList<>();
            m.add(Ds.item(Ui.I_LINK, "Copy link", () -> Ui.copy(a, url)));
            Ds.menu(a, m);
            return true;
        });
        return r;
    }

    private void connCall(String path) {
        Ui.bg(a, () -> p.hub.call("POST", path, new JSONObject()), r -> p.refresh());
    }

    /** A QR code's rows ("0"/"1", 1 dark) as a bitmap, the PC's encoder's output. */
    static android.graphics.Bitmap qrBitmap(JSONArray rows) {
        if (rows == null || rows.length() == 0) return null;
        int n = rows.length(), quiet = 2, side = n + 2 * quiet;
        int[] px = new int[side * side];
        java.util.Arrays.fill(px, 0xffffffff);
        for (int y = 0; y < n; y++) {
            String row = rows.optString(y, "");
            for (int x = 0; x < row.length() && x < n; x++) if (row.charAt(x) == '1') px[(y + quiet) * side + x + quiet] = 0xff000000;
        }
        android.graphics.Bitmap small = android.graphics.Bitmap.createBitmap(px, side, side, android.graphics.Bitmap.Config.ARGB_8888);
        return android.graphics.Bitmap.createScaledBitmap(small, side * 8, side * 8, false);
    }

    // ---- a person's long-press menu (shared with the list) ----

    static void menu(PersonsState p, JSONObject person, String section, boolean settled) { menu(p, person, section, "", settled); }

    /** `store`: the store the row sits in ("" outside Stores), the place Move to… starts from. */
    static void menu(PersonsState p, JSONObject person, String section, String store, boolean settled) {
        String id = PersonsUi.s(person, "id"), name = PersonsUi.s(person, "name");
        List<String> opts = new ArrayList<>();
        List<String[]> settles = new ArrayList<>(); // {section, "1" to settle}
        opts.add("Rename");
        if (isSection(section)) {
            opts.add(settled ? "Unsettle" : "Settle");
            settles.add(new String[]{section, settled ? "" : "1"});
        } else {
            // All people: one for each section they're in (the person panel has none).
            for (String s : sectionsOf(p, person)) {
                boolean done = settled(person, s);
                opts.add((done ? "Unsettle in " : "Settle in ") + PersonsUi.sectionLabel(s));
                settles.add(new String[]{s, done ? "" : "1"});
            }
        }
        // Link with… (the same human on another channel) and Unlink for each one linked into them
        int linkAt = opts.size();
        opts.add("Link with…");
        List<JSONObject> linked = PersonsLink.linked(person);
        for (JSONObject l : linked) opts.add("Unlink " + PersonsUi.s(l, "name") + "…");
        int moveAt = opts.size();
        opts.add("Move to…");
        String from = !store.isEmpty() ? "store:" + store : "creators".equals(section) || "spokpay".equals(section) || "personal".equals(section) ? section : "";
        Ui.dialog(p.a).setTitle(name).setItems(opts.toArray(new String[0]), (d, w) -> {
            if (w == 0) rename(p, id, name);
            else if (w == moveAt) moveTo(p, person, from);
            else if (w == linkAt) PersonsLink.pick(p, id);
            else if (w > linkAt) {
                JSONObject l = linked.get(w - linkAt - 1);
                PersonsLink.unlink(p, id, PersonsUi.s(l, "id"), PersonsUi.s(l, "name"), null);
            } else settle(p, id, settles.get(w - 1)[0], !settles.get(w - 1)[1].isEmpty());
        }).show();
    }

    // ---- Move to… (the desktop's MOVE TO: menus.ts moveEntries) ----

    /** Where a person is: "store:<id>" for each store of theirs (owned too), "creators", "spokpay". */
    static List<String> placesOf(PersonsState p, JSONObject person) {
        List<String> out = new ArrayList<>();
        String id = PersonsUi.s(person, "id");
        JSONArray si = PersonsUi.arr(person, "storeIds");
        for (int i = 0; i < si.length(); i++) out.add("store:" + si.optString(i));
        if (p.st != null) for (JSONObject s : objs(PersonsUi.arr(p.st, "stores")))
            if (id.equals(PersonsUi.s(s, "ownerId")) && !out.contains("store:" + PersonsUi.s(s, "id"))) out.add("store:" + PersonsUi.s(s, "id"));
        JSONArray li = PersonsUi.arr(person, "listIds");
        for (String s : new String[]{"creators", "spokpay", "personal"}) if (PersonsUi.has(li, s)) out.add(s);
        return out;
    }

    /** SpokPay · Creators · Stores ›, the place they're in checked and greyed; `from` = the row's place ("" = everywhere). */
    static void moveTo(PersonsState p, JSONObject person, String from) {
        String name = PersonsUi.s(person, "name");
        List<String> places = placesOf(p, person);
        List<Sheet.Option> o = new ArrayList<>();
        String here = "";
        for (String s : new String[]{"spokpay", "creators"}) {
            boolean in = from.isEmpty() ? places.contains(s) : from.equals(s);
            if (in) here = s;
            o.add(new Sheet.Option(s, PersonsUi.sectionLabel(s), in ? "Here now" : "", !in));
        }
        int n = 0;
        for (String s : places) if (s.startsWith("store:")) n++;
        o.add(new Sheet.Option("stores", "Stores  ›", n == 0 ? "Pick a store, or a new one" : from.startsWith("store:") ? "In " + storeName(p, from.substring(6)) : "In " + n + (n == 1 ? " store" : " stores"), true));
        boolean inPersonal = from.isEmpty() ? places.contains("personal") : from.equals("personal");
        if (inPersonal) here = "personal";
        o.add(new Sheet.Option("personal", "Personal", inPersonal ? "Here now" : "", !inPersonal));
        Sheet.pick(p.a, "Move " + name + " to", "Their chats, notes, picture and AI chat come along. Nothing is sent.", o, here, to -> {
            if ("stores".equals(to)) moveToStore(p, person, from, places);
            else move(p, PersonsUi.s(person, "id"), name, from, to);
        });
    }

    /** Stores' submenu: every store (theirs checked and greyed), then New store…; Back returns to Move to. */
    static void moveToStore(PersonsState p, JSONObject person, String from, List<String> places) {
        String id = PersonsUi.s(person, "id"), name = PersonsUi.s(person, "name");
        List<JSONObject> stores = new ArrayList<>(objs(PersonsUi.arr(p.st, "stores")));
        Collections.sort(stores, (x, y) -> PersonsUi.s(x, "name").compareToIgnoreCase(PersonsUi.s(y, "name")));
        List<Sheet.Option> o = new ArrayList<>();
        o.add(new Sheet.Option("back", "‹  Back", "", true));
        String here = "";
        for (JSONObject s : stores) {
            String key = "store:" + PersonsUi.s(s, "id");
            boolean in = from.isEmpty() ? places.contains(key) : from.equals(key);
            if (in) here = key;
            o.add(new Sheet.Option(key, PersonsUi.s(s, "name"), in ? "Here now" : "", !in, PersonsUi.storeBadge(p.a, p.hub, s, 22)));
        }
        o.add(new Sheet.Option("new", "New store…", "", true));
        Sheet.pick(p.a, "Move " + name + " to a store", null, o, here, to -> {
            if ("back".equals(to)) moveTo(p, person, from);
            else if ("new".equals(to)) newStore(p, id, name, from);
            else move(p, id, name, from, to);
        });
    }

    private static String storeName(PersonsState p, String sid) {
        for (JSONObject s : objs(PersonsUi.arr(p.st, "stores"))) if (sid.equals(PersonsUi.s(s, "id"))) return PersonsUi.s(s, "name");
        return "a store";
    }

    /** New store… (a name; the PC picks its colour), then the person moves into it. */
    static void newStore(PersonsState p, String id, String name, String from) {
        EditText e = Ui.input(p.a, "Store name", false);
        LinearLayout box = Ui.col(p.a);
        box.setPadding(Ui.dp(20), Ui.dp(8), Ui.dp(20), 0);
        box.addView(e, Ui.fill());
        Ui.dialog(p.a).setTitle("New store").setView(box)
                .setPositiveButton("Create", (d, w) -> {
                    String v = e.getText().toString().trim();
                    if (v.isEmpty()) return;
                    Ui.bg(p.a, () -> p.hub.call("POST", "/v1/persons/stores", PersonsUi.put(new JSONObject(), "name", v)), r -> {
                        JSONObject st = r.optJSONObject("store");
                        if (st == null) { Ui.toast(p.a, r.optString("error", "Couldn't create the store")); return; }
                        move(p, id, name, from, "store:" + PersonsUi.s(st, "id"));
                    });
                })
                .setNegativeButton("Cancel", null).show();
        e.requestFocus();
    }

    /** POST /v1/persons/person/{id}/move {to, from}: nothing is sent to anyone; the state follows. */
    static void move(PersonsState p, String id, String name, String from, String to) {
        JSONObject b = PersonsUi.put(new JSONObject(), "to", to);
        if (!from.isEmpty()) PersonsUi.put(b, "from", from);
        Ui.bg(p.a, () -> p.hub.call("POST", "/v1/persons/person/" + PersonsUi.enc(id) + "/move", b), r -> {
            if (!r.optBoolean("ok", false)) { Ui.toast(p.a, r.optString("error", "Couldn't move them")); return; }
            p.refresh();
            Ui.toast(p.a, "Moved " + name + " to " + (to.startsWith("store:") ? storeName(p, to.substring(6)) : PersonsUi.sectionLabel(to)));
        });
    }

    /** The sections a person is in: Stores (a member or an owner), and each section list. */
    static List<String> sectionsOf(PersonsState p, JSONObject person) {
        List<String> out = new ArrayList<>();
        String id = PersonsUi.s(person, "id");
        boolean inStore = PersonsUi.arr(person, "storeIds").length() > 0;
        if (!inStore && p.st != null) for (JSONObject s : objs(PersonsUi.arr(p.st, "stores")))
            if (id.equals(PersonsUi.s(s, "ownerId"))) inStore = true;
        if (inStore) out.add("stores");
        JSONArray li = PersonsUi.arr(person, "listIds");
        for (String s : new String[]{"creators", "spokpay", "personal"}) if (PersonsUi.has(li, s)) out.add(s);
        return out;
    }

    /** Add contact in `section` (the PC's dialog; Stores: the store first, from `stores`): the platform, then their
     *  number, username or email. The PC finds them there first; when it can't, the reason shows in the dialog and nothing
     *  is saved. Their chat opens once added. */
    static void addContact(PersonsState p, String section, List<JSONObject> stores) {
        if ("stores".equals(section)) {
            if (stores == null || stores.isEmpty()) return;
            if (stores.size() == 1) { contactKind(p, section, PersonsUi.s(stores.get(0), "id")); return; }
            List<Sheet.Option> o = new ArrayList<>();
            for (JSONObject st : stores) o.add(new Sheet.Option(PersonsUi.s(st, "id"), PersonsUi.s(st, "name"), "", true));
            Sheet.pick(p.a, "Add contact", "The store they're in.", o, "", store -> contactKind(p, section, store));
            return;
        }
        contactKind(p, section, "");
    }

    /** The platforms Add contact offers in a section: Personal's own (Discord, WhatsApp, Instagram); the others talk
     *  on Discord and WhatsApp, Creators by email too. */
    private static void contactKind(PersonsState p, String section, String store) {
        List<Sheet.Option> o = new ArrayList<>();
        if ("creators".equals(section)) o.add(new Sheet.Option("gmail", "Email", "Their email address", true));
        o.add(new Sheet.Option("discord", "Discord", "Their username", true));
        o.add(new Sheet.Option("whatsapp", "WhatsApp", "Their number", true));
        if ("personal".equals(section)) o.add(new Sheet.Option("instagram", "Instagram", "Their username", true));
        Sheet.pick(p.a, "Add contact", "Where you talk to them: their conversation shows here.", o, "", kind -> contactForm(p, kind, section, store));
    }

    private static void contactForm(PersonsState p, String kind, String section, String store) {
        boolean wa = "whatsapp".equals(kind), mail = "gmail".equals(kind);
        EditText handle = Ui.input(p.a, wa ? "+55 11 91234-5678" : mail ? "name@example.com" : "@username", false);
        if (wa) handle.setInputType(android.text.InputType.TYPE_CLASS_PHONE);
        if (mail) handle.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        EditText name = Ui.input(p.a, "Name (optional)", false);
        TextView err = Ui.text(p.a, "", 13, Ui.RED);
        err.setVisibility(View.GONE);
        LinearLayout box = Ui.col(p.a);
        box.setPadding(Ui.dp(20), Ui.dp(8), Ui.dp(20), 0);
        box.addView(handle, Ui.fill());
        box.addView(name, Ui.margins(Ui.fill(), 0, 8, 0, 0));
        box.addView(err, Ui.margins(Ui.fill(), 0, 8, 0, 0));
        android.app.AlertDialog d = Ui.dialog(p.a).setTitle(mail ? "Their email" : PersonsUi.kindLabel(kind) + (wa ? " number" : " username")).setView(box)
                .setPositiveButton("Add", null).setNegativeButton("Cancel", null).show();
        handle.requestFocus();
        // the dialog stays open on an error (its reason under the fields); a conflict (the number is someone else's, or
        // WhatsApp names it otherwise) turns the button into its confirm, sent again with the same fields
        android.widget.Button ok = d.getButton(android.app.AlertDialog.BUTTON_POSITIVE);
        String[] pending = {null};
        ok.setOnClickListener(v -> {
            String h = handle.getText().toString().trim(), n = name.getText().toString().trim();
            JSONObject body = PersonsUi.put(new JSONObject(), "kind", kind);
            PersonsUi.put(body, "handle", h);
            PersonsUi.put(body, "name", n);
            PersonsUi.put(body, "section", section);
            if (!store.isEmpty()) PersonsUi.put(body, "store", store);
            if ((h + "\n" + n).equals(pending[0])) PersonsUi.put(body, "confirm", true);
            v.setEnabled(false);
            err.setVisibility(View.GONE);
            Ui.bg(p.a, () -> p.hub.call("POST", "/v1/persons/contacts", body, 60_000), r -> {
                v.setEnabled(true);
                if (!r.optBoolean("ok", false)) {
                    JSONObject conflict = r.optJSONObject("conflict");
                    pending[0] = conflict != null ? h + "\n" + n : null;
                    ok.setText(conflict != null ? conflict.optString("confirm", "Add anyway") : "Add");
                    err.setText(r.optString("error", "Not added"));
                    err.setVisibility(View.VISIBLE);
                    return;
                }
                d.dismiss();
                JSONObject person = r.optJSONObject("person");
                if (r.optBoolean("existed")) Ui.toast(p.a, r.optString("message", "Already in Persons"));
                p.refresh();
                if (person != null) p.openChat(PersonsUi.s(person, "id"), section);
            });
        });
    }

    static void rename(PersonsState p, String id, String name) {
        EditText e = Ui.input(p.a, "Name", false);
        e.setText(name);
        e.setSelectAllOnFocus(true);
        LinearLayout box = Ui.col(p.a);
        box.setPadding(Ui.dp(20), Ui.dp(8), Ui.dp(20), 0);
        box.addView(e, Ui.fill());
        Ui.dialog(p.a).setTitle("Rename").setView(box)
                .setPositiveButton("Save", (d, w) -> {
                    String v = e.getText().toString().trim();
                    if (v.isEmpty() || v.equals(name)) return;
                    patch(p, id, PersonsUi.put(new JSONObject(), "name", v), null);
                })
                .setNegativeButton("Cancel", null).show();
        e.requestFocus();
    }

    static void settle(PersonsState p, String id, String section, boolean on) {
        JSONObject s = PersonsUi.put(new JSONObject(), "section", section);
        PersonsUi.put(s, "on", on);
        patch(p, id, PersonsUi.put(new JSONObject(), "settle", s), () ->
                Ui.toast(p.a, (on ? "Settled in " : "Back in ") + PersonsUi.sectionLabel(section).toLowerCase(Locale.ROOT).replace("spokpay", "SpokPay")));
    }

    /** PATCH /v1/persons/person/{id}; `then` on success; the state follows. */
    static void patch(PersonsState p, String id, JSONObject body, Runnable then) {
        Ui.bg(p.a, () -> p.hub.call("PATCH", "/v1/persons/person/" + PersonsUi.enc(id), body), r -> {
            if (!r.optBoolean("ok", true)) { Ui.toast(p.a, r.optString("error", "Couldn't save it")); return; }
            p.refresh();
            if (then != null) then.run();
        });
    }
}
