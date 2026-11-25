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
 *  app's client would over 127.0.0.1:47998 (raw sockets, so each header is the one written
 *  here), pairing with the rig chat "Speed up the checkout page" (code LocalApi.RIG_CODE: the
 *  approval link is `--view cards --approve <it>`), and logs "LOCALAPI PASS|FAIL …" lines;
 *  RIG_LOCAL_ALLOW / RIG_LOCAL_DENY tap Allow / Don't allow on the approval dialog (and check that
 *  Harbor stepped back to the app); RIG_LOCAL_CLOSE closes every Harbor screen, so the next link
 *  starts Hubs afresh. The app that opens the link can be the test caller (android/rigcaller,
 *  phoneshot --via), as a Capacitor app does. RIG_LOCAL_BG runs the chat calls again with the
 *  token the pairing gave (kept in the rig's prefs), with no Harbor screen: after phoneshot
 *  --cold (Harbor's process ended, then started by its notification service Listen alone, the
 *  test caller in front), as a backgrounded Harbor on a phone is; logs "LOCALAPI PASS|FAIL BG …".
 *  RIG_LOCAL_PAIR also runs attachments and voice messages through the API ("LOCALAPI PASS|FAIL
 *  FILES|VOICE …", files): the rig hub stands in for a transcriber (phonehub.ts). */
final class LocalRig {
    private LocalRig() { }

    static final String CHAT_TITLE = "Speed up the checkout page";

    static void hook(Context app) {
        BroadcastReceiver r = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent in) {
                if (in.getAction().endsWith("RIG_LOCAL_ALLOW") || in.getAction().endsWith("RIG_LOCAL_DENY")) {
                    boolean allow = in.getAction().endsWith("RIG_LOCAL_ALLOW");
                    Ui.main.post(() -> {
                        AlertDialog d = LocalApi.asking;
                        if (d != null) d.getButton(allow ? AlertDialog.BUTTON_POSITIVE : AlertDialog.BUTTON_NEGATIVE).performClick();
                        else Log.i(LocalApi.TAG, "LOCALAPI FAIL " + (allow ? "allow" : "deny") + ": no dialog on screen");
                    });
                    // Then Harbor steps back to the app that asked: no Harbor screen in front.
                    Ui.main.postDelayed(() -> Log.i(LocalApi.TAG, "LOCALAPI " + (Base.resumed == 0 ? "PASS" : "FAIL")
                            + " back to the app (Hub screens in front: " + Base.resumed + ")"), 2_500);
                    return;
                }
                if (in.getAction().endsWith("RIG_LOCAL_BG")) {
                    new Thread(LocalRig::background, "local-rig-bg").start();
                    return;
                }
                if (in.getAction().endsWith("RIG_LOCAL_CLOSE")) {
                    // Every Harbor screen closes (the process and the local API stay): the next
                    // approval link starts Hubs afresh instead of reaching it through onNewIntent.
                    Ui.main.post(() -> { for (Base b : new java.util.ArrayList<>(Base.alive)) b.finishAndRemoveTask(); });
                    return;
                }
                new Thread(LocalRig::run, "local-rig").start();
            }
        };
        IntentFilter f = new IntentFilter("dev.harbor.app.RIG_LOCAL_PAIR");
        f.addAction("dev.harbor.app.RIG_LOCAL_ALLOW");
        f.addAction("dev.harbor.app.RIG_LOCAL_DENY");
        f.addAction("dev.harbor.app.RIG_LOCAL_CLOSE");
        f.addAction("dev.harbor.app.RIG_LOCAL_BG");
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
        byte[] bytes = new byte[0];
        JSONObject json() { try { return new JSONObject(body); } catch (Exception e) { return new JSONObject(); } }
    }

    private static Ans call(String method, String path, String origin, String token, String body, String... extra) {
        return callBytes(method, path, origin, token, body == null ? null : body.getBytes(StandardCharsets.UTF_8), extra);
    }

    private static Ans callBytes(String method, String path, String origin, String token, byte[] body, String... extra) {
        Ans a = new Ans();
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress("127.0.0.1", LocalGate.PORT), 3_000);
            s.setSoTimeout(150_000);
            byte[] b = body == null ? new byte[0] : body;
            StringBuilder h = new StringBuilder(method + " " + path + " HTTP/1.1\r\nHost: 127.0.0.1:" + LocalGate.PORT + "\r\n");
            if (origin != null) h.append("Origin: ").append(origin).append("\r\n");
            if (token != null) h.append("Authorization: Bearer ").append(token).append("\r\n");
            boolean typed = false;
            for (String x : extra) if (x.toLowerCase().startsWith("content-type:")) typed = true;
            if (body != null) h.append(typed ? "" : "Content-Type: application/json\r\n").append("Content-Length: ").append(b.length).append("\r\n");
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
            byte[] raw = all.toByteArray();
            int split = -1;
            for (int i = 0; i + 3 < raw.length; i++) if (raw[i] == '\r' && raw[i + 1] == '\n' && raw[i + 2] == '\r' && raw[i + 3] == '\n') { split = i; break; }
            String head = new String(raw, 0, split < 0 ? raw.length : split, StandardCharsets.ISO_8859_1);
            a.status = Integer.parseInt(head.split(" ")[1]);
            a.head = head.toLowerCase();
            a.bytes = split < 0 ? new byte[0] : java.util.Arrays.copyOfRange(raw, split + 4, raw.length);
            a.body = new String(a.bytes, StandardCharsets.UTF_8);
        } catch (Exception e) {
            a.status = -1;
            a.body = String.valueOf(e);
        }
        return a;
    }

    /** The chat calls with no Harbor screen (RIG_LOCAL_BG, after phoneshot --cold): status,
     *  the recent messages, a send with context, and the long poll that sees it. */
    private static void background() {
        pass = 0; fail = 0;
        try {
            android.content.SharedPreferences p = Ui.app.getSharedPreferences("localrig", Context.MODE_PRIVATE);
            String token = p.getString("token", null), chat = p.getString("chat", null);
            check(token != null && chat != null, "BG token from the pairing", "none kept: run RIG_LOCAL_PAIR and allow it first");
            if (token == null || chat == null) return;
            Log.i(LocalApi.TAG, "LOCALAPI BG Hub screens: " + Base.alive.size() + " alive, " + Base.resumed + " in front; Listen "
                    + (Listen.listening() ? "running" : "not running") + "; process up " + (android.os.SystemClock.elapsedRealtime() - android.os.Process.getStartElapsedRealtime()) + " ms");
            check(Base.alive.isEmpty(), "BG no Hub screen in this process", Base.alive.size() + " screens");
            // As Hub.learn does on a real mesh: the rig's PC knows its own mesh id, so the chat's own
            // PC is one the phone can call directly (LocalApi.on), not only through the PC in use.
            for (Hub h : Hub.all(Ui.app)) {
                JSONObject c = Hub.chat(h.state(), chat);
                String home = c == null ? "" : c.optString("home", "");
                Log.i(LocalApi.TAG, "LOCALAPI BG the chat's home: " + (home.isEmpty() ? "(none said)" : home));
                if (!home.isEmpty() && h.pid.isEmpty()) { h.pid = home; Hub.put(Ui.app, h); }
            }
            String base = "/local/v1/chats/" + chat + "/messages";
            Ans st = call("GET", "/local/v1/status", "https://localhost", token, null);
            JSONObject sj = st.json();
            check(st.status == 200 && sj.optBoolean("pc_online") && sj.optJSONObject("chat") != null && sj.optJSONObject("chat").optBoolean("online"),
                    "BG status: the chat's PC online", st.status + " " + st.body);
            Ans first = call("GET", base, "https://localhost", token, null);
            String cursor = first.json().optString("cursor");
            check(first.status == 200 && !cursor.isEmpty(), "BG recent messages", first.status + " " + first.body.substring(0, Math.min(300, first.body.length())));
            String text = "From the background " + System.currentTimeMillis();
            Ans sent = call("POST", base, "https://localhost", token, "{\"text\":\"" + text + "\",\"context\":\"Stats: 4 shifts, no gaps\"}");
            check(sent.status == 200 && sent.json().optBoolean("ok"), "BG send with context", sent.status + " " + sent.body);
            Ans after = call("GET", base + "?after=" + cursor + "&wait=15", "https://localhost", token, null);
            JSONArray am = after.json().optJSONArray("messages");
            boolean seen = false;
            for (int i = 0; am != null && i < am.length(); i++) if (text.equals(am.optJSONObject(i).optString("text"))) seen = true;
            check(after.status == 200 && seen, "BG long poll sees the message", after.status + " " + after.body.substring(0, Math.min(600, after.body.length())));
        } catch (Exception e) {
            check(false, "BG selftest", String.valueOf(e));
        } finally {
            Log.i(LocalApi.TAG, "LOCALAPI BG SELFTEST " + pass + " passed, " + fail + " failed");
        }
    }

    // ---- attachments and voice messages ----

    /** A POST of raw bytes (a large body without a large string), retried after a 429's Retry-After. */
    private static Ans postRetry(String path, String token, byte[] body) {
        Ans a = null;
        for (int i = 0; i < 3; i++) {
            a = callBytes("POST", path, "https://localhost", token, body, "Content-Type: application/json");
            if (a.status != 429) return a;
            int wait = 2;
            java.util.regex.Matcher m = java.util.regex.Pattern.compile("retry-after: (\\d+)").matcher(a.head);
            if (m.find()) wait = Integer.parseInt(m.group(1));
            Log.i(LocalApi.TAG, "LOCALAPI rig: 429, waiting " + wait + " s");
            try { Thread.sleep(wait * 1000L + 200); } catch (InterruptedException e) { break; }
        }
        return a;
    }

    private static String b64(byte[] b) { return android.util.Base64.encodeToString(b, android.util.Base64.NO_WRAP); }

    private static String att(String name, String mime, byte[] data) {
        return "{\"name\":" + LocalHttp.q(name) + ",\"mime\":" + LocalHttp.q(mime) + ",\"data_base64\":\"" + b64(data) + "\"}";
    }

    private static byte[] utf8(String s) { return s.getBytes(StandardCharsets.UTF_8); }

    private static byte[] png() {
        android.graphics.Bitmap b = android.graphics.Bitmap.createBitmap(64, 48, android.graphics.Bitmap.Config.ARGB_8888);
        b.eraseColor(0xff4fb3a9);
        java.io.ByteArrayOutputStream o = new java.io.ByteArrayOutputStream();
        b.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, o);
        return o.toByteArray();
    }

    private static byte[] pdf() throws java.io.IOException {
        android.graphics.pdf.PdfDocument d = new android.graphics.pdf.PdfDocument();
        android.graphics.pdf.PdfDocument.Page pg = d.startPage(new android.graphics.pdf.PdfDocument.PageInfo.Builder(200, 200, 1).create());
        android.graphics.Paint p = new android.graphics.Paint();
        p.setTextSize(14);
        pg.getCanvas().drawText("Shift plan: Mon 9-17", 10, 40, p);
        d.finishPage(pg);
        java.io.ByteArrayOutputStream o = new java.io.ByteArrayOutputStream();
        d.writeTo(o);
        d.close();
        return o.toByteArray();
    }

    /** secs of a 440 Hz tone (silent: amp 0) encoded by this phone's encoder for mime into a muxer
     *  file (MediaMuxer format fmt): a recording as a WebView's MediaRecorder makes one. */
    private static byte[] tone(String mime, int fmt, int rate, double secs, float amp) throws Exception {
        android.media.MediaFormat f = android.media.MediaFormat.createAudioFormat(mime, rate, 1);
        f.setInteger(android.media.MediaFormat.KEY_BIT_RATE, mime.equals(android.media.MediaFormat.MIMETYPE_AUDIO_AAC) ? 64_000 : 32_000);
        if (mime.equals(android.media.MediaFormat.MIMETYPE_AUDIO_AAC))
            f.setInteger(android.media.MediaFormat.KEY_AAC_PROFILE, android.media.MediaCodecInfo.CodecProfileLevel.AACObjectLC);
        f.setInteger(android.media.MediaFormat.KEY_MAX_INPUT_SIZE, 16_384);
        android.media.MediaCodec c = android.media.MediaCodec.createEncoderByType(mime);
        c.configure(f, null, null, android.media.MediaCodec.CONFIGURE_FLAG_ENCODE);
        c.start();
        java.io.File out = java.io.File.createTempFile("rigtone", ".a", Ui.app.getCacheDir());
        android.media.MediaMuxer mx = new android.media.MediaMuxer(out.getPath(), fmt);
        int track = -1;
        long total = (long) (secs * rate), fed = 0;
        boolean inDone = false;
        android.media.MediaCodec.BufferInfo info = new android.media.MediaCodec.BufferInfo();
        long end = System.currentTimeMillis() + 20_000;
        try {
            while (System.currentTimeMillis() < end) {
                if (!inDone) {
                    int i = c.dequeueInputBuffer(10_000);
                    if (i >= 0) {
                        java.nio.ByteBuffer b = c.getInputBuffer(i);
                        if (fed >= total) {
                            c.queueInputBuffer(i, 0, 0, fed * 1_000_000L / rate, android.media.MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inDone = true;
                        } else {
                            int n = (int) Math.min(Math.min(b.capacity() / 2, 1024), total - fed);
                            b.clear();
                            b.order(java.nio.ByteOrder.nativeOrder());
                            for (int k = 0; k < n; k++) b.putShort((short) (Math.sin(2 * Math.PI * 440 * (fed + k) / rate) * amp * 32767));
                            c.queueInputBuffer(i, 0, n * 2, fed * 1_000_000L / rate, 0);
                            fed += n;
                        }
                    }
                }
                int o = c.dequeueOutputBuffer(info, 10_000);
                if (o == android.media.MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    track = mx.addTrack(c.getOutputFormat());
                    mx.start();
                } else if (o >= 0) {
                    java.nio.ByteBuffer b = c.getOutputBuffer(o);
                    if ((info.flags & android.media.MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) info.size = 0;
                    if (info.size > 0 && track >= 0) mx.writeSampleData(track, b, info);
                    c.releaseOutputBuffer(o, false);
                    if ((info.flags & android.media.MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) break;
                }
            }
        } finally {
            c.stop();
            c.release();
            if (track >= 0) mx.stop();
            mx.release();
        }
        byte[] bytes = java.nio.file.Files.readAllBytes(out.toPath());
        out.delete();
        return bytes;
    }

    private static JSONObject findMessage(JSONArray ms, String role, String textPart) {
        for (int i = 0; ms != null && i < ms.length(); i++) {
            JSONObject m = ms.optJSONObject(i);
            if (m != null && role.equals(m.optString("role")) && m.optString("text").contains(textPart)) return m;
        }
        return null;
    }

    /** The message of role whose text has part, once it shows after cursor (a queued one shows when
     *  the turn before it ends), waiting up to secs; null when it doesn't. */
    private static JSONObject awaitMessage(String base, String token, String cursor, String role, String part, int secs) {
        long end = System.currentTimeMillis() + secs * 1000L;
        Ans a = null;
        while (System.currentTimeMillis() < end) {
            a = call("GET", base + "?after=" + cursor + "&wait=3", null, token, null);
            JSONObject m = findMessage(a.json().optJSONArray("messages"), role, part);
            if (m != null) return m;
            if (a.status != 200) try { Thread.sleep(500); } catch (InterruptedException e) { break; }
        }
        Log.i(LocalApi.TAG, "LOCALAPI rig: no " + role + " message with \"" + part + "\" after " + secs + " s: " + (a == null ? "" : a.body.substring(0, Math.min(400, a.body.length()))));
        return null;
    }

    private static double secondsIn(String transcript) {
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("Voice note of ([0-9.]+) seconds").matcher(transcript == null ? "" : transcript);
        return m.find() ? Double.parseDouble(m.group(1)) : -1;
    }

    /** Attachments end to end (PROTOCOL.md "Attachments"): refusals, an image and a PDF sent, a
     *  repeat of it that uploads nothing, both read back through the files route (and a thumbnail),
     *  the files route's token, chat and id checks, a reply's file and a user's image from the rig
     *  chat; then voice messages (MP4/AAC, WebM/Opus, Ogg/Opus made here by the phone's encoders)
     *  transcribed by the rig hub's stand-in, and a silent one that sends nothing. */
    private static void files(String chat, String token, String base) throws Exception {
        String filesBase = "/local/v1/chats/" + chat + "/files/";
        byte[] img = png(), doc = pdf();
        // Every message of the rig chat (its reply with a file, its user message with an image).
        Ans all = call("GET", base + "?limit=200", null, token, null);
        JSONArray allMs = all.json().optJSONArray("messages");
        String cursor = all.json().optString("cursor");

        Ans mismatch = postRetry(base, token, utf8("{\"text\":\"x\",\"attachments\":[" + att("a.png", "image/png", doc) + "]}"));
        check(mismatch.status == 415 && "bad_attachment".equals(mismatch.json().optString("code")), "FILES mime vs bytes: 415", mismatch.status + " " + mismatch.body);
        StringBuilder five = new StringBuilder("{\"text\":\"x\",\"attachments\":[");
        for (int i = 0; i < 5; i++) five.append(i > 0 ? "," : "").append(att(i + ".png", "image/png", img));
        Ans many = postRetry(base, token, utf8(five.append("]}").toString()));
        check(many.status == 400 && "too_many_attachments".equals(many.json().optString("code")), "FILES five files: 400", many.status + " " + many.body);
        Ans huge = call("POST", base, null, token, null, "Content-Type: application/json", "Content-Length: " + (16 * 1024 * 1024));
        check(huge.status == 413 && "attachments_too_large".equals(huge.json().optString("code")), "FILES body over 15 MB: 413 before reading", huge.status + " " + huge.body);
        byte[] big = new byte[(int) (10.2 * 1024 * 1024)];
        System.arraycopy(img, 0, big, 0, 16);
        Ans tooBig = postRetry(base, token, utf8("{\"text\":\"x\",\"attachments\":[" + att("big.png", "image/png", big) + "]}"));
        check(tooBig.status == 413 && "attachments_too_large".equals(tooBig.json().optString("code")), "FILES over 10 MB decoded: 413", tooBig.status + " " + tooBig.body);
        big = null;

        int up0 = LocalApi.uploads.get();
        String cid = "rig-files-" + System.currentTimeMillis();
        String text = "Here are today's photo and the plan";
        byte[] sendBody = utf8("{\"text\":\"" + text + "\",\"client_id\":\"" + cid + "\",\"attachments\":[" + att("photo.png", "image/png", img) + ","
                + att("../../plan", "application/pdf", doc) + "]}");
        Ans sent = postRetry(base, token, sendBody);
        check(sent.status == 200 && sent.json().optBoolean("ok"), "FILES image + PDF sent", sent.status + " " + sent.body);
        check(LocalApi.uploads.get() - up0 == 2, "FILES two uploads", (LocalApi.uploads.get() - up0) + " uploads");
        Ans again = postRetry(base, token, sendBody);
        check(again.status == 200 && again.body.equals(sent.body) && LocalApi.uploads.get() - up0 == 2, "FILES a repeat (same client_id) uploads nothing",
                again.status + " " + again.body + " uploads " + (LocalApi.uploads.get() - up0));

        JSONObject mine = awaitMessage(base, token, cursor, "user", text, 30);
        JSONArray as = mine == null ? null : mine.optJSONArray("attachments");
        check(mine != null && mine.optString("text").contains("[Image #1]") && as != null && as.length() == 2, "FILES the message with its 2 attachments",
                String.valueOf(mine));
        if (as == null || as.length() < 2) return;
        JSONObject ai = as.getJSONObject(0), ap = as.getJSONObject(1);
        check("photo.png".equals(ai.optString("name")) && "image/png".equals(ai.optString("mime")) && ai.optLong("size") == img.length && "image".equals(ai.optString("kind")),
                "FILES image attachment", ai.toString());
        check("plan.pdf".equals(ap.optString("name")) && "application/pdf".equals(ap.optString("mime")) && ap.optLong("size") == doc.length && !ap.isNull("url"),
                "FILES PDF attachment: name cleaned, kept here", ap.toString());
        Ans gi = callBytes("GET", ai.optString("url"), "https://localhost", token, null);
        check(gi.status == 200 && gi.head.contains("content-type: image/png") && java.util.Arrays.equals(gi.bytes, img) && gi.head.contains("access-control-allow-origin: https://localhost"),
                "FILES image read back, same bytes, CORS", gi.status + " " + gi.head);
        Ans gt = callBytes("GET", ai.optString("thumb_url"), null, token, null);
        check(gt.status == 200 && gt.head.contains("content-type: image/jpeg") && gt.bytes.length > 2 && (gt.bytes[0] & 0xff) == 0xff && (gt.bytes[1] & 0xff) == 0xd8,
                "FILES thumbnail is a JPEG", gt.status + " " + gt.head);
        Ans gp = callBytes("GET", ap.optString("url"), null, token, null);
        check(gp.status == 200 && gp.head.contains("content-type: application/pdf") && java.util.Arrays.equals(gp.bytes, doc), "FILES PDF read back, same bytes", gp.status + " " + gp.head);
        Ans pt = call("GET", ap.optString("url") + "?thumb=1", null, token, null);
        check(pt.status == 400 && "no_thumb".equals(pt.json().optString("code")), "FILES no thumbnail of a PDF", pt.status + " " + pt.body);
        Ans noTok = call("GET", ap.optString("url"), null, null, null);
        check(noTok.status == 403, "FILES no token: 403", noTok.status + " " + noTok.body);
        String id = ap.optString("id");
        Ans other = call("GET", "/local/v1/chats/someotherchat/files/" + id, null, token, null);
        check(other.status == 403, "FILES another chat's path: 403", other.status + " " + other.body);
        Ans tampered = call("GET", filesBase + "l" + id.substring(1, id.lastIndexOf('.')) + "x" + id.substring(id.lastIndexOf('.')), null, token, null);
        check(tampered.status == 404 && "unknown_file".equals(tampered.json().optString("code")), "FILES a changed id: 404", tampered.status + " " + tampered.body);
        Ans trav = call("GET", filesBase + "..%2F..%2Fshared_prefs%2Flocalapi.xml", null, token, null);
        check(trav.status == 404, "FILES a path for an id: 404", trav.status + " " + trav.body);

        // The rig chat's own files: a reply's (the PC's /v1/file) and a user's image (/v1/image); a user's other file has no URL.
        JSONObject reply = null, userImg = null, userDoc = null;
        for (int i = 0; allMs != null && i < allMs.length(); i++) {
            JSONArray xs = allMs.getJSONObject(i).optJSONArray("attachments");
            for (int k = 0; xs != null && k < xs.length(); k++) {
                JSONObject x = xs.getJSONObject(k);
                String role = allMs.getJSONObject(i).optString("role");
                if (role.equals("agent") && x.optString("kind").equals("file")) reply = x;
                if (role.equals("user") && x.optString("kind").equals("image")) userImg = x;
                if (role.equals("user") && x.optString("kind").equals("file")) userDoc = x;
            }
        }
        check(reply != null && userImg != null && userDoc != null && userDoc.isNull("url"), "FILES the rig chat's attachments listed",
                "reply " + reply + " image " + userImg + " doc " + userDoc);
        if (reply != null) {
            Ans gr = callBytes("GET", reply.optString("url"), null, token, null);
            check(gr.status == 200 && gr.bytes.length == reply.optLong("size") && gr.head.contains("content-disposition: attachment"), "FILES a reply's file from the PC",
                    gr.status + " " + gr.head + " " + gr.bytes.length + " of " + reply.optLong("size"));
        }
        if (userImg != null) {
            Ans gu = callBytes("GET", userImg.optString("url"), null, token, null);
            check(gu.status == 200 && gu.head.contains("content-type: image/png") && gu.bytes.length > 100, "FILES a user's image from the PC", gu.status + " " + gu.head);
        }

        // Voice messages: transcribed, the words the message's text, the audio not uploaded.
        int tr0 = LocalApi.transcribed.get(), up1 = LocalApi.uploads.get();
        String[][] kinds = {
                { "note.m4a", "audio/mp4", android.media.MediaFormat.MIMETYPE_AUDIO_AAC, String.valueOf(android.media.MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4), "44100", "1.5" },
                { "note.webm", "audio/webm;codecs=opus", android.media.MediaFormat.MIMETYPE_AUDIO_OPUS, String.valueOf(android.media.MediaMuxer.OutputFormat.MUXER_OUTPUT_WEBM), "48000", "1.0" },
                { "note.ogg", "audio/ogg", android.media.MediaFormat.MIMETYPE_AUDIO_OPUS, String.valueOf(android.media.MediaMuxer.OutputFormat.MUXER_OUTPUT_OGG), "48000", "2.0" },
        };
        for (String[] k : kinds) {
            byte[] audio;
            try {
                audio = tone(k[2], Integer.parseInt(k[3]), Integer.parseInt(k[4]), Double.parseDouble(k[5]), 0.4f);
            } catch (Exception e) {
                Log.i(LocalApi.TAG, "LOCALAPI SKIP voice " + k[1] + ": this phone can't encode it (" + e + ")");
                continue;
            }
            String typed = "Typed first " + k[0];
            Ans v = postRetry(base, token, utf8("{\"text\":\"" + typed + "\",\"attachments\":[" + att(k[0], k[1], audio) + "]}"));
            String tr = v.json().optString("transcript");
            double secs = secondsIn(tr);
            check(v.status == 200 && Math.abs(secs - Double.parseDouble(k[5])) < 0.35, "VOICE " + k[1] + " (" + audio.length + " bytes) transcribed",
                    v.status + " " + v.body);
            JSONObject vm = awaitMessage(base, token, cursor, "user", typed, 30);
            check(vm != null && vm.optString("text").equals(typed + " " + tr) && !vm.has("attachments"), "VOICE " + k[1] + ": the words are the message's text, no audio kept",
                    String.valueOf(vm));
        }
        check(LocalApi.uploads.get() == up1, "VOICE no audio uploaded", (LocalApi.uploads.get() - up1) + " uploads");
        check(LocalApi.transcribed.get() > tr0, "VOICE transcribed by the PC", (LocalApi.transcribed.get() - tr0) + " transcribed");
        byte[] silent = tone(android.media.MediaFormat.MIMETYPE_AUDIO_AAC, android.media.MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4, 44100, 1.0, 0f);
        String marker = "Silent one " + System.currentTimeMillis();
        Ans sv = postRetry(base, token, utf8("{\"text\":\"" + marker + "\",\"attachments\":[" + att("quiet.m4a", "audio/mp4", silent) + "]}"));
        check(sv.status == 502 && "transcribe_failed".equals(sv.json().optString("code")), "VOICE no words heard: 502 transcribe_failed", sv.status + " " + sv.body);
        Ans sa = call("GET", base + "?after=" + cursor + "&wait=2", null, token, null);
        check(findMessage(sa.json().optJSONArray("messages"), "user", marker) == null, "VOICE a failed one sends nothing", sa.body.substring(0, Math.min(600, sa.body.length())));
        Ans wav = postRetry(base, token, utf8("{\"attachments\":[" + att("x.wav", "audio/wav", utf8("RIFF0000WAVEfmt ")) + "]}"));
        check(wav.status == 415, "VOICE a WAV isn't taken: 415", wav.status + " " + wav.body);
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
            Ans big = call("POST", "/local/v1/pair", null, null, null, "Content-Type: application/json", "Content-Length: " + (70 * 1024));
            check(big.status == 413, "body over 64 KB: 413", big.status + " " + big.body);
            Ans bigMsg = call("POST", base, null, null, null, "Content-Type: application/json", "Content-Length: " + (70 * 1024));
            check(bigMsg.status == 403, "a message's large body without a token: 403 before reading it", bigMsg.status + " " + bigMsg.body);

            Ans p = call("POST", "/local/v1/pair", "https://localhost", null, "{\"chat\":\"" + chat + "\",\"app\":\"Planner\"}");
            String pair = p.json().optString("pair");
            check(p.status == 200 && p.json().optString("link").equals(ChatLink.SCHEME + chat + "?approve=" + LocalApi.RIG_CODE), "pair", p.status + " " + p.body);
            String token = null;
            long end = System.currentTimeMillis() + 5 * 60_000;
            while (System.currentTimeMillis() < end) {
                Ans w = call("GET", "/local/v1/pair/" + pair + "?wait=25", "https://localhost", null, null);
                String state = w.json().optString("state");
                if (state.equals("pending")) continue;
                if (state.equals("denied")) { Log.i(LocalApi.TAG, "LOCALAPI pairing denied (RIG_LOCAL_DENY): the rest skipped"); return; }
                check(state.equals("allowed") && w.json().optString("token").length() == 64, "pairing allowed", w.status + " " + w.body);
                Log.i(LocalApi.TAG, "LOCALAPI paired app " + w.json().optJSONObject("app"));
                token = w.json().optString("token");
                // For RIG_LOCAL_BG, in a later process.
                Ui.app.getSharedPreferences("localrig", Context.MODE_PRIVATE).edit().putString("token", token).putString("chat", chat).commit();
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
            files(chat, token, base);
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
