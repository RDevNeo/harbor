package dev.harbor.app;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** What the local API (LocalApi) lets through, before anything reaches a PC: the Host and Origin
 *  it answers, CORS (with Private Network Access), the routes, who may call (a token from an
 *  approved pairing, scoped to one chat), the size limits and the rates; and the pairings and
 *  grants themselves. PROTOCOL.md, "Local API for other apps". Plain Java, no Android classes:
 *  the unit tests run it on the JVM with a clock of their own. */
final class LocalGate {
    /** 127.0.0.1 only, this port. */
    static final int PORT = 47999;
    static final int MAX_HEAD = 16 * 1024;
    static final int MAX_BODY = 64 * 1024;
    /** A message's text, in UTF-8 bytes once cleaned. */
    static final int MAX_TEXT = 16 * 1024;
    /** The untrusted context, as a chat link's (ChatLink.MAX_CONTEXT_BYTES). */
    static final int MAX_CONTEXT = ChatLink.MAX_CONTEXT_BYTES;
    /** A pairing waits this long for the user's answer. */
    static final long PAIR_TTL = 10 * 60_000;
    static final int MAX_PENDING = 4;
    /** Long polls one app may hold at once. */
    static final int MAX_POLLS = 2;
    /** Web pages served by a Capacitor (or Ionic) WebView: `https://localhost` (Android's
     *  default), `http://localhost` (androidScheme http), and `http://localhost:5173` (a Vite dev
     *  server's page in the phone's browser, while an app is being built). Any other origin is a web page
     *  elsewhere and gets 400; a request with no Origin (an app's own HTTP client) is let through
     *  to the token check. */
    static final String[] ORIGINS = { "https://localhost", "http://localhost", "http://localhost:5173" };

    interface Clock { long now(); }

    final Clock clock;
    /** Called (outside the lock) after the grants changed: LocalApi saves them. */
    volatile Runnable changed;

    LocalGate(Clock clock) { this.clock = clock; }

    // ---- grants and pairings ----

    /** An app allowed to chat with one chat: what its token (kept only as a hash) may do. */
    static final class Grant {
        final String hash, pkg, label, chat, title;
        final long at;
        int polls;
        final Bucket sends = new Bucket(6, 10_000), reads = new Bucket(30, 1_000);
        Grant(String hash, String pkg, String label, String chat, String title, long at) {
            this.hash = hash; this.pkg = pkg; this.label = label; this.chat = chat; this.title = title; this.at = at;
        }
    }

    /** A pairing asked for (POST /local/v1/pair): `id` is the asking app's secret to fetch the
     *  answer with, `code` what the approval link carries. */
    static final class Pair {
        final String id, code, chat, claimed;
        final long at;
        String state = "pending", token = "", pkg = "", label = "";
        Pair(String id, String code, String chat, String claimed, long at) {
            this.id = id; this.code = code; this.chat = chat; this.claimed = claimed; this.at = at;
        }
    }

    private final Map<String, Grant> grants = new LinkedHashMap<>();
    private final Map<String, Pair> pairs = new LinkedHashMap<>();
    private final Bucket pairStarts = new Bucket(3, 20_000);
    private final Bucket badTokens = new Bucket(20, 3_000);
    private static final SecureRandom random = new SecureRandom();

    synchronized List<Grant> grants() { return new ArrayList<>(grants.values()); }

    synchronized Grant byToken(String token) {
        if (token == null || !token.matches("[0-9a-f]{64}")) return null;
        String h = sha256(token);
        Grant g = grants.get(h);
        // Looked up by the hash (a secret's hash leaks nothing through timing), then checked in
        // constant time all the same.
        return g != null && MessageDigest.isEqual(g.hash.getBytes(StandardCharsets.US_ASCII), h.getBytes(StandardCharsets.US_ASCII)) ? g : null;
    }

    /** A new pairing for chat (claimed: the name the app gives itself, unverified); null when
     *  too many wait already. fixedCode: the rig's (Rig), else null for a random one. */
    synchronized Pair pairStart(String chat, String claimed, String fixedCode) {
        prune();
        int pending = 0;
        for (Pair p : pairs.values()) if (p.state.equals("pending")) pending++;
        if (pending >= MAX_PENDING) return null;
        Pair p = new Pair(hex(16), fixedCode != null ? fixedCode : hex(16), chat, claimed == null ? "" : claimed, clock.now());
        pairs.put(p.id, p);
        return p;
    }

