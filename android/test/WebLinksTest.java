package dev.harbor.app;

import java.util.ArrayList;
import java.util.List;

/** A user's message's bare web addresses, as the desktop finds them: run on the build's JVM (android/build.sh). */
public final class WebLinksTest {
    static int fails;

    static void eq(Object got, Object want, String what) {
        if (!got.equals(want)) { System.out.println("FAIL " + what + ": " + got + " != " + want); fails++; }
    }

    static List<String> found(String text) {
        List<String> out = new ArrayList<>();
        for (int[] w : WebLinks.find(text)) out.add(text.substring(w[0], w[1]));
        return out;
    }

    public static void main(String[] args) {
        eq(found("no address here"), List.of(), "none");
        eq(found("see http://localhost:5173, then"), List.of("http://localhost:5173"), "trailing comma outside");
        eq(found("https://a.dev/x?y=1. and https://b.dev"), List.of("https://a.dev/x?y=1", "https://b.dev"), "two, a full stop outside");
        eq(found("(https://no.dev) xhttps://no.dev \"https://no.dev\""), List.of(), "after a bracket, a letter or a quote");
        eq(found("é https://ok.dev\nhttps://next.dev"), List.of("https://ok.dev", "https://next.dev"), "after a space or a line break");
        eq(found("<https://a.dev>"), List.of(), "inside angle brackets");
        eq(found("https://a.dev`b`"), List.of("https://a.dev"), "a backtick ends it");
        if (fails > 0) System.exit(1);
        System.out.println("WebLinksTest ok");
    }
}
