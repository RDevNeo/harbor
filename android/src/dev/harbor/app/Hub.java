package dev.harbor.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.SocketTimeoutException;
import java.net.URLEncoder;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** One paired desktop Harbor (the hub) and its HTTP API (android/PROTOCOL.md). Every call
 *  carries the pairing token; none runs on the UI thread. */
final class Hub {
    static final int TIMEOUT = 25_000; // whole-request ceiling, events long-poll included
    static final int MAX_REPLY = 16 << 20; // biggest answer read into memory (a long transcript is far below)

    final String id;
    String name, host, token;
    String ip; // the tailnet IP from the pairing link, tried when the name doesn't resolve
    int port;

    /** Last /v1/state per hub id, so screens open with something while they refresh. */
    static final Map<String, JSONObject> states = new HashMap<>();

    Hub(String id, String name, String host, int port, String token) {
        this.id = id; this.name = name; this.host = host; this.port = port; this.token = token;
    }

    String label() { return name == null || name.isEmpty() ? host : name; }

    // ---- pairing ----

    /** harbor://pair?host=&port=&token=&name=  (null if it isn't one). */
    static Hub parse(String link) {
        if (link == null) return null;
        Uri u = Uri.parse(link.trim());
        if (!"harbor".equals(u.getScheme()) || !"pair".equals(u.getHost())) return null;
        String host = u.getQueryParameter("host"), token = u.getQueryParameter("token");
        int port;
        try { port = Integer.parseInt(u.getQueryParameter("port")); } catch (Exception e) { return null; }
        if (host == null || host.isEmpty() || token == null || token.isEmpty()) return null;
        String name = u.getQueryParameter("name");
        Hub h = new Hub(UUID.randomUUID().toString(), name == null ? host : name, host, port, token);
        h.ip = u.getQueryParameter("ip");
        return h;
    }

    // ---- storage ----

    private static SharedPreferences prefs(Context c) { return c.getSharedPreferences("hubs", Context.MODE_PRIVATE); }

