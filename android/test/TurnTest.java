package dev.harbor.app;

import java.util.Arrays;

/** Which cards the image viewer browses together (Turn), the desktop's rule (src/view.rs).
 *  Plain JVM, no Android: build.sh runs it before packaging. */
public class TurnTest {
    private static int failed;

    private static void check(boolean ok, String what) {
        if (!ok) { failed++; System.err.println("FAIL " + what); }
    }

    /** Cards as kind letters: u user, m message, r report, b old report, n other notice,
     *  t text, o tool, h hidden. */
    private static boolean[] cards(String s) {
        boolean[] out = new boolean[s.length()];
        for (int i = 0; i < out.length; i++) {
            char c = s.charAt(i);
            String kind = c == 'u' ? "user" : c == 'm' ? "message" : "rbn".indexOf(c) >= 0 ? "notice" : c == 'o' ? "tool" : c == 'h' ? "hidden" : "text";
            out[i] = Turn.speaker(kind, c == 'r' ? "report" : c == 'b' ? "bot" : c == 'n' ? "process" : "");
        }
        return out;
    }

    private static void range(String cards, int at, int first, int end) {
        int[] got = Turn.range(cards(cards), at);
        check(got[0] == first && got[1] == end, cards + " at " + at + ": got " + Arrays.toString(got));
    }

    public static void main(String[] args) {
        // An agent's turn across its cards, hidden ones and its own notices too.
        range("utothnt", 1, 1, 7);
        range("utothnt", 6, 1, 7);
        // Two turns with a user message between them.
        range("utotut", 2, 1, 4);
        range("utotut", 5, 5, 6);
        // A user message alone, between replies.
        range("tut", 1, 1, 2);
        range("uut", 0, 0, 1);
        // Other agents' messages and reports split the turn.
        range("mtmt", 1, 1, 2);
        range("mtmt", 3, 3, 4);
        range("trt", 0, 0, 1);
        range("trt", 2, 2, 3);
        range("tbt", 2, 2, 3);
        // A chat that starts with no message at all.
        range("tot", 1, 0, 3);
        if (failed > 0) { System.err.println(failed + " failed"); System.exit(1); }
        System.out.println("TurnTest ok");
    }
}
