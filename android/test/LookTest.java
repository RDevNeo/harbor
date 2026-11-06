package dev.harbor.app;

/** How cards draw when an older hub sends no `look` (Look): the desktop's rules. Plain JVM, no
 *  Android: build.sh runs it before packaging. */
public class LookTest {
    private static int failed;

    private static void same(Object got, Object want, String what) {
        if (String.valueOf(got).equals(String.valueOf(want))) return;
        failed++;
        System.err.println("FAIL " + what + ": got " + got + ", want " + want);
    }

    public static void main(String[] args) {
        // The hub's value wins; nothing (an older hub) falls back.
        same(Look.or("", Ui.I_CLOCK), "", "the hub's glyph");
        same(Look.or("", Ui.I_CLOCK), Ui.I_CLOCK, "an empty look");
        same(Look.or(null, Ui.I_CLOCK), Ui.I_CLOCK, "no look");

        // The desktop's notice glyphs (net's look.ts NOTICE_GLYPHS): wake is an alarm, not a clock.
        same(Look.noticeGlyph("wake"), "", "wake: alarm");
        same(Look.noticeGlyph("clock"), Ui.I_CLOCK, "clock");
        same(Look.noticeGlyph("lock"), "", "lock");
        same(Look.noticeGlyph("report"), Ui.I_BOT, "report: bot");
        same(Look.noticeGlyph("captcha"), "", "captcha: user-check");
        same(Look.noticeGlyph("started"), Ui.I_PLAY, "a lead's hand-off");
        same(Look.noticeGlyph("nope"), Ui.I_CIRCLE_CHECK, "unknown: a check");
        same(Look.noticeGlyph(null), Ui.I_CIRCLE_CHECK, "none: a check");
        same(Look.captchaGlyph("joined"), "", "captcha joined");
        same(Look.captchaGlyph("timeout"), "", "captcha not joined");

        // A notice opens to a detail that isn't an address, never with a url.
        same(Look.expandable("why", ""), true, "a detail");
        same(Look.expandable("why", null), true, "a detail, url null");
        same(Look.expandable("", ""), false, "no detail");
        same(Look.expandable("https://x", ""), false, "an address");
        same(Look.expandable("why", "http://127.0.0.1:3000"), false, "a url");

        same(Look.toolGlyph(false, false), Ui.I_LOADER, "running");
        same(Look.toolGlyph(true, false), Ui.I_CIRCLE_CHECK, "done");
        same(Look.toolGlyph(true, true), Ui.I_CIRCLE_X, "failed");
        same(Look.toolTone(false, true), "", "running: muted");
        same(Look.toolTone(true, false), "green", "done: green");
        same(Look.toolTone(true, true), "red", "failed: red");

        same(Look.runLabel(1), "1 tool call", "one call");
        same(Look.runLabel(5), "5 tool calls", "calls");
        same(Look.senderGlyph("phone"), Ui.I_PHONE, "a phone");
        same(Look.senderGlyph("pc"), Ui.I_MONITOR, "a PC");

        if (failed > 0) { System.err.println(failed + " check(s) failed"); System.exit(1); }
        System.out.println("LookTest ok");
    }
}
