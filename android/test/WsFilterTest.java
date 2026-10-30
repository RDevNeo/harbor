package dev.harbor.app;

import java.util.HashMap;
import java.util.Map;

/** The chat list's workspace filter (WsFilter), the desktop's rule (src/sidebar.rs).
 *  Plain JVM, no Android: build.sh runs it before packaging. */
public class WsFilterTest {
    private static int failed;

    private static void check(boolean ok, String what) {
        if (!ok) { failed++; System.err.println("FAIL " + what); }
    }

    public static void main(String[] args) {
        Map<String, String> pcs = new HashMap<>();
        pcs.put("ts:desk", "a");
        pcs.put("ts:other", "b");

        // All shows everything, a PC in no workspace too.
        WsFilter all = new WsFilter("", "ts:desk", "a", pcs);
        check(!all.active(), "all: not active");
        check(all.shows("ts:other") && all.shows("ts:loose") && all.shows(""), "all: every chat");
        check(all.showsProject("/p"), "all: every project");

        // The answering PC's workspace: its chats and every project of it.
        WsFilter mine = new WsFilter("a", "ts:desk", "a", pcs);
        check(mine.active(), "a workspace: active");
        check(mine.shows("ts:desk"), "the PC's own chat");
        check(mine.shows(""), "a chat with no home is the answering PC's");
        check(!mine.shows("ts:other"), "another workspace's chat");
        check(!mine.shows("ts:loose"), "a PC in no workspace shows only under All");
        check(mine.showsProject("/p"), "the answering PC's projects are in its workspace");

        // Another workspace: only the projects it has chats in.
        WsFilter other = new WsFilter("b", "ts:desk", "a", pcs);
        check(other.shows("ts:other"), "that workspace's chat");
        check(!other.shows("ts:desk"), "the answering PC's chat");
        other.saw("ts:desk", "/mine");
        other.saw("ts:other", "/shared");
        other.saw("ts:other", "");
        check(other.showsProject("/shared"), "a project with a chat there");
        check(!other.showsProject("/mine"), "a project with chats elsewhere only");
        check(!other.showsProject(""), "no project");

        // The answering PC in no workspace: its chats show only under All.
        WsFilter none = new WsFilter("a", "ts:loose", null, pcs);
        check(!none.shows("ts:loose") && !none.shows(""), "the answering PC in none");
        check(none.shows("ts:desk"), "another PC's chat still shows");
        check(!none.showsProject("/p"), "its projects don't");

        if (failed > 0) { System.err.println(failed + " failed"); System.exit(1); }
        System.out.println("WsFilterTest ok");
    }
}
