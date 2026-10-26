package dev.harbor.app;

import java.util.Arrays;
import java.util.List;
import java.util.Locale;

/** Dictation's phrase rules (Voice), plain Java so build.sh tests them on the JVM. Some
 *  recognisers (Google's speech services) keep one session through pauses and start the partial
 *  words over after each, with no final words for the earlier phrases; others give the whole
 *  segment at the end. */
final class Phrases {
    private Phrases() { }

    /** True when `now` starts a new phrase rather than revising `before`: it fell back to a word
     *  or so from several (revisions only change the last words). */
    static boolean restarted(String before, String now) {
        String[] o = words(before), n = words(now);
        if (o.length >= 3) return n.length * 2 <= o.length && !(n.length >= 2 && same(n[0], o[0]) && same(n[1], o[1]));
        return o.length == 2 && n.length == 1 && !same(n[0], o[0]);
    }

    /** A segment's final words `t` once its phrases `kept` already went in: what they don't
     *  repeat (the whole segment, or only its last phrase). */
    static String unkept(List<String> kept, String t) {
        if (kept.isEmpty()) return t;
        String[] w = words(t), k = words(String.join(" ", kept));
        int i = 0;
        while (i < k.length && i < w.length && same(w[i], k[i])) i++;
        if (i < k.length) return t;
        return String.join(" ", Arrays.copyOfRange(w, i, w.length));
    }

    static String[] words(String s) { return s == null || s.trim().isEmpty() ? new String[0] : s.trim().split("\\s+"); }

    private static boolean same(String a, String b) { return norm(a).equals(norm(b)); }

    private static String norm(String w) { return w.toLowerCase(Locale.ROOT).replaceAll("[^\\p{L}\\p{N}]", ""); }
}
