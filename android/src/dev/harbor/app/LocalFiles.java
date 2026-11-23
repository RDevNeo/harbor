package dev.harbor.app;

import java.io.BufferedOutputStream;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** The local API's attachments (PROTOCOL.md, "Local API for other apps", Attachments): a message
 *  POST's body read as it arrives (attachments decoded from base64 straight into files, never
 *  whole in memory, every limit checked on the way), the file types it takes (by their first
 *  bytes), their names, the ids of a chat's files (signed, so an id works for its own chat only)
 *  and which kept copy a transcript's file is. Plain Java, no Android classes: the unit tests run it
 *  on the JVM. */
final class LocalFiles {
    private LocalFiles() { }

    /** At most this many files in one message. */
    static final int MAX_FILES = 4;
    /** Their bytes together, decoded. */
    static final long MAX_BYTES = 10L * 1024 * 1024;
    /** A message POST's body: the files in base64 (4/3 of MAX_BYTES), the text and context escaped. */
    static final long MAX_POST_BODY = 15L * 1024 * 1024;
    /** The longest a message POST's body may take to arrive. */
    static final long BODY_TIME = 60_000;

    static final String JPEG = "image/jpeg", PNG = "image/png", WEBP = "image/webp", PDF = "application/pdf";
    /** A voice message's types (what a WebView's MediaRecorder makes): transcribed, not kept. */
    static final String WEBM = "audio/webm", MP4 = "audio/mp4", OGG = "audio/ogg";
    /** A voice message: at most this many bytes and seconds (a little more passes: encoders round). */
    static final long MAX_AUDIO_BYTES = 4L * 1024 * 1024;
    static final int MAX_AUDIO_SECONDS = 120;

    /** One file of a message, decoded into `file`. */
    static final class Att {
        String name = "", mime = "";
        File file;
        long size;
        boolean image() { return mime.startsWith("image/"); }
        boolean audio() { return mime.startsWith("audio/"); }
    }

    /** A message POST's body as read: `text` null when absent (`textBad` when it wasn't a string),
     *  `context` null when absent or null (`contextBad` when not a string), `clientId` "" when absent. */
    static final class Post {
        String text, context, clientId = "";
        boolean textBad, contextBad;
        final List<Att> atts = new ArrayList<>();

        /** The voice message, null when none (at most one: read checks). */
        Att audio() { for (Att a : atts) if (a.audio()) return a; return null; }

        /** The decoded files go (after a refusal or once they're sent). */
        void drop() { for (Att a : atts) if (a.file != null) a.file.delete(); }
    }

    // ---- the body ----

