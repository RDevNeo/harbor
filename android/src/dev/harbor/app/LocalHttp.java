package dev.harbor.app;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/** The local API's HTTP/1.1 (LocalApi, PROTOCOL.md "Local API for other apps"): one request per
 *  connection, a Content-Length body or none (read whole, or for a message with attachments as it
 *  arrives: bodyStream), every answer `Connection: close` (JSON, or a file streamed: head). Plain
 *  Java, no Android classes: the unit tests run it on the JVM. */
final class LocalHttp {
    private LocalHttp() { }

    /** A request that broke a limit or the protocol: answered with status, then closed. */
    static final class Bad extends IOException {
        final int status;
        final String code;
        Bad(int status, String code, String message) { super(message); this.status = status; this.code = code; }
    }

    static final class Req {
        String method = "", path = "", query = "";
        /** Header names in lower case; the first of each. */
        final Map<String, String> headers = new LinkedHashMap<>();
        byte[] body = new byte[0];
        /** Content-Length, -1 when none. */
        long length = -1;

        String header(String name) { return headers.get(name.toLowerCase(Locale.ROOT)); }

        /** Query parameter `name`, decoded (null: absent or malformed). */
        String param(String name) {
            if (query.isEmpty()) return null;
            for (String kv : query.split("&")) {
                int eq = kv.indexOf('=');
                String k = eq < 0 ? kv : kv.substring(0, eq);
                if (k.equals(name)) return ChatLink.decode(eq < 0 ? "" : kv.substring(eq + 1));
            }
            return null;
        }

        String bodyText() { return new String(body, StandardCharsets.UTF_8); }
    }

    static final class Res {
        final int status;
        final Map<String, String> headers = new LinkedHashMap<>();
        final String body;
        /** Already written to the connection (a file, streamed): nothing more to write. */
        boolean sent;
        Res(int status, String json) { this.status = status; this.body = json; }
        Res header(String k, String v) { headers.put(k, v); return this; }
    }

    /** An answer that was written already (LocalApi's files). */
    static Res sent(int status) {
        Res r = new Res(status, null);
        r.sent = true;
        return r;
    }

    /** Reads one request: the request line and headers (at most maxHead bytes together), then a
     *  body of Content-Length bytes (at most maxBody: 413 past it, before reading it). */
    static Req read(InputStream in, int maxHead, int maxBody) throws IOException {
        Req r = readHead(in, maxHead);
        readBody(in, r, maxBody);
        return r;
    }

    /** The request line and headers (at most maxHead bytes together), and Content-Length in
     *  `length`; the body is left in in (readBody, bodyStream). */
    static Req readHead(InputStream in, int maxHead) throws IOException {
        Req r = new Req();
        String line = line(in, maxHead);
        if (line == null) throw new Bad(400, "bad_request", "no request");
        String[] p = line.split(" ");
        if (p.length != 3 || !p[2].startsWith("HTTP/1.")) throw new Bad(400, "bad_request", "malformed request line");
        r.method = p[0];
        String target = p[1];
        int q = target.indexOf('?');
        r.path = q < 0 ? target : target.substring(0, q);
        r.query = q < 0 ? "" : target.substring(q + 1);
        int used = line.length();
        while (true) {
            String h = line(in, maxHead - used);
            if (h == null) throw new Bad(400, "bad_request", "headers cut off");
            used += h.length() + 2;
            if (used > maxHead) throw new Bad(431, "headers_too_large", "headers too large");
            if (h.isEmpty()) break;
            int c = h.indexOf(':');
            if (c <= 0) throw new Bad(400, "bad_request", "malformed header");
            String k = h.substring(0, c).trim().toLowerCase(Locale.ROOT);
            if (!r.headers.containsKey(k)) r.headers.put(k, h.substring(c + 1).trim());
        }
        if (r.header("transfer-encoding") != null) throw new Bad(411, "length_required", "send a Content-Length, not chunks");
        String cl = r.header("content-length");
        if (cl != null) {
            try { r.length = Long.parseLong(cl.trim()); } catch (NumberFormatException e) { throw new Bad(400, "bad_request", "bad Content-Length"); }
            if (r.length < 0) throw new Bad(400, "bad_request", "bad Content-Length");
        }
        return r;
    }

    /** The body into r.body: Content-Length bytes, at most maxBody (413 past it, before reading it). */
    static void readBody(InputStream in, Req r, int maxBody) throws IOException {
        if (r.length > 0) {
            long n = r.length;
            if (n > maxBody) throw new Bad(413, "too_large", "the request is over " + (maxBody / 1024) + " KB");
            byte[] b = new byte[(int) n];
            int off = 0;
            while (off < n) {
                int k = in.read(b, off, (int) n - off);
                if (k < 0) throw new Bad(400, "bad_request", "body cut off");
                off += k;
            }
            r.body = b;
        }
    }

