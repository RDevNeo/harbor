package dev.harbor.app;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** The chat list's workspace filter (WsFilter), the desktop's rule (src/sidebar.rs).
 *  Plain JVM, no Android: build.sh runs it before packaging. */
public class WsFilterTest {
    private static int failed;

    private static void check(boolean ok, String what) {
        if (!ok) { failed++; System.err.println("FAIL " + what); }
    }

    private static void same(Object got, Object want, String what) {
        check(String.valueOf(got).equals(String.valueOf(want)), what + ": got " + got + ", want " + want);
    }

    public static void main(String[] args) {
        Map<String, String> pcs = new HashMap<>();
        pcs.put("ts:desk", "a");
        pcs.put("ts:other", "b");

        // All shows everything, a PC in no workspace too.
        WsFilter all = new WsFilter(new ArrayList<>(), "ts:desk", "a", pcs);
        check(!all.active(), "all: not active");
        check(all.shows("ts:other") && all.shows("ts:loose") && all.shows(""), "all: every chat");
        check(all.showsProject("/p"), "all: every project");

        // The answering PC's workspace: its chats and every project of it.
        WsFilter mine = new WsFilter(Arrays.asList("a"), "ts:desk", "a", pcs);
        check(mine.active(), "a workspace: active");
        check(mine.shows("ts:desk"), "the PC's own chat");
        check(mine.shows(""), "a chat with no home is the answering PC's");
        check(!mine.shows("ts:other"), "another workspace's chat");
        check(!mine.shows("ts:loose"), "a PC in no workspace shows only under All");
        check(mine.showsProject("/p"), "the answering PC's projects are in its workspace");

        // Another workspace: only the projects it has chats in.
        WsFilter other = new WsFilter(Arrays.asList("b"), "ts:desk", "a", pcs);
        check(other.shows("ts:other"), "that workspace's chat");
        check(!other.shows("ts:desk"), "the answering PC's chat");
        other.saw("ts:desk", "/mine");
        other.saw("ts:other", "/shared");
        other.saw("ts:other", "");
        check(other.showsProject("/shared"), "a project with a chat there");
        check(!other.showsProject("/mine"), "a project with chats elsewhere only");
        check(!other.showsProject(""), "no project");

        // The answering PC in no workspace: its chats show only under All.
        WsFilter none = new WsFilter(Arrays.asList("a"), "ts:loose", null, pcs);
        check(!none.shows("ts:loose") && !none.shows(""), "the answering PC in none");
        check(none.shows("ts:desk"), "another PC's chat still shows");
        check(!none.showsProject("/p"), "its projects don't");

        // Several: what each of them has, and still not a PC in none.
        pcs.put("ts:third", "c");
        WsFilter two = new WsFilter(Arrays.asList("b", "c"), "ts:desk", "a", pcs);
        check(two.shows("ts:other") && two.shows("ts:third"), "both workspaces' chats");
        check(!two.shows("ts:desk") && !two.shows("ts:loose"), "nothing else");
        two.saw("ts:third", "/lab");
        check(two.showsProject("/lab") && !two.showsProject("/mine"), "their projects only");
        WsFilter withHere = new WsFilter(Arrays.asList("a", "b"), "ts:desk", "a", pcs);
        check(withHere.shows("") && withHere.shows("ts:other") && withHere.showsProject("/p"), "the answering PC's among them");

        // The same picks and toggles as src/sidebar.rs's tests.
        List<String> ids = Arrays.asList("a", "b", "c");
        same(WsFilter.picked("", ids), "[]", "All");
        same(WsFilter.picked("a", ids), "[a]", "a value from when one was the limit");
        same(WsFilter.picked("c,a", ids), "[a, c]", "in the directory's order");
        same(WsFilter.picked("a,left", ids), "[a]", "an id that's gone drops out");
        same(WsFilter.picked("left,gone", ids), "[]", "none left: All");
        same(WsFilter.picked("a,b,c", ids), "[]", "every one is All");
        same(WsFilter.picked("a,left", Arrays.asList("a")), "[]", "the only one left is every one");
        same(WsFilter.picked("a", new ArrayList<>()), "[]", "signed out");
        same(WsFilter.toggled("", "b", ids), "b", "from All, only the one checked");
        same(WsFilter.toggled("b", "a", ids), "a,b", "one more");
        same(WsFilter.toggled("a,b", "c", ids), "", "checking every one is All");
        same(WsFilter.toggled("a,b", "a", ids), "b", "unchecking one");
        same(WsFilter.toggled("b", "b", ids), "", "unchecking the last goes back to All");
        same(WsFilter.toggled("a,left", "b", ids), "a,b", "ids that are gone don't stay");
        same(WsFilter.toggled("", "a", Arrays.asList("a")), "", "a single workspace is All");

        if (failed > 0) { System.err.println(failed + " failed"); System.exit(1); }
        System.out.println("WsFilterTest ok");
    }
}
