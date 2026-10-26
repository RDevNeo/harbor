package dev.harbor.app;

import android.app.Activity;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** The slash menu above a chat's composer, as on the desktop (src/slash.rs) and in T3 Code:
 *  typing `/` at the start of a word lists Harbor's commands (/model, /plan, /default), the
 *  agent's commands and the user's commands and skills (GET /v1/chats/{id}/slash), filtered as
 *  you type (SlashList). A tap puts `/name ` in; Harbor's commands act instead (onHarbor).
 *  Back, a space or no match closes it. */
final class Slash {
    /** A list is fetched again when the menu opens after this long. */
    private static final long FRESH_MS = 30_000;
    private static final long NOTE_MS = 5_000;
    /** While Claude Code is still asked for its list: ask the PC again this often, this many times. */
    private static final long PENDING_MS = 1500;
    private static final int PENDING_TRIES = 12;
    private static final int MAX_ROWS = 60;

    /** model, plan or default was picked. */
    interface Harbor { void run(String command); }

    private static final class Cached {
        final List<SlashList.Entry> entries;
        final long at;
        final boolean pending;
        /** The PC (Hub endpoint, "" the paired one) that gave the list when the one calls go to
         *  has no slash menu (Harbor before 0.23); null: that one. */
        final String from;
        /** Why there's no list, when the user can do something about it; else null. */
        final String note;
        /** The note's fix is upgrading the pairing (a newer PC refused it). */
        final boolean upgrade;

        Cached(List<SlashList.Entry> entries, long at, boolean pending, String from, String note, boolean upgrade) {
            this.entries = entries; this.at = at; this.pending = pending; this.from = from; this.note = note; this.upgrade = upgrade;
        }
    }

    /** Per PC, chat and run settings (the list follows the agent and access). */
    private static final Map<String, Cached> cache = new HashMap<>();

    final LinearLayout view;
    private final LinearLayout rows;
    private final Activity a;
    private final Hub hub;
    /** Where the list comes from: a chat's, or a new chat's by project and run settings. */
    private final java.util.function.Supplier<String> path;
    private final Composer.Edit edit;
    private final Harbor onHarbor;
    private String settings = "", home = "", homeName = "";
    private SlashList.Word word;     // the word the menu shows for; null while it's closed
    private int dismissed = -1;      // Back closed the menu for the word starting here
    private List<SlashList.Entry> shown = new ArrayList<>(); // the rows drawn
    private boolean loading;
    private int tries;

    Slash(Activity a, Hub hub, String chat, Composer.Edit edit, Harbor onHarbor) {
        this(a, hub, () -> "/v1/chats/" + chat + "/slash", edit, onHarbor);
    }

