package dev.harbor.app;

import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.view.Gravity;
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

/** A new session: the serif prompt, which project it runs in, and the composer with the run
 *  settings (account, model, effort, access, device, fast) in its + sheet and model pill.
 *  Remembers the last picks per hub. */
public class NewChat extends Base {
    private JSONObject st;
    private Composer comp;
    private Attach attach;
    private Run run;
    private TextView project;
    private boolean starting;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        if (noHub()) return;
        LinearLayout root = frame("", menuButton(), false);

        LinearLayout mid = Ui.col(this);
        mid.setGravity(Gravity.CENTER);
        mid.setPadding(Ui.dp(28), 0, Ui.dp(28), Ui.dp(40));
        TextView ask = Ui.title(this, "What should we work on?", 30);
        ask.setGravity(Gravity.CENTER);
        mid.addView(ask, Ui.fill());
        project = Ui.text(this, "", 16, Ui.G700);
        project.setGravity(Gravity.CENTER);
        project.setPadding(Ui.dp(16), Ui.dp(8), Ui.dp(16), Ui.dp(8));
        project.setBackground(Ui.press(0, 0, 18));
        project.setOnClickListener(v -> { if (run != null) pickProject(); });
        LinearLayout.LayoutParams pp = Ui.wrap();
        pp.topMargin = Ui.dp(10);
        pp.gravity = Gravity.CENTER_HORIZONTAL;
        mid.addView(project, pp);
        root.addView(mid, new LinearLayout.LayoutParams(-1, 0, 1));

        attach = new Attach(this, hub, null);
        comp = new Composer(this, attach, "Chat with Claude…");
        comp.onSend = this::start;
        comp.onPill = () -> {
            if (run == null) return;
            Sheet sh = new Sheet(this, "Run settings");
            run.rows(this, sh, (f, v) -> { sh.dismiss(); change(f, v); });
            sh.show();
        };
        comp.onPlus = () -> Composer.addSheet(this, attach, run, this::change);
        root.addView(comp.view, Ui.margins(Ui.fill(), 12, 0, 12, 12));
        installDrawer(null);

        st = Hub.states.get(hub.id);
        if (st != null) init();
        Ui.bg(this, hub::state, s -> { boolean first = st == null; st = s; if (first) init(); else { run = rebuilt(); show(); } });
        comp.edit.requestFocus();
    }

    @Override
    void refresh() { Ui.bg(this, hub::state, s -> { st = s; if (side != null) side.render(s); }); }

    @Override
    void onEvents(java.util.Set<String> changed, boolean stateChanged, boolean reconnect) {
        if ((stateChanged || reconnect) && side != null && drawerOpen()) refresh();
    }

    private SharedPreferences prefs() { return getSharedPreferences("newchat-" + hub.id, MODE_PRIVATE); }

    /** Last pick on this phone, else the desktop's current pick, else the first option. */
    private void init() {
        JSONObject d = st.optJSONObject("defaults");
        if (d == null) d = new JSONObject();
        SharedPreferences p = prefs();
        run = new Run(st, null);
        run.project = p.getString("project", d.isNull("project_id") ? "" : d.optString("project_id"));
        run.device = p.getString("device", d.optString("device"));
        run.account = p.getString("account", d.optString("account"));
        run.model = p.getString("model", d.optString("model"));
        run.effort = p.getString("effort", d.optString("effort"));
        run.access = p.getString("access", d.optString("access"));
        run.fast = st.optBoolean("fast");
        run.normalize();
        show();
    }

    /** The same picks over a fresh state. */
    private Run rebuilt() {
        Run r = new Run(st, null);
        if (run != null) {
            r.project = run.project; r.account = run.account; r.model = run.model;
            r.effort = run.effort; r.access = run.access; r.device = run.device; r.fast = run.fast;
        }
        r.normalize();
        return r;
    }

    private void show() {
        comp.pill.setText(run.pill());
        project.setText(run.projectLabel() + "  ▾");
        String k = run.kind();
        comp.edit.setHint("Chat with " + (k.isEmpty() ? "Claude" : Character.toUpperCase(k.charAt(0)) + k.substring(1)) + "…");
    }

    private void change(String field, Object v) {
        switch (field) {
            case "project": run.project = (String) v; break;
            case "account": {
                String old = run.kind();
                run.account = (String) v;
                if (!old.equals(run.kind())) { run.model = ""; run.effort = ""; run.access = ""; }
                break;
            }
            case "model": run.model = (String) v; break;
            case "effort": run.effort = (String) v; break;
            case "access": run.access = (String) v; break;
            case "device": run.device = (String) v; break;
            case "fast": run.fast = (Boolean) v; break;
        }
        run.normalize();
        show();
    }

    private void pickProject() {
        java.util.List<Sheet.Option> o = new java.util.ArrayList<>();
        o.add(new Sheet.Option("", "No project", "runs in your home folder on the PC", true));
        JSONArray p = st.optJSONArray("projects");
        if (p != null) for (int i = 0; i < p.length(); i++) {
            JSONObject j = p.optJSONObject(i);
            if (j != null) o.add(new Sheet.Option(j.optString("id"), j.optString("name"), j.optString("path"), true));
        }
        Sheet.pick(this, "Project", null, o, run.project, id -> change("project", id));
    }

    private void start() {
        if (starting || st == null || run == null) return;
        String text = comp.edit.getText().toString().trim();
        if (text.isEmpty() && !attach.any()) { Ui.toast(this, "Write the first message"); return; }
        if (attach.busy()) { Ui.toast(this, "Still uploading…"); return; }
        if (run.account.isEmpty()) { Ui.toast(this, "This PC has no account to run with"); return; }
        prefs().edit().putString("project", run.project).putString("device", run.device).putString("account", run.account)
                .putString("model", run.model).putString("effort", run.effort).putString("access", run.access).apply();
        starting = true;
        comp.busy(true);
        JSONObject body = new JSONObject();
        try {
            body.put("project_id", run.project.isEmpty() ? JSONObject.NULL : Hub.num(run.project)).put("device", run.device)
                    .put("account", run.account).put("model", run.model).put("effort", run.effort).put("access", run.access)
                    .put("fast", run.fast).put("text", text).put("files", attach.ids());
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
                comp.busy(false);
                if (isFinishing()) return;
                if (fe != null) { Ui.toast(this, fe); return; }
                Chat.open(this, hub, fid);
                finish();
            });
        });
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] granted) {
        super.onRequestPermissionsResult(req, perms, granted);
        attach.permission(req, granted);
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (!comp.result(req, res, data)) attach.result(req, res, data);
    }
}
