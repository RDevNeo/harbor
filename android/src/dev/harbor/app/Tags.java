package dev.harbor.app;

import android.app.Activity;
import android.text.Editable;
import android.text.Spanned;
import android.text.TextWatcher;
import android.text.style.BackgroundColorSpan;
import android.text.style.ForegroundColorSpan;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.ScrollView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URLEncoder;
import java.util.HashMap;
import java.util.Map;

/** The `@` and `#` menu above a chat's composer, as on the desktop (src/tags.rs): `@` lists the
 *  project's files (type icon, name, dimmed folder), `#` its GitHub issues and pull requests
 *  (state icon, number, title). The hub ranks them for what's typed (GET /v1/chats/{id}/tags);
 *  a tap puts `@path ` or `#123 ` in, and the text shows its tags highlighted. Back, a space or
 *  no match closes it. */
final class Tags {
    /** An answer is asked again after this long. */
    private static final long FRESH_MS = 15_000;
    /** While the hub is still reading the list: ask again this often, this many times. */
    private static final long PENDING_MS = 1000;
    private static final int PENDING_TRIES = 10;
    /** Typing waits this long before asking. */
    private static final long DEBOUNCE_MS = 120;

    private static final class Answer {
        final JSONArray items;
        final boolean pending;
        final long at;

        Answer(JSONArray items, boolean pending, long at) { this.items = items; this.pending = pending; this.at = at; }
    }

    /** Per PC, chat and word (trigger and query). */
    private static final Map<String, Answer> cache = new HashMap<>();

    final LinearLayout view;
    private final LinearLayout rows;
    private final Activity a;
    private final Hub hub;
    /** The call's path up to its parameters: a chat's, or a new chat's by project. */
    private final java.util.function.Supplier<String> base;
    private final Composer.Edit edit;
    private TagList.Word word;  // the word the menu shows for; null while it's closed
    private int dismissed = -1; // Back closed the menu for the word starting here
    private String shown = "";  // the key of the rows drawn
    private String asking;      // the key being asked
    private int tries;
    private boolean highlighting;

    Tags(Activity a, Hub hub, String chat, Composer.Edit edit) {
        this(a, hub, () -> "/v1/chats/" + chat + "/tags?", edit);
    }

    /** For the new-chat screen: `base` is "/v1/tags?project=…&" (no chat yet). */
    Tags(Activity a, Hub hub, java.util.function.Supplier<String> base, Composer.Edit edit) {
        this.a = a;
        this.hub = hub;
        this.base = base;
        this.edit = edit;
        view = Ui.col(a);
        view.setBackground(Ui.round(Ui.CARD, Ui.LINE, 20));
        view.setElevation(Ui.dp(6));
        view.setClipToOutline(true);
        view.setVisibility(View.GONE);
        ScrollView scroll = new ScrollView(a) {
            @Override protected void onMeasure(int w, int h) {
                int max = Ui.dp(5 * 52 + 8);
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
            @Override public void afterTextChanged(Editable e) { highlight(e); update(); }
        });
        edit.getViewTreeObserver().addOnGlobalFocusChangeListener((was, now) -> update());
    }

    boolean open() { return view.getVisibility() == View.VISIBLE; }

    /** Back: closes the menu for the word being typed; false when it wasn't open. */
    boolean back() {
        if (!open() || word == null) return false;
        dismissed = word.start;
        hide();
        return true;
    }

    private void hide() {
        word = null;
        view.setVisibility(View.GONE);
    }

    private String key(TagList.Word w) { return hub.id + "/" + base.get() + "/" + w.trigger + w.query; }

    /** Follows the text and the cursor: shows the rows for the word under it, or hides. */
    void update() {
        int cur = edit.getSelectionStart();
        TagList.Word w = cur == edit.getSelectionEnd() ? TagList.word(edit.getText(), cur) : null;
        if (dismissed >= 0 && (w == null || w.start != dismissed)) dismissed = -1;
        if (w == null || w.start == dismissed || !edit.hasFocus() || !edit.isShown()) { hide(); return; }
        word = w;
        String k = key(w);
        Answer c = cache.get(k);
        if (c == null || c.pending || System.currentTimeMillis() - c.at > FRESH_MS) {
            final TagList.Word asked = w;
            Ui.main.removeCallbacksAndMessages(this);
            Ui.main.postAtTime(() -> fetch(asked, k), this, android.os.SystemClock.uptimeMillis() + (c == null ? DEBOUNCE_MS : 0));
        }
        // The last rows stay up while the next are asked.
        if (c == null) return;
        if (c.items.length() == 0) { hide(); word = w; return; }
        draw(k, c.items);
        view.setVisibility(View.VISIBLE);
    }

    private void fetch(TagList.Word w, String k) {
        if (k.equals(asking)) return;
        asking = k;
        Ui.pool.execute(() -> {
            Answer got;
            try {
                String q = URLEncoder.encode(w.query, "UTF-8");
                String t = URLEncoder.encode(String.valueOf(w.trigger), "UTF-8");
                JSONObject r = hub.get(base.get() + "trigger=" + t + "&q=" + q);
                JSONArray items = r.optJSONArray("items");
                got = new Answer(items == null ? new JSONArray() : items, r.optBoolean("pending"), System.currentTimeMillis());
            } catch (Exception e) {
                // A hub without tags (before 0.31) or not reachable now: no menu.
                got = new Answer(new JSONArray(), false, System.currentTimeMillis());
            }
            final Answer fa = got;
            Ui.main.post(() -> {
                if (k.equals(asking)) asking = null;
                if (a.isFinishing() || a.isDestroyed()) return;
                cache.put(k, fa);
                if (fa.pending && tries < PENDING_TRIES) {
                    tries++;
                    Ui.main.postDelayed(() -> { if (word != null && k.equals(key(word))) fetch(word, k); }, PENDING_MS);
                } else tries = 0;
                if (word != null && k.equals(key(word))) update();
            });
        });
    }

