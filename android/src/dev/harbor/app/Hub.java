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

/** One workspace's PCs (from the account's directory, Account) and their HTTP API
 *  (android/PROTOCOL.md). Every call carries the account's Harbor token; none runs on the UI
 *  thread.
 *
 *  The PCs of a workspace share their chats (the mesh), so any of them answers: the first is
 *  this entry's own (host, fp, addrs), the others are its endpoints. Every call goes to the PC
 *  used last; when it doesn't answer, the next one that does takes over. Chats are named by
 *  their gid, the same on every PC (X-Harbor-Ids: global). */
final class Hub {
    static final int TIMEOUT = 25_000; // whole-request ceiling, events long-poll included
    static final int MAX_REPLY = 16 << 20; // biggest answer read into memory (a long transcript is far below)

    final String id;
    String name, host, token;
    String ip; // a second address from a pairing link before 0.13 (its tailnet IP)
    int port;
    String pid = ""; // the first PC's id in the mesh ("ts:desk", "fp:…")
    String pcName = ""; // the first PC's name (name is the workspace's)
    String fp = ""; // the first PC's key (fingerprint): only it may answer
    final List<String> addrs = new ArrayList<>(); // every address the PC has said it has

    /** Another PC of the workspace (its token field is unused since 0.85: the account's works everywhere). */
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
        answered(id);
    }

    // ---- when a PC last answered, and why it doesn't ----

    /** Per hub id: when one of its PCs last answered (kept across restarts, written at most
     *  once a minute). */
    private static final Map<String, Long> answeredAt = new HashMap<>();

    private static void answered(String id) {
        long now = System.currentTimeMillis();
        Long was;
        synchronized (answeredAt) { was = answeredAt.put(id, now); }
        if ((was == null || now - was > 60_000) && Ui.app != null) prefs(Ui.app).edit().putLong("seen-" + id, now).apply();
    }

    /** When this hub last answered (ms), 0: never seen. */
    long lastAnswer() {
        synchronized (answeredAt) {
            Long t = answeredAt.get(id);
            if (t != null) return t;
        }
        return Ui.app == null ? 0 : prefs(Ui.app).getLong("seen-" + id, 0);
    }

    /** Why nothing answered: "harbor" (the PC refused the connection: it's up, Harbor isn't
     *  running there), "pc" (no answer at all: off, asleep, another network), null: something
     *  else (an error from Harbor itself, a pairing problem). */
    static String down(Throwable e) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            if (t instanceof ApiError || t instanceof Net.Refused || t instanceof Net.WrongKey) return null;
            String m = String.valueOf(t.getMessage());
            if (t instanceof ConnectException && (m.contains("ECONNREFUSED") || m.toLowerCase(java.util.Locale.ROOT).contains("refused"))) return "harbor";
            if (t instanceof ConnectException || t instanceof java.net.NoRouteToHostException || t instanceof UnknownHostException
                    || (t instanceof SocketTimeoutException && m.contains("connect"))) return "pc";
        }
        return null;
    }

    /** What to tell the user when this hub doesn't answer: Harbor not running on the PC, or the
     *  PC out of reach, with when it last answered; else why(e). */
    String whyDown(Throwable e) {
        String d = down(e);
        if (d == null) return why(e);
        long t = lastAnswer();
        String seen = t > 0 ? " Last answered " + (Ui.ago(t).equals("now") ? "just now." : Ui.ago(t) + " ago.") : "";
        String pc = labelOn(via());
        if ("harbor".equals(d)) return "Harbor isn't running on " + pc + ". Start it there (it can keep running in the background)." + seen;
        return pc + " is offline or out of reach." + seen;
    }

    /** Why the PC calls went to before stopped answering, once another PC answered instead
     *  ("Harbor isn't running on desk"): said with the move. Null: not known. */
    volatile String movedWhy;

    private String downNote(String v, Throwable e) {
        String n = labelOn(v);
        String d = down(e);
        return "harbor".equals(d) ? "Harbor isn't running on " + n : "pc".equals(d) ? n + " is offline" : null;
    }

    /** A short title for the offline state ("Harbor isn't running on desk" / "desk is offline"). */
    String downTitle(Throwable e) {
        String d = down(e), pc = labelOn(via());
        if ("harbor".equals(d)) return "Harbor isn't running on " + pc;
        if ("pc".equals(d)) return pc + " is offline";
        return "Can't reach " + pc;
    }

    /** Last /v1/state per hub id, so screens open with something while they refresh. */
    static final Map<String, JSONObject> states = new HashMap<>();

    Hub(String id, String name, String host, int port, String token) {
        this.id = id; this.name = name; this.host = host; this.port = port; this.token = token;
    }

    String label() { return name == null || name.isEmpty() ? host : name; }

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

    // ---- storage ----

    private static SharedPreferences prefs(Context c) { return c.getSharedPreferences("hubs", Context.MODE_PRIVATE); }

    // The list is kept encrypted with a key that never leaves the Android Keystore:
    // "hubs.enc" = base64(IV + AES-GCM ciphertext). Older versions kept it in plain text under
    // "hubs"; the first read moves it over. The account (Account) is sealed with the same key.
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

    /** base64(IV + AES-GCM ciphertext) of text under the Keystore key (null: no Keystore). */
    static String seal(String text) {
        try {
            Cipher ci = Cipher.getInstance("AES/GCM/NoPadding");
            ci.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = ci.getIV(), ct = ci.doFinal(text.getBytes(StandardCharsets.UTF_8));
            byte[] b = new byte[iv.length + ct.length];
            System.arraycopy(iv, 0, b, 0, iv.length);
            System.arraycopy(ct, 0, b, iv.length, ct.length);
            return Base64.encodeToString(b, Base64.NO_WRAP);
        } catch (Exception e) {
            return null;
        }
    }

    /** What seal made (null: the key is gone, e.g. a restored phone). */
    static String unseal(String sealed) {
        try {
            byte[] b = Base64.decode(sealed, Base64.NO_WRAP);
            Cipher ci = Cipher.getInstance("AES/GCM/NoPadding");
            ci.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, b, 0, 12));
            return new String(ci.doFinal(b, 12, b.length - 12), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
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
                plain = "[]"; // the key is gone (e.g. a restored phone): the directory fills it again
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
                h.pcName = o.optString("pc_name", "");
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
                        .put("ip", h.ip).put("pid", h.pid).put("pc_name", h.pcName).put("fp", h.fp).put("addrs", new JSONArray(h.addrs)).put("eps", e));
            }
        } catch (JSONException ignored) { }
        store(c, a.toString());
    }

    /** Saves h in place of the entry with its id. */
    static void put(Context c, Hub h) {
        List<Hub> hubs = all(c);
        for (int i = 0; i < hubs.size(); i++) if (hubs.get(i).id.equals(h.id)) hubs.set(i, h);
        save(c, hubs);
    }

    static void remove(Context c, String id) {
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
        /** Refused for the sign-in (missing, run out, or not this phone's): sign in again. */
        boolean signin;
        ApiError(int code, String msg) { super(msg); this.code = code; }
    }

    Net.Http open(String method, String path, int readTimeout) throws IOException { return open(method, path, readTimeout, true); }

    /** Per PC: the address that answered last, tried first. */
    private static final Map<String, String> goodAddr = new HashMap<>();

    /** Where a PC may answer: the address that did last, then the ones it says it has (its
     *  network's first, then the directory's). */
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
                // Only ever pinned: a PC without a key in the directory isn't reached.
                if (pin == null || pin.isEmpty()) throw new IOException("This PC has no key in your workspace's directory.");
                Net.Http c = Net.open((String) hp[0], (Integer) hp[1], pin, method, path, readTimeout, connect);
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
     *  PC that couldn't be reached (or answered with another key), so this is safe for every call. */
    Net.Http open(String method, String path, int readTimeout, boolean auth) throws IOException {
        sync();
        String cur = via();
        List<String> order = new ArrayList<>();
        // Talking through another PC: once a minute the paired PC (whose chats these are) is
        // tried first again, so the phone goes back to it as soon as it answers; a relay may
        // run an older Harbor and miss things.
        if (!cur.isEmpty() && backHome()) order.add("");
        order.add(cur);
        if (!cur.isEmpty() && !order.contains("")) order.add("");
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
                Net.Http c = connect(v, method, path, readTimeout, connect);
                if (auth) {
                    authorize(c);
                    c.header("X-Harbor-Ids", "global");
                }
                c.header("Accept", "application/json");
                if (v.equals(cur)) movedWhy = null;
                setVia(v);
                return c;
            } catch (NoV6 x) {
                noV6 = true;
                last = (IOException) x.getCause();
            } catch (IOException x) {
                last = x;
                if (v.equals(cur)) movedWhy = downNote(v, x);
            }
        }
        if (noV6 && !(last instanceof ApiError) && !(last instanceof Net.WrongKey) && !(last instanceof Net.Refused))
            throw new Net.Refused("Can't reach the PC. This phone's network has no IPv6, so away from home your PCs can only be reached on your home Wi-Fi (or a network with IPv6).");
        throw last != null ? last : new IOException("no address");
    }

    private static final Map<String, Long> homeTried = new HashMap<>();
    private static final long HOME_EVERY = 60_000;

    /** True at most once a minute per hub: time to try its own PC first again. */
    private boolean backHome() {
        long now = System.currentTimeMillis();
        synchronized (homeTried) {
            Long t = homeTried.get(id);
            if (t != null && now - t < HOME_EVERY) return false;
            homeTried.put(id, now);
            return true;
        }
    }

    /** The headers that say who calls: the account's Harbor token (every PC of the workspace
     *  checks it), the phone's name and its app's version. */
    private void authorize(Net.Http c) {
        c.header("Authorization", "Bearer " + (Ui.app == null ? "" : Account.token(Ui.app)));
        c.header("X-Harbor-Device", deviceName());
        c.header("X-Harbor-App", String.valueOf(appCode()));
        c.header("X-Harbor-Platform", platform());
    }

    private static String platform;

    /** What this phone is (Engine.platform), worked out once per process. */
    static String platform() {
        if (platform == null) platform = Engine.platform(Ui.app);
        return platform.replaceAll("[\\r\\n]", " ");
    }

    /** One background ping (Alive): the PC calls go to first, then the others, until one takes
     *  it; the mesh tells the rest. */
    void alive() throws IOException { alive(0); }

    /** A ping that also takes PC's notifications (Notes), waiting up to waitMs for one
     *  (Listen's instant mode, the short burst after leaving the app); 0: answer at once. */
    void alive(int waitMs) throws IOException {
        sync();
        List<String> order = new ArrayList<>();
        order.add(via());
        for (String v : endpoints()) if (!order.contains(v)) order.add(v);
        IOException last = null;
        for (String v : order) {
            try {
                Net.Http c = connect(v, "POST", "/v1/alive", 15_000 + waitMs, 5_000);
                authorize(c);
                JSONObject r = send(c, new JSONObject().put("since", Ui.app == null ? 0 : Notes.since(Ui.app, this, v)).put("wait_ms", waitMs));
                if (Ui.app != null) Notes.take(Ui.app, this, v, r);
                return;
            } catch (IOException x) {
                last = x;
                if (x instanceof ApiError && ((ApiError) x).signin) break;
            } catch (JSONException x) {
                last = new IOException(x);
            }
        }
        if (last != null) throw last;
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

    /** The PCs this entry reaches: "" (the first), then the workspace's others. */
    List<String> endpoints() {
        sync();
        List<String> out = new ArrayList<>();
        out.add("");
        synchronized (eps) { for (Ep e : eps) out.add(e.pid); }
        return out;
    }

    /** The name of PC v ("" = the first one). */
    String labelOn(String v) {
        Ep e = ep(v);
        return e != null ? e.label() : pcName == null || pcName.isEmpty() ? label() : pcName;
    }

    /** A call to PC v itself ("" = the paired one), not to whichever PC calls go to now: what
     *  that PC holds for this phone (Inbox). Its addresses in the usual order, pinned the same. */
    Net.Http openOn(String v, String method, String path, int readTimeout) throws IOException {
        sync();
        Ep e = ep(v);
        if (!v.isEmpty() && e == null) throw new IOException("no such PC");
        Net.Http c;
        try {
            c = connect(v, method, path, readTimeout, 3_000);
        } catch (NoV6 x) {
            throw (IOException) x.getCause();
        }
        authorize(c);
        c.header("Accept", "application/json");
        return c;
    }

    /** A JSON call to PC v itself (see openOn). */
    JSONObject callOn(String v, String method, String path, JSONObject body) throws IOException {
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

    /** After a state: the workspace's PCs as this one sees them (GET /v1/hubs: addresses on
     *  the local network, fresher than the directory's), at most every 10 minutes (30 s while
     *  one it lists online is missing here). */
    void learn(JSONObject st) {
        if (st == null) return;
        // The first PC's addresses as it says them now (it answered with its pinned key).
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
            if (t != null && now - t < (missing ? 30_000 : 600_000)) return;
            askedHubs.put(id, now);
        }
        try {
            JSONArray a = get("/v1/hubs").optJSONArray("hubs");
            if (a == null) return;
            boolean changed = false;
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.getJSONObject(i);
                String p = o.optString("id");
                // A PC whose phone access is off would drop the phone: never fail over to it.
                if (!o.optBoolean("phones", true)) { if (eps.removeIf(e -> e.pid.equals(p))) changed = true; continue; }
                String key = Addr.fp(o.optString("fp"));
                if (key == null || p.isEmpty() || key.equals(fp) || p.equals(pid)) continue;
                List<String> where = new ArrayList<>();
                strings(o.optJSONArray("addrs"), where);
                Ep e = ep(p);
                if (e == null) {
                    e = new Ep(p, o.optString("name"), o.optString("host"), o.optString("ip"), o.optInt("port"), "");
                    e.fp = key;
                    e.addrs.addAll(where);
                    eps.add(e);
                    changed = true;
                } else if (key.equals(e.fp) && !where.equals(e.addrs) && !where.isEmpty()) {
                    e.addrs.clear();
                    e.addrs.addAll(where);
                    e.port = o.optInt("port", e.port);
                    changed = true;
                }
            }
            if (changed) persist();
        } catch (Exception ignored) { }
    }

    /** Saves this hub's endpoints (kept encrypted). */
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

    /** POST /v1/transcribe: a phrase or a whole dictation (WAV, 16 kHz mono) for the PC the hub
     *  picks (Voice). `cleanup=0`: the raw words, cleaned up once at the end instead; `commands=1`:
     *  the spoken commands taken out (`send` when it ended with one). →
     *  {text, raw?, host?, send?}; 409 (ApiError) while the PC's model downloads. */
    JSONObject transcribe(byte[] wav, String lang, boolean raw, int timeout) throws IOException {
        Net.Http c = open("POST", "/v1/transcribe?lang=" + URLEncoder.encode(lang == null ? "" : lang, "UTF-8") + (raw ? "&cleanup=0&commands=1" : ""), timeout);
        try {
            c.header("Content-Type", "audio/wav");
            try (OutputStream o = c.body(wav.length)) { o.write(wav); }
            return reply(c);
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

    /** The error an answer stands for. A 401: the sign-in is missing, ran out or isn't this
     *  phone's (signin: a new token may fix it, else sign in again); a 403: this PC's workspace
     *  doesn't take this account (removed, or another workspace). */
    static ApiError error(Net.Http c, int code, String body) {
        JSONObject j = null;
        try { j = new JSONObject(body); } catch (JSONException ignored) { }
        String msg = j == null ? null : j.optString("error", null);
        ApiError e = new ApiError(code, msg != null ? msg : code == 401 ? "This PC refused the sign-in. Sign in again." : "HTTP " + code);
        if (code == 401) {
            e.signin = true;
            if (Ui.app != null) Account.renewSoon(Ui.app);
        }
        return e;
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
