package dev.harbor.app;

import android.app.TimePickerDialog;
import android.content.Context;
import android.content.Intent;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.os.Bundle;
import android.provider.AlarmClock;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.List;

/** Hub's Routine tab (Schedule Fixer, moved into Hub): Today, History, Sleep, Goals and Coach, as on
 *  the PC. The data is the PC's (Hub's engine, ts/tabs/routine): this screen draws what
 *  GET /v1/routine/view computes and sends each change (POST /v1/routine/act …), so the phone and
 *  the PC show the same. The phone's own parts: the alarm (the Clock app) and GPS rides (RideService). */
public class Routine extends Base {
    static final String[] SECTIONS = {"today", "history", "sleep", "goals", "coach"};
    private static final String[] LABELS = {"Today", "History", "Sleep", "Goals", "Coach"};
    // Lucide: sun, calendar, moon, target, message-circle
    private static final String[] GLYPHS = {"", "", "", "", ""};
    static final String[] COLORS = {"#7c5cff", "#22c55e", "#f97316", "#06b6d4", "#ec4899", "#eab308", "#ef4444", "#3b82f6"};
    static final String[] ICON_KEYS = {"activity", "arm", "dumbbell", "droplet", "run", "bike", "flame", "heart", "leaf", "book", "timer", "zap"};
    static final String[] ICON_GLYPHS = {"", "", "", "", "", "", "", "", "", "", "", ""};
    private static final String[] DAYS = {"Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"};
    private static final int[] WEEK = {1, 2, 3, 4, 5, 6, 0};

