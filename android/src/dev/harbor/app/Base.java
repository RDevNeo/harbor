package dev.harbor.app;

import android.app.Activity;
import android.os.Build;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.MotionEvent;
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
    LinearLayout page; // the frame's column (top bar + content)

    /** Harbor screens in the foreground now (Presence only asks for the unlock then). */
    static volatile int resumed;
    private int gen;                 // bumped to stop the current poll loop
    private volatile Net.Http polling;
    private long rev = -1;
    private String lastVia; // the PC the last answer came from
    boolean offline;
    private int myTheme;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        Ui.init(this);
        Ui.bars(this);
        myTheme = Ui.themeGen;
        String id = getIntent().getStringExtra("hub");
        if (id != null) hub = Hub.get(this, id);
        // Notifications (Notes): Android 13 asks once, when a PC is paired; Instant per setting.
        boolean paired = hub != null || !Hub.all(this).isEmpty();
        if (paired && Build.VERSION.SDK_INT >= 33 && !Notes.allowed(this) && !Notes.prefs(this).getBoolean("asked", false)) {
            Notes.prefs(this).edit().putBoolean("asked", true).apply();
            requestPermissions(new String[] { "android.permission.POST_NOTIFICATIONS" }, 42);
        }
        if (paired) Listen.apply(this);
    }

    /** True (and finishes) when the screen needs a hub that was unpaired meanwhile. */
    boolean noHub() {
        if (hub != null) return false;
        finish();
        return true;
    }

    /** A column with the top bar, then content filling the rest. back: an arrow that closes
     *  the screen; else nothing on the left (drawer screens put the menu button there). */
    LinearLayout frame(String title, boolean back) {
        return frame(title, back ? Ui.iconButton(this, Ui.I_LEFT, Ui.FG, v -> finish()) : null, true);
    }

    /** serifTitle: a page title like "Settings"; else a chat's title in the body font. */
    LinearLayout frame(String title, View leading, boolean serifTitle) {
        page = Ui.col(this);
        page.setBackgroundColor(Ui.BG);
        bar = Ui.row(this);
        bar.setPadding(Ui.dp(6), Ui.dp(6), Ui.dp(6), Ui.dp(6));
        bar.setMinimumHeight(Ui.dp(60));
        FrameLayout lead = new FrameLayout(this);
        if (leading != null) lead.addView(leading, new FrameLayout.LayoutParams(Ui.dp(44), Ui.dp(44), Gravity.CENTER_VERTICAL | Gravity.START));
        bar.addView(lead, new LinearLayout.LayoutParams(Ui.dp(88), Ui.dp(44)));
        LinearLayout t = Ui.col(this);
        t.setGravity(Gravity.CENTER_HORIZONTAL);
        barTitle = Ui.subtitle(serifTitle ? Ui.title(this, title, 24) : Ui.bold(this, title, 17, Ui.FG));
        barTitle.setGravity(Gravity.CENTER);
        barSub = Ui.subtitle(Ui.text(this, "", 13, Ui.G700));
        barSub.setGravity(Gravity.CENTER);
        barSub.setVisibility(View.GONE);
        t.addView(barTitle, Ui.fill());
        t.addView(barSub, Ui.fill());
        bar.addView(t, Ui.weight());
        barActions = Ui.row(this);
        barActions.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
        bar.addView(barActions, new LinearLayout.LayoutParams(Ui.dp(88), Ui.dp(44)));
        page.addView(bar, Ui.fill());
        setContentView(page);
        return page;
    }

    /** The workspace chip under the title (WorkBar.header): the chat works in a worktree. */
    void addHeaderChip(WorkBar w) {
        LinearLayout.LayoutParams lp = Ui.wrap();
        lp.gravity = Gravity.CENTER_HORIZONTAL;
        lp.topMargin = Ui.dp(3);
        ((LinearLayout) barTitle.getParent()).addView(w.header(), lp);
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
        TextView t = Ui.text(this, s, 15, Ui.G700);
        t.setGravity(Gravity.CENTER);
        t.setPadding(Ui.dp(28), Ui.dp(32), Ui.dp(28), Ui.dp(32));
        return t;
    }

    void hintInto(LinearLayout l, String s) { l.addView(hint(s), Ui.fill()); }

    FrameLayout.LayoutParams frameFill() {
        return new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
    }

    /** Fetch /v1/state again and redraw (after a rename, settle, delete from a menu). */
    void refresh() { }

    // ---- the side panels (Chat, NewChat): the chat list slides in from the left, a chat's
    // team (Team) from the right ----

    static final int NONE = 0, LEFT = 1, RIGHT = 2;
    Sidebar side;
    private View right; // the right panel, or null on screens without one
    private FrameLayout shell;
    private View scrim;
    private int panelW, rightW;
    private int open = NONE;

    /** The menu button for the top bar's left. */
    View menuButton() {
        FrameLayout b = Ui.roundButton(this, new Ui.Draw(Ui.Draw.MENU, Ui.FG), 0, Ui.FG, 44, v -> openDrawer());
        b.setBackground(Ui.press(0, 0, 22));
        b.setContentDescription("Chats");
        return b;
    }

    /** Puts the page (frame()) under a drawer holding the chat list. Call after frame(). */
    void installDrawer(String currentChat) {
        side = new Sidebar(this, currentChat);
        shell = new FrameLayout(this);
        ((ViewGroup) page.getParent()).removeView(page);
        shell.addView(page, frameFill());
        scrim = new View(this);
        scrim.setBackgroundColor(0x66000000);
        scrim.setAlpha(0);
        scrim.setVisibility(View.GONE);
        scrim.setOnClickListener(v -> closeDrawer());
        shell.addView(scrim, frameFill());
        panelW = Math.min(getResources().getDisplayMetrics().widthPixels * 86 / 100, Ui.dp(400));
        side.view.setElevation(Ui.dp(8));
        shell.addView(side.view, new FrameLayout.LayoutParams(panelW, ViewGroup.LayoutParams.MATCH_PARENT));
        side.view.setTranslationX(-panelW);
        side.view.setVisibility(View.INVISIBLE);
        setContentView(shell);
        JSONObject st = Hub.states.get(hub.id);
        if (st != null) side.render(st);
    }

    /** A panel for the right edge (after installDrawer): a swipe to the left opens it. */
    void installRight(View panel) {
        right = panel;
        rightW = Math.min(getResources().getDisplayMetrics().widthPixels * 88 / 100, Ui.dp(400));
        right.setElevation(Ui.dp(8));
        shell.addView(right, new FrameLayout.LayoutParams(rightW, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.END));
        right.setTranslationX(rightW);
        right.setVisibility(View.INVISIBLE);
        // With gesture navigation the right edge is Back: the middle of it opens the panel here.
        if (android.os.Build.VERSION.SDK_INT >= 29) shell.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> {
            int h = b - t, w = r - l;
            v.setSystemGestureExclusionRects(java.util.Collections.singletonList(
                    new android.graphics.Rect(w - Ui.dp(32), h / 2 - Ui.dp(100), w, h / 2 + Ui.dp(100))));
        });
    }

    void openDrawer() { slide(LEFT, 1f, true); }
    void openRight() { if (right != null) slide(RIGHT, 1f, true); }
    /** Closes whichever panel is open. */
    void closeDrawer() { if (open != NONE) slide(open, 0f, true); }
    boolean drawerOpen() { return open == LEFT; }
    boolean rightOpen() { return open == RIGHT; }

    /** The right panel just opened (Chat loads the team then). */
    void onRightOpened() { }

    /** panel: LEFT or RIGHT; f: 0 closed .. 1 open. */
    private void slide(int panel, float f, boolean animate) {
        if (shell == null || (panel == RIGHT && right == null)) return;
        View p = panel == LEFT ? side.view : right;
        int w = panel == LEFT ? panelW : rightW;
        View other = panel == LEFT ? right : side.view;
        if (other != null && other.getVisibility() == View.VISIBLE) { // only one at a time
            other.animate().cancel();
            other.setTranslationX(panel == LEFT ? rightW : -panelW);
            other.setVisibility(View.INVISIBLE);
        }
        p.setVisibility(View.VISIBLE);
        scrim.setVisibility(View.VISIBLE);
        float x = (panel == LEFT ? -w : w) * (1 - f);
        if (animate) {
            boolean was = open == panel;
            open = f > 0.5f ? panel : NONE;
            if (open == panel) {
                hideKeyboard();
                if (panel == LEFT) {
                    JSONObject st = Hub.states.get(hub.id);
                    if (st != null) side.render(st);
                } else if (!was) onRightOpened();
            }
            p.animate().translationX(x).setDuration(200).withEndAction(() -> {
                if (open != panel) { p.setVisibility(View.INVISIBLE); if (open == NONE) scrim.setVisibility(View.GONE); }
            }).start();
            scrim.animate().alpha(f).setDuration(200).start();
        } else {
            p.setTranslationX(x);
            scrim.setAlpha(f);
        }
    }

    private void hideKeyboard() {
        View f = getCurrentFocus();
        if (f != null) ((android.view.inputmethod.InputMethodManager) getSystemService(INPUT_METHOD_SERVICE))
                .hideSoftInputFromWindow(f.getWindowToken(), 0);
    }

    @Override
    public void onBackPressed() {
        if (open != NONE) { closeDrawer(); return; }
        super.onBackPressed();
    }

    // A rightward swipe anywhere opens the drawer, a leftward one the right panel (from the
    // right edge too); the opposite swipe closes the open one. A swipe that starts on something
    // that scrolls sideways itself (code blocks, tables, chips) keeps it, except at the edge.
    private float downX, downY;
    private boolean dragging, undecided;
    private int startOpen, which;

    @Override
    public boolean dispatchTouchEvent(MotionEvent e) {
        if (shell == null) return super.dispatchTouchEvent(e); // no drawer on this screen
        switch (e.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                downX = e.getRawX();
                downY = e.getRawY();
                dragging = false;
                startOpen = open;
                boolean edge = right != null && downX > getResources().getDisplayMetrics().widthPixels - Ui.dp(40);
                undecided = open != NONE || edge || !hScrolls(shell, e.getRawX(), e.getRawY());
                break;
            case MotionEvent.ACTION_MOVE: {
                float dx = e.getRawX() - downX, dy = e.getRawY() - downY;
                if (undecided && !dragging) {
                    float slop = Ui.dp(14);
                    if (Math.abs(dy) > slop && Math.abs(dy) > Math.abs(dx)) undecided = false;
                    else if (Math.abs(dx) > slop && Math.abs(dx) > 1.6f * Math.abs(dy)) {
                        which = startOpen == LEFT ? (dx < 0 ? LEFT : NONE)
                                : startOpen == RIGHT ? (dx > 0 ? RIGHT : NONE)
                                : dx > 0 ? LEFT : right != null ? RIGHT : NONE;
                        if (which == NONE) undecided = false;
                        else {
                            dragging = true;
                            MotionEvent cancel = MotionEvent.obtain(e);
                            cancel.setAction(MotionEvent.ACTION_CANCEL);
                            super.dispatchTouchEvent(cancel);
                            cancel.recycle();
                            hideKeyboard();
                        }
                    }
                }
                if (dragging) {
                    slide(which, Math.max(0, Math.min(1, dragged(dx))), false);
                    return true;
                }
                break;
            }
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL:
                if (dragging) {
                    dragging = false;
                    float f = dragged(e.getRawX() - downX);
                    slide(which, f > (startOpen == which ? 0.7f : 0.3f) ? 1f : 0f, true);
                    return true;
                }
                break;
        }
        return super.dispatchTouchEvent(e);
    }

    /** How open the dragged panel is after a drag of dx. */
    private float dragged(float dx) {
        if (which == LEFT) return startOpen == LEFT ? 1 + dx / panelW : dx / panelW;
        return startOpen == RIGHT ? 1 - dx / rightW : -dx / rightW;
    }

    /** Whether a view under (x, y) can scroll sideways. */
    private static boolean hScrolls(View v, float x, float y) {
        if (v.getVisibility() != View.VISIBLE) return false;
        int[] at = new int[2];
        v.getLocationOnScreen(at);
        if (x < at[0] || y < at[1] || x >= at[0] + v.getWidth() || y >= at[1] + v.getHeight()) return false;
        if (v.canScrollHorizontally(1) || v.canScrollHorizontally(-1)) return true;
        if (v instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) v;
            for (int i = g.getChildCount() - 1; i >= 0; i--) if (hScrolls(g.getChildAt(i), x, y)) return true;
        }
        return false;
    }

    // ---- events ----

    /** Called on the UI thread when chats changed or the state did. reconnect = the poll came
     *  back after an error or the hub restarted: refresh everything. */
    void onEvents(Set<String> changed, boolean stateChanged, boolean reconnect) { }

    /** The hub stopped answering (true) or answers again (false). */
    void onOffline(boolean off, String why) { }

    /** Why the hub stopped answering (for a title: Hub.downTitle), null while it answers. */
    Throwable offlineError;
    private volatile String lastWhy;

    /** "Try again" on an offline card: ask now instead of waiting for the next retry. */
    void retryNow() {
        if (hub == null || isFinishing()) return;
        Net.Http c = polling;
        if (c != null) Ui.pool.execute(c::close);
        startPolling();
        refresh();
    }

    /** Calls now go to another PC of the mesh (the one before stopped answering). */
    void onMoved() {
        String n = hub.viaName();
        String w = hub.movedWhy;
        Ui.toast(this, (w != null ? w + ". " : "") + "Connected through " + (n.isEmpty() ? hub.label() : n));
    }

    @Override
    protected void onResume() {
        super.onResume();
        resumed++;
        Inbox.resumed(this);
        Alive.calm(this);
        if (myTheme != Ui.themeGen) { recreate(); return; }
        if (hub != null) startPolling();
    }

    @Override
    protected void onPause() {
        super.onPause();
        resumed--;
        Inbox.paused(this);
        // Left the app (not just another of its screens): listen a few minutes for answers.
        Ui.main.postDelayed(() -> { if (resumed <= 0 && !Hub.all(getApplicationContext()).isEmpty()) Alive.burst(getApplicationContext()); }, 2_000);
        gen++;
        Net.Http c = polling;
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
                    Net.Http c = h.open("GET", "/v1/events?since=" + Math.max(rev, 0), Hub.TIMEOUT);
                    connected = true;
                    polling = c;
                    JSONObject r;
                    try {
                        if (my != gen) return; // paused while connecting
                        int code = c.code();
                        if (code >= 400) throw Hub.error(c, code);
                        r = new JSONObject(Hub.read(c.in()));
                    } finally {
                        c.close();
                        polling = null;
                    }
                    if (my != gen) return;
                    long nrev = r.optLong("rev", 0);
                    // Another PC answered (the one used before stopped): its revisions are its own.
                    String now = h.via();
                    boolean moved = lastVia != null && !now.equals(lastVia);
                    lastVia = now;
                    boolean reconnect = fails > 0 || moved || (rev >= 0 && nrev < rev);
                    boolean wasFirst = first;
                    first = false;
                    long old = rev;
                    rev = nrev;
                    Set<String> changed = new HashSet<>();
                    JSONArray a = r.optJSONArray("changed_chats");
                    if (a != null) for (int i = 0; i < a.length(); i++) changed.add(a.optString(i));
                    boolean sc = r.optBoolean("state_changed");
                    // Something one of the PCs sent this phone waits there (Devices › Send).
                    if (r.optInt("inbox") > 0) Inbox.poke(h, now);
                    if (fails > 0) Ui.main.post(() -> { if (my == gen) { offline = false; offlineError = null; onOffline(false, null); } });
                    lastWhy = null;
                    fails = 0;
                    // The first answer only tells the revision; the screen loaded on resume already,
                    // unless it missed something while paused (rev moved on).
                    if (moved) Ui.main.post(() -> { if (my == gen) onMoved(); });
                    boolean news = !changed.isEmpty() || sc || reconnect;
                    if (wasFirst) news = old >= 0 && nrev != old;
                    if (news) {
                        boolean all = reconnect || (wasFirst && old >= 0);
                        Ui.main.post(() -> { if (my == gen) onEvents(changed, sc || all, all); });
                    }
                } catch (Exception e) {
                    if (my != gen) return;
                    // The PC ended the session (it restarted): the next call starts a new one.
                    if (e instanceof Hub.ApiError && ((Hub.ApiError) e).rekey && fails == 0) { fails = 1; continue; }
                    // A pairing from before three factors: the PC wants the codes confirmed.
                    if (e instanceof Hub.NeedsUpgrade) Ui.main.post(() -> { if (my == gen) Pair.offerUpgrade(this, h); });
                    // The screen lock was removed or changed: go on with two factors, or re-confirm.
                    if (e instanceof Hub.NeedsLock) Ui.main.post(() -> { if (my == gen) Pair.offerLock(this, h); });
                    // The hub answers a long-poll within 20 s: no answer in 25 means it's gone (or the
                    // way to it). The next try goes to another PC of the mesh first.
                    if (!(e instanceof Hub.ApiError)) h.failed();
                    if (connected && e instanceof java.net.SocketTimeoutException && fails == 0) { fails = 0; continue; }
                    fails++;
                    // Said again when it changes (the connection dropped, then the PC refuses:
                    // Harbor was quit there).
                    final String why = h.whyDown(e);
                    final Throwable err = e;
                    if (fails == 1 || !why.equals(lastWhy)) {
                        lastWhy = why;
                        Ui.main.post(() -> { if (my == gen) { offline = true; offlineError = err; onOffline(true, why); } });
                    }
                    try { Thread.sleep(Math.min(10_000, 1000L * fails)); } catch (InterruptedException ignored) { }
                }
            }
        });
    }
}
