package dev.harbor.app;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Rect;
import android.os.Bundle;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicReference;

/** A Discord captcha for a person to solve, the desktop's captcha overlay on the phone (hub
 *  `/v1/apps/discord/captcha`, android/PROTOCOL.md): the hidden Discord page's frames, about
 *  three a second, the page around the captcha dimmed; taps on the captcha go back to the page
 *  as presses (the PC drops anything outside it). "Don't join" gives up the join; Back only
 *  leaves the screen, and the captcha keeps waiting. Once no captcha waits, the screen closes
 *  and says how the join ended. Extras: `hub`, and `pc` (the PC the captcha is on; absent: the
 *  one calls go to now; when that one has none, the workspace's others are asked once). */
public class DiscordCaptcha extends Base {
    private volatile String pc;
    private Page view;
    private TextView intro, status, loading;
    private TextView dontJoin;
    /** Bumped on pause: stops the frame loop. */
    private int round;
    /** A captcha was on this screen (else a 404 first asks the other PCs). */
    private volatile boolean seen, probed;
    /** Presses go out in order, one at a time; moves only the newest. */
    private final ExecutorService input = Executors.newSingleThreadExecutor();
    private final AtomicReference<int[]> nextMove = new AtomicReference<>();
    private boolean pressed;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        if (noHub()) return;
        pc = getIntent().hasExtra("pc") ? getIntent().getStringExtra("pc") : hub.via();
        if (pc == null) pc = "";
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        LinearLayout root = frame("", true);
        ScrollView sv = new ScrollView(this);
        sv.setFillViewport(true);
        LinearLayout col = Ui.col(this);
        col.setPadding(Ui.dp(16), 0, Ui.dp(16), Ui.dp(24));
        sv.addView(col);
        root.addView(sv, new LinearLayout.LayoutParams(-1, 0, 1));

        col.addView(Ui.title(this, "Discord needs a captcha", 26), Ui.margins(Ui.fill(), 4, 0, 4, 8));
        intro = Ui.text(this, DiscordKit.intro(""), 15, Ui.G700);
        col.addView(intro, Ui.margins(Ui.fill(), 4, 0, 4, 16));

        FrameLayout box = new FrameLayout(this);
        view = new Page(this);
        view.setOnTouchListener((v, e) -> touch(e));
        box.addView(view, new FrameLayout.LayoutParams(-2, -2, Gravity.CENTER_HORIZONTAL));
        loading = Ui.text(this, "Loading the captcha…", 15, Ui.G700);
        loading.setGravity(Gravity.CENTER);
        loading.setPadding(0, Ui.dp(48), 0, Ui.dp(48));
        box.addView(loading, new FrameLayout.LayoutParams(-1, -2, Gravity.CENTER));
        col.addView(box, Ui.fill());

        status = Ui.text(this, "", 13, Ui.AMBER);
        status.setVisibility(View.GONE);
        col.addView(status, Ui.margins(Ui.fill(), 4, 10, 4, 0));

