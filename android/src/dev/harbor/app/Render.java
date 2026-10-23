package dev.harbor.app;

import android.content.Context;
import android.graphics.Typeface;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.method.LinkMovementMethod;
import android.text.style.BackgroundColorSpan;
import android.text.style.ForegroundColorSpan;
import android.text.style.URLSpan;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.TableLayout;
import android.widget.TableRow;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

/** Draws the hub's block model (PROTOCOL.md: heading, paragraph, code, list, quote, rule,
 *  table; spans with bold/italic/code/link) with plain views. Every text view gets the same
 *  long-press handler, so links stay tappable and the item menu still opens. */
final class Render {
    private final Context c;
    private final View.OnLongClickListener longPress;

    Render(Context c, View.OnLongClickListener longPress) {
        this.c = c;
        this.longPress = longPress;
    }

    /** blocks, or the raw markdown as plain text when the hub sent none. */
    View text(JSONObject item) {
        LinearLayout col = Ui.col(c);
        JSONArray blocks = item.optJSONArray("blocks");
        if (blocks != null && blocks.length() > 0) blocks(col, blocks);
        else col.addView(para(item.optString("markdown", item.optString("text"))));
        return col;
    }

    void blocks(LinearLayout into, JSONArray blocks) {
        for (int i = 0; i < blocks.length(); i++) {
            JSONObject b = blocks.optJSONObject(i);
            if (b == null) continue;
            View v = block(b);
            if (v == null) continue;
            LinearLayout.LayoutParams p = Ui.fill();
            if (i > 0) p.topMargin = Ui.dp(8);
            into.addView(v, p);
        }
    }

    private View block(JSONObject b) {
        String k = b.optString("kind", b.optString("type"));
        switch (k) {
            case "heading": {
                int lvl = b.optInt("level", 1);
                TextView t = Ui.bold(c, spans(b.optJSONArray("spans")), lvl <= 1 ? 20 : lvl == 2 ? 18 : 16, Ui.FG);
                return links(t);
            }
            case "paragraph":
                return links(Ui.text(c, spans(b.optJSONArray("spans")), 15, Ui.FG));
            case "code":
                return code(b.optString("lang"), b.optString("text"));
            case "list":
                return list(b);
            case "quote": {
                LinearLayout r = Ui.row(c);
                r.setGravity(Gravity.TOP);
                View bar = new View(c);
                bar.setBackgroundColor(Ui.G500);
                r.addView(bar, new LinearLayout.LayoutParams(Ui.dp(3), ViewGroup.LayoutParams.MATCH_PARENT));
                LinearLayout inner = Ui.col(c);
                JSONArray bs = b.optJSONArray("blocks");
                if (bs != null) blocks(inner, bs);
                r.addView(inner, Ui.margins(Ui.weight(), 10, 0, 0, 0));
                return r;
            }
            case "rule": {
                LinearLayout box = Ui.col(c);
                box.addView(Ui.rule(c));
                return box;
            }
            case "table":
                return table(b.optJSONArray("rows"));
            default: {
                String t = b.optString("text");
                return t.isEmpty() ? null : para(t);
            }
        }
    }

    TextView para(String s) {
        TextView t = Ui.text(c, s, 15, Ui.FG);
        t.setOnLongClickListener(longPress);
        return t;
    }

    private TextView links(TextView t) {
        CharSequence s = t.getText();
        if (s instanceof Spanned && ((Spanned) s).getSpans(0, s.length(), URLSpan.class).length > 0)
            t.setMovementMethod(LinkMovementMethod.getInstance());
        t.setOnLongClickListener(longPress);
        return t;
    }

    CharSequence spans(JSONArray spans) {
        SpannableStringBuilder sb = new SpannableStringBuilder();
        if (spans == null) return sb;
        for (int i = 0; i < spans.length(); i++) {
            JSONObject s = spans.optJSONObject(i);
            if (s == null) continue;
            String text = s.optString("text");
            int a = sb.length();
            sb.append(text);
            int z = sb.length();
            if (a == z) continue;
            int f = Spanned.SPAN_EXCLUSIVE_EXCLUSIVE;
            boolean code = s.optBoolean("code"), bold = s.optBoolean("bold"), italic = s.optBoolean("italic");
            Typeface tf = code ? Ui.mono : bold ? Ui.semi : null;
            if (tf != null || italic) sb.setSpan(new Ui.Font(tf, italic ? -0.2f : 0), a, z, f);
            if (s.optBoolean("strike")) sb.setSpan(new android.text.style.StrikethroughSpan(), a, z, f);
            if (code) {
                sb.setSpan(new BackgroundColorSpan(Ui.G300), a, z, f);
                sb.setSpan(new android.text.style.RelativeSizeSpan(0.9f), a, z, f);
            }
            String link = s.optString("link", "");
            if (web(link)) {
                sb.setSpan(new URLSpan(link), a, z, f);
                sb.setSpan(new ForegroundColorSpan(Ui.BLUE), a, z, f);
            }
        }
        return sb;
    }

