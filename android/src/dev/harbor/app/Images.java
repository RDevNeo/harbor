package dev.harbor.app;

import android.app.Activity;
import android.app.Dialog;
import android.content.ContentResolver;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.graphics.RectF;
import android.graphics.drawable.Drawable;
import android.net.Uri;
import android.os.Build;
import android.util.LruCache;
import android.view.GestureDetector;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.ScaleGestureDetector;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/** Images in a chat: thumbnails the hub serves (/v1/image?…&max=512, with the token) in the
 *  strip under a user message, a reply or a tool, like the desktop's; thumbnails of what the
 *  composer is about to send (a local file); and the full-screen viewer a tap opens (pinch or
 *  double-tap to zoom, swipe or the side buttons to the previous or next one, Back to close). */
final class Images {
    /** A screen that picks what the viewer browses from card {@code seq} (a chat: the images of
     *  that card's turn, in order), whichever of them it opened on. */
    interface Gallery { List<Src> gallery(int seq); }
    private static final LruCache<String, Bitmap> cache = new LruCache<String, Bitmap>(24 << 20) {
        @Override protected int sizeOf(String k, Bitmap b) { return b.getByteCount(); }
    };
    private static final int MAX_BYTES = 12 << 20;
    /** The viewer's size: the hub scales to this, local files are decoded to it. */
    private static final int BIG = 2048;

    /** One image: on the hub (an /v1/image URL) or on this phone (a content Uri). */
    static final class Src {
        final Hub hub; final String url; final Uri uri; final String name;
        Src(Hub hub, String url, String name) { this.hub = hub; this.url = url; this.uri = null; this.name = name; }
        Src(Uri uri, String name) { this.hub = null; this.url = null; this.uri = uri; this.name = name; }
        String key(int px) { return hub != null ? hub.id + sized(url, px) : uri + "@" + px; }
        boolean same(Src o) { return hub != null ? o.hub == hub && url.equals(o.url) : uri.equals(o.uri); }
    }

    /** url with its max= set to px. */
    static String sized(String url, int px) { return url.replaceAll("([?&])max=\\d+", "$1max=" + px); }

    /** A sideways strip of images [{name,url}], or null when there are none. */
    static View strip(Activity a, Hub hub, JSONArray images, float size, int seq) {
        if (images == null || images.length() == 0) return null;
        List<Src> all = new ArrayList<>();
        for (int i = 0; i < images.length(); i++) {
            JSONObject im = images.optJSONObject(i);
            if (im != null && !im.optString("url").isEmpty()) all.add(new Src(hub, im.optString("url"), im.optString("name")));
        }
        if (all.isEmpty()) return null;
        HorizontalScrollView h = new HorizontalScrollView(a);
        h.setHorizontalScrollBarEnabled(false);
        LinearLayout row = Ui.row(a);
        for (int i = 0; i < all.size(); i++) {
            Src s = all.get(i);
            ImageView iv = tile(a, s.name);
            // An image that doesn't come (the PC that has it is off, a relay can't reach it):
            // a tile that says so, and a tap asks again.
            FrameLayout f = new FrameLayout(a);
            f.addView(iv, new FrameLayout.LayoutParams(-1, -1));
            LinearLayout miss = Ui.col(a);
            miss.setGravity(Gravity.CENTER);
            miss.addView(Ui.icon(a, Ui.I_IMAGE, 20, Ui.G600));
            miss.addView(Ui.text(a, "Tap to retry", 11, Ui.G600), Ui.margins(Ui.wrap(), 0, 4, 0, 0));
            miss.setVisibility(View.GONE);
            f.addView(miss, new FrameLayout.LayoutParams(-1, -1));
            LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(Ui.dp(size), Ui.dp(size));
            if (i > 0) p.leftMargin = Ui.dp(8);
            row.addView(f, p);
            Runnable failed = () -> { miss.setVisibility(View.VISIBLE); iv.setContentDescription(s.name + ": didn't load, tap to retry"); };
            load(a, hub, s.url, iv, failed);
            int at = i;
            iv.setOnClickListener(v -> {
                if (miss.getVisibility() == View.VISIBLE) {
                    miss.setVisibility(View.GONE);
                    iv.setContentDescription(s.name);
                    load(a, hub, s.url, iv, failed);
                } else open(a, seq, all, at);
            });
        }
        h.addView(row);
        return h;
    }

