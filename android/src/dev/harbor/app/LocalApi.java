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

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
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
import java.util.concurrent.atomic.AtomicInteger;

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

    /** What the files' ids are signed with (LocalFiles.mint), made once per install. */
    private static byte[] fileKey;
    /** Files uploaded to a PC and voice messages transcribed, since the start (the rig counts them). */
    static final AtomicInteger uploads = new AtomicInteger(), transcribed = new AtomicInteger();

    /** Starts listening, once per process (any screen, Listen); again after a failed bind,
     *  30 s later at the earliest (another app held the port). */
    static synchronized void start(Context c) {
        if (app == null) {
            app = c.getApplicationContext();
            gate.load(prefs().getString("grants", null));
            gate.changed = () -> prefs().edit().putString("grants", gate.save()).apply();
            String k = prefs().getString("file-key", "");
            if (!k.matches("[0-9a-f]{64}")) { k = LocalGate.hex(32); prefs().edit().putString("file-key", k).apply(); }
            fileKey = new byte[32];
            for (int i = 0; i < 32; i++) fileKey[i] = (byte) Integer.parseInt(k.substring(2 * i, 2 * i + 2), 16);
            // Attachments a request left half-read when the process ended.
            File[] left = spool().listFiles();
            if (left != null) for (File f : left) f.delete();
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

    /** One connection: the head first, routed and its token checked before any body is read; then
     *  the body (64 KB at most; a message's up to 15 MB, read as it arrives: LocalFiles.read). */
    private static void serve(Socket so) throws IOException {
        so.setSoTimeout(15_000);
        InputStream in = so.getInputStream();
        OutputStream out = so.getOutputStream();
        LocalHttp.Req r;
        try {
            r = LocalHttp.readHead(in, LocalGate.MAX_HEAD);
        } catch (LocalHttp.Bad b) {
            LocalHttp.write(out, LocalHttp.error(b.status, b.code, b.getMessage()));
            return;
        }
        LocalGate.Route rt = gate.route(r);
        LocalHttp.Res res = rt.answer;
        if (res == null && r.length > LocalGate.maxBody(rt.kind)) {
            res = LocalGate.cors(rt.kind == LocalGate.Kind.MESSAGES_POST
                    ? LocalHttp.error(413, "attachments_too_large", "The request is over " + (LocalFiles.MAX_POST_BODY >> 20) + " MB: attachments may be "
                            + (LocalFiles.MAX_BYTES >> 20) + " MB together")
                    : LocalHttp.error(413, "too_large", "the request is over " + (LocalGate.MAX_BODY / 1024) + " KB"), rt.origin);
        }
        if (res == null) {
            try {
                if (rt.kind != LocalGate.Kind.MESSAGES_POST) LocalHttp.readBody(in, r, LocalGate.MAX_BODY);
                res = handle(r, rt, so, in, out);
            } catch (LocalHttp.Bad b) {
                res = LocalHttp.error(b.status, b.code, b.getMessage());
            } catch (Exception e) {
                Log.i(TAG, rt.kind + ": " + e);
                res = LocalHttp.error(500, "internal", "Harbor couldn't do that: " + e.getClass().getSimpleName());
            }
            if (!res.sent) LocalGate.cors(res, rt.origin);
        }
        if (!res.sent) LocalHttp.write(out, res);
    }

    private static LocalHttp.Res handle(LocalHttp.Req r, LocalGate.Route rt, Socket so, InputStream in, OutputStream out) throws Exception {
        switch (rt.kind) {
            case STATUS: return status(rt.grant);
            case PAIR_START: return pairStart(r);
            case PAIR_GET: return pairGet(r, rt.arg);
            default: break;
        }
        // A chat's routes: the token's app must be the one calling, when Android lets us tell.
        Set<String> pk = callerPackages(so);
        if (pk != null && !pk.contains(rt.grant.pkg)) return LocalGate.notAllowed("This token belongs to another app");
        if (rt.kind == LocalGate.Kind.MESSAGES_POST) return post(r, rt.grant, in);
        if (rt.kind == LocalGate.Kind.FILE_GET) {
            LocalHttp.Res busy = gate.fileStart(rt.grant);
            if (busy != null) return busy;
            try { return file(r, rt.grant, rt.file, rt.origin, out); } finally { gate.fileDone(rt.grant); }
        }
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
        return ok(o.put("chat", chat).put("app", appJson(g.label, g.pkg)));
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

    /** An allowed app as the API shows it: package "" and verified false when Android didn't
     *  confirm which app it is (label is then the name it gave itself). */
    private static JSONObject appJson(String label, String pkg) throws JSONException {
        return new JSONObject().put("label", label).put("package", pkg).put("verified", !pkg.isEmpty());
    }

    private static LocalHttp.Res pairGet(LocalHttp.Req r, String id) throws Exception {
        LocalGate.Pair p = gate.awaitPair(id, waitMs(r, 25));
        if (p == null) return LocalHttp.error(404, "unknown_pair", "No such pairing (it was answered, or ran out after 10 minutes)");
        JSONObject o = new JSONObject().put("state", p.state);
        if (p.state.equals("allowed"))
            o.put("token", p.token).put("chat", p.chat).put("app", appJson(p.label, p.pkg));
        return ok(o);
    }

    /** The dialog on screen (the rig's RIG_LOCAL_ALLOW taps its Allow). */
    static volatile AlertDialog asking;

    /** An approval link (harbor://chat/<chat>?approve=<code>) opened Harbor (Hubs): asks the
     *  user whether the app that opened it may chat with that chat, then steps back to it.
     *  src: what Android and the sender said about that app (LocalGate.identify picks). An app
     *  Android doesn't name is still asked about, by the name it gives itself and said to be
     *  unconfirmed: the answer is the user's, once. */
    static void ask(Base a, String chat, String code, LocalGate.Sources src) {
        LocalGate.Pair p = gate.pairByCode(code);
        src.claimed = p == null ? "" : p.claimed;
        LocalGate.Who who = LocalGate.identify(src, a.getPackageName());
        if (who.verified()) who.label = appLabel(a, who.pkg);
        Log.i(TAG, "LOCALAPI who: " + src + " -> " + who);
        if (p == null || !p.chat.equals(chat)) {
            Ui.toast(a, "That request to chat has run out: ask again from the app.");
            back(a, who);
            return;
        }
        Ui.pool.execute(() -> {
            Found f = Account.needsSignIn(a) ? new Found() : resolve(chat);
            String title = f.title == null || f.title.isEmpty() ? chat : f.title;
            Ui.main.post(() -> {
                if (a.isFinishing() || a.isDestroyed()) { gate.deny(code); return; }
                String[] t = LocalGate.prompt(who, title);
                boolean[] done = { false };
                AlertDialog d = Ui.dialog(a).setTitle(t[0]).setMessage(t[1])
                        .setNegativeButton("Don't allow", (x, w) -> {
                            done[0] = true;
                            gate.deny(code);
                            back(a, who);
                        })
                        .setPositiveButton("Allow", (x, w) -> {
                            done[0] = true;
                            if (!gate.approve(code, who.pkg, who.name(), title)) Ui.toast(a, "That request ran out: ask again from the app.");
                            back(a, who);
                        })
                        .setOnDismissListener(x -> {
                            asking = null;
                            if (done[0]) return;
                            gate.deny(code);
                            back(a, who);
                        })
                        .create();
                asking = d;
                d.show();
            });
        });
    }

    /** The app's name on this phone, "" when Android doesn't show it to Harbor. */
    private static String appLabel(Context c, String pkg) {
        try {
            android.content.pm.PackageManager pm = c.getPackageManager();
            return String.valueOf(pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)));
        } catch (Exception e) {
            return "";
        }
    }

    /** Back to the app that asked, after an answer or an error: Harbor's task steps behind it
     *  (Hubs is singleTask, so the link brought Harbor's own task to the front, over the app's).
     *  When Harbor is still in front a moment later (a launcher that keeps it there), the
     *  confirmed app is opened by its launch intent, which brings its task back as it was. */
    static void back(Base a, LocalGate.Who who) {
        boolean moved = a.moveTaskToBack(true);
        Log.i(TAG, "LOCALAPI back: moveTaskToBack " + moved);
        Ui.main.postDelayed(() -> {
            if (a.isDestroyed() || !a.front) { Log.i(TAG, "LOCALAPI back: Harbor left the front"); return; }
            android.content.Intent l = who.verified() ? a.getPackageManager().getLaunchIntentForPackage(who.pkg) : null;
            Log.i(TAG, "LOCALAPI back: Harbor still in front; " + (l == null ? "no app to open" : "opening " + who.pkg));
            if (l == null) return;
            try { a.startActivity(l.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (RuntimeException ignored) { }
        }, 800);
    }

    /** Settings › Other apps: each app allowed to chat, tap to take it back. Nothing when none. */
    static void settingsRows(Activity a, LinearLayout box) {
        box.removeAllViews();
        List<LocalGate.Grant> gs = gate.grants();
        if (gs.isEmpty()) return;
        Prims.section(a, box, "Other apps");
        LinearLayout card = Prims.card(a, box);
        for (LocalGate.Grant g : gs) {
            String name = g.label.isEmpty() ? (g.pkg.isEmpty() ? "An app" : g.pkg) : g.label;
            // The package when Android confirmed it; else the name is only what the app said.
            String which = g.pkg.isEmpty() ? "Not confirmed by Android" : g.pkg;
            LinearLayout row = Ui.cardRow(a, Ui.I_PLUG, name, which + " · chats with “" + (g.title.isEmpty() ? g.chat : g.title) + "” · tap to remove", Ui.FG,
                    v -> Ui.dialog(a).setTitle("Stop " + name + " chatting with “" + (g.title.isEmpty() ? g.chat : g.title) + "”?")
                            .setMessage(name + " won't be able to send or read messages of that chat through Harbor any more. It can ask again.")
                            .setNegativeButton("Cancel", null)
                            .setPositiveButton("Remove", (d, w) -> { gate.revoke(g.hash); settingsRows(a, box); })
                            .show());
            Ui.wrapSub(row, 3);
            card.addView(row, Ui.fill());
        }
    }

    // ---- the chat ----

    /** Where a chat is: its workspace (hub), title and own PC, or the error to answer. */
    static final class Found {
        Hub hub;
        String title = "", pc = "";
        /** The chat's own PC as hub names its PCs ("" its first, else a mesh id); null when the
         *  phone can't reach that PC itself: calls then go through the PC in use, which forwards. */
        String home;
        LocalHttp.Res error;
        long at;
    }

    private static final Map<String, Found> found = new HashMap<>();
    /** The longest a lookup takes (every workspace asked at once), as opening the chat would wait. */
    static final long RESOLVE_WAIT = 12_000;

    /** Which of the phone's workspaces has chat, and which of its PCs it lives on: each
     *  workspace's /v1/state (what the chat list shows; it also brings that workspace's PCs up to
     *  date, Hub.learn), then GET /v1/chat_link (the PC's own resolver, as a link from another
     *  app). Every workspace at once, the one that had it last first, for at most RESOLVE_WAIT;
     *  remembered for a minute (the workspace across restarts). The same with no Harbor screen
     *  open (Listen alone keeps the process up): each call connects by itself, Hub's Route trying
     *  every PC of the workspace that answers. Each lookup logs a "LOCALAPI resolve" line with
     *  every workspace's answer. */
    static Found resolve(String chat) {
        synchronized (found) {
            Found f = found.get(chat);
            if (f != null && System.currentTimeMillis() - f.at < 60_000) return f;
        }
        long t0 = System.currentTimeMillis();
        List<Hub> hubs = new ArrayList<>(Hub.all(app));
        String hint = prefs().getString("ws-" + chat, "");
        for (int i = 0; i < hubs.size(); i++) if (hubs.get(i).id.equals(hint)) { hubs.add(0, hubs.remove(i)); break; }
        int n = hubs.size();
        Found[] fs = new Found[n];
        LocalGate.Probe[] ps = new LocalGate.Probe[n];
        Object lock = new Object();
        for (int i = 0; i < n; i++) {
            final int k = i;
            Ui.pool.execute(() -> {
                Found f = new Found();
                LocalGate.Probe p = probe(hubs.get(k), chat, f);
                synchronized (lock) { fs[k] = f; ps[k] = p; lock.notifyAll(); }
            });
        }
        Found hit = null;
        List<LocalGate.Probe> all = new ArrayList<>();
        synchronized (lock) {
            while (true) {
                int done = 0;
                for (int i = 0; i < n; i++) if (ps[i] != null) { done++; if (hit == null && ps[i].state == LocalGate.FOUND) hit = fs[i]; }
                long left = t0 + RESOLVE_WAIT - System.currentTimeMillis();
                if (hit != null || done == n || left <= 0) break;
                try { lock.wait(left); } catch (InterruptedException e) { break; }
            }
            for (int i = 0; i < n; i++)
                all.add(ps[i] != null ? ps[i] : new LocalGate.Probe(hubs.get(i).label(), LocalGate.DOWN, "No answer within " + RESOLVE_WAIT / 1000 + " s.", 0));
        }
        StringBuilder log = new StringBuilder();
        for (LocalGate.Probe p : all)
            log.append(" | ").append(p.ws).append(": ").append(new String[] { "has it", "hasn't it", "down", "error" }[p.state]).append(p.why.isEmpty() ? "" : " (" + p.why + ")");
        Log.i(TAG, "LOCALAPI resolve " + chat + " in " + (System.currentTimeMillis() - t0) + " ms"
                + (hit == null ? ": not found" : ": on " + hit.pc + (hit.home != null ? ", called directly" : ", through the PC in use")) + log);
        if (hit != null) {
            hit.at = System.currentTimeMillis();
            synchronized (found) { found.put(chat, hit); }
            prefs().edit().putString("ws-" + chat, hit.hub.id).apply();
            return hit;
        }
        Found f = new Found();
        f.error = LocalGate.notFound(all);
        return f;
    }

    /** What workspace h says about chat; f filled in when it has it. */
    private static LocalGate.Probe probe(Hub h, String chat, Found f) {
        String ws = h.label();
        try {
            JSONObject c = Hub.chat(h.state(), chat);
            if (c != null) {
                f.title = c.optString("title", "");
                List<String> eps = new ArrayList<>();
                for (String v : h.endpoints()) if (!v.isEmpty()) eps.add(v);
                f.home = LocalGate.endpointFor(c.optString("home", ""), h.pid, eps);
                f.pc = c.optString("home_name", "");
            } else {
                try {
                    JSONObject r = h.call("GET", "/v1/chat_link?url=" + URLEncoder.encode("harbor://chat/" + chat, "UTF-8"), null, 10_000);
                    String to = r.isNull("chat") ? "" : r.optString("chat", "");
                    if (to.isEmpty()) return new LocalGate.Probe(ws, LocalGate.ABSENT, "", 0);
                    f.title = r.optString("title", "");
                } catch (Hub.ApiError e) {
                    if (e.code == 404) return new LocalGate.Probe(ws, LocalGate.ABSENT, "", 0); // a PC from before chat links
                    throw e;
                }
            }
            f.hub = h;
            if (f.pc.isEmpty()) f.pc = h.viaName().isEmpty() ? h.pcName : h.viaName();
            return new LocalGate.Probe(ws, LocalGate.FOUND, "", 0);
        } catch (Hub.ApiError e) {
            return new LocalGate.Probe(ws, LocalGate.REFUSED, e.getMessage(), e.code);
        } catch (IOException e) {
            return new LocalGate.Probe(ws, LocalGate.DOWN, h.whyDown(e), 0);
        }
    }

    private static void forget(String chat) { synchronized (found) { found.remove(chat); } }

    // ---- calls about the chat ----

    /** A connection for a call about the chat: to its own PC when the phone can reach it (no PC
     *  in between to forward it, or to think that PC is off: a copy's PC answers 503 "… is
     *  offline" when its mesh doesn't see the chat's), else through the workspace's PC in use
     *  (Hub's Route tries each PC that answers). Its pc says which PC took it. */
    private static Net.Http open(Found f, String method, String path, int timeout) throws IOException {
        if (f.home != null) {
            try {
                return on(f.hub, f.home, method, path, timeout);
            } catch (IOException e) {
                Log.i(TAG, "LOCALAPI " + f.pc + " not reached directly (" + Hub.why(e) + "): through the PC in use");
            }
        }
        return f.hub.open(method, path, timeout, true, false);
    }

    /** A connection to PC v of h itself ("" its first), chats named by their gid. */
    private static Net.Http on(Hub h, String v, String method, String path, int timeout) throws IOException {
        Net.Http c = h.openOn(v, method, path, timeout);
        c.header("X-Harbor-Ids", "global");
        c.pc = v;
        return c;
    }

    /** A write about the chat on its own PC (see open). One that didn't get through there (no
     *  answer: an answer, an error too, is final) is made again through the PC in use: a send
     *  carries its client_id (the PCs run it once), a context replaces the last. */
    private static JSONObject write(Found f, String chat, String path, JSONObject body, int timeout) throws IOException {
        if (f.home != null) {
            try {
                return json(on(f.hub, f.home, "POST", path, timeout), body);
            } catch (Hub.ApiError e) {
                throw e;
            } catch (IOException e) {
                Log.i(TAG, "LOCALAPI " + f.pc + " didn't take " + path + " directly (" + Hub.why(e) + "): through the PC in use");
            }
        }
        if (path.endsWith("/send")) return f.hub.send(chat, body);
        return f.hub.call("POST", path, body, timeout);
    }

    private static JSONObject json(Net.Http c, JSONObject body) throws IOException {
        try {
            if (body != null) {
                byte[] b = body.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
                c.header("Content-Type", "application/json");
                try (OutputStream o = c.body(b.length)) { o.write(b); }
            }
            int code = c.code();
            String text = Hub.read(c.in());
            if (code >= 400) throw Hub.error(c, code, text);
            return text.trim().isEmpty() ? new JSONObject() : new JSONObject(text);
        } catch (JSONException e) {
            throw new IOException("the PC's answer isn't JSON");
        } finally {
            c.close();
        }
    }

    /** A message from the app: read as it arrives (attachments decoded into files on the way),
     *  then sent as Harbor's own composer sends one (post below). */
    private static LocalHttp.Res post(LocalHttp.Req r, LocalGate.Grant g, InputStream in) throws Exception {
        boolean big = r.length > LocalGate.MAX_BODY;
        if (big) {
            LocalHttp.Res busy = gate.bodyStart(g);
            if (busy != null) return busy;
        }
        LocalFiles.Post p;
        try {
            File dir = spool();
            dir.mkdirs();
            InputStream body = LocalHttp.bodyStream(new BufferedInputStream(in, 1 << 16), r, gate.clock, gate.clock.now() + LocalFiles.BODY_TIME);
            try {
                p = LocalFiles.read(body, dir);
            } catch (LocalHttp.Bad b) {
                // Refused partway: the rest of the body (15 MB at most, within its 60 s) is read and
                // dropped first, so the app gets the answer, not a connection reset mid-upload.
                if (b.status != 408) {
                    byte[] skip = new byte[1 << 16];
                    try { while (body.read(skip) >= 0) { } } catch (IOException ignored) { }
                }
                throw b;
            }
        } finally {
            if (big) gate.bodyDone(g);
        }
        try { return post(p, g); } finally { p.drop(); }
    }

    private static LocalHttp.Res post(LocalFiles.Post p, LocalGate.Grant g) throws Exception {
        if (p.textBad) return LocalHttp.error(400, "bad_request", "`text` must be a string");
        if (p.contextBad) return LocalHttp.error(400, "bad_request", "`context` must be a string");
        String text = ChatLink.clean(p.text == null ? "" : p.text);
        String context = null;
        if (p.context != null) {
            context = ChatLink.clean(p.context).trim();
            if (context.isEmpty()) context = null;
        }
        LocalHttp.Res bad = LocalGate.checkMessage(text, context, p.atts.size());
        if (bad != null) return bad;
        String cid = p.clientId;
        if (!cid.matches("[A-Za-z0-9_-]{8,80}")) cid = UUID.randomUUID().toString();
        // A repeat of a message (the app didn't get the answer) gets the first one's answer.
        LocalGate.Sent s = gate.sent(g, cid);
        synchronized (s) {
            long until = System.currentTimeMillis() + 60_000;
            while (s.running) {
                long left = until - System.currentTimeMillis();
                if (left <= 0) return LocalHttp.error(409, "busy", "This message (its client_id) is still being sent");
                s.wait(left);
            }
            if (s.res != null) {
                Log.i(TAG, "LOCALAPI repeat of " + cid + ": answered as the first");
                return copy(s.res);
            }
            s.running = true;
        }
        LocalHttp.Res res = null;
        try {
            res = send(p, g, text, context, cid, s);
            return res;
        } finally {
            synchronized (s) {
                s.running = false;
                if (res != null && res.status == 200) s.res = copy(res);
                s.notifyAll();
            }
        }
    }

    private static LocalHttp.Res copy(LocalHttp.Res r) {
        LocalHttp.Res c = new LocalHttp.Res(r.status, r.body);
        c.headers.putAll(r.headers);
        return c;
    }

    /** The message to the chat as Harbor's phone composer sends one: a voice message transcribed
     *  first (as the composer's mic: the PC's /v1/transcribe; nothing goes when that fails, and the
     *  audio itself isn't kept), the context, the files uploaded (POST /v1/upload) to the PC that
     *  takes the send, then the send with their ids and an `[Image #k]` for each image. To the
     *  chat's own PC when the phone reaches it, else through the PC in use; uploads made already for
     *  this client_id aren't made again. */
    private static LocalHttp.Res send(LocalFiles.Post p, LocalGate.Grant g, String text, String context, String cid, LocalGate.Sent s) throws Exception {
        if (!p.atts.isEmpty()) {
            LocalHttp.Res slow = gate.takeUpload(g);
            if (slow != null) return slow;
        }
        LocalHttp.Res slow = gate.takeSend(g);
        if (slow != null) return slow;
        if (Account.needsSignIn(app) || Hub.all(app).isEmpty()) return signedOut();
        Found f = resolve(g.chat);
        if (f.hub == null) return f.error;
        List<LocalFiles.Att> ups = new ArrayList<>();
        int images = 0;
        for (LocalFiles.Att a : p.atts) {
            if (a.audio()) continue;
            ups.add(a);
            if (a.image()) images++;
        }
        String step = "transcribe";
        try {
            String said = text;
            LocalFiles.Att voice = p.audio();
            if (voice != null) {
                String words = s.transcript;
                if (words == null) {
                    words = transcribe(f, voice);
                    s.transcript = words;
                }
                said = LocalFiles.withTranscript(text, words);
            }
            if (images > 0) said = LocalFiles.withImageTokens(said, images);
            step = "context";
            if (context != null) {
                JSONObject cb = new JSONObject().put("text", context).put("from", g.label)
                        .put("app", new JSONObject().put("label", g.label).put("package", g.pkg));
                write(f, g.chat, "/v1/chats/" + g.chat + "/context", cb, 15_000);
            }
            step = "send";
            // Where the transcript ends now: the message's card comes right after (its id).
            int count0 = -1;
            long rev0 = 0;
            String pc0 = null;
            try {
                Got pre = get(f, "/v1/chats/" + g.chat + "/items?since=999999999999999", 15_000);
                count0 = pre.j.optInt("count", -1);
                rev0 = pre.j.optLong("rev", 0);
                pc0 = pre.pc;
            } catch (IOException ignored) { }
            JSONObject res = ups.isEmpty()
                    ? write(f, g.chat, "/v1/chats/" + g.chat + "/send", new JSONObject().put("text", said).put("client_id", cid), 15_000)
                    : sendFiles(f, g.chat, ups, s, said, cid);
            if (!ups.isEmpty()) keep(g.chat, ups, s);
            boolean queued = res.optBoolean("queued");
            Object id = JSONObject.NULL;
            if (!queued && count0 >= 0) id = findSent(f, g.chat, pc0, rev0, count0, said);
            Log.i(TAG, "LOCALAPI sent to " + f.pc + (context != null ? " with context" : "") + (ups.isEmpty() ? "" : " with " + ups.size() + " files")
                    + (voice != null ? " and a voice message" : "") + (queued ? ", queued" : ""));
            JSONObject o = new JSONObject().put("ok", true).put("id", id).put("client_id", cid)
                    .put("queued", queued).put("steering", res.optBoolean("steering"));
            if (voice != null) o.put("transcript", s.transcript);
            return ok(o);
        } catch (LocalHttp.Bad b) {
            Log.i(TAG, "LOCALAPI " + step + ": " + b.status + " " + b.code + " " + b.getMessage());
            throw b;
        } catch (Hub.ApiError e) {
            Log.i(TAG, "LOCALAPI " + step + " refused by the PC (" + e.code + "): " + e.getMessage());
            return pcError(e, g.chat);
        } catch (IOException e) {
            forget(g.chat);
            Log.i(TAG, "LOCALAPI " + step + " didn't reach " + f.pc + ": " + Hub.why(e));
            return LocalHttp.error(503, "pc_offline", f.hub.whyDown(e));
        }
    }

    /** A voice message's words, as the composer's mic gets them: decoded here (LocalVoice) into a
     *  16 kHz WAV, then the PC's POST /v1/transcribe (the workspace's PC in use, which hands it to
     *  the PC Settings › Voice picked). LocalHttp.Bad when there are none: 415 (can't decode), 413
     *  (too long), 503 transcribe_unavailable (no PC could transcribe now: their words), 502
     *  transcribe_failed (no words heard, or another error), 503 pc_offline. */
    private static String transcribe(Found f, LocalFiles.Att voice) throws IOException {
        long t0 = System.currentTimeMillis();
        LocalFiles.Wav16k w = LocalVoice.decode(voice.file);
        JSONObject j;
        try {
            j = f.hub.transcribe(w.wav(), "", false, 120_000);
        } catch (Hub.ApiError e) {
            Log.i(TAG, "LOCALAPI transcribe refused (" + e.code + "): " + e.getMessage());
            if (e.code == 401 || e.code == 403) throw new LocalHttp.Bad(503, "signed_out", "Harbor on this phone isn't signed in: open Harbor and sign in");
            if (e.code == 404 || e.code == 409 || e.code == 503)
                throw new LocalHttp.Bad(503, "transcribe_unavailable", "No PC can transcribe the voice message now" + (e.getMessage() == null || e.getMessage().isEmpty() ? "" : ": " + e.getMessage()));
            if (e.code == 413) throw new LocalHttp.Bad(413, "audio_too_long", "The voice message is too long for the PC");
            throw new LocalHttp.Bad(502, "transcribe_failed", "The voice message couldn't be transcribed: " + e.getMessage());
        } catch (IOException e) {
            Log.i(TAG, "LOCALAPI transcribe didn't reach the PC: " + Hub.why(e));
            throw new LocalHttp.Bad(503, "pc_offline", f.hub.whyDown(e));
        }
        transcribed.incrementAndGet();
        String words = j.optString("text", "").trim();
        Log.i(TAG, "LOCALAPI transcribed " + String.format(java.util.Locale.ROOT, "%.1f", w.seconds()) + " s of " + voice.mime + " on "
                + j.optString("host", "?") + " in " + (System.currentTimeMillis() - t0) + " ms: " + words.length() + " characters");
        if (words.isEmpty()) throw new LocalHttp.Bad(502, "transcribe_failed", "Harbor didn't hear any words in the voice message");
        return words;
    }

    /** The send with files: on the chat's own PC when the phone reaches it (the files uploaded
     *  there), else through the PC in use (uploaded there: it hands them to the chat's PC with the
     *  send). A send that got no answer on the chat's PC is made again the other way, the files
     *  uploaded again there (that PC can't use the other's uploads). */
    private static JSONObject sendFiles(Found f, String chat, List<LocalFiles.Att> ups, LocalGate.Sent s, String text, String cid) throws IOException, JSONException {
        if (f.home != null) {
            try {
                return sendFilesVia(f, chat, ups, s, text, cid, true);
            } catch (Hub.ApiError | LocalHttp.Bad e) {
                throw e;
            } catch (IOException e) {
                Log.i(TAG, "LOCALAPI " + f.pc + " didn't take the files directly (" + Hub.why(e) + "): through the PC in use");
            }
        }
        return sendFilesVia(f, chat, ups, s, text, cid, false);
    }

    private static JSONObject sendFilesVia(Found f, String chat, List<LocalFiles.Att> ups, LocalGate.Sent s, String text, String cid, boolean direct) throws IOException, JSONException {
        String where = direct ? "home " + f.hub.id + " " + f.home : "route " + f.hub.id;
        JSONArray ids = new JSONArray();
        for (int i = 0; i < ups.size(); i++) {
            LocalFiles.Att a = ups.get(i);
            String[] u;
            synchronized (s) { u = s.ups.get(i); }
            if (u == null || !u[0].equals(where) || !u[1].equals(a.name + "\n" + a.size)) {
                JSONObject r = direct ? uploadOn(f, chat, a) : uploadRoute(f, chat, a);
                String id = r.optString("id", "");
                if (id.isEmpty()) throw new Hub.ApiError(502, "The PC didn't say where it put " + a.name);
                u = new String[] { where, a.name + "\n" + a.size, id, r.optString("path", "") };
                synchronized (s) { s.ups.put(i, u); }
                uploads.incrementAndGet();
                Log.i(TAG, "LOCALAPI uploaded " + a.name + " (" + a.size + " bytes) " + (direct ? "to " + f.pc : "through the PC in use"));
            }
            ids.put(u[2]);
        }
        JSONObject body = new JSONObject().put("text", text).put("files", ids).put("client_id", cid);
        return direct ? json(on(f.hub, f.home, "POST", "/v1/chats/" + chat + "/send", 15_000), body) : f.hub.send(chat, body);
    }

    /** POST /v1/upload on the chat's own PC: the file streamed from its decoded copy. */
    private static JSONObject uploadOn(Found f, String chat, LocalFiles.Att a) throws IOException {
        Net.Http c = on(f.hub, f.home, "POST", "/v1/upload?name=" + URLEncoder.encode(a.name, "UTF-8") + "&chat=" + URLEncoder.encode(chat, "UTF-8"), 120_000);
        Hub.writes.incrementAndGet();
        try {
            c.header("Content-Type", "application/octet-stream");
            try (OutputStream o = c.body(a.size); InputStream in = new FileInputStream(a.file)) {
                byte[] buf = new byte[1 << 16];
                for (int n; (n = in.read(buf)) > 0; ) o.write(buf, 0, n);
            }
            return json(c, null);
        } finally {
            c.close();
            Hub.writes.decrementAndGet();
        }
    }

    /** The composer's own upload (Hub.upload): through the workspace's PC in use. */
    private static JSONObject uploadRoute(Found f, String chat, LocalFiles.Att a) throws IOException {
        try (InputStream in = new FileInputStream(a.file)) { return f.hub.upload(a.name, chat, in, a.size); }
    }

    // ---- files kept on this phone ----

    /** Where a message's attachments arrive before they go (the cache: gone with a restart). */
    private static File spool() { return new File(app.getCacheDir(), "localapi-up"); }

    /** The files an app sent to chat, kept on this phone under the name the PC gave them (the
     *  transcript names them so: GET .../files serves them from here, a PDF too, which the PC
     *  doesn't serve for a user's message). At most KEEP_BYTES in all and KEEP_DAYS each. */
    static File keptDir(String chat) { return new File(new File(app.getFilesDir(), "localapi-files"), chat); }

    static final long KEEP_BYTES = 200L * 1024 * 1024;
    static final int KEEP_DAYS = 30;

    private static void keep(String chat, List<LocalFiles.Att> ups, LocalGate.Sent s) {
        File dir = keptDir(chat);
        dir.mkdirs();
        for (int i = 0; i < ups.size(); i++) {
            LocalFiles.Att a = ups.get(i);
            String[] u;
            synchronized (s) { u = s.ups.get(i); }
            String name = u == null ? "" : LocalFiles.baseName(u[3]);
            if (!LocalFiles.keptName(name)) name = System.currentTimeMillis() + "-" + a.name;
            File to = new File(dir, name);
            if (to.exists() || a.file == null || !a.file.exists()) continue;
            if (!a.file.renameTo(to)) {
                try (InputStream in = new FileInputStream(a.file); OutputStream o = new FileOutputStream(to)) {
                    byte[] buf = new byte[1 << 16];
                    for (int n; (n = in.read(buf)) > 0; ) o.write(buf, 0, n);
                } catch (IOException e) {
                    to.delete();
                    Log.i(TAG, "LOCALAPI couldn't keep " + a.name + ": " + e);
                }
            }
        }
        prune();
    }

    private static synchronized void prune() {
        File root = new File(app.getFilesDir(), "localapi-files");
        File[] chats = root.listFiles();
        if (chats == null) return;
        List<File> all = new ArrayList<>();
        long now = System.currentTimeMillis(), total = 0;
        for (File c : chats) {
            File[] fs = c.listFiles();
            if (fs == null) continue;
            for (File f : fs) {
                if (now - f.lastModified() > KEEP_DAYS * 86_400_000L) { f.delete(); continue; }
                all.add(f);
                total += f.length();
            }
            String[] rest = c.list();
            if (rest != null && rest.length == 0) c.delete();
        }
        all.sort((x, y) -> Long.compare(x.lastModified(), y.lastModified()));
        for (File f : all) {
            if (total <= KEEP_BYTES) break;
            total -= f.length();
            f.delete();
        }
    }

    private static List<String> keptNames(String chat) {
        String[] n = keptDir(chat).list();
        return n == null ? new ArrayList<>() : new ArrayList<>(Arrays.asList(n));
    }

    /** A kept file of chat by its name, null when there's none (or the name could reach outside). */
    private static File keptFile(String chat, String name) {
        if (!LocalFiles.keptName(name)) return null;
        try {
            File dir = keptDir(chat).getCanonicalFile();
            File f = new File(dir, name).getCanonicalFile();
            return dir.equals(f.getParentFile()) && f.isFile() ? f : null;
        } catch (IOException e) {
            return null;
        }
    }

    // ---- GET .../files/<id> ----

    /** A file of the chat by its id (LocalFiles.mint: made by GET messages, for this chat alone):
     *  a file kept here, else the PC's image (whole, or `?thumb=1`: a JPEG of 512 px at most),
     *  reply file or video, streamed as it comes (by parts from the chat's PC, as Files does). */
    private static LocalHttp.Res file(LocalHttp.Req r, LocalGate.Grant g, String id, String origin, OutputStream out) throws Exception {
        String[] kp = LocalFiles.open(fileKey, g.chat, id);
        if (kp == null) return LocalHttp.error(404, "unknown_file", "No such file in this chat");
        boolean thumb = "1".equals(r.param("thumb"));
        char k = kp[0].charAt(0);
        String p = kp[1];
        if (k == LocalFiles.LOCAL) {
            File f = keptFile(g.chat, p);
            if (f == null) return LocalHttp.error(404, "unknown_file", "That file is no longer on this phone");
            return local(f, LocalFiles.shownName(p), thumb, origin, out);
        }
        String name = LocalFiles.baseName(LocalFiles.pathOf(p));
        if (k == LocalFiles.IMAGE) {
            // An image an app sent: the copy kept here, without asking the PC.
            String m = LocalFiles.match(name, keptNames(g.chat));
            File f = m == null ? null : keptFile(g.chat, m);
            if (f != null) return local(f, LocalFiles.shownName(m), thumb, origin, out);
        } else if (thumb) {
            return LocalHttp.error(400, "no_thumb", "Only images have a thumbnail");
        }
        if (Account.needsSignIn(app) || Hub.all(app).isEmpty()) return signedOut();
        Found f = resolve(g.chat);
        if (f.hub == null) return f.error;
        try {
            if (k == LocalFiles.IMAGE) return pcImage(f, LocalFiles.imageUrl(p, thumb), name, thumb, origin, out);
            return pcFile(f, p, name, origin, out);
        } catch (Hub.ApiError e) {
            if (e.code == 404) return LocalHttp.error(404, "unknown_file", "It's gone from the PC, or the PC that has it is off");
            return pcError(e, g.chat);
        } catch (IOException e) {
            forget(g.chat);
            return LocalHttp.error(503, "pc_offline", f.hub.whyDown(e));
        }
    }

    /** A file's answer headers: CORS (as every answer), its name, a day in the app's cache, and
     *  nothing in it may run (anything not an image, video or PDF). */
    private static Map<String, String> fileHeaders(String origin, String name, String mime) {
        LocalHttp.Res h = LocalGate.cors(new LocalHttp.Res(200, null), origin);
        boolean shown = mime.startsWith("image/") || mime.startsWith("video/") || mime.equals(LocalFiles.PDF);
        String enc;
        try { enc = URLEncoder.encode(name, "UTF-8").replace("+", "%20"); } catch (IOException e) { enc = "file"; }
        h.header("Content-Disposition", (shown ? "inline" : "attachment") + "; filename*=UTF-8''" + enc);
        h.header("Cache-Control", "private, max-age=86400");
        if (!shown || mime.equals("image/svg+xml")) h.header("Content-Security-Policy", "sandbox; default-src 'none'");
        return h.headers;
    }

    private static LocalHttp.Res local(File f, String name, boolean thumb, String origin, OutputStream out) throws IOException {
        String mime = LocalFiles.mimeOf(f.getName());
        if (thumb) {
            if (!mime.startsWith("image/")) return LocalHttp.error(400, "no_thumb", "Only images have a thumbnail");
            byte[] j = thumbJpeg(f);
            if (j == null) return LocalHttp.error(415, "no_thumb", "Harbor couldn't make a thumbnail of that image");
            LocalHttp.head(out, 200, "image/jpeg", j.length, fileHeaders(origin, name, "image/jpeg"));
            out.write(j);
            out.flush();
            return LocalHttp.sent(200);
        }
        LocalHttp.head(out, 200, LocalFiles.servedType(mime), f.length(), fileHeaders(origin, name, mime));
        try (InputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[1 << 16];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
        } catch (IOException e) {
            Log.i(TAG, "LOCALAPI file cut off: " + e);
        }
        out.flush();
        return LocalHttp.sent(200);
    }

    /** A JPEG of an image at most 512 px on its longer side, null when Android can't read it. */
    private static byte[] thumbJpeg(File f) {
        android.graphics.BitmapFactory.Options o = new android.graphics.BitmapFactory.Options();
        o.inJustDecodeBounds = true;
        android.graphics.BitmapFactory.decodeFile(f.getPath(), o);
        if (o.outWidth <= 0 || o.outHeight <= 0) return null;
        int sample = 1;
        while (Math.max(o.outWidth, o.outHeight) / (sample * 2) >= 512) sample *= 2;
        android.graphics.BitmapFactory.Options d = new android.graphics.BitmapFactory.Options();
        d.inSampleSize = sample;
        android.graphics.Bitmap b = android.graphics.BitmapFactory.decodeFile(f.getPath(), d);
        if (b == null) return null;
        float scale = Math.min(1f, 512f / Math.max(b.getWidth(), b.getHeight()));
        android.graphics.Bitmap t = scale < 1f ? android.graphics.Bitmap.createScaledBitmap(b, Math.max(1, Math.round(b.getWidth() * scale)), Math.max(1, Math.round(b.getHeight() * scale)), true) : b;
        java.io.ByteArrayOutputStream o2 = new java.io.ByteArrayOutputStream();
        t.compress(android.graphics.Bitmap.CompressFormat.JPEG, 82, o2);
        if (t != b) t.recycle();
        b.recycle();
        return o2.toByteArray();
    }

    /** The PC's image (GET /v1/image, the transcript's URL): its type from its first bytes. */
    private static LocalHttp.Res pcImage(Found f, String url, String name, boolean thumb, String origin, OutputStream out) throws IOException {
        Net.Http c = open(f, "GET", url, 30_000);
        try {
            int code = c.code();
            if (code >= 400) throw Hub.error(c, code);
            InputStream in = c.in();
            byte[] head = new byte[16];
            int n = 0;
            for (int x; n < head.length && (x = in.read(head, n, head.length - n)) > 0; ) n += x;
            String mime = thumb ? "image/jpeg" : LocalFiles.sniff(head, n);
            if (mime == null || !mime.startsWith("image/")) mime = n >= 4 && head[0] == 'G' && head[1] == 'I' && head[2] == 'F' && head[3] == '8' ? "image/gif" : LocalFiles.mimeOf(name);
            if (!mime.startsWith("image/") || mime.equals("image/svg+xml")) mime = "application/octet-stream";
            LocalHttp.head(out, 200, mime, c.length(), fileHeaders(origin, name, mime));
            try {
                out.write(head, 0, n);
                byte[] buf = new byte[1 << 16];
                for (int x; (x = in.read(buf)) > 0; ) out.write(buf, 0, x);
            } catch (IOException e) {
                Log.i(TAG, "LOCALAPI image cut off: " + e);
            }
            out.flush();
            return LocalHttp.sent(200);
        } finally {
            c.close();
        }
    }

    /** A reply's file or video from the PC (GET /v1/file, /v1/media), by Range parts as Files
     *  fetches them (a copy's PC hands on 8 MB at a time): the whole file to the app. */
    private static LocalHttp.Res pcFile(Found f, String url, String name, String origin, OutputStream out) throws IOException {
        String mime = LocalFiles.mimeOf(name);
        long at = 0, total = -1;
        boolean headed = false;
        int fails = 0;
        byte[] buf = new byte[1 << 16];
        while (true) {
            Net.Http c = null;
            try {
                c = open(f, "GET", url, 30_000);
                c.header("Range", "bytes=" + at + "-");
                int code = c.code();
                if (!headed) {
                    if (code >= 400 && code != 416) throw Hub.error(c, code);
                    total = code == 416 ? 0 : code == 206 ? Blocks.total(c.range()) : c.length();
                    LocalHttp.head(out, 200, LocalFiles.servedType(mime), total, fileHeaders(origin, name, mime));
                    headed = true;
                    if (code == 416) break;
                } else if (code != 206) {
                    Log.i(TAG, "LOCALAPI file part answered " + code + ": cut off");
                    break;
                }
                InputStream in = c.in();
                long began = at;
                for (int n; (n = in.read(buf)) > 0; ) {
                    out.write(buf, 0, n);
                    at += n;
                }
                if (code == 200 || total < 0 || at >= total) break;
                if (at == began) throw new IOException("the PC stopped sending it");
                fails = 0;
            } catch (Hub.ApiError e) {
                if (!headed) throw e;
                break;
            } catch (IOException e) {
                if (headed || ++fails >= 3) {
                    if (!headed) throw e;
                    Log.i(TAG, "LOCALAPI file cut off: " + e);
                    break;
                }
                try { Thread.sleep(500L * fails); } catch (InterruptedException x) { throw e; }
            } finally {
                if (c != null) c.close();
            }
        }
        out.flush();
        return LocalHttp.sent(200);
    }

    /** The seq of the user card a send just made (the first at or after count0 with its text),
     *  NULL when it doesn't show within a second or so, or another PC answers than the one that
     *  counted (each counts its own revisions). */
    private static Object findSent(Found f, String chat, String pc0, long rev0, int count0, String text) {
        for (int i = 0; i < 3; i++) {
            try {
                if (i > 0) Thread.sleep(400L * i);
                Got g = get(f, "/v1/chats/" + chat + "/items?since=" + rev0, 15_000);
                if (!g.pc.equals(pc0)) return JSONObject.NULL;
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
        String base = "/v1/chats/" + g.chat + "/items?since=";
        try {
            if (cur == null) return recent(f, g.chat, base, limit, false);
            long end = System.currentTimeMillis() + waitMs(r, 25);
            long since = cur.rev;
            while (true) {
                Got got = get(f, base + since, 20_000);
                long rev = got.j.optLong("rev", 0);
                // Another PC answers now (its revisions are its own) or this one started over:
                // the client starts over too.
                if (!got.pc.equals(cur.via) || rev < cur.rev) return recent(f, g.chat, base, limit, true);
                boolean running = got.j.optBoolean("running");
                JSONArray ms = project(got.j, Integer.MAX_VALUE, g.chat);
                long left = end - System.currentTimeMillis();
                if (ms.length() > 0 || running != cur.running || left <= 0) return page(ms, got, false);
                since = rev;
                // Wait for the chat to change: the events long-poll, on the PC that answered.
                Net.Http c;
                try {
                    c = on(f.hub, got.pc, "GET", "/v1/events?since=" + since, (int) Math.max(1_000, Math.min(left, 21_000)));
                } catch (IOException e) {
                    // That PC went away a moment ago: the next round asks whichever answers.
                    Thread.sleep(Math.min(1_000, Math.max(0, left)));
                    continue;
                }
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
            return LocalHttp.error(503, "pc_offline", f.hub.whyDown(e));
        }
    }

    private static LocalHttp.Res recent(Found f, String chat, String base, int limit, boolean reset) throws Exception {
        Got got = get(f, base + "0", 25_000);
        return page(project(got.j, limit, chat), got, reset);
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
     *  `limit` of them. Those with files say so (`attachments`, see attachments). */
    static JSONArray project(JSONObject items, int limit, String chat) throws JSONException {
        JSONArray a = items.optJSONArray("items");
        boolean running = items.optBoolean("running");
        int count = items.optInt("count", 0);
        List<String> kept = null;
        List<JSONObject> out = new ArrayList<>();
        for (int i = 0; a != null && i < a.length(); i++) {
            JSONObject c = a.optJSONObject(i);
            if (c == null) continue;
            String kind = c.optString("kind");
            int seq = c.optInt("seq", -1);
            JSONObject m = new JSONObject().put("id", seq);
            JSONArray files = null;
            if (kind.equals("user") || kind.equals("text")) {
                boolean any = has(c, "images") || has(c, "files") || has(c, "media");
                if (any && kept == null) kept = keptNames(chat);
                files = any ? attachments(c, kind.equals("user"), chat, kept) : new JSONArray();
            }
            if (kind.equals("user")) {
                String t = c.optString("text", "");
                if (t.trim().isEmpty() && files.length() == 0) continue;
                m.put("role", "user").put("text", t).put("from", c.optString("sender", ""));
            } else if (kind.equals("text")) {
                String t = c.optString("markdown", "");
                if (t.trim().isEmpty() && files.length() == 0) continue;
                m.put("role", "agent").put("text", t).put("done", !running || seq < count - 1);
            } else if (kind.equals("error")) {
                m.put("role", "error").put("text", c.optString("text", ""));
            } else continue;
            if (files != null && files.length() > 0) m.put("attachments", files);
            if (c.has("at")) m.put("at", c.optLong("at"));
            out.add(m);
        }
        out.sort((x, y) -> Integer.compare(x.optInt("id"), y.optInt("id")));
        JSONArray r = new JSONArray();
        for (int i = Math.max(0, out.size() - limit); i < out.size(); i++) r.put(out.get(i));
        return r;
    }

    private static boolean has(JSONObject c, String k) {
        JSONArray x = c.optJSONArray(k);
        return x != null && x.length() > 0;
    }

    /** A message's files as the API shows them: {id, name, mime, size, url, kind, thumb_url?}.
     *  A user's: its images (the PC's /v1/image; a copy kept here when an app sent it) and other
     *  files (only those an app sent through here, kept on this phone: the PC serves no user's
     *  file but images, so others have id and url null). A reply's: its images and videos (the
     *  card's `images` and `media`) and the files it attached (`files`, the PC's /v1/file). `url`
     *  is GET /local/v1/chats/<chat>/files/<id>, an id signed for this chat alone. */
    static JSONArray attachments(JSONObject c, boolean user, String chat, List<String> kept) throws JSONException {
        JSONArray out = new JSONArray();
        java.util.Set<String> seen = new HashSet<>();
        JSONArray im = c.optJSONArray("images");
        for (int i = 0; im != null && i < im.length(); i++) {
            JSONObject x = im.optJSONObject(i);
            String url = x == null ? "" : x.optString("url", "");
            if (url.isEmpty() || !seen.add(LocalFiles.imageUrl(url, false))) continue;
            String pcName = x.optString("name", LocalFiles.baseName(LocalFiles.pathOf(url)));
            Object size = JSONObject.NULL;
            if (user) {
                String k = LocalFiles.match(LocalFiles.baseName(LocalFiles.pathOf(url)), kept);
                if (k != null) size = new File(keptDir(chat), k).length();
            }
            out.put(att(chat, LocalFiles.IMAGE, url, user ? LocalFiles.shownName(pcName) : pcName, size, "image"));
        }
        JSONArray media = c.optJSONArray("media");
        for (int i = 0; media != null && i < media.length(); i++) {
            JSONObject x = media.optJSONObject(i);
            String url = x == null ? "" : x.optString("url", "");
            if (url.isEmpty()) continue;
            boolean video = "video".equals(x.optString("kind"));
            if (!video && !seen.add(LocalFiles.imageUrl(url, false))) continue;
            if (video && !seen.add(url)) continue;
            out.put(att(chat, video ? LocalFiles.VIDEO : LocalFiles.IMAGE, url, x.optString("name", ""), JSONObject.NULL, video ? "video" : "image"));
        }
        JSONArray fs = c.optJSONArray("files");
        for (int i = 0; fs != null && i < fs.length(); i++) {
            if (user) {
                String pcName = fs.optString(i, "");
                if (pcName.isEmpty()) continue;
                String k = LocalFiles.match(pcName, kept);
                if (k != null) out.put(att(chat, LocalFiles.LOCAL, k, LocalFiles.shownName(pcName), new File(keptDir(chat), k).length(), "file"));
                else out.put(new JSONObject().put("id", JSONObject.NULL).put("name", LocalFiles.shownName(pcName)).put("mime", LocalFiles.mimeOf(pcName))
                        .put("size", JSONObject.NULL).put("url", JSONObject.NULL).put("kind", "file"));
            } else {
                JSONObject x = fs.optJSONObject(i);
                String url = x == null ? "" : x.optString("url", "");
                if (url.isEmpty() || !seen.add(url)) continue;
                out.put(att(chat, LocalFiles.FILE, url, x.optString("name", ""), x.has("size") ? (Object) x.optLong("size") : JSONObject.NULL, "file"));
            }
        }
        return out;
    }

    private static JSONObject att(String chat, char k, String payload, String name, Object size, String kind) throws JSONException {
        String id = LocalFiles.mint(fileKey, chat, k, payload);
        String url = "/local/v1/chats/" + chat + "/files/" + id;
        String mime = LocalFiles.mimeOf(name);
        if (kind.equals("image") && !mime.startsWith("image/")) mime = "image/*";
        JSONObject o = new JSONObject().put("id", id).put("name", name).put("mime", mime).put("size", size).put("url", url).put("kind", kind);
        if (kind.equals("image")) o.put("thumb_url", url + "?thumb=1");
        return o;
    }

    // ---- plumbing ----

    private static final class Got {
        JSONObject j;
        String pc;
    }

    /** A GET about the chat (see open): its own PC, else the PC in use. pc: the PC that
     *  answered (each counts its own revisions: a cursor holds it). */
    private static Got get(Found f, String path, int timeout) throws IOException {
        Net.Http c = open(f, "GET", path, timeout);
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
