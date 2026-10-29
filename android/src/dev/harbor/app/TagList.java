package dev.harbor.app;

import java.util.ArrayList;
import java.util.List;

/** The composer's `@` and `#` tags, as src/tags.rs has them: the `@word` or `#word` at the
 *  cursor, and the tag tokens the text highlights (with `/command`s and mentioned chats'
 *  titles, src/usertext.rs). Ranking is the hub's (GET
 *  /v1/chats/{id}/tags): nothing is matched here. Plain Java: build.sh tests it on the JVM
 *  (test/TagTest.java). Indices are the EditText's (UTF-16). */
final class TagList {
    private static final String OPENERS = "([{\"'`";
    private static final String PUNCT = ",.;:!?)]}\"'`";

    /** The word being typed: its trigger (@ or #), where it is, and what follows the trigger
     *  up to the cursor. */
    static final class Word {
        final char trigger;
        final int start, end;
        final String query;

        Word(char trigger, int start, int end, String query) { this.trigger = trigger; this.start = start; this.end = end; this.query = query; }
    }

    /** The `@word` or `#word` at `cursor`, if the cursor is in one. */
    static Word word(CharSequence text, int cursor) { return word(text, cursor, false); }

    /** …and with `chats`, a `$word` too (a chat to mention, src/chatmention.rs); `$5` (money)
     *  and `$$` aren't. */
    static Word word(CharSequence text, int cursor, boolean chats) {
        int n = text.length();
        cursor = Math.max(0, Math.min(cursor, n));
        int start = cursor;
        while (start > 0 && !Character.isWhitespace(text.charAt(start - 1))) start--;
        // `(@x` and `"#4`: the bracket or quote isn't part of it.
        while (start < cursor && OPENERS.indexOf(text.charAt(start)) >= 0) start++;
        if (start == cursor) return null;
        char t = text.charAt(start);
        if (t != '@' && t != '#' && !(chats && t == '$')) return null;
        String query = text.subSequence(start + 1, cursor).toString();
        if (t == '$' && !query.isEmpty() && (query.charAt(0) == '$' || Character.isDigit(query.charAt(0)))) return null;
        // `##` (a heading) and `@@` are not tags.
        if (!query.isEmpty() && query.charAt(0) == t) return null;
        int end = cursor;
        while (end < n && !Character.isWhitespace(text.charAt(end))) end++;
        return new Word(t, start, end, query);
    }

    /** The tag tokens of `text` as [start, end) pairs: each `@x` and `#123`, without the
     *  punctuation after it. */
    static List<int[]> tokens(CharSequence text) {
        List<int[]> out = new ArrayList<>();
        int n = text.length();
        for (int i = 0; i < n; i++) {
            char c = text.charAt(i);
            if ((c != '@' && c != '#') || (i > 0 && !opens(text.charAt(i - 1)))) continue;
            int end = i + 1;
            while (end < n && !Character.isWhitespace(text.charAt(end))) end++;
            int body = end;
            while (body > i + 1 && PUNCT.indexOf(text.charAt(body - 1)) >= 0) body--;
            boolean ok = body > i + 1;
            if (ok && c == '@') ok = text.charAt(i + 1) != '@';
            if (ok && c == '#') for (int k = i + 1; k < body; k++) if (text.charAt(k) < '0' || text.charAt(k) > '9') { ok = false; break; }
            if (ok) {
                out.add(new int[]{i, body});
                i = end - 1;
            }
        }
        return out;
    }

    /** The `/command` tokens of `text` as [start, end) pairs (src/usertext.rs `commands`): at the
     *  start of a word, a letter first, then letters, digits, `-`, `_` or `:`, without the
     *  punctuation after it; a path (`/tmp/x`) isn't one. */
    static List<int[]> commands(CharSequence text) {
        List<int[]> out = new ArrayList<>();
        int n = text.length();
        for (int i = 0; i < n; i++) {
            if (text.charAt(i) != '/' || (i > 0 && !opens(text.charAt(i - 1)))) continue;
            int end = i + 1;
            while (end < n && !Character.isWhitespace(text.charAt(end))) end++;
            int body = end;
            while (body > i + 1 && PUNCT.indexOf(text.charAt(body - 1)) >= 0) body--;
            boolean ok = body > i + 1 && ascii(text.charAt(i + 1)) && Character.isLetter(text.charAt(i + 1));
            for (int k = i + 1; ok && k < body; k++) {
                char c = text.charAt(k);
                ok = ascii(c) && (Character.isLetterOrDigit(c) || c == '-' || c == '_' || c == ':');
            }
            if (ok) out.add(new int[]{i, body});
            // The rest of the word is no command either.
            i = end - 1;
        }
        return out;
    }

    private static boolean ascii(char c) { return c < 128; }

    /** What the composer highlights (src/usertext.rs `runs`), as [start, end) pairs in order:
     *  each of `titles` (mentioned chats' titles, every time written, longer ones first), then
     *  the tags and commands outside them. */
    static List<int[]> marks(CharSequence text, List<String> titles) {
        List<int[]> out = new ArrayList<>();
        String s = text.toString();
        List<String> by = new ArrayList<>();
        if (titles != null) for (String t : titles) if (t != null && !t.trim().isEmpty()) by.add(t);
        by.sort((a, b) -> b.length() - a.length());
        for (String t : by) {
            for (int i = s.indexOf(t); i >= 0; i = s.indexOf(t, i + 1)) {
                if (free(out, i, i + t.length())) out.add(new int[]{i, i + t.length()});
            }
        }
        List<int[]> rest = tokens(text);
        rest.addAll(commands(text));
        for (int[] r : rest) if (free(out, r[0], r[1])) out.add(r);
        out.sort((a, b) -> a[0] - b[0]);
        return out;
    }

    private static boolean free(List<int[]> out, int a, int z) {
        for (int[] r : out) if (a < r[1] && r[0] < z) return false;
        return true;
    }

    private static boolean opens(char prev) {
        return Character.isWhitespace(prev) || OPENERS.indexOf(prev) >= 0;
    }
}
