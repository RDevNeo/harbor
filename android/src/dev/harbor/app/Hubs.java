package dev.harbor.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.List;

/** The start screen: "Sign in with Google" until this phone is signed in (Account), then the
 *  account's workspaces, each with its PCs (one Hub per workspace). The browser comes back
 *  here after the sign-in (harbor://oauth). There's no pairing: a PC shows up once its owner
 *  signed in on it, in a workspace this account is in. */
public class Hubs extends Base {
    private LinearLayout list;
    private boolean busy;
    private String error;

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

        if (b == null && !handleLink(getIntent()) && !Account.needsSignIn(this)) {
            // Right after an update: back to the chat the user had.
            if (Update.resume(this)) return;
            // A cold start goes straight back to the workspace used last.
            String last = Hub.last(this);
            List<Hub> all = Hub.all(this);
            if (last == null && all.size() == 1) last = all.get(0).id;
            if (last != null && Hub.get(this, last) != null) open(last);
        }
    }

    @Override
    protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        handleLink(i);
    }

    @Override
    protected void onResume() {
        super.onResume();
        render();
        if (!Account.needsSignIn(this) && !busy) {
            // A newer directory (PCs added, invitations) and token, when due.
            Ui.pool.execute(() -> {
                try { Account.renew(this, false); } catch (Exception ignored) { }
                Ui.main.post(() -> { if (!isFinishing() && !busy) render(); });
            });
        }
    }

    /** harbor://oauth: the sign-in's answer. A pairing link (before 0.85) gets a note. */
    private boolean handleLink(Intent i) {
        if (i == null || !Intent.ACTION_VIEW.equals(i.getAction()) || i.getData() == null) return false;
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
                    if (fe == null && all.size() == 1 && Account.invites(this).length() == 0) open(all.get(0).id);
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
        startActivity(new Intent(this, Chats.class).putExtra("hub", id));
    }

    private void render() {
        list.removeAllViews();
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
                if (all.size() == 1 && Account.invites(this).length() == 0) open(all.get(0).id);
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
            Ui.main.post(() -> { busy = false; error = fe; render(); });
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
