package dev.harbor.app;

import android.content.Intent;
import android.os.Bundle;
import android.text.Editable;
import android.text.TextWatcher;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** The desktop's "Add project" palette (addproject.ts) as a screen: New project (with or without
 *  Git), Local folder (the PC's folders, browsed), Git URL and GitHub repository. The PC serves
 *  the same rows the desktop shows (POST /v1/projects/rows) and runs the picked one (POST
 *  /v1/projects; a clone in the background, polled at /v1/projects/job). With several PCs in
 *  the mesh, the chip under the box picks which one gets the project. Once it's made, the
 *  project's main chat opens (its first message starts it), as on the desktop. */
public class NewProject extends Base {
    private static final long DEBOUNCE_MS = 150, POLL_MS = 1200;

    private EditText box;
    private LinearLayout list, statuses;
    private TextView crumb, back, pcChip, addHere;
    private String pc = "", pcName = "";  // "" = the PC this phone talks to
    private String step = "sources", dir = "";
    private String busy;                  // "Creating…", "Cloning…": taps wait
    private String error;                 // the last act's error, shown in red over the rows
    private int asked;                    // the latest question; older answers are dropped
    private JSONObject first;             // the first row, for the keyboard's Go
    private JSONObject st;

    private final Runnable typed = this::load;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        if (noHub()) return;
        LinearLayout root = frame("Add project", true);
        st = Hub.states.get(hub.id);

        // The step, with a way back to the sources (the desktop's label and back arrow).
        LinearLayout head = Ui.row(this);
        head.setGravity(Gravity.CENTER_VERTICAL);
        back = Ui.iconButton(this, Ui.I_LEFT, Ui.G700, v -> goBack());
        back.setTextSize(TypedValue.COMPLEX_UNIT_DIP, 18);
        back.setContentDescription("Back");
        head.addView(back, new LinearLayout.LayoutParams(Ui.dp(36), Ui.dp(36)));
        crumb = Ui.bold(this, "Sources", 14, Ui.G700);
        head.addView(crumb, Ui.weight());
        pcChip = Ui.text(this, "", 13.5f, Ui.G700);
        pcChip.setPadding(Ui.dp(12), Ui.dp(6), Ui.dp(12), Ui.dp(6));
        pcChip.setBackground(Ui.press(Ui.CARD, Ui.LINE, 14));
        pcChip.setOnClickListener(v -> pickPc());
        pcChip.setVisibility(View.GONE);
        head.addView(pcChip, Ui.wrap());
        root.addView(head, Ui.margins(Ui.fill(), 10, 0, 16, 4));

        box = Ui.input(this, "Search…", false);
        box.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        box.setPadding(Ui.dp(14), Ui.dp(11), Ui.dp(14), Ui.dp(11));
        box.setSingleLine(true);
        box.setImeOptions(EditorInfo.IME_ACTION_GO);
        box.setOnEditorActionListener((v, id, e) -> { if (first != null) pick(first); return true; });
        box.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int st, int c, int af) { }
            @Override public void onTextChanged(CharSequence s, int st, int bf, int c) { }
            @Override public void afterTextChanged(Editable e) { error = null; Ui.main.removeCallbacks(typed); Ui.main.postDelayed(typed, DEBOUNCE_MS); }
        });
        root.addView(box, Ui.margins(Ui.fill(), 16, 4, 16, 6));

        statuses = Ui.col(this);
        root.addView(statuses, Ui.margins(Ui.fill(), 20, 0, 20, 0));
        ScrollView sv = new ScrollView(this);
        list = Ui.col(this);
        list.setPadding(Ui.dp(8), 0, Ui.dp(8), Ui.dp(24));
        sv.addView(list);
        root.addView(sv, new LinearLayout.LayoutParams(-1, 0, 1));

        // Local folder: add the folder being browsed (the desktop's Add button, Ctrl+Enter).
        addHere = Ui.button(this, "Add this folder", true, v -> run(act("add", "dir", dir)));
        addHere.setVisibility(View.GONE);
        root.addView(addHere, Ui.margins(Ui.fill(), 16, 6, 16, 14));

        String start = getIntent().getStringExtra("step");
        if (start != null) step = start;
        showPc();
        box.requestFocus();
        load();
        if (st == null) Ui.bg(this, hub::state, s -> { st = s; showPc(); });
    }

    // ---- which PC ----

    /** The mesh's PCs as the paired one lists them (`hubs`), this one first. */
    private List<JSONObject> pcs() {
        List<JSONObject> out = new ArrayList<>();
        JSONArray h = st == null ? null : st.optJSONArray("hubs");
        if (h != null) for (int i = 0; i < h.length(); i++) {
            JSONObject o = h.optJSONObject(i);
            if (o != null && !o.optString("id").isEmpty()) out.add(o);
        }
        return out;
    }

    private void showPc() {
        List<JSONObject> all = pcs();
        if (pcName.isEmpty() && st != null) pcName = st.optString("hub_name", hub.label());
        pcChip.setText("On " + (pcName.isEmpty() ? hub.label() : pcName) + "  ▾");
        pcChip.setContentDescription("The PC that gets the project: " + pcName);
        pcChip.setVisibility(all.size() > 1 ? View.VISIBLE : View.GONE);
    }

    private void pickPc() {
        List<Sheet.Option> o = new ArrayList<>();
        String here = st == null ? "" : st.optString("hub_id");
        for (JSONObject h : pcs()) {
            String id = h.optString("id");
            boolean on = h.optBoolean("online", true);
            o.add(new Sheet.Option(id.equals(here) ? "" : id, h.optString("name", id), on ? (id.equals(here) ? "this phone talks to it" : "") : "off", on));
        }
        Sheet.pick(this, "Which PC", "The project's folder is made on this PC, and its chats run there.", o, pc, id -> {
            if (id.equals(pc)) return;
            pc = id;
            pcName = "";
            for (JSONObject h : pcs()) if (h.optString("id").equals(id.isEmpty() ? here : id)) pcName = h.optString("name");
            dir = "";
            error = null;
            showPc();
            load();
        });
    }

    // ---- the rows ----

    private JSONObject ask() throws Exception {
        JSONObject b = new JSONObject().put("step", step).put("query", box.getText().toString()).put("dir", dir);
        if (!pc.isEmpty()) b.put("pc", pc);
        return b;
    }

    private void load() {
        final int n = ++asked;
        Ui.pool.execute(() -> {
            JSONObject r = null;
            String err = null;
            try {
                r = hub.call("POST", "/v1/projects/rows", ask(), 40_000);
            } catch (Hub.ApiError e) {
                err = e.code == 404 && "no such call".equals(e.getMessage()) ? older() : Hub.why(e);
            } catch (Exception e) {
                err = Hub.why(e);
            }
            final JSONObject fr = r;
            final String fe = err;
            Ui.main.post(() -> {
                if (n != asked || isFinishing()) return;
                if (fe != null) { failed(fe); return; }
                draw(fr);
                // GitHub's list comes in the background on the PC: ask again until it's there.
                if (fr.optBoolean("loading")) Ui.main.postDelayed(() -> { if (n == asked && !isFinishing()) load(); }, POLL_MS);
            });
        });
    }

    private String older() {
        return "Adding projects from the phone needs a newer Harbor on " + (pcName.isEmpty() ? hub.label() : pcName) + ": update it there.";
    }

    private void failed(String why) {
        list.removeAllViews();
        first = null;
        statuses.removeAllViews();
        status(why, "error");
    }

    private void draw(JSONObject r) {
        step = r.optString("step", step);
        dir = r.optString("dir", dir);
        if (pcName.isEmpty()) { pcName = r.optString("pc_name"); showPc(); }
        crumb.setText(r.optString("label", "Sources"));
        back.setVisibility("sources".equals(step) ? View.INVISIBLE : View.VISIBLE);
        box.setHint(r.optString("hint", "Search…"));
        boolean local = "local".equals(step);
        addHere.setVisibility(local ? View.VISIBLE : View.GONE);
        if (local) addHere.setText("Add " + r.optString("dir_label", "this folder"));
        statuses.removeAllViews();
        if (busy != null) status(busy, "subtle");
        if (error != null) status(error, "error");
        JSONArray ss = r.optJSONArray("statuses");
        if (ss != null) for (int i = 0; i < ss.length(); i++) {
            JSONObject s = ss.optJSONObject(i);
            if (s != null) status(s.optString("text"), s.optString("tone"));
        }
        list.removeAllViews();
        first = null;
        JSONArray rows = r.optJSONArray("rows");
        if (rows != null) for (int i = 0; i < rows.length(); i++) {
            JSONObject it = rows.optJSONObject(i);
            if (it == null) continue;
            if (first == null) first = it;
            list.addView(row(it), Ui.fill());
        }
    }

    private void status(String text, String tone) {
        int color = "error".equals(tone) ? Ui.RED : "warn".equals(tone) ? Ui.AMBER : Ui.G700;
        TextView t = Ui.text(this, text, 13.5f, color);
        t.setPadding(0, Ui.dp(6), 0, Ui.dp(6));
        statuses.addView(t, Ui.fill());
    }

    /** One row: the desktop's icon (or GitHub's mark), the title, its dimmed detail. */
    private View row(JSONObject it) {
        LinearLayout r = Ui.row(this);
        r.setMinimumHeight(Ui.dp(52));
        r.setPadding(Ui.dp(12), Ui.dp(6), Ui.dp(12), Ui.dp(6));
        r.setBackground(Ui.press(0, 0, 16));
        String icon = it.optString("icon");
        android.graphics.Bitmap logo = "github".equals(icon) ? Ui.logo(this, "github.a8") : null;
        LinearLayout.LayoutParams ip = Ui.margins(new LinearLayout.LayoutParams(Ui.dp(22), Ui.dp(22)), 0, 0, 12, 0);
        if (logo != null) {
            ImageView iv = new ImageView(this);
            iv.setImageBitmap(logo);
            iv.setAlpha(0.8f);
            r.addView(iv, Ui.margins(new LinearLayout.LayoutParams(Ui.dp(18), Ui.dp(18)), 2, 0, 14, 0));
        } else {
            r.addView(Ui.icon(this, glyph(icon), 17, Ui.G700), ip);
        }
        LinearLayout t = Ui.col(this);
        t.addView(Ui.subtitle(Ui.bold(this, it.optString("title"), 15, Ui.FG)), Ui.fill());
        String d = it.optString("detail");
        if (!d.isEmpty()) t.addView(Ui.subtitle(Ui.text(this, d, 13.5f, Ui.G700)), Ui.fill());
        r.addView(t, Ui.weight());
        r.setOnClickListener(v -> pick(it));
        return r;
    }

    /** The palette's icons (projectsapi.ts ICON_NAMES). */
    private static String glyph(String name) {
        switch (name) {
            case "folder-git": return Ui.I_FOLDER_GIT;
            case "folder-plus": return Ui.I_FOLDER_PLUS;
            case "link": return Ui.I_LINK;
            case "up": return Ui.I_UP;
            case "github": return Ui.I_BRANCH;
            default: return Ui.I_FOLDER;
        }
    }

    // ---- acts ----

    private static JSONObject act(String kind, String k, String v) {
        try { return new JSONObject().put("kind", kind).put(k, v); } catch (Exception e) { return new JSONObject(); }
    }

    private void pick(JSONObject it) {
        JSONObject a = it.optJSONObject("act");
        if (a != null) run(a);
    }

    /** A step or a folder moves the list here; the rest runs on the PC. */
    private void run(JSONObject a) {
        if (busy != null) return;
        error = null;
        switch (a.optString("kind")) {
            case "step":
                step = a.optString("step", "sources");
                box.setText("");
                load();
                return;
            case "enter":
                dir = a.optString("dir");
                box.setText("");
                load();
                return;
            default:
                make(a);
        }
    }

    private void make(JSONObject a) {
        String kind = a.optString("kind");
        busy = "clone".equals(kind) ? "Cloning " + a.optString("url") + "…" : "add".equals(kind) ? "Adding…" : "Creating…";
        load();
        Ui.pool.execute(() -> {
            JSONObject r = null;
            String err = null;
            try {
                JSONObject b = new JSONObject().put("act", a);
                if (!pc.isEmpty()) b.put("pc", pc);
                r = hub.call("POST", "/v1/projects", b, 40_000);
                // A clone goes on in the background there: until it's done.
                while (r != null && !r.optString("job").isEmpty() && r.optString("path").isEmpty()) {
                    Thread.sleep(POLL_MS);
                    if (isFinishing()) return;
                    JSONObject q = new JSONObject().put("job", r.optString("job"));
                    if (!pc.isEmpty()) q.put("pc", pc);
                    // Asking is harmless: a lost connection is asked again (the clone goes on).
                    for (int tries = 0; ; tries++) {
                        try {
                            r = hub.call("POST", "/v1/projects/job", q, 40_000);
                            break;
                        } catch (Hub.ApiError e) {
                            throw e;
                        } catch (java.io.IOException e) {
                            if (tries >= 5) throw e;
                            Thread.sleep(POLL_MS);
                        }
                    }
                }
            } catch (Hub.ApiError e) {
                err = e.code == 404 && "no such call".equals(e.getMessage()) ? older() : Hub.why(e);
            } catch (Exception e) {
                err = Hub.why(e);
            }
            final JSONObject fr = r;
            final String fe = err;
            Ui.main.post(() -> {
                if (isFinishing()) return;
                busy = null;
                if (fe != null || fr == null) {
                    error = fe != null ? fe : "The PC didn't say what happened";
                    load();
                    return;
                }
                done(fr);
            });
        });
    }

    /** Made: on to the project's main chat (or its first message, which starts it). */
    private void done(JSONObject r) {
        busy = "Opening the project…";
        statuses.removeAllViews();
        status(busy, "subtle");
        String id = r.optString("id");
        String on = r.optString("pc_name");
        Ui.toast(this, (r.optBoolean("existing") ? r.optString("name") + " is already a project" : "Added " + r.optString("name")) + (on.isEmpty() ? "" : " on " + on));
        Chats.openProject(this, hub, id, pc);
    }

    /** Back: up a folder while browsing (the ".." row), else to the sources. */
    private void goBack() {
        if ("local".equals(step) && box.getText().length() == 0 && first != null && "..".equals(first.optString("title"))) {
            run(first.optJSONObject("act"));
            return;
        }
        step = "sources";
        dir = "";
        error = null;
        box.setText("");
        load();
    }

    @Override
    public void onBackPressed() {
        if (!"sources".equals(step) && busy == null) { goBack(); return; }
        super.onBackPressed();
    }

    /** Opens this screen (from the chat list, a project picker or the empty list). */
    static void open(android.app.Activity a, Hub hub) {
        a.startActivity(new Intent(a, NewProject.class).putExtra("hub", hub.id));
    }
}
