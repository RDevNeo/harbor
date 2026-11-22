package dev.harbor.app;

import java.io.ByteArrayOutputStream;
import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
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
    /** `context=`: text the opening app hands the chat (null: none, or left out, see contextError).
     *  Untrusted: the PC shows it folded and gives it to the agent with the user's next message,
     *  marked as written by that app (ts agents/linkcontext.ts). */
    String context;
    /** Why the link's context was left out ("too long", "couldn't be read"), null when it wasn't. */
    String contextError;
    /** `from=`: the name the link gives its sender; anyone can write anything there (unverified). */
    String from = "";

    /** The app Android said opened the link (Hubs.referrerApp): its name and package; "" unknown. */
    String appLabel = "", appPkg = "";

    /** The most context a link carries, in UTF-8 bytes once cleaned (the PC checks it too). */
    static final int MAX_CONTEXT_BYTES = 4096;
    /** The longest `from` label kept, in characters. */
    static final int MAX_FROM_CHARS = 60;
    /** Encoded context longer than this isn't even decoded. */
    private static final int MAX_RAW = 64 * 1024;

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
        String pc = null, ctx = null, from = null;
        if (q >= 0) {
            // The first of each; other parameters are ignored.
            for (String kv : rest.substring(q + 1).split("&")) {
                if (pc == null && kv.startsWith("pc=")) pc = kv.substring(3);
                else if (ctx == null && kv.startsWith("context=")) ctx = kv.substring(8);
                else if (from == null && kv.startsWith("from=")) from = kv.substring(5);
            }
        }
        String p = pc == null ? null : decode(pc);
        ChatLink l = new ChatLink(path, p == null ? "" : p.trim());
        if (from != null) {
            String f = decode(from);
            l.from = f == null ? "" : label(f);
        }
        if (ctx != null) {
            String c = ctx.length() > MAX_RAW ? null : decode(ctx);
            if (ctx.length() > MAX_RAW) l.contextError = "too long";
            else if (c == null) l.contextError = "couldn't be read";
            else {
                c = clean(c).trim();
                if (c.getBytes(StandardCharsets.UTF_8).length > MAX_CONTEXT_BYTES) l.contextError = "too long";
                else if (!c.isEmpty()) l.context = c;
            }
        }
        return l;
    }

    /** `s` without control characters but newline and tab (C0, DEL, C1); CRLF and a lone CR
     *  become newlines. As the PC's stripControls. */
    static String clean(String s) {
        String t = s.replace("\r\n", "\n").replace('\r', '\n');
        StringBuilder b = new StringBuilder(t.length());
        for (int i = 0; i < t.length(); i++) {
            char ch = t.charAt(i);
            if (ch == '\n' || ch == '\t' || !(ch < 0x20 || ch >= 0x7f && ch <= 0x9f)) b.append(ch);
        }
        return b.toString();
    }

    /** A label on one line: control characters and runs of spaces as one space, at most
     *  MAX_FROM_CHARS characters. */
    static String label(String s) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            b.append(ch < 0x20 || ch >= 0x7f && ch <= 0x9f || Character.isWhitespace(ch) ? ' ' : ch);
        }
        String one = b.toString().trim().replaceAll(" +", " ");
        int n = one.codePointCount(0, one.length());
        return n <= MAX_FROM_CHARS ? one : one.substring(0, one.offsetByCodePoints(0, MAX_FROM_CHARS - 1)) + "…";
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

    /** A query value decoded: %XX escapes and '+' as a space, then strict UTF-8. Null when it's
     *  malformed (a bad escape, bytes that aren't UTF-8). */
    static String decode(String s) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(s.length());
        for (int i = 0; i < s.length(); ) {
            char ch = s.charAt(i);
            if (ch == '%') {
                if (i + 2 >= s.length()) return null;
                int hi = Character.digit(s.charAt(i + 1), 16), lo = Character.digit(s.charAt(i + 2), 16);
                if (hi < 0 || lo < 0) return null;
                out.write(hi * 16 + lo);
                i += 3;
            } else if (ch == '+') {
                out.write(' ');
                i++;
            } else {
                int cp = s.codePointAt(i);
                byte[] b = new String(Character.toChars(cp)).getBytes(StandardCharsets.UTF_8);
                out.write(b, 0, b.length);
                i += Character.charCount(cp);
            }
        }
        try {
            return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(out.toByteArray())).toString();
        } catch (CharacterCodingException e) {
            return null;
        }
    }

    private static String encode(String s) {
        try { return URLEncoder.encode(s, "UTF-8").replace("+", "%20").replace("*", "%2A"); }
        catch (UnsupportedEncodingException e) { return s; }
    }
}
