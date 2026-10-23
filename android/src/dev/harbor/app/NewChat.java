package dev.harbor.app;

import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.view.View;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** Starts a chat on the hub: project, device (Claude only), account (with its usage), model,
 *  effort, access and fast, then the first message. Remembers the last picks per hub. */
public class NewChat extends Base {
    private JSONObject st;
    private LinearLayout form;
    private EditText composer;
    private Attach attach;
    private TextView start;
    private boolean starting;
    private String project, device, account, model, effort, access;
    private boolean fast;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        if (noHub()) return;
        LinearLayout root = frame("New chat", true);
        sub(hub.label(), Ui.G700);
        ScrollView sv = new ScrollView(this);
        LinearLayout col = Ui.col(this);
        form = Ui.col(this);
        col.addView(form, Ui.fill());
        composer = Ui.input(this, "What should it do?", true);
        composer.setMinLines(4);
        composer.setMaxLines(12);
        composer.setGravity(android.view.Gravity.TOP);
        col.addView(composer, Ui.margins(Ui.fill(), 16, 16, 16, 0));
        attach = new Attach(this, hub, null);
        col.addView(attach.view, Ui.margins(Ui.fill(), 8, 0, 8, 0));
        LinearLayout btns = Ui.row(this);
        btns.addView(Ui.button(this, "Attach", false, v -> attach.choose()), Ui.wrap());
        btns.addView(new View(this), Ui.weight());
        start = Ui.button(this, "Start chat", true, v -> start());
        btns.addView(start, Ui.wrap());
        col.addView(btns, Ui.margins(Ui.fill(), 16, 12, 16, 24));
        sv.addView(col);
        root.addView(sv, new LinearLayout.LayoutParams(-1, 0, 1));

