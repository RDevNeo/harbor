package dev.harbor.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.os.Build;
import android.system.OsConstants;
import android.util.Log;
import android.widget.LinearLayout;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Semaphore;

/** Harbor's local API for other apps on this phone (PROTOCOL.md, "Local API for other apps"):
 *  plain HTTP on 127.0.0.1:47999 only, so an app (a Capacitor WebView too) can hold a chat with
 *  one Harbor chat without opening Harbor, through this phone's own connection to its PCs. It
 *  runs while Harbor's process does (Listen keeps that up in the background). Who may call: an
 *  app the user allowed once for one chat (a pairing: the app opens an approval link, Android
 *  says which app opened it, the user taps Allow, the app gets a token). LocalGate decides what
 *  gets through; this file serves it and talks to the PCs. */
final class LocalApi {
    private LocalApi() { }

    static final String TAG = "harbor-localapi";
    static final LocalGate gate = new LocalGate(System::currentTimeMillis);
    /** A test build's pairing code (Rig): phoneshot's approval link carries it. */
    static final String RIG_CODE = "0123456789abcdef0123456789abcdef";

    private static Context app;
    private static ServerSocket server;
    private static long failedAt;
    /** Connections served at once (long polls hold theirs); past it, 503 at once. */
    private static final Semaphore slots = new Semaphore(16);

    private static SharedPreferences prefs() { return app.getSharedPreferences("localapi", Context.MODE_PRIVATE); }

    /** Starts listening, once per process (any screen, Listen); again after a failed bind,
     *  30 s later at the earliest (another app held the port). */
    static synchronized void start(Context c) {
        if (app == null) {
            app = c.getApplicationContext();
            gate.load(prefs().getString("grants", null));
            gate.changed = () -> prefs().edit().putString("grants", gate.save()).apply();
            if (Rig.on()) LocalRig.hook(app);
        }
        if (server != null && !server.isClosed()) return;
        long now = System.currentTimeMillis();
        if (now - failedAt < 30_000) return;
        try {
            ServerSocket s = new ServerSocket();
            s.setReuseAddress(true);
            s.bind(new InetSocketAddress(InetAddress.getByAddress(new byte[] { 127, 0, 0, 1 }), LocalGate.PORT), 32);
            server = s;
            Thread t = new Thread(() -> accept(s), "local-api");
            t.setDaemon(true);
            t.start();
            Log.i(TAG, "listening on 127.0.0.1:" + LocalGate.PORT);
        } catch (IOException e) {
            failedAt = now;
            Log.i(TAG, "can't listen on 127.0.0.1:" + LocalGate.PORT + ": " + e);
        }
    }

    private static void accept(ServerSocket s) {
        while (!s.isClosed()) {
            Socket so;
            try { so = s.accept(); } catch (IOException e) { break; }
            if (!slots.tryAcquire()) {
                try (Socket x = so) { LocalHttp.write(x.getOutputStream(), LocalHttp.error(503, "busy", "Harbor is busy: try again")); } catch (IOException ignored) { }
                continue;
            }
            Ui.pool.execute(() -> {
                try (Socket x = so) { serve(x); } catch (Exception e) { Log.i(TAG, "connection: " + e); }
                finally { slots.release(); }
            });
        }
        synchronized (LocalApi.class) { if (server == s) server = null; }
    }

    private static void serve(Socket so) throws IOException {
        so.setSoTimeout(15_000);
        InputStream in = so.getInputStream();
        OutputStream out = so.getOutputStream();
        LocalHttp.Req r;
        try {
            r = LocalHttp.read(in, LocalGate.MAX_HEAD, LocalGate.MAX_BODY);
        } catch (LocalHttp.Bad b) {
            LocalHttp.write(out, LocalHttp.error(b.status, b.code, b.getMessage()));
            return;
        }
        LocalGate.Route rt = gate.route(r);
        LocalHttp.Res res = rt.answer;
        if (res == null) {
            try {
                res = handle(r, rt, so);
            } catch (Exception e) {
                Log.i(TAG, rt.kind + ": " + e);
                res = LocalHttp.error(500, "internal", "Harbor couldn't do that: " + e.getClass().getSimpleName());
            }
            LocalGate.cors(res, rt.origin);
        }
        LocalHttp.write(out, res);
    }

