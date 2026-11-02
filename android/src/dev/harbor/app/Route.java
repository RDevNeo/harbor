package dev.harbor.app;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Which PC of a workspace the phone's calls go to (Hub), and when that changes. Plain Java,
 *  no Android: android/test/RouteTest.java runs it on the JVM.
 *
 *  Any PC of a workspace answers (they share their chats), so a call can go to any one that can
 *  be reached; the point is not to hop between them on a flaky network. A hop costs a full
 *  refresh (each PC counts its own event revisions) and, before 0.111, said so with a toast.
 *
 *  - The PC in use stays in use until it fails LEAVE_AFTER times in a row (a connection that
 *    couldn't be made, or dropped mid-call) with nothing answering in between, or once when the
 *    failure is certain (it refused the connection: Harbor isn't running there).
 *  - Below that, a call it can't take may still go to another PC, that once (a fallback): the
 *    PC in use doesn't change.
 *  - Away from the workspace's first PC ("", the "home"), that one is probed quietly in the
 *    background; calls go back to it after RETURN_AFTER probes in a row answered. Each time the
 *    phone has to leave home again soon after coming back, the probes wait twice as long (up
 *    to PROBE_MAX), so a PC that keeps dropping out doesn't pull the phone back and forth.
 *
 *  Times are passed in (ms), so tests can run it on their own clock. */
final class Route {
    static final int LEAVE_AFTER = 2;
    /** A PC that was left (or failed for certain) goes to the end of the list this long. */
    static final long DOWN_FOR = 60_000;
    static final int RETURN_AFTER = 2;
    static final long PROBE_EVERY = 30_000;
    static final long PROBE_MAX = 30 * 60_000;
    /** Leaving home this soon after coming back counts as a flap: probes slow down. */
    static final long FLAP_WITHIN = 10 * 60_000;

    private String cur;
    private final Map<String, Integer> fails = new HashMap<>();
    private final Map<String, Long> downAt = new HashMap<>();
    private int homeOk;
    private long probedAt;
    private long probeEvery = PROBE_EVERY;
    private long backAt = -1; // when calls last went back home

    Route(String cur, long now) {
        this.cur = cur == null ? "" : cur;
        probedAt = now; // the first probe waits a full interval
    }

    /** The PC calls go to ("" = the workspace's first one). */
    synchronized String current() { return cur; }

    /** The PC in use failed too often to stay: calls look for another one. */
    synchronized boolean leaving() { return failsOf(cur) >= LEAVE_AFTER; }

    /** The order to try the PCs in for one call. all: every PC of the workspace ("" first).
     *  stick: only the PC in use, unless it is being left (the events long-poll: each PC has its
     *  own revisions, so a one-off answer from another would cost two full refreshes). */
    synchronized List<String> order(List<String> all, boolean stick, long now) {
        List<String> out = new ArrayList<>();
        boolean leave = failsOf(cur) >= LEAVE_AFTER;
        if (!leave) out.add(cur);
        if (stick && !leave) return out;
        List<String> later = new ArrayList<>();
        // Home first among the others (its chats are the workspace's own), then the rest in the
        // directory's order; those that were down a moment ago last.
        List<String> rest = new ArrayList<>();
        if (!cur.isEmpty()) rest.add("");
        for (String v : all) if (!rest.contains(v) && !v.equals(cur)) rest.add(v);
        for (String v : rest) (isDown(v, now) ? later : out).add(v);
        out.addAll(later);
        if (leave) out.add(cur); // still worth a last try: maybe it was the network
        return out;
    }

    /** v was reached (its TLS handshake, pinned to its key, went through). True when calls
     *  move to it from now on. */
    synchronized boolean reached(String v, long now) {
        fails.remove(v);
        downAt.remove(v);
        if (v.equals(cur)) return false;
        if (failsOf(cur) < LEAVE_AFTER) return false; // a fallback for this one call
        if (cur.isEmpty() && backAt >= 0 && now - backAt < FLAP_WITHIN) probeEvery = Math.min(PROBE_MAX, probeEvery * 2);
        else if (cur.isEmpty()) probeEvery = PROBE_EVERY;
        downAt.put(cur, now);
        cur = v;
        homeOk = 0;
        probedAt = now;
        return true;
    }

    /** v couldn't be reached, or dropped a call. certain: it refused the connection (the PC
     *  is up, Harbor isn't running there), which a flaky network doesn't do. */
    synchronized void failed(String v, boolean certain, long now) {
        int n = failsOf(v) + 1;
        if (certain) n = Math.max(n, LEAVE_AFTER);
        fails.put(v, n);
        if (n >= LEAVE_AFTER) downAt.put(v, now);
    }

    /** Away from home, and time for a quiet probe of it. Each true is one probe: report it
     *  with probed(). */
    synchronized boolean probeDue(long now) {
        if (cur.isEmpty() || now - probedAt < probeEvery) return false;
        probedAt = now;
        return true;
    }

    /** A probe of home answered (or didn't). True when calls go back home now. */
    synchronized boolean probed(boolean answered, long now) {
        if (cur.isEmpty()) return false;
        if (!answered) { homeOk = 0; return false; }
        fails.remove("");
        downAt.remove("");
        homeOk++;
        if (homeOk < RETURN_AFTER) {
            probedAt = now - probeEvery + Math.min(probeEvery, PROBE_EVERY) / 3; // the next one soon
            return false;
        }
        cur = "";
        homeOk = 0;
        backAt = now;
        return true;
    }

    /** Back to the workspace's first PC (its directory changed, the user asked). */
    synchronized void reset(String v) {
        cur = v == null ? "" : v;
        fails.clear();
        downAt.clear();
        homeOk = 0;
    }

    synchronized long probeEvery() { return probeEvery; }

    // ---- the events long-poll (Base) ----

    /** Polls in a row that may fail quietly before the offline card shows: a blip on the way,
     *  or the PC in use going away while another takes over, says nothing. */
    static final int OFFLINE_AFTER = 3;

    /** The wait before the next poll after `fails` failed in a row: quick at first (most blips
     *  last under a second), then slower, at most 10 s. */
    static long retryDelay(int fails) {
        return Math.min(10_000, 500L << Math.min(5, Math.max(0, fails - 1)));
    }

    /** Whether a failed poll shows the offline card. answered: the PC itself said no (an error,
     *  a refused sign-in), which is said at once; the network only after OFFLINE_AFTER in a row. */
    static boolean showsOffline(boolean answered, int fails) {
        return answered || fails >= OFFLINE_AFTER;
    }

    private int failsOf(String v) {
        Integer n = fails.get(v);
        return n == null ? 0 : n;
    }

    private boolean isDown(String v, long now) {
        Long t = downAt.get(v);
        return t != null && now - t < DOWN_FOR;
    }
}
