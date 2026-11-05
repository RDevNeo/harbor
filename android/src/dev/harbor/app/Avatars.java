package dev.harbor.app;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.BitmapShader;
import android.graphics.Canvas;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Shader;
import android.graphics.drawable.BitmapDrawable;
import android.util.LruCache;
import android.view.View;
import android.widget.TextView;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.Map;

/** People's photos (the account directory's `image`, Clerk's image URL): fetched once over HTTPS,
 *  kept in the app's cache folder by URL (a new photo is a new URL), drawn round in place of the
 *  initials. Without a photo, or until it's here, the initials stay. */
final class Avatars {
    private Avatars() { }

    private static final int MAX_BYTES = 4 << 20;
    private static final int KEEP_FILES = 200;
    private static final long RETRY_MS = 10 * 60_000;

    /** Decoded photos by URL (square, at most 256 px). */
    private static final LruCache<String, Bitmap> mem = new LruCache<>(48);
    /** URLs that failed lately: not asked again for a while. */
    private static final Map<String, Long> failed = new HashMap<>();

    /** Shows `url`'s photo, round, as `box`'s background and blanks `initials`, at once when it's
     *  cached, else once it's fetched. Nothing happens for an empty URL or one that can't load. */
    static void into(View box, TextView initials, String url) {
        if (url == null || url.isEmpty()) return;
        box.setTag(url);
        Bitmap b = mem.get(url);
        if (b != null) { set(box, initials, b); return; }
        Context c = box.getContext().getApplicationContext();
        Ui.pool.execute(() -> {
            Bitmap got = load(c, url);
            if (got == null) return;
            box.post(() -> { if (url.equals(box.getTag())) set(box, initials, got); });
        });
    }

    private static void set(View box, TextView initials, Bitmap b) {
        box.setBackground(new BitmapDrawable(box.getResources(), round(b)));
        initials.setText("");
    }

    /** The photo from memory, the cache folder or the network; null when it can't be had. */
    static Bitmap load(Context c, String url) {
        Bitmap b = mem.get(url);
        if (b != null) return b;
        File f = file(c, url);
        if (f.isFile()) {
            b = decode(f);
            if (b != null) { mem.put(url, b); return b; }
        }
        synchronized (failed) {
            Long at = failed.get(url);
            if (at != null && System.currentTimeMillis() - at < RETRY_MS) return null;
        }
        byte[] bytes = Rig.on() ? Rig.photo(url) : fetch(url);
        if (bytes == null) {
            synchronized (failed) { failed.put(url, System.currentTimeMillis()); }
            return null;
        }
        put(c, url, bytes);
        return mem.get(url);
    }

