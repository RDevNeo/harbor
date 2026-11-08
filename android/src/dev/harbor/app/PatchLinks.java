package dev.harbor.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.view.Gravity;
import android.view.View;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

/** A chat's patch buttons that open a page (ts/packages/agents/src/patches.ts, `url` actions): a row of
 *  chips over the composer, like the desktop's shelf. Commands, messages and panels stay on the desktop. */
final class PatchLinks {
    final HorizontalScrollView view;
    private final LinearLayout row;
    private final Activity a;
    private final Hub hub;
    private final String chat;
    private String shown = "";

    PatchLinks(Activity a, Hub hub, String chat) {
        this.a = a;
        this.hub = hub;
        this.chat = chat;
        row = Ui.row(a);
        view = new HorizontalScrollView(a);
        view.setHorizontalScrollBarEnabled(false);
        view.addView(row);
        view.setVisibility(View.GONE);
    }

    /** Asks the hub again; a hub without patches (older, or none here) leaves the row hidden. */
    void load() {
        Ui.bg(a, () -> {
            try {
                return hub.call("GET", "/v1/chats/" + chat + "/patches", null).optJSONArray("links");
            } catch (Exception e) {
                return null;
            }
        }, this::show);
    }

    private void show(JSONArray links) {
        String key = links == null ? "" : links.toString();
        if (key.equals(shown)) return;
        shown = key;
        row.removeAllViews();
        int n = links == null ? 0 : links.length();
        for (int i = 0; i < n; i++) {
            JSONObject l = links.optJSONObject(i);
            if (l == null) continue;
            String url = l.optString("url", "");
            if (!url.startsWith("http://") && !url.startsWith("https://")) continue;
            LinearLayout chip = Ui.row(a);
            chip.setGravity(Gravity.CENTER_VERTICAL);
            chip.setPadding(Ui.dp(10), 0, Ui.dp(11), 0);
            chip.setBackground(Ui.press(0, Ui.LINE, 10));
            chip.addView(Ui.icon(a, Ui.I_EXTERNAL, 13, Ui.G700));
            TextView t = Ui.text(a, l.optString("title", url), 13.5f, Ui.G700);
            t.setSingleLine(true);
            chip.addView(t, Ui.margins(Ui.wrap(), 6, 0, 0, 0));
            chip.setContentDescription("Open " + l.optString("title", url));
            chip.setOnClickListener(v -> {
                try {
                    a.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE));
                } catch (Exception e) {
                    Ui.copy(a, url);
                }
            });
            row.addView(chip, Ui.margins(new LinearLayout.LayoutParams(-2, Ui.dp(34)), 0, 0, 8, 0));
        }
        view.setVisibility(row.getChildCount() == 0 ? View.GONE : View.VISIBLE);
    }
}
