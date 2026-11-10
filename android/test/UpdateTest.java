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
        // Only while nobody sees Harbor: no screen of it on screen, and the screen off or locked,
        // or Harbor out of sight for the grace (a quick look at another app comes back to it).
        long g = Quiet.GRACE_MS;
        check(Quiet.now(false, false, false, 0), "screen off: at once");
        check(Quiet.now(false, true, true, 0), "lock screen up: at once");
        check(!Quiet.now(false, true, false, 0), "just left Harbor for another app: not yet");
        check(!Quiet.now(false, true, false, g - 1), "still within the grace");
        check(Quiet.now(false, true, false, g), "out of sight for the grace: installs");
        check(Quiet.now(false, true, false, Long.MAX_VALUE), "no Harbor screen in this process yet (a job, the service)");
        check(!Quiet.now(true, true, false, Long.MAX_VALUE), "Harbor on screen");
        check(!Quiet.now(true, false, true, Long.MAX_VALUE), "a Harbor screen still on screen (seen wins over screen off)");
        check(10_000 >= g && g >= 3_000, "the grace is short: " + g);

        // Release news: which release to ask about, and what counts as newer.
        check(Quiet.newer("0.172.0", "0.171.3"), "minor");
        check(Quiet.newer("v0.171.10", "0.171.9"), "numeric, with v");
        check(Quiet.newer("1.0.0", "0.999.999"), "major");
        check(!Quiet.newer("0.171.3", "0.171.3"), "same");
        check(!Quiet.newer("0.171.2", "0.171.3"), "older");
        check(Quiet.newer("0.171.3", ""), "anything is newer than nothing known");
        check(Quiet.newer("0.171.3", "?"), "than an unreadable version");
        check(!Quiet.newer("", "0.1.0"), "nothing isn't newer");
        check(!Quiet.newer("0.172.0-rc1", "0.1.0"), "not a release version");
        same(Quiet.have("0.171.0", "0.172.0", "0.171.3"), "0.172.0", "asks about the newest it knows of");
        same(Quiet.have("", "", "0.171.3"), "0.171.3", "a fresh install asks about its own version");
        same(Quiet.have("v0.170.0", null, "?"), "0.170.0", "the v goes");
        same(Quiet.have("", null, "?"), "0.0.0", "nothing known: the first answer names the latest");
        same(Quiet.backoff(0), 0, "no failure, no wait");
        same(Quiet.backoff(1), 15000, "first failure");
        same(Quiet.backoff(2), 30000, "doubles");
        same(Quiet.backoff(50), 300000, "at most 5 minutes");

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

        // The "Harbor X is ready" sheet: once per version, back for a newer one.
        check(Quiet.prompt(53000, 52000, 0), "newer, never shown");
        check(!Quiet.prompt(53000, 52000, 53000), "shown for it already");
        check(Quiet.prompt(54000, 52000, 53000), "a newer one than the dismissed one");
        check(!Quiet.prompt(52000, 52000, 0), "up to date");
        check(!Quiet.prompt(0, 52000, 0), "nothing offered");

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

        if (failed > 0) { System.err.println(failed + " update checks failed"); System.exit(1); }
        System.out.println("UpdateTest ok");
    }
}
