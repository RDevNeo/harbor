package dev.harbor.app;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.SequenceInputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.Base64;
import java.util.List;

/** The local API's attachments (LocalFiles, and LocalGate/LocalHttp for them): the message body
 *  read as it arrives, base64, the limits, the types by their first bytes, names, image tokens,
 *  voice messages' WAV, the files' signed ids, the files route's token and rates. JVM only. */
public final class LocalFilesTest {
    static int fails;

    static void eq(Object got, Object want, String what) {
        if (got == null ? want != null : !got.equals(want)) { System.out.println("FAIL " + what + ": " + got + " != " + want); fails++; }
    }

    static File dir;

    static final byte[] PNG = { (byte) 0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 'I', 'H', 'D', 'R', 1, 2, 3 };
    static final byte[] JPG = { (byte) 0xff, (byte) 0xd8, (byte) 0xff, (byte) 0xe0, 0, 16, 'J', 'F', 'I', 'F' };
    static final byte[] WEBP = { 'R', 'I', 'F', 'F', 9, 0, 0, 0, 'W', 'E', 'B', 'P', 'V', 'P', '8', ' ' };
    static final byte[] PDF = "%PDF-1.4\n1 0 obj << >> endobj\n%%EOF\n".getBytes(StandardCharsets.US_ASCII);
    static final byte[] WEBM = { 0x1a, 0x45, (byte) 0xdf, (byte) 0xa3, (byte) 0x9f, 0x42, (byte) 0x86, (byte) 0x81, 1 };
    static final byte[] M4A = { 0, 0, 0, 0x18, 'f', 't', 'y', 'p', 'M', '4', 'A', ' ' };
    static final byte[] OGG = { 'O', 'g', 'g', 'S', 0, 2, 0, 0 };

    static String b64(byte[] b) { return Base64.getEncoder().encodeToString(b); }

    static String att(String name, String mime, byte[] data) {
        return "{\"name\":" + LocalHttp.q(name) + (mime == null ? "" : ",\"mime\":" + LocalHttp.q(mime)) + ",\"data_base64\":\"" + b64(data) + "\"}";
    }

