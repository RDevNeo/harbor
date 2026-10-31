package dev.harbor.app;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** What a video knows while it arrives: run on the build's JVM (android/build.sh). */
public final class BlocksTest {
    static int fails;

    static void eq(Object got, Object want, String what) {
        if (!got.equals(want)) { System.out.println("FAIL " + what + ": " + got + " != " + want); fails++; }
    }

    public static void main(String[] args) {
        int s = Blocks.SIZE;
        // 2.5 blocks: the last is short.
        Blocks b = new Blocks(s * 2L + s / 2);
        eq(b.has(0), false, "nothing yet");
        eq(b.missing(0), 0L, "starts at the start");
        b.mark(s);
        eq(b.has(s + 10L), true, "a block counts whole");
        eq(b.has(0), false, "others don't");
        eq(b.run(s + 10L, 100), 100, "a read within it");
        eq(b.run(s + 10L, s * 4), s - 10, "up to its end");
        eq(b.run(0, 10), 0, "nothing where it's missing");
        eq(b.missing(s), s * 2L, "the next missing after a jump");
        b.mark(s * 2L);
        eq(b.has(s * 2L + s / 2 - 1), true, "the file's last byte");
        eq(b.has(s * 2L + s / 2), false, "past the end");
        eq(b.run(s, s * 4), s + s / 2, "stops at the file's end");
        eq(b.missing(s), 0L, "wraps round to what's left before");
        eq(b.length(s * 2L), s / 2, "the last block is short");
        eq(b.complete(), false, "not yet");
        b.mark(0);
        eq(b.complete(), true, "all here");
        eq(b.missing(0), -1L, "nothing left");
        eq(new Blocks(0).complete(), true, "an empty file");

        eq(Blocks.total("bytes 0-99/1000"), 1000L, "a range's total");
        eq(Blocks.total("bytes */1000"), 1000L, "a refused range's total");
        eq(Blocks.total("bytes 0-99/*"), -1L, "an unknown total");
        eq(Blocks.total(null), -1L, "no header");

        eq(Blocks.clock(0), "0:00", "zero");
        eq(Blocks.clock(9900), "0:09", "rounds down");
        eq(Blocks.clock(65000), "1:05", "minutes");
        eq(Blocks.clock(3725000), "1:02:05", "hours");

        // The oldest go until it fits, the one in use never.
        List<Blocks.Kept> files = new ArrayList<>(Arrays.asList(new Blocks.Kept("new", 100, 3), new Blocks.Kept("old", 100, 1), new Blocks.Kept("mid", 100, 2)));
        eq(Blocks.over(files, 300, "new"), List.of(), "within the cap");
        eq(Blocks.over(files, 200, "new"), List.of("old"), "the oldest goes");
        eq(Blocks.over(files, 100, "new"), List.of("old", "mid"), "as many as it takes");
        eq(Blocks.over(files, 100, "old"), List.of("mid", "new"), "never the one in use");
        if (fails > 0) System.exit(1);
        System.out.println("BlocksTest ok");
    }
}