    /** For the new-chat screen: `path` is GET /v1/slash with its picks (no chat yet). */
    Slash(Activity a, Hub hub, java.util.function.Supplier<String> path, Composer.Edit edit, Harbor onHarbor) {
        this.a = a;
        this.hub = hub;
        this.path = path;
        this.edit = edit;
        this.onHarbor = onHarbor;
        view = Ui.col(a);
        view.setBackground(Ui.round(Ui.CARD, Ui.LINE, 20));
        view.setElevation(Ui.dp(6));
        view.setClipToOutline(true);
        view.setVisibility(View.GONE);
        // As tall as five rows, or the room above the composer when the keyboard leaves less.
        ScrollView scroll = new ScrollView(a) {
            @Override protected void onMeasure(int w, int h) {
                int max = Ui.dp(5 * 56 + 8);
                if (MeasureSpec.getMode(h) != MeasureSpec.UNSPECIFIED) max = Math.min(max, MeasureSpec.getSize(h));
                super.onMeasure(w, MeasureSpec.makeMeasureSpec(max, MeasureSpec.AT_MOST));
            }
        };
        rows = Ui.col(a);
        rows.setPadding(Ui.dp(4), Ui.dp(4), Ui.dp(4), Ui.dp(4));
        scroll.addView(rows);
        view.addView(scroll, Ui.fill());

        edit.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int st, int c, int af) { }
            @Override public void onTextChanged(CharSequence s, int st, int b, int c) { }
            @Override public void afterTextChanged(Editable e) { update(); }
        });
        edit.onSelection = this::update;
        edit.setOnFocusChangeListener((v, has) -> {
            // Asked ahead, so the list is there when `/` is typed (the PC asks Claude Code then).
            if (has) list();
            update();
        });
        edit.backOpen = this::open;
        edit.onBack = this::back;
    }

    /** The chat's account, device and access (another list once they change), and the PC it
     *  runs on (mesh id and name), which can give the list when the PC calls go to can't. */
    void settings(String s, String home, String homeName) {
        this.home = home;
        this.homeName = homeName;
        if (s.equals(settings)) return;
        settings = s;
        update();
    }

    /** A call about the menu (/plan, /default) to the PC that gave the list. */
    JSONObject call(String method, String path, JSONObject body) throws java.io.IOException {
        Cached c = cache.get(key());
        return c == null || c.from == null ? hub.call(method, path, body) : hub.callOn(c.from, method, path, body);
    }

    /** Whether that call went to another PC than the one calls go to (its answer names chats by
     *  that PC's ids). */
    boolean elsewhere() {
        Cached c = cache.get(key());
        return c != null && c.from != null;
    }

    boolean open() { return view.getVisibility() == View.VISIBLE; }

    /** Back: closes the menu for the word being typed; false when it wasn't open. */
    boolean back() {
        if (!open() || word == null) return false;
        dismissed = word.start;
        hide();
        return true;
    }

    private String key() { return hub.id + "/" + path.get() + "/" + settings; }

    /** The list as the PC last said it; asks again when it's old or missing. */
    private Cached list() {
        Cached c = cache.get(key());
        // No list yet for a reason the user may be fixing (an upgrade, an update): ask again soon.
        long fresh = c != null && c.note != null ? NOTE_MS : FRESH_MS;
        if (c == null || System.currentTimeMillis() - c.at > fresh) fetch();
        return c;
    }

    private void fetch() {
        if (loading) return;
        loading = true;
        final String k = key();
        final Cached old = cache.get(k);
        final String h = home, hn = homeName;
        Ui.pool.execute(() -> {
            final Cached fc = load(old, h, hn);
            Ui.main.post(() -> {
                loading = false;
                if (a.isFinishing() || a.isDestroyed()) return;
                cache.put(k, fc);
                if (fc.pending && tries < PENDING_TRIES) {
                    tries++;
                    Ui.main.postDelayed(() -> { if (!a.isFinishing() && k.equals(key())) fetch(); }, PENDING_MS);
                } else tries = 0;
                update();
            });
        });
    }

    /** The list from the PC calls go to; when it has no slash menu (a Harbor before 0.23
     *  answers 404), from the chat's home PC or another PC of the pairing, asked directly. */
    private Cached load(Cached old, String home, String homeName) {
        String path = this.path.get();
        String cur = hub.via();
        // The home PC as an endpoint of this pairing ("" the paired one), or null.
        String homeV = home.isEmpty() ? null : home.equals(hub.pid) ? "" : hub.ep(home) != null ? home : null;
        List<String> order = new ArrayList<>();
        if (old != null && old.from != null) order.add(old.from);
        if (!order.contains(cur)) order.add(cur);
        if (homeV != null && !order.contains(homeV)) order.add(homeV);
        for (String v : hub.endpoints()) if (!order.contains(v)) order.add(v);
        // A new chat's list names this PC's projects: from this PC only.
        if (!path.startsWith("/v1/chats/")) order.retainAll(java.util.Collections.singletonList(cur));
        boolean homeOld = false, upgrade = false;
        for (String v : order) {
            try {
                JSONObject r = v.equals(cur) ? hub.get(path) : hub.callOn(v, "GET", path, null);
                return new Cached(parse(r.optJSONArray("entries")), System.currentTimeMillis(), r.optBoolean("pending"), v.equals(cur) ? null : v, null, false);
            } catch (Hub.NeedsUpgrade e) {
                upgrade = true;
            } catch (Hub.ApiError e) {
                if (e.code == 404 && v.equals(homeV)) homeOld = true;
            } catch (Exception ignored) {
                // Not reachable now: the next one.
            }
        }
        // No list (until it's old): say why when the user can fix it.
        String note = null;
        if (homeOld) note = (homeName.isEmpty() ? "The PC this chat runs on" : homeName) + " runs a Harbor without slash commands. Update Harbor there to use them.";
        else if (upgrade) note = "Slash commands need this phone's pairing upgraded to three factors. Tap to upgrade.";
        return new Cached(old == null ? new ArrayList<>() : old.entries, System.currentTimeMillis(), false, null, note, upgrade && !homeOld);
    }

    static List<SlashList.Entry> parse(JSONArray a) {
        List<SlashList.Entry> out = new ArrayList<>();
        if (a != null) for (int i = 0; i < a.length(); i++) {
            JSONObject o = a.optJSONObject(i);
            if (o == null || o.optString("name").isEmpty()) continue;
            List<String> aliases = new ArrayList<>();
            JSONArray al = o.optJSONArray("aliases");
            if (al != null) for (int j = 0; j < al.length(); j++) aliases.add(al.optString(j));
            String cmd = o.isNull("command") ? null : o.optString("command", null);
            out.add(new SlashList.Entry(o.optString("name"), aliases, o.optString("description"), o.optString("hint"),
                    o.optString("source"), o.optString("badge"), o.optBoolean("skill"), cmd));
        }
        return out;
    }

    /** Follows the text and the cursor: shows the matches for the `/word` under it, or hides. */
    void update() {
        int cur = edit.getSelectionStart();
        SlashList.Word w = cur == edit.getSelectionEnd() ? SlashList.word(edit.getText(), cur) : null;
        // Back's close lasts while that word is being typed.
        if (dismissed >= 0 && (w == null || w.start != dismissed)) dismissed = -1;
        if (w == null || w.start == dismissed || !edit.hasFocus() || !edit.isShown()) { hide(); return; }
        word = w;
        Cached c = list();
        List<SlashList.Entry> m = c == null ? new ArrayList<>() : SlashList.search(c.entries, w);
        if (m.isEmpty()) {
            // No list at all: why, on the bare `/` only (a path being typed doesn't keep it up).
            if (c != null && c.entries.isEmpty() && c.note != null && w.query.isEmpty()) { note(c); view.setVisibility(View.VISIBLE); }
            else hide();
            return;
        }
        draw(m.size() > MAX_ROWS ? m.subList(0, MAX_ROWS) : m);
        view.setVisibility(View.VISIBLE);
    }

    /** One muted row saying why there's no menu; a tap upgrades the pairing when that's the fix. */
    private void note(Cached c) {
        shown = new ArrayList<>();
        rows.removeAllViews();
        LinearLayout r = Ui.row(a);
        r.setPadding(Ui.dp(12), Ui.dp(12), Ui.dp(12), Ui.dp(12));
        r.addView(Ui.icon(a, Ui.I_ALERT, 16, Ui.G700), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(18), Ui.dp(18)), 0, 0, 10, 0));
        r.addView(Ui.text(a, c.note, 14, Ui.G700), Ui.weight());
        if (c.upgrade) {
            r.setBackground(Ui.press(0, 0, 16));
            r.setOnClickListener(v -> { hide(); Pair.offerUpgrade(a, hub); });
        }
        rows.addView(r, Ui.fill());
    }

    private void hide() {
        word = null;
        view.setVisibility(View.GONE);
    }

    private void draw(List<SlashList.Entry> m) {
        // The same entries (a list fetched again has new ones): nothing to redraw.
        if (m.equals(shown)) return;
        shown = new ArrayList<>(m);
        rows.removeAllViews();
        for (SlashList.Entry e : m) rows.addView(row(e), Ui.fill());
        ((ScrollView) rows.getParent()).scrollTo(0, 0);
    }

    /** One row: /name and what it takes, its description under it, where it comes from. */
    private View row(SlashList.Entry e) {
        LinearLayout r = Ui.row(a);
        r.setMinimumHeight(Ui.dp(56));
        r.setPadding(Ui.dp(12), Ui.dp(8), Ui.dp(10), Ui.dp(8));
        r.setBackground(Ui.press(0, 0, 16));
        LinearLayout t = Ui.col(a);
        LinearLayout top = Ui.row(a);
        top.addView(Ui.subtitle(Ui.bold(a, "/" + e.name, 15, Ui.FG)), Ui.wrap());
        if (!e.hint.isEmpty()) {
            TextView h = Ui.subtitle(Ui.text(a, e.hint, 13, Ui.G600));
            h.setTypeface(Ui.mono);
            top.addView(h, Ui.margins(Ui.wrap(), 8, 0, 0, 0));
        }
        t.addView(top, Ui.fill());
        String d = firstLine(e.description);
        if (!d.isEmpty()) t.addView(Ui.subtitle(Ui.text(a, d, 13.5f, Ui.G700)), Ui.fill());
        r.addView(t, Ui.weight());
        r.addView(badge(e), Ui.margins(Ui.wrap(), 10, 0, 0, 0));
        r.setOnClickListener(v -> accept(e));
        // The whole description and usage (the desktop's hover text).
        r.setOnLongClickListener(v -> {
            String usage = "/" + e.name + (e.hint.isEmpty() ? "" : " " + e.hint);
            Ui.dialog(a).setTitle(usage).setMessage(e.description.isEmpty() ? e.badge : e.description + "\n\n" + e.badge)
                    .setPositiveButton("Insert", (dlg, x) -> accept(e)).setNegativeButton("Close", null).show();
            return true;
        });
        return r;
    }

    private View badge(SlashList.Entry e) {
        LinearLayout b = Ui.row(a);
        b.setPadding(Ui.dp(8), Ui.dp(3), Ui.dp(9), Ui.dp(3));
        b.setBackground(Ui.round(Ui.G100, 0, 10));
        b.addView(Ui.icon(a, glyph(e.source), 11, Ui.G700), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(13), Ui.dp(13)), 0, 0, 5, 0));
        b.addView(Ui.text(a, e.badge, 12, Ui.G700));
        return b;
    }

    /** The desktop's badge icons (slash.rs Entry::badge). */
    private static String glyph(String source) {
        switch (source) {
            case "harbor": return Ui.I_SLIDERS;
            case "plugin": return Ui.I_PLUG;
            case "project": return Ui.I_FOLDER;
            case "personal": return Ui.I_USER;
            default: return Ui.I_TERMINAL;
        }
    }

    private static String firstLine(String s) {
        int nl = s.indexOf('\n');
        return (nl < 0 ? s : s.substring(0, nl)).trim();
    }

    /** Puts `/name ` in place of the word; Harbor's commands take the word out and act. */
    private void accept(SlashList.Entry e) {
        SlashList.Word w = word != null ? word : SlashList.word(edit.getText(), edit.getSelectionStart());
        if (w == null) return;
        boolean harbor = e.command != null;
        SlashList.Put p = SlashList.put(edit.getText(), w, harbor ? "" : "/" + e.name);
        edit.getText().replace(p.from, p.to, p.text);
        edit.setSelection(Math.min(p.cursor(), edit.length()));
        hide();
        if (harbor) onHarbor.run(e.command);
    }
}
