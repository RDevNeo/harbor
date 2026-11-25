package dev.harbor.app;

import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/** A project's sheet: what the desktop's project row offers, in its order and words. The row's
 *  own buttons first (New chat in this project, Snooze), then its right-click menu (Open
 *  terminal, Pull requests, Issues, Open remote, Rename project…, Rename/Settle main chat, the icon, Move to PC…,
 *  Remove from Harbor). The hub lists them (`POST /v1/projects/menu`, logic/projectmenu.ts, the desktop's own
 *  list) and runs what happens on the PC (`POST /v1/projects/do`). */
final class ProjectMenu {
    private ProjectMenu() {}

    /** Biggest image sent as a project's icon. */
    private static final int MAX_ICON = 8 << 20;

    interface NewChat { void start(); }

    /** The project left the list (removed or settled): `say` is the toast. */
    interface Gone { void on(String say); }

    /** Opens project `pid`'s sheet (`name` while it loads). `newChat` starts a chat in it;
     *  `after` runs after a change; `removed` after Remove from Harbor. */
    static void show(Base a, Hub hub, String pid, String name, NewChat newChat, Runnable after, Gone gone) {
        Ui.bg(a, () -> {
            try {
                return hub.call("POST", "/v1/projects/menu", new JSONObject().put("project", pid));
            } catch (Hub.ApiError e) {
                if (e.code == 404 && !e.getMessage().contains("project")) throw new Hub.ApiError(404, "This PC runs an older Hub without the project menu: update it first.");
                throw e;
            }
        }, m -> sheet(a, hub, pid, name, m, newChat, after, gone));
    }

    private static String glyph(String name) {
        switch (name) {
            case "plus": return Ui.I_PLUS;
            case "clock": return Ui.I_CLOCK;
            case "terminal": return Ui.I_TERMINAL;
            case "pr": return Ui.I_PR_OPEN;
            case "circle-dot": return Ui.I_CIRCLE_DOT;
            case "external": return Ui.I_EXTERNAL;
            case "archive": return Ui.I_ARCHIVE;
            case "unarchive": return Ui.I_ARCHIVE;
            case "users": return Ui.I_USERS;
            case "link": return Ui.I_LINK;
            case "monitor": return Ui.I_MONITOR;
            case "merge": return Ui.I_MERGE;
            case "lock": return Ui.I_LOCK;
            default: return null;
        }
    }

    private static void sheet(Base a, Hub hub, String pid, String name, JSONObject m, NewChat newChat, Runnable after, Gone gone) {
        String title = m.optString("name", name == null || name.isEmpty() ? "Project" : name);
        // Its folder on another PC (or one of two projects with this name): which one, as on the row.
        String where = Place.hint(Hub.states.get(hub.id), pid);
        if (!where.isEmpty()) title = title + " · " + where;
        Sheet s = new Sheet(a, title);
        String snoozed = m.isNull("snoozed") ? "" : m.optString("snoozed");

        // The row's own buttons (none for a settled project).
        JSONArray rs = m.optJSONArray("row");
        LinearLayout row = rs != null && rs.length() > 0 ? s.card() : null;
        for (int i = 0; rs != null && i < rs.length(); i++) {
            JSONObject it = rs.optJSONObject(i);
            if (it == null) continue;
            String act = it.optString("act");
            String sub = act.equals("snooze") && !snoozed.isEmpty() ? "Snoozed " + snoozed : null;
            if (row.getChildCount() > 0) row.addView(Ui.gap(a));
            row.addView(Ui.cardRow(a, glyph(it.optString("icon")), it.optString("label"), sub, Ui.FG, v -> {
                s.dismiss();
                if (act.equals("new_chat")) newChat.start();
                else if (act.equals("snooze")) Snooze.project(a, hub, pid, snoozed, after);
            }), Ui.fill());
        }

        LinearLayout card = null;
        JSONArray items = m.optJSONArray("items");
        for (int i = 0; items != null && i < items.length(); i++) {
            JSONObject it = items.optJSONObject(i);
            if (it == null) continue;
            if (card == null || it.optBoolean("sep")) card = s.card();
            else card.addView(Ui.gap(a));
            boolean on = it.optBoolean("enabled", true);
            String act = it.optString("act");
            LinearLayout r = Ui.cardRow(a, glyph(it.optString("icon")), it.optString("label"), it.optString("desc"), on ? Ui.FG : Ui.G600,
                    on ? v -> { s.dismiss(); act(a, hub, pid, m, act, after, gone); } : null);
            Ui.wrapSub(r, 3);
            card.addView(r, Ui.fill());
        }
        s.show();
    }

