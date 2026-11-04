package dev.harbor.app;

/** The video player's double-tap seek ({@link Video#jump}): 5 s back on the picture's left half,
 *  5 s on on its right, as the desktop's ← and →. Double taps in a row add up: each goes on from
 *  where the last one went (the player may not be there yet), and the mark shows the sum.
 *  Plain Java, no Android, so it's tested on the JVM (JumpTest). */
final class Jump {
    /** How far one double tap seeks, in ms. */
    static final int BY = 5000;
    /** Double taps this close together are a streak, in ms. */
    static final long STREAK = 1000;

    /** Where the last one went, which way, the streak's sum (ms) and when. */
    int to, dir, sum;
    private long at = Long.MIN_VALUE / 2;

    /** A double tap (dir −1 or 1) at time {@code now}, the player at {@code position} of
     *  {@code duration} ms: where to seek, between the start and the end. */
    int tap(int dir, long position, long duration, long now) {
        boolean streak = now - at < STREAK;
        long from = streak ? to : position;
        sum = streak && dir == this.dir ? sum + BY : BY;
        this.dir = dir;
        to = (int) Math.max(0, Math.min(duration, from + (long) dir * BY));
        at = now;
        return to;
    }

    /** Another video: the next double tap starts afresh. */
    void reset() { at = Long.MIN_VALUE / 2; }

    /** The mark on the tapped side: "−5 s", "+15 s". */
    String mark() { return (dir < 0 ? "−" : "+") + (sum / 1000) + " s"; }
}
