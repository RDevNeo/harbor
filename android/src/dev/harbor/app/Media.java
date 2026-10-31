package dev.harbor.app;

import android.app.Activity;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** Images and videos an agent showed in a reply (a card's `media`, PROTOCOL.md), like the
 *  desktop: an image large in the reply (tap: the full-screen viewer, pinch to zoom), a video
 *  as its poster with a play button (tap: the same viewer, {@link Video}). What can't load says
 *  so; a tap retries. */
final class Media {
    /** What the viewer shows for an item of a card's `media`. */
    static Images.Src src(Hub hub, JSONObject m) {
        boolean video = "video".equals(m.optString("kind"));
        return new Images.Src(hub, m.optString("url"), m.optString("name"), video ? m.optString("poster") : null);
    }

    /** The media of a card, one under the other, or null when there are none. */
    static View list(Activity a, Hub hub, JSONArray media, int seq) {
        return list(a, hub, media, media, seq);
    }

    /** Some of card {@code seq}'s media ({@code media}), browsing all of it ({@code all}) in the viewer. */
    static View list(Activity a, Hub hub, JSONArray media, JSONArray all, int seq) {
        if (media == null || media.length() == 0) return null;
        LinearLayout col = Ui.col(a);
        List<Images.Src> gallery = new ArrayList<>();
        for (int i = 0; i < all.length(); i++) {
            JSONObject m = all.optJSONObject(i);
            if (m != null && !m.optString("url").isEmpty()) gallery.add(src(hub, m));
        }
        for (int i = 0; i < media.length(); i++) {
            JSONObject m = media.optJSONObject(i);
            if (m == null || m.optString("url").isEmpty()) continue;
            boolean tile = "video".equals(m.optString("kind"));
            View v = tile ? video(a, hub, m, gallery, seq) : image(a, hub, m, gallery, seq);
            col.addView(v, Ui.margins(tile ? Ui.wrap() : Ui.fill(), 0, col.getChildCount() == 0 ? 0 : 10, 0, 0));
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

    private static View image(Activity a, Hub hub, JSONObject m, List<Images.Src> gallery, int seq) {
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
            } else if (!gallery.isEmpty()) Images.open(a, seq, gallery, idx);
        });
        return f;
    }

    /** A video shows its poster at its own shape, like an image and like the desktop's, with a
     *  play button; a tap plays it in the viewer. */
    private static View video(Activity a, Hub hub, JSONObject m, List<Images.Src> gallery, int seq) {
        FrameLayout f = new FrameLayout(a);
        ImageView poster = new ImageView(a);
        poster.setAdjustViewBounds(true);
        poster.setMaxHeight(Ui.dp(380));
        poster.setMinimumHeight(Ui.dp(180));
        poster.setMinimumWidth(Ui.dp(260));
        poster.setScaleType(ImageView.ScaleType.FIT_START);
        poster.setBackground(Ui.round(0xff181818, 0, 14));
        poster.setClipToOutline(true);
        // (Those minimums are for until it's there: a tall video is narrow.)
        poster.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> {
            if (poster.getDrawable() != null && poster.getMinimumWidth() > 0) {
                poster.setMinimumWidth(0);
                poster.setMinimumHeight(0);
            }
        });
        f.addView(poster, new FrameLayout.LayoutParams(-2, -2));
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
        f.setContentDescription("Play " + m.optString("name"));
        int at = 0;
        for (int i = 0; i < gallery.size(); i++) if (gallery.get(i).url.equals(m.optString("url"))) at = i;
        int idx = at;
        f.setOnClickListener(v -> Images.open(a, seq, gallery, idx));
        return f;
    }
}