    private static void act(Base a, Hub hub, String pid, JSONObject m, String act, Runnable after, Gone gone) {
        JSONObject main = m.optJSONObject("main");
        switch (act) {
            case "prs":
            case "issues":
                a.startActivity(new Intent(a, GhList.class).putExtra("hub", hub.id)
                        .putExtra("kind", act.equals("issues") ? GhList.ISSUES : GhList.PRS).putExtra("project", m.optString("github")));
                a.closeDrawer();
                break;
            case "remote": {
                String url = m.optString("remote");
                try { a.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception e) { Ui.copy(a, url); }
                break;
            }
            case "rename_project":
                renameProject(a, hub, pid, m, after);
                break;
            case "rename_main":
                if (main != null) Chats.rename(a, hub, main, after);
                break;
            case "settle_main":
                if (main != null) Ui.bg(a, () -> hub.call("PATCH", "/v1/chats/" + main.optString("id"), new JSONObject().put("settled", true)),
                        r -> { Ui.toast(a, "Settled “" + main.optString("title") + "”"); after.run(); });
                break;
            case "refresh_icon":
            case "website_icon":
                Ui.bg(a, () -> run(hub, pid, act, null), r -> Ui.toast(a, act.equals("refresh_icon") ? "Icon refreshed on " + m.optString("pc_name", "the PC") : "Back to the website's icon"));
                break;
            case "choose_icon":
                a.pickImage(uri -> {
                    Ui.toast(a, "Sending the icon…");
                    Ui.bg(a, () -> {
                        JSONObject up = upload(a, hub, uri);
                        return run(hub, pid, act, up.optString("id"));
                    }, r -> Ui.toast(a, "Icon set on " + m.optString("pc_name", "the PC")));
                });
                break;
            case "clean_worktrees":
                // Its chats' worktrees whose PR was merged, on the PC that holds the project: what it did, in a toast.
                Ui.toast(a, "Cleaning up merged worktrees…");
                Ui.bg(a, () -> run(hub, pid, act, null), r -> { Ui.toast(a, r.optString("said", "Done")); after.run(); });
                break;
            case "settle_project":
                Ui.bg(a, () -> run(hub, pid, act, null), r -> gone.on("Settled “" + m.optString("name", "Project") + "”: it's under Settled"));
                break;
            case "unsettle_project":
                Ui.bg(a, () -> run(hub, pid, act, null), r -> { Ui.toast(a, "“" + m.optString("name", "Project") + "” is back"); after.run(); });
                break;
            case "move_workspace":
                Chats.moveWorkspace(a, m.optJSONObject("workspaces"), m.optString("name", "Project"),
                        ws -> hub.call("POST", "/v1/projects/do", new JSONObject().put("project", pid).put("act", "workspace").put("workspace", ws)), after);
                break;
            case "share_workspace":
                Chats.shareWorkspace(a, m.optJSONObject("shares"), m.optString("name", "Project"),
                        () -> { JSONObject again = hub.call("POST", "/v1/projects/menu", new JSONObject().put("project", pid)); return again == null ? null : again.optJSONObject("shares"); },
                        (ws, on) -> hub.call("POST", "/v1/projects/do", new JSONObject().put("project", pid).put("act", "share").put("workspace", ws).put("on", on)), after);
                break;
            case "move_pc":
                ProjectMove.show(a, hub, pid, m.optString("name", "Project"), after);
                break;
            case "pin_account":
                pinAccount(a, hub, pid, m, after);
                break;
            case "remove":
                Ui.dialog(a).setTitle("Remove project?")
                        .setMessage("Its chats are removed from Hub. Nothing on disk is touched.")
                        .setNegativeButton("Cancel", null)
                        .setPositiveButton("Remove", (d, w) -> Ui.bg(a, () -> run(hub, pid, act, null), r -> gone.on("Removed “" + m.optString("name", "Project") + "” from Hub")))
                        .show();
                break;
            default:
                break;
        }
    }

