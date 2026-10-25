package dev.harbor.app;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/** The slash menu's rules, as src/slash.rs has them: the `/word` at the cursor, the text with
 *  an entry put in its place, and which entries match, best first (T3 Code's ranking). Plain
 *  Java: build.sh tests it on the JVM (test/SlashTest.java). Indices are the EditText's (UTF-16). */
final class SlashList {
    /** Where an entry comes from, in the order equal matches are listed (slash.rs's Scope). */
    static final String[] SOURCES = {"harbor", "project", "personal", "builtin", "plugin"};

    static final class Entry {
        final String name, description, hint, source, badge;
        /** Harbor's own: model, plan or default; null for the rest. */
        final String command;
        final List<String> aliases;
        /** A skill: offered after other words too. */
        final boolean skill;

        Entry(String name, List<String> aliases, String description, String hint, String source, String badge, boolean skill, String command) {
            this.name = name; this.aliases = aliases; this.description = description; this.hint = hint;
            this.source = source; this.badge = badge; this.skill = skill; this.command = command;
        }

        int rank() {
            for (int i = 0; i < SOURCES.length; i++) if (SOURCES[i].equals(source)) return i;
            return SOURCES.length;
        }
    }

    /** The `/word` being typed: from its slash to the end of the word. */
    static final class Word {
        final int start, end;
        final String query;
        /** It begins the message: commands only run there, skills anywhere. */
        final boolean first;

        Word(int start, int end, String query, boolean first) { this.start = start; this.end = end; this.query = query; this.first = first; }
    }

    /** The `/word` at `cursor`, if the cursor is in one. */
    static Word word(CharSequence text, int cursor) {
        int n = text.length();
        cursor = Math.max(0, Math.min(cursor, n));
        int start = cursor;
        while (start > 0 && !Character.isWhitespace(text.charAt(start - 1))) start--;
        if (start == cursor || text.charAt(start) != '/') return null;
        int end = cursor;
        while (end < n && !Character.isWhitespace(text.charAt(end))) end++;
        boolean first = true;
        for (int i = 0; i < start && first; i++) first = Character.isWhitespace(text.charAt(i));
        return new Word(start, end, text.subSequence(start + 1, cursor).toString(), first);
    }

    /** What accepting puts in: [from, to) becomes `text`, and the cursor goes after it. */
    static final class Put {
        final int from, to;
        final String text;

        Put(int from, int to, String text) { this.from = from; this.to = to; this.text = text; }

        int cursor() { return from + text.length(); }

        String apply(String s) { return s.substring(0, from) + text + s.substring(to); }
    }

    /** The word replaced by `with` and a space after it (none for an empty `with`, which also
     *  takes the space after the word). */
    static Put put(CharSequence text, Word w, String with) {
        int end = Math.min(w.end, text.length());
        boolean space = end < text.length() && text.charAt(end) == ' ';
        return new Put(w.start, space ? end + 1 : end, with.isEmpty() ? "" : with + " ");
    }

    /** How well `query` matches (lower is better, -1 not at all): the name exactly, then as a
     *  prefix, at a word boundary, anywhere, its letters in order; then the description. */
    static int score(Entry e, String query) {
        if (query.isEmpty()) return 0;
        String q = query.toLowerCase(Locale.ROOT);
        int best = name(e.name, q);
        for (String a : e.aliases) {
            int s = name(a, q);
            if (s >= 0) best = min(best, s + 1);
        }
        String d = e.description.toLowerCase(Locale.ROOT);
        return min(best, d.startsWith(q) ? 22 : d.contains(q) ? 26 : -1);
    }

    private static int min(int a, int b) { return a < 0 ? b : b < 0 ? a : Math.min(a, b); }

    private static int name(String n, String q) {
        n = n.toLowerCase(Locale.ROOT);
        if (n.equals(q)) return 0;
        if (n.startsWith(q)) return 2;
        for (int i = n.indexOf(q); i >= 0; i = n.indexOf(q, i + q.length()))
            if (i > 0 && "-_:/".indexOf(n.charAt(i - 1)) >= 0) return 4;
        if (n.contains(q)) return 6;
        // Its letters in order, fewer skipped first.
        int gaps = 0, j = 0;
        for (int k = 0; k < q.length(); k++) {
            char c = q.charAt(k);
            while (j < n.length() && n.charAt(j) != c) { j++; gaps++; }
            if (j == n.length()) return -1;
            j++;
        }
        return 100 + gaps;
    }

    /** The entries for `w`, best first. After other words only skills (and Harbor's and the
     *  plugins', which Claude Code takes anywhere), as on the desktop. */
    static List<Entry> search(List<Entry> all, Word w) {
        List<Entry> out = new ArrayList<>();
        List<Integer> scores = new ArrayList<>();
        for (Entry e : all) {
            if (!(w.first || e.skill || "harbor".equals(e.source) || "plugin".equals(e.source))) continue;
            int s = score(e, w.query);
            if (s < 0) continue;
            out.add(e);
            scores.add(s);
        }
        List<Integer> order = new ArrayList<>();
        for (int i = 0; i < out.size(); i++) order.add(i);
        Collections.sort(order, (x, y) -> {
            int c = Integer.compare(scores.get(x), scores.get(y));
            if (c == 0) c = Integer.compare(out.get(x).rank(), out.get(y).rank());
            return c != 0 ? c : out.get(x).name.compareTo(out.get(y).name);
        });
        List<Entry> sorted = new ArrayList<>();
        for (int i : order) sorted.add(out.get(i));
        return sorted;
    }
}