        dontJoin = Ui.button(this, "Don't join", false, v -> cancel());
        col.addView(dontJoin, Ui.margins(Ui.fill(), 0, 20, 0, 0));
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (hub == null) return;
        int my = ++round;
        Ui.pool.execute(() -> frames(my));
    }

    @Override
    protected void onPause() {
        super.onPause();
        round++;
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        round++;
        input.shutdown();
    }

    // ---- frames ----

    /** The loop: one request at a time, about every 300 ms, while the screen is in front. */
    private void frames(int my) {
        int fails = 0;
        while (my == round) {
            long t0 = System.currentTimeMillis();
            JSONObject r;
            try {
                r = hub.callOn(pc, "GET", "/v1/apps/discord/captcha", null);
                fails = 0;
            } catch (Hub.ApiError e) {
                if (e.code == 404) {
                    if (!seen && !probed) {
                        probed = true;
                        String other = elsewhere();
                        if (other != null) { pc = other; continue; }
                    }
                    end(my);
                    return;
                }
                problem(my, e.getMessage());
                fails++;
                pause(1500);
                continue;
            } catch (Exception e) {
                problem(my, Hub.why(e));
                fails++;
                pause(Math.min(5000, 1000L * fails));
                continue;
            }
            Bitmap bmp = decode(r.optString("data", ""));
            JSONObject got = r;
            Ui.main.post(() -> { if (my == round) show(got, bmp); });
            pause(300 - (System.currentTimeMillis() - t0));
        }
    }

    private static void pause(long ms) {
        if (ms <= 0) return;
        try { Thread.sleep(ms); } catch (InterruptedException ignored) { }
    }

    /** Another PC of the workspace with a captcha waiting (the note may have come through
     *  another PC of the mesh), or null. */
    private String elsewhere() {
        for (String v : hub.endpoints()) {
            if (v.equals(pc)) continue;
            try {
                hub.callOn(v, "GET", "/v1/apps/discord/captcha", null);
                return v;
            } catch (Exception ignored) { /* none there, or it doesn't answer */ }
        }
        return null;
    }

    /** A frame's `data` (base64 JPEG, maybe a data: URL) as a bitmap; null: none or unreadable. */
    static Bitmap decode(String data) {
        if (data == null || data.isEmpty()) return null;
        int comma = data.startsWith("data:") ? data.indexOf(',') : -1;
        try {
            byte[] b = android.util.Base64.decode(comma >= 0 ? data.substring(comma + 1) : data, android.util.Base64.DEFAULT);
            return BitmapFactory.decodeByteArray(b, 0, b.length);
        } catch (Exception e) {
            return null;
        }
    }

    private void show(JSONObject r, Bitmap bmp) {
        seen = true;
        status.setVisibility(View.GONE);
        intro.setText(DiscordKit.intro(r.optString("guild")));
        JSONObject rc = r.optJSONObject("rect");
        int[] rect = rc == null ? null : new int[] { rc.optInt("x"), rc.optInt("y"), rc.optInt("width"), rc.optInt("height") };
        view.set(r.optInt("width", 1280), r.optInt("height", 720), rect, bmp);
        if (view.bmp != null) loading.setVisibility(View.GONE);
    }

    private void problem(int my, String why) {
        Ui.main.post(() -> {
            if (my != round) return;
            status.setText(why);
            status.setVisibility(View.VISIBLE);
        });
    }

    /** No captcha waits any more: how it ended, then away. */
    private void end(int my) {
        String say;
        try {
            JSONObject d = hub.callOn(pc, "GET", "/v1/apps/discord", null);
            JSONObject e = d.optJSONObject("captcha_end");
            say = e == null ? null : DiscordKit.outcome(e.optString("outcome"), e.optString("guild"));
        } catch (Exception e) {
            say = null;
        }
        if (say == null && !seen) say = "No captcha is waiting.";
        String msg = say;
        Ui.main.post(() -> {
            if (my != round || isFinishing()) return;
            if (msg != null) Ui.toast(getApplicationContext(), msg);
            finish();
        });
    }

    private void cancel() {
        dontJoin.setEnabled(false);
        dontJoin.setAlpha(0.5f);
        Ui.pool.execute(() -> {
            String err = null;
            try {
                hub.callOn(pc, "POST", "/v1/apps/discord/captcha_cancel", new JSONObject());
            } catch (Exception e) {
                err = Hub.why(e);
            }
            String fe = err;
            // Done: the next frame finds no captcha, and the screen closes saying so.
            Ui.main.post(() -> {
                if (isFinishing() || isDestroyed()) return;
                dontJoin.setEnabled(true);
                dontJoin.setAlpha(1f);
                if (fe != null) Ui.toast(this, fe);
            });
        });
    }

    // ---- taps ----

    private boolean touch(MotionEvent e) {
        if (view.pw <= 0 || view.getWidth() <= 0) return true;
        int[] p = DiscordKit.toPage(e.getX(), e.getY(), view.getWidth(), view.getHeight(), view.pw, view.ph);
        switch (e.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                if (DiscordKit.inside(p[0], p[1], view.rect)) {
                    pressed = true;
                    // A drag on the captcha (a slider) is the captcha's, not a scroll.
                    view.getParent().requestDisallowInterceptTouchEvent(true);
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

    /** p moved onto the captcha's edge when it's off it. */
    private int[] clamp(int[] p) {
        int[] r = view.rect;
        if (r == null || r[2] <= 0 || r[3] <= 0) return p;
        return new int[] { Math.max(r[0], Math.min(r[0] + r[2] - 1, p[0])), Math.max(r[1], Math.min(r[1] + r[3] - 1, p[1])) };
    }

    private void send(String kind, int[] p) {
        try {
            input.execute(() -> post(kind, p));
        } catch (Exception ignored) { /* the screen is closing */ }
    }

    /** The newest point only: one move queued at most, behind the presses before it. */
    private void move(int[] p) {
        if (nextMove.getAndSet(p) != null) return;
        try {
            input.execute(() -> {
                int[] m = nextMove.getAndSet(null);
                if (m != null) post("move", m);
            });
        } catch (Exception ignored) { /* the screen is closing */ }
    }

    private void post(String kind, int[] p) {
        try {
            hub.callOn(pc, "POST", "/v1/apps/discord/captcha_input", new JSONObject().put("kind", kind).put("x", p[0]).put("y", p[1]));
        } catch (Exception ignored) { /* the next frame shows what the page made of it */ }
    }

    // ---- the page ----

    /** The page's frame, as wide as the screen allows with its shape kept; outside the captcha
     *  35% black. */
    static final class Page extends View {
        int pw, ph;
        int[] rect;
        Bitmap bmp;
        private final Paint img = new Paint(Paint.FILTER_BITMAP_FLAG);
        private final Paint dim = new Paint();
        private final Rect dst = new Rect();

        Page(Context c) {
            super(c);
            dim.setColor(0x59000000);
        }

        void set(int w, int h, int[] r, Bitmap b) {
            boolean resize = w != pw || h != ph || (bmp == null && b != null);
            pw = w;
            ph = h;
            rect = r;
            if (b != null) bmp = b;
            if (resize) requestLayout();
            invalidate();
        }

        @Override
        protected void onMeasure(int ws, int hs) {
            int maxW = MeasureSpec.getSize(ws);
            int maxH = MeasureSpec.getMode(hs) == MeasureSpec.UNSPECIFIED ? 0 : MeasureSpec.getSize(hs);
            if (bmp == null || pw <= 0 || ph <= 0) { setMeasuredDimension(maxW, 0); return; }
            int[] f = DiscordKit.fit(maxW, maxH, pw, ph);
            setMeasuredDimension(f[0], f[1]);
        }

        @Override
        protected void onDraw(Canvas c) {
            if (bmp == null) return;
            int w = getWidth(), h = getHeight();
            dst.set(0, 0, w, h);
            c.drawBitmap(bmp, null, dst, img);
            if (rect == null || pw <= 0 || ph <= 0) { c.drawRect(0, 0, w, h, dim); return; }
            float sx = (float) w / pw, sy = (float) h / ph;
            float l = rect[0] * sx, t = rect[1] * sy, r = (rect[0] + rect[2]) * sx, b = (rect[1] + rect[3]) * sy;
            c.drawRect(0, 0, w, t, dim);
            c.drawRect(0, b, w, h, dim);
            c.drawRect(0, t, l, b, dim);
            c.drawRect(r, t, w, b, dim);
        }
    }
}
