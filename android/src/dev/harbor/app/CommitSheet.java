package dev.harbor.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.TextUtils;
import android.text.style.ForegroundColorSpan;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

/** A commit pill's card (the desktop's commit dialog): subject, id, author and date, message,
 *  changed files with their counts, then Open on GitHub, Copy SHA and Show diff. The hub reads
 *  it from git (GET /v1/chats/{id}/commit/{sha}, PROTOCOL.md); the phone runs no git. */
final class CommitSheet {
    private final Activity a;
    private final Hub hub;
    private final String path;
    private final Sheet sheet;
    private final LinearLayout box;
    private LinearLayout diffBox;
    private boolean diffLoading;

    private CommitSheet(Activity a, Hub hub, String chat, String sha) {
        this.a = a;
        this.hub = hub;
        this.path = "/v1/chats/" + Uri.encode(chat) + "/commit/" + Uri.encode(sha);
        sheet = new Sheet(a, "Commit");
        box = Ui.col(a);
        sheet.body.addView(box, Ui.fill());
    }

    /** `preview`: the item's `commits` entry, drawn until the hub answers. */
    static void open(Activity a, Hub hub, String chat, String sha, JSONObject preview) {
        CommitSheet s = new CommitSheet(a, hub, chat, sha);
        JSONObject p = preview != null ? preview : new JSONObject();
        try { if (!p.has("sha")) p.put("sha", sha); } catch (Exception ignored) { }
        s.draw(p, true, null);
        s.sheet.show();
        s.load();
    }

    private void load() {
        Ui.pool.execute(() -> {
            JSONObject r = null;
            String err = null;
            try { r = hub.call("GET", path, null, 30_000); } catch (Exception e) { err = Hub.why(e); }
            final JSONObject fr = r; final String fe = err;
            Ui.main.post(() -> {
                if (a.isFinishing() || !sheet.dialog.isShowing()) return;
                if (fr != null) draw(fr, false, null);
                else draw(null, false, fe);
            });
        });
    }

