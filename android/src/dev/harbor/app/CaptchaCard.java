package dev.harbor.app;

import android.app.Activity;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Rect;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicReference;

/** A Discord captcha waiting on a chat's agent, solved inside the chat (the desktop's captcha
 *  card; hub `POST /v1/chats/{chat}/captcha`, android/PROTOCOL.md). Chat draws it for a pending
 *  captcha notice without a later one of the same captcha. Frames come about twice a second, one
 *  request at a time, only while the card is on screen and the chat in front; taps on the captcha
 *  go back to the page as presses. Someone else solving it: "Being solved on <label>". No captcha
 *  waiting (404): one line instead. */
final class CaptchaCard {
    interface Front { boolean now(); }

    final LinearLayout view;
    private final Activity a;
    private final Hub hub;
    private final String chat, id;
    private final Front front;
    private final Frame frame;
    private final TextView sub, solver, loading, goneLine;
    private final LinearLayout full;
    private final TextView dontJoin;
    private boolean attached, busy;
    private final Runnable tick = this::tick;
    private boolean pressed;
    private final AtomicReference<int[]> nextMove = new AtomicReference<>();

    /** Presses of every card go out in order, one at a time. */
    private static final ExecutorService INPUT = Executors.newSingleThreadExecutor();
    /** The last frame of a few captchas: a card drawn again (the chat redraws a changed item)
     *  shows it at once. */
    private static final Map<String, Object[]> last = new LinkedHashMap<String, Object[]>() {
        @Override protected boolean removeEldestEntry(Map.Entry<String, Object[]> e) { return size() > 4; }
    };

    CaptchaCard(Activity a, Hub hub, String chat, String id, String guild, Front front) {
        this.a = a;
        this.hub = hub;
        this.chat = chat;
        this.id = id;
        this.front = front;
        view = Ui.col(a);
        view.setBackground(Ui.round(Ui.CARD, Ui.LINE, 16));
        view.setPadding(Ui.dp(14), Ui.dp(12), Ui.dp(14), Ui.dp(12));

        full = Ui.col(a);
        LinearLayout head = Ui.row(a);
        head.setGravity(Gravity.CENTER_VERTICAL);
        head.addView(Ui.icon(a, Ui.I_ALERT, 16, Ui.AMBER));
        head.addView(Ui.bold(a, "Discord needs a captcha", 15, Ui.FG), Ui.margins(Ui.weight(), 8, 0, 0, 0));
        full.addView(head, Ui.fill());
        sub = Ui.text(a, DiscordKit.cardIntro(guild), 13, Ui.G700);
        full.addView(sub, Ui.margins(Ui.fill(), 0, 4, 0, 10));
        FrameLayout box = new FrameLayout(a);
        frame = new Frame(a);
        frame.setOnTouchListener((v, e) -> touch(e));
        box.addView(frame, new FrameLayout.LayoutParams(-2, -2, Gravity.CENTER_HORIZONTAL));
        loading = Ui.text(a, "Loading the captcha…", 13, Ui.G700);
        loading.setGravity(Gravity.CENTER);
        loading.setPadding(0, Ui.dp(28), 0, Ui.dp(28));
        box.addView(loading, new FrameLayout.LayoutParams(-1, -2, Gravity.CENTER));
        full.addView(box, Ui.fill());
        solver = Ui.text(a, "", 13, Ui.AMBER);
        solver.setVisibility(View.GONE);
        full.addView(solver, Ui.margins(Ui.fill(), 0, 8, 0, 0));
        dontJoin = Ui.button(a, "Don't join", false, v -> cancel());
        full.addView(dontJoin, Ui.margins(Ui.wrap(), 0, 10, 0, 0));
        view.addView(full, Ui.fill());

        goneLine = Ui.text(a, "This captcha isn't waiting any more.", 13, Ui.G700);
        goneLine.setVisibility(View.GONE);
        view.addView(goneLine, Ui.fill());

        Object[] was;
        synchronized (last) { was = last.get(key()); }
        if (was != null) show((JSONObject) was[0], (Bitmap) was[1]);

        view.addOnAttachStateChangeListener(new View.OnAttachStateChangeListener() {
            @Override public void onViewAttachedToWindow(View v) { attached = true; Ui.main.removeCallbacks(tick); Ui.main.post(tick); }
            @Override public void onViewDetachedFromWindow(View v) { attached = false; Ui.main.removeCallbacks(tick); }
        });
    }

    private String key() { return hub.id + "|" + chat + "|" + id; }

    // ---- frames ----

    /** On screen: shown, partly inside the transcript's scroll, and the chat in front. */
    private boolean onScreen() {
        Rect r = new Rect();
        return front.now() && view.isShown() && view.getGlobalVisibleRect(r);
    }

