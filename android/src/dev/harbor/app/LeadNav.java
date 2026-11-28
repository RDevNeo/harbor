package dev.harbor.app;

import java.util.List;

/** Collector's way through a list from a lead's detail (pure, no Android: LeadNavTest). The PC's nextLead, stepLead and
 *  leadAfterSend (ts/packages/ui/src/tabs/collector/ui.ts). */
final class LeadNav {
    private LeadNav() { }

    /** The lead after `current` in `queue` that is still in `live` (the review bar's next); null at the end. */
    static String nextLead(List<String> queue, String current, List<String> live) {
        int at = queue.indexOf(current);
        if (at < 0) return null;
        for (int i = at + 1; i < queue.size(); i++) if (!queue.get(i).equals(current) && live.contains(queue.get(i))) return queue.get(i);
        return null;
    }

    /** Previous (-1) / next (+1) in the list as it was opened (leads that left it too); null at either end. */
    static String step(List<String> queue, String current, int dir) {
        int at = queue.indexOf(current);
        if (at < 0 || dir == 0) return null;
        int to = at + (dir < 0 ? -1 : 1);
        return to < 0 || to >= queue.size() ? null : queue.get(to);
    }

    /** After a send from a lead's detail: the next lead of its list still in it (the one right after, never one further,
     *  though the lead sent to may have just left the list for Sent), "" at the end (back to the list), null when the
     *  detail wasn't opened from a list (it stays). */
    static String afterSend(List<String> queue, String current, List<String> live) {
        if (!queue.contains(current)) return null;
        String n = nextLead(queue, current, live);
        return n == null ? "" : n;
    }
}
