package dev.harbor.app;

import android.app.AlertDialog;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

/** A test build's hooks for the local API (scripts/boat/phoneshot --broadcast; never in a
 *  release, Rig.on()): RIG_LOCAL_PAIR runs the API end to end from inside the app, as another
 *  app's client would over 127.0.0.1:47999 (raw sockets, so each header is the one written
 *  here), pairing with the rig chat "Speed up the checkout page" (code LocalApi.RIG_CODE: the
 *  approval link is `--view cards --approve <it>`), and logs "LOCALAPI PASS|FAIL …" lines;
 *  RIG_LOCAL_ALLOW taps Allow on the approval dialog. */
final class LocalRig {
    private LocalRig() { }

    static final String CHAT_TITLE = "Speed up the checkout page";

    static void hook(Context app) {
        BroadcastReceiver r = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent in) {
                if (in.getAction().endsWith("RIG_LOCAL_ALLOW")) {
                    Ui.main.post(() -> {
                        AlertDialog d = LocalApi.asking;
                        if (d != null) d.getButton(AlertDialog.BUTTON_POSITIVE).performClick();
                        else Log.i(LocalApi.TAG, "LOCALAPI FAIL allow: no dialog on screen");
                    });
                    return;
                }
                new Thread(LocalRig::run, "local-rig").start();
            }
        };
        IntentFilter f = new IntentFilter("dev.harbor.app.RIG_LOCAL_PAIR");
        f.addAction("dev.harbor.app.RIG_LOCAL_ALLOW");
        if (Build.VERSION.SDK_INT >= 33) app.registerReceiver(r, f, Context.RECEIVER_EXPORTED);
        else app.registerReceiver(r, f);
    }

    private static int pass, fail;

    private static String rep(char c, int n) {
        char[] a = new char[n];
        java.util.Arrays.fill(a, c);
        return new String(a);
    }

    private static void check(boolean ok, String what, String detail) {
        if (ok) pass++; else fail++;
        Log.i(LocalApi.TAG, "LOCALAPI " + (ok ? "PASS " : "FAIL ") + what + (ok ? "" : ": " + detail));
    }

    /** One answer: status, headers (lower-case names, as one string) and body. */
    private static final class Ans {
        int status;
        String head = "", body = "";
        JSONObject json() { try { return new JSONObject(body); } catch (Exception e) { return new JSONObject(); } }
    }

    private static Ans call(String method, String path, String origin, String token, String body, String... extra) {
        Ans a = new Ans();
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress("127.0.0.1", LocalGate.PORT), 3_000);
            s.setSoTimeout(40_000);
            byte[] b = body == null ? new byte[0] : body.getBytes(StandardCharsets.UTF_8);
            StringBuilder h = new StringBuilder(method + " " + path + " HTTP/1.1\r\nHost: 127.0.0.1:" + LocalGate.PORT + "\r\n");
            if (origin != null) h.append("Origin: ").append(origin).append("\r\n");
            if (token != null) h.append("Authorization: Bearer ").append(token).append("\r\n");
            if (body != null) h.append("Content-Type: application/json\r\nContent-Length: ").append(b.length).append("\r\n");
            for (String x : extra) h.append(x).append("\r\n");
            h.append("\r\n");
            OutputStream o = s.getOutputStream();
            o.write(h.toString().getBytes(StandardCharsets.ISO_8859_1));
            o.write(b);
            o.flush();
            InputStream in = s.getInputStream();
            ByteArrayOutputStream all = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            for (int n; (n = in.read(buf)) > 0; ) all.write(buf, 0, n);
            String t = all.toString("UTF-8");
            int split = t.indexOf("\r\n\r\n");
            String head = split < 0 ? t : t.substring(0, split);
            a.status = Integer.parseInt(head.split(" ")[1]);
            a.head = head.toLowerCase();
            a.body = split < 0 ? "" : t.substring(split + 4);
        } catch (Exception e) {
            a.status = -1;
            a.body = String.valueOf(e);
        }
        return a;
    }

    private static void run() {
        pass = 0; fail = 0;
        try {
            String chat = null;
            for (Hub h : Hub.all(Ui.app)) {
                JSONArray cs = h.state().optJSONArray("chats");
                for (int i = 0; cs != null && i < cs.length(); i++)
                    if (CHAT_TITLE.equals(cs.getJSONObject(i).optString("title"))) chat = cs.getJSONObject(i).optString("id");
            }
            check(chat != null, "rig chat", "no chat titled " + CHAT_TITLE);
            if (chat == null) return;
            String base = "/local/v1/chats/" + chat + "/messages";

            Ans st = call("GET", "/local/v1/status", null, null, null);
            check(st.status == 200 && st.json().optBoolean("signed_in") && !st.json().optBoolean("allowed"), "status", st.status + " " + st.body);
            Ans pf = call("OPTIONS", base, "https://localhost", null, null, "Access-Control-Request-Method: POST",
                    "Access-Control-Request-Headers: content-type", "Access-Control-Request-Private-Network: true");
            check(pf.status == 204 && pf.head.contains("access-control-allow-origin: https://localhost") && pf.head.contains("access-control-allow-private-network: true")
                    && pf.head.contains("access-control-allow-headers: authorization, content-type"), "preflight", pf.status + " " + pf.head);
            Ans dev = call("OPTIONS", base, "http://localhost:5173", null, null, "Access-Control-Request-Method: GET");
            check(dev.status == 204 && dev.head.contains("access-control-allow-origin: http://localhost:5173"), "preflight dev origin", dev.head);
            Ans evil = call("GET", "/local/v1/status", "https://evil.example", null, null);
            check(evil.status == 400 && !evil.head.contains("access-control-allow-origin"), "other origin refused", evil.status + " " + evil.head);
            Ans none = call("GET", base, "https://localhost", null, null);
            check(none.status == 403 && "not_allowed".equals(none.json().optString("code")) && none.head.contains("access-control-allow-origin: https://localhost"), "no token: 403", none.status + " " + none.body);
            Ans big = call("POST", base, null, null, null, "Content-Type: application/json", "Content-Length: " + (70 * 1024));
            check(big.status == 413, "body over 64 KB: 413", big.status + " " + big.body);

            Ans p = call("POST", "/local/v1/pair", "https://localhost", null, "{\"chat\":\"" + chat + "\",\"app\":\"Planner\"}");
            String pair = p.json().optString("pair");
            check(p.status == 200 && p.json().optString("link").equals("harbor://chat/" + chat + "?approve=" + LocalApi.RIG_CODE), "pair", p.status + " " + p.body);
            String token = null;
            long end = System.currentTimeMillis() + 5 * 60_000;
            while (System.currentTimeMillis() < end) {
                Ans w = call("GET", "/local/v1/pair/" + pair + "?wait=25", "https://localhost", null, null);
                String state = w.json().optString("state");
                if (state.equals("pending")) continue;
                check(state.equals("allowed") && w.json().optString("token").length() == 64, "pairing allowed", w.status + " " + w.body);
                token = w.json().optString("token");
                break;
            }
            if (token == null) { check(false, "pairing allowed", "no answer in 5 minutes"); return; }
            Ans again = call("GET", "/local/v1/pair/" + pair, null, null, null);
            check(again.status == 404, "token handed out once", again.status + " " + again.body);

            Ans st2 = call("GET", "/local/v1/status", null, token, null);
            JSONObject sj = st2.json();
            check(st2.status == 200 && sj.optBoolean("allowed") && sj.optBoolean("pc_online") && sj.optJSONObject("chat") != null
                    && CHAT_TITLE.equals(sj.optJSONObject("chat").optString("title")), "status with token", st2.body);
            Ans first = call("GET", base, "https://localhost", token, null);
            JSONObject fj = first.json();
            JSONArray ms = fj.optJSONArray("messages");
            check(first.status == 200 && ms != null && ms.length() > 0 && !fj.optString("cursor").isEmpty(), "recent messages", first.status + " " + first.body.substring(0, Math.min(400, first.body.length())));
            String cursor = fj.optString("cursor");
            Ans quiet = call("GET", base + "?after=" + cursor + "&wait=2", null, token, null);
            check(quiet.status == 200 && quiet.json().optJSONArray("messages") != null && quiet.json().optJSONArray("messages").length() == 0, "long poll, nothing new", quiet.body);
            Ans bad = call("GET", base + "?after=nonsense", null, token, null);
            check(bad.status == 400 && "bad_cursor".equals(bad.json().optString("code")), "bad cursor: 400", bad.body);
            Ans tooLong = call("POST", base, null, token, "{\"text\":\"" + rep('y', 17 * 1024) + "\"}");
            check(tooLong.status == 413 && "text_too_large".equals(tooLong.json().optString("code")), "text over 16 KB: 413", tooLong.body);
            Ans ctxLong = call("POST", base, null, token, "{\"text\":\"hi\",\"context\":\"" + rep('z', 5000) + "\"}");
            check(ctxLong.status == 413 && "context_too_large".equals(ctxLong.json().optString("code")), "context over 4 KB: 413", ctxLong.body);
            Ans other = call("GET", "/local/v1/chats/someotherchat/messages", null, token, null);
            check(other.status == 403, "another chat: 403", other.status + " " + other.body);
            Ans sent = call("POST", base, "https://localhost", token, "{\"text\":\"Hello from the rig app\",\"context\":\"Today: 3 shifts, 1 gap at 14:00\"}");
            check(sent.status == 200 && sent.json().optBoolean("ok"), "send", sent.status + " " + sent.body);
            Log.i(LocalApi.TAG, "LOCALAPI send answered " + sent.body);
            Ans after = call("GET", base + "?after=" + cursor + "&wait=10", null, token, null);
            JSONArray am = after.json().optJSONArray("messages");
            boolean seen = false;
            for (int i = 0; am != null && i < am.length(); i++) if ("Hello from the rig app".equals(am.optJSONObject(i).optString("text"))) seen = true;
            check(after.status == 200 && seen, "long poll sees the message", after.body.substring(0, Math.min(600, after.body.length())));
            int limited = 0;
            for (int i = 0; i < 8; i++) if (call("POST", base, null, token, "{\"text\":\"burst " + i + "\"}").status == 429) limited++;
            check(limited > 0, "rate limit: 429", "no 429 in 8 quick sends");
        } catch (Exception e) {
            check(false, "selftest", String.valueOf(e));
        } finally {
            Log.i(LocalApi.TAG, "LOCALAPI SELFTEST " + pass + " passed, " + fail + " failed");
        }
    }
}