    static List<Hub> all(Context c) {
        List<Hub> out = new ArrayList<>();
        try {
            JSONArray a = new JSONArray(prefs(c).getString("hubs", "[]"));
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.getJSONObject(i);
                out.add(new Hub(o.getString("id"), o.optString("name"), o.getString("host"), o.getInt("port"), o.getString("token")));
            }
        } catch (JSONException ignored) { }
        return out;
    }

    static Hub get(Context c, String id) {
        for (Hub h : all(c)) if (h.id.equals(id)) return h;
        return null;
    }

    static void save(Context c, List<Hub> hubs) {
        JSONArray a = new JSONArray();
        try {
            for (Hub h : hubs)
                a.put(new JSONObject().put("id", h.id).put("name", h.name).put("host", h.host).put("port", h.port).put("token", h.token));
        } catch (JSONException ignored) { }
        prefs(c).edit().putString("hubs", a.toString()).apply();
    }

    /** Adds h, or replaces the hub at the same address (pairing again renews its token). */
    static Hub put(Context c, Hub h) {
        List<Hub> hubs = all(c);
        for (int i = 0; i < hubs.size(); i++) {
            Hub o = hubs.get(i);
            if (o.id.equals(h.id) || (o.host.equalsIgnoreCase(h.host) && o.port == h.port)) {
                h = new Hub(o.id, h.name, h.host, h.port, h.token);
                hubs.set(i, h);
                save(c, hubs);
                return h;
            }
        }
        hubs.add(h);
        save(c, hubs);
        return h;
    }

    static void remove(Context c, String id) {
        List<Hub> hubs = all(c);
        hubs.removeIf(h -> h.id.equals(id));
        save(c, hubs);
        states.remove(id);
        if (id.equals(last(c))) prefs(c).edit().remove("last").apply();
    }

    static void setLast(Context c, String id) { prefs(c).edit().putString("last", id).apply(); }
    static String last(Context c) { return prefs(c).getString("last", null); }

    // ---- HTTP ----

    static final class ApiError extends IOException {
        final int code;
        ApiError(int code, String msg) { super(msg); this.code = code; }
    }

    Tailnet.Http open(String method, String path, int readTimeout) throws IOException { return open(method, path, readTimeout, true); }

    /** auth false: no token (GET /app.apk needs none). Only ever through Tailscale (Tailnet). */
    Tailnet.Http open(String method, String path, int readTimeout, boolean auth) throws IOException {
        Tailnet.Http c = new Tailnet.Http(host, port, method, path, readTimeout);
        if (auth) {
            c.header("Authorization", "Bearer " + token);
            c.header("X-Harbor-Device", android.os.Build.MODEL);
        }
        c.header("Accept", "application/json");
        return c;
    }

    JSONObject get(String path) throws IOException { return call("GET", path, null, TIMEOUT); }

    JSONObject call(String method, String path, JSONObject body) throws IOException { return call(method, path, body, TIMEOUT); }

    JSONObject call(String method, String path, JSONObject body, int readTimeout) throws IOException {
        Tailnet.Http c = open(method, path, readTimeout);
        try {
            if (body != null) {
                byte[] b = body.toString().getBytes(StandardCharsets.UTF_8);
                c.header("Content-Type", "application/json");
                try (OutputStream o = c.body(b.length)) { o.write(b); }
            }
            return reply(c);
        } finally {
            c.close();
        }
    }

    /** Streams a file to POST /v1/upload; returns {id, path}. */
    JSONObject upload(String name, String chat, InputStream in, long len) throws IOException {
        String q = "/v1/upload?name=" + URLEncoder.encode(name, "UTF-8") + (chat == null ? "" : "&chat=" + URLEncoder.encode(chat, "UTF-8"));
        Tailnet.Http c = open("POST", q, 120_000);
        try {
            c.header("Content-Type", "application/octet-stream");
            try (OutputStream o = c.body(len)) {
                byte[] buf = new byte[1 << 16];
                long left = len;
                for (int n; left > 0 && (n = in.read(buf, 0, (int) Math.min(buf.length, left))) > 0; left -= n) o.write(buf, 0, n);
                if (left > 0) throw new IOException("the file ended early");
            }
            return reply(c);
        } finally {
            c.close();
        }
    }

    JSONObject state() throws IOException {
        JSONObject s = get("/v1/state");
        states.put(id, s);
        return s;
    }

    private static JSONObject reply(Tailnet.Http c) throws IOException {
        int code = c.code();
        if (c.length() > MAX_REPLY) throw new IOException(TOO_BIG);
        String body = read(c.in());
        if (code >= 400) {
            String msg = null;
            try { msg = new JSONObject(body).optString("error", null); } catch (JSONException ignored) { }
            if (code == 401) msg = "This PC refused the pairing token. Pair it again.";
            throw new ApiError(code, msg != null ? msg : "HTTP " + code);
        }
        if (body.trim().isEmpty()) return new JSONObject();
        try {
            return new JSONObject(body);
        } catch (JSONException e) {
            throw new IOException("bad reply from the PC");
        }
    }

    private static final String TOO_BIG = "The PC's answer is too big for the phone.";

    static String read(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[1 << 14];
        try (InputStream i = in) {
            for (int n; (n = i.read(buf)) > 0; ) {
                if (b.size() + n > MAX_REPLY) throw new IOException(TOO_BIG);
                b.write(buf, 0, n);
            }
        }
        return b.toString("UTF-8");
    }

    /** A short human message for any failure. */
    static String why(Throwable e) {
        if (e instanceof ApiError || e instanceof Tailnet.Refused) return e.getMessage();
        if (e instanceof UnknownHostException) return "Can't find the PC. Is Tailscale on?";
        if (e instanceof ConnectException) return "The PC isn't answering. Is Harbor open there?";
        if (e instanceof SocketTimeoutException) return "The PC took too long to answer.";
        if (e instanceof FileNotFoundException) return "Not found";
        String m = e.getMessage();
        // The PC closed the connection mid-request (Harbor quit, phone access off, network change).
        if (e instanceof java.net.SocketException || e instanceof java.io.EOFException
                || e instanceof java.net.ProtocolException || (m != null && m.contains("unexpected end of stream")))
            return "Lost the connection to the PC. Retrying…";
        return m == null || m.isEmpty() ? e.getClass().getSimpleName() : m;
    }

    // ---- small JSON helpers shared by the screens ----

    static JSONObject chat(JSONObject state, String id) {
        JSONArray a = state == null ? null : state.optJSONArray("chats");
        if (a != null) for (int i = 0; i < a.length(); i++) {
            JSONObject c = a.optJSONObject(i);
            if (c != null && id.equals(c.optString("id"))) return c;
        }
        return null;
    }

    /** Ids are numbers on the wire (projects, chats); the app keeps them as strings. */
    static Object num(String id) {
        try { return Long.parseLong(id); } catch (NumberFormatException e) { return id; }
    }

    /** queued may be a count or a flag. */
    static int queued(JSONObject chat) {
        Object v = chat.opt("queued");
        if (v instanceof Number) return ((Number) v).intValue();
        if (v instanceof Boolean) return (Boolean) v ? 1 : 0;
        return 0;
    }

    /** An option list entry that is either "id" or {id, label}. */
    static String optId(Object o) { return o instanceof JSONObject ? ((JSONObject) o).optString("id") : String.valueOf(o); }
    static String optLabel(Object o) {
        if (o instanceof JSONObject) {
            JSONObject j = (JSONObject) o;
            String l = j.optString("label", "");
            return l.isEmpty() ? j.optString("id") : l;
        }
        return String.valueOf(o);
    }

    /** Label of the entry with this id in an option list, else the id itself. */
    static String labelOf(JSONArray list, String id) {
        if (list != null) for (int i = 0; i < list.length(); i++) {
            Object o = list.opt(i);
            if (optId(o).equals(id)) return optLabel(o);
        }
        return id;
    }
}
