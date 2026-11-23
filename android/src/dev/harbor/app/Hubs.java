package dev.harbor.app;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.List;

/** The start screen: "Sign in with Google" until this phone is signed in (Account), then the
 *  account's workspaces, each with its PCs (one Hub per workspace). The browser comes back
 *  here after the sign-in (harbor://oauth). There's no pairing: a PC shows up once its owner
 *  signed in on it, in a workspace this account is in. Another app or a browser opens a chat
 *  with its link, harbor://chat/<gid>?pc=<PC name> (ChatLink). */
public class Hubs extends Base {
    private LinearLayout list;
    private boolean busy;
    /** A live restart's screens are opening over this one (Swap.restore): drawn blank, Harbor's
     *  background only, until it's out of sight. */
    boolean restoring;
    private String error;
    /** A chat link is being looked up (openPending). */
    private boolean resolving;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        page = Ui.col(this);
        page.setBackgroundColor(Ui.BG);
        ScrollView sv = new ScrollView(this);
        sv.setFillViewport(true);
        list = Ui.col(this);
        list.setPadding(Ui.dp(20), Ui.dp(24), Ui.dp(20), Ui.dp(24));
        sv.addView(list);
        page.addView(sv, new LinearLayout.LayoutParams(-1, -1));
        setContentView(page);