    /** Only web links are tappable: a reply is agent output, which can be steered by what the
     *  agent read, so harbor://pair, intent:, tel: and the like stay plain text. */
    static boolean web(String link) {
        String l = link.trim().toLowerCase(java.util.Locale.ROOT);
        return l.startsWith("https://") || l.startsWith("http://");
    }

    /** A monospace block that scrolls sideways instead of wrapping. */
    View code(String lang, String text) {
        LinearLayout box = Ui.col(c);
        box.setBackground(Ui.round(Ui.G100, Ui.G300, 6));
        if (lang != null && !lang.isEmpty() && !"null".equals(lang)) {
            TextView l = Ui.text(c, lang, 11, Ui.G700);
            l.setPadding(Ui.dp(12), Ui.dp(6), Ui.dp(12), 0);
            box.addView(l);
        }
        HorizontalScrollView h = new HorizontalScrollView(c);
        h.setHorizontalScrollBarEnabled(false);
        TextView t = Ui.text(c, trimEnd(text), 13, Ui.FG);
        t.setTypeface(Ui.mono);
        t.setLineSpacing(0, 1.1f);
        t.setPadding(Ui.dp(12), Ui.dp(8), Ui.dp(12), Ui.dp(10));
        t.setOnLongClickListener(v -> { Ui.copy(c, text); return true; });
        h.addView(t);
        box.addView(h, Ui.fill());
        return box;
    }

    private View list(JSONObject b) {
        boolean ordered = b.optBoolean("ordered");
        int start = b.optInt("start", 1);
        LinearLayout col = Ui.col(c);
        JSONArray items = b.optJSONArray("items");
        if (items == null) return col;
        for (int i = 0; i < items.length(); i++) {
            LinearLayout r = Ui.row(c);
            r.setGravity(Gravity.TOP);
            TextView mark = Ui.text(c, ordered ? (start + i) + "." : "•", 15, Ui.G900);
            mark.setMinWidth(Ui.dp(ordered ? 22 : 14));
            r.addView(mark);
            LinearLayout inner = Ui.col(c);
            JSONArray bs = items.optJSONArray(i);
            if (bs != null) blocks(inner, bs);
            r.addView(inner, Ui.margins(Ui.weight(), 4, 0, 0, 0));
            LinearLayout.LayoutParams p = Ui.fill();
            if (i > 0) p.topMargin = Ui.dp(4);
            col.addView(r, p);
        }
        return col;
    }

    /** First row is the header. Scrolls sideways when wider than the screen. */
    private View table(JSONArray rows) {
        HorizontalScrollView h = new HorizontalScrollView(c);
        TableLayout t = new TableLayout(c);
        t.setBackground(Ui.round(0, Ui.G400, 6));
        t.setPadding(Ui.dp(1), Ui.dp(1), Ui.dp(1), Ui.dp(1));
        if (rows != null) for (int i = 0; i < rows.length(); i++) {
            JSONArray cells = rows.optJSONArray(i);
            if (cells == null) continue;
            TableRow tr = new TableRow(c);
            if (i == 0) tr.setBackgroundColor(Ui.G100);
            else if (i % 2 == 0) tr.setBackgroundColor(0xff0e0e0e);
            for (int j = 0; j < cells.length(); j++) {
                Object cell = cells.opt(j);
                CharSequence s = cell instanceof JSONArray ? spans((JSONArray) cell) : String.valueOf(cell);
                TextView tv = i == 0 ? Ui.bold(c, s, 13, Ui.FG) : Ui.text(c, s, 13, Ui.FG);
                tv.setPadding(Ui.dp(10), Ui.dp(6), Ui.dp(10), Ui.dp(6));
                tv.setMaxWidth(Ui.dp(280));
                links(tv);
                tr.addView(tv);
            }
            t.addView(tr);
        }
        h.addView(t);
        return h;
    }

    static String trimEnd(String s) {
        int n = s.length();
        while (n > 0 && (s.charAt(n - 1) == '\n' || s.charAt(n - 1) == ' ')) n--;
        return s.substring(0, n);
    }
}