    /** A rounded, centre-cropped image view. */
    static ImageView tile(Context c, String name) {
        ImageView iv = new ImageView(c);
        iv.setScaleType(ImageView.ScaleType.CENTER_CROP);
        iv.setBackground(Ui.round(Ui.G100, 0, 12));
        iv.setClipToOutline(true);
        iv.setContentDescription(name);
        return iv;
    }

    static void load(Activity a, Hub hub, String url, ImageView into) { load(a, hub, url, into, null); }

    /** Loads into the view; `failed` (on the UI thread) when the image can't be had. */
    static void load(Activity a, Hub hub, String url, ImageView into, Runnable failed) {
        if (url == null || url.isEmpty()) return;
        Bitmap b = cache.get(hub.id + url);
        if (b != null) { into.setImageBitmap(b); return; }
        into.setTag(url);
        Ui.pool.execute(() -> {
            Bitmap got = fetch(hub, url);
            if (got == null) {
                if (failed != null) Ui.main.post(() -> { if (url.equals(into.getTag()) && !a.isDestroyed()) failed.run(); });
                return;
            }
            cache.put(hub.id + url, got);
            Ui.main.post(() -> { if (url.equals(into.getTag()) && !a.isDestroyed()) into.setImageBitmap(got); });
        });
    }

    /** A file on this phone, decoded to at most px on its longer side. */
    static void local(Activity a, Uri uri, int px, ImageView into) {
        String key = uri + "@" + px;
        Bitmap b = cache.get(key);
        if (b != null) { into.setImageBitmap(b); return; }
        into.setTag(key);
        Ui.pool.execute(() -> {
            Bitmap got = decode(a.getContentResolver(), uri, px);
            if (got == null) return;
            cache.put(key, got);
            Ui.main.post(() -> { if (key.equals(into.getTag()) && !a.isDestroyed()) into.setImageBitmap(got); });
        });
    }

    private static Bitmap fetch(Hub hub, String url) {
        Net.Http c = null;
        try {
            c = hub.open("GET", url, 20_000);
            if (c.code() != 200) return null;
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[1 << 15];
            try (InputStream in = c.in()) {
                for (int n; (n = in.read(buf)) > 0; ) {
                    out.write(buf, 0, n);
                    if (out.size() > MAX_BYTES) return null;
                }
            }
            byte[] d = out.toByteArray();
            return BitmapFactory.decodeByteArray(d, 0, d.length);
        } catch (IOException | RuntimeException e) {
            return null;
        } finally {
            if (c != null) c.close();
        }
    }

    /** Decodes a local image at most px on its longer side (turned upright, on Android 9+). */
    static Bitmap decode(ContentResolver cr, Uri uri, int px) {
        try {
            if (Build.VERSION.SDK_INT >= 28) {
                return android.graphics.ImageDecoder.decodeBitmap(android.graphics.ImageDecoder.createSource(cr, uri), (d, info, src) -> {
                    int w = info.getSize().getWidth(), h = info.getSize().getHeight(), m = Math.max(w, h);
                    if (m > px) d.setTargetSize(Math.max(1, w * px / m), Math.max(1, h * px / m));
                    d.setAllocator(android.graphics.ImageDecoder.ALLOCATOR_SOFTWARE);
                });
            }
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inJustDecodeBounds = true;
            try (InputStream in = cr.openInputStream(uri)) { BitmapFactory.decodeStream(in, null, o); }
            int s = 1;
            while (Math.max(o.outWidth, o.outHeight) / (s * 2) >= px) s *= 2;
            BitmapFactory.Options d = new BitmapFactory.Options();
            d.inSampleSize = s;
            try (InputStream in = cr.openInputStream(uri)) { return BitmapFactory.decodeStream(in, null, d); }
        } catch (Exception | OutOfMemoryError e) {
            return null;
        }
    }

