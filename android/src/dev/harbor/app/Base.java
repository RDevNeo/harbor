package dev.harbor.app;

import android.app.Activity;
import android.content.Intent;
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

    /** Harbor screens in the foreground now. */
    static volatile int resumed;
    /** Harbor screens on screen now (between onStart and onStop, paused ones too): an update
     *  doesn't install while any is (Update.quiet). */
    static volatile int started;
    /** When the last of them went out of sight (elapsedRealtime), 0 while none has shown in this
     *  process: an update installs a few seconds after (Quiet.GRACE_MS). */
    static volatile long leftAt;
    /** When Harbor sent the user to another app for an answer (a photo, a file, the camera;
     *  elapsedRealtime), 0 once a screen is back: installing then would lose the answer. */
    static volatile long outFor;
    /** This screen is in front (between onResume and onPause). */
    boolean front;
    /** The screen in front now (Swap), and since when this one is (elapsedRealtime). */
    static volatile Base top;
    long resumedAt;
    /** Harbor's screens in this process, oldest first (Swap writes the task down from it). */
    static final java.util.List<Base> alive = new java.util.ArrayList<>();
    private int gen;                 // bumped to stop the current poll loop
    private volatile Net.Http polling;
    private long rev = -1;
    private String lastVia; // the PC the last answer came from
    boolean offline;
    private int myTheme;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        alive.add(this);
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
        // This version's notification channels; earlier versions' dead ones leave Android's settings.
        Notes.setUp(this);
        // Other apps' chats through this phone (LocalApi), while Harbor's process runs.
        LocalApi.start(this);
    }

    /** True (and finishes) when the screen needs a hub that was unpaired meanwhile. */
    /** The account's sign-in ran out and can't be renewed: the start screen asks again. */
    void signInAgain() {
        if (this instanceof Hubs || isFinishing()) return;
        startActivity(new Intent(this, Hubs.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP));
        finish();
    }

    boolean noHub() {
        if (hub != null) return false;
        finish();
        return true;
    }

    /** A column with the top bar (Ds.TopBar), then content filling the rest. back: an arrow that closes
     *  the screen (a sub-page); else nothing on the left (tab screens put the side-panel button there). */
    LinearLayout frame(String title, boolean back) {
        return frame(title, back ? Ds.backButton(this, v -> finish()) : null, true);
    }

    /** The page's top bar: `leading` at the far left (the side-panel button, or a back arrow), the title beside
     *  it, actions on the right; the same bar on every page of every tab (DESIGN.md "Android"). */
    LinearLayout frame(String title, View leading, boolean unused) {
        page = Ui.col(this);
        page.setBackgroundColor(Ui.BG);
        topBar = Ds.topBar(this, leading, title);
        bar = topBar.view;
        barTitle = topBar.title;
        barSub = topBar.sub;
        barActions = topBar.actions;
        page.addView(bar, Ui.fill());
        setContentView(page);
        return page;
    }

    Ds.TopBar topBar;

    void sub(String s, int color) {
        barSub.setText(s);
        barSub.setTextColor(color);
        barSub.setVisibility(TextUtils.isEmpty(s) ? View.GONE : View.VISIBLE);
    }

    TextView action(String glyph, View.OnClickListener on) {
        TextView t = Ds.barButton(this, glyph, on);
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

    // ---- one image picked for a caller (a project's icon, ProjectMenu) ----

    static final int PICK_IMAGE = 0x7a1;

    interface Picked { void on(android.net.Uri uri); }

    private Picked picked;

    /** The system photo picker (Android 13+), else any image picker; `then` gets the image. */
    void pickImage(Picked then) {
        picked = then;
        Intent i = Build.VERSION.SDK_INT >= 33
                ? new Intent(android.provider.MediaStore.ACTION_PICK_IMAGES)
                : new Intent(Intent.ACTION_GET_CONTENT).setType("image/*").addCategory(Intent.CATEGORY_OPENABLE);
        try { startActivityForResult(i, PICK_IMAGE); } catch (Exception e) { picked = null; Ui.toast(this, "No app to pick images with"); }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req != PICK_IMAGE) return;
        Picked p = picked;
        picked = null;
        if (p != null && res == RESULT_OK && data != null && data.getData() != null) p.on(data.getData());
    }

    // ---- the tab frame: every tab's screen is its page over the tab bar, the tab's drawer sliding in from the
    // left over both (a swipe right anywhere, or the top bar's side-panel button), and on a chat its team from
    // the right (a swipe left). Projects' drawer is the chat list (Sidebar), Persons' its people, Routine's and
    // Collector's their pages. ----

    static final int NONE = 0, LEFT = 1, RIGHT = 2;
    Sidebar side;
    /** The tab this screen belongs to (Tabs.PROJECTS…), null on screens outside the tabs. */
    String tab;
    private View drawer; // the left panel
    private View right; // the right panel, or null on screens without one
    private FrameLayout shell;
    private View scrim;
    private int panelW, rightW;
    private int open = NONE;

    /** The top bar's side-panel button: opens the tab's drawer. */
    View menuButton() { return Ds.sideButton(this, v -> openDrawer()); }

    /** Projects' screens: the page (frame()) over the tab bar, the chat list as the drawer. Call after frame(). */
    void installDrawer(String currentChat) {
        side = new Sidebar(this, currentChat);
        installTab(Tabs.PROJECTS, side.view);
        JSONObject st = Hub.states.get(hub.id);
        if (st != null) side.render(st);
    }

    /** The page (`page`, already the content view) over the tab bar of `tab`, `drawerView` as its drawer. */
    void installTab(String tab, View drawerView) {
        this.tab = tab;
        drawer = drawerView;
        shell = new FrameLayout(this);
        if (page.getParent() != null) ((ViewGroup) page.getParent()).removeView(page);
        shell.addView(Tabs.around(this, page, tab), frameFill());
        scrim = new View(this);
        scrim.setBackgroundColor(0x99000000);
        scrim.setAlpha(0);
        scrim.setVisibility(View.GONE);
        scrim.setOnClickListener(v -> closeDrawer());
        shell.addView(scrim, frameFill());
        panelW = Ds.drawerWidth(this);
        drawer.setElevation(Ui.dp(8));
        if (drawer.getParent() != null) ((ViewGroup) drawer.getParent()).removeView(drawer);
        shell.addView(drawer, new FrameLayout.LayoutParams(panelW, ViewGroup.LayoutParams.MATCH_PARENT));
        drawer.setTranslationX(-panelW);
        drawer.setVisibility(View.INVISIBLE);
        setContentView(shell);
        // Redrawn for the drawer's sun/moon: the drawer stays open, as it was when tapped.
        if (reopenDrawer) {
            reopenDrawer = false;
            open = LEFT;
            drawer.setVisibility(View.VISIBLE);
            drawer.setTranslationX(0);
            scrim.setVisibility(View.VISIBLE);
            scrim.setAlpha(1f);
        }
    }

    /** The screen's root: the tab frame (page, tab bar, drawer), or the page alone. */
    View root() { return shell != null ? shell : page; }

    /** The drawer is coming out: its list is drawn fresh (Projects' from the last state). */
    void onDrawerOpening() {
        if (side != null && hub != null) {
            JSONObject st = Hub.states.get(hub.id);
            if (st != null) side.render(st);
        }
    }

    /** Set by flipTheme: the screen it recreates opens with its drawer out. */
    private static boolean reopenDrawer;

    /** The drawer's sun/moon (Sidebar): light <-> dark at once, this screen redrawn in it (the
     *  others redraw when they come back: Ui.themeGen). */
    void flipTheme() {
        Ui.flipTheme(this);
        reopenDrawer = drawerOpen();
        recreate();
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
        View p = panel == LEFT ? drawer : right;
        int w = panel == LEFT ? panelW : rightW;
        View other = panel == LEFT ? right : drawer;
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
                    if (!was) onDrawerOpening();
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
        Swap.touch(e);
        // No drawer on this screen, or a screen of its own over it (Collector's lead detail).
        if (shell == null || !shell.isAttachedToWindow()) return super.dispatchTouchEvent(e);
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

    @Override
    protected void onStart() {
        super.onStart();
        // Back on screen from outside Harbor: is a release out? (Update, no PC involved)
        if (started++ <= 0) Update.opened(getApplicationContext());
    }

    @Override
    protected void onStop() {
        super.onStop();
        if (--started > 0) return;
        started = 0;
        // Out of sight: a waiting update installs in a few seconds, unless a screen comes back.
        leftAt = android.os.SystemClock.elapsedRealtime();
        Update.left(getApplicationContext());
    }

    @Override
    public void startActivityForResult(Intent i, int req, Bundle options) {
        outFor = android.os.SystemClock.elapsedRealtime();
        super.startActivityForResult(i, req, options);
    }

    @Override
    protected void onResume() {
        super.onResume();
        outFor = 0;
        resumed++;
        front = true;
        if (Tabs.PROJECTS.equals(tab)) Tabs.projectsShown(this);
        Inbox.resumed(this);
        Gmail.sayPending(this);
        Invites.resumed(this);
        Alive.calm(this);
        top = this;
        resumedAt = android.os.SystemClock.elapsedRealtime();
        Swap.resumed(this);
        // A screen that stays up a few seconds proves new app code works (no rollback; Shell).
        Ui.main.postDelayed(() -> { if (front && !isFinishing()) Ui.pool.execute(dev.harbor.shell.Shell::ok); }, 5_000);
        if (myTheme != Ui.themeGen) { recreate(); return; }
        if (hub != null) startPolling();
        // The tab bar's Collector count, fresh for this screen.
        Tabs.poke(Tabs.hub(this));
    }

    @Override
    protected void onPause() {
        super.onPause();
        resumed--;
        front = false;
        if (top == this) top = null;
        Inbox.paused(this);
        Invites.paused();
        // Left the app (not just another of its screens): listen a few minutes for answers.
        Ui.main.postDelayed(() -> { if (resumed <= 0 && !Hub.all(getApplicationContext()).isEmpty()) Alive.burst(getApplicationContext()); }, 2_000);
        gen++;
        Net.Http c = polling;
        if (c != null) Ui.pool.execute(c::close);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        alive.remove(this);
        if (top == this) top = null;
    }

    @Override
    public boolean dispatchKeyEvent(android.view.KeyEvent e) {
        Swap.input();
        return super.dispatchKeyEvent(e);
    }

    // ---- live updates (Swap, Live) ----

    /** The text field whose text and cursor this screen keeps across a live restart (Chat's
     *  composer), or null. */
    View liveField() { return null; }

    /** This screen as a live restart keeps it: its class, the extras it opens with (Live.keep),
     *  and an open side panel; null when it can't be opened again. Screens add their own place. */
    Live.Screen liveScreen() {
        String n = getClass().getSimpleName();
        String[] keep = Live.keep(n);
        if (keep == null) return null;
        Live.Screen s = new Live.Screen(n);
        Bundle x = getIntent().getExtras();
        if (x != null) for (String k : keep) {
            Object v = x.get(k);
            if (v instanceof String || v instanceof Long || v instanceof Integer || v instanceof Boolean) s.extras.put(k, v);
        }
        if (open != NONE) s.state.put("panel", Integer.toString(open));
        return s;
    }

    /** A side panel open at once, as a live restart left it (after installDrawer/installRight). */
    void livePanel(Bundle saved) {
        String p = Swap.state(this, saved, "panel");
        int which = p == null ? NONE : "1".equals(p) ? LEFT : "2".equals(p) ? RIGHT : NONE;
        if (which == NONE || shell == null || (which == RIGHT && right == null)) return;
        View v = which == LEFT ? drawer : right;
        open = which;
        v.setVisibility(View.VISIBLE);
        v.setTranslationX(0);
        scrim.setVisibility(View.VISIBLE);
        scrim.setAlpha(1f);
        if (which == RIGHT) onRightOpened();
    }

    private void startPolling() {
        final int my = ++gen;
        final Hub h = hub;
        Ui.pool.execute(() -> {
            int fails = 0;
            boolean first = true, shown = false;
            while (my == gen) {
                boolean connected = false;
                String pc = null;
                try {
                    // since=-1 (first call) answers at once with the current revision. Only the
                    // PC in use (stick): each counts its own revisions.
                    Net.Http c = h.open("GET", "/v1/events?since=" + Math.max(rev, 0), Hub.POLL_TIMEOUT, true, true);
                    connected = true;
                    pc = c.pc;
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
                    // Another PC answered (the one used before stopped): its revisions are its own,
                    // so everything is asked again (quietly: the screen just refreshes).
                    String now = pc;
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
                    if (shown) Ui.main.post(() -> { if (my == gen) { offline = false; offlineError = null; onOffline(false, null); } });
                    shown = false;
                    lastWhy = null;
                    fails = 0;
                    // The first answer only tells the revision; the screen loaded on resume already,
                    // unless it missed something while paused (rev moved on).
                    boolean news = !changed.isEmpty() || sc || reconnect;
                    if (wasFirst) news = old >= 0 && nrev != old;
                    // The PC's state moved (a Collector run may have ended): the tab bar's count again.
                    if (sc || reconnect) Tabs.poke(h);
                    if (news) {
                        boolean all = reconnect || (wasFirst && old >= 0);
                        Ui.main.post(() -> { if (my == gen) onEvents(changed, sc || all, all); });
                    }
                } catch (Exception e) {
                    if (my != gen) return;
                    // The sign-in was refused: a new Harbor token may fix it (Hub.error asks for one);
                    // when Clerk won't renew it either, back to the sign-in screen.
                    if (e instanceof Hub.ApiError && ((Hub.ApiError) e).signin && Account.needsSignIn(this))
                        Ui.main.post(() -> { if (my == gen) signInAgain(); });
                    // The hub answers a long-poll within 20 s: no answer in 40 means the connection
                    // died on the way (or the PC). One such is a blip: Route keeps the PC in use
                    // until it fails again (open() counts the connections it couldn't make).
                    if (connected) h.failed(pc, e);
                    if (connected && e instanceof java.net.SocketTimeoutException && fails == 0) continue;
                    fails++;
                    // An answer from the PC (an error, a sign-in refused) is said at once; the
                    // network only once it keeps failing.
                    if (!Route.showsOffline(e instanceof Hub.ApiError || e instanceof Net.Refused, fails)) {
                        try { Thread.sleep(Route.retryDelay(fails)); } catch (InterruptedException ignored) { }
                        continue;
                    }
                    // Said again when it changes (the connection dropped, then the PC refuses:
                    // Harbor was quit there).
                    final String why = h.whyDown(e);
                    final Throwable err = e;
                    if (!shown || !why.equals(lastWhy)) {
                        shown = true;
                        lastWhy = why;
                        Ui.main.post(() -> { if (my == gen) { offline = true; offlineError = err; onOffline(true, why); } });
                    }
                    try { Thread.sleep(Route.retryDelay(fails)); } catch (InterruptedException ignored) { }
                }
            }
        });
    }
}
