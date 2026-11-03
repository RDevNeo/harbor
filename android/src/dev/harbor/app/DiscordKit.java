package dev.harbor.app;

/** The Discord screens' plain logic (Discord, DiscordCaptcha), kept free of Android so
 *  DiscordKitTest runs it on a plain JVM: the sign-in QR's pixels, the captcha's touch mapping
 *  and the lines the desktop says. */
final class DiscordKit {
    private DiscordKit() { }

    /** White modules around the QR code, as the standard asks. */
    static final int QUIET = 4;

    /** The QR's width in modules, quiet zone included (`rows`: the hub's `qr.rows`, '0'/'1'). */
    static int modules(String[] rows) {
        int n = rows.length;
        for (String r : rows) n = Math.max(n, r == null ? 0 : r.length());
        return n + 2 * QUIET;
    }

    /** The QR as ARGB pixels, `scale` pixels a module, black on white with the quiet zone: a
     *  square of side modules(rows) * scale. Anything but '1' is white. */
    static int[] pixels(String[] rows, int scale) {
        int side = modules(rows) * scale;
        int[] px = new int[side * side];
        java.util.Arrays.fill(px, 0xffffffff);
        for (int y = 0; y < rows.length; y++) {
            String r = rows[y];
            if (r == null) continue;
            for (int x = 0; x < r.length(); x++) {
                if (r.charAt(x) != '1') continue;
                int x0 = (x + QUIET) * scale, y0 = (y + QUIET) * scale;
                for (int dy = 0; dy < scale; dy++) java.util.Arrays.fill(px, (y0 + dy) * side + x0, (y0 + dy) * side + x0 + scale, 0xff000000);
            }
        }
        return px;
    }

    /** The biggest whole number of pixels a module that keeps the QR within `max` pixels (at least 1). */
    static int scale(String[] rows, int max) {
        return Math.max(1, max / modules(rows));
    }

    /** A point on the view (vw × vh pixels, showing the whole page) in the page's own pixels
     *  (pw × ph), rounded. */
    static int[] toPage(float x, float y, int vw, int vh, int pw, int ph) {
        if (vw <= 0 || vh <= 0) return new int[] { 0, 0 };
        return new int[] { Math.round(x * pw / vw), Math.round(y * ph / vh) };
    }

    /** Whether page point (x, y) is on the captcha (`rect` x, y, width, height); no rect: nowhere. */
    static boolean inside(int x, int y, int[] rect) {
        return rect != null && x >= rect[0] && y >= rect[1] && x < rect[0] + rect[2] && y < rect[1] + rect[3];
    }

    /** The view's size for a page of pw × ph within maxW × maxH: as wide as it may be, keeping
     *  the page's shape. */
    static int[] fit(int maxW, int maxH, int pw, int ph) {
        if (pw <= 0 || ph <= 0) return new int[] { maxW, 0 };
        int w = maxW, h = Math.round((float) maxW * ph / pw);
        if (maxH > 0 && h > maxH) { h = maxH; w = Math.round((float) maxH * pw / ph); }
        return new int[] { w, h };
    }

    /** A point on a view (vw × vh pixels) showing an image of the page's `crop` (x, y, width,
     *  height in page pixels) in the page's own pixels, rounded: crop.x + x * crop.width / vw. */
    static int[] cropToPage(float x, float y, int vw, int vh, int[] crop) {
        if (vw <= 0 || vh <= 0 || crop == null) return new int[] { 0, 0 };
        return new int[] { Math.round(crop[0] + x * crop[2] / vw), Math.round(crop[1] + y * crop[3] / vh) };
    }

