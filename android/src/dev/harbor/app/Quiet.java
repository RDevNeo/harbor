package dev.harbor.app;

/** When an automatic update may install (Update.background). Android always ends an app's
 *  process when it replaces the app, so it installs only when nobody can see Harbor go: none
 *  of its screens in front, and the phone's screen off or locked. Plain Java (UpdateTest). */
final class Quiet {
    private Quiet() { }

    /** A version that didn't go in by itself (refused, or waiting for the user's OK) is tried
     *  again only after this. */
    static final long RETRY_MS = 6 * 3600_000L;

    /** resumed: Harbor screens in front (Base.resumed); interactive: the screen is on;
     *  locked: the lock screen is up. */
    static boolean now(int resumed, boolean interactive, boolean locked) {
        return resumed <= 0 && (!interactive || locked);
    }

    /** Whether to install `best` over `mine` now, given the last version that failed and when. */
    static boolean due(long best, long mine, long failedCode, long failedAt, long now) {
        if (best <= mine) return false;
        return best != failedCode || now - failedAt >= RETRY_MS;
    }

    /** The phone's own choice (null: none, it follows the PCs) and whether any PC updates
     *  automatically: on or off. */
    static boolean auto(Boolean mine, boolean pcs) {
        return mine != null ? mine : pcs;
    }
}
