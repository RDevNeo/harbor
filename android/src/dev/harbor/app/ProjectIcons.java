package dev.harbor.app;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.drawable.BitmapDrawable;
import android.util.Base64;
import android.util.LruCache;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.HashMap;
import java.util.Map;

/** Projects' icons as the desktop's sidebar shows them (their own, their website's): `/v1/state`
 *  names each project's by a hash, the picture comes once from `POST /v1/projects/icon` and is
 *  kept by that hash in memory and the cache folder (a new icon is a new hash). Until it's here,
 *  or without one, the project's letter stays. */
final class ProjectIcons {
    private ProjectIcons() { }

    private static final int KEEP_FILES = 200;
    private static final long RETRY_MS = 5 * 60_000;

    private static final LruCache<String, Bitmap> mem = new LruCache<>(64);
    /** Hashes that failed lately: not asked again for a while. */
    private static final Map<String, Long> failed = new HashMap<>();

    /** Draws project `project`'s icon `hash` in `tile` (its letter blanked), at once when it's at
     *  hand, else once it came from `hub`. Nothing happens for an empty hash. */
    static void into(TextView tile, Hub hub, String project, String hash) {
        if (hash == null || hash.isEmpty() || hub == null) return;
        tile.setTag(hash);
        Bitmap b = mem.get(hash);
        if (b != null) { set(tile, b); return; }
        Context c = tile.getContext().getApplicationContext();
        Ui.pool.execute(() -> {
            Bitmap got = load(c, hub, project, hash);
            if (got == null) return;
            tile.post(() -> { if (hash.equals(tile.getTag())) set(tile, got); });
        });
    }

    private static void set(TextView tile, Bitmap b) {
        BitmapDrawable d = new BitmapDrawable(tile.getResources(), b);
        d.setFilterBitmap(true);
        tile.setBackground(d);
        tile.setText("");
    }

    private static Bitmap load(Context c, Hub hub, String project, String hash) {
        Bitmap b = mem.get(hash);
        if (b != null) return b;
        File dir = new File(c.getCacheDir(), "project-icons");
        File f = new File(dir, hash.replaceAll("[^0-9a-f]", "") + ".png");
        if (f.isFile()) {
            b = BitmapFactory.decodeFile(f.getPath());
            if (b != null) { mem.put(hash, b); return b; }
        }
        synchronized (failed) {
            Long at = failed.get(hash);
            if (at != null && System.currentTimeMillis() - at < RETRY_MS) return null;
        }
        byte[] png = null;
        try {
            JSONObject r = hub.call("POST", "/v1/projects/icon", new JSONObject().put("project", project));
            png = Base64.decode(r.optString("png", ""), Base64.DEFAULT);
        } catch (Exception e) {
            png = null;
        }
        b = png == null || png.length == 0 ? null : BitmapFactory.decodeByteArray(png, 0, png.length);
        if (b == null) {
            synchronized (failed) { failed.put(hash, System.currentTimeMillis()); }
            return null;
        }
        mem.put(hash, b);
        if (dir.isDirectory() || dir.mkdirs()) {
            File tmp = new File(f.getPath() + ".tmp");
            try (FileOutputStream o = new FileOutputStream(tmp)) {
                o.write(png);
            } catch (IOException e) {
                tmp.delete();
            }
            if (!tmp.renameTo(f)) tmp.delete();
            prune(dir);
        }
        return b;
    }

    /** At most KEEP_FILES icons: the oldest go. */
    private static void prune(File dir) {
        File[] fs = dir.listFiles();
        if (fs == null || fs.length <= KEEP_FILES) return;
        java.util.Arrays.sort(fs, (x, y) -> Long.compare(x.lastModified(), y.lastModified()));
        for (int i = 0; i < fs.length - KEEP_FILES; i++) fs[i].delete();
    }
}
