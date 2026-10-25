package dev.harbor.app;

import android.app.Activity;
import android.widget.LinearLayout;
import android.widget.Switch;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** A chat's run settings as the composer shows them: account, model, effort, access, device,
 *  fast (and the project, for a new chat). For a started chat each one may be locked by the
 *  hub (chat.switchable); locked rows are greyed with the hub's reason (switch_reason). */
final class Run {
    final JSONObject st;
    final JSONObject chat; // null: a chat that doesn't exist yet
    String project = "", account = "", model = "", effort = "", access = "", device = "";
    boolean fast;

    /** What the user picked: field is project|account|model|effort|access|device|fast. */
    interface Changed { void apply(String field, Object value); }

    Run(JSONObject st, JSONObject chat) {
        this.st = st == null ? new JSONObject() : st;
        this.chat = chat;
        fast = this.st.optBoolean("fast");
        if (chat != null) {
            account = chat.optString("account");
            model = chat.optString("model");
            effort = chat.optString("effort");
            access = chat.optString("access");
            device = chat.optString("device");
            fast = chat.optBoolean("fast", fast);
            project = chat.isNull("project_id") ? "" : chat.optString("project_id");
        }
    }

    String kind() { return kindOf(account); }

    String kindOf(String acc) {
        JSONArray a = st.optJSONArray("accounts");
        if (a != null) for (int i = 0; i < a.length(); i++) {
            JSONObject o = a.optJSONObject(i);
            if (o != null && acc.equals(o.optString("id"))) return o.optString("kind");
        }
        return "";
    }

    JSONArray models() { return Chat.byKind(st, "models", kind()); }
    JSONArray efforts() { return Chat.byKind(st, "efforts", kind()); }
    JSONArray accesses() { return Chat.byKind(st, "access", kind()); }
    JSONArray devices() { JSONArray d = st.optJSONArray("devices"); return d == null ? new JSONArray() : d; }

    /** Whether field can change now. A new chat: everything its provider has. */
    boolean can(String f) {
        if (chat == null) return !"device".equals(f) || "claude".equals(kind());
        JSONObject s = chat.optJSONObject("switchable");
        return s != null && s.optBoolean(f, false);
    }

    String why(String f) {
        JSONObject r = chat == null ? null : chat.optJSONObject("switch_reason");
        String s = r == null ? "" : r.optString(f, "");
        if (!s.isEmpty()) return s;
        switch (f) {
            case "device": return chat != null ? "fixed once the chat has started" : "only Claude chats run on other devices";
            case "account": return "this chat stays on its provider";
            case "effort": return "this provider has no effort levels";
            case "fast": return "only Claude and Codex have fast mode";
            default: return "can't change now";
        }
    }

    // ---- labels ----

    String accountLabel() {
        JSONArray a = st.optJSONArray("accounts");
        if (a != null) for (int i = 0; i < a.length(); i++) {
            JSONObject o = a.optJSONObject(i);
            if (o != null && account.equals(o.optString("id"))) return o.optString("label", account);
        }
        return account;
    }

    static String usage(JSONObject a) {
        StringBuilder sb = new StringBuilder();
        if (!a.optBoolean("signed_in", true)) sb.append("signed out");
        JSONArray u = a.optJSONArray("usage");
        if (u != null) for (int i = 0; i < u.length(); i++) {
            JSONObject w = u.optJSONObject(i);
            if (w == null) continue;
            if (sb.length() > 0) sb.append(" · ");
            sb.append(w.optString("label")).append(' ').append(Math.round(w.optDouble("percent"))).append('%');
        }
        return sb.toString();
    }

    String modelLabel() { return model.isEmpty() ? "Default model" : Hub.labelOf(models(), model); }
    String effortLabel() { return effort.isEmpty() ? "" : Hub.labelOf(efforts(), effort); }
    String accessLabel() { return Hub.labelOf(accesses(), access); }
    String deviceLabel() { return Hub.labelOf(devices(), device); }