    /** Reads a message POST's JSON body from in (already limited to its Content-Length) and
     *  decodes its attachments into new files in dir. Throws LocalHttp.Bad for anything refused,
     *  after removing what it wrote: 400 bad_request (not a JSON object, wrong types), 400
     *  too_many_attachments, 413 attachments_too_large (decoded bytes over MAX_BYTES, as soon as
     *  they are), 413 text_too_large / context_too_large, 415 bad_attachment (a type it doesn't
     *  take, bytes that aren't what `mime` says, no data, bad base64). */
    static Post read(InputStream in, File dir) throws IOException {
        Post p = new Post();
        try {
            new Parser(new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8), 1 << 16), dir, p).top();
            int voices = 0;
            for (Att a : p.atts) if (a.audio()) voices++;
            if (voices > 1) throw new LocalHttp.Bad(400, "too_many_attachments", "One voice message per message");
            return p;
        } catch (IOException | RuntimeException e) {
            p.drop();
            throw e;
        }
    }

    private static LocalHttp.Bad bad(String why) { return new LocalHttp.Bad(400, "bad_request", why); }

    private static LocalHttp.Bad badAtt(String why) { return new LocalHttp.Bad(415, "bad_attachment", why); }

    static LocalHttp.Bad tooLarge() {
        return new LocalHttp.Bad(413, "attachments_too_large", "Attachments may be " + (MAX_BYTES / (1024 * 1024)) + " MB together");
    }

    private static final class Parser {
        private final Reader r;
        private final File dir;
        private final Post p;
        private int peeked = -2;
        private long total;
        private boolean attsSeen;

        Parser(Reader r, File dir, Post p) { this.r = r; this.dir = dir; this.p = p; }

        private int read() throws IOException {
            if (peeked != -2) { int c = peeked; peeked = -2; return c; }
            return r.read();
        }

        private int peek() throws IOException {
            if (peeked == -2) peeked = r.read();
            return peeked;
        }

        /** The next character that isn't JSON whitespace (-1 at the end). */
        private int next() throws IOException {
            while (true) {
                int c = read();
                if (c != ' ' && c != '\n' && c != '\r' && c != '\t') return c;
            }
        }

        private void expect(char want) throws IOException {
            int c = next();
            if (c != want) throw c < 0 ? bad("The body ended early") : bad("The body isn't JSON (expected '" + want + "')");
        }

        void top() throws IOException {
            if (next() != '{') throw bad("The body isn't a JSON object");
            members(this::member);
            if (next() != -1) throw bad("Something follows the JSON object");
        }

        interface Member { void take(String key) throws IOException; }

        /** An object's members after its '{', to its '}'. */
        private void members(Member m) throws IOException {
            int c = next();
            if (c == '}') return;
            while (true) {
                if (c != '"') throw bad("The body isn't JSON (expected a key)");
                String key = string(256, null);
                expect(':');
                m.take(key);
                c = next();
                if (c == '}') return;
                if (c != ',') throw bad("The body isn't JSON (expected ',' or '}')");
                c = next();
            }
        }

        private void member(String key) throws IOException {
            int c = next();
            switch (key) {
                case "text":
                    if (c == '"') p.text = string(LocalGate.MAX_TEXT, new LocalHttp.Bad(413, "text_too_large", "`text` is over " + (LocalGate.MAX_TEXT / 1024) + " KB"));
                    else { p.textBad = true; skip(c, 0); }
                    return;
                case "context":
                    if (c == '"') p.context = string(LocalGate.MAX_CONTEXT, new LocalHttp.Bad(413, "context_too_large", "`context` is over " + (LocalGate.MAX_CONTEXT / 1024) + " KB"));
                    else if (c == 'n') skip(c, 0);
                    else { p.contextBad = true; skip(c, 0); }
                    return;
                case "client_id":
                    if (c == '"') p.clientId = string(256, bad("`client_id` is too long"));
                    else skip(c, 0);
                    return;
                case "attachments":
                    if (attsSeen) throw bad("`attachments` is there twice");
                    attsSeen = true;
                    if (c == 'n') { skip(c, 0); return; }
                    if (c != '[') throw bad("`attachments` must be a list");
                    attachments();
                    return;
                default:
                    skip(c, 0);
            }
        }

        private void attachments() throws IOException {
            int c = next();
            if (c == ']') return;
            while (true) {
                if (p.atts.size() >= MAX_FILES)
                    throw new LocalHttp.Bad(400, "too_many_attachments", "At most " + MAX_FILES + " attachments in a message");
                if (c != '{') throw bad("Each attachment must be an object {name, mime, data_base64}");
                Att a = new Att();
                p.atts.add(a);
                attachment(a, p.atts.size());
                c = next();
                if (c == ']') return;
                if (c != ',') throw bad("The body isn't JSON (expected ',' or ']')");
                c = next();
            }
        }

        private void attachment(Att a, int n) throws IOException {
            String[] claimed = { null };
            byte[] head = new byte[16];
            int[] headLen = { 0 };
            members(key -> {
                int c = next();
                switch (key) {
                    case "name":
                        if (c != '"') throw bad("Attachment " + n + ": `name` must be a string");
                        a.name = string(1024, bad("Attachment " + n + ": `name` is too long"));
                        return;
                    case "mime":
                        if (c != '"') throw bad("Attachment " + n + ": `mime` must be a string");
                        claimed[0] = string(200, bad("Attachment " + n + ": `mime` is too long"));
                        return;
                    case "data_base64":
                        if (c != '"') throw bad("Attachment " + n + ": `data_base64` must be a string");
                        if (a.file != null) throw bad("Attachment " + n + ": `data_base64` is there twice");
                        a.file = File.createTempFile("att", ".part", dir);
                        try (OutputStream o = new BufferedOutputStream(new FileOutputStream(a.file), 1 << 16)) {
                            B64 d = new B64(o, MAX_BYTES - total, head);
                            data(d, n);
                            d.finish(n);
                            a.size = d.count;
                            headLen[0] = d.headLen;
                        }
                        total += a.size;
                        return;
                    default:
                        skip(c, 0);
                }
            });
            if (a.file == null) throw badAtt("Attachment " + n + " has no `data_base64`");
            if (a.size == 0) throw badAtt("Attachment " + n + " is empty");
            String is = sniff(head, headLen[0]);
            if (is == null) throw badAtt("Attachment " + n + " isn't a JPEG, PNG, WebP or PDF file, or a WebM, MP4 or Ogg recording");
            String said = claimed[0] == null ? "" : mime(claimed[0]);
            if (said.isEmpty() && claimed[0] != null && !claimed[0].trim().isEmpty())
                throw badAtt("Attachment " + n + ": `mime` " + claimed[0].trim() + " isn't taken (JPEG, PNG, WebP, PDF; audio/webm, audio/mp4, audio/ogg)");
            if (!said.isEmpty() && !said.equals(is))
                throw badAtt("Attachment " + n + " says it is " + said + " but its bytes are " + is);
            a.mime = is;
            a.name = cleanName(a.name, is);
            if (a.audio() && a.size > MAX_AUDIO_BYTES)
                throw new LocalHttp.Bad(413, "audio_too_large", "A voice message may be " + (MAX_AUDIO_BYTES / (1024 * 1024)) + " MB (about " + (MAX_AUDIO_SECONDS / 60) + " minutes)");
        }

        /** A string's characters after its opening quote, at most max (else over is thrown). */
        private String string(int max, LocalHttp.Bad over) throws IOException {
            StringBuilder b = new StringBuilder();
            while (true) {
                int c = read();
                if (c < 0) throw bad("The body ended inside a string");
                if (c == '"') return b.toString();
                if (c == '\\') c = escape();
                else if (c < 0x20) throw bad("The body isn't JSON (a control character in a string)");
                if (b.length() >= max) throw over != null ? over : bad("A string is too long");
                b.append((char) c);
            }
        }

        /** A base64 string's characters after its opening quote, fed to d as they come. A data URL's
         *  "data:…;base64," head is skipped. */
        private void data(B64 d, int n) throws IOException {
            StringBuilder start = new StringBuilder();
            int state = 0, skipped = 0; // 0: maybe a data URL's head, 1: in that head (to its ','), 2: the data
            while (true) {
                int c = read();
                if (c < 0) throw bad("The body ended inside attachment " + n + "'s data");
                if (c == '"') break;
                if (c == '\\') c = escape();
                if (state == 2) { d.put((char) c, n); continue; }
                if (state == 1) {
                    if (c == ',') state = 2;
                    else if (++skipped > 256) throw badAtt("Attachment " + n + "'s data URL has no ','");
                    continue;
                }
                start.append((char) c);
                if ("data:".startsWith(start.toString())) {
                    if (start.length() == 5) state = 1;
                    continue;
                }
                state = 2;
                for (int i = 0; i < start.length(); i++) d.put(start.charAt(i), n);
            }
            if (state == 1) throw badAtt("Attachment " + n + "'s data URL has no ','");
            if (state == 0) for (int i = 0; i < start.length(); i++) d.put(start.charAt(i), n);
        }

        private int escape() throws IOException {
            int c = read();
            switch (c) {
                case '"': return '"';
                case '\\': return '\\';
                case '/': return '/';
                case 'b': return '\b';
                case 'f': return '\f';
                case 'n': return '\n';
                case 'r': return '\r';
                case 't': return '\t';
                case 'u': {
                    int v = 0;
                    for (int i = 0; i < 4; i++) {
                        int h = Character.digit(read(), 16);
                        if (h < 0) throw bad("The body isn't JSON (a bad \\u escape)");
                        v = v * 16 + h;
                    }
                    return v;
                }
                default: throw bad("The body isn't JSON (a bad escape)");
            }
        }

        /** Skips a value whose first character is c (read already). */
        private void skip(int c, int depth) throws IOException {
            if (depth > 16) throw bad("The body nests too deep");
            if (c == '"') {
                while (true) {
                    int x = read();
                    if (x < 0) throw bad("The body ended inside a string");
                    if (x == '"') return;
                    if (x == '\\') escape();
                }
            }
            if (c == '{') {
                members(key -> skip(next(), depth + 1));
                return;
            }
            if (c == '[') {
                int x = next();
                if (x == ']') return;
                while (true) {
                    skip(x, depth + 1);
                    x = next();
                    if (x == ']') return;
                    if (x != ',') throw bad("The body isn't JSON (expected ',' or ']')");
                    x = next();
                }
            }
            if (c == '-' || (c >= '0' && c <= '9') || c == 't' || c == 'f' || c == 'n') {
                int len = 1;
                while (true) {
                    int x = peek();
                    if (x < 0 || !(x == '-' || x == '+' || x == '.' || (x >= '0' && x <= '9') || (x >= 'a' && x <= 'z') || x == 'E')) return;
                    read();
                    if (++len > 64) throw bad("The body isn't JSON (a value is too long)");
                }
            }
            throw c < 0 ? bad("The body ended early") : bad("The body isn't JSON");
        }
    }

    /** Base64 (standard or URL-safe alphabet, padding optional, whitespace skipped) into out, at
     *  most max bytes (else attachments_too_large at once); the first bytes kept in head. */
    static final class B64 {
        private final OutputStream out;
        private final long max;
        private final byte[] head;
        int headLen;
        long count;
        private int acc, n, pad;

        B64(OutputStream out, long max, byte[] head) { this.out = out; this.max = max; this.head = head; }

        void put(char c, int which) throws IOException {
            if (c == ' ' || c == '\n' || c == '\r' || c == '\t') return;
            if (c == '=') {
                if (++pad > 2 || n < 2) throw badAtt("Attachment " + which + "'s data isn't base64");
                return;
            }
            if (pad > 0) throw badAtt("Attachment " + which + "'s data isn't base64 (data after the padding)");
            int v = value(c);
            if (v < 0) throw badAtt("Attachment " + which + "'s data isn't base64");
            acc = (acc << 6) | v;
            if (++n == 4) {
                emit(acc >> 16);
                emit(acc >> 8);
                emit(acc);
                acc = 0;
                n = 0;
            }
        }

        void finish(int which) throws IOException {
            if (n == 1) throw badAtt("Attachment " + which + "'s data isn't base64 (cut short)");
            if (n == 2) emit(acc >> 4);
            else if (n == 3) { emit(acc >> 10); emit(acc >> 2); }
            n = 0;
        }

        private void emit(int b) throws IOException {
            if (++count > max) throw tooLarge();
            if (headLen < head.length) head[headLen++] = (byte) b;
            out.write(b & 0xff);
        }

        private static int value(char c) {
            if (c >= 'A' && c <= 'Z') return c - 'A';
            if (c >= 'a' && c <= 'z') return c - 'a' + 26;
            if (c >= '0' && c <= '9') return c - '0' + 52;
            if (c == '+' || c == '-') return 62;
            if (c == '/' || c == '_') return 63;
            return -1;
        }
    }

    // ---- types and names ----

    /** The type a file's first bytes say it is, of the ones taken: null for any other. */
    static String sniff(byte[] b, int n) {
        if (n >= 3 && (b[0] & 0xff) == 0xff && (b[1] & 0xff) == 0xd8 && (b[2] & 0xff) == 0xff) return JPEG;
        if (n >= 8 && (b[0] & 0xff) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G' && b[4] == 0x0d && b[5] == 0x0a && b[6] == 0x1a && b[7] == 0x0a) return PNG;
        if (n >= 12 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F' && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P') return WEBP;
        if (n >= 5 && b[0] == '%' && b[1] == 'P' && b[2] == 'D' && b[3] == 'F' && b[4] == '-') return PDF;
        if (n >= 4 && (b[0] & 0xff) == 0x1a && (b[1] & 0xff) == 0x45 && (b[2] & 0xff) == 0xdf && (b[3] & 0xff) == 0xa3) return WEBM;
        if (n >= 8 && b[4] == 'f' && b[5] == 't' && b[6] == 'y' && b[7] == 'p') return MP4;
        if (n >= 4 && b[0] == 'O' && b[1] == 'g' && b[2] == 'g' && b[3] == 'S') return OGG;
        return null;
    }

    /** A type as a client wrote it, as one taken ("" for any other): lower case, no parameters,
     *  image/jpg as image/jpeg. */
    static String mime(String s) {
        if (s == null) return "";
        String m = s.trim().toLowerCase(Locale.ROOT);
        int semi = m.indexOf(';');
        if (semi >= 0) m = m.substring(0, semi).trim();
        if (m.equals("image/jpg") || m.equals("image/pjpeg")) m = JPEG;
        if (m.equals("audio/x-m4a") || m.equals("audio/m4a")) m = MP4;
        if (m.equals("audio/opus")) m = OGG;
        return m.equals(JPEG) || m.equals(PNG) || m.equals(WEBP) || m.equals(PDF) || m.equals(WEBM) || m.equals(MP4) || m.equals(OGG) ? m : "";
    }

    /** The extensions a type goes by, the usual one first. */
    static String[] extensions(String mime) {
        switch (mime) {
            case JPEG: return new String[] { "jpg", "jpeg" };
            case PNG: return new String[] { "png" };
            case WEBP: return new String[] { "webp" };
            case PDF: return new String[] { "pdf" };
            case WEBM: return new String[] { "webm" };
            case MP4: return new String[] { "m4a", "mp4" };
            case OGG: return new String[] { "ogg", "opus", "oga" };
            default: return new String[0];
        }
    }

    /** A file name as the PC keeps it, for a file of type mime: the last part of a path, no
     *  control characters or \ / : * ? " < > | (each '_', as the PC's safeName), no dots in front,
     *  an extension that fits its type (added when it has none of them: the PC and the agent tell
     *  images by it), at most 120 characters; "photo"/"document" when nothing is left. */
    static String cleanName(String name, String mime) {
        String s = name == null ? "" : name;
        int cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
        if (cut >= 0) s = s.substring(cut + 1);
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c == 0x2028 || c == 0x2029) b.append('_');
            else if (":*?\"<>|".indexOf(c) >= 0) b.append('_');
            else b.append(c);
        }
        s = b.toString().trim();
        while (s.startsWith(".")) s = s.substring(1);
        String[] exts = extensions(mime);
        String base = s, ext = "";
        int dot = s.lastIndexOf('.');
        if (dot > 0) {
            String e = s.substring(dot + 1).toLowerCase(Locale.ROOT);
            for (String x : exts) if (x.equals(e)) { base = s.substring(0, dot); ext = s.substring(dot + 1); }
        }
        if (ext.isEmpty() && exts.length > 0) ext = exts[0];
        base = base.trim();
        if (base.isEmpty()) base = mime.equals(PDF) ? "document" : mime.startsWith("audio/") ? "voice" : "photo";
        int room = 120 - (ext.isEmpty() ? 0 : ext.length() + 1);
        if (base.length() > room) {
            int end = room;
            if (end > 0 && Character.isHighSurrogate(base.charAt(end - 1))) end--;
            base = base.substring(0, end).trim();
        }
        return ext.isEmpty() ? base : base + "." + ext;
    }

    private static final Pattern TOKEN = Pattern.compile("\\[Image #(\\d+)\\]");

    /** A voice message's words after the typed text, as the composer's mic puts them: a space
     *  between when the text doesn't end in one. */
    static String withTranscript(String text, String words) {
        String t = text == null ? "" : text.trim(), w = words == null ? "" : words.trim();
        if (w.isEmpty()) return t;
        if (t.isEmpty()) return w;
        return t + (Character.isWhitespace(t.charAt(t.length() - 1)) ? "" : " ") + w;
    }

    /** A voice message decoded (any rate, any channels) as /v1/transcribe takes it: 16-bit PCM WAV,
     *  mono, 16 kHz (the channels averaged, then linear resampling). At most MAX_AUDIO_SECONDS
     *  and 2 s: past that 413 audio_too_long. */
    static final class Wav16k {
        static final int RATE = 16_000;
        private final java.io.ByteArrayOutputStream pcm = new java.io.ByteArrayOutputStream(1 << 16);
        private final long maxOut = (long) (MAX_AUDIO_SECONDS + 2) * RATE;
        private int channels = 1;
        private double step = 1;   // source frames per output sample
        private double next;       // where the next output sample falls, in source frames
        private long index = -1;   // the last source frame's number
        private float prev;
        long out;

        /** The decoder's format (again when it changes). */
        void format(int rate, int channels) {
            if (rate <= 0 || channels <= 0) throw new IllegalArgumentException("bad audio format");
            this.channels = channels;
            this.step = rate / (double) RATE;
        }

        /** n interleaved samples (-1..1). */
        void push(float[] s, int n) throws LocalHttp.Bad {
            for (int i = 0; i + channels <= n; i += channels) {
                float v = 0;
                for (int c = 0; c < channels; c++) v += s[i + c];
                v /= channels;
                index++;
                if (index == 0) prev = v;
                while (next <= index) {
                    double frac = next - (index - 1);
                    emit(index == 0 ? v : (float) (prev + (v - prev) * Math.max(0, Math.min(1, frac))));
                    next += step;
                }
                prev = v;
            }
        }

        private void emit(float v) throws LocalHttp.Bad {
            if (++out > maxOut) throw new LocalHttp.Bad(413, "audio_too_long", "A voice message may be about " + (MAX_AUDIO_SECONDS / 60) + " minutes long");
            int x = Math.max(-32768, Math.min(32767, Math.round(v * 32767f)));
            pcm.write(x & 0xff);
            pcm.write((x >> 8) & 0xff);
        }

        double seconds() { return out / (double) RATE; }

        byte[] wav() {
            byte[] d = pcm.toByteArray();
            java.io.ByteArrayOutputStream o = new java.io.ByteArrayOutputStream(44 + d.length);
            o.write('R'); o.write('I'); o.write('F'); o.write('F'); le(o, 36 + d.length, 4);
            for (char c : "WAVEfmt ".toCharArray()) o.write(c);
            le(o, 16, 4); le(o, 1, 2); le(o, 1, 2); le(o, RATE, 4); le(o, RATE * 2, 4); le(o, 2, 2); le(o, 16, 2);
            o.write('d'); o.write('a'); o.write('t'); o.write('a'); le(o, d.length, 4);
            o.write(d, 0, d.length);
            return o.toByteArray();
        }

        private static void le(java.io.ByteArrayOutputStream o, int v, int bytes) { for (int i = 0; i < bytes; i++) o.write((v >> (8 * i)) & 0xff); }
    }

    /** The message's text as Harbor's composer would send it with `images` images attached: a
     *  `[Image #k]` token for each image its text doesn't name yet, after the text (one space
     *  between), as the composer places them at the end of a message it isn't focused on. */
    static String withImageTokens(String text, int images) {
        String t = text == null ? "" : text.trim();
        java.util.Set<Integer> named = new java.util.HashSet<>();
        Matcher m = TOKEN.matcher(t);
        while (m.find()) {
            try { named.add(Integer.parseInt(m.group(1))); } catch (NumberFormatException ignored) { }
        }
        StringBuilder b = new StringBuilder(t);
        for (int k = 1; k <= images; k++) {
            if (named.contains(k)) continue;
            if (b.length() > 0 && !Character.isWhitespace(b.charAt(b.length() - 1))) b.append(' ');
            b.append("[Image #").append(k).append(']');
        }
        return b.toString();
    }

    /** A file's type by its name, for a transcript's file ("application/octet-stream" when unknown). */
    static String mimeOf(String name) {
        String n = name == null ? "" : name.toLowerCase(Locale.ROOT);
        int q = n.indexOf('?');
        if (q >= 0) n = n.substring(0, q);
        int dot = n.lastIndexOf('.');
        String e = dot < 0 ? "" : n.substring(dot + 1);
        switch (e) {
            case "jpg": case "jpeg": return JPEG;
            case "png": return PNG;
            case "webp": return WEBP;
            case "gif": return "image/gif";
            case "bmp": return "image/bmp";
            case "svg": return "image/svg+xml";
            case "heic": return "image/heic";
            case "avif": return "image/avif";
            case "pdf": return PDF;
            case "mp4": case "m4v": return "video/mp4";
            case "webm": return "video/webm";
            case "mov": return "video/quicktime";
            case "mkv": return "video/x-matroska";
            case "txt": case "log": case "md": case "csv": return "text/plain";
            case "json": return "application/json";
            case "zip": return "application/zip";
            case "apk": return "application/vnd.android.package-archive";
            default: return "application/octet-stream";
        }
    }

    /** The Content-Type a file is served with: images, video, PDF and plain text as they are; anything
     *  else as bytes (application/octet-stream), so nothing renders as a page. */
    static String servedType(String mime) {
        if (mime.startsWith("image/") && !mime.equals("image/svg+xml")) return mime;
        if (mime.startsWith("video/") || mime.equals(PDF)) return mime;
        if (mime.equals("text/plain")) return "text/plain; charset=utf-8";
        return "application/octet-stream";
    }

    // ---- a transcript's file names ----

    private static final Pattern KEPT = Pattern.compile("^(\\d{10,})-(?:\\d{1,4}-)?(.+)$");

    /** A user message's file as its PC names it (`<ms>-<name>` or `<ms>-<n>-<name>`, the upload's
     *  kept name) as the user named it. */
    static String shownName(String kept) {
        Matcher m = KEPT.matcher(kept == null ? "" : kept);
        return m.matches() ? m.group(2) : kept == null ? "" : kept;
    }

    /** Which of the files kept on this phone for a chat (`have`, their names: the PC's kept names
     *  from the upload's answer) is a transcript's file `kept`: the same name, else the same name
     *  as the user gave it, stamped within 10 minutes (a PC that forwarded the upload to the chat's
     *  own PC keeps it under its own stamp), the nearest. Null when none. */
    static String match(String kept, List<String> have) {
        if (kept == null || kept.isEmpty()) return null;
        if (have.contains(kept)) return kept;
        Matcher m = KEPT.matcher(kept);
        if (!m.matches()) return null;
        long at;
        try { at = Long.parseLong(m.group(1)); } catch (NumberFormatException e) { return null; }
        String best = null;
        long gap = 10 * 60_000L + 1;
        for (String h : have) {
            Matcher x = KEPT.matcher(h);
            if (!x.matches() || !x.group(2).equals(m.group(2))) continue;
            long d;
            try { d = Math.abs(Long.parseLong(x.group(1)) - at); } catch (NumberFormatException e) { continue; }
            if (d < gap) { gap = d; best = h; }
        }
        return best;
    }

    /** A name a kept copy may have on this phone: one path part, no dots in front. */
    static boolean keptName(String s) {
        return s != null && !s.isEmpty() && s.length() <= 160 && !s.startsWith(".") && s.indexOf('/') < 0 && s.indexOf('\\') < 0
                && s.indexOf('\0') < 0 && !s.equals("..");
    }

    /** The last part of a path (either separator). */
    static String baseName(String path) {
        if (path == null) return "";
        int cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
        return cut < 0 ? path : path.substring(cut + 1);
    }

    // ---- file ids ----

    /** Kinds of id: a file kept on this phone (payload: its name), and a PC's image, file or video
     *  (payload: the PC's URL for it, as the transcript gave it). */
    static final char LOCAL = 'l', IMAGE = 'i', FILE = 'f', VIDEO = 'v';

    /** A file's id in chat: kind and payload, signed with key for that chat alone, so an id can't
     *  be made up or used for another chat (and no path in it is ever taken from a client). */
    static String mint(byte[] key, String chat, char kind, String payload) {
        String p = Base64.getUrlEncoder().withoutPadding().encodeToString(payload.getBytes(StandardCharsets.UTF_8));
        return kind + p + "." + sig(key, chat, kind, p);
    }

    /** {kind, payload} of an id this phone made for chat, null for anything else. */
    static String[] open(byte[] key, String chat, String id) {
        if (id == null || id.length() < 3 || id.length() > 4096) return null;
        char kind = id.charAt(0);
        if (kind != LOCAL && kind != IMAGE && kind != FILE && kind != VIDEO) return null;
        int dot = id.lastIndexOf('.');
        if (dot < 1) return null;
        String p = id.substring(1, dot), s = id.substring(dot + 1);
        if (!p.matches("[A-Za-z0-9_-]*")) return null;
        if (!MessageDigest.isEqual(sig(key, chat, kind, p).getBytes(StandardCharsets.US_ASCII), s.getBytes(StandardCharsets.US_ASCII))) return null;
        try {
            return new String[] { String.valueOf(kind), new String(Base64.getUrlDecoder().decode(p), StandardCharsets.UTF_8) };
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static String sig(byte[] key, String chat, char kind, String p) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key, "HmacSHA256"));
            byte[] d = mac.doFinal((chat + "\n" + kind + "\n" + p).getBytes(StandardCharsets.UTF_8));
            return Base64.getUrlEncoder().withoutPadding().encodeToString(java.util.Arrays.copyOf(d, 16));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** A PC's image URL (`/v1/image?path=…&max=…&chat=…`) whole (no `max`) or as a thumbnail
     *  (`max=512`: the PC answers a JPEG). */
    static String imageUrl(String url, boolean thumb) {
        int q = url.indexOf('?');
        if (q < 0) return url + (thumb ? "?max=512" : "");
        StringBuilder b = new StringBuilder(url.substring(0, q + 1));
        boolean first = true;
        for (String kv : url.substring(q + 1).split("&")) {
            if (kv.isEmpty() || kv.equals("max") || kv.startsWith("max=")) continue;
            if (!first) b.append('&');
            b.append(kv);
            first = false;
        }
        if (thumb) b.append(first ? "" : "&").append("max=512");
        String s = b.toString();
        return s.endsWith("?") ? s.substring(0, s.length() - 1) : s;
    }

    /** The `path` query parameter of a PC URL, decoded ("" when none). */
    static String pathOf(String url) {
        int q = url.indexOf('?');
        if (q < 0) return "";
        for (String kv : url.substring(q + 1).split("&")) {
            if (!kv.startsWith("path=")) continue;
            String d = ChatLink.decode(kv.substring(5));
            return d == null ? "" : d;
        }
        return "";
    }
}
