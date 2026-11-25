package dev.harbor.app;

import java.io.UnsupportedEncodingException;
import java.net.URLDecoder;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** A Hub pairing link, {@code hub://pair?fp=…&addrs=…&name=…&id=…&code=…} (Pair). Plain Java,
 *  no Android classes: the unit tests run it on the JVM (test/PairTest.java). */
final class PairLink {
    String fp = "", name = "", id = "", code = "";
    final List<String> addrs = new ArrayList<>();


    /** The pairing link in s, or null when it isn't one (no valid key fingerprint, no address or
     *  no code). Scheme and host are matched without case, as Android's intent filters do. */
    static PairLink parse(String s) {
        if (s == null) return null;
        s = s.trim();
        String pre = "hub://pair";
        if (!s.regionMatches(true, 0, pre, 0, pre.length())) return null;
        String rest = s.substring(pre.length());
        int hash = rest.indexOf('#');
        if (hash >= 0) rest = rest.substring(0, hash);
        if (rest.startsWith("/")) rest = rest.substring(1);
        if (!rest.startsWith("?")) return null;
        PairLink l = new PairLink();
        for (String kv : rest.substring(1).split("&")) {
            int eq = kv.indexOf('=');
            if (eq <= 0) continue;
            String k = kv.substring(0, eq), v = decode(kv.substring(eq + 1));
            if (v == null) return null;
            switch (k) {
                case "fp": l.fp = v; break;
                case "name": l.name = v.trim(); break;
                case "id": l.id = v.trim(); break;
                case "code": l.code = v.trim(); break;
                case "addrs":
                    for (String a : v.split(",")) {
                        a = a.trim();
                        if (!a.isEmpty() && a.length() <= 255 && !l.addrs.contains(a)) l.addrs.add(a);
                    }
                    break;
                default: break;
            }
        }
        l.fp = fp(l.fp);
        if (l.fp == null || l.addrs.isEmpty() || l.code.isEmpty() || l.code.length() > 128) return null;
        if (l.name.length() > 120) l.name = l.name.substring(0, 120);
        if (l.id.length() > 200) l.id = "";
        return l;
    }

    /** A key fingerprint, 64 lowercase hex characters (colons and spaces dropped), else null. */
    static String fp(String s) {
        if (s == null) return null;
        String f = s.replaceAll("[\\s:-]", "").toLowerCase(Locale.ROOT);
        return f.matches("[0-9a-f]{64}") ? f : null;
    }

    private static String decode(String s) {
        try { return URLDecoder.decode(s, "UTF-8"); } catch (UnsupportedEncodingException | IllegalArgumentException e) { return null; }
    }

    /** The PC's label for a link: its name, else the start of its key. */
    static String label(PairLink l) { return l.name.isEmpty() ? "PC " + l.fp.substring(0, 8) : l.name; }

}