    private void draw(String k, JSONArray items) {
        if (k.equals(shown)) return;
        shown = k;
        rows.removeAllViews();
        for (int i = 0; i < items.length(); i++) {
            JSONObject it = items.optJSONObject(i);
            if (it != null) rows.addView(row(it), Ui.fill());
        }
        ((ScrollView) rows.getParent()).scrollTo(0, 0);
    }

    /** One row: a file's type icon, name and folder; an issue's or PR's state, number and title. */
    private View row(JSONObject it) {
        boolean file = "file".equals(it.optString("kind"));
        LinearLayout r = Ui.row(a);
        r.setMinimumHeight(Ui.dp(52));
        r.setPadding(Ui.dp(12), Ui.dp(6), Ui.dp(12), Ui.dp(6));
        r.setBackground(Ui.press(0, 0, 16));
        String[] g = file ? fileGlyph(it.optString("icon")) : refGlyph(it.optString("kind"), it.optString("state"));
        r.addView(Ui.icon(a, g[0], 17, Integer.parseInt(g[1])), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(22), Ui.dp(22)), 0, 0, 12, 0));
        String name = file ? it.optString("name") : "#" + it.optLong("number");
        String rest = file ? it.optString("dir") : it.optString("title");
        r.addView(Ui.subtitle(Ui.bold(a, name, 15, Ui.FG)), Ui.wrap());
        if (!rest.isEmpty()) r.addView(Ui.subtitle(Ui.text(a, rest, 13.5f, Ui.G700)), Ui.margins(Ui.weight(), 10, 0, 0, 0));
        String insert = it.optString("insert");
        r.setOnClickListener(v -> accept(insert));
        // The whole path, or the title and address (the desktop's hover text).
        r.setOnLongClickListener(v -> {
            String body = file ? it.optString("path") : it.optString("title") + "\n\n" + it.optString("url");
            Ui.dialog(a).setTitle(name).setMessage(body).setPositiveButton("Insert", (d, x) -> accept(insert)).setNegativeButton("Close", null).show();
            return true;
        });
        return r;
    }

    /** The desktop's file icons (tags.rs file_icon): glyph and colour. */
    private static String[] fileGlyph(String kind) {
        switch (kind) {
            case "ts": case "tsx": return new String[]{Ui.I_FILE_CODE, String.valueOf(Ui.BLUE)};
            case "js": return new String[]{Ui.I_FILE_CODE, String.valueOf(Ui.AMBER)};
            case "rs": return new String[]{Ui.I_FILE_CODE, String.valueOf(Ui.RED)};
            case "json": return new String[]{Ui.I_FILE_BRACES, String.valueOf(Ui.AMBER)};
            case "md": return new String[]{Ui.I_FILE_TEXT, String.valueOf(Ui.BLUE)};
            case "image": return new String[]{Ui.I_IMAGE, String.valueOf(Ui.GREEN)};
            case "shell": return new String[]{Ui.I_TERMINAL, String.valueOf(Ui.GREEN)};
            case "code": return new String[]{Ui.I_FILE_CODE, String.valueOf(Ui.G700)};
            default: return new String[]{Ui.I_FILE, String.valueOf(Ui.G700)};
        }
    }

    /** The desktop's issue and PR state icons (tags.rs ref_icon). */
    private static String[] refGlyph(String kind, String state) {
        if ("pr".equals(kind)) switch (state) {
            case "merged": return new String[]{Ui.I_MERGE, String.valueOf(Ui.BLUE)};
            case "draft": return new String[]{Ui.I_PR_DRAFT, String.valueOf(Ui.G700)};
            case "closed": return new String[]{Ui.I_PR_CLOSED, String.valueOf(Ui.RED)};
            default: return new String[]{Ui.I_PR_OPEN, String.valueOf(Ui.GREEN)};
        }
        return "open".equals(state) ? new String[]{Ui.I_CIRCLE_DOT, String.valueOf(Ui.GREEN)} : new String[]{Ui.I_CIRCLE_CHECK, String.valueOf(Ui.BLUE)};
    }

    /** Puts `insert ` in place of the word. */
    private void accept(String insert) {
        TagList.Word w = word != null ? word : TagList.word(edit.getText(), edit.getSelectionStart());
        if (w == null || insert.isEmpty()) return;
        SlashList.Put p = SlashList.put(edit.getText(), new SlashList.Word(w.start, w.end, w.query, false), insert);
        edit.getText().replace(p.from, p.to, p.text);
        edit.setSelection(Math.min(p.cursor(), edit.length()));
        hide();
    }

    /** The text's tags drawn as the desktop's composer draws them (blue on a light blue). */
    private void highlight(Editable e) {
        if (highlighting) return;
        highlighting = true;
        for (Object s : e.getSpans(0, e.length(), TagSpan.class)) e.removeSpan(s);
        for (Object s : e.getSpans(0, e.length(), TagBg.class)) e.removeSpan(s);
        for (int[] t : TagList.tokens(e)) {
            e.setSpan(new TagSpan(Ui.BLUE), t[0], t[1], Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            e.setSpan(new TagBg((Ui.BLUE & 0x00ffffff) | 0x26000000), t[0], t[1], Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        }
        highlighting = false;
    }

    private static final class TagSpan extends ForegroundColorSpan { TagSpan(int c) { super(c); } }
    private static final class TagBg extends BackgroundColorSpan { TagBg(int c) { super(c); } }
}
