package dev.harbor.app;

import android.content.Intent;
import android.os.Bundle;
import android.text.Editable;
import android.text.TextWatcher;
import android.util.TypedValue;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URLEncoder;

/** The desktop's command palette as a search screen (src/palette.rs): one box over the PC's
 *  projects, chats, agents, pages and actions, grouped in the same sections with the same
 *  ranking (GET /v1/palette, ranked on the PC). With nothing typed, the recent picks come first.
 *  A tap opens the chat, the new-chat screen or the page; actions (settle, fork, fast mode) run
 *  on the PC (POST /v1/palette/run). */
public class Palette extends Base {
    private static final long DEBOUNCE_MS = 150;

    private EditText box;
    private LinearLayout list;
    private String chat; // the chat open behind it (its actions), or null
    private int asked;   // the latest question; older answers are dropped
    private JSONObject first; // the first row, for the keyboard's Go

    private final Runnable typed = this::load;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        if (noHub()) return;
        chat = getIntent().getStringExtra("chat");
        LinearLayout root = frame("Search", true);
        box = Ui.input(this, "Projects, chats, agents, pages, actions", false);
        box.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        box.setPadding(Ui.dp(14), Ui.dp(11), Ui.dp(14), Ui.dp(11));
        box.setSingleLine(true);
        box.setImeOptions(EditorInfo.IME_ACTION_GO);
        box.setOnEditorActionListener((v, id, e) -> { if (first != null) pick(first); return true; });
        box.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int st, int c, int af) { }
            @Override public void onTextChanged(CharSequence s, int st, int bf, int c) { }
            @Override public void afterTextChanged(Editable e) { Ui.main.removeCallbacks(typed); Ui.main.postDelayed(typed, DEBOUNCE_MS); }
        });
        root.addView(box, Ui.margins(Ui.fill(), 16, 4, 16, 8));
        ScrollView sv = new ScrollView(this);
        list = Ui.col(this);
        list.setPadding(Ui.dp(8), 0, Ui.dp(8), Ui.dp(24));
        sv.addView(list);
        root.addView(sv, new LinearLayout.LayoutParams(-1, 0, 1));
        box.requestFocus();
        load();
    }

    private void load() {
        final int n = ++asked;
        final String q = box.getText().toString();
        Ui.pool.execute(() -> {
            JSONObject r = null;
            String err = null;
            try {
                String path = "/v1/palette?q=" + URLEncoder.encode(q, "UTF-8") + (chat == null ? "" : "&chat=" + URLEncoder.encode(chat, "UTF-8"));
                r = hub.get(path);
            } catch (Hub.ApiError e) {
                err = e.code == 404 ? "Search needs a newer Harbor on the PC: update it there." : Hub.why(e);
            } catch (Exception e) {
                err = Hub.why(e);
            }
            final JSONObject fr = r;
            final String fe = err;
            Ui.main.post(() -> {
                if (n != asked || isFinishing()) return;
                if (fe != null) note(fe); else draw(fr.optJSONArray("sections"));
            });
        });
    }

    private void note(String s) {
        list.removeAllViews();
        first = null;
        TextView t = Ui.text(this, s, 14, Ui.G700);
        t.setPadding(Ui.dp(12), Ui.dp(16), Ui.dp(12), Ui.dp(16));
        list.addView(t, Ui.fill());
    }

    private void draw(JSONArray sections) {
        list.removeAllViews();
        first = null;
        if (sections == null || sections.length() == 0) { note("Nothing matches"); return; }
        for (int i = 0; i < sections.length(); i++) {
            JSONObject s = sections.optJSONObject(i);
            JSONArray items = s == null ? null : s.optJSONArray("items");
            if (items == null || items.length() == 0) continue;
            TextView h = Ui.text(this, s.optString("title"), 13, Ui.G700);
            h.setPadding(Ui.dp(12), Ui.dp(14), Ui.dp(12), Ui.dp(4));
            list.addView(h, Ui.fill());
            for (int j = 0; j < items.length(); j++) {
                JSONObject it = items.optJSONObject(j);
                if (it == null) continue;
                if (first == null) first = it;
                list.addView(row(it), Ui.fill());
            }
        }
    }

    /** One row: the desktop's icon, the title, its dimmed detail. */
    private View row(JSONObject it) {
        LinearLayout r = Ui.row(this);
        r.setMinimumHeight(Ui.dp(52));
        r.setPadding(Ui.dp(12), Ui.dp(6), Ui.dp(12), Ui.dp(6));
        r.setBackground(Ui.press(0, 0, 16));
        r.addView(Ui.icon(this, glyph(it.optString("icon")), 17, Ui.G700), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(22), Ui.dp(22)), 0, 0, 12, 0));
        LinearLayout t = Ui.col(this);
        t.addView(Ui.subtitle(Ui.bold(this, it.optString("title"), 15, Ui.FG)), Ui.fill());
        String d = it.optString("detail");
        if (!d.isEmpty()) t.addView(Ui.subtitle(Ui.text(this, d, 13.5f, Ui.G700)), Ui.fill());
        r.addView(t, Ui.weight());
        r.setOnClickListener(v -> pick(it));
        return r;
    }

    /** The desktop's icons (palette.rs Item::glyph). */
    private static String glyph(String name) {
        switch (name) {
            case "message": return Ui.I_CHAT;
            case "bot": return Ui.I_BOT;
            case "folder": return Ui.I_FOLDER;
            case "compose": return Ui.I_PEN;
            case "archive": case "unarchive": return Ui.I_ARCHIVE;
            case "fork": return Ui.I_FORK;
            case "gauge": return Ui.I_GAUGE;
            case "pr": return Ui.I_PR_OPEN;
            case "issue": return Ui.I_CIRCLE_DOT;
            default: return Ui.I_SEARCH;
        }
    }

    private void pick(JSONObject it) {
        String kind = it.optString("kind");
        JSONObject body = new JSONObject();
        try { body.put("id", it.optString("id")); if (chat != null) body.put("chat", chat); } catch (Exception ignored) { }
        if ("action".equals(kind)) {
            Ui.bg(this, () -> hub.call("POST", "/v1/palette/run", body), r -> {
                String toast = r.optString("toast");
                if (!toast.isEmpty()) Ui.toast(this, toast);
                String open = r.isNull("open") ? "" : r.optString("open");
                if (!open.isEmpty()) Chat.open(this, hub, open);
                finish();
            });
            return;
        }
        // Remembered as a recent pick on the PC; the screen opens here.
        Ui.pool.execute(() -> { try { hub.call("POST", "/v1/palette/run", body); } catch (Exception ignored) { } });
        switch (kind) {
            case "chat": Chat.open(this, hub, it.optString("chat")); break;
            case "new_chat": {
                Intent i = new Intent(this, NewChat.class).putExtra("hub", hub.id);
                if (!it.isNull("project")) i.putExtra("project", it.optString("project"));
                startActivity(i);
                break;
            }
            case "page": startActivity(new Intent(this, GhList.class).putExtra("hub", hub.id).putExtra("kind", "issues".equals(it.optString("page")) ? GhList.ISSUES : GhList.PRS)); break;
            default: return;
        }
        finish();
    }
}