    /** The waiting pairing a link's `approve=` code names, null when none (or it ran out). */
    synchronized Pair pairByCode(String code) {
        prune();
        if (code == null) return null;
        for (Pair p : pairs.values()) if (p.code.equals(code) && p.state.equals("pending")) return p;
        return null;
    }

    /** The user allowed it: the app that opened the link gets a token for the pairing's chat, in
     *  place of any it had for that chat. pkg: its package when Android confirmed it, "" when not
     *  (then label is the name it gave itself, and an earlier unconfirmed grant of that name for
     *  that chat is the one replaced). False when it ran out. */
    boolean approve(String code, String pkg, String label, String title) {
        synchronized (this) {
            Pair p = pairByCode(code);
            if (p == null) return false;
            String token = hex(32);
            for (Iterator<Grant> it = grants.values().iterator(); it.hasNext(); ) {
                Grant g = it.next();
                if (g.chat.equals(p.chat) && g.pkg.equals(pkg) && (!pkg.isEmpty() || g.label.equals(label))) it.remove();
            }
            Grant g = new Grant(sha256(token), pkg, label, p.chat, title == null ? "" : title, clock.now());
            grants.put(g.hash, g);
            p.state = "allowed"; p.token = token; p.pkg = pkg; p.label = label;
            notifyAll();
        }
        fire();
        return true;
    }

    synchronized void deny(String code) {
        Pair p = pairByCode(code);
        if (p == null) return;
        p.state = "denied";
        notifyAll();
    }

    /** The pairing's state for its app (null: unknown or ran out); an answer is handed out once. */
    synchronized Pair pairTake(String id) {
        prune();
        Pair p = pairs.get(id);
        if (p != null && !p.state.equals("pending")) pairs.remove(id);
        return p;
    }

    /** Waits up to ms for pairing id to be answered, then pairTake. */
    synchronized Pair awaitPair(String id, long ms) throws InterruptedException {
        long end = clock.now() + ms;
        while (true) {
            Pair p = pairs.get(id);
            if (p == null || !p.state.equals("pending")) break;
            long left = end - clock.now();
            if (left <= 0) break;
            wait(Math.min(left, 1_000));
        }
        return pairTake(id);
    }

    void revoke(String hash) {
        synchronized (this) { if (grants.remove(hash) == null) return; }
        fire();
    }

    private void fire() {
        Runnable r = changed;
        if (r != null) r.run();
    }

    private void prune() {
        long now = clock.now();
        pairs.values().removeIf(p -> now - p.at > PAIR_TTL);
    }

    /** The grants as text (one per line, tab-separated, each field escaped): what LocalApi keeps. */
    synchronized String save() {
        StringBuilder b = new StringBuilder();
        for (Grant g : grants.values())
            b.append(esc(g.hash)).append('\t').append(esc(g.pkg)).append('\t').append(esc(g.label)).append('\t')
                    .append(esc(g.chat)).append('\t').append(esc(g.title)).append('\t').append(g.at).append('\n');
        return b.toString();
    }

    synchronized void load(String text) {
        grants.clear();
        if (text == null) return;
        for (String line : text.split("\n")) {
            String[] f = line.split("\t", -1);
            if (f.length != 6) continue;
            try {
                Grant g = new Grant(unesc(f[0]), unesc(f[1]), unesc(f[2]), unesc(f[3]), unesc(f[4]), Long.parseLong(f[5]));
                if (g.hash.matches("[0-9a-f]{64}") && chatId(g.chat)) grants.put(g.hash, g);
            } catch (RuntimeException ignored) { }
        }
    }

    private static String esc(String s) {
        return s.replace("%", "%25").replace("\t", "%09").replace("\n", "%0A").replace("\r", "%0D").replace("+", "%2B");
    }

    private static String unesc(String s) {
        String d = ChatLink.decode(s);
        if (d == null) throw new IllegalArgumentException("bad field");
        return d;
    }

    // ---- who opened an approval link ----

