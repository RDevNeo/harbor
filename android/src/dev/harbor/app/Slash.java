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

        Cached(List<SlashList.Entry> entries, long at, boolean pending) { this.entries = entries; this.at = at; this.pending = pending; }
    }

    /** Per PC, chat and run settings (the list follows the agent and access). */
    private static final Map<String, Cached> cache = new HashMap<>();

    final LinearLayout view;
    private final LinearLayout rows;
    private final Activity a;
    private final Hub hub;
    private final String chat;
    private final Composer.Edit edit;
    private final Harbor onHarbor;
    private String settings = "";
    private SlashList.Word word;     // the word the menu shows for; null while it's closed
    private int dismissed = -1;      // Back closed the menu for the word starting here
    private List<SlashList.Entry> shown = new ArrayList<>(); // the rows drawn
    private boolean loading;
    private int tries;

    Slash(Activity a, Hub hub, String chat, Composer.Edit edit, Harbor onHarbor) {
        this.a = a;
        this.hub = hub;
        this.chat = chat;
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

    /** The chat's account, device and access: another list once they change. */
    void settings(String s) {
        if (s.equals(settings)) return;
        settings = s;
        update();
    }

    boolean open() { return view.getVisibility() == View.VISIBLE; }

    /** Back: closes the menu for the word being typed; false when it wasn't open. */
    boolean back() {
        if (!open() || word == null) return false;
        dismissed = word.start;
        hide();
        return true;
    }

    private String key() { return hub.id + "/" + chat + "/" + settings; }

    /** The list as the PC last said it; asks again when it's old or missing. */
    private Cached list() {
        Cached c = cache.get(key());
        if (c == null || System.currentTimeMillis() - c.at > FRESH_MS) fetch();
        return c;
    }

    private void fetch() {
        if (loading) return;
        loading = true;
        final String k = key();
        Ui.pool.execute(() -> {
            Cached got;
            try {
                JSONObject r = hub.get("/v1/chats/" + chat + "/slash");
                got = new Cached(parse(r.optJSONArray("entries")), System.currentTimeMillis(), r.optBoolean("pending"));
            } catch (Exception e) {
                // A PC from before the menu, or not reachable now: no menu (until it's old).
                Cached old = cache.get(k);
                got = new Cached(old == null ? new ArrayList<>() : old.entries, System.currentTimeMillis(), false);
            }
            final Cached fc = got;
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
        if (m.isEmpty()) { hide(); return; }
        draw(m.size() > MAX_ROWS ? m.subList(0, MAX_ROWS) : m);
        view.setVisibility(View.VISIBLE);
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
