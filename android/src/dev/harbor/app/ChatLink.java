package dev.harbor.app;

import java.io.UnsupportedEncodingException;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** A chat link, `harbor://chat/<gid>?pc=<PC name>`, as agents write them in replies (ts
 *  net/chatlink.ts) and as another app or a browser hands it to the phone (Hubs; the manifest's
 *  harbor://chat filter). Plain Java, no Android classes: the unit tests run it on the JVM. */
final class ChatLink {
    static final String SCHEME = "harbor://chat/";

    /** The chat's gid (or, as some agents write, its number on PC `pc`). */
    final String gid;
    /** The PC it lives on, decoded ("" when the link names none). */
    final String pc;

    private ChatLink(String gid, String pc) { this.gid = gid; this.pc = pc; }

    /** The link in `s`, or null when it isn't one. Like the desktop's parseChatLink: a gid of
     *  letters, digits, '_' and '-' (1-64 of them), then optionally `?pc=`; other query
     *  parameters and a fragment are ignored. The scheme and host are matched without case, as
     *  Android's intent filters match them. */
    static ChatLink parse(String s) {
        if (s == null) return null;
        s = s.trim();
        if (s.length() < SCHEME.length() || !s.regionMatches(true, 0, SCHEME, 0, SCHEME.length())) return null;
        String rest = s.substring(SCHEME.length());
        int hash = rest.indexOf('#');
        if (hash >= 0) rest = rest.substring(0, hash);
        int q = rest.indexOf('?');
        String path = q < 0 ? rest : rest.substring(0, q);
        if (path.endsWith("/")) path = path.substring(0, path.length() - 1);
        if (path.isEmpty() || path.length() > 64) return null;
        for (int i = 0; i < path.length(); i++) {
            char c = path.charAt(i);
            if (!(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-')) return null;
        }
        String pc = "";
        if (q >= 0) {
            for (String kv : rest.substring(q + 1).split("&")) {
                if (!kv.startsWith("pc=")) continue;
                pc = decode(kv.substring(3)).trim();
                break;
            }
        }
        return new ChatLink(path, pc);
    }

    /** The link as the hub resolves it (GET /v1/chat_link?url=): what an agent would have written. */
    String url() { return SCHEME + gid + (pc.isEmpty() ? "" : "?pc=" + encode(pc)); }

    /** Which of the phone's workspaces to ask, in order, given each one's PC names: those with
     *  the link's PC first (names without case, as the desktop compares them), then the rest
     *  (a renamed PC, a link without one: the chat may still be in any of them). */
    static List<Integer> order(List<List<String>> pcsOfHubs, String pc) {
        List<Integer> first = new ArrayList<>(), rest = new ArrayList<>();
        String want = pc == null ? "" : pc.toLowerCase(Locale.ROOT);
        for (int i = 0; i < pcsOfHubs.size(); i++) {
            boolean has = false;
            if (!want.isEmpty()) for (String n : pcsOfHubs.get(i)) if (n != null && n.toLowerCase(Locale.ROOT).equals(want)) { has = true; break; }
            (has ? first : rest).add(i);
        }
        first.addAll(rest);
        return first;
    }

    private static String decode(String s) {
        try { return URLDecoder.decode(s, "UTF-8"); }
        catch (UnsupportedEncodingException | IllegalArgumentException e) { return s; }
    }

    private static String encode(String s) {
        try { return URLEncoder.encode(s, "UTF-8").replace("+", "%20").replace("*", "%2A"); }
        catch (UnsupportedEncodingException e) { return s; }
    }
}