    private void draw(JSONObject c, boolean loading, String error) {
        box.removeAllViews();
        diffBox = null;
        if (c == null) {
            box.addView(Ui.text(a, error == null ? "Couldn't load the commit." : error, 15, Ui.G700), Ui.fill());
            return;
        }
        String sha = c.optString("sha");
        String subject = c.optString("subject", "");
        TextView title = Ui.title(a, subject.isEmpty() ? sha : subject, 21);
        box.addView(title, Ui.fill());

        // The id, the author and when.
        SpannableStringBuilder meta = new SpannableStringBuilder();
        String shortId = sha.substring(0, Math.min(sha.length(), Math.max(7, c.optString("short").length())));
        meta.append(Ui.I_COMMIT).setSpan(new Ui.Font(Ui.icons, 0), 0, 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        int a0 = meta.length();
        meta.append("  ").append(shortId);
        meta.setSpan(new Ui.Font(Ui.mono, 0), a0, meta.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        meta.setSpan(new ForegroundColorSpan(Ui.FG), a0, meta.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        String author = c.optString("author", "");
        if (!author.isEmpty()) meta.append("  ·  ").append(author);
        long at = c.optLong("at", 0);
        if (at > 0) meta.append("  ·  ").append(Ui.ago(at * 1000));
        box.addView(Ui.text(a, meta, 14, Ui.G700), Ui.margins(Ui.fill(), 0, 6, 0, 0));

        if (loading) {
            box.addView(Ui.text(a, "Loading…", 14, Ui.G700), Ui.margins(Ui.fill(), 0, 14, 0, 0));
            return;
        }
        String body = c.optString("body", "");
        if (!body.isEmpty()) {
            TextView b = Ui.text(a, body, 15, Ui.FG);
            b.setTextIsSelectable(true);
            box.addView(b, Ui.margins(Ui.fill(), 0, 14, 0, 0));
        }

        // Changed files.
        JSONArray files = c.optJSONArray("files");
        int n = (files == null ? 0 : files.length()) + c.optInt("more_files");
        long adds = 0, dels = 0;
        for (int i = 0; files != null && i < files.length(); i++) {
            JSONObject f = files.optJSONObject(i);
            if (f == null) continue;
            adds += f.optLong("adds", 0);
            dels += f.optLong("dels", 0);
        }
        SpannableStringBuilder head = new SpannableStringBuilder(n + (n == 1 ? " file changed  " : " files changed  "));
        color(head, "+" + adds, Ui.GREEN);
        head.append(" ");
        color(head, "−" + dels, Ui.RED);
        box.addView(Ui.bold(a, head, 14, Ui.FG), Ui.margins(Ui.fill(), 0, 18, 0, 8));
        if (files != null && files.length() > 0) {
            LinearLayout card = Ui.card(a);
            card.setPadding(Ui.dp(14), Ui.dp(8), Ui.dp(14), Ui.dp(8));
            for (int i = 0; i < files.length(); i++) {
                JSONObject f = files.optJSONObject(i);
                if (f == null) continue;
                LinearLayout r = Ui.row(a);
                r.setGravity(Gravity.CENTER_VERTICAL);
                r.setPadding(0, Ui.dp(5), 0, Ui.dp(5));
                TextView p = Ui.text(a, f.optString("path"), 13, Ui.FG);
                p.setTypeface(Ui.mono);
                p.setSingleLine(true);
                p.setEllipsize(TextUtils.TruncateAt.MIDDLE);
                r.addView(p, Ui.weight());
                SpannableStringBuilder cnt = new SpannableStringBuilder();
                if (f.isNull("adds") || f.isNull("dels")) cnt.append("binary");
                else {
                    color(cnt, "+" + f.optLong("adds"), Ui.GREEN);
                    cnt.append(" ");
                    color(cnt, "−" + f.optLong("dels"), Ui.RED);
                }
                TextView ct = Ui.text(a, cnt, 12, Ui.G700);
                ct.setTypeface(Ui.mono);
                r.addView(ct, Ui.margins(new LinearLayout.LayoutParams(-2, -2), 10, 0, 0, 0));
                card.addView(r, Ui.fill());
            }
            if (c.optInt("more_files") > 0)
                card.addView(Ui.text(a, "and " + c.optInt("more_files") + " more", 13, Ui.G700), Ui.fill());
            box.addView(card, Ui.fill());
        }

        // Actions.
        String url = c.optString("url", "");
        if (!url.isEmpty() && !"null".equals(url) && Render.web(url)) {
            box.addView(Ui.button(a, Ui.I_EXTERNAL + "  Open on GitHub", true, v -> {
                try { a.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception e) { Ui.copy(a, url); }
            }), Ui.margins(Ui.fill(), 0, 18, 0, 0));
            iconFont((TextView) box.getChildAt(box.getChildCount() - 1));
        }
        box.addView(Ui.button(a, Ui.I_COPY + "  Copy SHA", false, v -> Ui.copy(a, sha)), Ui.margins(Ui.fill(), 0, 10, 0, 0));
        iconFont((TextView) box.getChildAt(box.getChildCount() - 1));
        TextView show = Ui.button(a, "Show diff", false, null);
        show.setOnClickListener(v -> toggleDiff(show));
        box.addView(show, Ui.margins(Ui.fill(), 0, 10, 0, 0));
        diffBox = Ui.col(a);
        box.addView(diffBox, Ui.margins(Ui.fill(), 0, 12, 0, 0));
    }

    private void toggleDiff(TextView button) {
        if (diffBox == null || diffLoading) return;
        if (diffBox.getChildCount() > 0) {
            diffBox.removeAllViews();
            button.setText("Show diff");
            return;
        }
        diffLoading = true;
        button.setText("Loading the diff…");
        LinearLayout into = diffBox;
        Ui.pool.execute(() -> {
            JSONObject r = null;
            String err = null;
            try { r = hub.call("GET", path + "?diff=1", null, 40_000); } catch (Exception e) { err = Hub.why(e); }
            final JSONObject fr = r; final String fe = err;
            Ui.main.post(() -> {
                diffLoading = false;
                if (a.isFinishing() || into != diffBox) return;
                if (fr == null) { button.setText("Show diff"); Ui.toast(a, fe); return; }
                button.setText("Hide diff");
                GhItem.diffInto(a, into, fr.optJSONArray("lines"), fr.optBoolean("clipped"));
            });
        });
    }

    /** A button label that starts with a Lucide glyph: the glyph in the icon font. */
    private static void iconFont(TextView t) {
        CharSequence s = t.getText();
        SpannableStringBuilder b = new SpannableStringBuilder(s);
        b.setSpan(new Ui.Font(Ui.icons, 0), 0, 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        t.setText(b);
    }

    private static void color(SpannableStringBuilder s, String text, int color) {
        int a = s.length();
        s.append(text);
        s.setSpan(new ForegroundColorSpan(color), a, s.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
    }
}