    /** The body as a stream, read as it arrives: its Content-Length bytes and no more (then the end);
     *  a read after deadline (ms on clock) throws 408 too_slow, so a body that trickles in can't hold
     *  a thread for long. A body cut off ends early: the reader finds it incomplete. */
    static InputStream bodyStream(InputStream in, Req r, LocalGate.Clock clock, long deadline) {
        long[] left = { Math.max(0, r.length) };
        return new InputStream() {
            private void inTime() throws Bad {
                if (clock.now() > deadline) throw new Bad(408, "too_slow", "the request took too long to arrive");
            }
            @Override public int read() throws IOException {
                if (left[0] <= 0) return -1;
                inTime();
                int c = in.read();
                if (c >= 0) left[0]--;
                return c;
            }
            @Override public int read(byte[] b, int off, int len) throws IOException {
                if (left[0] <= 0) return -1;
                inTime();
                int n = in.read(b, off, (int) Math.min(len, left[0]));
                if (n > 0) left[0] -= n;
                return n;
            }
        };
    }

    /** A streamed answer's head: status, the type, the length (-1: unsaid, the body ends with the
     *  connection) and headers. The body follows on out. */
    static void head(OutputStream out, int status, String type, long length, Map<String, String> headers) throws IOException {
        StringBuilder h = new StringBuilder();
        h.append("HTTP/1.1 ").append(status).append(' ').append(reason(status)).append("\r\n");
        h.append("Content-Type: ").append(type).append("\r\n");
        if (length >= 0) h.append("Content-Length: ").append(length).append("\r\n");
        h.append("X-Content-Type-Options: nosniff\r\n");
        for (Map.Entry<String, String> e : headers.entrySet()) h.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
        h.append("Connection: close\r\n\r\n");
        out.write(h.toString().getBytes(StandardCharsets.ISO_8859_1));
    }

    /** One CRLF- (or LF-) ended line in ISO-8859-1, null at the end of the stream before any byte. */
    private static String line(InputStream in, int max) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream(128);
        while (true) {
            int c = in.read();
            if (c < 0) return b.size() == 0 ? null : b.toString("ISO-8859-1");
            if (c == '\n') break;
            if (b.size() >= max) throw new Bad(431, "headers_too_large", "headers too large");
            b.write(c);
        }
        String s = b.toString("ISO-8859-1");
        return s.endsWith("\r") ? s.substring(0, s.length() - 1) : s;
    }

    static void write(OutputStream out, Res r) throws IOException {
        byte[] body = r.body == null ? new byte[0] : r.body.getBytes(StandardCharsets.UTF_8);
        StringBuilder h = new StringBuilder();
        h.append("HTTP/1.1 ").append(r.status).append(' ').append(reason(r.status)).append("\r\n");
        if (r.body != null) h.append("Content-Type: application/json; charset=utf-8\r\n");
        h.append("Content-Length: ").append(body.length).append("\r\n");
        h.append("Cache-Control: no-store\r\n");
        h.append("X-Content-Type-Options: nosniff\r\n");
        for (Map.Entry<String, String> e : r.headers.entrySet()) h.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
        h.append("Connection: close\r\n\r\n");
        out.write(h.toString().getBytes(StandardCharsets.ISO_8859_1));
        out.write(body);
        out.flush();
    }

    static String reason(int s) {
        switch (s) {
            case 200: return "OK";
            case 204: return "No Content";
            case 400: return "Bad Request";
            case 401: return "Unauthorized";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 405: return "Method Not Allowed";
            case 408: return "Request Timeout";
            case 409: return "Conflict";
            case 411: return "Length Required";
            case 413: return "Payload Too Large";
            case 415: return "Unsupported Media Type";
            case 429: return "Too Many Requests";
            case 431: return "Request Header Fields Too Large";
            case 500: return "Internal Server Error";
            case 502: return "Bad Gateway";
            case 503: return "Service Unavailable";
            default: return "Status";
        }
    }

    /** s as a JSON string literal. */
    static String q(String s) {
        if (s == null) return "null";
        StringBuilder b = new StringBuilder(s.length() + 2).append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (c < 0x20 || c == 0x2028 || c == 0x2029) b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
            }
        }
        return b.append('"').toString();
    }

    /** The error answer: {"error": message, "code": code}. */
    static Res error(int status, String code, String message) {
        return new Res(status, "{\"error\":" + q(message) + ",\"code\":" + q(code) + "}");
    }
}
