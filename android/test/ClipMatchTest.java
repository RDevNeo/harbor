package dev.harbor.app;

/** ClipMatch: when text coming into the composer is a message copied with its images. */
public final class ClipMatchTest {
    private static int failed;

    private static void check(String what, boolean got, boolean want) {
        if (got != want) { failed++; System.out.println("FAIL " + what + ": got " + got + ", want " + want); }
    }

    public static void main(String[] args) {
        String msg = "Here's the funnel from last week: [Image #1]";
        check("the same text", ClipMatch.same(msg, msg), true);
        check("a keyboard's space after it", ClipMatch.same(msg, msg + " "), true);
        check("a keyboard's space before it", ClipMatch.same(msg, " " + msg), true);
        check("part of it", ClipMatch.same(msg, "Here's the funnel"), false);
        check("more than it", ClipMatch.same(msg, msg + " and more"), false);
        check("another text", ClipMatch.same(msg, "Something else"), false);
        check("one letter typed", ClipMatch.same("a", "a"), false);
        check("an empty copy", ClipMatch.same("", ""), false);
        check("only spaces", ClipMatch.same("   ", "   "), false);
        check("no copy", ClipMatch.same(null, msg), false);
        check("nothing came", ClipMatch.same(msg, null), false);
        check("a styled CharSequence", ClipMatch.same(msg, new StringBuilder(msg)), true);
        if (failed > 0) { System.out.println(failed + " failed"); System.exit(1); }
        System.out.println("ClipMatchTest ok");
    }
}
