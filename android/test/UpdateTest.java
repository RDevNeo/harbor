package dev.harbor.app;

/** When an automatic update may install, and what happens when one doesn't go in (Quiet).
 *  Plain JVM, no Android: build.sh runs it before packaging. */
public class UpdateTest {
    private static int failed;

    private static void check(boolean ok, String what) {
        if (!ok) { failed++; System.err.println("FAIL " + what); }
    }

    private static void same(Object got, Object want, String what) {
        check(String.valueOf(got).equals(String.valueOf(want)), what + ": got " + got + ", want " + want);
    }

    public static void main(String[] args) {
        // Only while nobody sees Harbor: no screen of it in front, and the screen off or locked.
        check(Quiet.now(0, false, false), "screen off");
        check(Quiet.now(0, true, true), "lock screen up");
        check(!Quiet.now(0, true, false), "another app in front: the user is on the phone");
        check(!Quiet.now(1, true, false), "Harbor in front");
        check(!Quiet.now(1, false, true), "a Harbor screen still resumed");

        // A newer version installs in the background...
        same(Quiet.plan(53000, 52000, 0, false, 0), Quiet.INSTALL, "newer, nothing failed");
        same(Quiet.plan(52000, 52000, 0, false, 0), Quiet.NONE, "same version");
        same(Quiet.plan(51000, 52000, 0, false, 0), Quiet.NONE, "older");
        // ...one that didn't go in is offered once in a notification, never tried again silently...
        same(Quiet.plan(53000, 52000, 53000, false, 0), Quiet.OFFER, "failed: offer it");
        same(Quiet.plan(53000, 52000, 53000, false, 53000), Quiet.NONE, "failed and offered: nothing more");
        same(Quiet.plan(53001, 52000, 53000, false, 53000), Quiet.INSTALL, "a newer one than the failed one");
        // ...and once the verifier refused one, later versions go straight to the notification.
        same(Quiet.plan(54000, 53000, 53000, true, 53000), Quiet.OFFER, "blocked: offer the next one");
        same(Quiet.plan(54000, 53000, 53000, true, 54000), Quiet.NONE, "blocked and offered");
        same(Quiet.plan(53000, 53000, 53000, true, 53000), Quiet.NONE, "blocked, up to date");

        // What counts as the verifier's refusal (Play Protect), and the reason Settings shows.
        check(Quiet.verifier(Quiet.BLOCKED, null), "STATUS_FAILURE_BLOCKED");
        check(Quiet.verifier(1, "INSTALL_FAILED_VERIFICATION_FAILURE: Verification failed"), "verification message");
        check(!Quiet.verifier(6, "INSTALL_FAILED_INSUFFICIENT_STORAGE: Failed to allocate"), "storage isn't the verifier");
        same(Quiet.reason(2, "INSTALL_FAILED_VERIFICATION_FAILURE: Install not allowed"),
                "INSTALL_FAILED_VERIFICATION_FAILURE: Install not allowed (status 2, blocked)", "whole reason");
        same(Quiet.reason(1, null), "status 1, failed", "no message");
        check(!Quiet.verifier(7, "INSTALL_FAILED_NO_MATCHING_ABIS: Failed to extract native libraries, res=-113"), "ABIs aren't the verifier");
        check(Quiet.reason(7, "INSTALL_FAILED_NO_MATCHING_ABIS: Failed to extract native libraries, res=-113")
                .startsWith("This version wasn't built for this phone's processor"), "ABI reason in plain words");
        same(Quiet.reason(42, " "), "status 42", "unknown status");

        // The phone's own choice wins; until there is one it follows the PCs.
        check(Quiet.auto(null, true), "follows the PCs: on");
        check(!Quiet.auto(null, false), "follows the PCs: off");
        check(!Quiet.auto(false, true), "off here");
        check(Quiet.auto(true, false), "on here");

        if (failed > 0) { System.err.println(failed + " update checks failed"); System.exit(1); }
        System.out.println("UpdateTest ok");
    }
}
