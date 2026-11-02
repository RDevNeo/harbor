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