    /** What Android (and the sender) told Hubs about the app that opened an approval link, and
     *  what the pairing says (LocalApi.ask): every source, best first in identify. */
    static final class Sources {
        int sdk;
        /** The link started the screen (onCreate), not a new intent to a running one (onNewIntent):
         *  only then is getLaunchedFrom* about this link (else it names who opened Harbor before). */
        boolean fresh;
        /** Activity.getLaunchedFromPackage (Android 14+; set when the app shared its identity,
         *  ActivityOptions.setShareIdentityEnabled), and the one package of getLaunchedFromUid. */
        String launchedPkg, launchedUidPkg;
        /** Android 15+'s Activity.getCurrentCaller() package (and its uid's one package) for a new
         *  intent: set, as launched-from, only when the app shared its identity. */
        String currentPkg, currentUidPkg;
        /** Activity.getCallingPackage: only for startActivityForResult. */
        String callingPkg;
        /** Activity.getReferrer() with the sender's extras dropped: Android's record of the
         *  launching package (android-app://<package>), which it checks against the caller's uid
         *  from Android 11; null when Android leaves it out (Harbor can't see that package). */
        String referrer;
        /** Intent.EXTRA_REFERRER and EXTRA_REFERRER_NAME as sent: anyone may write anything there. */
        String extraReferrer, extraReferrerName;
        /** The pairing's `app` (POST /local/v1/pair): the name the app gives itself. */
        String claimed = "";

        @Override public String toString() {
            return "sdk=" + sdk + " fresh=" + fresh + " launchedFromPackage=" + launchedPkg + " launchedFromUid=" + launchedUidPkg
                    + " currentCaller=" + currentPkg + " currentCallerUid=" + currentUidPkg
                    + " callingPackage=" + callingPkg + " referrer=" + referrer + " EXTRA_REFERRER=" + extraReferrer
                    + " EXTRA_REFERRER_NAME=" + extraReferrerName + " claimed=" + claimed;
        }
    }

    /** Who opened an approval link, as identify found it. */
    static final class Who {
        /** The package Android confirmed; "" when it didn't. */
        final String pkg;
        /** The package the sender itself named (an extra, or a referrer Android doesn't check
         *  before Android 11), shown as what it says; "" when none or when pkg is set. */
        final String hint;
        /** The name the app gives itself (the pairing's `app`), "" when none. */
        final String claimed;
        /** Which source said so: launched-from-package, launched-from-uid, current-caller(-uid),
         *  calling-package, referrer; or none. */
        final String how;
        /** The app's name on this phone, when pkg is set and Android shows it (LocalApi.ask). */
        String label = "";
        Who(String pkg, String hint, String claimed, String how) { this.pkg = pkg; this.hint = hint; this.claimed = claimed; this.how = how; }
        boolean verified() { return !pkg.isEmpty(); }
        /** What to call it: the app's name (else its package) when confirmed, else what it calls
         *  itself (else what it says its package is), else "An app". */
        String name() {
            if (verified()) return label.isEmpty() ? pkg : label;
            if (!claimed.isEmpty()) return claimed;
            return hint.isEmpty() ? "An app" : hint;
        }
        @Override public String toString() { return verified() ? "verified " + pkg + " (" + how + ")" : "unverified claimed=" + claimed + " hint=" + hint; }
    }

    /** The app that opened an approval link, from every source, best first: Android 14's
     *  launched-from (only on a fresh launch), Android 15's current caller (only on a new
     *  intent), the calling package, Android's referrer (checked
     *  from Android 11); the sender's own extras and the pairing's name only as what it says.
     *  own: Harbor's package (never the answer). Never null: unknown is an unverified Who. */
    static Who identify(Sources s, String own) {
        String claimed = s.claimed == null ? "" : s.claimed;
        String p;
        if (s.sdk >= 34 && s.fresh) {
            if ((p = pkg(s.launchedPkg, own)) != null) return new Who(p, "", claimed, "launched-from-package");
            if ((p = pkg(s.launchedUidPkg, own)) != null) return new Who(p, "", claimed, "launched-from-uid");
        }
        if (s.sdk >= 35 && !s.fresh) {
            if ((p = pkg(s.currentPkg, own)) != null) return new Who(p, "", claimed, "current-caller");
            if ((p = pkg(s.currentUidPkg, own)) != null) return new Who(p, "", claimed, "current-caller-uid");
        }
        if ((p = pkg(s.callingPkg, own)) != null) return new Who(p, "", claimed, "calling-package");
        String ref = appUri(s.referrer, own);
        if (ref != null && s.sdk >= 30) return new Who(ref, "", claimed, "referrer");
        String hint = ref != null ? ref : appUri(s.extraReferrer, own);
        if (hint == null) hint = appUri(s.extraReferrerName, own);
        return new Who("", hint == null ? "" : hint, claimed, "none");
    }

