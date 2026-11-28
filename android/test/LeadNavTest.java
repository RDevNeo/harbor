package dev.harbor.app;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** Collector's lead detail: ← / → and the next lead after a send (LeadNav). Plain JVM, no Android. */
public class LeadNavTest {
    private static int failed;

    private static void same(Object got, Object want, String what) {
        if (!String.valueOf(got).equals(String.valueOf(want))) { failed++; System.err.println("FAIL " + what + ": got " + got + ", want " + want); }
    }

    public static void main(String[] args) {
        List<String> q = Arrays.asList("a", "b", "c");
        same(LeadNav.step(q, "b", -1), "a", "previous");
        same(LeadNav.step(q, "b", 1), "c", "next");
        same(LeadNav.step(q, "a", -1), null, "nothing before the first");
        same(LeadNav.step(q, "c", 1), null, "nothing after the last");
        same(LeadNav.step(new ArrayList<>(), "a", 1), null, "not opened from a list");
        // "49 of 190": 49 was sent to and left the list (Sent); the next is 50, never 51
        List<String> all = new ArrayList<>();
        for (int i = 1; i <= 190; i++) all.add("l" + i);
        List<String> live = new ArrayList<>(all);
        live.remove("l49");
        same(LeadNav.afterSend(all, "l49", live), "l50", "after a send: the one after it");
        same(LeadNav.afterSend(all, "l49", all), "l50", "in Sent it stays in the list: still the one after");
        same(LeadNav.afterSend(all, "l190", all.subList(0, 189)), "", "the last one: back to the list");
        same(LeadNav.afterSend(new ArrayList<>(), "l1", all), null, "not from a list: stays");
        same(LeadNav.nextLead(q, "a", Arrays.asList("a", "c")), "c", "the review bar passes over one that left");
        if (failed > 0) { System.err.println(failed + " failed"); System.exit(1); }
    }
}
