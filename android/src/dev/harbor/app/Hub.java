package dev.harbor.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

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
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** One paired desktop Harbor (the hub) and its HTTP API (android/PROTOCOL.md). Every call
 *  carries the pairing token; none runs on the UI thread.
 *
 *  With the PCs sharing their chats (the mesh), one pairing reaches all of them: the hub tells
 *  the phone the other PCs and a token for each (GET /v1/hubs), kept here as endpoints. Every
 *  call goes to the PC used last; when it doesn't answer, the next one that does takes over.
 *  Chats are then named by their gid, the same on every PC (X-Harbor-Ids: global). */
final class Hub {
    static final int TIMEOUT = 25_000; // whole-request ceiling, events long-poll included
    static final int MAX_REPLY = 16 << 20; // biggest answer read into memory (a long transcript is far below)

    final String id;
    String name, host, token;
    String ip; // a second address from a pairing link before 0.13 (its tailnet IP)
    int port;
    String pid = ""; // the paired PC's id in the mesh ("ts:desk"), once known
    String fp = ""; // the PC's key (fingerprint): only it may answer ("" for a pairing before 0.13, until it upgrades)
    /** The pairing secret (hex) from the codes confirmed on the PC: the second factor. "" for a
     *  pairing from before three factors (the PC asks it to upgrade). Kept encrypted with the rest. */
    String secret = "";
    /** Calls are bound to their TLS connection (Android 12+ exports keying material). */
    boolean binding;
    final List<String> addrs = new ArrayList<>(); // every address the PC has said it has

    /** Another PC of the mesh, reachable with a token of its own. */
    static final class Ep {
        String pid, name, host, ip, token, fp = "";
        int port;
        final List<String> addrs = new ArrayList<>();
        Ep(String pid, String name, String host, String ip, int port, String token) {
            this.pid = pid; this.name = name; this.host = host; this.ip = ip; this.port = port; this.token = token;
        }
        String label() { return name == null || name.isEmpty() ? (host == null || host.isEmpty() ? ip : host) : name; }
    }

    final List<Ep> eps = new ArrayList<>();
    private int seen = -1; // the saved list's generation these endpoints come from
    private static int generation;

    /** Endpoints learned by another screen's copy of this hub since this one was read. */
    private void sync() {
        if (seen == generation || Ui.app == null) return;
        Hub fresh = get(Ui.app, id);
        seen = generation;
        if (fresh == null) return;
        synchronized (eps) {
            eps.clear();
            eps.addAll(fresh.eps);
        }
        if (!fresh.pid.isEmpty()) pid = fresh.pid;
    }

    /** Per hub: the endpoint calls go to now ("" = the paired PC). Shared by every screen. */
    private static final Map<String, String> via = new HashMap<>();
    private static final Map<String, Long> askedHubs = new HashMap<>();
    /** hub/endpoint → when it last failed mid-call: tried last for a while. */
    private static final Map<String, Long> bad = new HashMap<>();
    private static final long BAD_FOR = 30_000;

    /** The PC calls go to failed after connecting (it closed the connection, stopped
     *  answering): the next call tries the others first. */
    void failed() {
        if (eps.isEmpty()) return;
        synchronized (bad) { bad.put(id + "/" + via(), System.currentTimeMillis()); }
    }

    private boolean isBad(String v) {
        synchronized (bad) {
            Long t = bad.get(id + "/" + v);
            return t != null && System.currentTimeMillis() - t < BAD_FOR;
        }
    }

    private void good(String v) {
        synchronized (bad) { bad.remove(id + "/" + v); }
    }

    /** Last /v1/state per hub id, so screens open with something while they refresh. */
    static final Map<String, JSONObject> states = new HashMap<>();

    Hub(String id, String name, String host, int port, String token) {
        this.id = id; this.name = name; this.host = host; this.port = port; this.token = token;
    }

    String label() { return name == null || name.isEmpty() ? host : name; }

    /** Paired with all three factors: every call goes with a session. */
    boolean three() { return secret != null && !secret.isEmpty(); }

    /** The PC calls go to now: "" for the paired one, else its mesh id. */
    String via() {
        synchronized (via) {
            String v = via.get(id);
            if (v == null) v = Ui.app == null ? "" : prefs(Ui.app).getString("via-" + id, "");
            if (!v.isEmpty() && ep(v) == null) v = "";
            via.put(id, v);
            return v;
        }
    }

    /** The name of the PC calls go to now, when it isn't the paired one ("" otherwise). */
    String viaName() {
        Ep e = ep(via());
        return e == null ? "" : e.label();
    }

    Ep ep(String pid) {
        if (pid == null || pid.isEmpty()) return null;
        for (Ep e : eps) if (pid.equals(e.pid)) return e;
        return null;
    }

    private void setVia(String v) {
        synchronized (via) {
            if (v.equals(via.get(id))) return;
            via.put(id, v);
        }
        if (Ui.app != null) prefs(Ui.app).edit().putString("via-" + id, v).apply();
    }