    // ---- the viewer ----

    /** A tap on group[at] (images of card {@code seq}): the viewer on the screen's gallery of
     *  that card when it has this one in it, else on the group. */
    static void open(Activity a, int seq, List<Src> group, int at) {
        if (a instanceof Gallery) {
            List<Src> all = ((Gallery) a).gallery(seq);
            for (int i = 0; i < all.size(); i++) {
                if (all.get(i).same(group.get(at))) { view(a, all, i); return; }
            }
        }
        view(a, group, at);
    }

    /** Full screen over everything, starting at all[at]. */
    static void view(Activity a, List<Src> all, int at) {
        // Not a fullscreen theme: that keeps the window out of a camera cutout, and the page
        // showed above it. Black bars with light icons instead.
        Dialog d = new Dialog(a, android.R.style.Theme_Black_NoTitleBar);
        android.view.Window win = d.getWindow();
        if (win != null) {
            win.setStatusBarColor(0xff000000);
            win.setNavigationBarColor(0xff000000);
            win.getDecorView().setSystemUiVisibility(0);
        }
        FrameLayout f = new FrameLayout(a);
        f.setBackgroundColor(0xff000000);
        Zoom z = new Zoom(a);
        f.addView(z, new FrameLayout.LayoutParams(-1, -1));
        LinearLayout bar = Ui.row(a);
        bar.setPadding(Ui.dp(6), Ui.dp(6), Ui.dp(16), Ui.dp(6));
        bar.setBackgroundColor(0x66000000);
        TextView close = Ui.iconButton(a, Ui.I_X, 0xffffffff, v -> d.dismiss());
        close.setBackground(null);
        close.setContentDescription("Close");
        bar.addView(close);
        TextView name = Ui.subtitle(Ui.text(a, "", 15, 0xffffffff));
        bar.addView(name, Ui.margins(Ui.weight(), 6, 0, 0, 0));
        TextView count = Ui.text(a, "", 14, 0xccffffff);
        bar.addView(count);
        f.addView(bar, new FrameLayout.LayoutParams(-1, -2, Gravity.TOP));
        int[] i = {at};
        boolean[] chrome = {true}; // the bar and the side buttons; a tap on the image hides them
        View[] sides = new View[2];
        Runnable show = () -> {
            Src s = all.get(i[0]);
            name.setText(s.name);
            count.setText(all.size() > 1 ? (i[0] + 1) + " / " + all.size() : "");
            bar.setVisibility(chrome[0] ? View.VISIBLE : View.GONE);
            // A side's button only while there's an image that way.
            sides[0].setVisibility(chrome[0] && i[0] > 0 ? View.VISIBLE : View.GONE);
            sides[1].setVisibility(chrome[0] && i[0] < all.size() - 1 ? View.VISIBLE : View.GONE);
        };
        Zoom.Swipe go = new Zoom.Swipe() {
            @Override public boolean can(int dir) { int n = i[0] + dir; return n >= 0 && n < all.size(); }
            @Override public void to(int dir) {
                if (!can(dir)) return;
                i[0] += dir;
                show.run();
                big(a, all.get(i[0]), z);
                z.setAlpha(0.4f);
                z.animate().alpha(1).setDuration(160).start();
            }
        };
        for (int k = 0; k < 2; k++) {
            int dir = k == 0 ? -1 : 1;
            FrameLayout b = Ui.roundButton(a, k == 0 ? Ui.I_CHEV_LEFT : Ui.I_CHEV_RIGHT, 0x66000000, 0xffffffff, 44, v -> go.to(dir));
            b.setContentDescription(k == 0 ? "Previous image" : "Next image");
            FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(Ui.dp(44), Ui.dp(44), (k == 0 ? Gravity.START : Gravity.END) | Gravity.CENTER_VERTICAL);
            lp.leftMargin = lp.rightMargin = Ui.dp(10);
            f.addView(b, lp);
            sides[k] = b;
        }
        z.onSwipe = go;
        z.onTap = () -> { chrome[0] = !chrome[0]; show.run(); };
        // A keyboard's ← → too (a tablet or a Chromebook).
        d.setOnKeyListener((x, code, e) -> {
            if (e.getAction() != android.view.KeyEvent.ACTION_DOWN) return false;
            if (code == android.view.KeyEvent.KEYCODE_DPAD_LEFT) { go.to(-1); return true; }
            if (code == android.view.KeyEvent.KEYCODE_DPAD_RIGHT) { go.to(1); return true; }
            return false;
        });
        d.setContentView(f);
        show.run();
        big(a, all.get(i[0]), z);
        d.show();
    }

