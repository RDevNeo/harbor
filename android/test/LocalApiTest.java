package dev.harbor.app;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;

/** The local API's gate (LocalGate, LocalHttp): requests, Host and Origin, CORS and Private
 *  Network Access, routes, tokens and their chat, limits, rates, pairings, grants, cursors, and
 *  the /proc/net parse. Run on the build's JVM (android/build.sh). */
public final class LocalApiTest {
    static int fails;

    static void eq(Object got, Object want, String what) {
        if (got == null ? want != null : !got.equals(want)) { System.out.println("FAIL " + what + ": " + got + " != " + want); fails++; }
    }

    static long now = 1_000_000;
    static final LocalGate gate = new LocalGate(() -> now);

    static LocalHttp.Req req(String raw) {
        try {
            return LocalHttp.read(new ByteArrayInputStream(raw.getBytes(StandardCharsets.UTF_8)), LocalGate.MAX_HEAD, LocalGate.MAX_BODY);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    static String H = "Host: 127.0.0.1:47999";

    static LocalGate.Route route(String method, String path, String... headers) {
        StringBuilder b = new StringBuilder(method + " " + path + " HTTP/1.1\r\n");
        for (String h : headers) b.append(h).append("\r\n");
        return gate.route(req(b.append("\r\n").toString()));
    }

    static int status(LocalGate.Route r) { return r.answer == null ? 0 : r.answer.status; }

    static String code(LocalGate.Route r) {
        if (r.answer == null || r.answer.body == null) return null;
        int i = r.answer.body.indexOf("\"code\":\"");
        return i < 0 ? null : r.answer.body.substring(i + 8, r.answer.body.indexOf('"', i + 8));
    }

    static int badStatus(String raw) {
        try {
            LocalHttp.read(new ByteArrayInputStream(raw.getBytes(StandardCharsets.UTF_8)), LocalGate.MAX_HEAD, LocalGate.MAX_BODY);
            return 0;
        } catch (LocalHttp.Bad b) {
            return b.status;
        } catch (Exception e) {
            return -1;
        }
    }

    public static void main(String[] args) throws Exception {
        String chat = "0b6f3c1e-7a9d-4d2e-9b1a-2f4c5d6e7f80";
        String msgs = "/local/v1/chats/" + chat + "/messages";

        // ---- HTTP ----
        LocalHttp.Req r = req("POST /local/v1/pair?x=1&wait=5 HTTP/1.1\r\nHost: 127.0.0.1:47999\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}");
        eq(r.method, "POST", "method");
        eq(r.path, "/local/v1/pair", "path");
        eq(r.param("wait"), "5", "query parameter");
        eq(r.header("CONTENT-TYPE"), "application/json", "headers without case");
        eq(r.bodyText(), "{}", "body");
        eq(badStatus("GET / HTTP/1.1\r\nContent-Length: 70000\r\n\r\n"), 413, "body over 64 KB: 413 before reading it");
        eq(badStatus("GET / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n"), 411, "chunked: 411");
        eq(badStatus("GARBAGE\r\n\r\n"), 400, "malformed request line");
        eq(badStatus("GET / HTTP/1.1\r\nX: " + "a".repeat(20_000) + "\r\n\r\n"), 431, "headers too large");
        eq(badStatus("POST / HTTP/1.1\r\nContent-Length: 10\r\n\r\n{}"), 400, "body cut off");
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        LocalHttp.write(out, LocalHttp.error(429, "rate_limited", "slow \"down\"").header("Retry-After", "3"));
        String w = out.toString("UTF-8");
        eq(w.startsWith("HTTP/1.1 429 Too Many Requests\r\n"), true, "status line");
        eq(w.contains("Retry-After: 3\r\n") && w.contains("Connection: close\r\n"), true, "headers written");
        eq(w.endsWith("{\"error\":\"slow \\\"down\\\"\",\"code\":\"rate_limited\"}"), true, "JSON escaped: " + w);

        // ---- Host and Origin ----
        eq(status(route("GET", "/local/v1/status", H)), 0, "status passes");
        eq(status(route("GET", "/local/v1/status", "Host: localhost:47999")), 0, "localhost passes");
        eq(code(route("GET", "/local/v1/status", "Host: evil.example:47999")), "bad_host", "DNS rebinding: other Host");
        eq(code(route("GET", "/local/v1/status")), "bad_host", "no Host");
        LocalGate.Route evil = route("GET", "/local/v1/status", H, "Origin: https://evil.example");
        eq(status(evil), 400, "a web page elsewhere: 400");
        eq(evil.answer.headers.containsKey("Access-Control-Allow-Origin"), false, "no CORS for it");
        eq(status(route("GET", "/local/v1/status", H, "Origin: null")), 400, "Origin null refused");
        eq(route("GET", "/local/v1/status", H, "Origin: https://localhost").origin, "https://localhost", "the app's origin");
        eq(route("GET", "/local/v1/status", H, "Origin: http://localhost:5173").origin, "http://localhost:5173", "the dev server's origin");

        // ---- preflight ----
        LocalGate.Route pf = route("OPTIONS", msgs, H, "Origin: https://localhost", "Access-Control-Request-Method: POST",
                "Access-Control-Request-Headers: content-type", "Access-Control-Request-Private-Network: true");
        eq(status(pf), 204, "preflight 204");
        eq(pf.answer.headers.get("Access-Control-Allow-Origin"), "https://localhost", "preflight echoes the origin");
        eq(pf.answer.headers.get("Vary"), "Origin", "Vary: Origin");
        eq(pf.answer.headers.get("Access-Control-Allow-Methods"), "GET, POST, OPTIONS", "methods");
        eq(pf.answer.headers.get("Access-Control-Allow-Headers"), "Authorization, Content-Type", "headers");
        eq(pf.answer.headers.get("Access-Control-Allow-Private-Network"), "true", "Private Network Access");
        eq(route("OPTIONS", msgs, H, "Origin: http://localhost:5173").answer.headers.get("Access-Control-Allow-Origin"), "http://localhost:5173", "dev origin preflight");
        eq(status(route("OPTIONS", msgs, H, "Origin: https://evil.example")), 400, "preflight from elsewhere");

        // ---- routes ----
        eq(route("GET", "/local/v1/status", H).kind, LocalGate.Kind.STATUS, "status route");
        eq(code(route("GET", "/local/v1/nope", H)), "no_route", "unknown route");
        eq(code(route("GET", "/other", H)), "no_route", "outside /local/v1");
        eq(status(route("POST", "/local/v1/status", H)), 405, "wrong method");
        eq(status(route("GET", "/local/v1/pair", H)), 405, "pair is POST");
        eq(code(route("POST", "/local/v1/pair", H, "Content-Type: text/plain")), "bad_request", "POST must be JSON");
        eq(route("POST", "/local/v1/pair", H, "Content-Type: application/json; charset=utf-8").kind, LocalGate.Kind.PAIR_START, "pair route");
        eq(route("GET", "/local/v1/pair/0123456789abcdef0123456789abcdef", H).kind, LocalGate.Kind.PAIR_GET, "pair answer route");
        eq(code(route("GET", "/local/v1/pair/nothex", H)), "no_route", "a pairing id is hex");
        eq(code(route("GET", "/local/v1/chats/a.b/messages", H)), "unknown_chat", "malformed chat id");

        // ---- tokens: 403 "not_allowed" is the one answer for "pair first" ----
        LocalGate.Route no = route("GET", msgs, H, "Origin: https://localhost");
        eq(status(no), 403, "no token: 403");
        eq(code(no), "not_allowed", "no token: not_allowed");
        eq(no.answer.body.contains("\"pair\":true"), true, "says to pair");
        eq(no.answer.headers.get("Access-Control-Allow-Origin"), "https://localhost", "the 403 is readable by the page");
        eq(status(route("GET", msgs, H, "Authorization: Bearer " + "ab".repeat(32))), 403, "unknown token: 403");
        eq(status(route("GET", msgs, H, "Authorization: Bearer short")), 403, "malformed token: 403");

        // ---- pairing ----
        LocalGate.Pair p = gate.pairStart(chat, "Planner", null);
        eq(p.id.matches("[0-9a-f]{32}") && p.code.matches("[0-9a-f]{32}") && !p.id.equals(p.code), true, "pair id and code");
        eq(gate.pairByCode(p.code) == p, true, "found by code");
        eq(gate.pairTake(p.id).state, "pending", "pending");
        eq(gate.pairTake(p.id) != null, true, "pending stays");
        int[] saved = { 0 };
        gate.changed = () -> saved[0]++;
        eq(gate.approve(p.code, "com.example.planner", "Planner", "Weekly plan"), true, "approve");
        eq(saved[0], 1, "grants saved after approve");
        LocalGate.Pair got = gate.pairTake(p.id);
        eq(got.state, "allowed", "allowed");
        String token = got.token;
        eq(token.matches("[0-9a-f]{64}"), true, "token: 256 random bits");
        eq(gate.pairTake(p.id), null, "the token is handed out once");
        eq(gate.approve(p.code, "x", "x", "x"), false, "a code works once");
        eq(gate.save().contains(token), false, "the token itself isn't kept");

        LocalGate.Route ok = route("GET", msgs, H, "Authorization: Bearer " + token);
        eq(status(ok), 0, "the token passes");
        eq(ok.kind, LocalGate.Kind.MESSAGES_GET, "messages route");
        eq(ok.grant.pkg, "com.example.planner", "its app");
        eq(route("POST", msgs, H, "authorization: bearer " + token, "Content-Type: application/json").kind, LocalGate.Kind.MESSAGES_POST, "post route, header without case");
        eq(status(route("GET", "/local/v1/chats/otherchat/messages", H, "Authorization: Bearer " + token)), 403, "another chat: 403");
        eq(route("GET", "/local/v1/status", H, "Authorization: Bearer " + token).grant != null, true, "status knows the token");
        eq(status(route("GET", "/local/v1/status", H, "Authorization: Bearer " + "cd".repeat(32))), 0, "status with a bad token still answers");

        // A second approval for the same app and chat replaces the first token.
        LocalGate.Pair p2 = gate.pairStart(chat, "", null);
        gate.approve(p2.code, "com.example.planner", "Planner", "Weekly plan");
        String token2 = gate.pairTake(p2.id).token;
        eq(gate.byToken(token), null, "the old token is gone");
        eq(gate.byToken(token2) != null, true, "the new one works");
        eq(gate.grants().size(), 1, "one grant per app and chat");

        // Grants survive a restart (save/load), and revoke ends them.
        LocalGate g2 = new LocalGate(() -> now);
        g2.load(gate.save());
        eq(g2.byToken(token2) != null && g2.byToken(token2).title.equals("Weekly plan"), true, "grants round trip");
        LocalGate g3 = new LocalGate(() -> now);
        g3.load("garbage\n\t\t\n" + gate.save().replace("Weekly plan", "Weekly\tplan"));
        eq(g3.grants().size(), 0, "a broken line is dropped");
        gate.revoke(gate.byToken(token2).hash);
        eq(status(route("GET", msgs, H, "Authorization: Bearer " + token2)), 403, "revoked: 403");

        // Deny, expiry, how many wait.
        LocalGate.Pair d = gate.pairStart(chat, "", null);
        gate.deny(d.code);
        eq(gate.pairTake(d.id).state, "denied", "denied");
        eq(gate.pairTake(d.id), null, "a denial is handed out once");
        LocalGate.Pair old = gate.pairStart(chat, "", null);
        now += LocalGate.PAIR_TTL + 1;
        eq(gate.pairTake(old.id), null, "a pairing runs out after 10 minutes");
        eq(gate.pairByCode(old.code), null, "its code too");
        for (int i = 0; i < LocalGate.MAX_PENDING; i++) eq(gate.pairStart(chat, "", null) != null, true, "pending " + i);
        eq(gate.pairStart(chat, "", null), null, "at most " + LocalGate.MAX_PENDING + " wait");
        eq(gate.pairStart(chat, "", "0123456789abcdef0123456789abcdef"), null, "the rig's code too");
        now += LocalGate.PAIR_TTL + 1;
        eq(gate.pairStart(chat, "", "0123456789abcdef0123456789abcdef").code, "0123456789abcdef0123456789abcdef", "a fixed code (rig)");
        LocalGate.Pair waited = gate.pairStart(chat, "", null);
        long t0 = System.currentTimeMillis();
        new Thread(() -> { try { Thread.sleep(150); } catch (InterruptedException ignored) { } gate.approve(waited.code, "a.b", "A", "T"); }).start();
        LocalGate gReal = gate;
        eq(gReal.awaitPair(waited.id, 5_000).state, "allowed", "a long poll wakes on the answer");
        eq(System.currentTimeMillis() - t0 < 4_000, true, "at once");

        // ---- limits ----
        eq(LocalGate.checkMessage("hi", null), null, "a message");
        eq(LocalGate.checkMessage("  \n", null).status, 400, "an empty message");
        eq(LocalGate.checkMessage(null, null).status, 400, "no text");
        eq(LocalGate.checkMessage("x".repeat(LocalGate.MAX_TEXT), null), null, "16 KB of text");
        eq(LocalGate.checkMessage("x".repeat(LocalGate.MAX_TEXT + 1), null).status, 413, "over 16 KB: 413");
        eq(LocalGate.checkMessage("é".repeat(LocalGate.MAX_TEXT / 2 + 1), null).status, 413, "counted in UTF-8 bytes");
        eq(LocalGate.checkMessage("hi", "c".repeat(4096)), null, "4 KB of context");
        LocalHttp.Res cbig = LocalGate.checkMessage("hi", "c".repeat(4097));
        eq(cbig.status + " " + cbig.body.contains("context_too_large"), "413 true", "context over 4 KB: 413");

        // ---- rates ----
        LocalGate.Pair rp = gate.pairStart(chat, "", null);
        gate.approve(rp.code, "r.app", "R", "T");
        LocalGate.Grant rg = gate.byToken(gate.pairTake(rp.id).token);
        int okSends = 0;
        LocalHttp.Res limited = null;
        for (int i = 0; i < 10 && limited == null; i++) { limited = gate.takeSend(rg); if (limited == null) okSends++; }
        eq(okSends, 6, "6 messages at once");
        eq(limited.status, 429, "then 429");
        eq(limited.headers.get("Retry-After"), "10", "with Retry-After");
        now += 10_000;
        eq(gate.takeSend(rg), null, "one more after 10 s");
        eq(gate.pollStart(rg), null, "a long poll");
        eq(gate.pollStart(rg), null, "a second");
        eq(gate.pollStart(rg).status, 429, "a third waits: 429");
        gate.pollDone(rg);
        eq(gate.pollStart(rg), null, "after one ended");
        LocalGate.Bucket b = new LocalGate.Bucket(2, 1_000);
        eq(b.take(0), 0L, "bucket 1");
        eq(b.take(0), 0L, "bucket 2");
        eq(b.take(0), 1_000L, "bucket empty: wait 1 s");
        eq(b.take(500), 500L, "half way");
        eq(b.take(1_000), 0L, "refilled");
        now += 60_000;
        int pairs = 0;
        for (int i = 0; i < 5; i++) if (gate.takePairStart() == null) pairs++;
        eq(pairs, 3, "3 pairings at once");

        // ---- cursors ----
        String cur = new LocalGate.Cursor(1761200000300L, true, "pc:desk").toString();
        LocalGate.Cursor c = LocalGate.Cursor.parse(cur);
        eq(c.rev + "|" + c.running + "|" + c.via, "1761200000300|true|pc:desk", "cursor round trip");
        LocalGate.Cursor c0 = LocalGate.Cursor.parse(new LocalGate.Cursor(5, false, "").toString());
        eq(c0.rev + "|" + c0.running + "|" + c0.via, "5|false|", "the first PC's cursor");
        eq(LocalGate.Cursor.parse("nonsense"), null, "not a cursor");
        eq(LocalGate.Cursor.parse("1.-5.i."), null, "negative revision");
        eq(LocalGate.Cursor.parse("2.5.i."), null, "another version");
        eq(LocalGate.Cursor.parse("1.5.i.abc"), null, "odd hex");

        // ---- who calls: /proc/net/tcp ----
        String tcp = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
                + "   0: 0100007F:BB7F 00000000:0000 0A 00000000:00000000 00:00000000 00000000 10123        0 1 1\n"
                + "   1: 0100007F:BB7F 0100007F:9C41 01 00000000:00000000 00:00000000 00000000 10123        0 2 1\n"
                + "   2: 0100007F:9C41 0100007F:BB7F 01 00000000:00000000 00:00000000 00000000 10245        0 3 1\n";
        eq(LocalGate.uidFromProcNet(tcp, 0x9C41, 47999), 10245, "the client's side of the connection");
        eq(LocalGate.uidFromProcNet(tcp, 1234, 47999), -1, "no such connection");
        String tcp6 = "   0: 0000000000000000FFFF00000100007F:9C42 0000000000000000FFFF00000100007F:BB7F 01 00000000:00000000 00:00000000 00000000 10300 0 4 1\n";
        eq(LocalGate.uidFromProcNet(tcp6, 0x9C42, 47999), 10300, "IPv4 in tcp6");
        eq(LocalGate.uidFromProcNet(null, 1, 2), -1, "unreadable");

        // ---- the approval link ----
        ChatLink l = ChatLink.parse("harbor://chat/" + chat + "?approve=0123456789abcdef0123456789abcdef");
        eq(l.approve, "0123456789abcdef0123456789abcdef", "approve= in a chat link");
        eq(ChatLink.parse("harbor://chat/" + chat + "?approve=XYZ").approve, null, "a malformed code is no approval");
        eq(ChatLink.parse("harbor://chat/" + chat).approve, null, "a plain link");

        if (fails > 0) { System.out.println(fails + " local API checks failed"); System.exit(1); }
        System.out.println("LocalApiTest ok");
    }
}
