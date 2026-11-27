package dev.harbor.app;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Outline;
import android.graphics.Paint;
import android.graphics.Rect;
import android.util.LruCache;
import android.view.View;
import android.view.ViewOutlineProvider;
import android.widget.ImageView;

import java.io.File;
import java.io.FileOutputStream;
import java.lang.ref.WeakReference;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.LinkedBlockingDeque;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** Pictures for long lists (Collector's leads): loaded only for the views on screen, newest request first, each
 *  decoded and scaled to the size it is drawn at (centre-cropped), kept in memory (an eighth of the app's heap) and on
 *  disk (the app's cache, ~60 MB, oldest dropped first). A view that was recycled for another row before its picture
 *  came never gets the old one, and a request whose view moved on is dropped before it downloads. */
final class Thumbs {
    private Thumbs() {}

    private static final LruCache<String, Bitmap> mem = new LruCache<String, Bitmap>((int) Math.min(Runtime.getRuntime().maxMemory() / 8, 48L << 20)) {
        @Override protected int sizeOf(String k, Bitmap b) { return b.getByteCount(); }
    };
    /** Paths that had no picture lately (404): not asked again for a while. */
    private static final Map<String, Long> none = new HashMap<>();
    private static final long NONE_MS = 5 * 60_000;
    private static final long DISK_MAX = 60L << 20;
    private static boolean trimmed;

    /** Three downloads at once, the newest request first (the rows just scrolled to). */
    private static final ThreadPoolExecutor io = new ThreadPoolExecutor(3, 3, 30, TimeUnit.SECONDS, new LinkedBlockingDeque<Runnable>() {
        @Override public boolean offer(Runnable r) { return offerFirst(r); }
    });
    static { io.allowCoreThreadTimeOut(true); }

    /** Round (an avatar). */
    static final ViewOutlineProvider OVAL = new ViewOutlineProvider() {
        @Override public void getOutline(View v, Outline o) { o.setOval(0, 0, v.getWidth(), v.getHeight()); }
    };

    /** The picture at `path` (on the PC) into `iv`, scaled and cropped to w x h pixels; nothing while it comes (the
     *  view's own background shows). Cheap to call again with the same picture (a list's rebind). */
    static void load(Activity a, Hub hub, String path, ImageView iv, int w, int h) {
        if (path == null || path.isEmpty() || hub == null || w <= 0 || h <= 0) { iv.setTag(null); iv.setImageDrawable(null); return; }
        final String key = path + "@" + w + "x" + h;
        if (key.equals(iv.getTag()) && iv.getDrawable() != null) return;
        iv.setTag(key);
        Bitmap b = mem.get(key);
        if (b != null) { iv.setImageBitmap(b); return; }
        iv.setImageDrawable(null);
        synchronized (none) {
            Long at = none.get(path);
            if (at != null && System.currentTimeMillis() - at < NONE_MS) return;
        }
        final WeakReference<ImageView> ref = new WeakReference<>(iv);
        final File dir = new File(a.getCacheDir(), "thumbs");
        io.execute(() -> {
            ImageView v = ref.get();
            // Scrolled away (the view shows another row now) or the screen is gone: not wanted any more.
            if (v == null || !key.equals(v.getTag()) || a.isDestroyed()) return;
            Bitmap got = mem.get(key);
            File f = new File(dir, sha1(key) + ".jpg");
            try {
                if (got == null && f.isFile()) {
                    got = BitmapFactory.decodeFile(f.getPath());
                    if (got != null) f.setLastModified(System.currentTimeMillis());
                }
                if (got == null) {
                    byte[] d = PersonsUi.bytes(hub, path);
                    got = scaled(d, w, h);
                    if (got != null) save(dir, f, got);
                }
            } catch (Hub.ApiError e) {
                if (e.code == 404) synchronized (none) { none.put(path, System.currentTimeMillis()); }
            } catch (Exception | OutOfMemoryError ignored) { }
            if (got == null) return;
            mem.put(key, got);
            final Bitmap fin = got;
            Ui.main.post(() -> {
                ImageView v2 = ref.get();
                if (v2 != null && key.equals(v2.getTag())) v2.setImageBitmap(fin);
            });
        });
    }

    /** Decoded at the smallest power-of-two step that still covers w x h, then centre-cropped to exactly w x h. */
    static Bitmap scaled(byte[] d, int w, int h) {
        if (d == null || d.length == 0) return null;
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(d, 0, d.length, o);
        if (o.outWidth <= 0 || o.outHeight <= 0) return null;
        int s = 1;
        while (o.outWidth / (s * 2) >= w && o.outHeight / (s * 2) >= h) s *= 2;
        BitmapFactory.Options r = new BitmapFactory.Options();
        r.inSampleSize = s;
        Bitmap src = BitmapFactory.decodeByteArray(d, 0, d.length, r);
        if (src == null) return null;
        int sw = src.getWidth(), sh = src.getHeight();
        if (sw == w && sh == h) return src;
        // The part of the source with the target's shape, from its centre.
        float k = Math.max((float) w / sw, (float) h / sh);
        int cw = Math.round(w / k), ch = Math.round(h / k);
        int cx = (sw - cw) / 2, cy = (sh - ch) / 2;
        Bitmap out = Bitmap.createBitmap(w, h, src.hasAlpha() ? Bitmap.Config.ARGB_8888 : Bitmap.Config.RGB_565);
        new Canvas(out).drawBitmap(src, new Rect(cx, cy, cx + cw, cy + ch), new Rect(0, 0, w, h), new Paint(Paint.FILTER_BITMAP_FLAG));
        src.recycle();
        return out;
    }

    private static void save(File dir, File f, Bitmap b) {
        try {
            if (!dir.isDirectory() && !dir.mkdirs()) return;
            File tmp = new File(dir, f.getName() + ".tmp");
            try (FileOutputStream out = new FileOutputStream(tmp)) { b.compress(Bitmap.CompressFormat.JPEG, 88, out); }
            if (!tmp.renameTo(f)) tmp.delete();
            trim(dir);
        } catch (Exception ignored) { }
    }

    /** Once a run: the disk cache back under DISK_MAX, the least recently used first. */
    private static synchronized void trim(File dir) {
        if (trimmed) return;
        trimmed = true;
        File[] fs = dir.listFiles();
        if (fs == null) return;
        long total = 0;
        for (File x : fs) total += x.length();
        if (total <= DISK_MAX) return;
        java.util.Arrays.sort(fs, (x, y) -> Long.compare(x.lastModified(), y.lastModified()));
        for (File x : fs) {
            if (total <= DISK_MAX * 3 / 4) break;
            total -= x.length();
            x.delete();
        }
    }

    private static String sha1(String s) {
        try {
            byte[] h = MessageDigest.getInstance("SHA-1").digest(s.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder b = new StringBuilder();
            for (int i = 0; i < 12; i++) b.append(String.format("%02x", h[i]));
            return b.toString();
        } catch (Exception e) {
            return Integer.toHexString(s.hashCode());
        }
    }
}