    private LinearLayout sections, body;
    private ScrollView scroll;
    private String section = "today", hsel = "all", confirmReset = "", confirmDel = "", lastAlarm = "", note = "";
    private JSONObject view, coach;
    private boolean loading, polling;
    private final List<Runnable> clocks = new ArrayList<>();
    private final Runnable tick = new Runnable() {
        @Override public void run() {
            for (Runnable r : clocks) r.run();
            if (!clocks.isEmpty() && front) Ui.main.postDelayed(this, 1000);
        }
    };

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        section = Ui.prefs(this).getString("routine_section", "today");
        hub = Tabs.hub(this);
        // The shared frame: the top bar (the side-panel button, the page's name), the page, the tab bar; the
        // pages (Today, History, Sleep, Goals, Coach) are the drawer's rows.
        LinearLayout col = frame("Routine", menuButton(), false);
        scroll = new ScrollView(this);
        body = Ui.col(this);
        body.setPadding(Ui.dp(16), Ui.dp(12), Ui.dp(16), Ui.dp(24));
        scroll.addView(body);
        col.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        sections = Ui.col(this);
        sections.setPadding(0, Ui.dp(4), 0, Ui.dp(12));
        ScrollView ds = new ScrollView(this);
        ds.addView(sections);
        installTab(Tabs.ROUTINE, Ds.drawer(this, "Routine", ds));
        drawSections();
    }

    @Override
    protected void onResume() {
        super.onResume();
        hub = Tabs.hub(this);
        load();
    }

    @Override
    void refresh() { load(); }

    // ---------- the PC ----------

    private String q(String s) {
        try { return URLEncoder.encode(s, "UTF-8"); } catch (Exception e) { return s; }
    }

    private void load() {
        if (hub == null) { draw(); return; }
        RideService.send(this);
        if (loading) return;
        loading = true;
        final Hub h = hub;
        Ui.pool.execute(() -> {
            try {
                JSONObject v = h.get("/v1/routine/view?sel=" + q(hsel));
                JSONObject c = "coach".equals(section) ? h.get("/v1/routine/coach") : coach;
                Ui.main.post(() -> { loading = false; view = v; coach = c; note = ""; draw(); pollCoach(); });
            } catch (Exception e) {
                Ui.main.post(() -> { loading = false; note = h.whyDown(e); draw(); });
            }
        });
    }

    /** A change on the PC, then the screen again. */
    private void act(JSONObject body) {
        if (hub == null) return;
        final Hub h = hub;
        Ui.pool.execute(() -> {
            try {
                h.call("POST", "/v1/routine/act", body);
                Ui.main.post(this::load);
            } catch (Exception e) {
                Ui.main.post(() -> Ui.toast(this, h.whyDown(e)));
            }
        });
    }

    private void act(String act, Object... kv) {
        try {
            JSONObject o = new JSONObject().put("act", act);
            for (int i = 0; i + 1 < kv.length; i += 2) o.put((String) kv[i], kv[i + 1]);
            act(o);
        } catch (Exception ignored) { }
    }

    private void pollCoach() {
        if (!"coach".equals(section) || coach == null || !coach.optBoolean("running") || polling) return;
        polling = true;
        Ui.main.postDelayed(() -> { polling = false; if (front && "coach".equals(section)) load(); }, 1500);
    }

    // ---------- drawing ----------

    private void drawSections() {
        sections.removeAllViews();
        for (int i = 0; i < SECTIONS.length; i++) {
            final String s = SECTIONS[i];
            boolean on = s.equals(section);
            if (on) barTitle.setText(LABELS[i]);
            sections.addView(Ds.navRow(this, GLYPHS[i], LABELS[i], null, on, v -> {
                closeDrawer();
                if (s.equals(section)) return;
                section = s;
                Ui.prefs(this).edit().putString("routine_section", s).apply();
                confirmReset = "";
                confirmDel = "";
                drawSections();
                draw();
                scroll.scrollTo(0, 0);
                if ("coach".equals(s)) load();
            }), Ui.fill());
        }
    }

    private void draw() {
        body.removeAllViews();
        clocks.clear();
        Ui.main.removeCallbacks(tick);
        if (hub == null) {
            message("Pair this phone with your PC first (Projects): Routine's data is on the PC.");
            return;
        }
        if (view == null) {
            message(note.isEmpty() ? "Loading…" : note);
            return;
        }
        boolean picking = view.optBoolean("picking");
        if (picking) barTitle.setText("Choose a plan");
        else drawSections();
        if (!note.isEmpty()) body.addView(Ui.text(this, note, 13, Ui.RED), Ui.fill());
        if (picking) drawPicker();
        else if ("history".equals(section)) drawHistory();
        else if ("sleep".equals(section)) drawSleep();
        else if ("goals".equals(section)) drawGoals();
        else if ("coach".equals(section)) drawCoach();
        else drawToday();
        if (!clocks.isEmpty()) Ui.main.postDelayed(tick, 1000);
    }

    private void message(String s) {
        body.addView(Ds.empty(this, s), Ui.fill());
    }

    private static int color(String hex) {
        try { return Color.parseColor(hex); } catch (Exception e) { return 0xfff97316; }
    }

    private void addCard(View v) {
        LinearLayout.LayoutParams lp = Ui.fill();
        lp.bottomMargin = Ui.dp(10);
        body.addView(v, lp);
    }

    private void addTo(LinearLayout row, View v) {
        LinearLayout.LayoutParams lp = Ui.wrap();
        lp.rightMargin = Ui.dp(6);
        row.addView(v, lp);
    }

    /** A progress ring around a goal's glyph. */
    static final class Ring extends View {
        float frac;
        int tint;
        float stroke;
        private final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF r = new RectF();

        Ring(Context c, float frac, int tint, float strokeDp) {
            super(c);
            this.frac = frac;
            this.tint = tint;
            this.stroke = Ui.dp(strokeDp);
            p.setStyle(Paint.Style.STROKE);
            p.setStrokeCap(Paint.Cap.ROUND);
        }

        @Override
        protected void onDraw(Canvas c) {
            float s = stroke / 2 + 1;
            r.set(s, s, getWidth() - s, getHeight() - s);
            p.setStrokeWidth(stroke);
            p.setColor(Ui.G300);
            c.drawArc(r, 0, 360, false, p);
            p.setColor(tint);
            float f = Math.max(0, Math.min(1, frac));
            if (f > 0) c.drawArc(r, -90, f * 360, false, p);
        }
    }

    private View ring(float frac, int tint, String glyph, int size) {
        FrameLayout f = new FrameLayout(this);
        f.addView(new Ring(this, frac, tint, size > 50 ? 6 : 4.5f), new FrameLayout.LayoutParams(-1, -1));
        if (glyph != null) f.addView(Ui.icon(this, glyph, size * 0.42f, tint), new FrameLayout.LayoutParams(-1, -1, Gravity.CENTER));
        f.setLayoutParams(new LinearLayout.LayoutParams(Ui.dp(size), Ui.dp(size)));
        return f;
    }

    private static String secs(double s) {
        long n = Math.max(0, (long) Math.floor(s));
        return (n / 60) + ":" + String.format(java.util.Locale.ROOT, "%02d", n % 60);
    }

    // ---- Today ----

    private void drawToday() {
        JSONObject t = view.optJSONObject("today");
        if (t == null) return;
        LinearLayout hero = Ui.row(this);
        LinearLayout left = Ui.col(this);
        if (!t.optString("walk").isEmpty()) {
            LinearLayout w = Ui.row(this);
            w.addView(Ui.icon(this, "", 15, Ui.G700));
            TextView wt = Ui.text(this, "  " + t.optString("walk"), 14, Ui.G700);
            w.addView(wt);
            left.addView(w);
        }
        hero.addView(left, Ui.weight());
        FrameLayout pr = (FrameLayout) ring((float) t.optDouble("pct"), Ui.GREEN, null, 58);
        TextView pct = Ui.bold(this, Math.round(t.optDouble("pct") * 100) + "%", 14, Ui.FG);
        pct.setGravity(Gravity.CENTER);
        pr.addView(pct, new FrameLayout.LayoutParams(-1, -1));
        hero.addView(pr);
        LinearLayout.LayoutParams hl = Ui.fill();
        hl.bottomMargin = Ui.dp(10);
        body.addView(hero, hl);
        String empty = t.optString("empty");
        if ("first".equals(empty)) {
            LinearLayout c = Ds.card(this);
            c.setGravity(Gravity.CENTER);
            c.addView(Ui.text(this, "Add your first daily goal to get started.", 15, Ui.G700));
            c.addView(Ui.button(this, "Add a goal", true, v -> { section = "goals"; drawSections(); goalForm(null); }));
            addCard(c);
        } else if ("rest".equals(empty)) {
            LinearLayout c = Ds.card(this);
            c.addView(Ui.text(this, "Rest day — nothing scheduled today.", 15, Ui.G700));
            addCard(c);
        }
        JSONArray gs = t.optJSONArray("goals");
        for (int i = 0; gs != null && i < gs.length(); i++) addCard(todayCard(gs.optJSONObject(i), t.optBoolean("dense")));
    }

    private View todayCard(JSONObject g, boolean dense) {
        final String id = g.optString("id");
        int tint = color(g.optString("hex"));
        boolean done = g.optBoolean("done");
        LinearLayout c = Ds.card(this);
        LinearLayout top = Ui.row(this);
        top.addView(ring((float) g.optDouble("frac"), tint, done ? Ui.I_CHECK : g.optString("glyph"), dense ? 38 : 46));
        LinearLayout info = Ui.col(this);
        info.setPadding(Ui.dp(12), 0, Ui.dp(6), 0);
        LinearLayout name = Ui.row(this);
        name.addView(Ui.bold(this, g.optString("name"), 16, Ui.FG));
        if (g.optBoolean("bonus")) name.addView(Ui.text(this, "  Bonus", 12, Ui.AMBER));
        if (done) name.addView(Ui.text(this, "  Done", 12, Ui.GREEN));
        info.addView(name);
        LinearLayout val = Ui.row(this);
        val.addView(Ui.bold(this, g.optString("value"), 16, Ui.FG));
        val.addView(Ui.text(this, " " + g.optString("rest"), 14, Ui.G700));
        info.addView(val);
        if (!dense) {
            FrameLayout bar = new FrameLayout(this);
            bar.setBackground(Ui.round(Ui.G200, 0, 2));
            View fill = new View(this);
            fill.setBackground(Ui.round(tint, 0, 2));
            bar.addView(fill, new FrameLayout.LayoutParams(0, -1));
            final double frac = Math.min(1, g.optDouble("frac"));
            bar.post(() -> { ViewGroup.LayoutParams lp = fill.getLayoutParams(); lp.width = (int) (bar.getWidth() * frac); fill.setLayoutParams(lp); });
            LinearLayout.LayoutParams bl = new LinearLayout.LayoutParams(-1, Ui.dp(4));
            bl.topMargin = Ui.dp(4);
            info.addView(bar, bl);
        }
        top.addView(info, Ui.weight());
        if (g.optInt("streak") > 0) {
            top.addView(Ui.icon(this, "", 13, Ui.AMBER));
            top.addView(Ui.bold(this, " " + g.optInt("streak"), 13, Ui.AMBER));
        }
        c.addView(top);
        LinearLayout row = Ui.row(this);
        row.setPadding(0, Ui.dp(10), 0, 0);
        String kind = g.optString("kind"), session = g.optString("session");
        if (!"count".equals(kind)) {
            final TextView clock = Ui.bold(this, secs(g.optDouble("secs")), 18, "running".equals(session) ? tint : Ui.FG);
            clock.setTypeface(android.graphics.Typeface.MONOSPACE, android.graphics.Typeface.BOLD);
            addTo(row, clock);
            final long base = g.optLong("base");
            if ("running".equals(session) && base > 0) clocks.add(() -> clock.setText(secs((System.currentTimeMillis() - base) / 1000.0)));
            boolean ride = "ride".equals(kind);
            if (ride) {
                RideService.State live = RideService.state(this);
                if (live != null && id.equals(live.goal)) {
                    session = live.paused ? "paused" : "running";
                    final RideService.State l = live;
                    clock.setText(secs(l.movingMs() / 1000.0));
                    clocks.add(() -> clock.setText(secs(l.movingMs() / 1000.0)));
                }
                TextView sub = Ui.text(this, live != null && id.equals(live.goal) ? String.format(java.util.Locale.ROOT, "%.2f km", live.distM / 1000) : g.optString("sub"), 12, Ui.G700);
                addTo(row, sub);
            }
            if ("idle".equals(session)) addTo(row, Ds.chip(this, "▶ Start", false, v -> { if (ride) startRide(id); else act("timer", "goal", id, "cmd", "start"); }));
            else if ("running".equals(session)) addTo(row, Ds.chip(this, "❚❚ Pause", true, v -> { if (ride) RideService.pause(this); else act("timer", "goal", id, "cmd", "pause"); draw(); }));
            else addTo(row, Ds.chip(this, "▶ Resume", false, v -> { if (ride) RideService.resume(this); else act("timer", "goal", id, "cmd", "resume"); draw(); }));
            if (!"idle".equals(session)) addTo(row, Ds.chip(this, "■", false, v -> { if (ride) RideService.stop(this); else act("timer", "goal", id, "cmd", "stop"); }));
        }
        JSONArray quick = g.optJSONArray("quick");
        for (int i = 0; quick != null && i < quick.length(); i++) {
            final JSONObject qk = quick.optJSONObject(i);
            addTo(row, Ds.chip(this, qk.optString("label"), false, v -> act("log", "goal", id, "amount", qk.optInt("amount"))));
        }
        View gap = new View(this);
        row.addView(gap, Ui.weight());
        if ("idle".equals(session)) {
            TextView undo = Ui.iconButton(this, "", g.optBoolean("canUndo") ? Ui.G700 : Ui.G300, v -> act("undo", "goal", id));
            undo.setEnabled(g.optBoolean("canUndo"));
            row.addView(undo);
        }
        if (id.equals(confirmReset)) row.addView(Ds.chip(this, "Reset?", false, v -> { confirmReset = ""; act("reset", "goal", id); }));
        else {
            TextView reset = Ui.iconButton(this, "", g.optBoolean("canReset") ? Ui.G700 : Ui.G300, v -> { confirmReset = id; draw(); });
            reset.setEnabled(g.optBoolean("canReset"));
            row.addView(reset);
        }
        c.addView(row);
        return c;
    }

    private void startRide(String goal) {
        if (RideService.state(this) != null) { Ui.toast(this, "A ride is being recorded already"); return; }
        if (checkSelfPermission("android.permission.ACCESS_FINE_LOCATION") != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            pendingRide = goal;
            requestPermissions(new String[] {"android.permission.ACCESS_FINE_LOCATION"}, 77);
            return;
        }
        RideService.start(this, hub, goal);
        draw();
    }

    private String pendingRide;

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] res) {
        super.onRequestPermissionsResult(code, perms, res);
        if (code == 77 && pendingRide != null && res.length > 0 && res[0] == android.content.pm.PackageManager.PERMISSION_GRANTED) {
            RideService.start(this, hub, pendingRide);
            draw();
        } else if (code == 77) Ui.toast(this, "Rides need the location permission");
        pendingRide = null;
    }

    // ---- History ----

    private void drawHistory() {
        JSONObject h = view.optJSONObject("history");
        if (h == null) return;
        HorizontalScrollView hs = new HorizontalScrollView(this);
        hs.setHorizontalScrollBarEnabled(false);
        LinearLayout segs = Ui.row(this);
        JSONArray sa = h.optJSONArray("segs");
        for (int i = 0; sa != null && i < sa.length(); i++) {
            final JSONObject s = sa.optJSONObject(i);
            addTo(segs, Ds.chip(this, s.optString("label"), s.optString("id").equals(h.optString("sel")), v -> { hsel = s.optString("id"); load(); }));
        }
        hs.addView(segs);
        LinearLayout.LayoutParams sl = Ui.fill();
        sl.bottomMargin = Ui.dp(10);
        body.addView(hs, sl);
        if (h.optBoolean("walkView")) {
            LinearLayout c = Ds.card(this);
            LinearLayout tot = Ui.row(this);
            JSONArray wt = h.optJSONArray("walkTotals");
            String[] under = {"this week", "today", "a day"};
            for (int i = 0; wt != null && i < wt.length(); i++) {
                LinearLayout cell = Ui.col(this);
                cell.addView(Ui.bold(this, wt.optString(i), 16, Ui.FG));
                cell.addView(Ui.text(this, under[i], 12, Ui.G700));
                tot.addView(cell, Ui.weight());
            }
            c.addView(tot);
            LinearLayout bars = Ui.row(this);
            bars.setGravity(Gravity.BOTTOM);
            JSONArray wb = h.optJSONArray("walkBars");
            for (int i = 0; wb != null && i < wb.length(); i++) {
                JSONObject b = wb.optJSONObject(i);
                View bar = new View(this);
                bar.setBackgroundColor(b.optBoolean("today") ? Ui.GREEN : b.optBoolean("approx") ? Ui.G500 : 0xff1a9338);
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, Math.max(1, (int) (Ui.dp(120) * b.optDouble("frac"))), 1);
                lp.rightMargin = 1;
                bars.addView(bar, lp);
            }
            LinearLayout.LayoutParams bl = new LinearLayout.LayoutParams(-1, Ui.dp(124));
            bl.topMargin = Ui.dp(10);
            c.addView(bars, bl);
            LinearLayout axis = Ui.row(this);
            TextView from = Ui.text(this, h.optString("walkFrom"), 12, Ui.G700);
            TextView to = Ui.text(this, h.optString("walkTo"), 12, Ui.G700);
            to.setGravity(Gravity.END);
            axis.addView(from, Ui.weight());
            axis.addView(to, Ui.weight());
            c.addView(axis);
            addCard(c);
            return;
        }
        JSONArray st = h.optJSONArray("streaks");
        for (int i = 0; st != null && i < st.length(); i++) {
            JSONObject s = st.optJSONObject(i);
            LinearLayout c = Ds.card(this);
            LinearLayout r = Ui.row(this);
            r.addView(Ui.icon(this, s.optString("glyph"), 18, color(s.optString("hex"))));
            LinearLayout info = Ui.col(this);
            info.setPadding(Ui.dp(12), 0, 0, 0);
            info.addView(Ui.bold(this, s.optString("name"), 15, Ui.FG));
            info.addView(Ui.text(this, s.optString("line"), 12, Ui.G700));
            r.addView(info, Ui.weight());
            LinearLayout n = Ui.col(this);
            n.setGravity(Gravity.END);
            n.addView(Ui.bold(this, String.valueOf(s.optInt("streak")), 18, Ui.FG));
            n.addView(Ui.text(this, "streak", 11, Ui.G700));
            r.addView(n);
            c.addView(r);
            addCard(c);
        }
        // The heatmap: 8 weeks as columns, Mon..Sun as rows
        LinearLayout c = Ds.card(this);
        int heat = h.optString("heatHex").isEmpty() ? Ui.GREEN : color(h.optString("heatHex"));
        LinearLayout grid = Ui.row(this);
        LinearLayout labels = Ui.col(this);
        String[] dl = {"M", "", "W", "", "F", "", "S"};
        for (String d : dl) {
            TextView t = Ui.text(this, d, 10, Ui.G700);
            t.setGravity(Gravity.CENTER_VERTICAL);
            labels.addView(t, new LinearLayout.LayoutParams(Ui.dp(16), Ui.dp(26)));
        }
        grid.addView(labels);
        JSONArray cells = h.optJSONArray("cells");
        for (int w = 0; w < 8; w++) {
            LinearLayout colv = Ui.col(this);
            for (int d = 0; d < 7; d++) {
                JSONObject cell = cells == null ? null : cells.optJSONObject(w * 7 + d);
                int lv = cell == null ? 6 : cell.optInt("level");
                View v = new View(this);
                int fill = lv == 6 ? 0 : lv == 5 ? Ui.G100 : lv == 0 ? Ui.G200 : (heat & 0x00ffffff) | ((int) (255 * (lv == 1 ? 0.3 : lv == 2 ? 0.55 : lv == 3 ? 0.78 : 1.0)) << 24);
                v.setBackground(Ui.round(fill, cell != null && cell.optBoolean("today") ? Ui.FG : 0, 5));
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, Ui.dp(22));
                lp.bottomMargin = Ui.dp(4);
                colv.addView(v, lp);
            }
            LinearLayout.LayoutParams cl = new LinearLayout.LayoutParams(0, -2, 1);
            cl.rightMargin = Ui.dp(4);
            grid.addView(colv, cl);
        }
        c.addView(grid);
        c.addView(Ui.text(this, h.optString("fullDays"), 12, Ui.G700));
        addCard(c);
        if (!h.optString("ridesTotal").isEmpty()) {
            LinearLayout rc = Ds.card(this);
            rc.addView(Ui.bold(this, h.optString("ridesWeek") + " km this week · " + h.optString("ridesTotal") + " km total", 14, Ui.FG));
            JSONArray rides = h.optJSONArray("rides");
            for (int i = 0; rides != null && i < rides.length(); i++) {
                JSONObject r = rides.optJSONObject(i);
                rc.addView(Ui.text(this, r.optString("day") + "   " + r.optString("km") + " km   " + r.optString("time") + "   ↑" + r.optString("gain") + " m", 13, Ui.FG));
            }
            addCard(rc);
        }
    }

    // ---- Sleep ----

    private void drawSleep() {
        TextView now = Ui.button(this, "Going to sleep now", true, v -> wakeChoices());
        LinearLayout.LayoutParams nl = Ui.fill();
        nl.bottomMargin = Ui.dp(12);
        body.addView(now, nl);
        if (!lastAlarm.isEmpty()) {
            LinearLayout c = Ds.card(this);
            LinearLayout r = Ui.row(this);
            r.addView(Ui.icon(this, Ui.I_ALARM, 20, Ui.FG));
            TextView t = Ui.bold(this, "  " + lastAlarm, 16, Ui.FG);
            r.addView(t, Ui.weight());
            r.addView(Ds.chip(this, "Open Clock", false, v -> {
                try { startActivity(new Intent(AlarmClock.ACTION_SHOW_ALARMS)); } catch (Exception e) { Ui.toast(this, "No Clock app"); }
            }));
            c.addView(r);
            addCard(c);
        }
        LinearLayout c = Ds.card(this);
        LinearLayout r = Ui.row(this);
        r.addView(Ui.bold(this, "Wake up by", 16, Ui.FG), Ui.weight());
        final String wakeBy = view.optString("wakeBy", "07:00");
        r.addView(Ds.chip(this, wakeBy, false, v -> {
            String[] hm = wakeBy.split(":");
            new TimePickerDialog(this, (tp, hh, mm) -> act("sleep", "wakeBy", String.format(java.util.Locale.ROOT, "%02d:%02d", hh, mm)),
                    Integer.parseInt(hm[0]), Integer.parseInt(hm[1]), true).show();
        }));
        c.addView(r);
        addCard(c);
    }

    private void wakeChoices() {
        // The options are the PC's (wakeView), for now: ask again so "now" is now.
        final Hub h = hub;
        Ui.pool.execute(() -> {
            try {
                JSONObject v = h.get("/v1/routine/view?sel=all");
                JSONArray w = v.optJSONArray("wakes");
                Ui.main.post(() -> showWakes(w));
            } catch (Exception e) {
                Ui.main.post(() -> Ui.toast(this, h.whyDown(e)));
            }
        });
    }

    private void showWakes(JSONArray w) {
        if (w == null) return;
        String[] items = new String[w.length()];
        for (int i = 0; i < w.length(); i++) {
            JSONObject o = w.optJSONObject(i);
            items[i] = o.optString("time") + "   " + o.optString("meta") + (o.optBoolean("rec") ? "   · Recommended" : "");
        }
        Ui.dialog(this).setTitle("Wake me up at…").setItems(items, (d, i) -> {
            JSONObject o = w.optJSONObject(i);
            Intent a = new Intent(AlarmClock.ACTION_SET_ALARM)
                    .putExtra(AlarmClock.EXTRA_HOUR, o.optInt("hour"))
                    .putExtra(AlarmClock.EXTRA_MINUTES, o.optInt("minute"))
                    .putExtra(AlarmClock.EXTRA_MESSAGE, "Routine · " + o.optInt("cycles") + " cycles")
                    .putExtra(AlarmClock.EXTRA_SKIP_UI, true)
                    .putExtra(AlarmClock.EXTRA_VIBRATE, true);
            try {
                startActivity(a);
                lastAlarm = o.optString("time") + " · " + o.optInt("cycles") + " cycles";
                Ui.toast(this, "Alarm set for " + o.optString("time") + " (" + o.optInt("cycles") + " cycles). Good night!");
            } catch (Exception e) {
                Ui.toast(this, "Could not create the alarm: " + e.getMessage());
            }
            draw();
        }).show();
    }

    // ---- Goals ----

    private void drawGoals() {
        JSONObject g = view.optJSONObject("goals");
        if (g == null) return;
        LinearLayout head = Ui.row(this);
        head.addView(new View(this), Ui.spacer());
        head.addView(Ds.chip(this, "+ New", true, v -> goalForm(null)));
        body.addView(head, Ui.fill());
        LinearLayout plan = Ds.card(this);
        LinearLayout pr = Ui.row(this);
        pr.addView(Ui.text(this, "Plan  ", 14, Ui.G700));
        pr.addView(Ui.bold(this, g.optString("planLabel"), 15, Ui.FG), Ui.weight());
        pr.addView(Ui.icon(this, Ui.I_DOWN, 16, Ui.G700));
        plan.addView(pr);
        plan.setOnClickListener(v -> plans(g.optJSONArray("plans")));
        addCard(plan);
        JSONArray rows = g.optJSONArray("rows");
        for (int i = 0; rows != null && i < rows.length(); i++) {
            final JSONObject r = rows.optJSONObject(i);
            final String id = r.optString("id");
            LinearLayout c = Ds.card(this);
            LinearLayout row = Ui.row(this);
            row.addView(Ui.icon(this, r.optString("glyph"), 18, color(r.optString("hex"))));
            LinearLayout info = Ui.col(this);
            info.setPadding(Ui.dp(12), 0, 0, 0);
            info.addView(Ui.bold(this, r.optString("name"), 15, Ui.FG));
            info.addView(Ui.text(this, r.optString("line"), 12, Ui.G700));
            row.addView(info, Ui.weight());
            row.addView(Ui.iconButton(this, "", Ui.G700, v -> goalForm(id)));
            if (id.equals(confirmDel)) row.addView(Ds.chip(this, "Delete?", false, v -> { confirmDel = ""; act("delete_goal", "id", id); }));
            else row.addView(Ui.iconButton(this, Ui.I_TRASH, Ui.G700, v -> { confirmDel = id; draw(); }));
            c.addView(row);
            addCard(c);
        }
        if (rows == null || rows.length() == 0) body.addView(Ui.text(this, "No goals. Tap “New” to add one.", 14, Ui.G700));
        TextView imp = Ui.text(this, "Import from Schedule Fixer", 14, Ui.G700);
        imp.setGravity(Gravity.CENTER);
        imp.setPadding(0, Ui.dp(14), 0, Ui.dp(14));
        imp.setOnClickListener(v -> importDialog());
        body.addView(imp, Ui.fill());
    }

    private void plans(JSONArray plans) {
        if (plans == null) return;
        String[] items = new String[plans.length()];
        for (int i = 0; i < plans.length(); i++) {
            JSONObject p = plans.optJSONObject(i);
            items[i] = p.optString("name") + (p.optBoolean("on") ? "  ✓" : "") + "\n" + p.optString("meta");
        }
        Ui.dialog(this).setTitle("Plan").setItems(items, (d, i) -> act("plan", "id", plans.optJSONObject(i).optString("id"))).show();
    }

    private void drawPicker() {
        JSONObject g = view.optJSONObject("goals");
        JSONArray plans = g == null ? null : g.optJSONArray("plans");
        for (int i = 0; plans != null && i < plans.length(); i++) {
            final JSONObject p = plans.optJSONObject(i);
            LinearLayout c = Ds.card(this);
            c.addView(Ui.bold(this, p.optString("name"), 16, Ui.FG));
            c.addView(Ui.text(this, p.optString("meta"), 13, Ui.G700));
            c.setBackground(Ui.press(Ui.CARD, Ui.LINE, 16));
            c.setOnClickListener(v -> act("plan", "id", p.optString("id")));
            addCard(c);
        }
        body.addView(Ui.button(this, "Import from Schedule Fixer", false, v -> importDialog()), Ui.fill());
    }

    /** New (id null) or edit: name, type, daily target, unit, days (a tap cycles on, bonus, off), icon, color. */
    private void goalForm(String id) {
        JSONObject goal = null;
        JSONArray icons = view == null ? null : view.optJSONArray("goalIcons");
        for (int i = 0; id != null && icons != null && i < icons.length(); i++) if (id.equals(icons.optJSONObject(i).optString("id"))) goal = icons.optJSONObject(i);
        final String unit0 = goal == null ? "reps" : goal.optString("unit");
        final int[] type = {goal == null ? 0 : "ride".equals(goal.optString("kind")) ? 3 : "sec".equalsIgnoreCase(unit0) ? 2 : "ml".equalsIgnoreCase(unit0) ? 1 : 0};
        final int[] icon = {0};
        final int[] col = {2};
        final int[] state = new int[7];
        if (goal != null) {
            for (int i = 0; i < ICON_KEYS.length; i++) if (ICON_KEYS[i].equals(goal.optString("icon"))) icon[0] = i;
            for (int i = 0; i < COLORS.length; i++) if (COLORS[i].equalsIgnoreCase(goal.optString("color"))) col[0] = i;
            JSONArray days = goal.optJSONArray("days"), bonus = goal.optJSONArray("bonusDays");
            for (int k = 0; k < 7; k++) {
                state[k] = days == null || days.length() == 0 ? 1 : 0;
                for (int j = 0; days != null && j < days.length(); j++) if (days.optInt(j) == WEEK[k]) state[k] = 1;
                for (int j = 0; bonus != null && j < bonus.length(); j++) if (bonus.optInt(j) == WEEK[k]) state[k] = 2;
            }
        } else for (int k = 0; k < 7; k++) state[k] = 1;
        LinearLayout f = Ui.col(this);
        f.setPadding(Ui.dp(20), Ui.dp(8), Ui.dp(20), 0);
        final EditText name = Ui.input(this, "e.g. Squats", false);
        if (goal != null) name.setText(goal.optString("name"));
        f.addView(Ui.label(this, "Name"));
        f.addView(name, Ui.fill());
        final LinearLayout types = Ui.row(this);
        final EditText target = Ui.input(this, "Daily target", false);
        target.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_DECIMAL);
        double t0 = goal == null ? 20 : goal.optDouble("target");
        target.setText(goal != null && type[0] >= 2 ? trim(t0 / 60) : trim(t0));
        final EditText unit = Ui.input(this, "reps, km, pages", false);
        unit.setText(type[0] == 0 ? unit0 : "reps");
        final TextView targetLabel = Ui.label(this, "Daily target");
        final Runnable[] drawTypes = new Runnable[1];
        drawTypes[0] = () -> {
            types.removeAllViews();
            String[] tl = {"Count", "Water", "Timer", "GPS ride"};
            for (int i = 0; i < tl.length; i++) {
                final int k = i;
                addTo(types, Ds.chip(this, tl[i], type[0] == i, v -> { type[0] = k; drawTypes[0].run(); }));
            }
            targetLabel.setText(type[0] >= 2 ? "Daily target (min)" : type[0] == 1 ? "Daily target (ml)" : "Daily target");
            unit.setVisibility(type[0] == 0 ? View.VISIBLE : View.GONE);
        };
        drawTypes[0].run();
        HorizontalScrollView ts = new HorizontalScrollView(this);
        ts.addView(types);
        f.addView(ts, Ui.fill());
        f.addView(targetLabel);
        f.addView(target, Ui.fill());
        f.addView(unit, Ui.fill());
        f.addView(Ui.label(this, "Days (tap: on, bonus, off)"));
        final LinearLayout days = Ui.row(this);
        final Runnable[] drawDays = new Runnable[1];
        drawDays[0] = () -> {
            days.removeAllViews();
            int tint = color(COLORS[col[0]]);
            for (int k = 0; k < 7; k++) {
                final int kk = k;
                TextView d = Ui.bold(this, DAYS[k].substring(0, 2), 12, state[k] == 1 ? Color.WHITE : Ui.FG);
                d.setGravity(Gravity.CENTER);
                d.setBackground(Ui.round(state[k] == 1 ? tint : state[k] == 2 ? (tint & 0x00ffffff) | 0x33000000 : Ui.G200, state[k] == 2 ? tint : 0, 8));
                d.setOnClickListener(v -> { state[kk] = (state[kk] + 1) % 3; drawDays[0].run(); });
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, Ui.dp(36), 1);
                lp.rightMargin = Ui.dp(3);
                days.addView(d, lp);
            }
        };
        drawDays[0].run();
        f.addView(days, Ui.fill());
        f.addView(Ui.label(this, "Icon"));
        final LinearLayout iconRow = Ui.row(this);
        final LinearLayout colorRow = Ui.row(this);
        final Runnable[] drawPick = new Runnable[1];
        drawPick[0] = () -> {
            iconRow.removeAllViews();
            colorRow.removeAllViews();
            int tint = color(COLORS[col[0]]);
            for (int i = 0; i < ICON_GLYPHS.length; i++) {
                final int k = i;
                TextView ic = Ui.icon(this, ICON_GLYPHS[i], 18, icon[0] == i ? tint : Ui.G700);
                ic.setBackground(Ui.round(icon[0] == i ? (tint & 0x00ffffff) | 0x33000000 : 0, 0, 8));
                ic.setOnClickListener(v -> { icon[0] = k; drawPick[0].run(); });
                iconRow.addView(ic, new LinearLayout.LayoutParams(Ui.dp(36), Ui.dp(36)));
            }
            for (int i = 0; i < COLORS.length; i++) {
                final int k = i;
                View dot = new View(this);
                dot.setBackground(Ui.round(color(COLORS[i]), col[0] == i ? Ui.FG : 0, 14));
                dot.setOnClickListener(v -> { col[0] = k; drawPick[0].run(); drawDays[0].run(); });
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(Ui.dp(28), Ui.dp(28));
                lp.rightMargin = Ui.dp(8);
                colorRow.addView(dot, lp);
            }
        };
        drawPick[0].run();
        HorizontalScrollView is = new HorizontalScrollView(this);
        is.addView(iconRow);
        f.addView(is, Ui.fill());
        f.addView(Ui.label(this, "Color"));
        f.addView(colorRow, Ui.fill());
        ScrollView sv = new ScrollView(this);
        sv.addView(f);
        Ui.dialog(this).setTitle(id == null ? "New goal" : "Edit goal").setView(sv).setNegativeButton("Cancel", null)
                .setPositiveButton(id == null ? "Add goal" : "Save", (d, w) -> {
                    try {
                        double n = Double.parseDouble(target.getText().toString().replace(',', '.'));
                        String nm = name.getText().toString().trim();
                        if (nm.isEmpty() || n <= 0) { Ui.toast(this, nm.isEmpty() ? "Give it a name" : "The target is a number above 0"); return; }
                        boolean minutes = type[0] >= 2;
                        JSONObject g = new JSONObject()
                                .put("name", nm)
                                .put("target", Math.max(1, Math.round(minutes ? n * 60 : n)))
                                .put("unit", type[0] == 1 ? "ml" : minutes ? "sec" : unit.getText().toString().trim().isEmpty() ? "reps" : unit.getText().toString().trim())
                                .put("icon", ICON_KEYS[icon[0]])
                                .put("color", COLORS[col[0]]);
                        if (id != null) g.put("id", id);
                        if (type[0] == 3) g.put("kind", "ride");
                        JSONArray on = new JSONArray(), bonus = new JSONArray();
                        for (int k = 0; k < 7; k++) { if (state[k] == 1) on.put(WEEK[k]); else if (state[k] == 2) bonus.put(WEEK[k]); }
                        if (on.length() > 0 && on.length() < 7) g.put("days", on);
                        if (bonus.length() > 0 && on.length() > 0 && on.length() < 7) g.put("bonusDays", bonus);
                        act(new JSONObject().put("act", "save_goal").put("goal", g));
                    } catch (Exception e) {
                        Ui.toast(this, "The target is a number");
                    }
                }).show();
    }

    private static String trim(double v) {
        return v == Math.rint(v) ? String.valueOf((long) v) : String.valueOf(v);
    }

    private void importDialog() {
        final EditText in = Ui.input(this, "ABCD-EFGH-JKMN, or the export's text", true);
        LinearLayout f = Ui.col(this);
        f.setPadding(Ui.dp(20), Ui.dp(8), Ui.dp(20), 0);
        f.addView(Ui.text(this, "Your goals, history, rides, walking and Coach chat. Type the code Schedule Fixer's “Export to Person Hub” shows, or paste its exported text.", 13, Ui.G700));
        f.addView(in, Ui.fill());
        Ui.dialog(this).setTitle("Import from Schedule Fixer").setView(f).setNegativeButton("Cancel", null).setPositiveButton("Read", (d, w) -> {
            String t = in.getText().toString().trim();
            final Hub h = hub;
            Ui.pool.execute(() -> {
                try {
                    JSONObject body = t.matches("[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}") ? new JSONObject().put("code", t) : new JSONObject().put("text", t);
                    JSONObject r = h.call("POST", "/v1/routine/import", body);
                    JSONObject s = r.optJSONObject("summary");
                    String what = s == null ? "" : s.optInt("goals") + " goals, " + s.optInt("entries") + " entries over " + s.optInt("days") + " days, " + s.optInt("rides") + " rides";
                    Ui.main.post(() -> Ui.dialog(this).setTitle("Replace Routine's data?").setMessage(what + ". This replaces Routine's data here and on the PC.")
                            .setNegativeButton("Cancel", null).setPositiveButton("Replace", (d2, w2) -> Ui.pool.execute(() -> {
                                try {
                                    h.call("POST", "/v1/routine/import", body.put("confirm", true));
                                    Ui.main.post(() -> { Ui.toast(this, "Imported"); load(); });
                                } catch (Exception e) { Ui.main.post(() -> Ui.toast(this, h.whyDown(e))); }
                            })).show());
                } catch (Exception e) {
                    Ui.main.post(() -> Ui.toast(this, h.whyDown(e)));
                }
            });
        }).show();
    }

    // ---- Coach ----

    private void drawCoach() {
        if (coach == null) { body.addView(Ui.text(this, "Loading…", 14, Ui.G700)); return; }
        JSONArray msgs = coach.optJSONArray("messages");
        if (!coach.optBoolean("ready")) body.addView(Ui.text(this, "Add the “" + coach.optString("project") + "” project in Projects: the Coach is a chat there.", 13, Ui.G700));
        else if (msgs == null || msgs.length() == 0) body.addView(Ui.text(this, "Ask the Coach about your day: today's stats go along with your message.", 13, Ui.G700));
        for (int i = 0; msgs != null && i < msgs.length(); i++) {
            JSONObject m = msgs.optJSONObject(i);
            boolean agent = "agent".equals(m.optString("role"));
            LinearLayout line = Ui.row(this);
            line.setGravity(agent ? Gravity.START : Gravity.END);
            TextView t = Ui.text(this, m.optString("text") + (m.optBoolean("done", true) ? "" : " …"), 15, agent ? Ui.FG : Ui.ON_INK);
            t.setTextIsSelectable(true);
            t.setPadding(Ui.dp(12), Ui.dp(8), Ui.dp(12), Ui.dp(8));
            t.setBackground(Ui.round(agent ? Ui.G100 : Ui.INK, 0, 14));
            t.setMaxWidth((int) (getResources().getDisplayMetrics().widthPixels * 0.8));
            line.addView(t, Ui.wrap());
            LinearLayout.LayoutParams lp = Ui.fill();
            lp.bottomMargin = Ui.dp(6);
            body.addView(line, lp);
            JSONArray chips = m.optJSONArray("chips");
            for (int j = 0; chips != null && j < chips.length(); j++) {
                final JSONObject c = chips.optJSONObject(j);
                LinearLayout cr = Ui.row(this);
                cr.addView(Ui.text(this, (c.optBoolean("ok") ? "✓ " : "✕ ") + c.optString("label") + (c.optBoolean("undone") ? " (undone)" : ""), 12, c.optBoolean("ok") ? Ui.GREEN : Ui.RED));
                if (c.optBoolean("canUndo")) addTo(cr, Ds.chip(this, "Undo", false, v -> coachUndo(c.optString("key"))));
                body.addView(cr, Ui.fill());
            }
        }
        if (coach.optBoolean("running")) body.addView(Ui.text(this, "writing…", 13, Ui.G700));
        LinearLayout in = Ui.row(this);
        in.setPadding(0, Ui.dp(10), 0, 0);
        final EditText e = Ui.input(this, "Message the Coach", true);
        in.addView(e, Ui.weight());
        in.addView(Ui.iconButton(this, Ui.I_SEND, Ui.FG, v -> {
            String text = e.getText().toString().trim();
            if (text.isEmpty()) return;
            e.setText("");
            coachSend(text);
        }));
        body.addView(in, Ui.fill());
        scroll.post(() -> scroll.fullScroll(View.FOCUS_DOWN));
    }

    private void coachSend(String text) {
        final Hub h = hub;
        Ui.pool.execute(() -> {
            try {
                h.call("POST", "/v1/routine/coach", new JSONObject().put("text", text));
                Ui.main.post(this::load);
            } catch (Exception e) {
                Ui.main.post(() -> Ui.toast(this, h.whyDown(e)));
            }
        });
    }

    private void coachUndo(String key) {
        final Hub h = hub;
        Ui.pool.execute(() -> {
            try {
                h.call("POST", "/v1/routine/coach/undo", new JSONObject().put("key", key));
                Ui.main.post(this::load);
            } catch (Exception e) {
                Ui.main.post(() -> Ui.toast(this, h.whyDown(e)));
            }
        });
    }
}
