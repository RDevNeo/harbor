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

        if (fails > 0) System.exit(1);
        System.out.println("ChatLinkTest ok");
    }
}