        if (b == null && !handleLink(getIntent(), true) && !Account.needsSignIn(this)) {
            // Right after a live update (Swap): the same screens as before, at once.
            if (Swap.restore(this)) return;
            // Right after an update: back to the chat the user had.
            if (Update.resume(this)) return;
            openLast();
        }
    }

    /** A cold start goes straight back to the workspace used last. */
    private void openLast() {
        String last = Hub.last(this);
        List<Hub> all = Hub.all(this);
        if (last == null && all.size() == 1) last = all.get(0).id;
        if (last != null && Hub.get(this, last) != null) open(last);
    }

    @Override
    protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        handleLink(i, false);
    }

    @Override
    protected void onResume() {
        super.onResume();
        render();
        openPending();
        if (!Account.needsSignIn(this) && !busy) {
            // A newer directory (PCs added, invitations) and token, when due.
            Ui.pool.execute(() -> {
                try { Account.renew(this, false); } catch (Exception ignored) { }
                Ui.main.post(() -> { if (!isFinishing() && !busy) { render(); openPending(); } });
            });
        }
    }

    /** harbor://oauth: the sign-in's answer. harbor://chat/…: a chat another app or a browser
     *  opens (openPending). A pairing link (before 0.85) gets a note. fresh: i started this
     *  screen (onCreate), else it came to the running one (onNewIntent). */
    private boolean handleLink(Intent i, boolean fresh) {
        if (i == null || !Intent.ACTION_VIEW.equals(i.getAction()) || i.getData() == null) return false;
        if ("harbor".equalsIgnoreCase(i.getData().getScheme()) && "chat".equalsIgnoreCase(i.getData().getHost())) {
            ChatLink link = ChatLink.parse(i.getDataString());
            // Another app asks to chat with a chat through the local API (LocalApi): Allow or not.
            if (link != null && link.approve != null) {
                LocalGate.Sources src = launcher(i, fresh);
                setIntent(new Intent(this, Hubs.class));
                LocalApi.ask(this, link.gid, link.approve, src);
                return true;
            }
            String[] app = link == null ? null : referrerApp(i);
            setIntent(new Intent(this, Hubs.class));
            if (link == null) { Ui.toast(this, "That isn't a Harbor chat link"); return false; }
            keepLink(this, i.getDataString(), app);
            openPending();
            return true;
        }
        if (Account.isCallback(i)) {
            Uri u = i.getData();
            setIntent(new Intent(this, Hubs.class));
            busy = true;
            error = null;
            render();
            Ui.pool.execute(() -> {
                String e = null;
                try { Account.finish(this, u); } catch (Exception x) { e = Hub.why(x); }
                final String fe = e;
                Ui.main.post(() -> {
                    busy = false;
                    error = fe;
                    render();
                    List<Hub> all = Hub.all(this);
                    if (fe == null && pending(this)) openPending();
                    else if (fe == null && all.size() == 1 && Account.invites(this).length() == 0) open(all.get(0).id);
                });
            });
            return true;
        }
        if ("harbor".equals(i.getData().getScheme()) && "pair".equals(i.getData().getHost())) {
            Ui.toast(this, "Pairing codes are gone: sign in with Google instead.");
            return true;
        }
        return false;
    }

    private void open(String id) {
        Hub.setLast(this, id);
        // Picked here: this workspace is the phone's own now, not a stand-in for another (Away).
        Away.forget(this, id);
        startActivity(new Intent(this, Chats.class).putExtra("hub", id));
    }

    /** New invitations came (Invites): their cards, unless an answer is on its way. */
    @Override
    void refresh() { if (!busy && !isFinishing()) render(); }

    @Override
    protected void onStop() {
        super.onStop();
        restoring = false;
    }

    private void render() {
        list.removeAllViews();
        if (restoring) return;
        list.addView(Ui.title(this, "Harbor", 44), Ui.margins(Ui.fill(), 4, 24, 4, 8));
        if (Account.needsSignIn(this)) {
            boolean ran = Account.signedIn(this);
            String intro = ran ? "Your sign-in ran out. Sign in again to reach your PCs."
                    : "Your Harbor chats on your phone. Sign in with the Google account you use in Harbor on your PC, or the one a workspace invited.";
            list.addView(Ui.text(this, intro, 17, Ui.G700), Ui.margins(Ui.fill(), 4, 8, 4, 28));
            if (busy) {
                list.addView(Ui.text(this, "Signing in…", 15, Ui.G700), Ui.margins(Ui.fill(), 4, 0, 4, 12));
            } else {
                list.addView(Ui.button(this, "Sign in with Google", true, v -> signIn()), Ui.fill());
            }
            if (error != null) {
                list.addView(Ui.text(this, error, 14, Ui.RED), Ui.margins(Ui.fill(), 4, 14, 4, 0));
                if (!busy) list.addView(Ui.button(this, "Try again", false, v -> signIn()), Ui.margins(Ui.fill(), 0, 10, 0, 0));
            }
            TextView how = Ui.text(this, "No pairing codes: once you're signed in, the PCs of your workspaces show up here and connect directly, encrypted with each PC's own key.", 13, Ui.G700);
            list.addView(how, Ui.margins(Ui.fill(), 4, 24, 4, 0));
            return;
        }
        LinearLayout acct = Ui.cardRow(this, Ui.I_USER, Account.name(this), Account.email(this), Ui.FG, v -> accountMenu());
        acct.addView(Ui.chevron(this));
        LinearLayout ac = Ui.card(this);
        ac.addView(acct, Ui.fill());
        list.addView(ac, Ui.margins(Ui.fill(), 0, 8, 0, 0));
        if (error != null) list.addView(Ui.text(this, error, 14, Ui.RED), Ui.margins(Ui.fill(), 4, 12, 4, 0));
        invitations();
        List<Hub> hubs = Hub.all(this);
        list.addView(Ui.text(this, "Your workspaces", 15, Ui.G700), Ui.margins(Ui.fill(), 6, 20, 6, 8));
        if (hubs.isEmpty()) {
            list.addView(Ui.text(this, busy ? "Looking for your PCs…" : "No PCs in your workspaces yet. Open Harbor 0.85 or newer on a PC and sign in there with this account, or ask whoever invited you to sign in on theirs.", 15, Ui.G700), Ui.margins(Ui.fill(), 6, 0, 6, 16));
            if (!busy) list.addView(Ui.button(this, "Check again", false, v -> recheck()), Ui.fill());
            return;
        }
        LinearLayout c = Ui.card(this);
        boolean first = true;
        for (Hub h : hubs) {
            if (!first) c.addView(Ui.gap(this));
            first = false;
            c.addView(hubRow(h), Ui.fill());
        }
        list.addView(c, Ui.fill());
    }

    /** Invitations waiting for this account: a card each, Accept or Decline (nothing joins
     *  until Accept). */
    private void invitations() {
        org.json.JSONArray inv = Account.invites(this);
        if (inv.length() == 0) return;
        list.addView(Ui.text(this, "Invitations", 15, Ui.G700), Ui.margins(Ui.fill(), 6, 20, 6, 8));
        for (int i = 0; i < inv.length(); i++) {
            JSONObject x = inv.optJSONObject(i);
            if (x == null) continue;
            LinearLayout c = Ui.card(this);
            String ws = x.optString("ws_name").isEmpty() ? "A workspace" : x.optString("ws_name");
            String by = x.optString("inviter_name").isEmpty() ? "" : x.optString("inviter_name") + " invited " + x.optString("email") + ". ";
            c.addView(Ui.cardRow(this, Ui.I_USERS, "Join " + ws + "?", by + "You'd share all of its PCs and chats.", Ui.FG, null), Ui.fill());
            LinearLayout b = Ui.row(this);
            b.setPadding(Ui.dp(14), 0, Ui.dp(14), Ui.dp(14));
            String id = x.optString("id");
            b.addView(Ui.button(this, "Accept", true, v -> answer(id, true)), Ui.weight());
            b.addView(Ui.button(this, "Decline", false, v -> answer(id, false)), Ui.margins(Ui.weight(), 10, 0, 0, 0));
            c.addView(b, Ui.fill());
            list.addView(c, Ui.margins(Ui.fill(), 0, 0, 0, 10));
        }
    }

    private void answer(String id, boolean accept) {
        busy = true;
        render();
        Ui.pool.execute(() -> {
            String e = null, joined = null;
            try { joined = Account.answer(this, id, accept); } catch (Exception x) { e = Hub.why(x); }
            final String fe = e, fj = joined;
            Ui.main.post(() -> {
                busy = false;
                error = fe;
                if (fj != null) Ui.toast(this, "You joined " + fj);
                render();
            });
        });
    }

    /** Sign in: the account sheet answers here; the browser (only where the sheet can't run)
     *  comes back as harbor://oauth. */
    private void signIn() {
        busy = true;
        error = null;
        render();
        Account.start(this, err -> {
            busy = false;
            error = err == null || err.isEmpty() ? null : err;
            render();
            if (err == null) {
                List<Hub> all = Hub.all(this);
                if (pending(this)) openPending();
                else if (all.size() == 1 && Account.invites(this).length() == 0) open(all.get(0).id);
            }
        });
    }

    private void recheck() {
        busy = true;
        render();
        Ui.pool.execute(() -> {
            String e = null;
            try { Account.renew(this, true); } catch (Exception x) { e = Hub.why(x); }
            final String fe = e;
            Ui.main.post(() -> { busy = false; error = fe; render(); openPending(); });
        });
    }

    // ---- chat links from other apps and browsers ----

    /** A chat link waits this long at most for the phone to be ready (signed in, its PCs known),
     *  so a sign-in much later doesn't jump to a chat nobody asked for any more. */
    private static final long PENDING_FOR = 15 * 60_000;

    /** The app that opened link intent `i`, as Android saw it: {name, package}, null when unknown.
     *  Activity.getReferrer() returns what the sender wrote into the intent (EXTRA_REFERRER, which
     *  anyone can set) before what Android knows, so those extras are dropped first. An app that
     *  starts one of ours is visible to us (package visibility), so its name can be read. */
    private String[] referrerApp(Intent i) {
        Intent bare = new Intent(i);
        bare.removeExtra(Intent.EXTRA_REFERRER);
        bare.removeExtra(Intent.EXTRA_REFERRER_NAME);
        setIntent(bare);
        Uri r = getReferrer();
        if (r == null || !"android-app".equals(r.getScheme()) || r.getHost() == null || r.getHost().isEmpty()) return null;
        String pkg = r.getHost();
        if (pkg.equals(getPackageName())) return null;
        String label = "";
        try {
            PackageManager pm = getPackageManager();
            label = String.valueOf(pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)));
        } catch (Exception ignored) { }
        return new String[] { label, pkg };
    }

    /** What Android and the sender say about the app that opened approval link intent `i`
     *  (LocalGate.identify weighs them). Read here, while i is the intent being handled: on a
     *  new intent Android sets the referrer only for the call to onNewIntent. Android leaves the
     *  referrer out when Harbor can't see the launching package (package visibility), as for an
     *  app that starts it with a plain startActivity while Harbor runs; getLaunchedFrom* (14+)
     *  speak of this link only when it started the screen (fresh). */
    private LocalGate.Sources launcher(Intent i, boolean fresh) {
        LocalGate.Sources s = new LocalGate.Sources();
        s.sdk = android.os.Build.VERSION.SDK_INT;
        s.fresh = fresh;
        Object er = i.getParcelableExtra(Intent.EXTRA_REFERRER);
        s.extraReferrer = er instanceof Uri ? er.toString() : null;
        s.extraReferrerName = i.getStringExtra(Intent.EXTRA_REFERRER_NAME);
        if (s.sdk >= 34) {
            s.launchedPkg = getLaunchedFromPackage();
            int uid = getLaunchedFromUid();
            if (uid >= 0) {
                String[] p = getPackageManager().getPackagesForUid(uid);
                if (p != null && p.length == 1) s.launchedUidPkg = p[0];
            }
        }
        // Android 15+: who sent this new intent (ComponentCaller), read before setIntent below
        // replaces it. By reflection: the app compiles against Android 14.
        if (s.sdk >= 35 && !fresh) {
            try {
                Object c = android.app.Activity.class.getMethod("getCurrentCaller").invoke(this);
                if (c != null) {
                    Object pk = c.getClass().getMethod("getPackage").invoke(c);
                    if (pk instanceof String) s.currentPkg = (String) pk;
                    Object uid = c.getClass().getMethod("getUid").invoke(c);
                    if (uid instanceof Integer && (Integer) uid >= 0) {
                        String[] p = getPackageManager().getPackagesForUid((Integer) uid);
                        if (p != null && p.length == 1) s.currentUidPkg = p[0];
                    }
                }
            } catch (Exception | LinkageError e) {
                android.util.Log.i(LocalApi.TAG, "LOCALAPI getCurrentCaller: " + e);
            }
        }
        s.callingPkg = getCallingPackage();
        Intent bare = new Intent(i);
        bare.removeExtra(Intent.EXTRA_REFERRER);
        bare.removeExtra(Intent.EXTRA_REFERRER_NAME);
        setIntent(bare);
        Uri r = getReferrer();
        s.referrer = r == null ? null : r.toString();
        return s;
    }

    /** Keeps link `raw` (and the app that opened it, null unknown) until it can open (openPending takes it). */
    static void keepLink(Context c, String raw, String[] app) {
        Ui.prefs(c).edit().putString("chat_link", raw).putLong("chat_link_at", System.currentTimeMillis())
                .putString("chat_link_app", app == null ? "" : app[0]).putString("chat_link_pkg", app == null ? "" : app[1]).apply();
    }

    /** A chat link is waiting to open. */
    static boolean pending(Context c) {
        android.content.SharedPreferences p = Ui.prefs(c);
        long at = p.getLong("chat_link_at", 0);
        return p.getString("chat_link", null) != null && System.currentTimeMillis() - at < PENDING_FOR;
    }

    /** The waiting chat link, taken (null when none, or it waited too long). */
    private ChatLink takeLink() {
        boolean fresh = pending(this);
        android.content.SharedPreferences p = Ui.prefs(this);
        String url = p.getString("chat_link", null);
        ChatLink l = fresh ? ChatLink.parse(url) : null;
        if (l != null) { l.appLabel = p.getString("chat_link_app", ""); l.appPkg = p.getString("chat_link_pkg", ""); }
        p.edit().remove("chat_link").remove("chat_link_at").remove("chat_link_app").remove("chat_link_pkg").apply();
        return l;
    }

    /** Opens the waiting chat link once the phone can: signed in, with its workspaces' PCs
     *  known. Each workspace is asked where the link leads (GET /v1/chat_link, the PC's own
     *  resolver, as a link in a reply), the one with the link's PC first; the chat opens over
     *  its workspace's chat list, as a tap on the link in a reply opens it. A chat no PC has
     *  opens the app as usual, with the PC's reason in a short notice. */
    private void openPending() {
        if (resolving || busy || Account.needsSignIn(this) || !pending(this)) return;
        List<Hub> hubs = Hub.all(this);
        if (hubs.isEmpty()) return; // kept until the account's PCs show up (onResume's renew)
        ChatLink link = takeLink();
        if (link == null) return;
        resolving = true;
        Ui.pool.execute(() -> {
            List<List<String>> names = new ArrayList<>();
            for (Hub h : hubs) {
                List<String> n = new ArrayList<>();
                n.add(h.pcName);
                synchronized (h.eps) { for (Hub.Ep e : h.eps) n.add(e.label()); }
                names.add(n);
            }
            List<Integer> order = ChatLink.order(names, link.pc);
            Hub found = null, down = null;
            String chat = null, missing = null;
            for (int idx : order) {
                Hub h = hubs.get(idx);
                try {
                    JSONObject r = h.call("GET", "/v1/chat_link?url=" + URLEncoder.encode(link.url(), "UTF-8"), null, 10_000);
                    String to = r.isNull("chat") ? "" : r.optString("chat", "");
                    if (!to.isEmpty()) { found = h; chat = to; break; }
                    if (missing == null) missing = r.optString("missing", "");
                } catch (Hub.ApiError e) {
                    // A PC before 0.192 has no /v1/chat_link: its chat list says whether the chat is there.
                    if (e.code != 404) { if (missing == null) missing = e.getMessage(); continue; }
                    try {
                        JSONObject c = Hub.chat(h.state(), link.gid);
                        if (c != null) { found = h; chat = c.optString("id", link.gid); break; }
                    } catch (IOException ignored) { if (down == null) down = h; }
                } catch (IOException e) {
                    if (down == null) down = h;
                }
            }
            // No PC answered at all: the chat opens where it most likely is, and loads once its
            // PC answers (Chat says when it's gone).
            boolean guessed = false;
            if (found == null && missing == null && down != null && (down == hubs.get(order.get(0)))) { found = down; chat = link.gid; guessed = true; }
            // The link's context (untrusted, from whichever app opened it) goes to the chat's PC, which
            // shows it folded and gives it to the agent with the user's next message; only to a chat
            // that's there.
            String note = null;
            if (link.contextError != null) note = "The link's context was left out: " + ("too long".equals(link.contextError) ? "it's over 4 KB" : "it couldn't be read");
            else if (link.context != null && found != null && guessed) note = "The link's context wasn't passed on: no PC answered";
            else if (link.context != null && found != null) {
                try {
                    JSONObject body = new JSONObject().put("text", link.context).put("from", link.from)
                            .put("app", link.appPkg.isEmpty() ? JSONObject.NULL : new JSONObject().put("label", link.appLabel).put("package", link.appPkg));
                    found.call("POST", "/v1/chats/" + chat + "/context", body, 15_000);
                } catch (Hub.ApiError e) {
                    note = "no such call".equals(e.getMessage()) ? "The link's context wasn't passed on: update Harbor on that PC"
                            : "The link's context wasn't passed on: " + e.getMessage();
                } catch (Exception e) {
                    note = "The link's context wasn't passed on: " + Hub.why(e);
                }
            }
            final Hub fh = found; final String fc = chat; final String fnote = note;
            final String why = missing == null || missing.isEmpty() ? "Chat not found" : missing;
            Ui.main.post(() -> {
                resolving = false;
                if (isFinishing() || isDestroyed()) return;
                if (fh == null) {
                    Ui.toast(this, why);
                    openLast();
                    return;
                }
                open(fh.id);
                Chat.open(this, fh, fc);
                if (fnote != null) Ui.toast(this, fnote);
            });
        });
    }

    /** The account: sign out (switching accounts is sign out, sign in). */
    private void accountMenu() {
        Ui.dialog(this).setTitle(Account.name(this))
                .setMessage(Account.email(this) + "\n\nSigning out forgets your PCs on this phone; they stop taking it. To use another Google account, sign out and sign in again.")
                .setNegativeButton("Cancel", null)
                .setNeutralButton("Refresh", (d, w) -> recheck())
                .setPositiveButton("Sign out", (d, w) -> { Account.signOut(this); error = null; render(); })
                .show();
    }

    private View hubRow(Hub h) {
        View dot = Ui.dot(this, Ui.G500, 10);
        JSONObject w = Account.workspace(this, Account.wsOf(h) == null ? "" : Account.wsOf(h));
        JSONArray pcs = w == null ? null : w.optJSONArray("pcs");
        int n = pcs == null ? 1 + h.eps.size() : pcs.length();
        LinearLayout r = Ui.cardRow(this, Ui.I_USERS, h.label(), n + (n == 1 ? " PC" : " PCs"), Ui.FG, v -> open(h.id));
        r.addView(dot, Ui.margins(new LinearLayout.LayoutParams(Ui.dp(10), Ui.dp(10)), 8, 0, 8, 0));
        r.addView(Ui.chevron(this));
        TextView sub = (TextView) ((LinearLayout) r.getChildAt(1)).getChildAt(1);
        r.setOnLongClickListener(v -> {
            startActivity(new Intent(this, Settings.class).putExtra("hub", h.id));
            return true;
        });
        Ui.pool.execute(() -> {
            String s; int color;
            try {
                JSONObject st = h.state();
                String via = h.viaName();
                s = n + (n == 1 ? " PC" : " PCs") + " · " + (via.isEmpty() ? st.optString("hub_name", h.labelOn("")) : via) + " answers";
                // Its owner doesn't let this account start chats there (guest.ts): it reads only.
                JSONObject g = st.optJSONObject("guest");
                if (g != null && !g.optBoolean("start", true)) s += " · you can't start chats there";
                color = Ui.GREEN;
            } catch (Exception e) {
                s = h.whyDown(e);
                color = Ui.RED;
            }
            final String fs = s; final int fc = color;
            Ui.main.post(() -> {
                sub.setText(fs);
                dot.setBackground(Ui.round(fc, 0, 5));
            });
        });
        return r;
    }
}