    /** s when it is a package name other than own, else null. */
    static String pkg(String s, String own) {
        return s != null && !s.equals(own) && s.length() <= 255 && s.matches("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+") ? s : null;
    }

    /** The package of an android-app://<package>[/...] referrer, other than own; else null. */
    static String appUri(String s, String own) {
        if (s == null || !s.startsWith("android-app://")) return null;
        String rest = s.substring("android-app://".length());
        int slash = rest.indexOf('/');
        return pkg(slash < 0 ? rest : rest.substring(0, slash), own);
    }

    /** The approval dialog's title and message for who and the chat's title. A confirmed app by
     *  its name (and package); an unconfirmed one by the name it gives itself, saying Harbor
     *  couldn't confirm which app it is. */
    static String[] prompt(Who who, String title) {
        String name = who.name();
        String rest = " asks to send messages to this chat and read its messages, through Harbor on this phone. It can't see your other chats.";
        String back = "\n\nYou can take this back in Settings › Other apps.";
        if (who.verified()) {
            String said = who.claimed.isEmpty() || who.claimed.equals(name) ? "" : " It calls itself “" + who.claimed + "”.";
            return new String[] { "Let " + name + " chat with “" + title + "”?", name + " (" + who.pkg + ")" + rest + said + back };
        }
        String what = !who.claimed.isEmpty() ? "An app calling itself “" + who.claimed + "”"
                : !who.hint.isEmpty() ? "An app that says it is " + who.hint : "An app that didn't give its name";
        String says = !who.claimed.isEmpty() && !who.hint.isEmpty() ? " (it says it is " + who.hint + ")" : "";
        String head = who.claimed.isEmpty() ? "Let an app chat with “" + title + "”?" : "Let “" + who.claimed + "” chat with “" + title + "”?";
        return new String[] { head, what + says + rest + "\n\nHarbor couldn't confirm which app it is: allow it only if you just asked for this in that app." + back };
    }

    // ---- rates ----

    /** A token bucket: `cap` at once, one more every `every` ms. */
    static final class Bucket {
        final int cap;
        final long every;
        private double have;
        private long at = -1;
        Bucket(int cap, long every) { this.cap = cap; this.every = every; this.have = cap; }

        /** Takes one; 0 when it could, else the ms until one is there. */
        synchronized long take(long now) {
            if (at < 0) at = now;
            have = Math.min(cap, have + (now - at) / (double) every);
            at = now;
            if (have >= 1) { have -= 1; return 0; }
            return (long) Math.ceil((1 - have) * every);
        }
    }

    static LocalHttp.Res tooMany(long waitMs, String what) {
        long s = Math.max(1, (waitMs + 999) / 1000);
        return LocalHttp.error(429, "rate_limited", what + ": try again in " + s + " s").header("Retry-After", String.valueOf(s));
    }

    /** A message may go: null, or the 429 to answer. */
    LocalHttp.Res takeSend(Grant g) {
        long w = g.sends.take(clock.now());
        return w == 0 ? null : tooMany(w, "Too many messages");
    }

    /** A long poll may start: null (then pollDone after it), or the 429. */
    LocalHttp.Res pollStart(Grant g) {
        synchronized (this) {
            if (g.polls >= MAX_POLLS) return LocalHttp.error(429, "rate_limited", "Too many requests waiting at once").header("Retry-After", "1");
            long w = g.reads.take(clock.now());
            if (w > 0) return tooMany(w, "Too many requests");
            g.polls++;
        }
        return null;
    }

    synchronized void pollDone(Grant g) { if (g.polls > 0) g.polls--; }

    // ---- requests ----

    enum Kind { STATUS, PAIR_START, PAIR_GET, MESSAGES_GET, MESSAGES_POST }

    /** Where a request goes: `answer` set means answer that now (an error, a preflight);
     *  else `kind` with `arg` (the chat or pairing id) and, for a chat's routes, `grant`. */
    static final class Route {
        Kind kind;
        String arg = "", origin;
        Grant grant;
        LocalHttp.Res answer;
    }

