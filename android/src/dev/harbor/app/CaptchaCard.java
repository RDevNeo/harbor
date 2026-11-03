package dev.harbor.app;

import android.app.Activity;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
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
 *  captcha notice without a later one of the same captcha. Frames: one call at a time that the PC
 *  answers as soon as the captcha repaints (a long-poll, `after` the last `seq`), at most about
 *  15 a second, only while the card is on screen and the chat in front; each JPEG is decoded on
 *  the network thread into a reused bitmap and only drawn on the UI thread (no layout per frame).
 *  Taps on the captcha go back to the page as presses on their own queue, never behind a frame.
 *  Someone else solving it: "Being solved on <label>". No captcha waiting (404): one line. */
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
    private boolean attached;
    private boolean pressed;
    private final AtomicReference<int[]> nextMove = new AtomicReference<>();

    // The frame loop: `gen` bumped stops it (a call in flight finishes, its answer is dropped).
    private volatile int gen;
    private boolean looping; // UI thread
    private final Runnable watch = this::watch;
    /** The card's width in pixels: the frame the PC sends (it never upscales past the crop). */
    private volatile int maxW;
    /** Bitmaps free to decode into: never the one drawn, nor the one drawn just before it (the
     *  render thread may still be reading it). */
    private final java.util.concurrent.ConcurrentLinkedQueue<Bitmap> free = new java.util.concurrent.ConcurrentLinkedQueue<>();
    private Bitmap shownBefore; // UI thread
    /** The newest answer not drawn yet ({answer, bitmap or null}); older ones are dropped. */
    private final Object lock = new Object();
    private Object[] pending;

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
        maxW = Math.max(320, a.getResources().getDisplayMetrics().widthPixels - Ui.dp(68));
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
        box.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> { if (r - l > 0) maxW = r - l; });
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
            @Override public void onViewAttachedToWindow(View v) {
                attached = true;
                Ui.main.removeCallbacks(watch);
                Ui.main.post(watch);
            }
            @Override public void onViewDetachedFromWindow(View v) {
                attached = false;
                Ui.main.removeCallbacks(watch);
                stop();
            }
        });
    }

    private String key() { return hub.id + "|" + chat + "|" + id; }

    // ---- frames ----

    /** On screen: shown, partly inside the transcript's scroll, and the chat in front. */
    private boolean onScreen() {
        Rect r = new Rect();
        return front.now() && view.isShown() && view.getGlobalVisibleRect(r);
    }

    /** Every 300 ms while attached: the loop runs exactly while the card is on screen. */
    private void watch() {
        if (!attached) return;
        boolean want = onScreen();
        if (want && !looping) {
            looping = true;
            int my = ++gen;
            Ui.pool.execute(() -> loop(my));
        } else if (!want && looping) {
            stop();
        }
        Ui.main.postDelayed(watch, 300);
    }

    private void stop() {
        looping = false;
        gen++;
    }

    /** The frame loop, on a pool thread: one call in flight, the next `after` the last `seq`. */
    private void loop(int my) {
        long after = 0;
        while (my == gen) {
            long t0 = android.os.SystemClock.uptimeMillis();
            JSONObject r;
            try {
                JSONObject body = new JSONObject().put("action", "frame").put("max", maxW).put("after", after).put("wait", DiscordKit.WAIT);
                r = hub.call("POST", "/v1/chats/" + chat + "/captcha", body, Hub.TIMEOUT);
            } catch (Exception e) {
                if (my != gen) return;
                if (e instanceof Hub.ApiError && ((Hub.ApiError) e).code == 404) Ui.main.post(() -> { if (my == gen) gone(); });
                pause(DiscordKit.BACKOFF);
                continue;
            }
            if (my != gen) return;
            boolean longPoll = r.has("seq");
            if (longPoll) after = r.optLong("seq");
            // The JPEG is decoded here, off the UI thread; a `same` answer has none.
            Bitmap b = r.optBoolean("same") ? null : decode(r.optString("data", ""));
            deliver(my, r, b);
            pause(DiscordKit.nextCall(longPoll, t0, android.os.SystemClock.uptimeMillis()));
        }
    }

    private static void pause(long ms) {
        if (ms <= 0) return;
        try { Thread.sleep(ms); } catch (InterruptedException ignored) { }
    }

    /** data into a bitmap of `free` when one fits, else a new one. */
    private Bitmap decode(String data) {
        byte[] jpeg = DiscordCaptcha.jpeg(data);
        if (jpeg == null) return null;
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inMutable = true;
        o.inBitmap = free.poll();
        try {
            return BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length, o);
        } catch (IllegalArgumentException e) {
            o.inBitmap = null; // too small for this frame
            try { return BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length, o); } catch (Exception x) { return null; }
        } catch (Exception e) {
            return null;
        }
    }

    /** Hands an answer to the UI thread; one not drawn yet is replaced (its bitmap kept when the
     *  newer one brings none). */
    private void deliver(int my, JSONObject r, Bitmap b) {
        boolean post;
        synchronized (lock) {
            post = pending == null;
            if (pending != null && pending[1] != null) {
                if (b == null) b = (Bitmap) pending[1];
                else free.offer((Bitmap) pending[1]); // never drawn
            }
            pending = new Object[] { r, b };
        }
        if (post) Ui.main.post(() -> draw(my));
    }

    private void draw(int my) {
        Object[] p;
        synchronized (lock) { p = pending; pending = null; }
        if (p == null) return;
        JSONObject r = (JSONObject) p[0];
        Bitmap b = (Bitmap) p[1];
        if (my != gen || a.isDestroyed()) {
            if (b != null) free.offer(b);
            return;
        }
        synchronized (last) {
            Object[] was = last.get(key());
            last.put(key(), new Object[] { r, b != null ? b : was == null ? null : was[1] });
        }
        Bitmap old = b != null ? frame.bmp : null;
        show(r, b);
        if (old != null && old != b) {
            // The one drawn before this one goes back to `free` a frame later.
            if (shownBefore != null) free.offer(shownBefore);
            shownBefore = old;
        }
    }

    private static int[] box(JSONObject o) {
        return o == null ? null : new int[] { o.optInt("x"), o.optInt("y"), o.optInt("width"), o.optInt("height") };
    }

    /** An answer on the card: only what changed is touched; a new bitmap is only drawn. */
    private void show(JSONObject r, Bitmap b) {
        if (full.getVisibility() != View.VISIBLE) full.setVisibility(View.VISIBLE);
        if (goneLine.getVisibility() != View.GONE) goneLine.setVisibility(View.GONE);
        if (r.has("guild")) setText(sub, DiscordKit.cardIntro(r.isNull("guild") ? "" : r.optString("guild")));
        int iw = r.optInt("width"), ih = r.optInt("height");
        int[] crop = box(r.optJSONObject("crop"));
        if (crop == null && iw > 0 && ih > 0) crop = new int[] { 0, 0, iw, ih };
        int[] rect = box(r.optJSONObject("rect"));
        if (iw > 0 && ih > 0) frame.set(iw, ih, crop, rect != null ? rect : frame.rect, b);
        else if (b != null) frame.set(frame.iw, frame.ih, frame.crop, frame.rect, b);
        if (frame.bmp != null && loading.getVisibility() != View.GONE) loading.setVisibility(View.GONE);
        if (r.has("solver")) solver(r.optJSONObject("solver"));
    }

    private static void setText(TextView t, String s) {
        if (!s.contentEquals(t.getText())) t.setText(s);
    }

    /** Someone else solving it (another phone, a PC): said under the frame. */
    private void solver(JSONObject s) {
        String who = s == null ? "" : s.optString("who");
        String label = s == null ? "" : s.optString("label");
        boolean other = s != null && !who.equals(me());
        if (other) setText(solver, "Being solved on " + (label.isEmpty() ? "another device" : label));
        int vis = other ? View.VISIBLE : View.GONE;
        if (solver.getVisibility() != vis) solver.setVisibility(vis);
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

        /** A frame: laid out again only for the first bitmap or a new shape, else only drawn. */
        void set(int w, int h, int[] cr, int[] r, Bitmap b) {
            boolean resize = DiscordKit.reshapes(iw, ih, w, h) || (bmp == null && b != null);
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