    private static LocalHttp.Res handle(LocalHttp.Req r, LocalGate.Route rt, Socket so) throws Exception {
        switch (rt.kind) {
            case STATUS: return status(rt.grant);
            case PAIR_START: return pairStart(r);
            case PAIR_GET: return pairGet(r, rt.arg);
            default: break;
        }
        // A chat's routes: the token's app must be the one calling, when Android lets us tell.
        Set<String> pk = callerPackages(so);
        if (pk != null && !pk.contains(rt.grant.pkg)) return LocalGate.notAllowed("This token belongs to another app");
        if (rt.kind == LocalGate.Kind.MESSAGES_POST) return post(r, rt.grant);
        LocalHttp.Res busy = gate.pollStart(rt.grant);
        if (busy != null) return busy;
        try { return messages(r, rt.grant); } finally { gate.pollDone(rt.grant); }
    }

    // ---- who calls ----

    private static volatile String probed;

    /** The packages of the app whose socket this is, null when Android won't say: the
     *  connection's owner (ConnectivityManager, Android 10+: only a VPN app may ask, so it throws
     *  for Harbor), then /proc/net/tcp6 and tcp (closed to apps since Android 10). Where neither
     *  answers, the token alone says who calls. */
    static Set<String> callerPackages(Socket so) {
        int uid = -1;
        String how = "none";
        if (Build.VERSION.SDK_INT >= 29) {
            try {
                ConnectivityManager cm = app.getSystemService(ConnectivityManager.class);
                uid = cm.getConnectionOwnerUid(OsConstants.IPPROTO_TCP,
                        new InetSocketAddress(so.getInetAddress(), so.getPort()), new InetSocketAddress(so.getLocalAddress(), so.getLocalPort()));
                if (uid >= 0) how = "getConnectionOwnerUid";
            } catch (RuntimeException e) {
                uid = -1;
            }
        }
        for (String f : new String[] { "/proc/net/tcp6", "/proc/net/tcp" }) {
            if (uid >= 0) break;
            try (InputStream in = new java.io.FileInputStream(f)) {
                uid = LocalGate.uidFromProcNet(Hub.read(in), so.getPort(), LocalGate.PORT);
                if (uid >= 0) how = f;
            } catch (IOException | RuntimeException e) {
                uid = -1;
            }
        }
        if (!how.equals(probed)) { probed = how; Log.i(TAG, "caller's uid from: " + how + (uid >= 0 ? " (" + uid + ")" : "")); }
        if (uid < 0) return null;
        String[] p = app.getPackageManager().getPackagesForUid(uid);
        return p == null ? null : new HashSet<>(Arrays.asList(p));
    }

    // ---- status ----

    private static LocalHttp.Res status(LocalGate.Grant g) throws JSONException {
        boolean signed = !Account.needsSignIn(app) && !Hub.all(app).isEmpty();
        JSONObject o = new JSONObject().put("ok", true).put("api", 1).put("version", Settings.myName(app))
                .put("signed_in", signed).put("allowed", g != null);
        if (g == null) {
            o.put("pc_online", signed && anyPcAnswers());
            return ok(o);
        }
        JSONObject chat = new JSONObject().put("id", g.chat).put("title", g.title);
        if (signed) {
            Found f = resolve(g.chat);
            chat.put("online", f.hub != null);
            if (f.hub != null) { chat.put("title", f.title); chat.put("pc", f.pc); }
            else chat.put("why", f.error.body == null ? "" : new JSONObject(f.error.body).optString("error"));
            o.put("pc_online", f.hub != null);
        } else {
            chat.put("online", false);
            o.put("pc_online", false);
        }
        return ok(o.put("chat", chat).put("app", new JSONObject().put("label", g.label).put("package", g.pkg)));
    }

    private static boolean anyPcAnswers() {
        long now = System.currentTimeMillis();
        List<Hub> hubs = Hub.all(app);
        for (Hub h : hubs) if (now - h.lastAnswer() < 120_000) return true;
        for (Hub h : hubs) {
            try { h.call("GET", "/v1/app", null, 6_000); return true; } catch (IOException ignored) { }
        }
        return false;
    }

    // ---- pairing ----

