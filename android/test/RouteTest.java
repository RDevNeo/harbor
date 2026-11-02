package dev.harbor.app;

import java.util.Arrays;
import java.util.List;

/** Which PC the phone's calls go to (Route): a flaky network must not move them back and forth.
 *  Plain JVM, no Android: build.sh runs it before packaging. */
public class RouteTest {
    private static int failed;

    private static void check(boolean ok, String what) {
        if (!ok) { failed++; System.err.println("FAIL " + what); }
    }

    private static void same(Object got, Object want, String what) {
        check(String.valueOf(got).equals(String.valueOf(want)), what + ": got " + got + ", want " + want);
    }

    // The workspace: "" its first PC (home), then two more.
    private static final List<String> ALL = Arrays.asList("", "fp:desk", "fp:laptop");

    public static void main(String[] args) {
        long t = 1_000_000;

        // At home, nothing wrong: home only for the poll, home first for a call.
        Route r = new Route("", t);
        same(r.current(), "", "starts home");
        same(r.order(ALL, true, t), Arrays.asList(""), "poll: only the PC in use");
        same(r.order(ALL, false, t), ALL, "call: the PC in use, then the others");

        // One blip (a connection that couldn't be made) moves nothing, even when another PC took
        // that one call.
        r.failed("", false, t);
        check(!r.leaving(), "one failure: not leaving");
        same(r.order(ALL, true, t), Arrays.asList(""), "poll after a blip: still home only");
        check(!r.reached("fp:desk", t), "a fallback for one call doesn't move");
        same(r.current(), "", "still home after the fallback");
        // It answers again: the count starts over.
        check(!r.reached("", t), "reached the PC in use");
        r.failed("", false, t + 1);
        check(!r.leaving(), "failures with an answer between them don't add up");

        // Two in a row: leave. The poll may now go elsewhere; the old PC is tried last.
        r.failed("", false, t + 2);
        check(r.leaving(), "two failures in a row: leaving");
        same(r.order(ALL, true, t + 2), Arrays.asList("fp:desk", "fp:laptop", ""), "leaving: the others, then the PC in use");
        check(r.reached("fp:desk", t + 3), "the first that answers takes over");
        same(r.current(), "fp:desk", "calls go to desk");
        same(r.order(ALL, true, t + 3), Arrays.asList("fp:desk"), "poll sticks to desk");
        same(r.order(ALL, false, t + 3), Arrays.asList("fp:desk", "fp:laptop", ""), "home (just left) goes last for a while");
        same(r.order(ALL, false, t + 3 + Route.DOWN_FOR), Arrays.asList("fp:desk", "", "fp:laptop"), "then home comes first among the others again");

        // Refused (Harbor isn't running there) is certain: one is enough.
        Route q = new Route("", t);
        q.failed("", true, t);
        check(q.leaving(), "a refusal: leaving at once");
        check(q.reached("fp:laptop", t), "and the next that answers takes over");

        // Back home only through the quiet probes: none before the interval, then two that
        // answer in a row.
        check(!r.probeDue(t + 3 + Route.PROBE_EVERY - 1), "no probe before the interval");
        long p1 = t + 3 + Route.PROBE_EVERY;
        check(r.probeDue(p1), "probe due after the interval");
        check(!r.probeDue(p1), "one probe at a time");
        check(!r.probed(true, p1), "one answer isn't enough");
        same(r.current(), "fp:desk", "still on desk after one good probe");
        long p2 = p1 + Route.PROBE_EVERY / 3;
        check(r.probeDue(p2), "the second probe comes sooner");
        check(r.probed(true, p2), "two in a row: back home");
        same(r.current(), "", "home again");
        check(!r.probeDue(p2 + Route.PROBE_MAX), "no probes while home");

        // A probe that fails starts the count over.
        Route s = new Route("fp:desk", t);
        long a = t + Route.PROBE_EVERY;
        check(s.probeDue(a), "probe due");
        check(!s.probed(true, a), "first good probe");
        long b = a + Route.PROBE_EVERY / 3;
        check(s.probeDue(b), "second probe due");
        check(!s.probed(false, b), "a failed probe: stay");
        long c = b + Route.PROBE_EVERY;
        check(s.probeDue(c), "probe due again");
        check(!s.probed(true, c), "one good probe after a failed one isn't enough");
        same(s.current(), "fp:desk", "still away");

        // Flapping: leaving home soon after coming back doubles the wait for the next probe, up
        // to PROBE_MAX; a calm stretch at home starts it over.
        Route f = new Route("", t);
        long now = t;
        long want = Route.PROBE_EVERY;
        for (int i = 0; i < 12; i++) {
            f.failed("", false, now);
            f.failed("", false, now);
            check(f.reached("fp:desk", now), "flap " + i + ": left home");
            same(f.probeEvery(), want, "flap " + i + ": probe interval");
            now += f.probeEvery();
            check(f.probeDue(now), "flap " + i + ": probe due");
            check(!f.probed(true, now), "flap " + i + ": first good probe");
            now += Route.PROBE_EVERY / 3;
            check(f.probeDue(now), "flap " + i + ": second probe due");
            check(f.probed(true, now), "flap " + i + ": back home");
            now += 1_000; // and the network drops again soon after
            want = Math.min(Route.PROBE_MAX, want * 2);
        }
        same(f.probeEvery(), Route.PROBE_MAX, "flapping: probes at most every PROBE_MAX");
        now += Route.FLAP_WITHIN;
        f.failed("", false, now);
        f.failed("", false, now);
        check(f.reached("fp:desk", now), "left home after a calm stretch");
        same(f.probeEvery(), Route.PROBE_EVERY, "a calm stretch: probes at the usual pace again");

        // A one-PC workspace: the poll keeps asking it, failed or not.
        Route one = new Route("", t);
        List<String> solo = Arrays.asList("");
        one.failed("", false, t);
        one.failed("", false, t);
        same(one.order(solo, true, t), solo, "one PC: always it");
        check(!one.probeDue(t + Route.PROBE_MAX), "one PC at home: no probes");

        // A PC that isn't in the workspace anymore: Hub resets to home.
        Route gone = new Route("fp:old", t);
        gone.reset("");
        same(gone.current(), "", "reset: home");
        check(!gone.leaving(), "reset: nothing failed");

        // The poll: quiet for the first failures, the offline card after OFFLINE_AFTER; an
        // answer from the PC at once.
        check(!Route.showsOffline(false, 1) && !Route.showsOffline(false, Route.OFFLINE_AFTER - 1), "network blips: quiet");
        check(Route.showsOffline(false, Route.OFFLINE_AFTER), "network failing: the offline card");
        check(Route.showsOffline(true, 1), "the PC said no: at once");
        same(Route.retryDelay(1), 500, "first retry soon");
        same(Route.retryDelay(2), 1000, "then doubling");
        same(Route.retryDelay(3), 2000, "then doubling again");
        same(Route.retryDelay(50), 10000, "at most 10 s");
        check(Route.retryDelay(0) > 0, "never zero");

        if (failed > 0) {
            System.err.println(failed + " route check(s) failed");
            System.exit(1);
        }
        System.out.println("RouteTest: ok");
    }
}
