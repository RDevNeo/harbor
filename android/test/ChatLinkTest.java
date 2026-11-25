package dev.harbor.app;

import java.util.List;

/** Chat links another app or a browser hands the phone (ChatLink, Hubs), as the desktop parses
 *  them (ts net/chatlink.ts): run on the build's JVM (android/build.sh). */
public final class ChatLinkTest {
    static int fails;

    static void eq(Object got, Object want, String what) {
        if (got == null ? want != null : !got.equals(want)) { System.out.println("FAIL " + what + ": " + got + " != " + want); fails++; }
    }

    static String parsed(String s) {
        ChatLink l = ChatLink.parse(s);
        return l == null ? null : l.gid + "|" + l.pc;
    }

    public static void main(String[] args) {
        String gid = "0b6f3c1e-7a9d-4d2e-9b1a-2f4c5d6e7f80";
        eq(parsed("harbor://chat/" + gid), gid + "|", "no PC");
        eq(parsed("harbor://chat/" + gid + "?pc=desk"), gid + "|desk", "with a PC");
        eq(parsed("harbor://chat/" + gid + "?pc=My%20Laptop"), gid + "|My Laptop", "a PC name with a space, encoded");
        eq(parsed("harbor://chat/" + gid + "?pc=My+Laptop"), gid + "|My Laptop", "'+' as a space");
        eq(parsed("harbor://chat/" + gid + "?from=app&pc=desk#top"), gid + "|desk", "other parameters and a fragment");
        eq(parsed("HARBOR://Chat/" + gid + "/"), gid + "|", "scheme and host without case, a trailing slash");
        eq(parsed("  harbor://chat/42?pc=desk\n"), "42|desk", "a chat's number (agents write those too), spaces around");
        eq(parsed("harbor://chat/"), null, "no id");
        eq(parsed("harbor://chat/?pc=desk"), null, "no id, a PC");
        eq(parsed("harbor://chat/a/b"), null, "a path");
        eq(parsed("harbor://chat/a.b"), null, "a dot in the id");
        eq(parsed("harbor://chat/" + "x".repeat(65)), null, "an id too long");
        eq(parsed("harbor://pair/abc"), null, "another host");
        eq(parsed("https://chat/abc"), null, "another scheme");
        // Hub's own scheme (the manifest's filter), and what the PC is asked stays Harbor's.
        eq(parsed("hub://chat/" + gid + "?pc=desk"), gid + "|desk", "Hub's scheme");
        eq(parsed("HUB://Chat/" + gid), gid + "|", "Hub's scheme without case");
        eq(ChatLink.parse("hub://chat/" + gid + "?pc=desk").url(), "harbor://chat/" + gid + "?pc=desk", "url() of a hub:// link");
        eq(parsed(null), null, "nothing");

        // What the PC is asked about: the link as an agent writes it (ts chatLink()).
        eq(ChatLink.parse("harbor://chat/" + gid + "?x=1&pc=My%20Laptop#a").url(), "harbor://chat/" + gid + "?pc=My%20Laptop", "url() with a PC");
        eq(ChatLink.parse("harbor://chat/" + gid).url(), "harbor://chat/" + gid, "url() without one");

        // Which workspaces to ask first: the one with the link's PC, then the rest in order.
        List<List<String>> ws = List.of(List.of("desk", "laptop"), List.of("Office-PC"), List.of("", "studio"));
        eq(ChatLink.order(ws, "office-pc"), List.of(1, 0, 2), "the PC's workspace first, without case");
        eq(ChatLink.order(ws, "studio"), List.of(2, 0, 1), "another PC of a workspace");
        eq(ChatLink.order(ws, ""), List.of(0, 1, 2), "no PC: as they are");
        eq(ChatLink.order(ws, "gone"), List.of(0, 1, 2), "an unknown PC: every workspace still");
        eq(ChatLink.order(List.of(), "desk"), List.of(), "no workspaces");

        // context= and from= (what another app hands the chat): decoded strictly, cleaned, capped.
        String base = "harbor://chat/" + gid + "?pc=desk";
        ChatLink c = ChatLink.parse(base + "&context=Weight%2080%20kg%0ASleep%3A%207h%20%E2%9C%85&from=Schedule%20Fixer");
        eq(c.context, "Weight 80 kg\nSleep: 7h \u2705", "context, percent-encoded UTF-8 (encodeURIComponent)");
        eq(c.contextError, null, "no error");
        eq(c.from, "Schedule Fixer", "from");
        eq(c.url(), "harbor://chat/" + gid + "?pc=desk", "the PC is asked about the chat alone, never the context");
        eq(ChatLink.parse(base + "&context=a+b%2Bc").context, "a b+c", "'+' as a space, %2B a plus");
        eq(ChatLink.parse(base + "&context=a%0D%0Ab%09c%00d%07e%1Bf%7Fg%C2%85h").context, "a\nb\tcdefgh", "control characters stripped but newline and tab; CRLF a newline");
        eq(ChatLink.parse(base + "&context=%20%0A%01").context, null, "nothing left: no context, no error");
        eq(ChatLink.parse(base + "&context=%20%0A%01").contextError, null, "nothing left: no error either");
        eq(ChatLink.parse(base + "&context=" + "x".repeat(4096)).context, "x".repeat(4096), "4 KB exactly");
        ChatLink big = ChatLink.parse(base + "&context=" + "x".repeat(4097));
        eq(big.context + "|" + big.contextError, "null|too long", "over 4 KB: left out");
        eq(big.gid, gid, "over 4 KB: the chat still opens");
        // UTF-8 bytes, not characters: 1366 three-byte characters are 4098 bytes.
        eq(ChatLink.parse(base + "&context=" + "%E2%82%AC".repeat(1366)).contextError, "too long", "bytes, not characters");
        eq(ChatLink.parse(base + "&context=" + "%E2%82%AC".repeat(1365)).context, "\u20ac".repeat(1365), "1365 euros fit");
        eq(ChatLink.parse(base + "&context=" + "x".repeat(70000)).contextError, "too long", "huge: not even decoded");
        eq(ChatLink.parse(base + "&context=50%").contextError, "couldn't be read", "a cut escape");
        eq(ChatLink.parse(base + "&context=%G1").contextError, "couldn't be read", "a bad escape");
        eq(ChatLink.parse(base + "&context=%C3%28").contextError, "couldn't be read", "bytes that aren't UTF-8");
        eq(ChatLink.parse(base + "&context=%ED%A0%80").contextError, "couldn't be read", "a UTF-8 surrogate");
        eq(ChatLink.parse(base + "&context=ok&context=second").context, "ok", "the first context= wins");
        eq(ChatLink.parse("harbor://chat/" + gid + "?context=hi#frag").context, "hi", "no PC, a fragment");
        eq(ChatLink.parse(base + "&from=" + "y".repeat(80)).from.length(), 60, "from at most 60 characters");
        eq(ChatLink.parse(base + "&from=Fixer%0A%5Bsystem%5D%20%20now").from, "Fixer [system] now", "from on one line");
        eq(ChatLink.parse(base + "&from=%FF").from, "", "a from that isn't UTF-8: none");
        eq(ChatLink.parse(base).context, null, "no context=");

        if (fails > 0) System.exit(1);
        System.out.println("ChatLinkTest ok");
    }
}