    String projectLabel() {
        if (project.isEmpty()) return "No project";
        JSONArray p = st.optJSONArray("projects");
        if (p != null) for (int i = 0; i < p.length(); i++) {
            JSONObject o = p.optJSONObject(i);
            if (o != null && project.equals(o.optString("id"))) return o.optString("name");
        }
        return "Project";
    }

    /** "Opus 5.5 Medium", the composer pill. */
    String pill() {
        String e = effortLabel();
        return e.isEmpty() ? modelLabel() : modelLabel() + " " + e;
    }

    // ---- a new chat's choices stay valid ----

    static String valid(JSONArray list, String cur) {
        if (list == null || list.length() == 0) return "";
        for (int i = 0; i < list.length(); i++) if (Hub.optId(list.opt(i)).equals(cur)) return cur;
        return Hub.optId(list.opt(0));
    }

    /** Accounts offered: a new chat's must be able to start one (leads run on Claude); a
     *  started chat's come from allowed_accounts. */
    List<JSONObject> accounts() {
        List<JSONObject> out = new ArrayList<>();
        JSONArray a = st.optJSONArray("accounts");
        JSONArray allowed = chat == null ? null : chat.optJSONArray("allowed_accounts");
        if (a != null) for (int i = 0; i < a.length(); i++) {
            JSONObject o = a.optJSONObject(i);
            if (o == null) continue;
            if (chat == null ? !o.optBoolean("can_start", true) : !contains(allowed, o.optString("id"))) continue;
            out.add(o);
        }
        return out;
    }

    private static boolean contains(JSONArray a, String id) {
        if (a == null) return true;
        for (int i = 0; i < a.length(); i++) if (id.equals(a.optString(i))) return true;
        return false;
    }

    void normalize() {
        List<JSONObject> acc = accounts();
        boolean ok = false;
        for (JSONObject o : acc) if (o.optString("id").equals(account)) ok = true;
        if (!ok && !acc.isEmpty()) account = acc.get(0).optString("id");
        model = valid(models(), model);
        effort = efforts().length() == 0 ? "" : valid(efforts(), effort);
        access = valid(accesses(), access);
        device = "claude".equals(kind()) ? valid(devices(), device) : "";
        // A PC of the mesh that's off can't take a new chat: back to this one.
        JSONArray ds = devices();
        if (chat == null) for (int i = 0; i < ds.length(); i++) {
            JSONObject d = ds.optJSONObject(i);
            if (d != null && device.equals(d.optString("id")) && d.optBoolean("hub") && !d.optBoolean("online", true)) device = "";
        }
        if (!project.isEmpty()) {
            JSONArray p = st.optJSONArray("projects");
            boolean found = false;
            if (p != null) for (int i = 0; i < p.length(); i++) {
                JSONObject o = p.optJSONObject(i);
                if (o != null && project.equals(o.optString("id"))) found = true;
            }
            if (!found) project = "";
        }
    }

    // ---- rows and sheets ----

