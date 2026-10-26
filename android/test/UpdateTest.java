package dev.harbor.app;

/** When an automatic update may install (Quiet). Plain JVM, no Android: build.sh runs it
 *  before packaging. */
public class UpdateTest {
    private static int failed;

    private static void check(boolean ok, String what) {
        if (!ok) { failed++; System.err.println("FAIL " + what); }
    }

    public static void main(String[] args) {
        // Only while nobody sees Harbor: no screen of it in front, and the screen off or locked.
        check(Quiet.now(0, false, false), "screen off");
        check(Quiet.now(0, true, true), "lock screen up");
        check(!Quiet.now(0, true, false), "another app in front: the user is on the phone");
        check(!Quiet.now(1, true, false), "Harbor in front");
        check(!Quiet.now(1, false, true), "a Harbor screen still resumed");

        // Due when newer, unless that version failed less than RETRY_MS ago.
        long now = 10 * Quiet.RETRY_MS;
        check(Quiet.due(53000, 52000, 0, 0, now), "newer, never failed");
        check(!Quiet.due(52000, 52000, 0, 0, now), "same version");
        check(!Quiet.due(51000, 52000, 0, 0, now), "older");
        check(!Quiet.due(53000, 52000, 53000, now - 60_000, now), "failed a minute ago");
        check(Quiet.due(53000, 52000, 53000, now - Quiet.RETRY_MS, now), "failed long ago");
        check(Quiet.due(53001, 52000, 53000, now - 60_000, now), "a newer one than the failed one");

        // The phone's own choice wins; until there is one it follows the PCs.
        check(Quiet.auto(null, true), "follows the PCs: on");
        check(!Quiet.auto(null, false), "follows the PCs: off");
        check(!Quiet.auto(false, true), "off here");
        check(Quiet.auto(true, false), "on here");

        if (failed > 0) { System.err.println(failed + " update checks failed"); System.exit(1); }
        System.out.println("UpdateTest ok");
    }
}
