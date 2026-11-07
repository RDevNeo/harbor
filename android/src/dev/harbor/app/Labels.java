package dev.harbor.app;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** What the model and effort badges and the agent strip say, without Android: android/test's
 *  LabelsTest runs these before packaging. */
final class Labels {
    private Labels() { }

    private static final Pattern CLAUDE = Pattern.compile("claude-([a-z]+)-(\\d{1,2})(?:-(\\d{1,2}))?");

    /** A model the hub's list doesn't name: "claude-opus-5-5" reads as the desktop's "Opus 5.5".
     *  Anything else stays as it is: only the hub knows other providers' names. */
    static String modelName(String label) {
        Matcher m = CLAUDE.matcher(label);
        if (!m.matches()) return label;
        String family = m.group(1);
        String version = m.group(3) == null ? m.group(2) : m.group(2) + "." + m.group(3);
        return Character.toUpperCase(family.charAt(0)) + family.substring(1) + " " + version;
    }

    /** The effort badge: "" hides it (the provider has no levels); a hub too old to say the
     *  default still gets a badge that opens the picker. */
    static String effortBadge(String label, boolean levels) {
        if (!levels) return "";
        if (label.isEmpty()) return "Effort";
        return Character.toUpperCase(label.charAt(0)) + label.substring(1);
    }

    /** The provider's logo in assets/logos (src/agentstrip.rs `logo`); "" when it isn't known. */
    static String logo(String kind) {
        switch (kind) {
            case "claude": return "p-claude-color.rgba";
            case "codex": return "p-openai.a8";
            case "opencode": return "p-opencode.a8";
            default: return "";
        }
    }

    /** Stop all stands apart only with something to add: one agent has its own row's stop. */
    static boolean stopAll(int agents) { return agents >= 2; }

    /** The strip's title row: it holds Stop all, so from two agents on it always shows. */
    static boolean header(int agents, boolean hubHeader) { return stopAll(agents) || hubHeader; }

    /** Whether the rows show; `picked` is this screen's choice (null: the hub's default). A lone
     *  agent always does: its stop is in its row. */
    static boolean rowsOpen(int agents, boolean folded, Boolean picked) {
        return !stopAll(agents) || !folded || (picked != null && picked);
    }
}