    /** The inverse for a page rectangle (x, y, width, height): {left, top, right, bottom} on the
     *  view; null without a rect or a crop. */
    static float[] pageToView(int[] rect, int[] crop, int vw, int vh) {
        if (rect == null || crop == null || crop[2] <= 0 || crop[3] <= 0) return null;
        float sx = (float) vw / crop[2], sy = (float) vh / crop[3];
        return new float[] { (rect[0] - crop[0]) * sx, (rect[1] - crop[1]) * sy, (rect[0] + rect[2] - crop[0]) * sx, (rect[1] + rect[3] - crop[1]) * sy };
    }

    /** The chat card's frame loop: the PC holds a call up to WAIT ms until the captcha repaints;
     *  a call starts at most every MIN_GAP ms (about 15 frames a second); BACKOFF after an error
     *  or no captcha; OLD_GAP for PCs that answer at once (no `seq`: before the long-poll). */
    static final int WAIT = 2000, MIN_GAP = 66, BACKOFF = 2000, OLD_GAP = 500;

    /** How long to wait before the next frame call, the last one having started at `started`
     *  (ms, same clock as `now`); longPoll: the PC answered with a `seq`. */
    static long nextCall(boolean longPoll, long started, long now) {
        return Math.max(0, (longPoll ? MIN_GAP : OLD_GAP) - (now - started));
    }

    /** Whether a frame of w × h changes the view's shape from one of was w × was h (then it's
     *  laid out again; otherwise only drawn). */
    static boolean reshapes(int wasW, int wasH, int w, int h) {
        if (w <= 0 || h <= 0) return false;
        if (wasW <= 0 || wasH <= 0) return true;
        return Math.abs((long) w * wasH - (long) h * wasW) * 100 > (long) wasW * wasH; // more than 1%
    }

    /** Where a bitmap of bw × bh is drawn in a view of vw × vh: centred, its shape kept, as
     *  large as fits ({left, top, width, height}). The view takes each frame's shape, so this is
     *  the whole view but for the moment between a new shape's first frame and its layout. */
    static int[] inset(int vw, int vh, int bw, int bh) {
        if (vw <= 0 || vh <= 0 || bw <= 0 || bh <= 0) return new int[] { 0, 0, Math.max(0, vw), Math.max(0, vh) };
        int[] f = fit(vw, vh, bw, bh);
        return new int[] { (vw - f[0]) / 2, (vh - f[1]) / 2, f[0], f[1] };
    }

    /** The tallest the chat card's frame may be on a screen sh pixels tall: room is left for the
     *  card's title and Don't join, so the whole challenge stays in view. */
    static int capHeight(int sh) {
        return Math.max(1, sh * 60 / 100);
    }

    /** The same within the transcript actually shown (vh pixels tall, 0: not laid out yet): the
     *  card's title, its line and Don't join (`chrome` pixels) fit beside the frame, never
     *  shorter than `least`. */
    static int capHeight(int sh, int vh, int chrome, int least) {
        int c = capHeight(sh);
        return vh > 0 ? Math.max(least, Math.min(c, vh - chrome)) : c;
    }

    /** The chat card's line under its title (the desktop's). */
    static String cardIntro(String guild) {
        return "To join " + (guild == null || guild.isEmpty() ? "a server" : guild) + ". Only the captcha takes your taps; Harbor never answers it for you.";
    }

    /** The captcha screen's line under its title (the desktop's, with taps for clicks). */
    static String intro(String guild) {
        return "To join " + (guild == null || guild.isEmpty() ? "a server" : guild)
                + ", Discord wants a person to solve this. Only the captcha takes your taps; Harbor never answers it for you.";
    }

    /** What to say once the captcha is gone, from `captcha_end.outcome` (null: say nothing). */
    static String outcome(String outcome, String guild) {
        if (outcome == null) return null;
        switch (outcome) {
            case "joined": return "Discord joined " + (guild == null || guild.isEmpty() ? "the server" : guild);
            case "closed": return "Not joined: the captcha was closed";
            case "timeout": return "Not joined: nobody solved the captcha in time";
            case "stopped": return "Not joined: Discord stopped";
            default: return null;
        }
    }
}
