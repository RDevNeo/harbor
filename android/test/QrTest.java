package dev.harbor.app;

import java.awt.image.BufferedImage;
import java.io.File;
import java.util.Random;
import javax.imageio.ImageIO;

/** QrDecode on synthetic camera frames: pair-qr.png (a placeholder harbor://pair link) pasted
 *  into a noisy 1280×720 Y plane with padded rows, as Camera2 hands them over. Plain JVM, no
 *  Android: build.sh runs it before packaging. */
public class QrTest {
    private static final String LINK = "harbor://pair?host=desk.example.ts.net&port=47821"
            + "&token=0123456789abcdef0123456789abcdef&name=desk&ip=";
    private static int failed;

    private static void check(boolean ok, String what) {
        if (!ok) { failed++; System.err.println("FAIL " + what); }
    }

    /** A W×H frame (rows `stride` apart) with the code scaled by `scale`, centred, optionally
     *  rotated a quarter turn (a portrait phone over a landscape sensor) and inverted (light on
     *  dark, which Harbor never shows, so it isn't read). */
    private static byte[] frame(BufferedImage qr, int w, int h, int stride, int scale, boolean rotate, boolean invert) {
        Random rnd = new Random(7);
        byte[] y = new byte[stride * h];
        for (int i = 0; i < y.length; i++) y[i] = (byte) (90 + rnd.nextInt(40));
        int side = qr.getWidth() * scale, x0 = (w - side) / 2, y0 = (h - side) / 2;
        for (int r = 0; r < side; r++)
            for (int c = 0; c < side; c++) {
                int sx = (rotate ? r : c) / scale, sy = (rotate ? qr.getHeight() - 1 - c / scale : r / scale);
                boolean dark = (qr.getRGB(sx, sy) & 0xff) < 128;
                if (invert) dark = !dark;
                int v = dark ? 20 + rnd.nextInt(30) : 200 + rnd.nextInt(40);
                y[(y0 + r) * stride + x0 + c] = (byte) v;
            }
        return y;
    }

    public static void main(String[] a) throws Exception {
        BufferedImage qr = ImageIO.read(new File(a[0]));
        QrDecode d = new QrDecode();
        int w = 1280, h = 720, stride = 1344;
        check(LINK.equals(d.decode(frame(qr, w, h, stride, 2, false, false), stride, w, h, 500, 500)), "upright");
        check(LINK.equals(d.decode(frame(qr, w, h, stride, 2, true, false), stride, w, h, 500, 500)), "rotated");
        check(LINK.equals(d.decode(frame(qr, w, h, stride, 3, false, false), stride, w, h, 9999, 9999)), "whole frame");
        check(d.decode(frame(qr, w, h, stride, 4, false, false), stride, w, h, 200, 200) == null, "cropped too tight");
        check(d.decode(frame(qr, w, h, stride, 2, false, true), stride, w, h, 500, 500) == null, "inverted");
        check(d.decode(new byte[stride * h], stride, w, h, 9999, 9999) == null, "blank");
        if (failed > 0) { System.err.println(failed + " QR check(s) failed"); System.exit(1); }
        System.out.println("QrTest ok");
    }
}
