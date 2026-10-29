package dev.harbor.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.Signature;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** The phone's Google sign-in and its account (android/PROTOCOL.md, "Accounts"). Clerk is the
 *  OAuth provider: the browser opens its sign-in (Google only) and comes back through the
 *  account service's /oauth/android to harbor://oauth with a code, which only this app's PKCE
 *  verifier turns into tokens. With Clerk's access token the service answers who this is, a
 *  Harbor token bound to this phone's TLS key (every PC checks it itself) and, from its
 *  directory, the PCs of the account's workspaces: each workspace becomes a Hub whose
 *  endpoints are its PCs, reached directly and pinned to their keys. No pairing.
 *
 *  Nothing stops while Clerk or the service can't be reached: the Harbor token works on the
 *  PCs until it runs out (7 days; a new one is asked for about daily), and the PCs' addresses
 *  are kept. Everything is stored encrypted with a Keystore key, like the hubs. */
final class Account {
    static final String SCOPE = "openid profile email offline_access";
    /** A Harbor token is renewed when older than this, or when it runs out within 2 days. */
    static final long RENEW_MS = 12 * 3600_000L;

    static String clerk() { return Config.CLERK_URL; }
    static String clientId() { return Config.CLERK_CLIENT_ID; }
    static String service() { return Config.ACCOUNTS_URL; }
    static String redirect() { return service() + "/oauth/android"; }

    /** Clerk ended the session, or the service refused the sign-in: sign in again. */
    static final class Expired extends IOException {
        Expired(String m) { super(m); }
    }

    // ---- state (encrypted) ----

    private static JSONObject cur;

    private static SharedPreferences prefs(Context c) { return c.getSharedPreferences("account", Context.MODE_PRIVATE); }

    static synchronized JSONObject state(Context c) {
        if (cur != null) return cur;
        String enc = prefs(c).getString("state", null);
        String plain = enc == null ? null : Hub.unseal(enc);
        try { cur = plain == null ? new JSONObject() : new JSONObject(plain); } catch (JSONException e) { cur = new JSONObject(); }
        return cur;
    }

    private static synchronized void save(Context c, JSONObject j) {
        cur = j;
        String sealed = Hub.seal(j.toString());
        if (sealed != null) prefs(c).edit().putString("state", sealed).apply();
    }

    private static synchronized void edit(Context c, JSONEdit e) {
        JSONObject j = state(c);
        try { e.apply(j); } catch (JSONException ignored) { }
        save(c, j);
    }

    interface JSONEdit { void apply(JSONObject j) throws JSONException; }

    /** Someone is signed in (their sign-in may have run out: see needsSignIn). */
    static boolean signedIn(Context c) { return !state(c).optString("id").isEmpty(); }

    /** Nothing works until the user signs in again: no account, or its token ran out and
     *  Clerk won't renew it. */
    static boolean needsSignIn(Context c) {
        JSONObject s = state(c);
        if (s.optString("id").isEmpty()) return true;
        boolean live = s.optLong("exp") * 1000 > System.currentTimeMillis();
        return !live && s.optBoolean("expired");
    }

    static String name(Context c) { JSONObject s = state(c); String n = s.optString("name"); return n.isEmpty() ? s.optString("email") : n; }
    static String email(Context c) { return state(c).optString("email"); }
    static String id(Context c) { return state(c).optString("id"); }

    /** The Harbor token every call to a PC carries ("" when there's none). */
    static String token(Context c) {
        JSONObject s = state(c);
        if (System.currentTimeMillis() - s.optLong("token_at") > RENEW_MS) renewSoon(c);
        return s.optString("token");
    }

    /** The directory as last fetched: {"at", "workspaces": [...]}. */
    static JSONObject directory(Context c) {
        JSONObject d = state(c).optJSONObject("dir");
        return d == null ? new JSONObject() : d;
    }

    static JSONObject workspace(Context c, String ws) {
        JSONArray a = directory(c).optJSONArray("workspaces");
        if (a != null) for (int i = 0; i < a.length(); i++) {
            JSONObject w = a.optJSONObject(i);
            if (w != null && ws.equals(w.optString("id"))) return w;
        }
        return null;
    }

    /** "ws:<id>" → "<id>": the workspace a hub entry stands for (null for none). */
    static String wsOf(Hub h) { return h != null && h.id.startsWith("ws:") ? h.id.substring(3) : null; }

    // ---- signing in ----