    /** Rename project…: its name in every PC's sidebar (`do` act `rename`); its folder stays as it is. */
    private static void renameProject(Base a, Hub hub, String pid, JSONObject m, Runnable after) {
        String was = m.optString("name");
        EditText e = Ui.input(a, "Name", false);
        e.setText(was);
        e.setSelectAllOnFocus(true);
        FrameLayout f = new FrameLayout(a);
        f.setPadding(Ui.dp(20), Ui.dp(8), Ui.dp(20), 0);
        f.addView(e);
        Ui.dialog(a).setTitle("Rename project").setView(f).setNegativeButton("Cancel", null)
                .setPositiveButton("Rename", (d, w) -> {
                    String t = e.getText().toString().trim();
                    if (t.isEmpty() || t.equals(was)) return;
                    Ui.bg(a, () -> hub.call("POST", "/v1/projects/do", new JSONObject().put("project", pid).put("act", "rename").put("name", t)),
                            r -> { Ui.toast(a, r.optString("said", "Renamed")); after.run(); });
                }).show();
        e.requestFocus();
    }

    /** Not an account id: the chooser's Unpin. */
    private static final String UNPIN = "\u0000unpin";

    /** Keep on one account…: the accounts the menu offers (`pin_choices`), the pinned one checked,
     *  and Unpin while it has a pin. The pick goes to `do` as `pin_account` (`account` null: unpin). */
    private static void pinAccount(Base a, Hub hub, String pid, JSONObject m, Runnable after) {
        JSONObject pin = Run.pinOf(m);
        List<Sheet.Option> o = new ArrayList<>();
        JSONArray choices = m.optJSONArray("pin_choices");
        for (int i = 0; choices != null && i < choices.length(); i++) {
            JSONObject c = choices.optJSONObject(i);
            if (c != null) o.add(new Sheet.Option(c.optString("id"), c.optString("label", c.optString("id")), "", true));
        }
        if (pin != null) o.add(new Sheet.Option(UNPIN, "Unpin", "Hub may switch its chats to another account again", true));
        String note = Run.pinBroken(pin) ? Run.sentence(pin.optString("tip")) + " Pick another account, or unpin it."
                : "Its chats and agents stay on the account you pick: Hub won't switch them, and at a usage limit they wait for the reset.";
        Sheet.pick(a, "Keep on one account", note, o, Run.pinAccount(pin), id -> Ui.bg(a,
                () -> hub.call("POST", "/v1/projects/do", new JSONObject().put("project", pid).put("act", "pin_account")
                        .put("account", UNPIN.equals(id) ? JSONObject.NULL : id)),
                r -> { Ui.toast(a, r.optString("text", "Done")); after.run(); }));
    }

    private static JSONObject run(Hub hub, String pid, String act, String upload) throws Exception {
        JSONObject b = new JSONObject().put("project", pid).put("act", act);
        if (upload != null) b.put("upload", upload);
        return hub.call("POST", "/v1/projects/do", b);
    }

    /** The picked image, sent to the PC (`POST /v1/upload`). */
    private static JSONObject upload(Base a, Hub hub, Uri uri) throws IOException {
        String name = "icon.png";
        try (Cursor c = a.getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst() && c.getString(0) != null) name = c.getString(0);
        } catch (Exception ignored) { }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (InputStream in = a.getContentResolver().openInputStream(uri)) {
            if (in == null) throw new IOException("Couldn't read that image");
            byte[] buf = new byte[1 << 16];
            for (int n; (n = in.read(buf)) > 0; ) {
                out.write(buf, 0, n);
                if (out.size() > MAX_ICON) throw new IOException("That image is too big for an icon (8 MB at most)");
            }
        }
        byte[] bytes = out.toByteArray();
        return hub.upload(name, null, new ByteArrayInputStream(bytes), bytes.length);
    }
}