    Route route(LocalHttp.Req r) {
        Route out = new Route();
        // DNS rebinding: a page whose name now points at 127.0.0.1 still says its own name.
        String host = r.header("host");
        if (host == null || !(host.equalsIgnoreCase("127.0.0.1:" + PORT) || host.equalsIgnoreCase("localhost:" + PORT))) {
            out.answer = LocalHttp.error(400, "bad_host", "Call http://127.0.0.1:" + PORT);
            return out;
        }
        String origin = r.header("origin");
        if (origin != null) {
            if (!allowedOrigin(origin)) {
                out.answer = LocalHttp.error(400, "origin_not_allowed", "Only apps on this phone may call Harbor's local API");
                return out;
            }
            out.origin = origin;
        }
        String path = r.path;
        if (!path.startsWith("/local/v1/")) { out.answer = cors(LocalHttp.error(404, "no_route", "No such call"), out.origin); return out; }
        if (r.method.equals("OPTIONS")) { out.answer = preflight(r, out.origin); return out; }

        String[] p = path.substring("/local/v1/".length()).split("/", -1);
        String want;
        if (p.length == 1 && p[0].equals("status")) { out.kind = Kind.STATUS; want = "GET"; }
        else if (p.length == 1 && p[0].equals("pair")) { out.kind = Kind.PAIR_START; want = "POST"; }
        else if (p.length == 2 && p[0].equals("pair") && p[1].matches("[0-9a-f]{32}")) { out.kind = Kind.PAIR_GET; out.arg = p[1]; want = "GET"; }
        else if (p.length == 3 && p[0].equals("chats") && p[2].equals("messages")) {
            if (!chatId(p[1])) { out.answer = cors(LocalHttp.error(404, "unknown_chat", "No such chat"), out.origin); return out; }
            out.arg = p[1];
            out.kind = r.method.equals("POST") ? Kind.MESSAGES_POST : Kind.MESSAGES_GET;
            want = r.method.equals("POST") ? "POST" : "GET";
        } else { out.answer = cors(LocalHttp.error(404, "no_route", "No such call"), out.origin); return out; }
        if (!r.method.equals(want)) {
            out.answer = cors(LocalHttp.error(405, "method_not_allowed", "Use " + want), out.origin).header("Allow", want + ", OPTIONS");
            return out;
        }
        if (want.equals("POST")) {
            String ct = r.header("content-type");
            if (ct == null || !ct.toLowerCase(Locale.ROOT).startsWith("application/json")) {
                out.answer = cors(LocalHttp.error(415, "bad_request", "Send JSON (Content-Type: application/json)"), out.origin);
                return out;
            }
        }
        // Who calls: a chat's routes need its token; status tells more with one.
        String auth = r.header("authorization");
        String token = auth != null && auth.regionMatches(true, 0, "Bearer ", 0, 7) ? auth.substring(7).trim() : null;
        if (out.kind == Kind.MESSAGES_GET || out.kind == Kind.MESSAGES_POST || (out.kind == Kind.STATUS && token != null)) {
            Grant g = token == null ? null : byToken(token);
            if (g == null && out.kind != Kind.STATUS) {
                if (token != null && badTokens.take(clock.now()) > 0) { out.answer = cors(tooMany(3_000, "Too many bad tokens"), out.origin); return out; }
                out.answer = cors(notAllowed(token == null ? "This app isn't allowed to chat yet: pair first (POST /local/v1/pair)" : "This app isn't allowed (any more): pair again"), out.origin);
                return out;
            }
            if (g != null && out.kind != Kind.STATUS && !g.chat.equals(out.arg)) {
                out.answer = cors(notAllowed("This app isn't allowed to chat with that chat: pair for it"), out.origin);
                return out;
            }
            out.grant = g;
        }
        return out;
    }

    /** 403 is kept for this one case (clients show "Allow <app> in Harbor" and pair). */
    static LocalHttp.Res notAllowed(String why) {
        return new LocalHttp.Res(403, "{\"error\":" + LocalHttp.q(why) + ",\"code\":\"not_allowed\",\"pair\":true}");
    }

    static boolean allowedOrigin(String o) {
        for (String a : ORIGINS) if (a.equals(o)) return true;
        return false;
    }

    /** The CORS headers on an answer to an allowed origin (none without an Origin). */
    static LocalHttp.Res cors(LocalHttp.Res res, String origin) {
        if (origin == null) return res;
        return res.header("Access-Control-Allow-Origin", origin).header("Vary", "Origin")
                .header("Access-Control-Expose-Headers", "Retry-After");
    }

