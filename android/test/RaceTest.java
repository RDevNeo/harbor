package dev.harbor.app;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.Executor;

/** A PC's addresses tried staggered, the first to connect winning (Race).
 *  Plain JVM, no Android: build.sh runs it before packaging. */
public class RaceTest {
    private static int failed;

    private static void check(boolean ok, String what) {
        if (!ok) { failed++; System.err.println("FAIL " + what); }
    }

    private static final Executor THREADS = r -> new Thread(r).start();

    private static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException ignored) { }
    }

    public static void main(String[] args) throws Exception {
        List<Integer> started = Collections.synchronizedList(new ArrayList<>());
        List<String> dropped = Collections.synchronizedList(new ArrayList<>());

        // The first answers at once: the others never start.
        String w = Race.first(3, 200, THREADS, i -> { started.add(i); return "a" + i; }, dropped::add);
        check("a0".equals(w), "the first wins");
        sleep(300);
        check(started.size() == 1, "nothing else started: " + started);

        // The first hangs (a stale address): the second starts after the stagger and wins long
        // before the first's timeout.
        started.clear();
        long t0 = System.currentTimeMillis();
        w = Race.first(2, 150, THREADS, i -> {
            started.add(i);
            if (i == 0) { sleep(2_000); return "late"; }
            return "b" + i;
        }, dropped::add);
        long took = System.currentTimeMillis() - t0;
        check("b1".equals(w), "the second wins: " + w);
        check(took >= 140 && took < 1_000, "after the stagger, not the timeout: " + took + " ms");
        sleep(2_200);
        check(dropped.contains("late"), "the first's late connection is dropped: " + dropped);

        // One that fails fast lets the next start at once.
        started.clear();
        t0 = System.currentTimeMillis();
        w = Race.first(3, 5_000, THREADS, i -> {
            started.add(i);
            if (i < 2) throw new IOException("refused " + i);
            return "c" + i;
        }, dropped::add);
        took = System.currentTimeMillis() - t0;
        check("c2".equals(w), "the third wins: " + w);
        check(took < 1_000, "no stagger waited after failures: " + took + " ms");

        // All fail: every error, in the addresses' order.
        try {
            Race.<String>first(3, 50, THREADS, i -> { sleep(30 * (3 - i)); throw new IOException("e" + i); }, dropped::add);
            check(false, "all failed: throws");
        } catch (Race.Lost l) {
            check(l.errors.size() == 3, "three errors: " + l.errors.size());
            check("e0".equals(l.errors.get(0).getMessage()) && "e2".equals(l.errors.get(2).getMessage()), "in order");
            check("e2".equals(l.getMessage()), "says the last address's error");
        }

        // A runtime error counts as a failure, not a crash.
        w = Race.first(2, 50, THREADS, i -> { if (i == 0) throw new IllegalStateException("bug"); return "d" + i; }, dropped::add);
        check("d1".equals(w), "after a runtime error, the next: " + w);

        // One address: just it.
        w = Race.first(1, 50, THREADS, i -> "only", dropped::add);
        check("only".equals(w), "one address");
        try {
            Race.first(0, 50, THREADS, i -> "x", dropped::add);
            check(false, "no address: throws");
        } catch (Race.Lost l) {
            check(l.errors.isEmpty(), "no errors to tell");
        }

        if (failed > 0) {
            System.err.println(failed + " race check(s) failed");
            System.exit(1);
        }
        System.out.println("RaceTest: ok");
    }
}
