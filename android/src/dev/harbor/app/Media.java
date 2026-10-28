package dev.harbor.app;

import android.app.Activity;
import android.app.Dialog;
import android.net.Uri;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.MediaController;
import android.widget.TextView;
import android.widget.VideoView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/** Images and videos an agent showed in a reply (a card's `media`, PROTOCOL.md), like the
 *  desktop: an image large in the reply (tap: the full-screen viewer, pinch to zoom), a video
 *  as its poster with a play button; a tap downloads it from the PC (with the token, over the
 *  same pinned connection) and plays it full screen. What can't load says so; a tap retries. */
final class Media {
    /** Videos larger than this aren't downloaded (the hub caps them lower anyway). */
    private static final long MAX_VIDEO = 200L << 20;

    /** The media of a card, one under the other, or null when there are none. */
    static View list(Activity a, Hub hub, JSONArray media) {
        if (media == null || media.length() == 0) return null;
        LinearLayout col = Ui.col(a);
        List<Images.Src> gallery = new ArrayList<>();
        for (int i = 0; i < media.length(); i++) {
            JSONObject m = media.optJSONObject(i);
            if (m != null && "image".equals(m.optString("kind")) && !m.optString("url").isEmpty()) gallery.add(new Images.Src(hub, m.optString("url"), m.optString("name")));
        }
        for (int i = 0; i < media.length(); i++) {
            JSONObject m = media.optJSONObject(i);
            if (m == null || m.optString("url").isEmpty()) continue;
            View v = "video".equals(m.optString("kind")) ? video(a, hub, m) : image(a, hub, m, gallery);
            col.addView(v, Ui.margins(Ui.fill(), 0, col.getChildCount() == 0 ? 0 : 10, 0, 0));
            String cap = m.optString("caption");
            if (!cap.isEmpty()) col.addView(Ui.text(a, cap, 13, Ui.G700), Ui.margins(Ui.fill(), 2, 4, 2, 0));
        }
        return col.getChildCount() == 0 ? null : col;
    }

    /** "Can't load" over a tile: an icon and "Tap to retry". */
    private static LinearLayout miss(Activity a, int color) {
        LinearLayout miss = Ui.col(a);
        miss.setGravity(Gravity.CENTER);
        miss.addView(Ui.icon(a, Ui.I_ALERT, 20, color));
        miss.addView(Ui.text(a, "Can't load · Tap to retry", 12, color), Ui.margins(Ui.wrap(), 0, 4, 0, 0));
        miss.setVisibility(View.GONE);
        return miss;
    }

    private static View image(Activity a, Hub hub, JSONObject m, List<Images.Src> gallery) {
        String url = Images.sized(m.optString("url"), 1024);
        FrameLayout f = new FrameLayout(a);
        ImageView iv = new ImageView(a);
        iv.setAdjustViewBounds(true);
        iv.setMaxHeight(Ui.dp(380));
        iv.setMinimumHeight(Ui.dp(120));
        iv.setScaleType(ImageView.ScaleType.FIT_START);
        iv.setBackground(Ui.round(Ui.G100, 0, 14));
        iv.setClipToOutline(true);
        iv.setContentDescription(m.optString("name"));
        f.addView(iv, new FrameLayout.LayoutParams(-2, -2));
        LinearLayout miss = miss(a, Ui.G600);
        f.addView(miss, new FrameLayout.LayoutParams(-1, -1));
        Runnable failed = () -> { miss.setVisibility(View.VISIBLE); iv.setMinimumWidth(Ui.dp(260)); };
        Images.load(a, hub, url, iv, failed);
        int at = 0;
        for (int i = 0; i < gallery.size(); i++) if (gallery.get(i).url.equals(m.optString("url"))) at = i;
        int idx = at;
        iv.setOnClickListener(v -> {
            if (miss.getVisibility() == View.VISIBLE) {
                miss.setVisibility(View.GONE);
                Images.load(a, hub, url, iv, failed);
            } else if (!gallery.isEmpty()) Images.open(a, gallery, idx);
        });
        return f;
    }