    /** A CORS preflight, with Private Network Access's (a secure page calling a loopback address). */
    static LocalHttp.Res preflight(LocalHttp.Req r, String origin) {
        return cors(new LocalHttp.Res(204, null), origin)
                .header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                .header("Access-Control-Allow-Headers", "Authorization, Content-Type")
                .header("Access-Control-Allow-Private-Network", "true")
                .header("Access-Control-Max-Age", "600");
    }

    /** A message's text and context are fine: null, else the error to answer. Both are cleaned
     *  first (control characters but newline and tab dropped, as a chat link's context). */
    static LocalHttp.Res checkMessage(String text, String context) {
        if (text == null || text.trim().isEmpty()) return LocalHttp.error(400, "bad_request", "`text` is empty");
        if (text.getBytes(StandardCharsets.UTF_8).length > MAX_TEXT)
            return LocalHttp.error(413, "text_too_large", "`text` is over " + (MAX_TEXT / 1024) + " KB");
        if (context != null && context.getBytes(StandardCharsets.UTF_8).length > MAX_CONTEXT)
            return LocalHttp.error(413, "context_too_large", "`context` is over " + (MAX_CONTEXT / 1024) + " KB");
        return null;
    }

    /** A pairing may start now: null, or the 429. */
    LocalHttp.Res takePairStart() {
        long w = pairStarts.take(clock.now());
        return w == 0 ? null : tooMany(w, "Too many pairing requests");
    }

    /** As a chat link's gid: 1-64 letters, digits, '_' and '-'. */
    static boolean chatId(String s) {
        return s != null && s.matches("[A-Za-z0-9_-]{1,64}");
    }

    // ---- cursors ----

    /** Where a client is in a chat's messages: the revision of the PC that answered (each PC counts
     *  its own), that PC, and whether a turn ran. Opaque to clients. */
    static final class Cursor {
        final long rev;
        final boolean running;
        final String via;
        Cursor(long rev, boolean running, String via) { this.rev = rev; this.running = running; this.via = via; }

        @Override public String toString() {
            StringBuilder h = new StringBuilder();
            for (byte b : via.getBytes(StandardCharsets.UTF_8)) h.append(String.format("%02x", b & 0xff));
            return "1." + rev + "." + (running ? "r" : "i") + "." + h;
        }

        /** Null when s isn't one. */
        static Cursor parse(String s) {
            if (s == null) return null;
            String[] p = s.split("\\.", -1);
            if (p.length != 4 || !p[0].equals("1") || !(p[2].equals("r") || p[2].equals("i")) || p[3].length() % 2 != 0 || p[3].length() > 256) return null;
            try {
                long rev = Long.parseLong(p[1]);
                if (rev < 0) return null;
                byte[] b = new byte[p[3].length() / 2];
                for (int i = 0; i < b.length; i++) b[i] = (byte) Integer.parseInt(p[3].substring(2 * i, 2 * i + 2), 16);
                return new Cursor(rev, p[2].equals("r"), new String(b, StandardCharsets.UTF_8));
            } catch (NumberFormatException e) {
                return null;
            }
        }
    }

    // ---- helpers ----

    static String hex(int bytes) {
        byte[] b = new byte[bytes];
        random.nextBytes(b);
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format("%02x", x & 0xff));
        return s.toString();
    }

    static String sha256(String s) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder h = new StringBuilder();
            for (byte x : d) h.append(String.format("%02x", x & 0xff));
            return h.toString();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** The calling socket's owner, from /proc/net/tcp or tcp6's text: the uid of the connection
     *  whose local port is clientPort and whose remote port is serverPort, -1 when none. Android
     *  10+ keeps /proc/net from apps, so this mostly says -1 there (LocalApi.callerPackages). */
    static int uidFromProcNet(String text, int clientPort, int serverPort) {
        if (text == null) return -1;
        for (String line : text.split("\n")) {
            String[] f = line.trim().split("\\s+");
            if (f.length < 8 || !f[0].endsWith(":")) continue;
            int lp = port(f[1]), rp = port(f[2]);
            if (lp == clientPort && rp == serverPort) {
                try { return Integer.parseInt(f[7]); } catch (NumberFormatException e) { return -1; }
            }
        }
        return -1;
    }

    private static int port(String addr) {
        int c = addr.lastIndexOf(':');
        if (c < 0) return -1;
        try { return Integer.parseInt(addr.substring(c + 1), 16); } catch (NumberFormatException e) { return -1; }
    }
}