    private static LocalHttp.Res pairStart(LocalHttp.Req r) throws JSONException {
        JSONObject b = body(r);
        if (b == null) return LocalHttp.error(400, "bad_request", "The body isn't a JSON object");
        String chat = b.optString("chat", "");
        if (!LocalGate.chatId(chat)) return LocalHttp.error(400, "bad_request", "`chat` must be a chat id");
        LocalHttp.Res slow = gate.takePairStart();
        if (slow != null) return slow;
        String claimed = ChatLink.label(b.optString("app", ""));
        LocalGate.Pair p = gate.pairStart(chat, claimed, Rig.on() ? RIG_CODE : null);
        if (p == null) return LocalGate.tooMany(60_000, "Too many pairings wait for an answer");
        return ok(new JSONObject().put("pair", p.id).put("link", "harbor://chat/" + chat + "?approve=" + p.code)
                .put("expires_in", LocalGate.PAIR_TTL / 1000));
    }

    private static LocalHttp.Res pairGet(LocalHttp.Req r, String id) throws Exception {
        LocalGate.Pair p = gate.awaitPair(id, waitMs(r, 25));
        if (p == null) return LocalHttp.error(404, "unknown_pair", "No such pairing (it was answered, or ran out after 10 minutes)");
        JSONObject o = new JSONObject().put("state", p.state);
        if (p.state.equals("allowed"))
            o.put("token", p.token).put("chat", p.chat).put("app", new JSONObject().put("label", p.label).put("package", p.pkg));
        return ok(o);
    }

    /** Who opened an approval link, as Hubs found it. */
    static final class Who {
        final String pkg, label;
        /** Android itself said so (else it's what the link's sender may have written). */
        final boolean verified;
        Who(String pkg, String label, boolean verified) { this.pkg = pkg; this.label = label; this.verified = verified; }
    }

    /** The dialog on screen (the rig's RIG_LOCAL_ALLOW taps its Allow). */
    static volatile AlertDialog asking;

    /** An approval link (harbor://chat/<chat>?approve=<code>) opened Harbor: asks the user
     *  whether that app may chat with that chat, then steps back to it. */
    static void ask(Activity a, String chat, String code, Who who) {
        LocalGate.Pair p = gate.pairByCode(code);
        if (p == null || !p.chat.equals(chat)) {
            Ui.toast(a, "That request to chat has run out: ask again from the app.");
            return;
        }
        if (who == null) {
            gate.deny(code);
            Ui.toast(a, "Harbor couldn't tell which app asked to chat, so it didn't let it.");
            return;
        }
        Ui.pool.execute(() -> {
            Found f = Account.needsSignIn(a) ? new Found() : resolve(chat);
            String title = f.title == null || f.title.isEmpty() ? chat : f.title;
            Ui.main.post(() -> {
                if (a.isFinishing() || a.isDestroyed()) { gate.deny(code); return; }
                String name = who.label.isEmpty() ? who.pkg : who.label;
                String said = p.claimed.isEmpty() || p.claimed.equals(name) ? "" : " It calls itself “" + p.claimed + "”.";
                String what = (who.verified ? name + " (" + who.pkg + ")" : "An app that says it is " + name + " (" + who.pkg + "; Android couldn't confirm it)")
                        + " asks to send messages to this chat and read its messages, through Harbor on this phone." + said
                        + " It can't see your other chats.\n\nYou can take this back in Settings › Other apps.";
                boolean[] done = { false };
                AlertDialog d = Ui.dialog(a).setTitle("Let " + name + " chat with “" + title + "”?").setMessage(what)
                        .setNegativeButton("Don't allow", (x, w) -> {
                            done[0] = true;
                            gate.deny(code);
                            a.moveTaskToBack(true);
                        })
                        .setPositiveButton("Allow", (x, w) -> {
                            done[0] = true;
                            if (gate.approve(code, who.pkg, name, title)) a.moveTaskToBack(true);
                            else Ui.toast(a, "That request ran out: ask again from the app.");
                        })
                        .setOnDismissListener(x -> { asking = null; if (!done[0]) gate.deny(code); })
                        .create();
                asking = d;
                d.show();
            });
        });
    }

    /** Settings › Other apps: each app allowed to chat, tap to take it back. Nothing when none. */
    static void settingsRows(Activity a, LinearLayout box) {
        box.removeAllViews();
        List<LocalGate.Grant> gs = gate.grants();
        if (gs.isEmpty()) return;
        Prims.section(a, box, "Other apps");
        LinearLayout card = Prims.card(a, box);
        for (LocalGate.Grant g : gs) {
            String name = g.label.isEmpty() ? g.pkg : g.label;
            LinearLayout row = Ui.cardRow(a, Ui.I_PLUG, name, "Chats with “" + (g.title.isEmpty() ? g.chat : g.title) + "” · tap to remove", Ui.FG,
                    v -> Ui.dialog(a).setTitle("Stop " + name + " chatting with “" + (g.title.isEmpty() ? g.chat : g.title) + "”?")
                            .setMessage(name + " won't be able to send or read messages of that chat through Harbor any more. It can ask again.")
                            .setNegativeButton("Cancel", null)
                            .setPositiveButton("Remove", (d, w) -> { gate.revoke(g.hash); settingsRows(a, box); })
                            .show());
            Ui.wrapSub(row, 2);
            card.addView(row, Ui.fill());
        }
    }