    /** Keeps these bytes as `url`'s photo (one just uploaded shows without a download). */
    static void put(Context c, String url, byte[] bytes) {
        File f = file(c, url);
        File dir = f.getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs()) return;
        File tmp = new File(f.getPath() + ".tmp");
        try (FileOutputStream o = new FileOutputStream(tmp)) {
            o.write(bytes);
        } catch (IOException e) {
            tmp.delete();
            return;
        }
        if (!tmp.renameTo(f)) { tmp.delete(); return; }
        Bitmap b = decode(f);
        if (b != null) mem.put(url, b);
        else f.delete();
        prune(dir);
    }

    /** Only HTTPS, at most 4 MB. */
    private static byte[] fetch(String url) {
        if (!url.startsWith("https://")) return null;
        HttpURLConnection h = null;
        try {
            h = (HttpURLConnection) new URL(url).openConnection();
            h.setConnectTimeout(15_000);
            h.setReadTimeout(20_000);
            if (h.getResponseCode() != 200) return null;
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            try (InputStream in = h.getInputStream()) {
                for (int n; (n = in.read(buf)) > 0; ) {
                    if (out.size() + n > MAX_BYTES) return null;
                    out.write(buf, 0, n);
                }
            }
            // A redirect may only end on HTTPS too.
            return h.getURL().getProtocol().equals("https") ? out.toByteArray() : null;
        } catch (IOException | RuntimeException e) {
            return null;
        } finally {
            if (h != null) h.disconnect();
        }
    }

    /** The image, center-cropped to a square of at most 256 px. */
    private static Bitmap decode(File f) {
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(f.getPath(), o);
        if (o.outWidth <= 0 || o.outHeight <= 0) return null;
        int side = Math.min(o.outWidth, o.outHeight), s = 1;
        while (side / (s * 2) >= 256) s *= 2;
        BitmapFactory.Options d = new BitmapFactory.Options();
        d.inSampleSize = s;
        Bitmap b = BitmapFactory.decodeFile(f.getPath(), d);
        return b == null ? null : square(b, 256);
    }

    /** `b` center-cropped to a square of at most `max` px. */
    static Bitmap square(Bitmap b, int max) {
        int side = Math.min(b.getWidth(), b.getHeight());
        int out = Math.min(side, max);
        Bitmap sq = Bitmap.createBitmap(out, out, Bitmap.Config.ARGB_8888);
        Canvas cv = new Canvas(sq);
        Matrix m = new Matrix();
        float k = out / (float) side;
        m.postTranslate(-(b.getWidth() - side) / 2f, -(b.getHeight() - side) / 2f);
        m.postScale(k, k);
        cv.drawBitmap(b, m, new Paint(Paint.FILTER_BITMAP_FLAG | Paint.ANTI_ALIAS_FLAG));
        return sq;
    }

    /** A square image clipped to a circle. */
    static Bitmap round(Bitmap sq) {
        int n = sq.getWidth();
        Bitmap out = Bitmap.createBitmap(n, n, Bitmap.Config.ARGB_8888);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
        p.setShader(new BitmapShader(sq, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP));
        new Canvas(out).drawCircle(n / 2f, n / 2f, n / 2f, p);
        return out;
    }

    private static File file(Context c, String url) {
        return new File(new File(c.getCacheDir(), "avatars"), sha1(url));
    }

    private static String sha1(String s) {
        try {
            return Account.hex(MessageDigest.getInstance("SHA-1").digest(s.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        } catch (Exception e) {
            return Integer.toHexString(s.hashCode());
        }
    }

    /** At most KEEP_FILES photos: the oldest go. */
    private static void prune(File dir) {
        File[] fs = dir == null ? null : dir.listFiles();
        if (fs == null || fs.length <= KEEP_FILES) return;
        java.util.Arrays.sort(fs, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
        for (int i = 0; i < fs.length - KEEP_FILES; i++) fs[i].delete();
    }

    /** A picked image as a photo to upload: center-cropped, 512 px, JPEG. */
    static byte[] forUpload(Context c, android.net.Uri uri) throws IOException {
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inJustDecodeBounds = true;
        try (InputStream in = c.getContentResolver().openInputStream(uri)) { BitmapFactory.decodeStream(in, null, o); }
        if (o.outWidth <= 0 || o.outHeight <= 0) throw new IOException("That isn't an image Harbor can read.");
        int side = Math.min(o.outWidth, o.outHeight), s = 1;
        while (side / (s * 2) >= 512) s *= 2;
        BitmapFactory.Options d = new BitmapFactory.Options();
        d.inSampleSize = s;
        Bitmap b;
        try (InputStream in = c.getContentResolver().openInputStream(uri)) { b = BitmapFactory.decodeStream(in, null, d); }
        if (b == null) throw new IOException("That isn't an image Harbor can read.");
        b = rotated(c, uri, b);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        square(b, 512).compress(Bitmap.CompressFormat.JPEG, 88, out);
        return out.toByteArray();
    }

    /** Upright, as the camera held it (EXIF orientation). */
    private static Bitmap rotated(Context c, android.net.Uri uri, Bitmap b) {
        int deg = 0;
        try (InputStream in = c.getContentResolver().openInputStream(uri)) {
            if (in != null) {
                int or = new android.media.ExifInterface(in).getAttributeInt(android.media.ExifInterface.TAG_ORIENTATION, 1);
                deg = or == 6 ? 90 : or == 3 ? 180 : or == 8 ? 270 : 0;
            }
        } catch (IOException | RuntimeException ignored) { }
        if (deg == 0) return b;
        Matrix m = new Matrix();
        m.postRotate(deg);
        return Bitmap.createBitmap(b, 0, 0, b.getWidth(), b.getHeight(), m, true);
    }
}
