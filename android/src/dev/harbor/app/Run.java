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

    String kind() {
        String k = kindOf(account);
        return k.isEmpty() ? kindOfModel() : k;
    }

    /** Another PC's chat can run on an account this PC doesn't have, and then only its model says
     *  the provider. Claude's list first: other providers can offer Claude's models too. */
    private String kindOfModel() {
        if (model.isEmpty()) return "";
        if (has(Chat.byKind(st, "models", "claude"), model)) return "claude";
        JSONObject all = st.optJSONObject("models");
        if (all != null) for (java.util.Iterator<String> k = all.keys(); k.hasNext(); ) {
            String kind = k.next();
            if (has(all.optJSONArray(kind), model)) return kind;
        }
        return model.startsWith("claude-") ? "claude" : "";
    }

    private static boolean has(JSONArray list, String id) {
        if (list != null) for (int i = 0; i < list.length(); i++) if (Hub.optId(list.opt(i)).equals(id)) return true;
        return false;
    }

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
    /** The places a chat can run. "Auto" (the PC with the most free memory) is for a chat not made
     *  yet (decided at its first message) and for a started one whose hub moves it there at the pick
     *  (auto_moves), as a pick of that PC would. */
    JSONArray devices() {
        JSONArray d = st.optJSONArray("devices");
        if (d == null) return new JSONArray();
        if (chat == null || chat.optBoolean("auto_moves")) return d;
        JSONArray out = new JSONArray();
        for (int i = 0; i < d.length(); i++) {
            JSONObject o = d.optJSONObject(i);
            if (o == null || !o.optBoolean("auto")) out.put(d.opt(i));
        }
        return out;
    }

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
            case "device": return chat != null ? "can't move it now" : "only Claude chats run on other devices";
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

    String modelLabel() { return model.isEmpty() ? "Default model" : Labels.modelName(Hub.labelOf(models(), model)); }
    String effortLabel() {
        String e = effort.isEmpty() ? defaultEffort() : effort;
        return e.isEmpty() ? "" : Hub.labelOf(efforts(), e);
    }

    /** What an empty effort means on this provider (the PC's `default_efforts`; "" on older PCs). */
    String defaultEffort() {
        JSONObject d = st == null ? null : st.optJSONObject("default_efforts");
        return d == null ? "" : d.optString(kind(), "");
    }
    String accessLabel() { return Hub.labelOf(accesses(), access); }
    /** The composer's device: "Auto → <PC>" where Auto would put it now, or where it put this chat. */
    String deviceLabel() {
        String placed = chat == null || chat.isNull("auto_label") ? "" : chat.optString("auto_label", "");
        if (!placed.isEmpty()) return placed;
        JSONArray d = devices();
        for (int i = 0; i < d.length(); i++) {
            JSONObject o = d.optJSONObject(i);
            if (o != null && o.optBoolean("auto") && device.equals(o.optString("id"))) return o.optString("pick_label", o.optString("label"));
        }
        return Hub.labelOf(d, device);
    }

    String projectLabel() {
        if (project.isEmpty()) return "No project";
        JSONArray p = st.optJSONArray("projects");
        if (p != null) for (int i = 0; i < p.length(); i++) {
            JSONObject o = p.optJSONObject(i);
            if (o != null && project.equals(o.optString("id"))) return o.optString("name");
        }
        return "Project";
    }

    /** The badges over the composer: logo, "Opus 5.5" and "Medium". */
    void badges(Composer comp) {
        comp.badges(Labels.logo(kind()), modelLabel(), Labels.effortBadge(effortLabel(), efforts().length() > 0));
    }

    // ---- a new chat's choices stay valid ----

    static String valid(JSONArray list, String cur) {
        if (list == null || list.length() == 0) return "";
        for (int i = 0; i < list.length(); i++) if (Hub.optId(list.opt(i)).equals(cur)) return cur;
        return Hub.optId(list.opt(0));
    }

    /** Accounts offered: a new chat's must be able to start one (can_start: every provider since
     *  0.153); a started chat's come from allowed_accounts. */
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
        // An unset effort is the provider's default, not the first level ("Low").
        effort = efforts().length() == 0 ? "" : valid(efforts(), effort.isEmpty() ? defaultEffort() : effort);
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

    /** The effort picker alone (the slash menu's /effort). */
    void pickEffort(Activity a, Changed ch) {
        if (!can("effort") || efforts().length() == 0) { Ui.toast(a, "The effort can't change now: " + why("effort")); return; }
        pickList(a, "Effort", efforts(), effort, "effort", ch);
    }

    private void pickList(Activity a, String title, JSONArray list, String cur, String field, Changed ch) {
        List<Sheet.Option> o = new ArrayList<>();
        // A started chat moves to the device picked (its session with it); the hub says why it
        // can't go to some (device_why, by device id). Hubs before 0.63 don't send it.
        boolean started = chat != null && "device".equals(field) && chat.has("device_why");
        JSONObject no = started ? chat.optJSONObject("device_why") : null;
        for (int i = 0; i < list.length(); i++) {
            Object e = list.opt(i);
            String sub = "";
            boolean ok = true;
            if (e instanceof JSONObject) {
                JSONObject j = (JSONObject) e;
                // A row is its name; only Auto's says more (where it would go), and one that can't be
                // picked says why.
                sub = j.optBoolean("auto") ? j.optString("desc", "") : "";
                boolean off = j.has("online") && !j.isNull("online") && !j.optBoolean("online");
                // Another PC running Harbor: the chat starts there, so it has to be on.
                if (j.optBoolean("hub") && off) { sub = "Harbor · off"; ok = false; }
                if (j.has("enabled") && !j.optBoolean("enabled", true)) ok = false;
            }
            String why = no == null ? "" : no.optString(Hub.optId(e), "");
            if (!why.isEmpty()) { sub = why; ok = false; }
            o.add(new Sheet.Option(Hub.optId(e), Hub.optLabel(e), sub, ok));
        }
        String note = started ? "The chat moves to the device you pick, with its Claude session, and goes on there." : null;
        Sheet.pick(a, title, note, o, cur, id -> { if (!id.equals(cur)) ch.apply(field, id); });
    }

    private void pickAccount(Activity a, Changed ch) {
        List<Sheet.Option> o = new ArrayList<>();
        // Each with its logo and whose it is: their workspace photo (hubs from 0.163), else their initials.
        for (JSONObject j : accounts()) o.add(new Sheet.Option(j.optString("id"), j.optString("label", j.optString("id")), usage(j), true,
                Ui.accountMark(a, Labels.logo(j.optString("kind")), j.optString("badge"), 28, j.optString("photo"))));
        String note = chat == null ? "Any provider can lead a chat. OpenCode works alone, without subagents." : null;
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
