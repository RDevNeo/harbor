package dev.harbor.app;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** A message shows the moment it's sent and goes once the chat has it (Echo).
 *  Plain JVM, no Android: build.sh runs it before packaging. */
public class EchoTest {
    private static int failed;

    private static void check(boolean ok, String what) {
        if (!ok) { failed++; System.err.println("FAIL " + what); }
    }

    private static void same(Object got, Object want, String what) {
        check(String.valueOf(got).equals(String.valueOf(want)), what + ": got " + got + ", want " + want);
    }

    private static Echo.Seen card(int seq, String text) { return new Echo.Seen(seq, text); }

    private static List<String> texts(Echo e) {
        List<String> out = new ArrayList<>();
        for (Echo.Msg m : e.shown()) out.add(m.text + ":" + m.state);
        return out;
    }

    public static void main(String[] args) {
        long t = 1_000_000;

        // Sent: shown at once, faint until the PC accepts it, gone when its card comes.
        Echo e = new Echo();
        Echo.Msg a = e.add("c1", "  hello  ", "{}", t, 5);
        same(texts(e), Arrays.asList("hello:" + Echo.SENDING), "shown at once, trimmed");
        check(e.waiting(), "waits for its card");
        check(e.sent("c1", t + 200), "accepted");
        same(a.state, Echo.SENT, "sent");
        // An older card with the same text isn't this one's.
        check(!e.settle(Arrays.asList(card(3, "hello")), t + 300), "an earlier card with the same text: still shown");
        check(e.settle(Arrays.asList(card(3, "hello"), card(5, "hello")), t + 400), "its card came: gone");
        check(e.isEmpty() && !e.waiting(), "nothing left");
        check(!e.sent("c1", t + 500), "a late answer for a message already on the chat: nothing to do");

        // Queued while the agent works: its place in the queue is its card.
        Echo q = new Echo();
        q.add("c2", "next", "{}", t, 9);
        check(q.settle(Arrays.asList(card(-1, "next")), t + 100), "in the queue: gone");

        // Two the same: each card takes one, the oldest first.
        Echo two = new Echo();
        two.add("c3", "ok", "{}", t, 10);
        two.add("c4", "ok", "{}", t + 1, 10);
        two.sent("c3", t + 2);
        two.sent("c4", t + 3);
        check(two.settle(Arrays.asList(card(10, "ok")), t + 4), "one card: one goes");
        same(two.shown().size(), 1, "the other stays");
        same(two.shown().get(0).cid, "c4", "the newer one stays");
        check(two.settle(Arrays.asList(card(10, "ok"), card(11, "ok")), t + 5), "its own card");
        check(two.isEmpty(), "both gone");

        // Accepted but no card comes (a slash command, another PC's copy slow to arrive):
        // at most SENT_FOR.
        Echo slow = new Echo();
        slow.add("c5", "/compact", "{}", t, 0);
        slow.sent("c5", t);
        check(!slow.settle(new ArrayList<>(), t + Echo.SENT_FOR - 1), "kept a while");
        check(slow.settle(new ArrayList<>(), t + Echo.SENT_FOR), "then it goes");

        // Sending doesn't time out: it waits for the PC's answer (Hub.send tries again).
        Echo going = new Echo();
        going.add("c6", "hi", "{}", t, 0);
        check(!going.settle(new ArrayList<>(), t + 10 * Echo.SENT_FOR), "sending: shown until answered");
        // Its card came although the answer didn't (it got lost on the way back): it did arrive.
        check(going.settle(Arrays.asList(card(0, "hi")), t + 11 * Echo.SENT_FOR), "its card came: gone while sending");

        // Not sent: kept with its why, never dropped by time; Retry sends the same message again.
        Echo no = new Echo();
        Echo.Msg n = no.add("c7", "important", "{\"client_id\":\"c7\"}", t, 0);
        check(no.failed("c7", "desk is offline"), "failed");
        same(n.why, "desk is offline", "why");
        check(!no.settle(new ArrayList<>(), t + 100 * Echo.SENT_FOR), "not sent: kept");
        check(!no.waiting(), "nothing to wait for while not sent");
        check(no.retry("c7"), "retry");
        same(n.state, Echo.SENDING, "sending again");
        same(n.cid, "c7", "the same client id (the PC runs it once)");
        check(!no.retry("c7"), "retry only from not sent");
        no.failed("c7", "x");
        check(no.settle(Arrays.asList(card(0, "important")), t), "not sent, but its card came (the answer was lost): gone");

        // Delete / Edit take it off.
        Echo del = new Echo();
        del.add("c8", "oops", "{}", t, 0);
        del.failed("c8", "");
        check(del.remove("c8") && del.isEmpty(), "deleted");

        // Back from disk: what was under way goes again while it's recent; old ones say they
        // may not have been sent; accepted ones are the chat's.
        Echo back = new Echo();
        List<Echo.Msg> saved = Arrays.asList(
                new Echo.Msg("r1", "recent", "{}", t, 0, Echo.SENDING),
                new Echo.Msg("r2", "old", "{}", t - Echo.RESEND_WITHIN, 0, Echo.SENDING),
                new Echo.Msg("r3", "accepted", "{}", t, 0, Echo.SENT),
                new Echo.Msg("r4", "failed", "{}", t, 0, Echo.FAILED));
        List<Echo.Msg> again = back.restore(saved, t);
        same(again.size(), 1, "one goes again");
        same(again.get(0).cid, "r1", "the recent one");
        same(texts(back), Arrays.asList("recent:" + Echo.SENDING, "old:" + Echo.FAILED, "failed:" + Echo.FAILED), "restored");

        if (failed > 0) {
            System.err.println(failed + " echo check(s) failed");
            System.exit(1);
        }
        System.out.println("EchoTest: ok");
    }
}
