package dev.harbor.app;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Iterator;
import java.util.List;

/** Messages this phone sent in a chat that the chat doesn't show yet (Chat draws them under the
 *  transcript as the user's bubbles): one appears the moment Send is pressed, and goes once the
 *  PC's own card for it (or its place in the queue) arrives. Before, the composer kept the text
 *  and nothing showed until the PC answered and the chat was read again, seconds on a slow way.
 *
 *  A message is SENDING until the PC answers, SENT once it accepted it (until its card comes;
 *  at most SENT_FOR), FAILED when it couldn't be sent: kept, with Retry (the same client id, so
 *  a send that did arrive isn't run twice), Edit and Delete. Nothing typed is lost: Chat keeps
 *  the list on disk until each message is on the chat.
 *
 *  Plain Java, no Android: android/test/EchoTest.java runs it on the JVM. Times are passed in. */
final class Echo {
    static final int SENDING = 0, SENT = 1, FAILED = 2;
    /** An accepted message whose card hasn't come (a copy of another PC's chat waits for it to
     *  arrive; a slash command makes none): shown this long at most. */
    static final long SENT_FOR = 10_000;
    /** A send that was under way when the app was closed: tried again on reopening while it's
     *  younger than this (the PC still knows its client id), else shown as not sent. */
    static final long RESEND_WITHIN = 5 * 60_000;

    static final class Msg {
        final String cid, text, body;
        final long at;
        /** The chat's next card when it was sent: only cards from there on can be its own. */
        final int seq;
        int state;
        long ackAt;
        String why = "";

        Msg(String cid, String text, String body, long at, int seq, int state) {
            this.cid = cid; this.text = text; this.body = body; this.at = at; this.seq = seq; this.state = state;
        }
    }

    /** A user card of the chat, or a message in its queue (seq -1: it has no card yet). */
    static final class Seen {
        final int seq;
        final String text;
        Seen(int seq, String text) { this.seq = seq; this.text = text; }
    }

    private final List<Msg> list = new ArrayList<>();

    Msg add(String cid, String text, String body, long now, int seq) {
        Msg m = new Msg(cid, norm(text), body, now, seq, SENDING);
        list.add(m);
        return m;
    }

    /** Back from disk: what was under way goes again (true in the result's state SENDING) while
     *  it's recent, else it's shown as not sent; what was accepted is left to the chat. */
    List<Msg> restore(List<Msg> saved, long now) {
        List<Msg> again = new ArrayList<>();
        for (Msg m : saved) {
            if (m.state == SENT) continue;
            if (m.state == SENDING && now - m.at >= RESEND_WITHIN) { m.state = FAILED; m.why = "It may not have been sent."; }
            list.add(m);
            if (m.state == SENDING) again.add(m);
        }
        return again;
    }

    Msg get(String cid) {
        for (Msg m : list) if (m.cid.equals(cid)) return m;
        return null;
    }

    /** The PC accepted it. False when it's gone already (its card came first). */
    boolean sent(String cid, long now) {
        Msg m = get(cid);
        if (m == null) return false;
        m.state = SENT;
        m.ackAt = now;
        return true;
    }

    boolean failed(String cid, String why) {
        Msg m = get(cid);
        if (m == null) return false;
        m.state = FAILED;
        m.why = why == null ? "" : why;
        return true;
    }

    /** Retry: sending again. */
    boolean retry(String cid) {
        Msg m = get(cid);
        if (m == null || m.state != FAILED) return false;
        m.state = SENDING;
        m.why = "";
        return true;
    }

    boolean remove(String cid) {
        return list.remove(get(cid));
    }

    /** What the chat shows now: each user card or queued message (with the same text, from the
     *  message's place on) takes one message off, the oldest first; so does SENT_FOR passing
     *  after the PC accepted it. Messages that may still be on their way (sending, or not sent
     *  for a dropped answer) go too when their card comes: they did arrive. True when any went. */
    boolean settle(Collection<Seen> seen, long now) {
        List<Seen> left = new ArrayList<>(seen);
        boolean changed = false;
        for (Iterator<Msg> it = list.iterator(); it.hasNext(); ) {
            Msg m = it.next();
            Seen hit = null;
            for (Seen s : left) {
                if ((s.seq < 0 || s.seq >= m.seq) && norm(s.text).equals(m.text)) { hit = s; break; }
            }
            if (hit != null) {
                left.remove(hit);
                it.remove();
                changed = true;
            } else if (m.state == SENT && now - m.ackAt >= SENT_FOR) {
                it.remove();
                changed = true;
            }
        }
        return changed;
    }

    /** The messages to draw, in the order they were sent. */
    List<Msg> shown() { return new ArrayList<>(list); }

    boolean isEmpty() { return list.isEmpty(); }

    /** Whether one waits for the PC's card (Chat reads the chat again until it comes). */
    boolean waiting() {
        for (Msg m : list) if (m.state != FAILED) return true;
        return false;
    }

    static String norm(String s) { return s == null ? "" : s.trim(); }
}
