package dev.harbor.app;

/** Whether text that came into the composer is a message copied here with its images (Copied),
 *  however it came: the clip pasted, the same text from the phone's clipboard history (Samsung's
 *  and Gboard's keep only the text of a clip that has both) or a clipboard app. Plain Java, so
 *  ClipMatchTest runs it on the JVM. */
final class ClipMatch {
    private ClipMatch() { }

    /** `got` is the text `copied` was, give or take the spaces a keyboard puts around a paste.
     *  A copy of one character never matches: that is typing. */
    static boolean same(String copied, CharSequence got) {
        if (copied == null || got == null) return false;
        String c = copied.trim();
        return c.length() > 1 && c.equals(got.toString().trim());
    }
}
