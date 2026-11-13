package dev.harbor.app;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** Which PCs of the account's other workspaces the phone offers when its workspace's PCs are
 *  off (Fallback), and when it moves there by itself. Plain JVM, no Android: build.sh runs it. */
public class FallbackTest {
    private static int failed;

    private static void check(boolean ok, String what) {
        if (!ok) { failed++; System.err.println("FAIL " + what); }
    }

    private static void same(Object got, Object want, String what) {
        check(String.valueOf(got).equals(String.valueOf(want)), what + ": got " + got + ", want " + want);
    }

    private static Fallback.Pc pc(String hub, String ws, String pid, String name, int order, boolean answered, boolean start) {
        Fallback.Pc p = new Fallback.Pc(hub, ws, pid, name, order);
        p.answered = answered;
        p.start = start;
        return p;
    }

    public static void main(String[] args) {
        Fallback.Pc mac = pc("ws:fagner", "Fagner's Workspace", "", "Fagners-MacBook-Air", 0, true, true);
        Fallback.Pc lenovo = pc("ws:doggg", "Doggg's Workspace", "", "Filipe-Lenovo", 100, true, true);
        Fallback.Pc off = pc("ws:doggg", "Doggg's Workspace", "ts:tower", "tower", 101, false, true);
        Fallback.Pc no = pc("ws:sam", "Sam's Workspace", "", "sam-pc", 200, true, false);
        List<Fallback.Pc> all = new ArrayList<>(Arrays.asList(lenovo, off, no, mac));

        // Only those that answered and let this account start chats, in the directory's order.
        same(Fallback.offered(all, ""), Arrays.asList(mac, lenovo), "answered and allowed, directory order");
        // The one used last time first.
        same(Fallback.offered(all, "ws:doggg/"), Arrays.asList(lenovo, mac), "the one used last first");
        // Nothing answers: nothing offered.
        same(Fallback.offered(Arrays.asList(off, no), ""), new ArrayList<>(), "none usable");
        // A PC two workspaces list is offered once.
        Fallback.Pc twice = pc("ws:other", "Other", "", "Fagners-MacBook-Air", 300, true, true);
        same(Fallback.offered(Arrays.asList(mac, twice), "").size(), 1, "one PC once");

        // A PC that doesn't say (older, or the account's own) lets this account start chats.
        check(Fallback.mayStart(null), "no guest: may start");
        check(Fallback.mayStart(true) && !Fallback.mayStart(false), "guest.start as said");

        // Moves by itself when something is offered and the user didn't stay lately.
        long now = 10_000_000L;
        check(Fallback.auto(2, 0, now), "auto: never stayed");
        check(!Fallback.auto(0, 0, now), "auto: nothing offered");
        check(!Fallback.auto(1, now - 60_000, now), "auto: stayed a minute ago");
        check(Fallback.auto(1, now - Fallback.STAY_MS - 1, now), "auto: stayed long ago");

        // What it says.
        same(Fallback.button(mac), "Fagners-MacBook-Air · Fagner's Workspace", "button");
        same(Fallback.moved("Igor-Windows", mac), "Igor-Windows is off: using Fagners-MacBook-Air.", "toast");
        same(Fallback.usingTitle("Fagners-MacBook-Air", "Igor-Windows", false), "Using Fagners-MacBook-Air while Igor-Windows is off", "banner");
        same(Fallback.usingTitle("Fagners-MacBook-Air", "Igor-Windows", true), "Igor-Windows is back", "banner, back");
        same(Fallback.usingLine("Fagners-MacBook-Air", "Igor's Workspace", "read", false), "Chats you start now run on Fagners-MacBook-Air. Its owner lets your chats only read there.", "line, read only");
        same(Fallback.usingLine("Fagners-MacBook-Air", "Igor's Workspace", "full", true), "Switch back to Igor's Workspace when you like.", "line, back");
        same(Fallback.pickLine(new ArrayList<>(), true), "Looking for another PC you can use…", "probing");

        if (failed > 0) { System.err.println("FallbackTest: " + failed + " failed"); System.exit(1); }
        System.out.println("FallbackTest ok");
    }
}