    private void tick() {
        if (!attached || busy) return;
        if (!onScreen()) { Ui.main.postDelayed(tick, 1000); return; }
        busy = true;
        long t0 = System.currentTimeMillis();
        int w = frame.getWidth() > 0 ? frame.getWidth() : view.getWidth() > 0 ? view.getWidth() - Ui.dp(28) : a.getResources().getDisplayMetrics().widthPixels - Ui.dp(68);
        int max = Math.max(320, Math.min(1280, w));
        Ui.pool.execute(() -> {
            JSONObject r = null;
            int code = 0;
            try {
                r = hub.call("POST", "/v1/chats/" + chat + "/captcha", new JSONObject().put("action", "frame").put("max", max), 10_000);
            } catch (Hub.ApiError e) {
                code = e.code;
            } catch (Exception e) {
                code = -1;
            }
            Bitmap b = r == null ? null : DiscordCaptcha.decode(r.optString("data", ""));
            JSONObject got = r;
            int fc = code;
            Ui.main.post(() -> {
                busy = false;
                if (got != null) {
                    Object[] keep;
                    synchronized (last) {
                        Object[] was = last.get(key());
                        keep = new Object[] { got, b != null ? b : was == null ? null : was[1] };
                        last.put(key(), keep);
                    }
                    if (!a.isDestroyed()) show(got, (Bitmap) keep[1]);
                } else if (fc == 404) {
                    gone();
                }
                if (!attached) return;
                long wait = got != null ? Math.max(0, 500 - (System.currentTimeMillis() - t0)) : 2000;
                Ui.main.postDelayed(tick, wait);
            });
        });
    }

    private static int[] box(JSONObject o) {
        return o == null ? null : new int[] { o.optInt("x"), o.optInt("y"), o.optInt("width"), o.optInt("height") };
    }

    private void show(JSONObject r, Bitmap b) {
        full.setVisibility(View.VISIBLE);
        goneLine.setVisibility(View.GONE);
        if (r.has("guild")) sub.setText(DiscordKit.cardIntro(r.isNull("guild") ? "" : r.optString("guild")));
        int iw = r.optInt("width"), ih = r.optInt("height");
        int[] crop = box(r.optJSONObject("crop"));
        if (crop == null && iw > 0 && ih > 0) crop = new int[] { 0, 0, iw, ih };
        frame.set(iw, ih, crop, box(r.optJSONObject("rect")), b);
        if (frame.bmp != null) loading.setVisibility(View.GONE);
        solver(r.optJSONObject("solver"));
    }

    /** Someone else solving it (another phone, a PC): said under the frame. */
    private void solver(JSONObject s) {
        String who = s == null ? "" : s.optString("who");
        String label = s == null ? "" : s.optString("label");
        boolean other = s != null && !who.equals(me());
        solver.setText("Being solved on " + (label.isEmpty() ? "another device" : label));
        solver.setVisibility(other ? View.VISIBLE : View.GONE);
    }

    private void gone() {
        full.setVisibility(View.GONE);
        goneLine.setVisibility(View.VISIBLE);
    }

    private void cancel() {
        dontJoin.setEnabled(false);
        dontJoin.setAlpha(0.5f);
        Ui.pool.execute(() -> {
            String err = null;
            try {
                hub.call("POST", "/v1/chats/" + chat + "/captcha", new JSONObject().put("action", "cancel").put("who", who()));
            } catch (Exception e) {
                err = Hub.why(e);
            }
            String fe = err;
            // Done: the outcome comes as the chat's next notice, which takes this card's place.
            Ui.main.post(() -> {
                if (a.isFinishing() || a.isDestroyed()) return;
                dontJoin.setEnabled(true);
                dontJoin.setAlpha(1f);
                if (fe != null) Ui.toast(a, fe);
            });
        });
    }

    // ---- who taps ----

    private static volatile String who;

    /** This phone, as the PC tells solvers apart: "phone:" and its key's fingerprint (stable
     *  until the app is reinstalled). Reads the Keystore: off the UI thread. */
    static String who() {
        String w = who;
        if (w != null) return w;
        String fp = Net.myFp().replace(":", "");
        if (fp.isEmpty() && Ui.app != null) {
            android.content.SharedPreferences p = Ui.prefs(Ui.app);
            fp = p.getString("solver_id", "");
            if (fp.isEmpty()) { fp = java.util.UUID.randomUUID().toString(); p.edit().putString("solver_id", fp).apply(); }
        }
        who = w = "phone:" + (fp.length() > 16 ? fp.substring(0, 16) : fp);
        return w;
    }

