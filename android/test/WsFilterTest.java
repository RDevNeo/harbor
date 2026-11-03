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

        // Move to workspace…: where it was moved, before its home PC's (logic/sidebar.ts's test).
        WsFilter inA = new WsFilter(Arrays.asList("a"), "ts:desk", "a", pcs);
        check(!inA.shows("", "b"), "this PC's chat moved to b leaves a");
        check(inA.shows("ts:other", "a"), "another workspace's chat moved to a comes in");
        check(inA.shows("ts:desk", ""), "not moved: its PC's");
        check(!inA.showsProject("/moved", "b"), "this PC's project moved to b leaves a");
        inA.saw("ts:other", "a", "/theirs");
        check(inA.showsProject("/theirs", ""), "a project with a chat moved here shows");
        check(inA.showsProject("/kept", ""), "a project not moved stays in the PC's");
        WsFilter inB = new WsFilter(Arrays.asList("b"), "ts:desk", "a", pcs);
        check(inB.shows("", "b") && inB.showsProject("/moved", "b"), "and they show under b");
        inB.saw("", "a", "/mine");
        check(!inB.showsProject("/mine", ""), "a project whose chats were moved to a doesn't come along");
        WsFilter allOf = new WsFilter(new ArrayList<>(), "ts:desk", "a", pcs);
        check(allOf.shows("", "b") && allOf.showsProject("/moved", "b"), "under All everything still shows");

        // Share with workspace…: its owner or any workspace it's shared with (logic/sidebar.ts's test).
        List<String> toB = Arrays.asList("b");
        WsFilter onlyB = new WsFilter(Arrays.asList("b"), "ts:desk", "a", pcs);
        check(onlyB.shows("", "", toB), "this PC's chat shared with b shows under b");
        check(!onlyB.shows("", "", Arrays.asList("c")), "shared with c only: not under b");
        check(!onlyB.shows("", "", null) && !onlyB.shows("", "", new ArrayList<>()), "not shared: its owner's alone");
        check(onlyB.showsProject("/mine", "", toB), "a project shared with b shows under b");
        onlyB.saw("", "", toB, "/through");
        check(onlyB.showsProject("/through", "", null), "a project with a lead shared with b comes along");
        WsFilter onlyA = new WsFilter(Arrays.asList("a"), "ts:desk", "a", pcs);
        check(onlyA.shows("", "", toB) && onlyA.showsProject("/mine", "", toB), "it still shows under its owner");
        check(!onlyA.shows("", "b", Arrays.asList("c")), "moved to b, shared with c: not under a");
        same(onlyA.owner("", ""), "a", "owner: its PC's");
        same(onlyA.owner("ts:other", "c"), "c", "owner: where it was moved");
        same(onlyA.projectOwner(""), "a", "project owner: the answering PC's");
        // The mark: plain under its owner or All; "here" when it shows only because it's shared.
        same(onlyB.mark("a", toB), "here", "shared, owner not picked");
        same(onlyA.mark("a", toB), "shared", "shared, owner picked");
        same(allOf.mark("a", toB), "shared", "shared, under All");
        same(onlyB.mark("b", toB), "", "the owner never counts as a share");
        Map<String, String> names = new HashMap<>();
        names.put("a", "Sam's workspace");
        names.put("b", "Team");
        same(WsFilter.line(names, "a", toB), "Owned by Sam's workspace · shared with Team", "the line");
        same(WsFilter.line(names, "b", toB), "Owned by Team · not shared", "the line, not shared");

        // A project whose folder is another PC's is in that PC's workspace, not the answering PC's
        // (logic/sidebar.ts `projectWorkspace`); one of a PC in no workspace, or of none known, only under All.
        WsFilter deskA = new WsFilter(Arrays.asList("a"), "ts:desk", "a", pcs);
        check(!deskA.showsProject("/theirs", "", "ts:other", null), "another PC's unmoved project leaves the answering PC's workspace");
        check(deskA.showsProject("/mine", "", null, null), "the answering PC's own project stays");
        check(deskA.showsProject("/mine", "", "ts:desk", null), "a project of the answering PC by its id stays");
        check(!deskA.showsProject("/lost", "", "", null) && !deskA.showsProject("/loose", "", "ts:loose", null), "a PC in none, or none known: not under a");
        check(deskA.showsProject("/theirs", "a", "ts:other", null), "another PC's project moved to a shows under a");
        deskA.saw("ts:desk", "/visiting");
        check(deskA.showsProject("/visiting", "", "ts:other", null), "another PC's project with a lead here comes along");
        check(deskA.showsProject("/theirs", "", "ts:other", Arrays.asList("a")), "another PC's project shared with a shows");
        WsFilter deskB = new WsFilter(Arrays.asList("b"), "ts:desk", "a", pcs);
        check(deskB.showsProject("/theirs", "", "ts:other", null), "and it shows under its PC's workspace");
        check(!deskB.showsProject("/mine", "", null, null), "the answering PC's own project doesn't");
        same(deskA.projectOwner("", "ts:other"), "b", "project owner: its PC's");
        same(deskA.projectOwner("", ""), "null", "project owner: none known");
        same(deskA.projectOwner("c", "ts:other"), "c", "project owner: where it was moved");
        WsFilter allPcs = new WsFilter(new ArrayList<>(), "ts:desk", "a", pcs);
        check(allPcs.showsProject("/lost", "", "", null), "under All every project shows");

        // The same picks and toggles as src/sidebar.rs's tests.
        List<String> ids = Arrays.asList("a", "b", "c");
        same(WsFilter.picked("", ids), "[]", "All");
        same(WsFilter.picked("a", ids), "[a]", "a value from when one was the limit");
        same(WsFilter.picked("c,a", ids), "[a, c]", "in the directory's order");
        same(WsFilter.picked("a,left", ids), "[a]", "an id that's gone drops out");
        same(WsFilter.picked("left,gone", ids), "[]", "none left: All");
        same(WsFilter.picked("a,b,c", ids), "[a, b, c]", "every one isn't All");
        same(WsFilter.picked("a,left", Arrays.asList("a")), "[a]", "the only one left stays picked");
        same(WsFilter.picked("a", new ArrayList<>()), "[]", "signed out");
        same(WsFilter.toggled("", "b", ids), "b", "from All, only the one checked");
        same(WsFilter.toggled("b", "a", ids), "a,b", "one more");
        same(WsFilter.toggled("a,b", "c", ids), "a,b,c", "checking every one stays every one");
        same(WsFilter.toggled("a,b", "a", ids), "b", "unchecking one");
        same(WsFilter.toggled("b", "b", ids), "", "unchecking the last goes back to All");
        same(WsFilter.toggled("a,left", "b", ids), "a,b", "ids that are gone don't stay");
        same(WsFilter.toggled("", "a", Arrays.asList("a")), "a", "an account's only workspace can be picked");
        same(WsFilter.toggled("a", "a", Arrays.asList("a")), "", "and unpicked back to All");

        if (failed > 0) { System.err.println(failed + " failed"); System.exit(1); }
        System.out.println("WsFilterTest ok");
    }
}
