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
        Update.shown(this, hub.id, null);
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
        // Sub-agents move with their lead: no "Move to PC…" on them.
        boolean sub = "sub".equals(c.optString("role"));
        // Snooze, the desktop row's clock: unsettled leads, on hubs that have it (0.78).
        boolean snooze = !sub && !settled && c.has("snoozed_until_ms");
        List<String> items = new ArrayList<>();
        items.add("Rename");
        items.add(settled ? "Unsettle" : "Settle");
        if (snooze) items.add(c.isNull("snoozed_until_ms") ? "Snooze…" : "Snoozed · " + c.optString("snoozed_label"));
        if (!sub) items.add("Move to PC…");
        items.add("Delete");
        Ui.dialog(a).setTitle(c.optString("title", "Chat")).setItems(items.toArray(new String[0]), (d, w) -> {
            String it = items.get(w);
            if (w == 0) rename(a, hub, c, after);
            else if (w == 1) Ui.bg(a, () -> hub.call("PATCH", "/v1/chats/" + id, new JSONObject().put("settled", !settled)), r -> after.run());
            else if (it.startsWith("Snooze")) Snooze.sheet(a, hub, c, after);
            else if (it.equals("Move to PC…")) movePc(a, hub, c, after);
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

    /** "Move to PC…": a sheet of the mesh's PCs as the chat's home PC lists them (greyed, with
     *  why, when the chat can't go there); the pick hands the chat over (`POST move_pc`). The
     *  hub decides everything; an old hub without the call says so in a toast. */
    static void movePc(Base a, Hub hub, JSONObject c, Runnable after) {
        String id = c.optString("id");
        Ui.bg(a, () -> {
            try {
                return hub.call("GET", "/v1/chats/" + id + "/move_targets", null);
            } catch (Hub.ApiError e) {
                // A hub from before "Move to PC…".
                if (e.code == 404) throw new Hub.ApiError(404, "This PC runs an older Harbor that can't move chats: update it first.");
                throw e;
            }
        }, r -> {
            JSONArray ts = r.optJSONArray("targets");
            String why = r.isNull("why") ? "" : r.optString("why", "");
            List<Sheet.Option> o = new ArrayList<>();
            for (int i = 0; ts != null && i < ts.length(); i++) {
                JSONObject t = ts.optJSONObject(i);
                if (t == null) continue;
                String no = t.isNull("why") ? "" : t.optString("why", "");
                o.add(new Sheet.Option(t.optString("id"), t.optString("name", t.optString("id")), no.isEmpty() ? "Goes on there" : no, no.isEmpty()));
            }
            if (o.isEmpty()) { Ui.toast(a, "No other PCs: pair one in Settings › Devices on a PC"); return; }
            String note = why.isEmpty()
                    ? "The chat and its sub-agents move with their Claude sessions and go on there. Its project must be on that PC, with no uncommitted changes here."
                    : "Can't move now: " + why;
            Sheet.pick(a, "Move to PC", note, o, null, pc -> Ui.bg(a,
                    () -> hub.call("POST", "/v1/chats/" + id + "/move_pc", new JSONObject().put("pc", pc)),
                    r2 -> { Ui.toast(a, "Moving to " + r2.optString("to", "the PC") + "…"); after.run(); }));
        });
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
