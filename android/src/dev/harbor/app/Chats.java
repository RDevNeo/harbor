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

/** Home for one hub: its chats as the full-screen sidebar (the reference's drawer). */
public class Chats extends Base {
    private boolean loading;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        if (noHub()) return;
        side = new Sidebar(this, null);
        setContentView(side.view);
        JSONObject cached = Hub.states.get(hub.id);
        if (cached != null) side.render(cached);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (hub == null) return;
        Hub fresh = Hub.get(this, hub.id);
        if (fresh == null) { finish(); return; }
        hub = fresh;
        side.label();
        load();
    }

    @Override
    void refresh() { load(); }

    private void load() {
        if (loading) return;
        loading = true;
        Ui.pool.execute(() -> {
            try {
                JSONObject st = hub.state();
                Ui.main.post(() -> { loading = false; if (!isFinishing()) { side.offline(null, null, null); side.render(st); } });
            } catch (Exception e) {
                String why = hub.whyDown(e);
                boolean down = Hub.down(e) != null;
                String title = hub.downTitle(e);
                Ui.main.post(() -> {
                    loading = false;
                    if (isFinishing()) return;
                    if (down) side.offline(title, why, this::retryNow); else Ui.toast(this, why);
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
        // A card over the last list it sent, not a toast that goes away: the poll keeps trying.
        if (off) side.offline(hub.downTitle(offlineError), why, this::retryNow);
        else { side.offline(null, null, null); load(); }
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
