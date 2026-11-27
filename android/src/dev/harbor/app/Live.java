package dev.harbor.app;

import java.io.IOException;
import java.io.StringReader;
import java.io.StringWriter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.TreeSet;

/** A live update while Harbor is on screen (Swap): new app code the shell staged runs from a
 *  quick restart of the process, at a moment that loses nothing, and the screens come back as
 *  they were. Classes a process loaded can't be swapped, so "live" is a restart the user
 *  hardly sees. This is its plain-Java half (LiveTest): when that moment is ({@link #why}), and
 *  what is kept across it ({@link Saved}, written to the app's preferences before the process
 *  ends and read by the next one's first screen). */
final class Live {
    private Live() { }

    /** Untouched this long, the screen may restart. */
    static final long IDLE_MS = 2_000;
    /** While a message is being written (the composer focused, not empty): a longer pause. */
    static final long COMPOSING_IDLE_MS = 12_000;
    /** A screen that just came up (navigation) restarts at once: nothing on it to lose yet. */
    static final long NAV_MS = 1_500;
    /** After this long waiting, a short pause is enough (a message being written comes back with
     *  its text and cursor). */
    static final long CAP_MS = 5 * 60_000L;
    static final long CAP_IDLE_MS = 600;
    /** A saved state older than this isn't restored (the next start is an ordinary one). */
    static final long FRESH_MS = 10 * 60_000L;
    /** Restores of one state at most (new code that crashed, then rolled back, comes back to
     *  the same place; not forever). */
    static final int MAX_TRIES = 4;

    /** What the screen in front is doing (Swap builds it each tick). */
    static final class Moment {
        /** A Harbor screen is resumed. */
        boolean front;
        /** Its window has the focus: no sheet, menu, dialog, permission prompt or the
         *  notification shade over it. */
        boolean focused = true;
        /** The screen (and its place) can be opened again (Live.keep). */
        boolean restorable = true;
        boolean recording, playing, writing, outForAnswer, fingerDown;
        /** A focused text field with text in it that isn't the composer (its text wouldn't come back). */
        boolean typingField;
        /** The chat composer is focused and not empty. */
        boolean composing;
        /** Since the last touch, key or text change; since this screen came up; since staged code
         *  waits for a moment. */
        long idleMs, shownMs, armedMs;
    }

    /** Why not now (for the log), or null: restart now. */
    static String why(Moment m) {
        if (!m.front) return "not in front";
        if (!m.restorable) return "a screen that can't come back";
        if (!m.focused) return "a sheet or dialog is open";
        if (m.recording) return "recording";
        if (m.playing) return "playing a video";
        if (m.writing) return "sending";
        if (m.outForAnswer) return "waiting for another app's answer";
        if (m.fingerDown) return "touching";
        if (m.typingField) return "typing in a field";
        boolean capped = m.armedMs >= CAP_MS;
        if (m.composing) {
            if (m.idleMs >= COMPOSING_IDLE_MS || (capped && m.idleMs >= CAP_IDLE_MS)) return null;
            return "writing a message";
        }
        if (m.shownMs < NAV_MS) return null;
        if (m.idleMs >= IDLE_MS || (capped && m.idleMs >= CAP_IDLE_MS)) return null;
        return "in use";
    }

    // ---- what comes back ----

    /** Screens that open again, and the extras of theirs that do (an extra that acts, like
     *  Settings' "install", doesn't). null: not restorable (a form being filled in). Hubs, the
     *  first screen, is always there. */
    static String[] keep(String screen) {
        switch (screen) {
            case "Hubs": return new String[0];
            case "Chats": return new String[] { "hub" };
            case "Chat": return new String[] { "hub", "chat" };
            case "Settings": return new String[] { "hub", "people" };
            case "GhList": return new String[] { "hub", "kind", "project" };
            case "GhItem": return new String[] { "hub", "kind", "row", "projects" };
            // Hub's other tabs: their pages, drafts and places are the screen's own state (liveScreen).
            case "Persons": return new String[] { "hub" };
            case "Routine": return new String[0];
            case "Collector": return new String[0];
            default: return null;
        }
    }

    static boolean kept(String screen, String extra) {
        String[] k = keep(screen);
        if (k == null) return false;
        for (String x : k) if (x.equals(extra)) return true;
        return false;
    }

    /** One screen of the task: its activity's simple name, the extras it opens with (String,
     *  Long, Integer or Boolean), and what it keeps of itself (its own keys). */
    static final class Screen {
        String cls;
        final Map<String, Object> extras = new LinkedHashMap<>();
        final Map<String, String> state = new LinkedHashMap<>();

