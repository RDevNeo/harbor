package dev.harbor.app;

import android.app.Activity;
import android.app.Dialog;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.util.LruCache;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;

/** Thumbnails the hub serves (/v1/image?…&max=512, with the token): the strip under a user
 *  message, a reply or a tool, like the desktop's. Tap one for a bigger copy. */
final class Images {
    private static final LruCache<String, Bitmap> cache = new LruCache<String, Bitmap>(24 << 20) {
        @Override protected int sizeOf(String k, Bitmap b) { return b.getByteCount(); }
    };
    private static final int MAX_BYTES = 12 << 20;

    /** A sideways strip of images [{name,url}], or null when there are none. */
    static View strip(Activity a, Hub hub, JSONArray images, float size) {
        if (images == null || images.length() == 0) return null;
        HorizontalScrollView h = new HorizontalScrollView(a);
        h.setHorizontalScrollBarEnabled(false);
        LinearLayout row = Ui.row(a);
        for (int i = 0; i < images.length(); i++) {
            JSONObject im = images.optJSONObject(i);
            if (im == null) continue;
            ImageView iv = new ImageView(a);
            iv.setScaleType(ImageView.ScaleType.CENTER_CROP);
            iv.setBackground(Ui.round(Ui.G100, 0, 12));
            iv.setClipToOutline(true);
            iv.setContentDescription(im.optString("name"));
            LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(Ui.dp(size), Ui.dp(size));
            if (i > 0) p.leftMargin = Ui.dp(8);
            row.addView(iv, p);
            String url = im.optString("url");
            load(a, hub, url, iv);
            iv.setOnClickListener(v -> big(a, hub, url.replaceAll("([?&])max=\\d+", "$1max=2048")));
        }
        h.addView(row);
        return h;
    }

    static void load(Activity a, Hub hub, String url, ImageView into) {
        if (url == null || url.isEmpty()) return;
        Bitmap b = cache.get(hub.id + url);
        if (b != null) { into.setImageBitmap(b); return; }
        into.setTag(url);
        Ui.pool.execute(() -> {
            Bitmap got = fetch(hub, url);
            if (got == null) return;
            cache.put(hub.id + url, got);
            Ui.main.post(() -> { if (url.equals(into.getTag()) && !a.isDestroyed()) into.setImageBitmap(got); });
        });
    }

    private static Bitmap fetch(Hub hub, String url) {
        Tailnet.Http c = null;
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

    private static void big(Activity a, Hub hub, String url) {
        Dialog d = new Dialog(a);
        d.requestWindowFeature(Window.FEATURE_NO_TITLE);
        ImageView iv = new ImageView(a);
        iv.setAdjustViewBounds(true);
        iv.setScaleType(ImageView.ScaleType.FIT_CENTER);
        iv.setOnClickListener(v -> d.dismiss());
        d.setContentView(iv, new ViewGroup.LayoutParams(-1, -2));
        if (d.getWindow() != null) {
            d.getWindow().setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            d.getWindow().setLayout(-1, -2);
        }
        load(a, hub, url, iv);
        d.show();
    }
}
