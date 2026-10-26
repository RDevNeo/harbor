package dev.harbor.app;

import java.util.List;

/** The composer's tag rules (TagList), with the cases of src/tags.rs's tests. Plain JVM, no
 *  Android: build.sh runs it before packaging. */
public class TagTest {
    private static int failed;

    private static void same(Object got, Object want, String what) {
        if (!String.valueOf(got).equals(String.valueOf(want))) { failed++; System.err.println("FAIL " + what + ": got " + got + ", want " + want); }
    }

    private static String word(String text, int cursor) {
        TagList.Word w = TagList.word(text, cursor);
        return w == null ? "none" : w.trigger + "," + w.start + "," + w.end + "," + w.query;
    }

    private static String tokens(String text) {
        StringBuilder b = new StringBuilder();
        for (int[] t : TagList.tokens(text)) b.append(text, t[0], t[1]).append('|');
        return b.toString();
    }

    public static void main(String[] args) {
        same(word("@src", 4), "@,0,4,src", "a file");
        same(word("look at @ch now", 11), "@,8,11,ch", "after words");
        same(word("fix #12", 7), "#,4,7,12", "an issue");
        same(word("(#4", 3), "#,1,3,4", "after a bracket");
        same(word("@", 1), "@,0,1,", "bare");
        same(word("me@host", 7), "none", "an email address");
        same(word("## Title", 2), "none", "a heading");
        same(word("@a ", 3), "none", "after the word");
        same(word("/cmd", 4), "none", "a slash command");

        same(tokens("a @b #3 c#4 #x"), "@b|#3|", "tokens");
        same(tokens("see @src/chat.rs, and #12 (also #12) or me@mail.com #7."), "@src/chat.rs|#12|#12|#7|", "punctuation");
        same(tokens("@app/(group)/page.tsx"), "@app/(group)/page.tsx|", "brackets in a path");
        List<int[]> t = TagList.tokens("é @ñ.");
        same(t.get(0)[0] + "," + t.get(0)[1], "2,4", "UTF-16 indices");

        if (failed > 0) { System.err.println(failed + " tag test(s) failed"); System.exit(1); }
        System.out.println("tag tests passed");
    }
}
