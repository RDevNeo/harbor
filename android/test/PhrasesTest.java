package dev.harbor.app;

import java.util.Arrays;
import java.util.Collections;

/** Dictation's phrase rules (Phrases), with partial words logged from Google's speech services.
 *  Plain JVM, no Android: build.sh runs it before packaging. */
public class PhrasesTest {
    private static int failed;

    private static void same(Object got, Object want, String what) {
        if (!String.valueOf(got).equals(String.valueOf(want))) { failed++; System.err.println("FAIL " + what + ": got " + got + ", want " + want); }
    }

    /** Feeds partials as Voice does; returns the phrases kept plus the last partial. */
    private static String run(String... partials) {
        StringBuilder kept = new StringBuilder();
        String p = "";
        for (String t : partials) {
            if (Phrases.restarted(p, t)) kept.append(p).append(" | ");
            p = t;
        }
        return kept + p;
    }

    public static void main(String[] args) {
        same(run("and", "And so", "And so my fellow Americans", "and", "ask", "and not", "ask not", "ask not what you are you", "ask not what you"),
                "And so my fellow Americans | ask not what you", "a pause, then early flips and a revision");
        same(run("and not what our country can do for you your country", "and not what our country can do for you"),
                "and not what our country can do for you", "a revision dropping words");
        same(run("And so I told Americ", "And so I", "and"), "And so I | and", "a short phrase");
        same(run("what you", "do", "do your country"), "what you | do your country", "two words, then a new one");
        same(run("and not", "and"), "and", "two words revised to the first");
        same(run("And so my fellow", "And so my fellow Americans ask not"), "And so my fellow Americans ask not", "growing");
        same(Phrases.unkept(Collections.emptyList(), "ask what"), "ask what", "nothing kept");
        same(Phrases.unkept(Arrays.asList("And so my fellow Americans,"), "and so my fellow Americans ask not"), "ask not", "the whole segment");
        same(Phrases.unkept(Arrays.asList("And so my fellow Americans"), "ask not"), "ask not", "only the last phrase");
        same(Phrases.unkept(Arrays.asList("ask not"), "ask not"), "", "nothing new");
        if (failed > 0) { System.err.println(failed + " phrase test(s) failed"); System.exit(1); }
        System.out.println("phrase tests passed");
    }
}
