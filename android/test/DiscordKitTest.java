package dev.harbor.app;

/** The Discord screens' plain logic (DiscordKit): the sign-in QR's pixels, the captcha's touch
 *  mapping and what the screens say. Plain JVM, no Android: build.sh runs it before packaging. */
public class DiscordKitTest {
    private static int failed;

    private static void same(Object got, Object want, String what) {
        if (String.valueOf(got).equals(String.valueOf(want))) return;
        failed++;
        System.err.println("FAIL " + what + ": got " + got + ", want " + want);
    }

    public static void main(String[] args) {
        // A 3×3 code: a quiet zone of 4 modules on each side, 2 pixels a module.
        String[] rows = { "101", "010", "001" };
        same(DiscordKit.modules(rows), 11, "modules with the quiet zone");
        int[] px = DiscordKit.pixels(rows, 2);
        int side = 22;
        same(px.length, side * side, "pixel count");
        java.util.function.BiFunction<Integer, Integer, Integer> at = (x, y) -> px[y * side + x];
        same(Integer.toHexString(at.apply(0, 0)), "ffffffff", "the corner is quiet");
        same(Integer.toHexString(at.apply(7, 7)), "ffffffff", "just before the code: white");
        same(Integer.toHexString(at.apply(8, 8)), "ff000000", "module (0,0) black");
        same(Integer.toHexString(at.apply(9, 9)), "ff000000", "module (0,0) is 2 px wide");
        same(Integer.toHexString(at.apply(10, 8)), "ffffffff", "module (1,0) white");
        same(Integer.toHexString(at.apply(10, 10)), "ff000000", "module (1,1) black");
        same(Integer.toHexString(at.apply(12, 12)), "ff000000", "module (2,2) black");
        same(Integer.toHexString(at.apply(14, 14)), "ffffffff", "after the code: white");
        int black = 0;
        for (int p : px) if (p == 0xff000000) black++;
        same(black, 4 * 4, "four black modules of 2×2 pixels");
        // Ragged or odd rows: anything but '1' is white, a short row pads.
        same(DiscordKit.modules(new String[] { "1", "0110" }), 12, "the widest row counts");
        same(DiscordKit.pixels(new String[] { "x1" }, 1)[4 * 10 + 5], 0xff000000, "only '1' is black");
        // Whole pixels a module that fit.
        same(DiscordKit.scale(rows, 220), 20, "scale to fit 220 px");
        same(DiscordKit.scale(rows, 5), 1, "never below one pixel");

        // The view shows the whole 1280×720 page at 640×360: half the page's pixels.
        int[] p = DiscordKit.toPage(100, 50, 640, 360, 1280, 720);
        same(p[0] + "," + p[1], "200,100", "view to page");
        p = DiscordKit.toPage(639.6f, 359.6f, 640, 360, 1280, 720);
        same(p[0] + "," + p[1], "1279,719", "the far corner");
        p = DiscordKit.toPage(10, 10, 0, 0, 1280, 720);
        same(p[0] + "," + p[1], "0,0", "no size yet");
        int[] rect = { 400, 100, 300, 400 };
        same(DiscordKit.inside(400, 100, rect), true, "the captcha's corner is on it");
        same(DiscordKit.inside(699, 499, rect), true, "its last pixel");
        same(DiscordKit.inside(700, 300, rect), false, "just right of it");
        same(DiscordKit.inside(500, 99, rect), false, "just above it");
        same(DiscordKit.inside(500, 300, null), false, "no captcha rect: nowhere");

        // Fitting: the width when the height allows, else the height.
        int[] f = DiscordKit.fit(1080, 0, 1280, 720);
        same(f[0] + "x" + f[1], "1080x608", "fit to the width");
        f = DiscordKit.fit(2000, 600, 1280, 720);
        same(f[0] + "x" + f[1], "1067x600", "fit to the height");
        f = DiscordKit.fit(1080, 0, 0, 0);
        same(f[0] + "x" + f[1], "1080x0", "no page yet");

        // The lines, as the desktop says them.
        same(DiscordKit.intro("Cats"), "To join Cats, Discord wants a person to solve this. Only the captcha takes your taps; Harbor never answers it for you.", "intro");
        same(DiscordKit.intro(""), "To join a server, Discord wants a person to solve this. Only the captcha takes your taps; Harbor never answers it for you.", "intro without a name");
        same(DiscordKit.outcome("joined", "Cats"), "Discord joined Cats", "joined");
        same(DiscordKit.outcome("closed", "Cats"), "Not joined: the captcha was closed", "closed");
        same(DiscordKit.outcome("timeout", ""), "Not joined: nobody solved the captcha in time", "timeout");
        same(DiscordKit.outcome("stopped", ""), "Not joined: Discord stopped", "stopped");
        same(DiscordKit.outcome("", ""), null, "nothing known");
        same(DiscordKit.outcome(null, ""), null, "no end");

        if (failed > 0) { System.err.println(failed + " check(s) failed"); System.exit(1); }
        System.out.println("DiscordKitTest ok");
    }
}
