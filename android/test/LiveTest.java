package dev.harbor.app;

/** Live updates on screen (Live, used by Swap): when a restart into staged code may happen, and
 *  what's kept across it. Plain JVM, no Android: build.sh runs it before packaging. */
public class LiveTest {
    private static int failed;

    private static void check(boolean ok, String what) {
        if (!ok) { failed++; System.err.println("FAIL " + what); }
    }

    private static void same(Object got, Object want, String what) {
        check(String.valueOf(got).equals(String.valueOf(want)), what + ": got " + got + ", want " + want);
    }

    /** A chat in front, untouched for a while, the update just staged. */
    private static Live.Moment idle() {
        Live.Moment m = new Live.Moment();
        m.front = true;
        m.idleMs = Live.IDLE_MS;
        m.shownMs = 60_000;
        m.armedMs = 3_000;
        return m;
    }

    public static void main(String[] args) {
        // ---- the moment ----
        same(Live.why(idle()), null, "in front, idle a couple of seconds: now");
        Live.Moment m = idle();
        m.idleMs = Live.IDLE_MS - 1;
        same(Live.why(m), "in use", "touched a moment ago");
        m = idle();
        m.front = false;
        same(Live.why(m), "not in front", "out of sight: the background's restart, not this one");

        // Hard waits: each one alone holds it, also past the cap.
        String[] holds = { "a sheet or dialog is open", "recording", "playing a video", "sending",
                "waiting for another app's answer", "touching", "typing in a field", "a screen that can't come back" };
        for (int i = 0; i < holds.length; i++) {
            m = idle();
            m.armedMs = Live.CAP_MS * 10;
            m.idleMs = Live.COMPOSING_IDLE_MS * 10;
            m.shownMs = 0; // even a screen that just came up
            switch (i) {
                case 0: m.focused = false; break;
                case 1: m.recording = true; break;
                case 2: m.playing = true; break;
                case 3: m.writing = true; break;
                case 4: m.outForAnswer = true; break;
                case 5: m.fingerDown = true; break;
                case 6: m.typingField = true; break;
                default: m.restorable = false; break;
            }
            same(Live.why(m), holds[i], "waits for: " + holds[i]);
        }

        // A screen that just came up (navigation): at once, even right after the tap.
        m = idle();
        m.shownMs = 200;
        m.idleMs = 200;
        same(Live.why(m), null, "a screen just came up");
        m.shownMs = Live.NAV_MS;
        same(Live.why(m), "in use", "no longer just came up");

        // Writing a message: a longer pause, unless the update has waited long.
        m = idle();
        m.composing = true;
        m.idleMs = Live.IDLE_MS;
        same(Live.why(m), "writing a message", "a short pause in a message isn't enough");
        m.shownMs = 100;
        same(Live.why(m), "writing a message", "a message being written isn't a fresh screen");
        m.idleMs = Live.COMPOSING_IDLE_MS;
        same(Live.why(m), null, "a long pause in the message");
        m.idleMs = Live.CAP_IDLE_MS;
        m.armedMs = Live.CAP_MS;
        same(Live.why(m), null, "waited past the cap: a short pause is enough");
        m.idleMs = Live.CAP_IDLE_MS - 1;
        same(Live.why(m), "writing a message", "past the cap, but typing right now");
        m = idle();
        m.idleMs = Live.CAP_IDLE_MS;
        m.armedMs = Live.CAP_MS;
        same(Live.why(m), null, "past the cap: a short pause on any screen");
        check(Live.IDLE_MS >= 1_000 && Live.IDLE_MS <= 5_000, "a couple of seconds idle");
        check(Live.CAP_MS <= 15 * 60_000L, "the cap doesn't wait forever");

        // ---- what's kept ----
        check(Live.keep("Chat") != null && Live.keep("Chats") != null && Live.keep("Settings") != null && Live.keep("Hubs") != null, "the usual screens come back");
        check(Live.keep("NewChat") == null && Live.keep("NewProject") == null && Live.keep("Palette") == null && Live.keep("DiscordCaptcha") == null,
                "forms being filled in don't");
        check(!Live.kept("Settings", "install"), "Settings' install extra (it installs) isn't kept");
        check(!Live.kept("Chat", "captcha"), "nor a chat's scroll-to-captcha");

        Live.Saved s = new Live.Saved();
        s.from = 189000;
        s.to = 189001;
        s.at = 1_700_000_000_000L;
        Live.Screen chats = new Live.Screen("Chats");
        chats.extras.put("hub", "ws:org_sam");
        Live.Screen chat = new Live.Screen("Chat");
        chat.extras.put("hub", "ws:org_sam");
        chat.extras.put("chat", "pc:rig-pc/42");
        chat.extras.put("captcha", true); // not one Chat keeps: dropped on the way back
        String text = "Line one\nline two = with \\ backslash, ünïcödé, emoji 🚀 and #hash !bang\r\n  indented";
        chat.state.put("text", text);
        chat.state.put("selStart", "3");
        chat.state.put("selEnd", "8");
        chat.state.put("seq", "117");
        chat.state.put("off", "-42");
        chat.state.put("panel", "2");
        Live.Screen settings = new Live.Screen("Settings");
        settings.extras.put("hub", "ws:org_sam");
        settings.extras.put("people", true);
        settings.extras.put("install", 189001L);
        s.screens.add(chats);
        s.screens.add(chat);
        s.screens.add(settings);
        String enc = Live.encode(s);
        same(Live.encode(s), enc, "the same state is the same text");
        check(!enc.contains("\n#"), "no date comment");
        Live.Saved back = Live.decode(enc);
        check(back != null, "decodes");
        same(back.from, 189000, "from");
        same(back.to, 189001, "to");
        same(back.at, s.at, "at");
        same(back.tries, 0, "tries");
        same(back.screens.size(), 3, "screens");
        same(back.screens.get(0).cls, "Chats", "bottom first");
        Live.Screen c2 = back.screens.get(1);
        same(c2.cls, "Chat", "then the chat");
        same(c2.extras.get("chat"), "pc:rig-pc/42", "its chat id");
        check(!c2.extras.containsKey("captcha"), "an extra Chat doesn't keep is dropped");
        same(c2.state.get("text"), text, "the composer's text, byte for byte");
        same(c2.getInt("selStart", -1), 3, "cursor start");
        same(c2.getInt("selEnd", -1), 8, "cursor end");
        same(c2.getInt("off", 0), -42, "offset (negative)");
        same(c2.get("panel", "?"), "2", "the open panel");
        same(c2.getInt("missing", 7), 7, "a missing number: the default");
        Live.Screen s2 = back.screens.get(2);
        same(s2.extras.get("people"), true, "a boolean extra stays a boolean");
        check(s2.extras.get("people") instanceof Boolean, "typed");
        check(!s2.extras.containsKey("install"), "Settings comes back without installing");

        Live.Saved typed = new Live.Saved();
        Live.Screen gh = new Live.Screen("GhItem");
        gh.extras.put("hub", "h");
        gh.extras.put("row", "{\"n\":1}");
        typed.screens.add(gh);
        Live.Screen odd = new Live.Screen("NewChat"); // a screen not kept, if one got in
        odd.extras.put("hub", "h");
        typed.screens.add(odd);
        Live.Saved tb = Live.decode(Live.encode(typed));
        same(tb.screens.size(), 1, "screens this code doesn't restore are dropped");
        same(tb.screens.get(0).extras.get("row"), "{\"n\":1}", "JSON in an extra");

        check(Live.decode(null) == null, "nothing saved");
        check(Live.decode("") == null, "empty");
        check(Live.decode("garbage") == null, "not a state");
        check(Live.decode("from=1\nto=2\nat=x\nn=0\n") == null, "unreadable number");
        check(Live.decode("from=1\nto=2\nat=3\nn=-1\n") == null, "negative count");

        // Fresh: recent, not restored too often (new code that crashed comes back a few times).
        long now = s.at + 1_000;
        check(Live.fresh(s, now), "a second old");
        check(!Live.fresh(s, s.at + Live.FRESH_MS), "too old: an ordinary start");
        check(!Live.fresh(s, s.at - 1), "from the future (clock moved): not trusted");
        check(!Live.fresh(null, now), "none");
        s.tries = Live.MAX_TRIES - 1;
        check(Live.fresh(s, now), "a few restores (crash, rollback)");
        s.tries = Live.MAX_TRIES;
        check(!Live.fresh(s, now), "not forever");

        if (failed > 0) {
            System.err.println("LiveTest: " + failed + " failed");
            System.exit(1);
        }
        System.out.println("LiveTest ok");
    }
}