    // ---- the chat ----

    /** Where a chat is: its workspace (hub) and title, or the error to answer. */
    static final class Found {
        Hub hub;
        String title = "", pc = "";
        LocalHttp.Res error;
        long at;
    }

    private static final Map<String, Found> found = new HashMap<>();

    /** Which of the phone's workspaces has chat (GET /v1/chat_link, the PC's own resolver, as a
     *  link from another app), remembered for a minute. */
    static Found resolve(String chat) {
        synchronized (found) {
            Found f = found.get(chat);
            if (f != null && System.currentTimeMillis() - f.at < 60_000) return f;
        }
        Found f = new Found();
        String missing = null;
        boolean down = false;
        String link = "harbor://chat/" + chat;
        for (Hub h : Hub.all(app)) {
            try {
                JSONObject r = h.call("GET", "/v1/chat_link?url=" + URLEncoder.encode(link, "UTF-8"), null, 10_000);
                String to = r.isNull("chat") ? "" : r.optString("chat", "");
                if (!to.isEmpty()) { f.hub = h; f.title = r.optString("title", ""); break; }
                if (missing == null || missing.isEmpty()) missing = r.optString("missing", "");
            } catch (Hub.ApiError e) {
                if (e.code != 404) { down = true; if (missing == null) missing = e.getMessage(); continue; }
                try {
                    JSONObject c = Hub.chat(h.state(), chat);
                    if (c != null) { f.hub = h; f.title = c.optString("title", ""); break; }
                } catch (IOException x) { down = true; }
            } catch (IOException e) {
                down = true;
            }
        }
        if (f.hub != null) {
            f.pc = f.hub.viaName().isEmpty() ? f.hub.pcName : f.hub.viaName();
            f.at = System.currentTimeMillis();
            synchronized (found) { found.put(chat, f); }
            return f;
        }
        if (missing != null && !missing.isEmpty() && !missing.toLowerCase().contains("not found"))
            f.error = LocalHttp.error(503, "pc_offline", missing);
        else if (missing == null && down)
            f.error = LocalHttp.error(503, "pc_offline", "No PC answered: is Harbor running on the PC, and is this phone on its network?");
        else
            f.error = LocalHttp.error(404, "unknown_chat", "None of your PCs has that chat");
        return f;
    }

    private static void forget(String chat) { synchronized (found) { found.remove(chat); } }

    private static LocalHttp.Res post(LocalHttp.Req r, LocalGate.Grant g) throws Exception {
        JSONObject b = body(r);
        if (b == null) return LocalHttp.error(400, "bad_request", "The body isn't a JSON object");
        Object t = b.opt("text");
        if (!(t instanceof String)) return LocalHttp.error(400, "bad_request", "`text` must be a string");
        String text = ChatLink.clean((String) t);
        Object cx = b.opt("context");
        String context = null;
        if (cx != null && cx != JSONObject.NULL) {
            if (!(cx instanceof String)) return LocalHttp.error(400, "bad_request", "`context` must be a string");
            context = ChatLink.clean((String) cx).trim();
            if (context.isEmpty()) context = null;
        }
        LocalHttp.Res bad = LocalGate.checkMessage(text, context);
        if (bad != null) return bad;
        String cid = b.optString("client_id", "");
        if (!cid.matches("[A-Za-z0-9_-]{8,80}")) cid = UUID.randomUUID().toString();
        LocalHttp.Res slow = gate.takeSend(g);
        if (slow != null) return slow;
        if (Account.needsSignIn(app) || Hub.all(app).isEmpty()) return signedOut();
        Found f = resolve(g.chat);
        if (f.hub == null) return f.error;
        Hub h = f.hub;
        try {
            if (context != null) {
                JSONObject cb = new JSONObject().put("text", context).put("from", g.label)
                        .put("app", new JSONObject().put("label", g.label).put("package", g.pkg));
                h.call("POST", "/v1/chats/" + g.chat + "/context", cb, 15_000);
            }
            // Where the transcript ends now: the message's card comes right after (its id).
            int count0 = -1;
            long rev0 = 0;
            try {
                Got pre = get(h, "/v1/chats/" + g.chat + "/items?since=999999999999999", 15_000);
                count0 = pre.j.optInt("count", -1);
                rev0 = pre.j.optLong("rev", 0);
            } catch (IOException ignored) { }
            JSONObject res = h.send(g.chat, new JSONObject().put("text", text).put("client_id", cid));
            boolean queued = res.optBoolean("queued");
            Object id = JSONObject.NULL;
            if (!queued && count0 >= 0) id = findSent(h, g.chat, rev0, count0, text);
            return ok(new JSONObject().put("ok", true).put("id", id).put("client_id", cid)
                    .put("queued", queued).put("steering", res.optBoolean("steering")));
        } catch (Hub.ApiError e) {
            return pcError(e, g.chat);
        } catch (IOException e) {
            forget(g.chat);
            return LocalHttp.error(503, "pc_offline", Hub.why(e));
        }
    }

