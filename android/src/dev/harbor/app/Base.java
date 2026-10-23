package dev.harbor.app;

import android.app.Activity;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashSet;
import java.util.Set;

/** Shared by every screen: Harbor's colours, a top bar, and the /v1/events long-poll that runs
 *  while the screen is in the foreground (reconnecting on any error). */
abstract class Base extends Activity {
    Hub hub;
    LinearLayout bar;
    TextView barTitle, barSub;
    LinearLayout barActions;

    private int gen;                 // bumped to stop the current poll loop
    private volatile Tailnet.Http polling;
    private long rev = -1;
    boolean offline;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        Ui.init(this);
        getWindow().setStatusBarColor(Ui.BG);
        getWindow().setNavigationBarColor(Ui.BG);
        getWindow().getDecorView().setBackgroundColor(Ui.BG);
        String id = getIntent().getStringExtra("hub");
        if (id != null) hub = Hub.get(this, id);
    }

    /** True (and finishes) when the screen needs a hub that was unpaired meanwhile. */
    boolean noHub() {
        if (hub != null) return false;
        finish();
        return true;
    }

    /** A column with the top bar, then content filling the rest. */
    LinearLayout frame(String title, boolean back) {
        LinearLayout root = Ui.col(this);
        root.setBackgroundColor(Ui.BG);
        bar = Ui.row(this);
        bar.setPadding(Ui.dp(4), Ui.dp(4), Ui.dp(4), Ui.dp(4));
        bar.setMinimumHeight(Ui.dp(56));
        if (back) bar.addView(Ui.iconButton(this, Ui.I_LEFT, Ui.FG, v -> finish()));
        else bar.addView(new View(this), new LinearLayout.LayoutParams(Ui.dp(12), 1));
        LinearLayout t = Ui.col(this);
        barTitle = Ui.subtitle(Ui.bold(this, title, 17, Ui.FG));
        barSub = Ui.subtitle(Ui.text(this, "", 12, Ui.G700));
        barSub.setVisibility(View.GONE);
        t.addView(barTitle);
        t.addView(barSub);
        bar.addView(t, Ui.margins(Ui.weight(), 4, 0, 4, 0));
        barActions = Ui.row(this);
        bar.addView(barActions);
        root.addView(bar, Ui.fill());
        View line = new View(this);
        line.setBackgroundColor(Ui.G300);
        root.addView(line, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Ui.dp(1)));
        setContentView(root);
        return root;
    }

    void sub(String s, int color) {
        barSub.setText(s);
        barSub.setTextColor(color);
        barSub.setVisibility(TextUtils.isEmpty(s) ? View.GONE : View.VISIBLE);
    }

    TextView action(String glyph, View.OnClickListener on) {
        TextView t = Ui.iconButton(this, glyph, Ui.FG, on);
        barActions.addView(t);
        return t;
    }

    /** A centred grey line for empty and error states. */
    TextView hint(String s) {
        TextView t = Ui.text(this, s, 14, Ui.G700);
        t.setGravity(Gravity.CENTER);
        t.setPadding(Ui.dp(24), Ui.dp(32), Ui.dp(24), Ui.dp(32));
        return t;
    }

    FrameLayout.LayoutParams frameFill() {
        return new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
    }

    // ---- events ----

    /** Called on the UI thread when chats changed or the state did. reconnect = the poll came
     *  back after an error or the hub restarted: refresh everything. */
    void onEvents(Set<String> changed, boolean stateChanged, boolean reconnect) { }

    /** The hub stopped answering (true) or answers again (false). */
    void onOffline(boolean off, String why) { }

    @Override
    protected void onResume() {
        super.onResume();
        if (hub != null) startPolling();
    }

    @Override
    protected void onPause() {
        super.onPause();
        gen++;
        Tailnet.Http c = polling;
        if (c != null) Ui.pool.execute(c::close);
    }

    private void startPolling() {
        final int my = ++gen;
        final Hub h = hub;
        Ui.pool.execute(() -> {
            int fails = 0;
            boolean first = true;
            while (my == gen) {
                boolean connected = false;
                try {
                    // since=-1 (first call) answers at once with the current revision.
                    Tailnet.Http c = h.open("GET", "/v1/events?since=" + Math.max(rev, 0), Hub.TIMEOUT);
                    connected = true;
                    polling = c;
                    JSONObject r;
                    try {
                        if (my != gen) return; // paused while connecting
                        int code = c.code();
                        if (code >= 400) throw new Hub.ApiError(code, code == 401 ? "This PC refused the pairing token. Pair it again." : "HTTP " + code);
                        r = new JSONObject(Hub.read(c.in()));
                    } finally {
                        c.close();
                        polling = null;
                    }
                    if (my != gen) return;
                    long nrev = r.optLong("rev", 0);
                    boolean reconnect = fails > 0 || (rev >= 0 && nrev < rev);
                    boolean wasFirst = first;
                    first = false;
                    long old = rev;
                    rev = nrev;
                    Set<String> changed = new HashSet<>();
                    JSONArray a = r.optJSONArray("changed_chats");
                    if (a != null) for (int i = 0; i < a.length(); i++) changed.add(a.optString(i));
                    boolean sc = r.optBoolean("state_changed");
                    if (fails > 0) Ui.main.post(() -> { if (my == gen) { offline = false; onOffline(false, null); } });
                    fails = 0;
                    // The first answer only tells the revision; the screen loaded on resume already,
                    // unless it missed something while paused (rev moved on).
                    boolean news = !changed.isEmpty() || sc || reconnect;
                    if (wasFirst) news = old >= 0 && nrev != old;
                    if (news) {
                        boolean all = reconnect || (wasFirst && old >= 0);
                        Ui.main.post(() -> { if (my == gen) onEvents(changed, sc || all, all); });
                    }
                } catch (Exception e) {
                    if (my != gen) return;
                    if (connected && e instanceof java.net.SocketTimeoutException && fails == 0) continue; // an idle long-poll
                    fails++;
                    final String why = Hub.why(e);
                    if (fails == 1) Ui.main.post(() -> { if (my == gen) { offline = true; onOffline(true, why); } });
                    try { Thread.sleep(Math.min(10_000, 1000L * fails)); } catch (InterruptedException ignored) { }
                }
            }
        });
    }
}