        Screen(String cls) { this.cls = cls; }

        String get(String k, String def) { String v = state.get(k); return v == null ? def : v; }

        int getInt(String k, int def) {
            try { return Integer.parseInt(state.get(k)); } catch (Exception e) { return def; }
        }
    }

    /** What a live restart keeps: the code it left and the one it goes to, when, how many times
     *  it was restored, and the task's screens bottom to top (without Hubs). */
    static final class Saved {
        long from, to, at;
        int tries;
        final List<Screen> screens = new ArrayList<>();
    }

    static String encode(Saved s) {
        Properties p = new Properties();
        p.setProperty("from", Long.toString(s.from));
        p.setProperty("to", Long.toString(s.to));
        p.setProperty("at", Long.toString(s.at));
        p.setProperty("tries", Integer.toString(s.tries));
        p.setProperty("n", Integer.toString(s.screens.size()));
        for (int i = 0; i < s.screens.size(); i++) {
            Screen sc = s.screens.get(i);
            String k = "s" + i + ".";
            p.setProperty(k + "cls", sc.cls);
            for (Map.Entry<String, Object> e : sc.extras.entrySet()) {
                Object v = e.getValue();
                String t = v instanceof String ? "s" : v instanceof Long ? "l" : v instanceof Integer ? "i" : v instanceof Boolean ? "b" : null;
                if (t != null) p.setProperty(k + "e." + e.getKey(), t + ":" + v);
            }
            for (Map.Entry<String, String> e : sc.state.entrySet()) if (e.getValue() != null) p.setProperty(k + "v." + e.getKey(), e.getValue());
        }
        // Sorted, no date line: the same state is the same text.
        StringBuilder b = new StringBuilder();
        for (String key : new TreeSet<>(p.stringPropertyNames())) {
            Properties one = new Properties();
            one.setProperty(key, p.getProperty(key));
            StringWriter w = new StringWriter();
            try { one.store(w, null); } catch (IOException ignored) { }
            for (String line : w.toString().split("\n")) if (!line.startsWith("#") && !line.isEmpty()) b.append(line.replace("\r", "")).append('\n');
        }
        return b.toString();
    }

    /** The state back, or null when it's not one (an older format, garbage). */
    static Saved decode(String text) {
        if (text == null || text.isEmpty()) return null;
        Properties p = new Properties();
        try { p.load(new StringReader(text)); } catch (IOException | IllegalArgumentException e) { return null; }
        Saved s = new Saved();
        int n;
        try {
            s.from = Long.parseLong(p.getProperty("from"));
            s.to = Long.parseLong(p.getProperty("to"));
            s.at = Long.parseLong(p.getProperty("at"));
            s.tries = Integer.parseInt(p.getProperty("tries", "0"));
            n = Integer.parseInt(p.getProperty("n"));
        } catch (RuntimeException e) {
            return null;
        }
        if (n < 0 || n > 64) return null;
        for (int i = 0; i < n; i++) {
            String k = "s" + i + ".";
            String cls = p.getProperty(k + "cls");
            if (cls == null || keep(cls) == null) continue; // a screen this code doesn't restore
            Screen sc = new Screen(cls);
            for (String key : new TreeSet<>(p.stringPropertyNames())) {
                if (key.startsWith(k + "e.")) {
                    String name = key.substring(k.length() + 2), v = p.getProperty(key);
                    if (!kept(cls, name) || v.length() < 2 || v.charAt(1) != ':') continue;
                    String raw = v.substring(2);
                    try {
                        switch (v.charAt(0)) {
                            case 's': sc.extras.put(name, raw); break;
                            case 'l': sc.extras.put(name, Long.parseLong(raw)); break;
                            case 'i': sc.extras.put(name, Integer.parseInt(raw)); break;
                            case 'b': sc.extras.put(name, Boolean.parseBoolean(raw)); break;
                            default: break;
                        }
                    } catch (NumberFormatException ignored) { }
                } else if (key.startsWith(k + "v.")) {
                    sc.state.put(key.substring(k.length() + 2), p.getProperty(key));
                }
            }
            s.screens.add(sc);
        }
        return s;
    }

    /** A saved state the next start opens: recent, and not restored too often already. */
    static boolean fresh(Saved s, long now) {
        return s != null && now >= s.at && now - s.at < FRESH_MS && s.tries < MAX_TRIES;
    }
}