    /** The thumbnail at once (if cached), then the big copy. */
    private static void big(Activity a, Src s, Zoom into) {
        String key = s.key(BIG);
        Bitmap b = cache.get(key);
        if (b == null) b = cache.get(s.hub != null ? s.hub.id + s.url : s.uri + "@" + Attach.THUMB);
        into.setTag(key);
        into.show(b);
        if (cache.get(key) != null) return;
        Ui.pool.execute(() -> {
            Bitmap got = s.hub != null ? fetch(s.hub, sized(s.url, BIG)) : decode(a.getContentResolver(), s.uri, BIG);
            if (got == null) return;
            // Too big for the cache: kept only by the viewer.
            if (got.getByteCount() < cache.maxSize() / 3) cache.put(key, got);
            Ui.main.post(() -> { if (key.equals(into.getTag()) && !a.isDestroyed()) into.show(got); });
        });
    }

    /** An image that fits the screen and zooms: pinch, double-tap, drag while zoomed; a swipe
     *  sideways at fit size goes to the previous or next one; a tap shows or hides the bar. */
    static final class Zoom extends ImageView {
        /** dir -1: the previous image, 1: the next one. */
        interface Swipe { boolean can(int dir); void to(int dir); }
        Swipe onSwipe;
        Runnable onTap;
        private final Matrix m = new Matrix();
        private float fit = 1; // the scale that fits the view
        private final ScaleGestureDetector pinch;
        private final GestureDetector gestures;
        private final int slop;
        // A sideways drag at fit size: the image follows the finger; let go far or fast enough
        // and the next image that way comes, else it springs back (past either end it only gives
        // a little). Two fingers or a zoomed image never swipe.
        private float downX, downY, dragX;
        private boolean dragging, multi;
        private int flung;

        Zoom(Context c) {
            super(c);
            setScaleType(ScaleType.MATRIX);
            slop = android.view.ViewConfiguration.get(c).getScaledTouchSlop();
            pinch = new ScaleGestureDetector(c, new ScaleGestureDetector.SimpleOnScaleGestureListener() {
                @Override public boolean onScale(ScaleGestureDetector g) {
                    zoomBy(g.getScaleFactor(), g.getFocusX(), g.getFocusY());
                    return true;
                }
            });
            gestures = new GestureDetector(c, new GestureDetector.SimpleOnGestureListener() {
                @Override public boolean onDown(MotionEvent e) { return true; }
                @Override public boolean onScroll(MotionEvent e1, MotionEvent e2, float dx, float dy) {
                    if (!zoomed() || pinch.isInProgress()) return false;
                    m.postTranslate(-dx, -dy);
                    apply();
                    return true;
                }
                @Override public boolean onFling(MotionEvent e1, MotionEvent e2, float vx, float vy) {
                    if (!dragging || Math.abs(vx) < 800 || Math.abs(vx) < 1.5f * Math.abs(vy)) return false;
                    flung = vx < 0 ? 1 : -1;
                    return true;
                }
                @Override public boolean onDoubleTap(MotionEvent e) {
                    if (zoomed()) fitIn(); else zoomBy(2.5f, e.getX(), e.getY());
                    return true;
                }
                @Override public boolean onSingleTapConfirmed(MotionEvent e) {
                    if (onTap != null) onTap.run();
                    return true;
                }
            });
        }

