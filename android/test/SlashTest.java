package dev.harbor.app;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/** The slash menu's rules (SlashList), with the cases of src/slash.rs's tests. Plain JVM, no
 *  Android: build.sh runs it before packaging. */
public class SlashTest {
    private static int failed;

    private static void check(boolean ok, String what) {
        if (!ok) { failed++; System.err.println("FAIL " + what); }
    }

    private static void same(Object got, Object want, String what) {
        check(String.valueOf(got).equals(String.valueOf(want)), what + ": got " + got + ", want " + want);
    }

    private static String word(String text, int cursor) {
        SlashList.Word w = SlashList.word(text, cursor);
        return w == null ? "none" : w.start + "," + w.end + "," + w.query + "," + w.first;
    }

    private static String put(String text, int cursor, String with) {
        SlashList.Put p = SlashList.put(text, SlashList.word(text, cursor), with);
        return p.apply(text) + "|" + p.cursor();
    }

    /** As slash.rs's tests' local(): "<name> does things"; Harbor's with the PC's descriptions. */
    private static SlashList.Entry entry(String name, String source, boolean skill) {
        boolean harbor = "harbor".equals(source);
        String desc = !harbor ? name + " does things" : "model".equals(name) ? "Switch the model for this chat"
                : "Switch this chat to read only: it reads and plans, changes nothing";
        return new SlashList.Entry(name, Collections.<String>emptyList(), desc, "", source, harbor ? "Harbor" : source, skill, harbor ? name : null);
    }

    private static List<String> find(List<SlashList.Entry> all, String text) {
        List<String> out = new ArrayList<>();
        for (SlashList.Entry e : SlashList.search(all, SlashList.word(text, text.length()))) out.add(e.name);
        return out;
    }

    public static void main(String[] args) {
        // finds_the_word_at_the_cursor
        same(word("/co", 3), "0,3,co,true", "word at the end");
        same(word("/compact now", 4), "0,8,com,true", "word with more after it");
        same(word("fix it /rev", 11), "7,11,rev,false", "word after others");
        same(word("  /x", 4), "2,4,x,true", "leading spaces still first");
        same(word("/", 1), "0,1,,true", "a lone slash");
        same(word("a/b", 3), "none", "slash inside a word");
        same(word("/compact ", 9), "none", "after the space");
        same(word("/x", 0), "none", "cursor before the slash");

        // replaces_the_word
        same(put("/co", 3, "/compact"), "/compact |9", "put at the end");
        same(put("/co more", 2, "/compact"), "/compact more|9", "put before more text");
        same(put("/mod hello", 3, ""), "hello|0", "a Harbor command takes its word and space");
        same(put("é /sk", 5, "/skill"), "é /skill |9", "put after other text");

        // ranks_and_filters (Harbor's /model and /plan, then the user's files, for Codex)
        List<SlashList.Entry> all = Arrays.asList(entry("model", "harbor", false), entry("plan", "harbor", false),
                entry("code-review", "personal", true), entry("review-pr", "personal", false), entry("deploy", "personal", false));
        same(find(all, "/review"), "[review-pr, code-review]", "prefix before word boundary");
        same(find(all, "/dpl"), "[deploy]", "letters in order");
        same(find(all, "/zzz"), "[]", "no match");
        same(find(all, "/"), "[model, plan, code-review, deploy, review-pr]", "everything: Harbor's first, then by name");
        same(find(all, "look at /rev"), "[code-review]", "mid-message: skills only");
        same(find(all, "/model"), "[model]", "exact name");
        same(find(all, "/things"), "[code-review, deploy, review-pr]", "descriptions match too");

        // Aliases count, one step after the name; plugins are offered mid-message like skills.
        SlashList.Entry compact = new SlashList.Entry("compact", Collections.singletonList("squash"), "Free up context", "<instructions>", "builtin", "Built-in", false, null);
        SlashList.Entry plugin = new SlashList.Entry("vercel:deploy", Collections.<String>emptyList(), "(vercel) Deploy", "", "plugin", "Plugin", false, null);
        List<SlashList.Entry> cc = Arrays.asList(compact, plugin);
        same(find(cc, "/squash"), "[compact]", "alias");
        same(SlashList.score(compact, "squash"), 1, "an alias's exact match scores one more than a name's");
        same(find(cc, "/dep"), "[vercel:deploy]", "after a colon is a word boundary");
        same(find(cc, "and /"), "[vercel:deploy]", "mid-message: no built-in commands");

        if (failed > 0) { System.err.println(failed + " slash check(s) failed"); System.exit(1); }
        System.out.println("slash menu: all checks passed");
    }
}
