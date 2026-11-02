package dev.harbor.app;

/** The badges' names and the strip's stop controls (Labels). Plain JVM, no Android: build.sh runs
 *  it before packaging. */
public class LabelsTest {
    private static int failed;

    private static void same(Object got, Object want, String what) {
        if (String.valueOf(got).equals(String.valueOf(want))) return;
        failed++;
        System.err.println("FAIL " + what + ": got " + got + ", want " + want);
    }

    /** Stop controls on screen: one per row shown, and Stop all. */
    private static int stops(int agents, boolean folded, Boolean picked) {
        int rows = Labels.rowsOpen(agents, folded, picked) ? agents : 0;
        return rows + (Labels.header(agents, false) && Labels.stopAll(agents) ? 1 : 0);
    }

    public static void main(String[] args) {
        // The names the hub's list would give (src/providers.rs claude_models).
        same(Labels.modelName("claude-opus-5-5"), "Opus 5.5", "opus");
        same(Labels.modelName("claude-sonnet-5-5"), "Sonnet 5.5", "sonnet");
        same(Labels.modelName("claude-haiku-5-5"), "Haiku 5.5", "haiku");
        same(Labels.modelName("claude-fable-5-1"), "Fable 5.1", "fable");
        same(Labels.modelName("claude-opus-5"), "Opus 5", "no minor version");
        // Already a label, or not ours to rename.
        same(Labels.modelName("Opus 5.5"), "Opus 5.5", "a label");
        same(Labels.modelName("gpt-5.2-codex"), "gpt-5.2-codex", "another provider");
        same(Labels.modelName("claude-opus-4-20250514"), "claude-opus-4-20250514", "a dated id");
        same(Labels.modelName(""), "", "empty");

        same(Labels.effortBadge("Medium", true), "Medium", "a level");
        same(Labels.effortBadge("xhigh", true), "Xhigh", "a level the hub doesn't name");
        same(Labels.effortBadge("", true), "Effort", "an older hub without the default");
        same(Labels.effortBadge("medium", false), "", "no levels: hidden");
        same(Labels.effortBadge("", false), "", "nothing: hidden");

        same(Labels.logo("claude"), "p-claude-color.rgba", "claude's logo");
        same(Labels.logo("codex"), "p-openai.a8", "codex's logo");
        same(Labels.logo("opencode"), "", "a provider Harbor dropped");
        same(Labels.logo(""), "", "an unknown provider");

        same(stops(1, false, null), 1, "one agent: one stop");
        same(stops(1, true, null), 1, "one agent, folded by an older hub: one stop");
        same(stops(1, true, false), 1, "one agent never folds away");
        same(stops(2, false, null), 3, "two agents: theirs and Stop all");
        same(stops(3, true, null), 1, "folded: Stop all alone");
        same(stops(3, true, true), 4, "unfolded: theirs and Stop all");
        same(stops(3, false, null), 4, "not folded");
        same(Labels.header(1, false), false, "one agent: no title row");
        same(Labels.header(1, true), true, "one agent with a queue: the hub's title row");
        same(Labels.header(2, false), true, "two agents: Stop all needs the title row");

        if (failed > 0) { System.err.println(failed + " check(s) failed"); System.exit(1); }
        System.out.println("LabelsTest ok");
    }
}
