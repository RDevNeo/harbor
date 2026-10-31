package dev.harbor.app;

import java.util.ArrayList;
import java.util.BitSet;
import java.util.List;

/** Which parts of a video are here while it arrives ({@link Stream}), and the sums around it. No
 *  Android in here: it runs in the build's unit tests. */
final class Blocks {
    static final int SIZE = 1 << 16;
    private final BitSet have = new BitSet();
    private final long total;
    private final int count;

    Blocks(long total) {
        this.total = total;
        count = (int) ((total + SIZE - 1) / SIZE);
    }

    private static int at(long pos) { return (int) (pos / SIZE); }

    boolean has(long pos) { return pos >= 0 && pos < total && have.get(at(pos)); }

    void mark(long pos) { have.set(at(pos)); }

    boolean complete() { return have.nextClearBit(0) >= count; }

    /** How many bytes from pos are here in a row, at most size. */
    int run(long pos, int size) {
        if (!has(pos)) return 0;
        long end = have.nextClearBit(at(pos)) * (long) SIZE;
        return (int) Math.min(size, Math.min(end, total) - pos);
    }

    /** Where the first block missing at or after pos starts, else the first missing at all, -1
     *  when none is. */
    long missing(long pos) {
        int i = have.nextClearBit(at(Math.max(0, pos)));
        if (i >= count) i = have.nextClearBit(0);
        return i >= count ? -1 : i * (long) SIZE;
    }

    /** The bytes of the block at pos, which ends the file short. */
    int length(long pos) { return (int) Math.min(SIZE, total - pos); }

    /** A `Content-Range: bytes N-M/total` header's total, -1 without one. */
    static long total(String range) {
        if (range == null) return -1;
        int slash = range.lastIndexOf('/');
        if (slash < 0) return -1;
        try { return Long.parseLong(range.substring(slash + 1).trim()); } catch (NumberFormatException e) { return -1; }
    }

    /** "1:05", or "1:02:05" past an hour, like the desktop's. */
    static String clock(long ms) {
        long s = Math.max(0, ms) / 1000;
        return s >= 3600 ? String.format(java.util.Locale.ROOT, "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60)
                : String.format(java.util.Locale.ROOT, "%d:%02d", s / 60, s % 60);
    }

    /** One cached file. */
    static final class Kept {
        final String name; final long size, used;
        Kept(String name, long size, long used) { this.name = name; this.size = size; this.used = used; }
    }

    /** What to delete so the files fit cap: the least recently used, never {@code keep}. */
    static List<String> over(List<Kept> files, long cap, String keep) {
        List<Kept> old = new ArrayList<>(files);
        old.sort((a, b) -> Long.compare(a.used, b.used));
        long sum = 0;
        for (Kept k : old) sum += k.size;
        List<String> out = new ArrayList<>();
        for (Kept k : old) {
            if (sum <= cap) break;
            if (k.name.equals(keep)) continue;
            out.add(k.name);
            sum -= k.size;
        }
        return out;
    }
}