    // ---- pairing ----

    /** harbor://pair?host=&port=&token=&name=&fp=&addrs=a,b  (null if it isn't one). */
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
        String fp = Addr.fp(u.getQueryParameter("fp"));
        if (fp != null) h.fp = fp;
        String a = u.getQueryParameter("addrs");
        if (a != null) for (String x : a.split(",")) if (!x.trim().isEmpty() && !h.addrs.contains(x.trim())) h.addrs.add(x.trim());
        return h;
    }

    // ---- storage ----

    private static SharedPreferences prefs(Context c) { return c.getSharedPreferences("hubs", Context.MODE_PRIVATE); }

    // The list (tokens included) is kept encrypted with a key that never leaves the Android
    // Keystore: "hubs.enc" = base64(IV + AES-GCM ciphertext). Older versions kept it in plain
    // text under "hubs"; the first read moves it over.
    private static final String KEY = "harbor-hubs";
    private static String plain; // decrypted list, so screens don't call the Keystore on every read

    private static SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(KEY)) return (SecretKey) ks.getKey(KEY, null);
        KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        g.init(new KeyGenParameterSpec.Builder(KEY, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).build());
        return g.generateKey();
    }

    private static synchronized String load(Context c) {
        if (plain != null) return plain;
        SharedPreferences p = prefs(c);
        String enc = p.getString("hubs.enc", null), old = p.getString("hubs", null);
        if (enc != null) {
            try {
                byte[] b = Base64.decode(enc, Base64.NO_WRAP);
                Cipher ci = Cipher.getInstance("AES/GCM/NoPadding");
                ci.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, b, 0, 12));
                plain = new String(ci.doFinal(b, 12, b.length - 12), StandardCharsets.UTF_8);
            } catch (Exception e) {
                plain = "[]"; // the key is gone (e.g. a restored phone): pair again
            }
        } else if (old != null) {
            plain = old;
            store(c, old);
        } else {
            plain = "[]";
        }
        return plain;
    }

    private static synchronized void store(Context c, String json) {
        plain = json;
        generation++;
        SharedPreferences.Editor e = prefs(c).edit();
        try {
            Cipher ci = Cipher.getInstance("AES/GCM/NoPadding");
            ci.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = ci.getIV(), ct = ci.doFinal(json.getBytes(StandardCharsets.UTF_8));
            byte[] b = new byte[iv.length + ct.length];
            System.arraycopy(iv, 0, b, 0, iv.length);
            System.arraycopy(ct, 0, b, iv.length, ct.length);
            e.putString("hubs.enc", Base64.encodeToString(b, Base64.NO_WRAP)).remove("hubs");
        } catch (Exception ex) {
            e.putString("hubs", json).remove("hubs.enc"); // no working Keystore: keep the pairings as before
        }
        e.apply();
    }

    static List<Hub> all(Context c) {
        List<Hub> out = new ArrayList<>();
        try {
            JSONArray a = new JSONArray(load(c));
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.getJSONObject(i);
                Hub h = new Hub(o.getString("id"), o.optString("name"), o.getString("host"), o.getInt("port"), o.getString("token"));
                h.ip = o.optString("ip", null);
                h.pid = o.optString("pid", "");
                h.fp = o.optString("fp", "");
                h.secret = o.optString("secret", "");
                h.binding = o.optBoolean("binding");
                strings(o.optJSONArray("addrs"), h.addrs);
                JSONArray e = o.optJSONArray("eps");
                if (e != null) for (int j = 0; j < e.length(); j++) {
                    JSONObject x = e.getJSONObject(j);
                    Ep ep = new Ep(x.getString("pid"), x.optString("name"), x.optString("host"), x.optString("ip"), x.getInt("port"), x.getString("token"));
                    ep.fp = x.optString("fp", "");
                    strings(x.optJSONArray("addrs"), ep.addrs);
                    h.eps.add(ep);
                }
                out.add(h);
            }
        } catch (JSONException ignored) { }
        return out;
    }

    private static void strings(JSONArray a, List<String> into) {
        if (a != null) for (int i = 0; i < a.length(); i++) {
            String x = a.optString(i, "");
            if (!x.isEmpty() && !into.contains(x)) into.add(x);
        }
    }

    static Hub get(Context c, String id) {
        for (Hub h : all(c)) if (h.id.equals(id)) return h;
        return null;
    }

    static void save(Context c, List<Hub> hubs) {
        JSONArray a = new JSONArray();
        try {
            for (Hub h : hubs) {
                JSONArray e = new JSONArray();
                for (Ep x : h.eps)
                    e.put(new JSONObject().put("pid", x.pid).put("name", x.name).put("host", x.host).put("ip", x.ip).put("port", x.port).put("token", x.token)
                            .put("fp", x.fp).put("addrs", new JSONArray(x.addrs)));
                a.put(new JSONObject().put("id", h.id).put("name", h.name).put("host", h.host).put("port", h.port).put("token", h.token)
                        .put("ip", h.ip).put("pid", h.pid).put("fp", h.fp).put("secret", h.secret).put("binding", h.binding)
                        .put("addrs", new JSONArray(h.addrs)).put("eps", e));
            }
        } catch (JSONException ignored) { }
        store(c, a.toString());
    }

    /** Adds h, or replaces the same PC (same key, or same address): pairing again renews its token. */
    static Hub put(Context c, Hub h) {
        List<Hub> hubs = all(c);
        for (int i = 0; i < hubs.size(); i++) {
            Hub o = hubs.get(i);
            if (o.id.equals(h.id) || (!h.fp.isEmpty() && h.fp.equals(o.fp)) || (o.host.equalsIgnoreCase(h.host) && o.port == h.port)) {
                Hub n = new Hub(o.id, h.name, h.host, h.port, h.token);
                n.ip = h.ip;
                n.fp = h.fp;
                n.secret = h.secret;
                n.binding = h.binding;
                n.addrs.addAll(h.addrs);
                n.pid = h.pid.isEmpty() ? o.pid : h.pid;
                n.eps.addAll(h.eps.isEmpty() ? o.eps : h.eps);
                h = n;
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
        endSessions(id);
        List<Hub> hubs = all(c);
        hubs.removeIf(h -> h.id.equals(id));
        save(c, hubs);
        states.remove(id);
        if (id.equals(last(c))) prefs(c).edit().remove("last").apply();
        Chat.forget(c, id, null);
        c.deleteSharedPreferences("newchat-" + id);
    }

    static void setLast(Context c, String id) { prefs(c).edit().putString("last", id).apply(); }
    static String last(Context c) { return prefs(c).getString("last", null); }

    // ---- HTTP ----

    static class ApiError extends IOException {
        final int code;
        /** A call refused for its session (it ended on the PC): a new one may fix it. */
        boolean rekey;
        ApiError(int code, String msg) { super(msg); this.code = code; }
    }

    /** The PC asks this pairing (from before three factors) to upgrade: confirm a code there. */
    static final class NeedsUpgrade extends ApiError {
        NeedsUpgrade(String msg) { super(401, msg); }
    }

    Net.Http open(String method, String path, int readTimeout) throws IOException { return open(method, path, readTimeout, true); }

    /** Per PC: the address that answered last, tried first. */
    private static final Map<String, String> goodAddr = new HashMap<>();

    /** Where a PC may answer: the address that did last, then the ones it says it has (its
     *  network's first), then the pairing link's own (a link from before 0.13 has only those). */
    private List<String> candidates(String v, Ep e) {
        List<String> out = new ArrayList<>();
        String last;
        synchronized (goodAddr) { last = goodAddr.get(id + "/" + v); }
        List<String> all = new ArrayList<>();
        all.add(last);
        all.addAll(e == null ? addrs : e.addrs);
        all.add(e == null ? host : e.host);
        all.add(e == null ? ip : e.ip);
        for (String a : all) if (a != null && !a.isEmpty() && !"null".equals(a) && !out.contains(a)) out.add(a);
        return out;
    }

    /** No address of a PC could be reached because this phone's network has no IPv6. */
    private static final class NoV6 extends IOException {
        NoV6(IOException last) { super(last.getMessage(), last); }
    }

    /** A connection to PC v ("" = the paired one): its addresses in order, each pinned to its
     *  key. No headers yet. */
    private Net.Http connect(String v, String method, String path, int readTimeout, int connect) throws IOException {
        Ep e = ep(v);
        String pin = e == null ? fp : e.fp;
        int p = e == null ? port : e.port;
        IOException last = null;
        boolean noV6 = false;
        for (String addr : candidates(v, e)) {
            try {
                Object[] hp = Addr.hostPort(addr, p);
                Net.Http c = Net.open((String) hp[0], (Integer) hp[1], pin == null || pin.isEmpty() ? null : pin, method, path, readTimeout, connect);
                // A pairing from before 0.13 learned the PC's key (over Tailscale): pinned from now on.
                if ((pin == null || pin.isEmpty()) && c.seen != null) {
                    if (e == null) fp = c.seen; else e.fp = c.seen;
                    persist();
                }
                synchronized (goodAddr) { goodAddr.put(id + "/" + v, addr); }
                return c;
            } catch (Net.Refused x) {
                throw x; // another address of the same PC can't change this
            } catch (Net.WrongKey x) {
                // Another device answers there now (a stale address): nothing was sent to it,
                // the PC's other addresses are still worth a try.
                last = x;
            } catch (IOException x) {
                last = x;
                String m = String.valueOf(x.getMessage());
                if (((String) Addr.hostPort(addr, p)[0]).contains(":") && (m.contains("ENETUNREACH") || m.contains("unreachable"))) noV6 = true;
            }
        }
        if (last == null) last = new IOException("no address");
        if (noV6 && !(last instanceof Net.WrongKey)) throw new NoV6(last);
        throw last;
    }

    /** auth false: no token (GET /app.apk needs none on the PC's network). Only ever through
     *  Net: TLS to the PC's pinned key. The PC used last first; when it can't be reached the
     *  others are tried, and the first that answers is used from then on. Nothing was sent to a
     *  PC that couldn't be reached (or answered with another key), so this is safe for every call.
     *  With three factors each PC needs a session first (handshake below). */
    Net.Http open(String method, String path, int readTimeout, boolean auth) throws IOException {
        sync();
        String cur = via();
        List<String> order = new ArrayList<>();
        order.add(cur);
        if (!cur.isEmpty()) order.add("");
        for (Ep e : eps) if (!e.pid.equals(cur) && !e.pid.equals(pid)) order.add(e.pid);
        // PCs that just failed go last (stable: the preference stays among the rest).
        List<String> ok = new ArrayList<>(), later = new ArrayList<>();
        for (String v : order) (isBad(v) ? later : ok).add(v);
        order = ok;
        order.addAll(later);
        IOException last = null;
        boolean noV6 = false; // an IPv6 address was unreachable from this phone's network
        for (String v : order) {
            int connect = order.size() > 1 || candidates(v, ep(v)).size() > 1 ? 3_000 : 8_000;
            try {
                Sess s = auth && three() ? session(v) : null;
                Net.Http c = connect(v, method, path, readTimeout, connect);
                if (auth) {
                    authorize(c, v, s);
                    c.header("X-Harbor-Ids", "global");
                }
                c.header("Accept", "application/json");
                setVia(v);
                return c;
            } catch (NoV6 x) {
                noV6 = true;
                last = (IOException) x.getCause();
            } catch (IOException x) {
                last = x;
            }
        }
        if (noV6 && !(last instanceof ApiError) && !(last instanceof Net.WrongKey) && !(last instanceof Net.Refused))
            throw new Net.Refused("Can't reach the PC. This phone's network has no IPv6, so away from home your PCs can only be reached on your home Wi-Fi (or a network with IPv6).");
        throw last != null ? last : new IOException("no address");
    }

    /** The headers that say who calls: the session and its MAC (three factors), else the
     *  pairing's token (a pairing from before them, or a PC that doesn't ask for them yet). */
    private void authorize(Net.Http c, String v, Sess s) {
        Ep e = ep(v);
        if (s == null) {
            c.header("Authorization", "Bearer " + (e == null ? token : e.token));
        } else {
            c.header("X-Harbor-Session", s.sid);
            c.signer = (h, len) -> {
                byte[] x = s.bound ? h.exporter() : null;
                if (s.bound && x == null) throw new IOException("This connection can't be bound to the PC's session");
                h.header("X-Harbor-Auth", s.mac(h.method, h.path, len, x));
                h.signed = true;
            };
            c.on401 = () -> drop(v, s);
        }
        c.header("X-Harbor-Device", deviceName());
        c.header("X-Harbor-App", String.valueOf(appCode()));
    }

    // ---- sessions (three factors) ----

    /** One PC's session: its id, the key chain (Sec.Ratchet) and the request counter. In memory
     *  only: a restarted app starts new ones (the unlock may be asked again). */
    static final class Sess {
        final String sid, hubFp, phoneFp;
        final boolean bound;
        private final Sec.Ratchet r;
        private final long t0, epochMs;
        private long ctr;
        private volatile long last;
        volatile boolean dead;

        Sess(String sid, String hubFp, String phoneFp, boolean bound, byte[] root, long epochMs) {
            this.sid = sid; this.hubFp = hubFp; this.phoneFp = phoneFp; this.bound = bound;
            // The PC says how long its epochs are (10 minutes; test rigs use less).
            this.epochMs = epochMs >= 20_000 && epochMs <= 3_600_000 ? epochMs : Sec.EPOCH_MS;
            r = new Sec.Ratchet(root);
            Sec.wipe(root);
            t0 = last = android.os.SystemClock.elapsedRealtime();
        }

        /** Still good: the PC ends a session idle for 30 minutes, and every one after 12 hours. */
        boolean fresh() {
            long now = android.os.SystemClock.elapsedRealtime();
            return !dead && now - last < 25 * 60_000L && now - t0 < 11 * 3600_000L;
        }

        /** The MAC header of one call: the epoch's key (the chain moves on by the clock since
         *  the session started; the PC accepts a key 30 s either side of a change), a counter
         *  never used before, the call and its TLS connection. */
        synchronized String mac(String method, String target, long len, byte[] x) throws IOException {
            long now = android.os.SystemClock.elapsedRealtime();
            long e = (now - t0) / epochMs, n = ++ctr;
            byte[] k = r.key(e);
            if (k == null) throw new IOException("session key gone");
            String m = Sec.hex(Sec.hmac(k, Sec.utf8(Sec.requestMsg(sid, e, n, method, target, len, phoneFp, hubFp, x))));
            Sec.wipe(k);
            last = now;
            return e + "." + n + "." + m;
        }

        void end() { dead = true; r.wipeAll(); }
    }

    private static final Map<String, Sess> sessions = new HashMap<>();
    private static final Map<String, Object> starting = new HashMap<>();

    private void drop(String v, Sess s) {
        synchronized (sessions) { if (sessions.get(id + "/" + v) == s) sessions.remove(id + "/" + v); }
        s.end();
    }

    private static void endSessions(String hubId) {
        synchronized (sessions) {
            for (java.util.Iterator<Map.Entry<String, Sess>> i = sessions.entrySet().iterator(); i.hasNext(); ) {
                Map.Entry<String, Sess> x = i.next();
                if (x.getKey().startsWith(hubId + "/")) { x.getValue().end(); i.remove(); }
            }
        }
    }

    /** PC v's session, started when there's none (one start at a time per PC). */
    private Sess session(String v) throws IOException {
        String k = id + "/" + v;
        Object lock;
        synchronized (starting) {
            lock = starting.get(k);
            if (lock == null) starting.put(k, lock = new Object());
        }
        synchronized (lock) {
            Sess s;
            synchronized (sessions) { s = sessions.get(k); }
            if (s != null && s.fresh()) return s;
            if (s != null) drop(v, s);
            s = handshake(v);
            synchronized (sessions) { sessions.put(k, s); }
            return s;
        }
    }

    /** PC v's secret: the pairing's own for the paired PC, derived for each other one. */
    private byte[] secretFor(Ep e) throws IOException {
        byte[] root = Sec.unhex(secret);
        if (root == null || root.length != 32) throw new IOException("This pairing has no secret: pair the phone again.");
        if (e == null) return root;
        byte[] s = Sec.hubSecret(root, e.fp);
        Sec.wipe(root);
        return s;
    }

    /** A session with PC v: all three factors, android/PROTOCOL.md "Three factors".
     *  hello: a fresh ECDH key and nonce; the PC answers with its own and a challenge.
     *  open: the pairing secret's HMAC and the presence key's signature over the transcript
     *  (both TLS keys, both ECDH keys, the nonce, the challenge, this connection's exporter).
     *  The PC proves the session key back. */
    private Sess handshake(String v) throws IOException {
        Ep e = ep(v);
        String tok = e == null ? token : e.token;
        String why = "Sign in to " + labelOn(v);
        // Asked before connecting, so the PC never waits on a prompt.
        Presence.ready(why);
        byte[] secret = secretFor(e);
        try {
            java.security.KeyPair eph = Sec.ephemeral();
            byte[] epk = Sec.spki(eph.getPublic());
            byte[] nonce = new byte[32];
            new java.security.SecureRandom().nextBytes(nonce);
            Net.Http h = connect(v, "POST", "/v1/session/hello", 15_000, 5_000);
            h.header("Authorization", "Bearer " + tok);
            h.header("X-Harbor-Device", deviceName());
            JSONObject hr = send(h, new JSONObject().put("epk", Sec.hex(epk)).put("nonce", Sec.hex(nonce)));
            byte[] epkH = Sec.unhex(hr.optString("epk")), ch = Sec.unhex(hr.optString("challenge"));
            String hid = hr.optString("hid");
            if (epkH == null || ch == null || hid.isEmpty()) throw new IOException("bad answer from the PC");
            byte[] z = Sec.agree(eph.getPrivate(), epkH);
            Net.Http o = connect(v, "POST", "/v1/session/open", 15_000, 5_000);
            byte[] x = binding ? o.exporter() : null;
            if (binding && x == null) { o.close(); throw new IOException("This connection can't be bound to the PC's session."); }
            String phoneFp = Net.myFp(), hubFp = o.seen;
            if (hubFp == null) { o.close(); throw new IOException("Three factors need the encrypted connection to the PC."); }
            byte[] t2 = Sec.sessionTranscript(hubFp, phoneFp, tok, epk, epkH, nonce, ch, x == null ? new byte[0] : x);
            byte[] proof = Sec.labelled(secret, "harbor-session-v3 proof", t2);
            byte[] sig;
            try {
                sig = Presence.sign(Sec.sessionPresenceMsg(t2), why);
            } catch (IOException ex) {
                o.close();
                throw ex;
            }
            o.header("Authorization", "Bearer " + tok);
            o.header("X-Harbor-Device", deviceName());
            JSONObject or = send(o, new JSONObject().put("hid", hid).put("proof", Sec.hex(proof)).put("sig", Sec.hex(sig)));
            byte[] root = Sec.sessionRoot(t2, z, secret);
            Sec.wipe(z);
            if (!Sec.same(Sec.labelled(root, "harbor-session-v3 hub", t2), Sec.unhex(or.optString("proof")))) {
                Sec.wipe(root);
                throw new IOException("The PC couldn't prove the pairing's keys: not connecting.");
            }
            return new Sess(or.optString("sid"), hubFp, phoneFp, binding, root, or.optLong("epoch_ms", Sec.EPOCH_MS));
        } catch (java.security.GeneralSecurityException | JSONException ex) {
            throw new IOException("Couldn't start a session: " + ex.getMessage(), ex);
        } finally {
            Sec.wipe(secret);
        }
    }

    /** Sends a JSON body on c and reads the JSON answer. */
    private static JSONObject send(Net.Http c, JSONObject body) throws IOException {
        try {
            byte[] b = body.toString().getBytes(StandardCharsets.UTF_8);
            c.header("Content-Type", "application/json");
            try (OutputStream o = c.body(b.length)) { o.write(b); }
            return reply(c);
        } finally {
            c.close();
        }
    }

    /** Pairs with the PC of this link (a pairing code), or upgrades this pairing from before
     *  three factors: the presence key signs, an ECDH agreement gives the secret, and the
     *  6-digit code both screens show (showCode, on this thread) must be confirmed on the PC.
     *  Throws ApiError 404 when the PC doesn't know three factors (Harbor before 0.19). */
    void pair3(java.util.function.Consumer<String> showCode, java.util.function.BooleanSupplier cancelled) throws IOException {
        String why = "Pair with " + label();
        byte[] presence = Presence.publicKey();
        Presence.ready(why);
        try {
            java.security.KeyPair eph = Sec.ephemeral();
            byte[] epk = Sec.spki(eph.getPublic());
            Net.Http c = connect("", "POST", "/v1/pair/start", 20_000, 8_000);
            byte[] x = c.exporter();
            boolean bind = x != null;
            String hubFp = c.seen, phoneFp = Net.myFp();
            if (hubFp == null || phoneFp.isEmpty()) { c.close(); throw new IOException("Pairing needs the encrypted connection to the PC (its key in the link)."); }
            byte[] xb = bind ? x : new byte[0];
            byte[] psig;
            try {
                psig = Presence.sign(Sec.pairPresenceMsg(hubFp, phoneFp, token, epk, presence, bind, xb), why);
            } catch (IOException ex) {
                c.close();
                throw ex;
            }
            c.header("Authorization", "Bearer " + token);
            c.header("X-Harbor-Device", deviceName());
            JSONObject r = send(c, new JSONObject().put("epk", Sec.hex(epk)).put("presence", Sec.hex(presence)).put("binding", bind)
                    .put("psig", Sec.hex(psig)).put("name", deviceName()));
            byte[] epkH = Sec.unhex(r.optString("epk"));
            if (epkH == null) throw new IOException("bad answer from the PC");
            byte[] z = Sec.agree(eph.getPrivate(), epkH);
            byte[] t = Sec.pairTranscript(hubFp, phoneFp, token, epk, epkH, presence, bind, xb);
            Object[] k = Sec.pairKeys(t, z);
            Sec.wipe(z);
            byte[] s = (byte[]) k[0];
            showCode.accept((String) k[1]);
            byte[] proof = Sec.labelled(s, "harbor-pair-v3 phone", t);
            long until = System.currentTimeMillis() + r.optLong("wait_ms", 180_000);
            while (true) {
                if (cancelled.getAsBoolean()) throw new IOException("Cancelled");
                if (System.currentTimeMillis() > until) throw new IOException("Nobody confirmed the code on the PC in time. Try again.");
                Net.Http f = connect("", "POST", "/v1/pair/finish", 30_000, 8_000);
                f.header("Authorization", "Bearer " + token);
                JSONObject fr = send(f, new JSONObject().put("proof", Sec.hex(proof)));
                if (!"paired".equals(fr.optString("status"))) continue;
                if (!Sec.same(Sec.labelled(s, "harbor-pair-v3 hub", t), Sec.unhex(fr.optString("proof"))))
                    throw new IOException("The PC couldn't prove the pairing: not paired.");
                secret = Sec.hex(s);
                binding = bind;
                Sec.wipe(s);
                endSessions(id);
                synchronized (askedHubs) { askedHubs.remove(id); }
                persist();
                return;
            }
        } catch (java.security.GeneralSecurityException | JSONException ex) {
            throw new IOException("Couldn't pair: " + ex.getMessage(), ex);
        }
    }

    /** The PCs this pairing reaches: "" (the paired one), then the mesh's others. */
    List<String> endpoints() {
        sync();
        List<String> out = new ArrayList<>();
        out.add("");
        synchronized (eps) { for (Ep e : eps) out.add(e.pid); }
        return out;
    }

    /** The name of PC v ("" = the paired one). */
    String labelOn(String v) {
        Ep e = ep(v);
        return e == null ? label() : e.label();
    }

    /** A call to PC v itself ("" = the paired one), not to whichever PC calls go to now: what
     *  that PC holds for this phone (Inbox). Its addresses in the usual order, pinned the same. */
    Net.Http openOn(String v, String method, String path, int readTimeout) throws IOException {
        sync();
        Ep e = ep(v);
        if (!v.isEmpty() && e == null) throw new IOException("no such PC");
        Sess s = three() ? session(v) : null;
        Net.Http c;
        try {
            c = connect(v, method, path, readTimeout, 3_000);
        } catch (NoV6 x) {
            throw (IOException) x.getCause();
        }
        authorize(c, v, s);
        c.header("Accept", "application/json");
        return c;
    }

    /** A JSON call to PC v itself (see openOn). */
    JSONObject callOn(String v, String method, String path, JSONObject body) throws IOException {
        try {
            return callOn1(v, method, path, body);
        } catch (ApiError e) {
            // The PC ended the session (it restarted): refused before anything ran, so once more.
            if (!e.rekey) throw e;
            return callOn1(v, method, path, body);
        }
    }

    private JSONObject callOn1(String v, String method, String path, JSONObject body) throws IOException {
        Net.Http c = openOn(v, method, path, TIMEOUT);
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

    /** After a state: the mesh's other PCs and this phone's token on each, when some are new. */
    void learn(JSONObject st) {
        if (st == null) return;
        // The paired PC's addresses as it says them now (it answered with its pinned key).
        if (via().isEmpty() && !fp.isEmpty() && fp.equals(Addr.fp(st.optString("hub_fp")))) {
            List<String> now = new ArrayList<>();
            strings(st.optJSONArray("hub_addrs"), now);
            if (!now.isEmpty() && !now.equals(addrs)) { addrs.clear(); addrs.addAll(now); persist(); }
        }
        if (!st.optBoolean("mesh")) return;
        String here = st.optString("hub_id", "");
        if (via().isEmpty() && pid.isEmpty() && !here.isEmpty()) { pid = here; persist(); }
        JSONArray hs = st.optJSONArray("hubs");
        boolean missing = false;
        if (hs != null) for (int i = 0; i < hs.length(); i++) {
            JSONObject o = hs.optJSONObject(i);
            String p = o == null ? "" : o.optString("id");
            if (o != null && o.optBoolean("online") && !p.equals(pid) && ep(p) == null) missing = true;
        }
        long now = System.currentTimeMillis();
        synchronized (askedHubs) {
            Long t = askedHubs.get(id);
            // New PCs at once (at most every 30 s), the rest every 10 minutes.
            if (t != null && now - t < (missing ? 30_000 : 600_000)) return;
            askedHubs.put(id, now);
        }
        try {
            JSONArray a = get("/v1/hubs").optJSONArray("hubs");
            if (a == null) return;
            // Three factors: each other PC gets its own pairing secret (derived from this one's
            // for its key) through this session; it answers with a token bound to this phone.
            if (three()) {
                JSONObject secrets = new JSONObject();
                byte[] root = Sec.unhex(secret);
                for (int i = 0; i < a.length() && root != null; i++) {
                    JSONObject o = a.getJSONObject(i);
                    String key = Addr.fp(o.optString("fp"));
                    if (o.optBoolean("provision") && key != null && !key.equals(fp) && !o.optString("id").equals(pid)) {
                        byte[] sk = Sec.hubSecret(root, key);
                        secrets.put(key, Sec.hex(sk));
                        Sec.wipe(sk);
                    }
                }
                Sec.wipe(root);
                if (secrets.length() > 0) {
                    JSONArray b = call("POST", "/v1/hubs", new JSONObject().put("secrets", secrets)).optJSONArray("hubs");
                    if (b != null) a = b;
                }
            }
            boolean changed = false;
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.getJSONObject(i);
                String p = o.optString("id"), tok = o.optString("token", "");
                // A PC whose phone access is off would drop the phone: never fail over to it.
                if (!o.optBoolean("phones", true)) { if (eps.removeIf(e -> e.pid.equals(p))) changed = true; continue; }
                // A PC without a key runs Harbor before 0.13: the phone can't reach it safely.
                String key = Addr.fp(o.optString("fp"));
                if (key == null) { if (eps.removeIf(e -> e.pid.equals(p))) changed = true; continue; }
                if (p.isEmpty() || tok.isEmpty() || "null".equals(tok) || p.equals(pid)) continue;
                List<String> where = new ArrayList<>();
                strings(o.optJSONArray("addrs"), where);
                Ep e = ep(p);
                if (e == null) { e = new Ep(p, o.optString("name"), o.optString("host"), o.optString("ip"), o.optInt("port"), tok); eps.add(e); e.fp = key; e.addrs.addAll(where); changed = true; }
                else if (!tok.equals(e.token) || !o.optString("ip").equals(e.ip) || o.optInt("port") != e.port || !o.optString("host").equals(e.host) || !key.equals(e.fp) || !where.equals(e.addrs)) {
                    e.token = tok; e.ip = o.optString("ip"); e.port = o.optInt("port"); e.host = o.optString("host"); e.name = o.optString("name");
                    e.fp = key; e.addrs.clear(); e.addrs.addAll(where); changed = true;
                }
            }
            if (changed) persist();
        } catch (Exception ignored) { }
    }

    /** Saves this hub's endpoints (kept encrypted with the pairing). */
    private void persist() {
        if (Ui.app == null) return;
        synchronized (Hub.class) {
            List<Hub> hubs = all(Ui.app);
            for (int i = 0; i < hubs.size(); i++) if (hubs.get(i).id.equals(id)) hubs.set(i, this);
            save(Ui.app, hubs);
        }
    }

    /** This app's versionCode (the PCs show it, and tell when it's out of date). */
    static long appCode() {
        return Ui.app == null ? 0 : Settings.myCode(Ui.app);
    }

    /** What the PC calls this phone (typing lines, Settings › Phones): the name the user gave
     *  it ("Galaxy A13"), else the model ("SM-A135M"). */
    static String deviceName() {
        String n = null;
        try { n = android.provider.Settings.Global.getString(Ui.app.getContentResolver(), "device_name"); } catch (Exception ignored) { }
        if (n == null || n.trim().isEmpty()) n = android.os.Build.MODEL;
        return n.replaceAll("[\\r\\n]", " ").trim();
    }

    JSONObject get(String path) throws IOException { return call("GET", path, null, TIMEOUT); }

    JSONObject call(String method, String path, JSONObject body) throws IOException { return call(method, path, body, TIMEOUT); }

    JSONObject call(String method, String path, JSONObject body, int readTimeout) throws IOException {
        try {
            return call1(method, path, body, readTimeout);
        } catch (ApiError e) {
            // The PC ended the session (it restarted): refused before anything ran, so a write
            // is safe to send again too, with a new session.
            if (e.rekey) return call1(method, path, body, readTimeout);
            throw e;
        } catch (IOException e) {
            failed();
            // A read can go to the next PC at once; a write may have reached the PC, so not.
            if (!"GET".equals(method) || eps.isEmpty()) throw e;
            return call1(method, path, body, readTimeout);
        }
    }

    private JSONObject call1(String method, String path, JSONObject body, int readTimeout) throws IOException {
        Net.Http c = open(method, path, readTimeout);
        String v = via();
        try {
            if (body != null) {
                byte[] b = body.toString().getBytes(StandardCharsets.UTF_8);
                c.header("Content-Type", "application/json");
                try (OutputStream o = c.body(b.length)) { o.write(b); }
            }
            JSONObject r = reply(c);
            good(v);
            return r;
        } finally {
            c.close();
        }
    }

    /** Streams a file to POST /v1/upload; returns {id, path}. */
    JSONObject upload(String name, String chat, InputStream in, long len) throws IOException {
        String q = "/v1/upload?name=" + URLEncoder.encode(name, "UTF-8") + (chat == null ? "" : "&chat=" + URLEncoder.encode(chat, "UTF-8"));
        Net.Http c = open("POST", q, 120_000);
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
        learn(s);
        return s;
    }

    private static JSONObject reply(Net.Http c) throws IOException {
        int code = c.code();
        if (c.length() > MAX_REPLY) throw new IOException(TOO_BIG);
        String body = read(c.in());
        if (code >= 400) throw error(c, code, body);
        if (body.trim().isEmpty()) return new JSONObject();
        try {
            return new JSONObject(body);
        } catch (JSONException e) {
            throw new IOException("bad reply from the PC");
        }
    }

    private static final String TOO_BIG = "The PC's answer is too big for the phone.";

    /** The error an answer stands for. A 401: the session ended (rekey: start a new one), the
     *  PC asks for the upgrade to three factors, or the pairing is refused. */
    static ApiError error(Net.Http c, int code, String body) {
        JSONObject j = null;
        try { j = new JSONObject(body); } catch (JSONException ignored) { }
        String msg = j == null ? null : j.optString("error", null);
        if (code == 401) {
            if (j != null && j.optBoolean("upgrade")) return new NeedsUpgrade(msg != null ? msg : "This PC asks for three factors: upgrade the pairing.");
            ApiError e = new ApiError(401, c.signed ? "This PC refused the session. If this keeps happening, pair the phone again." : "This PC refused the pairing. Pair it again.");
            e.rekey = c.signed;
            return e;
        }
        return new ApiError(code, msg != null ? msg : "HTTP " + code);
    }

    /** Reads an error answer's body (for Base's long-poll, which reads answers itself). */
    static ApiError error(Net.Http c, int code) {
        String body = "";
        try { if (c.length() >= 0 && c.length() < 65536) body = read(c.in()); } catch (IOException ignored) { }
        return error(c, code, body);
    }

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
        if (e instanceof ApiError || e instanceof Net.Refused || e instanceof Net.WrongKey) return e.getMessage();
        if (e instanceof UnknownHostException) return "Can't find the PC on this network.";
        if (e instanceof ConnectException || e instanceof java.net.NoRouteToHostException)
            return "The PC isn't answering. Is Harbor open there, and this phone on the same network?";
        if (e instanceof javax.net.ssl.SSLException) return "Couldn't set up the encrypted connection to the PC: " + e.getMessage();
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
