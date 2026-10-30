package dev.harbor.app;

/** Which of a chat's cards the image viewer browses together, the desktop's rule (view.rs
 *  `turn`, PROTOCOL.md): a speaker's card alone, any other with the rest of its agent's turn. */
final class Turn {
    private Turn() {}

    /** Whether a card is someone else speaking: a person's message, another agent's message or
     *  report. An agent's images never browse together across one. */
    static boolean speaker(String kind, String icon) {
        return "user".equals(kind) || "message".equals(kind) || "notice".equals(kind) && ("report".equals(icon) || "bot".equals(icon));
    }

    /** The cards {first, end} that browse with card {@code at}, given which ones are speakers. */
    static int[] range(boolean[] speakers, int at) {
        if (speakers[at]) return new int[]{at, at + 1};
        int first = at, end = at;
        while (first > 0 && !speakers[first - 1]) first--;
        while (end < speakers.length && !speakers[end]) end++;
        return new int[]{first, end};
    }
}