        void show(Bitmap b) {
            setImageBitmap(b);
            fitIn();
        }

        private float scale() {
            float[] v = new float[9];
            m.getValues(v);
            return v[Matrix.MSCALE_X];
        }

        private boolean zoomed() { return scale() > fit * 1.02f; }

        private void zoomBy(float f, float x, float y) {
            float s = scale(), to = Math.max(fit, Math.min(fit * 6, s * f));
            m.postScale(to / s, to / s, x, y);
            apply();
        }

        private void fitIn() {
            Drawable d = getDrawable();
            if (d == null || getWidth() == 0) return;
            int dw = d.getIntrinsicWidth(), dh = d.getIntrinsicHeight(), w = getWidth(), h = getHeight();
            fit = Math.min((float) w / dw, (float) h / dh);
            m.reset();
            m.postScale(fit, fit);
            m.postTranslate((w - dw * fit) / 2, (h - dh * fit) / 2);
            setImageMatrix(m);
        }

        /** Keeps the image on screen: centred where it is smaller than the view, edge to edge
         *  where it is larger. */
        private void apply() {
            Drawable d = getDrawable();
            if (d == null) return;
            RectF r = new RectF(0, 0, d.getIntrinsicWidth(), d.getIntrinsicHeight());
            m.mapRect(r);
            float dx = 0, dy = 0, w = getWidth(), h = getHeight();
            if (r.width() <= w) dx = (w - r.width()) / 2 - r.left;
            else if (r.left > 0) dx = -r.left;
            else if (r.right < w) dx = w - r.right;
            if (r.height() <= h) dy = (h - r.height()) / 2 - r.top;
            else if (r.top > 0) dy = -r.top;
            else if (r.bottom < h) dy = h - r.bottom;
            m.postTranslate(dx, dy);
            setImageMatrix(m);
        }

        @Override protected void onSizeChanged(int w, int h, int ow, int oh) {
            super.onSizeChanged(w, h, ow, oh);
            fitIn();
        }

        @Override public boolean onTouchEvent(MotionEvent e) {
            pinch.onTouchEvent(e);
            int act = e.getActionMasked();
            if (act == MotionEvent.ACTION_DOWN) {
                downX = e.getX();
                downY = e.getY();
                dragX = 0;
                dragging = multi = false;
                flung = 0;
            } else if (act == MotionEvent.ACTION_POINTER_DOWN) {
                multi = true;
                if (dragging) { dragging = false; fitIn(); }
            } else if (act == MotionEvent.ACTION_MOVE) {
                float dx = e.getX() - downX, dy = e.getY() - downY;
                if (!dragging && !multi && onSwipe != null && !zoomed() && Math.abs(dx) > slop && Math.abs(dx) > 1.5f * Math.abs(dy)) dragging = true;
                if (dragging) {
                    float to = onSwipe.can(dx < 0 ? 1 : -1) ? dx : dx / 3;
                    m.postTranslate(to - dragX, 0);
                    dragX = to;
                    setImageMatrix(m);
                }
            }
            // (Its fling, on the lift, comes before the lift is handled below.)
            gestures.onTouchEvent(e);
            if ((act == MotionEvent.ACTION_UP || act == MotionEvent.ACTION_CANCEL) && dragging) {
                dragging = false;
                int dir = flung != 0 ? flung : Math.abs(dragX) > getWidth() * 0.2f ? (dragX < 0 ? 1 : -1) : 0;
                if (act == MotionEvent.ACTION_UP && dir != 0 && onSwipe.can(dir)) onSwipe.to(dir);
                else fitIn();
            }
            return true;
        }
    }
}