    private static View video(Activity a, Hub hub, JSONObject m) {
        FrameLayout f = new FrameLayout(a);
        f.setBackground(Ui.round(0xff181818, 0, 14));
        f.setClipToOutline(true);
        ImageView poster = new ImageView(a);
        poster.setScaleType(ImageView.ScaleType.CENTER_CROP);
        f.addView(poster, new FrameLayout.LayoutParams(-1, -1));
        String p = m.optString("poster");
        if (!p.isEmpty()) Images.load(a, hub, Images.sized(p, 1024), poster, null);
        TextView play = Ui.icon(a, Ui.I_PLAY, 26, 0xffffffff);
        play.setBackground(Ui.round(0x99000000, 0, 28));
        play.setPadding(Ui.dp(4), 0, 0, 0);
        f.addView(play, new FrameLayout.LayoutParams(Ui.dp(56), Ui.dp(56), Gravity.CENTER));
        TextView label = Ui.subtitle(Ui.text(a, m.optString("name"), 12, 0xffe6e6e6));
        label.setBackground(Ui.round(0x99000000, 0, 6));
        label.setPadding(Ui.dp(8), Ui.dp(3), Ui.dp(8), Ui.dp(3));
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM | Gravity.START);
        lp.setMargins(Ui.dp(10), 0, Ui.dp(10), Ui.dp(10));
        f.addView(label, lp);
        LinearLayout miss = miss(a, 0xffe6e6e6);
        miss.setBackgroundColor(0xcc181818);
        f.addView(miss, new FrameLayout.LayoutParams(-1, -1));
        f.setContentDescription("Play " + m.optString("name"));
        boolean[] busy = {false};
        f.setOnClickListener(v -> {
            if (busy[0]) return;
            busy[0] = true;
            miss.setVisibility(View.GONE);
            play.setText("");
            Ui.pool.execute(() -> {
                File got = download(a, hub, m.optString("url"), m.optString("name"), pct -> Ui.main.post(() -> label.setText(pct + "% · " + m.optString("name"))));
                Ui.main.post(() -> {
                    busy[0] = false;
                    play.setText(Ui.I_PLAY);
                    label.setText(m.optString("name"));
                    if (a.isDestroyed()) return;
                    if (got == null) miss.setVisibility(View.VISIBLE);
                    else player(a, got, m.optString("name"));
                });
            });
        });
        // 16:9 at the reply's width.
        f.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> {
            int h = (r - l) * 9 / 16;
            if (h > 0 && v.getLayoutParams().height != h) {
                v.getLayoutParams().height = h;
                v.post(v::requestLayout);
            }
        });
        f.setLayoutParams(new LinearLayout.LayoutParams(-1, Ui.dp(200)));
        return f;
    }

    interface Progress { void at(int pct); }

    /** The video in this app's cache (downloaded once per address), or null. */
    private static File download(Activity a, Hub hub, String url, String name, Progress progress) {
        String ext = name.contains(".") ? name.substring(name.lastIndexOf('.')).toLowerCase() : ".mp4";
        if (!ext.matches("\\.(mp4|webm|mov)")) ext = ".mp4";
        File dir = new File(a.getCacheDir(), "media");
        dir.mkdirs();
        File to = new File(dir, Integer.toHexString((hub.id + url).hashCode()) + ext);
        if (to.isFile() && to.length() > 0) return to;
        File part = new File(dir, to.getName() + ".part");
        Net.Http c = null;
        try {
            c = hub.open("GET", url, 120_000);
            if (c.code() == 401 && c.signed) {
                c.close();
                c = hub.open("GET", url, 120_000);
            }
            if (c.code() != 200) return null;
            long len = c.length();
            if (len > MAX_VIDEO) return null;
            long got = 0;
            int last = -1;
            byte[] buf = new byte[1 << 16];
            try (InputStream in = c.in(); OutputStream out = new FileOutputStream(part)) {
                for (int n; (n = in.read(buf)) > 0; ) {
                    out.write(buf, 0, n);
                    got += n;
                    if (got > MAX_VIDEO) return null;
                    int pct = len > 0 ? (int) (got * 100 / len) : -1;
                    if (pct >= 0 && pct != last) { last = pct; progress.at(pct); }
                }
            }
            if (len > 0 && got != len) return null;
            return part.renameTo(to) ? to : null;
        } catch (IOException | RuntimeException e) {
            return null;
        } finally {
            if (c != null) c.close();
            part.delete();
        }
    }

    /** Full screen over everything, playing at once; Back or the X closes. */
    private static void player(Activity a, File file, String name) {
        Dialog d = new Dialog(a, android.R.style.Theme_Black_NoTitleBar);
        android.view.Window win = d.getWindow();
        if (win != null) {
            win.setStatusBarColor(0xff000000);
            win.setNavigationBarColor(0xff000000);
        }
        FrameLayout f = new FrameLayout(a);
        f.setBackgroundColor(0xff000000);
        VideoView vv = new VideoView(a);
        f.addView(vv, new FrameLayout.LayoutParams(-1, -2, Gravity.CENTER));
        MediaController mc = new MediaController(a);
        mc.setAnchorView(vv);
        vv.setMediaController(mc);
        vv.setVideoURI(Uri.fromFile(file));
        vv.setOnPreparedListener(mp -> { vv.start(); mc.show(2500); });
        vv.setOnErrorListener((mp, what, extra) -> { Ui.toast(a, "This phone can't play " + name); d.dismiss(); return true; });
        LinearLayout bar = Ui.row(a);
        bar.setPadding(Ui.dp(6), Ui.dp(6), Ui.dp(16), Ui.dp(6));
        TextView close = Ui.iconButton(a, Ui.I_X, 0xffffffff, v -> d.dismiss());
        close.setBackground(null);
        close.setContentDescription("Close");
        bar.addView(close);
        bar.addView(Ui.subtitle(Ui.text(a, name, 15, 0xffffffff)), Ui.margins(Ui.weight(), 6, 0, 0, 0));
        f.addView(bar, new FrameLayout.LayoutParams(-1, -2, Gravity.TOP));
        d.setOnDismissListener(x -> vv.stopPlayback());
        d.setContentView(f);
        d.show();
    }
}
