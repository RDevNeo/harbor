package dev.harbor.app;

/** The video player's double-tap seek (Jump): 5 s each way, adding up in a streak, held between
 *  the start and the end. Plain JVM, no Android: build.sh runs it before packaging. */
public class JumpTest {
    private static int failed;

    private static void same(Object got, Object want, String what) {
        if (!String.valueOf(got).equals(String.valueOf(want))) { failed++; System.err.println("FAIL " + what + ": got " + got + ", want " + want); }
    }

    public static void main(String[] args) {
        long t = 1_000_000, len = 60_000;
        Jump j = new Jump();
        same(j.tap(1, 10_000, len, t), 15_000, "+5 s");
        same(j.mark(), "+5 s", "its mark");
        // Three in a row go 15 s, from where the last one went (the player still at 10 s).
        same(j.tap(1, 10_000, len, t + 300), 20_000, "second of a streak");
        same(j.tap(1, 10_000, len, t + 600), 25_000, "third of a streak");
        same(j.mark(), "+15 s", "the streak's mark");
        // The other way in the streak: from where the streak went, its own count.
        same(j.tap(-1, 10_000, len, t + 900), 20_000, "back in a streak");
        same(j.mark(), "−5 s", "back's mark");
        // A pause ends the streak: from the player's position.
        same(j.tap(-1, 30_000, len, t + 5000), 25_000, "after the streak");
        same(j.mark(), "−5 s", "a fresh mark");
        // The start and the end hold.
        same(j.tap(-1, 3000, len, t + 10_000), 0, "back past the start");
        same(j.tap(-1, 3000, len, t + 10_200), 0, "still at the start");
        same(j.tap(1, 58_000, len, t + 20_000), 60_000, "on past the end");
        same(j.tap(1, 58_000, len, t + 20_200), 60_000, "still at the end");
        // Another video starts afresh.
        j.tap(1, 0, len, t + 30_000);
        j.reset();
        same(j.tap(1, 40_000, len, t + 30_100), 45_000, "after reset: from the position");
        same(j.mark(), "+5 s", "after reset: its mark");
        if (failed > 0) { System.err.println(failed + " failed"); System.exit(1); }
        System.out.println("JumpTest: ok");
    }
}