    static LocalFiles.Post read(String body) throws IOException {
        return LocalFiles.read(new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)), dir);
    }

    /** "status code" of a refused body, "ok" when read. */
    static String refused(String body) { return refused(new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8))); }

    static String refused(InputStream in) {
        try {
            LocalFiles.Post p = LocalFiles.read(in, dir);
            p.drop();
            return "ok";
        } catch (LocalHttp.Bad b) {
            return b.status + " " + b.code;
        } catch (Exception e) {
            return "threw " + e;
        }
    }

    static int left() { String[] l = dir.list(); return l == null ? 0 : l.length; }

    static byte[] bytes(File f) throws IOException { return Files.readAllBytes(f.toPath()); }

    /** n characters of 'A' as a stream (no n-sized string in memory). */
    static InputStream as(long n) {
        return new InputStream() {
            long left = n;
            @Override public int read() { return left-- > 0 ? 'A' : -1; }
            @Override public int read(byte[] b, int off, int len) {
                if (left <= 0) return -1;
                int k = (int) Math.min(len, left);
                Arrays.fill(b, off, off + k, (byte) 'A');
                left -= k;
                return k;
            }
        };
    }

    static InputStream join(String a, InputStream mid, String b) {
        return new SequenceInputStream(new SequenceInputStream(new ByteArrayInputStream(a.getBytes(StandardCharsets.UTF_8)), mid),
                new ByteArrayInputStream(b.getBytes(StandardCharsets.UTF_8)));
    }

    public static void main(String[] args) throws Exception {
        dir = Files.createTempDirectory("lf").toFile();
        dir.deleteOnExit();

        // ---- a message with files ----
        LocalFiles.Post p = read("{\"text\":\"Here they are\",\"client_id\":\"abc12345\",\"attachments\":[" + att("shift photo.png", "image/png", PNG)
                + "," + att("../../etc/plan", "application/pdf", PDF) + "],\"extra\":{\"x\":[1,true,null,\"s\"]}}");
        eq(p.text, "Here they are", "text");
        eq(p.clientId, "abc12345", "client_id");
        eq(p.atts.size(), 2, "two attachments");
        eq(p.atts.get(0).mime + " " + p.atts.get(0).name + " " + p.atts.get(0).size, "image/png shift photo.png " + PNG.length, "the image");
        eq(Arrays.equals(bytes(p.atts.get(0).file), PNG), true, "the image's bytes decoded");
        eq(p.atts.get(1).mime + " " + p.atts.get(1).name, "application/pdf plan.pdf", "the PDF: path dropped, extension added");
        eq(Arrays.equals(bytes(p.atts.get(1).file), PDF), true, "the PDF's bytes");
        eq(p.atts.get(0).image() && !p.atts.get(1).image() && p.audio() == null, true, "kinds");
        p.drop();
        eq(left(), 0, "drop removes the files");

        // Attachments first, then text; image/jpg; a data URL; URL-safe base64; escapes and line breaks; no mime.
        String jpgUrlSafe = Base64.getUrlEncoder().withoutPadding().encodeToString(JPG);
        p = read("{\"attachments\":[{\"data_base64\":\"data:image/jpeg;base64," + b64(JPG) + "\",\"mime\":\"image/jpg\",\"name\":\"IMG_1.JPG\"},"
                + "{\"name\":\"w\",\"data_base64\":\"" + jpgUrlSafe.substring(0, 4) + "\\n" + jpgUrlSafe.substring(4) + "\"},"
                + "{\"name\":\"s.webp\",\"mime\":\"image/webp; q=1\",\"data_base64\":\"" + b64(WEBP).replace("/", "\\/") + "\"}],\"text\":\"\"}");
        eq(p.atts.size() + " " + p.text, "3 ", "files before the text, empty text");
        eq(p.atts.get(0).name + " " + p.atts.get(0).mime, "IMG_1.JPG image/jpeg", "data URL, image/jpg, extension kept");
        eq(Arrays.equals(bytes(p.atts.get(0).file), JPG), true, "data URL decoded");
        eq(p.atts.get(1).name + " " + p.atts.get(1).mime, "w.jpg image/jpeg", "no mime: its bytes say; URL-safe base64 with a line break");
        eq(Arrays.equals(bytes(p.atts.get(1).file), JPG), true, "URL-safe decoded");
        eq(p.atts.get(2).mime, "image/webp", "WebP, mime parameters dropped, \\/ escape");
        p.drop();

        // ---- refused ----
        eq(refused("{\"text\":\"x\",\"attachments\":[" + att("a.png", "image/png", PDF) + "]}"), "415 bad_attachment", "mime and bytes disagree");
        eq(refused("{\"attachments\":[" + att("a.gif", "image/gif", PNG) + "]}"), "415 bad_attachment", "a type not taken");
        eq(refused("{\"attachments\":[" + att("a.bin", null, "MZ\u0090\u0000 not a picture".getBytes(StandardCharsets.ISO_8859_1)) + "]}"), "415 bad_attachment", "bytes of no type taken");
        eq(refused("{\"attachments\":[{\"name\":\"a.png\",\"mime\":\"image/png\"}]}"), "415 bad_attachment", "no data");
        eq(refused("{\"attachments\":[{\"name\":\"a.png\",\"data_base64\":\"\"}]}"), "415 bad_attachment", "empty data");
        eq(refused("{\"attachments\":[{\"name\":\"a.png\",\"data_base64\":\"iVBO*w0K\"}]}"), "415 bad_attachment", "not base64");
        eq(refused("{\"attachments\":[{\"name\":\"a.png\",\"data_base64\":\"iVBORw0KG\"}]}"), "415 bad_attachment", "base64 cut short");
        eq(refused("{\"attachments\":[{\"name\":\"a.png\",\"data_base64\":\"iVBO=w0K\"}]}"), "415 bad_attachment", "data after the padding");
        eq(refused("{\"attachments\":[{\"name\":\"a\",\"data_base64\":\"data:image/png;base64\"}]}"), "415 bad_attachment", "a data URL with no comma");
        String five = "{\"attachments\":[" + String.join(",", Arrays.asList(att("1.png", "image/png", PNG), att("2.png", "image/png", PNG),
                att("3.png", "image/png", PNG), att("4.png", "image/png", PNG), att("5.png", "image/png", PNG))) + "]}";
        eq(refused(five), "400 too_many_attachments", "five files");
        eq(left(), 0, "the refused message's files are gone");
        eq(refused("{\"attachments\":{}}"), "400 bad_request", "attachments not a list");
        eq(refused("{\"attachments\":[],\"attachments\":[]}"), "400 bad_request", "attachments twice");
        eq(refused("{\"attachments\":[\"x\"]}"), "400 bad_request", "an attachment not an object");
        eq(refused("{\"attachments\":[{\"name\":3,\"data_base64\":\"\"}]}"), "400 bad_request", "name not a string");
        eq(refused("[1]"), "400 bad_request", "not an object");
        eq(refused("{\"text\":\"a\"} x"), "400 bad_request", "something after the object");
        eq(refused("{\"text\":\"a\""), "400 bad_request", "cut off");
        eq(refused(""), "400 bad_request", "no body");
        eq(refused("{\"text\":\"" + "y".repeat(LocalGate.MAX_TEXT + 1) + "\"}"), "413 text_too_large", "text over 16 KB, while reading");
        eq(refused("{\"text\":\"a\",\"context\":\"" + "z".repeat(LocalGate.MAX_CONTEXT + 1) + "\"}"), "413 context_too_large", "context over 4 KB");
        eq(refused("{\"x\":" + "[".repeat(40) + "]".repeat(40) + "}"), "400 bad_request", "too deep");
        LocalFiles.Post types = read("{\"text\":3,\"context\":[1]}");
        eq(types.textBad && types.contextBad, true, "text and context of other types: flagged");
        eq(read("{\"text\":\"a\",\"context\":null}").context, null, "context null");
        // Over 10 MB decoded, refused while it arrives, before the end; the file goes.
        long chars = (LocalFiles.MAX_BYTES / 3) * 4 + 8;
        eq(refused(join("{\"attachments\":[{\"name\":\"big.png\",\"data_base64\":\"" + b64(PNG).substring(0, 24), as(chars), "\"}]}")), "413 attachments_too_large", "over 10 MB");
        eq(left(), 0, "the big file is gone");
        // Two that are 10 MB together: refused at the second.
        long half = (LocalFiles.MAX_BYTES / 2 / 3) * 4 + 8;
        InputStream second = join("\"},{\"name\":\"b.png\",\"data_base64\":\"" + b64(PNG).substring(0, 24), as(half), "\"}]}");
        eq(refused(new SequenceInputStream(join("{\"attachments\":[{\"name\":\"a.png\",\"data_base64\":\"" + b64(PNG).substring(0, 24), as(half), ""), second)),
                "413 attachments_too_large", "over 10 MB together");
        eq(left(), 0, "both files gone");

        // ---- voice messages ----
        eq(LocalFiles.sniff(WEBM, WEBM.length) + " " + LocalFiles.sniff(M4A, M4A.length) + " " + LocalFiles.sniff(OGG, OGG.length), "audio/webm audio/mp4 audio/ogg", "audio by its first bytes");
        p = read("{\"attachments\":[" + att("rec", "audio/webm;codecs=opus", WEBM) + "]}");
        eq(p.audio() != null && p.audio().name.equals("rec.webm") && p.audio().audio() && !p.audio().image(), true, "a WebM voice message");
        p.drop();
        p = read("{\"attachments\":[" + att("v.m4a", "audio/x-m4a", M4A) + "]}");
        eq(p.audio().mime + " " + p.audio().name, "audio/mp4 v.m4a", "audio/x-m4a is audio/mp4");
        p.drop();
        p = read("{\"attachments\":[" + att("", "audio/ogg", OGG) + "]}");
        eq(p.audio().name, "voice.ogg", "a nameless recording");
        p.drop();
        eq(refused("{\"attachments\":[" + att("a.webm", "audio/ogg", WEBM) + "]}"), "415 bad_attachment", "an audio type its bytes deny");
        eq(refused("{\"attachments\":[" + att("a.webm", "audio/webm", WEBM) + "," + att("b.ogg", "audio/ogg", OGG) + "]}"), "400 too_many_attachments", "two voice messages");
        eq(refused("{\"attachments\":[" + att("a.wav", "audio/wav", "RIFF0000WAVE".getBytes(StandardCharsets.US_ASCII)) + "]}"), "415 bad_attachment", "WAV isn't taken");
        long audioChars = (LocalFiles.MAX_AUDIO_BYTES / 3) * 4 + 400;
        eq(refused(join("{\"attachments\":[{\"name\":\"long.webm\",\"mime\":\"audio/webm\",\"data_base64\":\"" + b64(WEBM).substring(0, 8), as(audioChars), "\"}]}")),
                "413 audio_too_large", "a voice message over 4 MB");
        eq(left(), 0, "its file is gone");
        eq(LocalFiles.withTranscript("Please check", "the second shift"), "Please check the second shift", "transcript after the text");
        eq(LocalFiles.withTranscript("", " hello "), "hello", "transcript alone");
        eq(LocalFiles.withTranscript("typed", ""), "typed", "no words");

        // The WAV /v1/transcribe takes: 1 s of 48 kHz stereo is 16000 samples of mono 16 kHz.
        LocalFiles.Wav16k w = new LocalFiles.Wav16k();
        w.format(48_000, 2);
        float[] s = new float[48_000 * 2];
        for (int i = 0; i < 48_000; i++) { float v = (float) Math.sin(2 * Math.PI * 440 * i / 48_000.0) * 0.5f; s[2 * i] = v; s[2 * i + 1] = v; }
        for (int at = 0; at < s.length; at += 8190) w.push(Arrays.copyOfRange(s, at, Math.min(s.length, at + 8190)), Math.min(8190, s.length - at));
        eq(w.out, 16_000L, "resampled to 16 kHz");
        byte[] wav = w.wav();
        eq(new String(wav, 0, 4, StandardCharsets.US_ASCII) + new String(wav, 8, 8, StandardCharsets.US_ASCII), "RIFFWAVEfmt ", "a WAV");
        eq(wav.length, 44 + 32_000, "16-bit mono samples");
        eq((wav[22] & 0xff) + " " + ((wav[24] & 0xff) | (wav[25] & 0xff) << 8) + " " + (wav[34] & 0xff), "1 16000 16", "mono, 16 kHz, 16 bits");
        short peak = 0;
        for (int i = 44; i < wav.length; i += 2) peak = (short) Math.max(peak, (short) ((wav[i] & 0xff) | (wav[i + 1] << 8)));
        eq(peak > 15_000 && peak < 17_000, true, "the level kept: " + peak);
        LocalFiles.Wav16k w8 = new LocalFiles.Wav16k();
        w8.format(8_000, 1);
        w8.push(new float[8_000], 8_000);
        eq(w8.out >= 15_998 && w8.out <= 16_000, true, "8 kHz upsampled: " + w8.out);
        LocalFiles.Wav16k tooLong = new LocalFiles.Wav16k();
        tooLong.format(16_000, 1);
        String longCode = "ok";
        try {
            float[] sec = new float[16_000];
            for (int i = 0; i < LocalFiles.MAX_AUDIO_SECONDS + 5; i++) tooLong.push(sec, sec.length);
        } catch (LocalHttp.Bad b) { longCode = b.status + " " + b.code; }
        eq(longCode, "413 audio_too_long", "over about 2 minutes");

        // ---- names, tokens, types ----
        eq(LocalFiles.cleanName("../../etc/passwd", LocalFiles.PDF), "passwd.pdf", "a path's last part");
        eq(LocalFiles.cleanName("C:\\Users\\x\\scan.PDF", LocalFiles.PDF), "scan.PDF", "a Windows path; extension kept");
        eq(LocalFiles.cleanName("x.png", LocalFiles.JPEG), "x.png.jpg", "an extension of another type: the right one added");
        eq(LocalFiles.cleanName("", LocalFiles.JPEG), "photo.jpg", "no name");
        eq(LocalFiles.cleanName(".hidden.pdf", LocalFiles.PDF), "hidden.pdf", "no dot in front");
        eq(LocalFiles.cleanName("a\u0000b\nc:d*?\"<>|.webp", LocalFiles.WEBP), "a_b_c_d______.webp", "control characters and reserved ones");
        eq(LocalFiles.cleanName(".pdf", LocalFiles.PDF), "pdf.pdf", "a dot name");
        String longName = LocalFiles.cleanName("n".repeat(300) + ".jpeg", LocalFiles.JPEG);
        eq(longName.length() <= 120 && longName.endsWith(".jpeg"), true, "at most 120 characters, extension kept: " + longName.length());
        eq(LocalFiles.withImageTokens("hi", 2), "hi [Image #1] [Image #2]", "tokens after the text, as the composer");
        eq(LocalFiles.withImageTokens("", 1), "[Image #1]", "a photo alone");
        eq(LocalFiles.withImageTokens("see [Image #1] here", 2), "see [Image #1] here [Image #2]", "a token the text has isn't added again");
        eq(LocalFiles.withImageTokens("x ", 0), "x", "no images");
        eq(LocalFiles.mime("IMAGE/PNG ; x=1") + LocalFiles.mime("text/html") + LocalFiles.mime(null), "image/png", "mime normalized, others empty");
        eq(LocalFiles.servedType("text/html") + " " + LocalFiles.servedType("image/svg+xml") + " " + LocalFiles.servedType("application/pdf") + " "
                + LocalFiles.servedType(LocalFiles.mimeOf("x.md")), "application/octet-stream application/octet-stream application/pdf text/plain; charset=utf-8", "served types");
        eq(LocalFiles.mimeOf("a.APK") + " " + LocalFiles.mimeOf("/x/y.jpeg?max=5") + " " + LocalFiles.mimeOf("noext"), "application/vnd.android.package-archive image/jpeg application/octet-stream", "types by name");

        // ---- the transcript's names and the copies kept here ----
        eq(LocalFiles.shownName("1732350000000-plan.pdf") + " " + LocalFiles.shownName("1732350000000-2-plan.pdf") + " " + LocalFiles.shownName("README.md"),
                "plan.pdf plan.pdf README.md", "names as the user gave them");
        List<String> kept = Arrays.asList("1732350000000-plan.pdf", "1732350100000-photo.jpg", "1732350000000-photo.jpg");
        eq(LocalFiles.match("1732350000000-plan.pdf", kept), "1732350000000-plan.pdf", "the same name");
        eq(LocalFiles.match("1732350030000-plan.pdf", kept), "1732350000000-plan.pdf", "another PC's stamp, 30 s apart");
        eq(LocalFiles.match("1732350090000-photo.jpg", kept), "1732350100000-photo.jpg", "the nearest stamp");
        eq(LocalFiles.match("1732351000000-plan.pdf", kept), null, "over 10 minutes apart");
        eq(LocalFiles.match("1732350000000-other.pdf", kept), null, "another name");
        eq(LocalFiles.match("plan.pdf", kept), null, "not a kept name");
        eq(LocalFiles.keptName("..") || LocalFiles.keptName("a/b") || LocalFiles.keptName(".x") || LocalFiles.keptName("a\\b") || LocalFiles.keptName(""), false, "unsafe kept names");
        eq(LocalFiles.keptName("1732350000000-plan.pdf"), true, "a kept name");
        eq(LocalFiles.baseName("/home/u/.local/share/harbor/uploads/7/1732350000000-plan.pdf"), "1732350000000-plan.pdf", "base name");

        // ---- file ids ----
        byte[] key = new byte[32];
        for (int i = 0; i < 32; i++) key[i] = (byte) i;
        String chat = "0b6f3c1e-7a9d-4d2e-9b1a-2f4c5d6e7f80";
        String url = "/v1/image?path=%2Fhome%2Fu%2Fpics%2Fa.png&max=512&chat=" + chat;
        String id = LocalFiles.mint(key, chat, LocalFiles.IMAGE, url);
        eq(id.matches("[A-Za-z0-9_.-]+"), true, "an id fits a path segment: " + id);
        String[] o = LocalFiles.open(key, chat, id);
        eq(o == null ? null : o[0] + " " + o[1], "i " + url, "the id opens for its chat");
        eq(LocalFiles.open(key, "another-chat", id), null, "not for another chat");
        byte[] key2 = key.clone();
        key2[0] = 9;
        eq(LocalFiles.open(key2, chat, id), null, "not with another key (another phone)");
        String forged = "l" + Base64.getUrlEncoder().withoutPadding().encodeToString("../../shared_prefs/localapi.xml".getBytes(StandardCharsets.UTF_8)) + id.substring(id.lastIndexOf('.'));
        eq(LocalFiles.open(key, chat, forged), null, "a made-up payload with a real signature");
        eq(LocalFiles.open(key, chat, "f" + id.substring(1)), null, "another kind");
        eq(LocalFiles.open(key, chat, id.substring(0, id.length() - 1) + (id.endsWith("A") ? "B" : "A")), null, "a changed signature");
        eq(LocalFiles.open(key, chat, "x") == null && LocalFiles.open(key, chat, "..") == null && LocalFiles.open(key, chat, null) == null, true, "garbage");
        eq(LocalFiles.imageUrl(url, false), "/v1/image?path=%2Fhome%2Fu%2Fpics%2Fa.png&chat=" + chat, "the whole image: no max");
        eq(LocalFiles.imageUrl(url, true), "/v1/image?path=%2Fhome%2Fu%2Fpics%2Fa.png&chat=" + chat + "&max=512", "the thumbnail: max=512");
        eq(LocalFiles.pathOf(url), "/home/u/pics/a.png", "the path in a PC URL");

        // ---- the route, its token, its rates ----
        LocalGate gate = new LocalGate(() -> LocalApiTest.now);
        LocalGate.Pair pr = gate.pairStart(chat, "Planner", null);
        gate.approve(pr.code, "com.example.planner", "Planner", "Weekly plan");
        String token = gate.pairTake(pr.id).token;
        LocalGate.Grant g = gate.byToken(token);
        String files = "/local/v1/chats/" + chat + "/files/" + id;
        LocalGate.Route rt = route(gate, "GET", files + "?thumb=1", "Authorization: Bearer " + token);
        eq(rt.answer == null ? rt.kind + " " + rt.file : "answered " + rt.answer.status, "FILE_GET " + id, "the files route with the token");
        eq(rt.grant == g, true, "its grant");
        eq(status(route(gate, "GET", files)), 403, "no token: 403");
        eq(status(route(gate, "GET", "/local/v1/chats/another/files/" + id, "Authorization: Bearer " + token)), 403, "another chat's files: 403");
        eq(status(route(gate, "POST", files, "Authorization: Bearer " + token, "Content-Type: application/json")), 405, "files are GET");
        eq(status(route(gate, "GET", "/local/v1/chats/" + chat + "/files/a/b", "Authorization: Bearer " + token)), 404, "no deeper path");
        eq(LocalGate.maxBody(LocalGate.Kind.MESSAGES_POST) + " " + LocalGate.maxBody(LocalGate.Kind.PAIR_START), LocalFiles.MAX_POST_BODY + " " + LocalGate.MAX_BODY, "15 MB for a message only");
        eq(LocalGate.checkMessage("", null, 1), null, "empty text with a file passes");
        eq(LocalGate.checkMessage("  ", null, 0) != null, true, "empty text alone doesn't");
        eq(gate.bodyStart(g), null, "one large body");
        eq(status(gate.bodyStart(g)), 429, "a second for the same app: 429");
        gate.bodyDone(g);
        int ok = 0;
        for (int i = 0; i < 6; i++) if (gate.takeUpload(g) == null) ok++;
        eq(ok, 4, "4 messages with files at once");
        LocalApiTest.now += 15_000;
        eq(gate.takeUpload(g), null, "then one every 15 s");
        for (int i = 0; i < LocalGate.MAX_STREAMS; i++) gate.fileStart(g);
        eq(status(gate.fileStart(g)), 429, "4 files read at once");
        gate.fileDone(g);
        eq(gate.fileStart(g), null, "then another");
        LocalGate.Sent a1 = gate.sent(g, "client-1"), a2 = gate.sent(g, "client-1"), b1 = gate.sent(g, "client-2");
        eq(a1 == a2 && a1 != b1, true, "a repeat finds the first send's record");

        // ---- the body as it arrives: its length, and a deadline ----
        LocalHttp.Req r = LocalHttp.readHead(new ByteArrayInputStream("POST / HTTP/1.1\r\nContent-Length: 3\r\n\r\n".getBytes(StandardCharsets.UTF_8)), LocalGate.MAX_HEAD);
        eq(r.length, 3L, "Content-Length read, body left");
        long[] clock = { 0 };
        InputStream body = LocalHttp.bodyStream(new ByteArrayInputStream("abcdef".getBytes(StandardCharsets.UTF_8)), r, () -> clock[0], 100);
        byte[] got = new byte[10];
        int n = body.read(got, 0, 10);
        eq(n + " " + body.read(), "3 -1", "no more than Content-Length");
        InputStream slow = LocalHttp.bodyStream(new ByteArrayInputStream("abc".getBytes(StandardCharsets.UTF_8)), r, () -> clock[0], 100);
        clock[0] = 101;
        String late = "ok";
        try { slow.read(); } catch (LocalHttp.Bad b) { late = b.status + " " + b.code; }
        eq(late, "408 too_slow", "a body that takes too long");

        String[] rest = dir.list();
        eq(rest == null ? 0 : rest.length, 0, "no file left behind");
        if (fails > 0) { System.out.println(fails + " local files checks failed"); System.exit(1); }
        System.out.println("LocalFilesTest ok");
    }

    static LocalGate.Route route(LocalGate gate, String method, String path, String... headers) {
        StringBuilder b = new StringBuilder(method + " " + path + " HTTP/1.1\r\nHost: 127.0.0.1:47998\r\n");
        for (String h : headers) b.append(h).append("\r\n");
        try {
            return gate.route(LocalHttp.read(new ByteArrayInputStream(b.append("\r\n").toString().getBytes(StandardCharsets.UTF_8)), LocalGate.MAX_HEAD, LocalGate.MAX_BODY));
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
    }

    static int status(LocalGate.Route r) { return r.answer == null ? 0 : r.answer.status; }

    static int status(LocalHttp.Res r) { return r == null ? 0 : r.status; }
}