    /** The run-settings rows (as cards) into a sheet; each opens a picker. */
    void rows(Activity a, Sheet s, Changed ch) {
        LinearLayout c = s.card();
        if (chat == null) {
            c.addView(row(a, Ui.I_FOLDER, "Project", projectLabel(), true, null, () -> pickProject(a, ch)), Ui.fill());
            c.addView(Ui.gap(a));
        }
        c.addView(row(a, Ui.I_LOCK_OPEN, "Permission", accessLabel(), can("access"), why("access"), () -> pickList(a, "Permission", accesses(), access, "access", ch)), Ui.fill());
        if ("claude".equals(kind()) && devices().length() > 0) {
            c.addView(Ui.gap(a));
            c.addView(row(a, Ui.I_MONITOR, "Device", deviceLabel(), can("device"), why("device"), () -> pickList(a, "Device", devices(), device, "device", ch)), Ui.fill());
        }

        LinearLayout m = s.card();
        m.addView(row(a, Ui.I_USER, "Account", accountLabel(), can("account"), why("account"), () -> pickAccount(a, ch)), Ui.fill());
        m.addView(Ui.gap(a));
        m.addView(row(a, Ui.I_SPARKLES, "Model", modelLabel(), can("model") && models().length() > 0, why("model"), () -> pickList(a, "Model", models(), model, "model", ch)), Ui.fill());
        if (efforts().length() > 0) {
            m.addView(Ui.gap(a));
            m.addView(row(a, Ui.I_BRAIN, "Effort", effortLabel(), can("effort"), why("effort"), () -> pickList(a, "Effort", efforts(), effort, "effort", ch)), Ui.fill());
        }
        m.addView(Ui.gap(a));
        LinearLayout f = Ui.cardRow(a, Ui.disc(a, Ui.I_GAUGE, 44), "Fast mode", can("fast") ? "for every chat on this PC" : why("fast"),
                can("fast") ? Ui.FG : Ui.G600, null);
        Switch sw = new Switch(a);
        sw.setChecked(fast);
        sw.setEnabled(can("fast"));
        sw.setOnCheckedChangeListener((b, on) -> ch.apply("fast", on));
        f.addView(sw);
        m.addView(f, Ui.fill());
    }

    private LinearLayout row(Activity a, String glyph, String title, String value, boolean enabled, String reason, Runnable on) {
        LinearLayout r = Ui.cardRow(a, Ui.disc(a, glyph, 44), title, enabled ? value : value + " · " + reason,
                enabled ? Ui.FG : Ui.G600, enabled ? v -> on.run() : null);
        if (enabled) r.addView(Ui.chevron(a));
        return r;
    }

    /** The model picker alone (the slash menu's /model). */
    void pickModel(Activity a, Changed ch) {
        if (!can("model") || models().length() == 0) { Ui.toast(a, "The model can't change now: " + why("model")); return; }
        pickList(a, "Model", models(), model, "model", ch);
    }

    private void pickList(Activity a, String title, JSONArray list, String cur, String field, Changed ch) {
        List<Sheet.Option> o = new ArrayList<>();
        for (int i = 0; i < list.length(); i++) {
            Object e = list.opt(i);
            String sub = "";
            boolean ok = true;
            if (e instanceof JSONObject) {
                JSONObject j = (JSONObject) e;
                sub = j.optString("desc", "");
                boolean off = j.has("online") && !j.isNull("online") && !j.optBoolean("online");
                // Another PC running Harbor: the chat starts there, so it has to be on.
                if (j.optBoolean("hub")) { sub = off ? "Harbor · off" : "Harbor · the chat runs there"; ok = !off; }
                else if (off) sub = sub.isEmpty() ? "offline" : sub + " · offline";
            }
            o.add(new Sheet.Option(Hub.optId(e), Hub.optLabel(e), sub, ok));
        }
        Sheet.pick(a, title, null, o, cur, id -> ch.apply(field, id));
    }

    private void pickAccount(Activity a, Changed ch) {
        List<Sheet.Option> o = new ArrayList<>();
        for (JSONObject j : accounts()) o.add(new Sheet.Option(j.optString("id"), j.optString("label", j.optString("id")), usage(j), true));
        String note = chat == null ? "New chats are project leads, and leads run on Claude." : null;
        Sheet.pick(a, "Account", note, o, account, id -> ch.apply("account", id));
    }

    private void pickProject(Activity a, Changed ch) {
        List<Sheet.Option> o = new ArrayList<>();
        o.add(new Sheet.Option("", "No project", "runs in your home folder on the PC", true));
        JSONArray p = st.optJSONArray("projects");
        if (p != null) for (int i = 0; i < p.length(); i++) {
            JSONObject j = p.optJSONObject(i);
            if (j != null) o.add(new Sheet.Option(j.optString("id"), j.optString("name"), "", true));
        }
        Sheet.pick(a, "Project", null, o, project, id -> ch.apply("project", id));
    }
}
