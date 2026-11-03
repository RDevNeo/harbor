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

        // The chat card's frame: an image of a crop of the page, drawn at the view's size.
        int[] crop = { 300, 50, 500, 600 };
        p = DiscordKit.cropToPage(0, 0, 250, 300, crop);
        same(p[0] + "," + p[1], "300,50", "the crop's corner");
        p = DiscordKit.cropToPage(125, 150, 250, 300, crop);
        same(p[0] + "," + p[1], "550,350", "the middle of the crop");
        p = DiscordKit.cropToPage(10, 10, 0, 0, crop);
        same(p[0] + "," + p[1], "0,0", "no view size yet");
        float[] v = DiscordKit.pageToView(new int[] { 400, 100, 300, 400 }, crop, 250, 300);
        same(v[0] + "," + v[1] + "," + v[2] + "," + v[3], "50.0,25.0,200.0,225.0", "the captcha on the view");
        int[] back = DiscordKit.cropToPage(v[0], v[1], 250, 300, crop);
        same(back[0] + "," + back[1], "400,100", "and back to the page");
        same(DiscordKit.pageToView(null, crop, 250, 300), null, "no rect");
        same(DiscordKit.cardIntro("Cats"), "To join Cats. Only the captcha takes your taps; Harbor never answers it for you.", "card intro");
        same(DiscordKit.cardIntro(null), "To join a server. Only the captcha takes your taps; Harbor never answers it for you.", "card intro without a name");

        // The frame loop's pace: at most ~15 calls a second, older PCs every 500 ms.
        same(DiscordKit.nextCall(true, 1000, 1010), 56, "a quick answer waits out the 66 ms");
        same(DiscordKit.nextCall(true, 1000, 1200), 0, "a long-poll answer: at once");
        same(DiscordKit.nextCall(false, 1000, 1100), 400, "an older PC: every 500 ms");
        same(DiscordKit.nextCall(false, 1000, 1700), 0, "a slow older PC: at once");
        // Laid out again only when the frame's shape changes.
        same(DiscordKit.reshapes(0, 0, 720, 540), true, "the first frame sets the height");
        same(DiscordKit.reshapes(720, 540, 720, 540), false, "same size: drawn only");
        same(DiscordKit.reshapes(720, 540, 360, 270), false, "same shape, smaller: drawn only");
        same(DiscordKit.reshapes(720, 540, 720, 600), true, "a new shape: laid out");
        same(DiscordKit.reshapes(720, 540, 0, 0), false, "no size: nothing");

        // The card's frame takes each frame's shape: the checkbox (wide), then the challenge
        // (tall, 2x device pixels), fitted to the card's width and capped at 60% of the screen.
        int cap = DiscordKit.capHeight(2400);
        same(cap, 1440, "60% of a 2400 px screen");
        f = DiscordKit.fit(996, cap, 600, 148);
        same(f[0] + "x" + f[1], "996x246", "the checkbox: the card's width");
        f = DiscordKit.fit(996, cap, 896, 1256);
        same(f[0] + "x" + f[1], "996x1396", "the challenge: the card's width, under the cap");
        f = DiscordKit.fit(996, DiscordKit.capHeight(1600), 896, 1256);
        same(f[0] + "x" + f[1], "685x960", "a short screen: as tall as the cap, narrower");
        // Within the transcript shown (1500 px tall on that phone, the card's chrome 500 px).
        same(DiscordKit.capHeight(2400, 1500, 500, 420), 1000, "the transcript's room, less the card");
        same(DiscordKit.capHeight(2400, 0, 500, 420), 1440, "not laid out yet: 60% of the screen");
        same(DiscordKit.capHeight(2400, 3000, 500, 420), 1440, "a tall transcript: still 60%");
        same(DiscordKit.capHeight(2400, 700, 500, 420), 420, "the keyboard up: never below the least");
        f = DiscordKit.fit(996, DiscordKit.capHeight(2400, 1500, 500, 420), 896, 1256);
        same(f[0] + "x" + f[1], "713x1000", "the challenge, all of it in view");
        // Drawn in the view: the whole view once laid out, else centred with its shape kept.
        int[] in = DiscordKit.inset(996, 1396, 896, 1256);
        same(in[0] + "," + in[1] + "," + in[2] + "," + in[3], "0,0,996,1396", "laid out: the whole view");
        in = DiscordKit.inset(996, 246, 896, 1256);
        same(in[0] + "," + in[1] + "," + in[2] + "," + in[3], "410,0,175,246", "a new shape before its layout: not stretched");
        // A tap on the fitted challenge, back in page pixels (the crop is the page's 448x628).
        int[] cc = { 0, 0, 448, 628 };
        p = DiscordKit.cropToPage(498, 698, 996, 1396, cc);
        same(p[0] + "," + p[1], "224,314", "the challenge's middle");
        p = DiscordKit.cropToPage(342 - 0, 480 - 0, 685, 960, cc);
        same(p[0] + "," + p[1], "224,314", "the same point on a short screen");
        p = DiscordKit.cropToPage(1100, -40, 996, 1396, cc);
        same(p[0] + "," + p[1], "495,-18", "a drag past the edge goes as it is (the PC clamps)");

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