    /** The seq of the user card a send just made (the first at or after count0 with its text),
     *  NULL when it doesn't show within a second or so. */
    private static Object findSent(Hub h, String chat, long rev0, int count0, String text) {
        for (int i = 0; i < 3; i++) {
            try {
                if (i > 0) Thread.sleep(400L * i);
                Got g = get(h, "/v1/chats/" + chat + "/items?since=" + rev0, 15_000);
                JSONArray items = g.j.optJSONArray("items");
                int best = -1;
                for (int k = 0; items != null && k < items.length(); k++) {
                    JSONObject c = items.optJSONObject(k);
                    if (c == null || !"user".equals(c.optString("kind"))) continue;
                    int seq = c.optInt("seq", -1);
                    if (seq >= count0 && c.optString("text").trim().equals(text.trim()) && (best < 0 || seq < best)) best = seq;
                }
                if (best >= 0) return best;
            } catch (Exception e) {
                break;
            }
        }
        return JSONObject.NULL;
    }

    private static LocalHttp.Res messages(LocalHttp.Req r, LocalGate.Grant g) throws Exception {
        if (Account.needsSignIn(app) || Hub.all(app).isEmpty()) return signedOut();
        String after = r.param("after");
        int limit = 50;
        String ls = r.param("limit");
        if (ls != null) {
            try { limit = Math.max(1, Math.min(200, Integer.parseInt(ls))); } catch (NumberFormatException e) { return LocalHttp.error(400, "bad_request", "`limit` must be a number"); }
        }
        LocalGate.Cursor cur = null;
        if (after != null) {
            cur = LocalGate.Cursor.parse(after);
            if (cur == null) return LocalHttp.error(400, "bad_cursor", "`after` isn't a cursor this API gave");
        }
        Found f = resolve(g.chat);
        if (f.hub == null) return f.error;
        Hub h = f.hub;
        String base = "/v1/chats/" + g.chat + "/items?since=";
        try {
            if (cur == null) return recent(h, base, limit, false);
            long end = System.currentTimeMillis() + waitMs(r, 25);
            long since = cur.rev;
            while (true) {
                Got got = get(h, base + since, 20_000);
                long rev = got.j.optLong("rev", 0);
                // Another PC answers now (its revisions are its own) or this one started over:
                // the client starts over too.
                if (!got.pc.equals(cur.via) || rev < cur.rev) return recent(h, base, limit, true);
                boolean running = got.j.optBoolean("running");
                JSONArray ms = project(got.j, Integer.MAX_VALUE);
                long left = end - System.currentTimeMillis();
                if (ms.length() > 0 || running != cur.running || left <= 0) return page(ms, got, false);
                since = rev;
                // Wait for the chat to change: the events long-poll, on the PC that answered.
                Net.Http c = h.open("GET", "/v1/events?since=" + since, (int) Math.max(1_000, Math.min(left, 21_000)), true, true);
                try {
                    int code = c.code();
                    if (code >= 400) throw Hub.error(c, code);
                    Hub.read(c.in());
                } catch (java.net.SocketTimeoutException e) {
                    // the client's wait ran out before the PC's (20 s): ask once more, then answer
                } finally {
                    c.close();
                }
            }
        } catch (Hub.ApiError e) {
            return pcError(e, g.chat);
        } catch (IOException e) {
            forget(g.chat);
            return LocalHttp.error(503, "pc_offline", Hub.why(e));
        }
    }

