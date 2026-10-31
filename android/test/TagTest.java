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
        same(word("$fix", 4), "none", "no chats there");
        TagList.Word c = TagList.word("see $fix", 8, true);
        same(c == null ? "none" : c.trigger + "," + c.start + "," + c.end + "," + c.query, "$,4,8,fix", "a chat");
        same(TagList.word("costs $5", 8, true) == null, true, "money");
        same(TagList.word("$$x", 3, true) == null, true, "two dollars");
        same(TagList.word("a$b", 3, true) == null, true, "inside a word");

        same(word("Image #1", 8), "none", "an image's number");
        same(word("[Image #", 8), "none", "an image's number, being written");
        same(word("fix #1", 6), "#,4,6,1", "still an issue");

        same(tokens("a @b #3 c#4 #x"), "@b|#3|", "tokens");
        same(tokens("this [Image #1] and Image #2, image #3, IMAGE  #4 but #5 and myimage #6"), "#5|#6|", "an image's number is no issue");
        same(tokens("see @src/chat.rs, and #12 (also #12) or me@mail.com #7."), "@src/chat.rs|#12|#12|#7|", "punctuation");
        same(tokens("@app/(group)/page.tsx"), "@app/(group)/page.tsx|", "brackets in a path");
        List<int[]> t = TagList.tokens("é @ñ.");
        same(t.get(0)[0] + "," + t.get(0)[1], "2,4", "UTF-16 indices");

        // src/usertext.rs's cases: commands, and chats' titles before tags.
        StringBuilder cmd = new StringBuilder();
        String cs = "/review this, then /plugin:skill. see /tmp/x and a/b and //x and /5 and (/compact) é /ñ";
        for (int[] r : TagList.commands(cs)) cmd.append(cs, r[0], r[1]).append('|');
        same(cmd, "/review|/plugin:skill|/compact|", "commands");
        String ms = "Fix @login page and Fix /go @a";
        StringBuilder m = new StringBuilder();
        for (int[] r : TagList.marks(ms, java.util.Arrays.asList("Fix", "Fix @login page"))) m.append(ms, r[0], r[1]).append('|');
        same(m, "Fix @login page|Fix|/go|@a|", "marks: longer titles first, tags outside them");

        // src/usertext.rs's images.
        String im = "see [Image #1], Image #2 [Image #x] [Image #0] [Image #12]";
        StringBuilder found = new StringBuilder();
        for (int[] r : TagList.images(im)) found.append(im, r[0], r[1]).append('=').append(r[2]).append('|');
        same(found, "[Image #1]=1|[Image #12]=12|", "image tokens");
        same(TagList.imageNumbers("[Image #3] [Image #1] [Image #3]"), "[1, 3]", "image numbers");
        same(TagList.shifted("a [Image #1] b [Image #2]", 3), "a [Image #4] b [Image #5]", "shifted");
        same(TagList.defuse("see [Image #1], [Image #12] and Image #3"), "see [Image 1], [Image 12] and Image #3", "defused");
        same(TagList.imageNumbers(TagList.defuse("[Image #1] [Image #2]")), "[]", "defused tokens are none");
        same(tokens(TagList.defuse("[Image #4]")), "", "defused is no issue");
        StringBuilder marked = new StringBuilder();
        String ims = "look [Image #1] /go #4";
        for (int[] r : TagList.marks(ims, null)) marked.append(ims, r[0], r[1]).append('|');
        same(marked, "[Image #1]|/go|#4|", "marks: images");

        if (failed > 0) { System.err.println(failed + " tag test(s) failed"); System.exit(1); }
        System.out.println("tag tests passed");
    }
}
