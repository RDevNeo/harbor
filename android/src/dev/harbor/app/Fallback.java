package dev.harbor.app;

import java.util.ArrayList;
import java.util.List;

/** When no PC of a workspace answers (its only PC is off, say), the phone carries on on a PC of
 *  another workspace the account is in: Fagner's Mac in Fagner's Workspace, where its owner
 *  invited this account. Each workspace is its own Hub; this decides which of the other ones'
 *  PCs are offered, in what order, whether the phone moves there by itself, and what it says.
 *  Away does the probing and the moving. Plain JVM, no Android: android/test/FallbackTest.java.
 *
 *  Offered: a PC that answered and lets this account start chats there (its `/v1/state` `guest`:
 *  its owner's Settings › Workspace levels; a PC that doesn't say, or the account's own, does).
 *  The PC used instead last time comes first, then the directory's order. */
final class Fallback {
    private Fallback() { }

    /** After the user went back to (or stayed on) a workspace whose PCs are off, the phone doesn't
     *  move away from it by itself for this long: the offline card still offers the others. */
    static final long STAY_MS = 30 * 60_000L;

    /** One PC of another workspace, as a probe found it. */
    static final class Pc {
        final String hub;  // its Hub entry ("ws:<id>")
        final String ws;   // its workspace's name
        final String pid;  // "" that Hub's first PC, else one of its endpoints' mesh id
        final String name; // the PC's name
        final int order;   // the directory's order
        boolean answered;
        boolean start = true; // lets this account start chats there
        String why = "";      // why not, as the PC says it
        String level = "";    // its owner's level for this account ("" none: no limit)

        Pc(String hub, String ws, String pid, String name, int order) {
            this.hub = hub; this.ws = ws; this.pid = pid; this.name = name; this.order = order;
        }

        String key() { return hub + "/" + pid; }

        @Override public String toString() { return name; }
    }

    /** The PCs to offer, best first: those that answered and let this account start chats; the
     *  one used last (`last`, a key) first, then the directory's order. One per PC name (a PC
     *  listed by two workspaces). */
    static List<Pc> offered(List<Pc> probed, String last) {
        List<Pc> out = new ArrayList<>();
        for (Pc p : probed) if (p.answered && p.start) out.add(p);
        out.sort((a, b) -> {
            boolean la = a.key().equals(last), lb = b.key().equals(last);
            if (la != lb) return la ? -1 : 1;
            return Integer.compare(a.order, b.order);
        });
        List<Pc> once = new ArrayList<>();
        List<String> names = new ArrayList<>();
        for (Pc p : out) if (!names.contains(p.name)) { names.add(p.name); once.add(p); }
        return once;
    }

    /** Whether the phone moves to the first offered PC by itself: something is offered, and the
     *  user didn't stay on this workspace within STAY_MS (`stayAt`, 0: never). */
    static boolean auto(int offered, long stayAt, long now) {
        return offered > 0 && (stayAt <= 0 || now - stayAt > STAY_MS);
    }

    /** `guest.start` of a PC's state: null (the PC doesn't say: older, or the account's own) is yes. */
    static boolean mayStart(Boolean start) { return start == null || start; }

    /** The picker's line under the offline card's title. */
    static String pickLine(List<Pc> offered, boolean probing) {
        if (offered.isEmpty()) return probing ? "Looking for another PC you can use…" : "No other PC of your workspaces is on and lets you start chats.";
        return offered.size() == 1 ? "Use this PC of another workspace meanwhile:" : "Use one of these PCs of your other workspaces meanwhile:";
    }

    /** A PC's button in the picker: "Fagners-MacBook-Air · Fagner's Workspace". */
    static String button(Pc p) { return p.ws.isEmpty() ? p.name : p.name + " · " + p.ws; }

    /** The toast when the phone moved by itself. */
    static String moved(String off, Pc to) { return off + " is off: using " + to.name + "."; }

    /** The banner on the PC used instead: its title and line. `back`: the PC that was off answers again. */
    static String usingTitle(String pc, String off, boolean back) {
        return back ? off + " is back" : "Using " + pc + " while " + off + " is off";
    }

    static String usingLine(String pc, String homeWs, String level, boolean back) {
        String lim = "read".equals(level) ? " Its owner lets your chats only read there." : "edit".equals(level) ? " Its owner lets your chats only edit files there." : "";
        if (back) return "Switch back to " + homeWs + " when you like.";
        return "Chats you start now run on " + pc + "." + lim;
    }
}
