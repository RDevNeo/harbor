package dev.harbor.app;

/** When an automatic update may install (Update.round). Android always ends an app's
 *  process when it replaces the app, so it installs only when nobody can see Harbor go: none
 *  of its screens on screen, and either the phone's screen off or locked, or Harbor left a
 *  little while ago (GRACE: a quick look at another app comes back to the same process). A
 *  version that doesn't go in by itself is offered in a notification instead (tap: the install
 *  in front, where the phone's verifier, Google Play Protect, can ask to scan it). Plain Java
 *  (UpdateTest). */
final class Quiet {
    private Quiet() { }

    /** How long Harbor has to be out of sight (with the screen on) before an update installs. */
    static final long GRACE_MS = 10_000;

    /** seen: a Harbor screen is on screen (Base.started, or another of its processes in front);
     *  interactive: the screen is on; locked: the lock screen is up; awayMs: since the last
     *  Harbor screen went out of sight. */
    static boolean now(boolean seen, boolean interactive, boolean locked, long awayMs) {
        return !seen && (!interactive || locked || awayMs >= GRACE_MS);
    }

    /** "0.171.3" (or "v0.171.3") newer than `than`; false when either isn't a version. */
    static boolean newer(String v, String than) {
        long[] a = parse(v), b = parse(than);
        if (a == null) return false;
        if (b == null) return true;
        for (int i = 0; i < 3; i++) if (a[i] != b[i]) return a[i] > b[i];
        return false;
    }

    private static long[] parse(String v) {
        if (v == null) return null;
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("^v?(\\d{1,9})\\.(\\d{1,9})\\.(\\d{1,9})$").matcher(v.trim());
        if (!m.matches()) return null;
        return new long[] { Long.parseLong(m.group(1)), Long.parseLong(m.group(2)), Long.parseLong(m.group(3)) };
    }

    /** The release to ask the news about (Update.hear): the newest of the ones given (the
     *  release last looked at, the last one announced, this app's own version), "0.0.0" if none
     *  is a version, so the first answer names the latest. */
    static String have(String... versions) {
        String best = null;
        for (String v : versions) if (parse(v) != null && (best == null || newer(v, best))) best = v.trim().replaceFirst("^v", "");
        return best == null ? "0.0.0" : best;
    }

    /** The wait after the news (or GitHub) couldn't be reached `fails` times in a row: 15 s,
     *  doubling, at most 5 minutes. */
    static long backoff(int fails) {
        return fails <= 0 ? 0 : Math.min(15_000L << Math.min(fails - 1, 5), 5 * 60_000L);
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

    /** Whether the "Harbor X is ready" sheet shows for version `offered` (this phone runs
     *  `mine`): once per version, so Later on one keeps it away until a newer one comes.
     *  dismissed: the version the sheet last showed for (Later, Update or its X). */
    static boolean prompt(long offered, long mine, long dismissed) {
        return offered > mine && offered != dismissed;
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