        st = Hub.states.get(hub.id);
        if (st != null) init(); else form.addView(hint("Loading…"));
        Ui.bg(this, hub::state, s -> { boolean first = st == null; st = s; if (first) init(); else renderForm(); });
    }

    private SharedPreferences prefs() { return getSharedPreferences("newchat-" + hub.id, MODE_PRIVATE); }

    /** Last pick on this phone, else the desktop's current pick, else the first option. */
    private void init() {
        JSONObject d = st.optJSONObject("defaults");
        if (d == null) d = new JSONObject();
        SharedPreferences p = prefs();
        project = p.getString("project", d.isNull("project_id") ? "" : d.optString("project_id"));
        device = p.getString("device", d.optString("device"));
        account = p.getString("account", d.optString("account"));
        model = p.getString("model", d.optString("model"));
        effort = p.getString("effort", d.optString("effort"));
        access = p.getString("access", d.optString("access"));
        fast = st.optBoolean("fast");
        renderForm();
    }

    private String kind() {
        JSONObject a = acc(account);
        return a == null ? "" : a.optString("kind");
    }

    private JSONObject acc(String id) {
        JSONArray a = st.optJSONArray("accounts");
        if (a != null) for (int i = 0; i < a.length(); i++) {
            JSONObject o = a.optJSONObject(i);
            if (o != null && o.optString("id").equals(id)) return o;
        }
        return null;
    }

    private static String accLabel(JSONObject a) {
        StringBuilder sb = new StringBuilder(a.optString("label", a.optString("id")));
        if (!a.optBoolean("signed_in", true)) sb.append(" · signed out");
        JSONArray u = a.optJSONArray("usage");
        if (u != null) for (int i = 0; i < u.length(); i++) {
            JSONObject w = u.optJSONObject(i);
            if (w != null) sb.append(" · ").append(w.optString("label")).append(' ').append(Math.round(w.optDouble("percent"))).append('%');
        }
        return sb.toString();
    }

    /** Keeps cur if it's in the list, else the first entry ("" for an empty list). */
    private static String valid(JSONArray list, String cur) {
        if (list == null || list.length() == 0) return "";
        for (int i = 0; i < list.length(); i++) if (Hub.optId(list.opt(i)).equals(cur)) return cur;
        return Hub.optId(list.opt(0));
    }

    private void renderForm() {
        form.removeAllViews();
        // Projects: "No project" first.
        JSONArray projects = new JSONArray();
        try {
            projects.put(new JSONObject().put("id", "").put("label", "No project"));
            JSONArray pa = st.optJSONArray("projects");
            if (pa != null) for (int i = 0; i < pa.length(); i++) {
                JSONObject p = pa.optJSONObject(i);
                if (p != null) projects.put(new JSONObject().put("id", p.optString("id")).put("label", p.optString("name")));
            }
        } catch (Exception ignored) { }
        project = valid(projects, project);

        JSONArray accounts = new JSONArray();
        JSONArray aa = st.optJSONArray("accounts");
        try {
            if (aa != null) for (int i = 0; i < aa.length(); i++) {
                JSONObject a = aa.optJSONObject(i);
                // A new chat is a project lead, and leads run on Claude (can_start), as on the desktop.
                if (a != null && a.optBoolean("can_start", true)) accounts.put(new JSONObject().put("id", a.optString("id")).put("label", accLabel(a)));
            }
        } catch (Exception ignored) { }
        account = valid(accounts, account);
        String kind = kind();
        JSONArray models = Chat.byKind(st, "models", kind), efforts = Chat.byKind(st, "efforts", kind),
                accesses = Chat.byKind(st, "access", kind), devices = st.optJSONArray("devices");
        model = valid(models, model);
        effort = valid(efforts, effort);
        access = valid(accesses, access);
        device = "claude".equals(kind) ? valid(devices, device) : "";

        form.addView(pick("Project", projects, project, v -> { project = v; renderForm(); }));
        if ("claude".equals(kind) && devices != null && devices.length() > 0)
            form.addView(pick("Device", devices, device, v -> { device = v; renderForm(); }));
        form.addView(pick("Account", accounts, account, v -> { account = v; renderForm(); }));
        if (models.length() > 0) form.addView(pick("Model", models, model, v -> { model = v; renderForm(); }));
        if (efforts.length() > 0) form.addView(pick("Effort", efforts, effort, v -> { effort = v; renderForm(); }));
        if (accesses.length() > 0) form.addView(pick("Access", accesses, access, v -> { access = v; renderForm(); }));

        LinearLayout r = Ui.row(this);
        r.setPadding(Ui.dp(16), Ui.dp(8), Ui.dp(12), Ui.dp(8));
        LinearLayout t = Ui.col(this);
        t.addView(Ui.text(this, "Fast", 15, Ui.FG));
        t.addView(Ui.text(this, "Harbor-wide on that PC", 12, Ui.G700));
        r.addView(t, Ui.weight());
        Switch sw = new Switch(this);
        sw.setChecked(fast);
        sw.setOnCheckedChangeListener((b, on) -> fast = on);
        r.addView(sw);
        form.addView(r, Ui.fill());
    }

    interface Pick { void on(String id); }

    private View pick(String label, JSONArray list, String cur, Pick on) {
        LinearLayout r = Ui.row(this);
        r.setPadding(Ui.dp(16), Ui.dp(10), Ui.dp(12), Ui.dp(10));
        r.setBackground(Ui.press(0, 0, 0));
        LinearLayout t = Ui.col(this);
        t.addView(Ui.text(this, label, 12, Ui.G700));
        t.addView(Ui.subtitle(Ui.text(this, Hub.labelOf(list, cur), 15, Ui.FG)));
        r.addView(t, Ui.weight());
        r.addView(Ui.icon(this, Ui.I_DOWN, 16, Ui.G600));
        r.setOnClickListener(v -> {
            List<String> labels = new ArrayList<>();
            int sel = -1;
            for (int i = 0; i < list.length(); i++) {
                Object o = list.opt(i);
                String l = Hub.optLabel(o);
                if (o instanceof JSONObject) {
                    JSONObject j = (JSONObject) o;
                    String desc = j.optString("desc", "");
                    if (!desc.isEmpty()) l += " — " + desc;
                    if (j.has("online") && !j.optBoolean("online")) l += " (offline)";
                }
                labels.add(l);
                if (Hub.optId(o).equals(cur)) sel = i;
            }
            Ui.dialog(this).setTitle(label).setSingleChoiceItems(labels.toArray(new String[0]), sel, (d, w) -> {
                d.dismiss();
                on.on(Hub.optId(list.opt(w)));
            }).show();
        });
        return r;
    }

    private void start() {
        if (starting || st == null) return;
        String text = composer.getText().toString().trim();
        if (text.isEmpty() && !attach.any()) { Ui.toast(this, "Write the first message"); return; }
        if (attach.busy()) { Ui.toast(this, "Still uploading…"); return; }
        if (account.isEmpty()) { Ui.toast(this, "This PC has no account to run with"); return; }
        prefs().edit().putString("project", project).putString("device", device).putString("account", account)
                .putString("model", model).putString("effort", effort).putString("access", access).apply();
        starting = true;
        start.setAlpha(0.4f);
        JSONObject body = new JSONObject();
        try {
            body.put("project_id", project.isEmpty() ? JSONObject.NULL : Hub.num(project)).put("device", device)
                    .put("account", account).put("model", model).put("effort", effort).put("access", access)
                    .put("fast", fast).put("text", text).put("files", attach.ids());
        } catch (Exception ignored) { }
        Ui.pool.execute(() -> {
            String id = null, err = null;
            try {
                id = hub.call("POST", "/v1/chats", body).optString("id");
            } catch (Exception e) {
                err = Hub.why(e);
            }
            final String fid = id, fe = err;
            Ui.main.post(() -> {
                starting = false;
                start.setAlpha(1f);
                if (isFinishing()) return;
                if (fe != null) { Ui.toast(this, fe); return; }
                Chat.open(this, hub, fid);
                finish();
            });
        });
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        attach.result(req, res, data);
    }
}
