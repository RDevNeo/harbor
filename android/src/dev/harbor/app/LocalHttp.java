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
 *  connection, a Content-Length body or none, every answer `Connection: close`. Plain Java, no
 *  Android classes: the unit tests run it on the JVM. */
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
        Res(int status, String json) { this.status = status; this.body = json; }
        Res header(String k, String v) { headers.put(k, v); return this; }
    }

    /** Reads one request: the request line and headers (at most maxHead bytes together), then a
     *  body of Content-Length bytes (at most maxBody: 413 past it, before reading it). */
    static Req read(InputStream in, int maxHead, int maxBody) throws IOException {
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
            long n;
            try { n = Long.parseLong(cl); } catch (NumberFormatException e) { throw new Bad(400, "bad_request", "bad Content-Length"); }
            if (n < 0) throw new Bad(400, "bad_request", "bad Content-Length");
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
        return r;
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