    private static LocalHttp.Res recent(Hub h, String base, int limit, boolean reset) throws Exception {
        Got got = get(h, base + "0", 25_000);
        return page(project(got.j, limit), got, reset);
    }

    private static LocalHttp.Res page(JSONArray ms, Got got, boolean reset) throws JSONException {
        boolean running = got.j.optBoolean("running");
        JSONObject o = new JSONObject().put("messages", ms)
                .put("cursor", new LocalGate.Cursor(got.j.optLong("rev", 0), running, got.pc).toString())
                .put("running", running).put("count", got.j.optInt("count", 0));
        if (reset) o.put("reset", true);
        return ok(o);
    }

    /** A chat's cards as plain messages: the user's (`user`), the agent's replies (`agent`, the
     *  markdown; `done` false while it's still being written) and errors (`error`). The last
     *  `limit` of them. */
    static JSONArray project(JSONObject items, int limit) throws JSONException {
        JSONArray a = items.optJSONArray("items");
        boolean running = items.optBoolean("running");
        int count = items.optInt("count", 0);
        List<JSONObject> out = new ArrayList<>();
        for (int i = 0; a != null && i < a.length(); i++) {
            JSONObject c = a.optJSONObject(i);
            if (c == null) continue;
            String kind = c.optString("kind");
            int seq = c.optInt("seq", -1);
            JSONObject m = new JSONObject().put("id", seq);
            if (kind.equals("user")) {
                String t = c.optString("text", "");
                if (t.trim().isEmpty()) continue;
                m.put("role", "user").put("text", t).put("from", c.optString("sender", ""));
            } else if (kind.equals("text")) {
                String t = c.optString("markdown", "");
                if (t.trim().isEmpty()) continue;
                m.put("role", "agent").put("text", t).put("done", !running || seq < count - 1);
            } else if (kind.equals("error")) {
                m.put("role", "error").put("text", c.optString("text", ""));
            } else continue;
            if (c.has("at")) m.put("at", c.optLong("at"));
            out.add(m);
        }
        out.sort((x, y) -> Integer.compare(x.optInt("id"), y.optInt("id")));
        JSONArray r = new JSONArray();
        for (int i = Math.max(0, out.size() - limit); i < out.size(); i++) r.put(out.get(i));
        return r;
    }

    // ---- plumbing ----

    private static final class Got {
        JSONObject j;
        String pc;
    }

    /** A GET on the PC calls go to, kept there (stick: each PC counts its own revisions). */
    private static Got get(Hub h, String path, int timeout) throws IOException {
        Net.Http c = h.open("GET", path, timeout, true, true);
        try {
            int code = c.code();
            if (code >= 400) throw Hub.error(c, code);
            Got g = new Got();
            g.j = new JSONObject(Hub.read(c.in()));
            g.pc = c.pc == null ? "" : c.pc;
            return g;
        } catch (JSONException e) {
            throw new IOException("the PC's answer isn't JSON");
        } finally {
            c.close();
        }
    }

    private static LocalHttp.Res pcError(Hub.ApiError e, String chat) {
        forget(chat);
        if (e.code == 404) return LocalHttp.error(404, "unknown_chat", e.getMessage());
        if (e.code == 401 || e.code == 403) return signedOut();
        if (e.code == 409) return LocalHttp.error(409, "busy", e.getMessage());
        if (e.code == 413) return LocalHttp.error(413, "too_large", e.getMessage());
        if (e.code == 503) return LocalHttp.error(503, "pc_offline", e.getMessage());
        return LocalHttp.error(502, "pc_error", e.getMessage());
    }

    private static LocalHttp.Res signedOut() {
        return LocalHttp.error(503, "signed_out", "Harbor on this phone isn't signed in: open Harbor and sign in");
    }

    private static long waitMs(LocalHttp.Req r, int max) {
        String w = r.param("wait");
        if (w == null) return max * 1000L;
        try { return Math.max(0, Math.min(max, Integer.parseInt(w))) * 1000L; } catch (NumberFormatException e) { return max * 1000L; }
    }

    private static JSONObject body(LocalHttp.Req r) {
        try { return new JSONObject(r.bodyText()); } catch (JSONException e) { return null; }
    }

    private static LocalHttp.Res ok(JSONObject o) { return new LocalHttp.Res(200, o.toString()); }
}
