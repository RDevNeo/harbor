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
        // Hubs from 0.88 say which chat is its project's main chat: any other lead of a project can become it.
        if (!sub && c.has("main") && !c.optBoolean("main") && !c.isNull("project_id")) items.add("Make main chat");
        if (!sub) items.add("Move to PC…");
        items.add("Delete");
        Ui.dialog(a).setTitle(c.optString("title", "Chat")).setItems(items.toArray(new String[0]), (d, w) -> {
            String it = items.get(w);
            if (w == 0) rename(a, hub, c, after);
            else if (w == 1) Ui.bg(a, () -> hub.call("PATCH", "/v1/chats/" + id, new JSONObject().put("settled", !settled)),
                    r -> { if (settled) after.run(); else landAfterSettle(a, hub, id, after); });
            else if (it.startsWith("Snooze")) Snooze.sheet(a, hub, c, after);
            else if (it.equals("Move to PC…")) movePc(a, hub, c, after);
            else if (it.equals("Make main chat")) Ui.bg(a, () -> hub.call("POST", "/v1/chats/" + id + "/main", new JSONObject()),
                    r -> { Ui.toast(a, "Its project's header opens it now"); after.run(); });
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

    /** After a chat is settled on this phone: its project's main chat opens, as the desktop does
     *  after its own (hubs from 0.88, whose state names main chats). With none yet, or when the
     *  settled chat was the main chat (which frees the project), New chat starts the project's
     *  main chat; a chat of no project lands on New chat. From a chat screen or the search, that
     *  screen closes; an older hub runs `older` instead. */
    static void landAfterSettle(Base a, Hub hub, String id, Runnable older) {
        Ui.bg(a, hub::state, st -> {
            JSONObject c = null;
            JSONArray cs = st.optJSONArray("chats");
            for (int i = 0; cs != null && i < cs.length(); i++) {
                JSONObject x = cs.optJSONObject(i);
                if (x != null && id.equals(x.optString("id"))) c = x;
            }
            if (c == null || !c.has("main")) { older.run(); return; }
            // The settled chat may still read as main while it's another PC's copy on its way.
            openMain(a, hub, st, c.isNull("project_id") ? "" : c.optString("project_id"), id);
        });
    }

    /** A project picked on this phone (the search's project rows): its main chat opens, or its
     *  page (New chat starting the main chat) while it has none, as the desktop's project row.
     *  An older hub, which names no main chats, gets the new-chat screen there as before. */
    static void openProject(Base a, Hub hub, String pid) {
        Ui.bg(a, hub::state, st -> {
            JSONObject tree = st.optJSONObject("tree");
            JSONArray tp = tree == null ? null : tree.optJSONArray("projects");
            boolean mains = false;
            for (int i = 0; tp != null && i < tp.length(); i++) {
                JSONObject p = tp.optJSONObject(i);
                mains |= p != null && p.has("main");
            }
            if (mains) { openMain(a, hub, st, pid, null); return; }
            a.startActivity(new Intent(a, NewChat.class).putExtra("hub", hub.id).putExtra("project", pid));
            if (a instanceof Palette) a.finish();
        });
    }

    /** Opens project `pid`'s main chat as `st` names it (never chat `not`), else its page; ""
     *  (no project): New chat. A chat screen or the search under it closes. */
    private static void openMain(Base a, Hub hub, JSONObject st, String pid, String not) {
        String main = null;
        JSONObject tree = st.optJSONObject("tree");
        JSONArray tp = tree == null ? null : tree.optJSONArray("projects");
        for (int i = 0; tp != null && i < tp.length(); i++) {
            JSONObject p = tp.optJSONObject(i);
            if (p != null && !pid.isEmpty() && pid.equals(p.optString("id")) && !p.isNull("main")) main = p.optString("main");
        }
        if (main != null && !main.equals(not)) Chat.open(a, hub, main);
        else {
            Intent i = new Intent(a, NewChat.class).putExtra("hub", hub.id);
            if (!pid.isEmpty()) i.putExtra("project", pid).putExtra("main", true);
            a.startActivity(i);
        }
        if (a instanceof Chat || a instanceof Palette) a.finish();
        else a.closeDrawer();
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
