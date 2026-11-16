package dev.harbor.app;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** The bare http(s) addresses in a user's message, as the desktop finds them (ts/packages/net/src/markdown.ts
 *  `webLinks`, a reply's rule): not one right after a letter, a digit, an opening bracket or a quote, and
 *  trailing punctuation stays outside it. Plain Java: build.sh tests it on the JVM (test/WebLinksTest.java).
 *  Indices are UTF-16, as the TextView's. */
final class WebLinks {
    private static final Pattern WEB = Pattern.compile("https?://");

    private WebLinks() {}

    /** Each address as {start, end}. */
    static List<int[]> find(String text) {
        List<int[]> out = new ArrayList<>();
        if (!text.contains("http://") && !text.contains("https://")) return out;
        Matcher m = WEB.matcher(text);
        int after = 0, from = 0;
        while (from < text.length() && m.find(from)) {
            int at = m.start();
            from = m.end();
            if (at > after) {
                String prev = new String(Character.toChars(text.codePointBefore(at)));
                if ("(<[\"'".contains(prev) || prev.matches("[\\p{L}\\p{N}]")) continue;
            }
            int end = at;
            while (end < text.length()) {
                char c = text.charAt(end);
                if (Character.isWhitespace(c) || Character.isSpaceChar(c) || c == '<' || c == '>' || c == '"' || c == '`') break;
                end++;
            }
            while (end > at && ".,;:!?)'*_".indexOf(text.charAt(end - 1)) >= 0) end--;
            out.add(new int[] { at, end });
            after = end;
            from = end;
        }
        return out;
    }
}
