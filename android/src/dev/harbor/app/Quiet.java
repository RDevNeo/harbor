package dev.harbor.app;

/** When an automatic update may install (Update.background). Android always ends an app's
 *  process when it replaces the app, so it installs only when nobody can see Harbor go: none
 *  of its screens in front, and the phone's screen off or locked. A version that doesn't go in
 *  by itself is offered in a notification instead (tap: the install in front, where the phone's
 *  verifier, Google Play Protect, can ask to scan it). Plain Java (UpdateTest). */
final class Quiet {
    private Quiet() { }

    /** resumed: Harbor screens in front (Base.resumed); interactive: the screen is on;
     *  locked: the lock screen is up. */
    static boolean now(int resumed, boolean interactive, boolean locked) {
        return resumed <= 0 && (!interactive || locked);
    }

    /** The phone's own choice (null: none, it follows the PCs) and whether any PC updates
     *  automatically: on or off. */
    static boolean auto(Boolean mine, boolean pcs) {
        return mine != null ? mine : pcs;
    }

    static final int NONE = 0, INSTALL = 1, OFFER = 2;

    /** What the background does about version `best` (this phone runs `mine`): nothing, install
     *  it, or offer it in a notification. failed: the last version that didn't go in by itself
     *  (never tried again in the background); blocked: the phone's verifier refused one, so later
     *  versions go straight to the notification too; offered: the version already offered (one
     *  notification per version). */
    static int plan(long best, long mine, long failed, boolean blocked, long offered) {
        if (best <= mine) return NONE;
        if (best == failed || blocked) return best == offered ? NONE : OFFER;
        return INSTALL;
    }

    /** PackageInstaller's STATUS_FAILURE_BLOCKED: the verifier (Play Protect) refused it. */
    static final int BLOCKED = 2;

    /** A failure the phone's verifier caused (it needs the user there to scan the app). */
    static boolean verifier(int status, String message) {
        return status == BLOCKED || (message != null && message.contains("VERIFICATION"));
    }

    /** PackageInstaller's status codes, for the reason Settings shows. */
    static String status(int st) {
        switch (st) {
            case 1: return "failed";
            case 2: return "blocked";
            case 3: return "aborted";
            case 4: return "invalid";
            case 5: return "conflict";
            case 6: return "storage";
            case 7: return "incompatible";
            case 8: return "timeout";
            default: return "status " + st;
        }
    }

    /** The whole reason: what it means when Android's message says it plainly, then the
     *  message (INSTALL_FAILED_…) and the status it came with. */
    static String reason(int st, String message) {
        String m = message == null ? "" : message.trim();
        String s = "status " + st + (status(st).startsWith("status") ? "" : ", " + status(st));
        String hint = m.contains("NO_MATCHING_ABIS") ? "This version wasn't built for this phone's processor: update Harbor on your PC, then try again. "
                : m.contains("INSUFFICIENT_STORAGE") ? "The phone is out of space. "
                : m.contains("UPDATE_INCOMPATIBLE") ? "This version is signed differently from the installed app. "
                : "";
        return hint + (m.isEmpty() ? s : m + " (" + s + ")");
    }
}