    /** who() when it's known already ("" before the first tap or cancel on this phone). */
    private static String me() {
        String w = who;
        return w == null ? "" : w;
    }

    static {
        Ui.pool.execute(CaptchaCard::who);
    }

    // ---- taps ----

    private boolean touch(MotionEvent e) {
        if (frame.crop == null || frame.getWidth() <= 0) return true;
        int[] p = DiscordKit.cropToPage(e.getX(), e.getY(), frame.getWidth(), frame.getHeight(), frame.crop);
        switch (e.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                if (DiscordKit.inside(p[0], p[1], frame.rect)) {
                    pressed = true;
                    // A drag on the captcha (a slider) is the captcha's, not the transcript's.
                    frame.getParent().requestDisallowInterceptTouchEvent(true);
                    send("down", p);
                }
                return true;
            case MotionEvent.ACTION_MOVE:
                if (pressed) move(clamp(p));
                return true;
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL:
                // A press always ends, even off the captcha: at its edge, where the PC takes it.
                if (pressed) {
                    pressed = false;
                    send("up", clamp(p));
                }
                return true;
            default:
                return true;
        }
    }

    private int[] clamp(int[] p) {
        int[] r = frame.rect;
        if (r == null || r[2] <= 0 || r[3] <= 0) return p;
        return new int[] { Math.max(r[0], Math.min(r[0] + r[2] - 1, p[0])), Math.max(r[1], Math.min(r[1] + r[3] - 1, p[1])) };
    }

    private void send(String kind, int[] p) {
        INPUT.execute(() -> post(kind, p));
    }

    /** The newest point only: one move queued at most, behind the presses before it. */
    private void move(int[] p) {
        if (nextMove.getAndSet(p) != null) return;
        INPUT.execute(() -> {
            int[] m = nextMove.getAndSet(null);
            if (m != null) post("move", m);
        });
    }

    private void post(String kind, int[] p) {
        try {
            JSONObject r = hub.call("POST", "/v1/chats/" + chat + "/captcha", new JSONObject().put("action", "input").put("kind", kind)
                    .put("x", p[0]).put("y", p[1]).put("who", who()).put("label", Hub.deviceName()));
            if (r.has("taken")) {
                JSONObject s = r.optJSONObject("solver");
                boolean taken = r.optBoolean("taken");
                Ui.main.post(() -> solver(taken ? null : s));
            }
        } catch (Exception ignored) { /* the next frame shows what the page made of it */ }
    }

    // ---- the frame ----

    /** The frame (an image of the page's `crop`) as wide as the card, its shape kept; outside
     *  the captcha 35% black. Swipes on it stay its own (no drawer). */
    static final class Frame extends View {
        int iw, ih;
        int[] crop, rect;
        Bitmap bmp;
        private final Paint img = new Paint(Paint.FILTER_BITMAP_FLAG);
        private final Paint dim = new Paint();
        private final Rect dst = new Rect();

        Frame(Context c) {
            super(c);
            dim.setColor(0x59000000);
        }

        void set(int w, int h, int[] cr, int[] r, Bitmap b) {
            boolean resize = w != iw || h != ih || (bmp == null && b != null);
            iw = w;
            ih = h;
            crop = cr;
            rect = r;
            if (b != null) bmp = b;
            if (resize) requestLayout();
            invalidate();
        }

        @Override
        public boolean canScrollHorizontally(int direction) {
            return bmp != null; // Base's drawer swipe leaves a drag on the captcha alone
        }

        @Override
        protected void onMeasure(int ws, int hs) {
            int maxW = MeasureSpec.getSize(ws);
            if (bmp == null || iw <= 0 || ih <= 0) { setMeasuredDimension(maxW, 0); return; }
            int[] f = DiscordKit.fit(maxW, 0, iw, ih);
            setMeasuredDimension(f[0], f[1]);
        }

        @Override
        protected void onDraw(Canvas c) {
            if (bmp == null) return;
            int w = getWidth(), h = getHeight();
            dst.set(0, 0, w, h);
            c.drawBitmap(bmp, null, dst, img);
            float[] v = DiscordKit.pageToView(rect, crop, w, h);
            if (v == null) { c.drawRect(0, 0, w, h, dim); return; }
            float l = Math.max(0, v[0]), t = Math.max(0, v[1]), r = Math.min(w, v[2]), b = Math.min(h, v[3]);
            c.drawRect(0, 0, w, t, dim);
            c.drawRect(0, b, w, h, dim);
            c.drawRect(0, t, l, b, dim);
            c.drawRect(r, t, w, b, dim);
        }
    }
}