    private static String b64url(byte[] b) { return Base64.encodeToString(b, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING); }

    private static byte[] sha256(byte[] b) {
        try { return MessageDigest.getInstance("SHA-256").digest(b); } catch (Exception e) { throw new IllegalStateException(e); }
    }

    static String hex(byte[] b) {
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format(Locale.ROOT, "%02x", x & 0xff));
        return s.toString();
    }

    private static String enc(String s) {
        try { return URLEncoder.encode(s, "UTF-8"); } catch (Exception e) { return s; }
    }

    /** Opens Clerk's sign-in in the browser; the answer comes back as harbor://oauth (finish). */
    static void start(Activity a) {
        byte[] v = new byte[32], st = new byte[16];
        SecureRandom r = new SecureRandom();
        r.nextBytes(v);
        r.nextBytes(st);
        String verifier = b64url(v), state = b64url(st);
        prefs(a).edit().putString("verifier", verifier).putString("flow", state).putLong("flow_at", System.currentTimeMillis()).apply();
        String url = clerk() + "/oauth/authorize?response_type=code&client_id=" + enc(clientId())
                + "&redirect_uri=" + enc(redirect()) + "&scope=" + enc(SCOPE)
                + "&code_challenge=" + b64url(sha256(verifier.getBytes(StandardCharsets.US_ASCII)))
                + "&code_challenge_method=S256&state=" + state + "&prompt=login";
        try {
            a.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (Exception e) {
            Ui.toast(a, "No browser to sign in with.");
        }
    }

    static boolean isCallback(Intent i) {
        Uri u = i == null ? null : i.getData();
        return u != null && "harbor".equals(u.getScheme()) && "oauth".equals(u.getHost());
    }

    /** The browser came back (on a background thread): the code for tokens, then the session
     *  and the directory. */
    static void finish(Context c, Uri u) throws IOException {
        String err = u.getQueryParameter("error");
        if (err != null) {
            String d = u.getQueryParameter("error_description");
            throw new IOException("Sign-in failed: " + (d != null ? d : err));
        }
        SharedPreferences p = prefs(c);
        String state = u.getQueryParameter("state"), code = u.getQueryParameter("code");
        String verifier = p.getString("verifier", null);
        boolean fresh = System.currentTimeMillis() - p.getLong("flow_at", 0) < 15 * 60_000L;
        if (code == null || state == null || verifier == null || !state.equals(p.getString("flow", "")) || !fresh)
            throw new IOException("That sign-in link isn't this phone's (or it's too old). Sign in again.");
        p.edit().remove("verifier").remove("flow").apply();
        JSONObject t = http("POST", clerk() + "/oauth/token", null, "application/x-www-form-urlencoded",
                "grant_type=authorization_code&code=" + enc(code) + "&redirect_uri=" + enc(redirect())
                        + "&client_id=" + enc(clientId()) + "&code_verifier=" + enc(verifier));
        JSONObject j = new JSONObject();
        tokens(j, t);
        session(c, j);
        directory(c, true);
    }

    private static void tokens(JSONObject j, JSONObject t) throws IOException {
        String access = t.optString("access_token", "");
        if (access.isEmpty()) throw new IOException("Clerk sent no token.");
        try {
            j.put("access", access);
            if (!t.optString("refresh_token", "").isEmpty()) j.put("refresh", t.optString("refresh_token"));
            j.put("access_exp", System.currentTimeMillis() / 1000 + t.optLong("expires_in", 3600));
        } catch (JSONException ignored) { }
    }

    /** Proof that this phone holds its TLS key: a signature over the time and the access
     *  token's hash (the service only binds tokens to keys their device holds). */
    private static JSONObject device(String access) throws IOException {
        try {
            java.security.KeyStore.PrivateKeyEntry e = Net.identity();
            long ts = System.currentTimeMillis() / 1000;
            String msg = "harbor-device-v1\n" + ts + "\n" + hex(sha256(access.getBytes(StandardCharsets.UTF_8)));
            Signature s = Signature.getInstance("SHA256withECDSA");
            s.initSign(e.getPrivateKey());
            s.update(msg.getBytes(StandardCharsets.UTF_8));
            return new JSONObject().put("kind", "phone").put("name", Hub.deviceName())
                    .put("spki", Base64.encodeToString(e.getCertificate().getPublicKey().getEncoded(), Base64.NO_WRAP))
                    .put("ts", ts).put("sig", Base64.encodeToString(s.sign(), Base64.NO_WRAP));
        } catch (IOException e) {
            throw e;
        } catch (Exception e) {
            throw new IOException("This phone couldn't sign with its key: " + e.getMessage(), e);
        }
    }

    /** POST /v1/session with Clerk's access token: the account, its workspaces, a Harbor token. */
    private static void session(Context c, JSONObject j) throws IOException {
        String access = j.optString("access");
        JSONObject body;
        try { body = new JSONObject().put("device", device(access)).put("app", Settings.myName(c)); } catch (JSONException e) { throw new IOException(e); }
        JSONObject r = http("POST", service() + "/v1/session", access, "application/json", body.toString());
        JSONObject a = r.optJSONObject("account");
        if (a == null || r.optString("token").isEmpty()) throw new IOException("The account service sent no sign-in.");
        String was = state(c).optString("id");
        try {
            for (String k : new String[] { "id", "email", "name", "image" }) j.put(k, a.optString(k));
            j.put("workspaces", r.optJSONArray("workspaces") == null ? new JSONArray() : r.optJSONArray("workspaces"));
            j.put("token", r.optString("token"));
            j.put("exp", r.optLong("exp"));
            j.put("token_at", System.currentTimeMillis());
            j.put("expired", false);
            // The same account: its directory stays until the new one comes.
            if (was.equals(a.optString("id")) && state(c).optJSONObject("dir") != null) j.put("dir", state(c).optJSONObject("dir"));
            JSONArray inv = r.optJSONArray("invites");
            if (inv != null) j.put("invites", inv);
        } catch (JSONException ignored) { }
        save(c, j);
    }

    /** A Clerk access token good for a while, refreshed with the refresh token. */
    private static String freshAccess(Context c, JSONObject j) throws IOException {
        if (!j.optString("access").isEmpty() && j.optLong("access_exp") - System.currentTimeMillis() / 1000 > 300) return j.optString("access");
        String refresh = j.optString("refresh");
        if (refresh.isEmpty()) throw new Expired("Your sign-in ran out: sign in again.");
        JSONObject t;
        try {
            t = http("POST", clerk() + "/oauth/token", null, "application/x-www-form-urlencoded",
                    "grant_type=refresh_token&refresh_token=" + enc(refresh) + "&client_id=" + enc(clientId()));
        } catch (Hub.ApiError e) {
            if (e.code == 400 || e.code == 401) throw new Expired("Your sign-in ran out: sign in again.");
            throw e;
        }
        tokens(j, t);
        return j.optString("access");
    }

    private static volatile long renewing;

    /** A new Harbor token in the background, when one is due (at most once a minute). */
    static void renewSoon(Context c) {
        long now = System.currentTimeMillis();
        if (now - renewing < 60_000) return;
        renewing = now;
        Context app = c.getApplicationContext();
        Ui.pool.execute(() -> { try { renew(app, false); } catch (Exception ignored) { } });
    }

    /** A new Harbor token (and the directory), when due or forced. Expired: Clerk ended the
     *  session; the old token works on the PCs until it runs out. */
    static synchronized void renew(Context c, boolean force) throws IOException {
        JSONObject s = state(c);
        if (s.optString("id").isEmpty()) return;
        long now = System.currentTimeMillis();
        boolean due = force || now - s.optLong("token_at") > RENEW_MS || s.optLong("exp") * 1000 - now < 2 * 86400_000L;
        if (due) {
            JSONObject j;
            try { j = new JSONObject(s.toString()); } catch (JSONException e) { j = new JSONObject(); }
            try {
                freshAccess(c, j);
                session(c, j);
            } catch (Expired e) {
                edit(c, x -> x.put("expired", true));
                throw e;
            } catch (Hub.ApiError e) {
                if (e.code == 401) { edit(c, x -> x.put("expired", true)); throw new Expired(e.getMessage()); }
                throw e;
            }
        }
        directory(c, due);
    }

    // ---- the directory: workspaces and their PCs ----

    private static volatile long dirAt;

    /** GET /v1/directory (at most every 2 minutes unless forced) → the hubs. */
    static void directory(Context c, boolean force) throws IOException {
        if (!force && System.currentTimeMillis() - dirAt < 120_000) return;
        String tok = state(c).optString("token");
        if (tok.isEmpty()) return;
        JSONObject d;
        try {
            d = http("GET", service() + "/v1/directory", tok, null, null);
        } catch (Hub.ApiError e) {
            if (e.code == 401) renewSoon(c);
            throw e;
        }
        dirAt = System.currentTimeMillis();
        edit(c, j -> j.put("dir", d));
        hubs(c, d);
        // Invitations waiting for this account (only Accept joins).
        try {
            JSONArray inv = http("GET", service() + "/v1/invites", tok, null, null).optJSONArray("invites");
            if (inv != null) edit(c, j -> j.put("invites", inv));
        } catch (Hub.ApiError e) {
            if (e.code != 404) throw e; // a service before invitations in Harbor
        }
    }

    /** Invitations to workspaces waiting for this account: [{id, ws, ws_name, inviter_name, email, at}]. */
    static JSONArray invites(Context c) {
        JSONArray a = state(c).optJSONArray("invites");
        return a == null ? new JSONArray() : a;
    }

    /** Accepts (joins that workspace: its PCs show up) or declines an invitation. Returns the
     *  joined workspace's name, or null. Nothing on the phone or the PCs is lost either way. */
    static String answer(Context c, String id, boolean accept) throws IOException {
        JSONObject r = http("POST", service() + "/v1/invites/" + enc(id) + (accept ? "/accept" : "/decline"), token(c), null, null);
        edit(c, j -> {
            JSONArray a = j.optJSONArray("invites"), keep = new JSONArray();
            if (a != null) for (int i = 0; i < a.length(); i++) if (!id.equals(a.optJSONObject(i).optString("id"))) keep.put(a.optJSONObject(i));
            j.put("invites", keep);
        });
        JSONObject joined = r.optJSONObject("joined");
        if (accept) renew(c, true); // a token naming the new workspace, and its PCs
        return joined == null ? null : joined.optString("name");
    }

    /** Each workspace with PCs is a hub: its first PC (the one used last, else the newest)
     *  answers, the others are its endpoints. Pairings from before accounts go. */
    static synchronized void hubs(Context c, JSONObject dir) {
        List<Hub> old = Hub.all(c), out = new ArrayList<>();
        JSONArray ws = dir.optJSONArray("workspaces");
        String token = state(c).optString("token");
        if (ws != null) for (int i = 0; i < ws.length(); i++) {
            JSONObject w = ws.optJSONObject(i);
            JSONArray pcs = w == null ? null : w.optJSONArray("pcs");
            if (pcs == null || pcs.length() == 0) continue;
            String id = "ws:" + w.optString("id");
            Hub was = null;
            for (Hub h : old) if (h.id.equals(id)) was = h;
            JSONObject first = null;
            for (int k = 0; k < pcs.length(); k++) {
                JSONObject p = pcs.optJSONObject(k);
                if (p == null || Addr.fp(p.optString("fp")) == null) continue;
                if (was != null && p.optString("fp").equals(was.fp)) { first = p; break; }
                if (first == null || p.optLong("seen") > first.optLong("seen")) first = p;
            }
            if (first == null) continue;
            Hub h = new Hub(id, w.optString("name"), "", 0, token);
            place(h, first);
            for (int k = 0; k < pcs.length(); k++) {
                JSONObject p = pcs.optJSONObject(k);
                if (p == null || p == first || Addr.fp(p.optString("fp")) == null) continue;
                Hub.Ep e = new Hub.Ep(pcId(p), p.optString("name"), "", "", 0, token);
                e.fp = p.optString("fp");
                addrs(p, e.addrs);
                if (!e.addrs.isEmpty()) { Object[] hp = Addr.hostPort(e.addrs.get(0), 47930); e.host = (String) hp[0]; e.port = (Integer) hp[1]; }
                // What the PCs said on the local network (GET /v1/hubs) comes first.
                if (was != null) { Hub.Ep o = was.ep(e.pid); if (o != null) for (String a : o.addrs) if (!e.addrs.contains(a)) e.addrs.add(0, a); }
                h.eps.add(e);
            }
            if (was != null && was.fp.equals(h.fp)) for (String a : was.addrs) if (!h.addrs.contains(a)) h.addrs.add(0, a);
            out.add(h);
        }
        Hub.save(c, out);
    }

    private static String pcId(JSONObject p) {
        String id = p.optString("id");
        return id.isEmpty() ? "fp:" + p.optString("fp").substring(0, 16) : id;
    }

    private static void place(Hub h, JSONObject p) {
        h.fp = p.optString("fp");
        h.pid = pcId(p);
        h.pcName = p.optString("name");
        addrs(p, h.addrs);
        if (!h.addrs.isEmpty()) {
            Object[] hp = Addr.hostPort(h.addrs.get(0), 47930);
            h.host = (String) hp[0];
            h.port = (Integer) hp[1];
        }
    }

    private static void addrs(JSONObject p, List<String> into) {
        JSONArray a = p.optJSONArray("addrs");
        if (a != null) for (int i = 0; i < a.length(); i++) {
            String x = a.optString(i, "").trim();
            if (!x.isEmpty() && !into.contains(x)) into.add(x);
        }
    }

    /** Signs this phone out: its tokens, account and PCs go (the PCs refuse its old token once
     *  their directory no longer lists this phone, after DELETE /v1/devices). */
    static void signOut(Context c) {
        String tok = state(c).optString("token"), fp = Net.myFp();
        if (!tok.isEmpty() && !fp.isEmpty()) Ui.pool.execute(() -> { try { http("DELETE", service() + "/v1/devices/" + fp, tok, null, null); } catch (Exception ignored) { } });
        save(c, new JSONObject());
        for (Hub h : Hub.all(c)) Hub.remove(c, h.id);
        Hub.states.clear();
    }

    // ---- workspace actions (owners invite and remove; anyone leaves) ----

    /** Invites someone by email. No email goes out: the invitation waits in their Harbor once
     *  they sign in with a Google account whose verified email is this one. */
    static void invite(Context c, String ws, String email) throws IOException {
        try {
            http("POST", service() + "/v1/workspaces/" + enc(ws) + "/invites", token(c), "application/json", new JSONObject().put("email", email.trim().toLowerCase(Locale.ROOT)).toString());
        } catch (JSONException e) { throw new IOException(e); }
        directory(c, true);
    }

    static void cancelInvite(Context c, String ws, String id) throws IOException {
        http("DELETE", service() + "/v1/workspaces/" + enc(ws) + "/invites/" + enc(id), token(c), null, null);
        directory(c, true);
    }

    static void removeMember(Context c, String ws, String user) throws IOException {
        http("DELETE", service() + "/v1/workspaces/" + enc(ws) + "/members/" + enc(user), token(c), null, null);
        if (user.equals(id(c))) renew(c, true); else directory(c, true);
    }

    // ---- HTTPS ----

    /** One call to Clerk or the service (the platform's TLS and CAs). Errors: ApiError with
     *  the answer's "error" (or Clerk's error_description). */
    static JSONObject http(String method, String url, String bearer, String ctype, String body) throws IOException {
        HttpURLConnection h = (HttpURLConnection) new URL(url).openConnection();
        try {
            h.setConnectTimeout(15_000);
            h.setReadTimeout(25_000);
            h.setInstanceFollowRedirects(false);
            h.setRequestMethod(method);
            h.setRequestProperty("Accept", "application/json");
            if (bearer != null) h.setRequestProperty("Authorization", "Bearer " + bearer);
            if (body != null) {
                byte[] b = body.getBytes(StandardCharsets.UTF_8);
                h.setDoOutput(true);
                h.setRequestProperty("Content-Type", ctype);
                h.setFixedLengthStreamingMode(b.length);
                try (OutputStream o = h.getOutputStream()) { o.write(b); }
            }
            int code = h.getResponseCode();
            InputStream in = code >= 400 ? h.getErrorStream() : h.getInputStream();
            String text = in == null ? "" : read(in);
            JSONObject j;
            try { j = text.trim().isEmpty() ? new JSONObject() : new JSONObject(text); } catch (JSONException e) { j = new JSONObject(); }
            if (code >= 400) {
                String m = j.optString("error_description", j.optString("error", ""));
                if (m.isEmpty()) m = code >= 500 ? "The account service is unavailable right now. Try again soon." : "HTTP " + code;
                Hub.ApiError e = new Hub.ApiError(code, m);
                e.signin = j.optBoolean("signin");
                throw e;
            }
            return j;
        } finally {
            h.disconnect();
        }
    }

    private static String read(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        try (InputStream i = in) {
            for (int n; (n = i.read(buf)) > 0; ) {
                if (b.size() + n > (4 << 20)) throw new IOException("answer too big");
                b.write(buf, 0, n);
            }
        }
        return b.toString("UTF-8");
    }
}
