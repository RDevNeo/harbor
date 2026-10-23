package dev.harbor.app;

import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** One hub's chats, grouped by project (most recent first), settled ones folded at the end. */
public class Chats extends Base {
    private LinearLayout list;
    private TextView update;
    private boolean showSettled;
    private boolean loading;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        if (noHub()) return;
        LinearLayout root = frame(hub.label(), true);
        update = Ui.bold(this, "Update", 13, Ui.BG);
        update.setPadding(Ui.dp(12), Ui.dp(6), Ui.dp(12), Ui.dp(6));
        update.setBackground(Ui.press(Ui.FG, 0, 14));
        update.setVisibility(View.GONE);
        update.setOnClickListener(v -> settings());
        barActions.addView(update, Ui.margins(Ui.wrap(), 0, 0, 4, 0));
        action(Ui.I_SETTINGS, v -> settings());

        FrameLayout body = new FrameLayout(this);
        ScrollView sv = new ScrollView(this);
        list = Ui.col(this);
        list.setPadding(0, 0, 0, Ui.dp(96));
        sv.addView(list);
        body.addView(sv, frameFill());
        TextView fab = Ui.bold(this, "New chat", 15, Ui.BG);
        fab.setCompoundDrawablePadding(Ui.dp(8));
        fab.setPadding(Ui.dp(20), Ui.dp(14), Ui.dp(20), Ui.dp(14));
        fab.setBackground(Ui.press(Ui.FG, 0, 24));
        fab.setElevation(Ui.dp(6));
        fab.setOnClickListener(v -> startActivity(new Intent(this, NewChat.class).putExtra("hub", hub.id)));
        FrameLayout.LayoutParams fp = new FrameLayout.LayoutParams(-2, -2, android.view.Gravity.BOTTOM | android.view.Gravity.END);
        fp.setMargins(0, 0, Ui.dp(20), Ui.dp(24));
        body.addView(fab, fp);
        root.addView(body, new LinearLayout.LayoutParams(-1, 0, 1));

