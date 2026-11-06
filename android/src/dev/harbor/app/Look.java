package dev.harbor.app;

/** How a card draws when the hub doesn't say (PROTOCOL.md `look`). Hubs from 0.150 send each
 *  card's `look`, the desktop's own decisions (glyphs, tones, labels, what expands, what a
 *  captcha notice is), and the app draws it as given; these are the fallbacks for older hubs,
 *  kept to the desktop's rules. No Android in here: it runs in the build's unit tests. */
final class Look {
    private Look() {}

    /** The hub's value when it sent one (non-empty), else the fallback. */
    static String or(String looked, String fallback) {
        return looked == null || looked.isEmpty() ? fallback : looked;
    }

    /** A notice's `icon` → its glyph (the desktop's table; anything else a check). */
    static String noticeGlyph(String icon) {
        switch (icon == null ? "" : icon) {
            case "bot": case "report": return Ui.I_BOT;
            case "wake": return Ui.I_ALARM;
            case "clock": return Ui.I_CLOCK;
            case "webhook": return Ui.I_WEBHOOK;
            case "alert": return Ui.I_ALERT;
            case "fork": return Ui.I_FORK;
            case "process": return Ui.I_ACTIVITY;
            case "restart": return Ui.I_ROTATE;
            case "users": return Ui.I_USERS;
            case "monitor": return Ui.I_MONITOR;
            case "folder": return Ui.I_FOLDER;
            case "worktree": return Ui.I_FOLDER_GIT;
            case "lock": return Ui.I_LOCK;
            case "captcha": return Ui.I_USER_CHECK;
            // A lead's hand-offs (hubs 0.84 to 0.107).
            case "started": return Ui.I_PLAY;
            case "sent": return Ui.I_SEND;
            default: return Ui.I_CIRCLE_CHECK;
        }
    }

    /** A captcha's outcome line (Chat.captchaOf state): a check when it joined, else a slash. */
    static String captchaGlyph(String state) {
        return "joined".equals(state) ? Ui.I_USER_CHECK : Ui.I_CIRCLE_SLASH;
    }

    /** A notice opens to its detail: one that isn't an address, and never one with a url. */
    static boolean expandable(String detail, String url) {
        return detail != null && !detail.isEmpty() && !detail.startsWith("http") && (url == null || url.isEmpty());
    }

    /** A tool call's row: a spinner while it runs, then a check or a cross. */
    static String toolGlyph(boolean done, boolean error) {
        return !done ? Ui.I_LOADER : error ? Ui.I_CIRCLE_X : Ui.I_CIRCLE_CHECK;
    }

    /** Its tone: "" (muted) while it runs, "red" failed, "green" done. */
    static String toolTone(boolean done, boolean error) {
        return !done ? "" : error ? "red" : "green";
    }

    /** A run's chevron row: "1 tool call", "5 tool calls". */
    static String runLabel(int calls) {
        return calls + (calls == 1 ? " tool call" : " tool calls");
    }

    /** The glyph over a user bubble for who wrote it elsewhere ("phone" or "pc"). */
    static String senderGlyph(String via) {
        return "phone".equals(via) ? Ui.I_PHONE : Ui.I_MONITOR;
    }
}