        JSONObject cached = Hub.states.get(hub.id);
        if (cached != null) render(cached);
    }

    private void settings() { startActivity(new Intent(this, Settings.class).putExtra("hub", hub.id)); }

    @Override
    protected void onResume() {
        super.onResume();
        if (hub == null) return;
        Hub fresh = Hub.get(this, hub.id);
        if (fresh == null) { finish(); return; }
        hub = fresh;
        barTitle.setText(hub.label());
        load();
    }

    private void load() {
        if (loading) return;
        loading = true;
        Ui.pool.execute(() -> {
            try {
                JSONObject st = hub.state();
                Ui.main.post(() -> { loading = false; if (!isFinishing()) { sub("Harbor " + st.optString("version"), Ui.G700); render(st); } });
            } catch (Exception e) {
                String why = Hub.why(e);
                Ui.main.post(() -> {
                    loading = false;
                    if (isFinishing()) return;
                    sub(why, Ui.RED);
                    if (Hub.states.get(hub.id) == null) { list.removeAllViews(); list.addView(hint(why)); }
                });
            }
        });
    }

    @Override
    void onEvents(Set<String> changed, boolean stateChanged, boolean reconnect) {
        // Only the list's own data: a streaming reply's new text alone changes nothing here (its
        // updated time comes as a state change).
        if (stateChanged || reconnect) load();
    }

    @Override
    void onOffline(boolean off, String why) {
        if (off) sub(why, Ui.RED); else load();
    }

    private void render(JSONObject st) {
        JSONObject app = st.optJSONObject("app");
        update.setVisibility(app != null && app.optLong("version_code") > Settings.myCode(this) ? View.VISIBLE : View.GONE);

        list.removeAllViews();
        Map<String, String> projects = new HashMap<>();
        JSONArray pa = st.optJSONArray("projects");
        if (pa != null) for (int i = 0; i < pa.length(); i++) {
            JSONObject p = pa.optJSONObject(i);
            if (p != null) projects.put(p.optString("id"), p.optString("name"));
        }
        List<JSONObject> chats = new ArrayList<>();
        JSONArray ca = st.optJSONArray("chats");
        if (ca != null) for (int i = 0; i < ca.length(); i++) if (ca.optJSONObject(i) != null) chats.add(ca.optJSONObject(i));
        chats.sort((a, b) -> Long.compare(b.optLong("updated_ms"), a.optLong("updated_ms")));

        if (chats.isEmpty()) { list.addView(hint("No chats yet. Start one with New chat.")); return; }

        // Groups in order of their newest chat.
        LinkedHashMap<String, List<JSONObject>> groups = new LinkedHashMap<>();
        List<JSONObject> settled = new ArrayList<>();
        for (JSONObject c : chats) {
            if ("sub".equals(c.optString("role"))) continue; // a lead's subagents live inside its chat
            if (c.optBoolean("settled")) { settled.add(c); continue; }
            String pid = c.isNull("project_id") ? "" : c.optString("project_id");
            groups.computeIfAbsent(pid, k -> new ArrayList<>()).add(c);
        }
        for (Map.Entry<String, List<JSONObject>> g : groups.entrySet()) {
            String name = g.getKey().isEmpty() ? "No project" : projects.getOrDefault(g.getKey(), "Project");
            list.addView(Ui.section(this, name));
            for (JSONObject c : g.getValue()) list.addView(chatRow(c, st));
        }
        if (!settled.isEmpty()) {
            TextView h = Ui.section(this, (showSettled ? "▾ " : "▸ ") + "Settled · " + settled.size());
            h.setBackground(Ui.press(0, 0, 0));
            h.setOnClickListener(v -> { showSettled = !showSettled; render(st); });
            list.addView(h, Ui.fill());
            if (showSettled) for (JSONObject c : settled) list.addView(chatRow(c, st));
        }
    }

    private View chatRow(JSONObject c, JSONObject st) {
        String id = c.optString("id");
        LinearLayout r = Ui.row(this);
        r.setPadding(Ui.dp(16), Ui.dp(10), Ui.dp(16), Ui.dp(10));
        r.setBackground(Ui.press(0, 0, 0));
        boolean running = c.optBoolean("running");
        int q = Hub.queued(c);
        View dot = Ui.dot(this, running ? Ui.GREEN : q > 0 ? Ui.AMBER : 0, 8);
        r.addView(dot);
        LinearLayout t = Ui.col(this);
        String title = c.optString("title");
        t.addView(Ui.subtitle(Ui.text(this, title.isEmpty() ? "New chat" : title, 15,
                c.optBoolean("settled") ? Ui.G900 : Ui.FG)));
        StringBuilder sb = new StringBuilder();
        String dev = Hub.labelOf(st.optJSONArray("devices"), c.optString("device"));
        if (!dev.isEmpty()) sb.append(dev).append(" · ");
        String model = c.optString("model");
        if (!model.isEmpty()) sb.append(Hub.labelOf(Chat.byKind(st, "models", kindOf(st, c.optString("account"))), model)).append(" · ");
        sb.append(Ui.ago(c.optLong("updated_ms")));
        if (q > 0) sb.append(" · ").append(q).append(" waiting");
        t.addView(Ui.subtitle(Ui.text(this, sb, 12, Ui.G700)));
        r.addView(t, Ui.margins(Ui.weight(), 12, 0, 0, 0));
        r.setOnClickListener(v -> startActivity(new Intent(this, Chat.class).putExtra("hub", hub.id).putExtra("chat", id)));
        r.setOnLongClickListener(v -> { menu(this, hub, c, this::load, null); return true; });
        return r;
    }

    static String kindOf(JSONObject st, String account) {
        JSONArray a = st.optJSONArray("accounts");
        if (a != null) for (int i = 0; i < a.length(); i++) {
            JSONObject o = a.optJSONObject(i);
            if (o != null && account.equals(o.optString("id"))) return o.optString("kind");
        }
        return "";
    }

    /** Rename / settle / delete, shared with the chat screen's menu. after runs on success;
     *  deleted (if any) runs instead after a delete. */
    static void menu(Base a, Hub hub, JSONObject c, Runnable after, Runnable deleted) {
        String id = c.optString("id");
        boolean settled = c.optBoolean("settled");
        String[] items = {"Rename", settled ? "Unsettle" : "Settle", "Delete"};
        Ui.dialog(a).setTitle(c.optString("title", "Chat")).setItems(items, (d, w) -> {
            if (w == 0) rename(a, hub, c, after);
            else if (w == 1) Ui.bg(a, () -> hub.call("PATCH", "/v1/chats/" + id, new JSONObject().put("settled", !settled)), r -> after.run());
            else Ui.dialog(a).setTitle("Delete this chat?")
                    .setMessage("“" + c.optString("title") + "” and its transcript are removed on the PC. A running turn is stopped first.")
                    .setNegativeButton("Cancel", null)
                    .setPositiveButton("Delete", (d2, w2) -> Ui.bg(a, () -> hub.call("DELETE", "/v1/chats/" + id, null), r -> {
                        Chat.forget(a, hub.id, id);
                        (deleted != null ? deleted : after).run();
                    }))
                    .show();
        }).show();
    }

    static void rename(Base a, Hub hub, JSONObject c, Runnable after) {
        EditText e = Ui.input(a, "Title", false);
        e.setText(c.optString("title"));
        e.setSelectAllOnFocus(true);
        FrameLayout f = new FrameLayout(a);
        f.setPadding(Ui.dp(20), Ui.dp(8), Ui.dp(20), 0);
        f.addView(e);
        Ui.dialog(a).setTitle("Rename chat").setView(f).setNegativeButton("Cancel", null)
                .setPositiveButton("Rename", (d, w) -> {
                    String t = e.getText().toString().trim();
                    if (t.isEmpty()) return;
                    Ui.bg(a, () -> hub.call("PATCH", "/v1/chats/" + c.optString("id"), new JSONObject().put("title", t)), r -> after.run());
                }).show();
        e.requestFocus();
    }
}
