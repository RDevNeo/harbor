package dev.harbor.app;

import android.accounts.Account;
import android.accounts.AccountManager;
import android.accounts.OperationCanceledException;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.widget.LinearLayout;

import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.Scope;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;

/** Gmail for the agents on a PC, from the phone (Settings › Apps; hub `/v1/apps/gmail`,
 *  android/PROTOCOL.md): the PC's connected Google accounts, the default one, sign-out, and
 *  adding one. Adding: the sheet Harbor's own sign-in uses (Credential Manager, GooglePicker,
 *  Android 14+; before that, or when it can't run, AccountManager's chooser) picks the account;
 *  Google's AuthorizationClient then shows Google's native consent and gives a one-time server
 *  code for the PC's Web client, which the PC exchanges for a refresh token of its own: agents
 *  run there, so the tokens live there. If that fails, AccountManager asks for the same code
 *  (`oauth2:server:client_id:…`). Only when both fail, or the PC has no Web client, Google's
 *  page opens in a Custom Tab and comes back to a loopback port on this phone, whose code the
 *  PC exchanges; why it did shows in the sheet (`note`). */
final class Gmail {
    static final int PICK = 0x6a1, CONSENT = 0x6a2;
    static final String SCOPES = "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.settings.basic";
    private static Sheet sheet;
    /** Runs when the sheet closes (Settings updates its row). */
    static Runnable changed;
    /** How a browser sign-in ended while the app wasn't in front (Android drops toasts then):
     *  said once any screen is back (Base.onResume). */
    private static volatile String outcome;

    /** Why the last Add account didn't go the native way: logged, and shown in the sheet. */
    private static void note(Activity a, String why) {
        android.util.Log.w("HarborGmail", why);
        Ui.prefs(a).edit().putString("gmail_why", why).apply();
    }

    private static void say(Activity a, String msg) {
        if (Base.resumed > 0) Ui.toast(a.getApplicationContext(), msg);
        else outcome = msg;
    }

    static void sayPending(Activity a) {
        String o = outcome;
        if (o == null) return;
        outcome = null;
        Ui.toast(a, o);
    }
    /** The PC an account is being picked for (the chooser's result comes back to Settings). */
    private static Hub picking;
    private static String pickingClient;
    private static Account pickingAccount;

    /** The row's subtitle: "Not connected", the address, or "3 accounts". */
    static String summary(JSONObject r) {
        JSONArray acc = r.optJSONArray("accounts");
        int n = acc == null ? 0 : acc.length();
        if (n == 0) return "Not connected: agents on this PC can't use Gmail";
        if (n == 1) return acc.optJSONObject(0).optString("email");
        return n + " accounts";
    }

    static void show(Activity a, Hub hub) {
        Ui.bg(a, () -> hub.get("/v1/apps/gmail"), r -> render(a, hub, r));
    }

    private static void render(Activity a, Hub hub, JSONObject r) {
        if (sheet != null) sheet.dismiss();
        Sheet s = new Sheet(a, "Gmail");
        sheet = s;
        JSONArray acc = r.optJSONArray("accounts");
        int n = acc == null ? 0 : acc.length();
        s.body.addView(Ui.text(a, "Agents on " + hub.label() + " can read, send and sort the mail of these Google accounts, only when you ask them to. The sign-in stays on the PC.", 14, Ui.G700),
                Ui.margins(Ui.fill(), 6, 0, 6, 12));
        if (n > 0) {
            LinearLayout c = s.card();
            for (int i = 0; i < n; i++) {
                JSONObject o = acc.optJSONObject(i);
                if (o == null) continue;
                String email = o.optString("email");
                boolean def = o.optBoolean("default");
                if (c.getChildCount() > 0) c.addView(Ui.gap(a));
                LinearLayout row = Ui.cardRow(a, Ui.I_USER, email, def ? (n > 1 ? "Default: agents use it unless they name another" : "Connected") : "Tap to make it the default",
                        Ui.FG, def ? null : v -> post(a, hub, "default", email));
                row.addView(Ui.button(a, "Sign out", false, v -> confirmOut(a, hub, email)));
                Ui.wrapSub(row, 2);
                c.addView(row, Ui.fill());
            }
        }
        boolean nativeOk = !r.isNull("web_client_id") && !r.optString("web_client_id").isEmpty();
        boolean browserOk = r.optBoolean("browser");
        LinearLayout add = s.card();
        if (nativeOk || browserOk) {
            LinearLayout ar = Ui.cardRow(a, Ui.I_PLUS, n == 0 ? "Connect a Google account" : "Add another account",
                    nativeOk ? "Pick it from your phone's accounts" : "Sign in with Google in the browser", Ui.FG, v -> add(a, hub, r));
            ar.addView(Ui.chevron(a));
            add.addView(ar, Ui.fill());
            add.addView(Ui.text(a, "Google may say it hasn't verified Harbor: tap Advanced, then Go to Harbor.", 13, Ui.G700), Ui.margins(Ui.fill(), 16, 2, 16, 12));
        } else {
            add.addView(Ui.cardRow(a, Ui.I_ALERT, "Connect from the PC", "This PC's Harbor has no Google client to sign in with: connect Gmail in Settings › Integrations there.", Ui.FG, null), Ui.fill());
        }
        String why = Ui.prefs(a).getString("gmail_why", "");
        if (!why.isEmpty()) s.body.addView(Ui.text(a, "Last try: " + why, 12, Ui.G700), Ui.margins(Ui.fill(), 6, 0, 6, 8));
        s.dialog.setOnDismissListener(d -> { if (changed != null) changed.run(); });
        s.show();
    }

    private static void confirmOut(Activity a, Hub hub, String email) {
        Ui.dialog(a).setTitle("Sign " + email + " out?")
                .setMessage("Agents on " + hub.label() + " lose its mail, and Google forgets Harbor's access.")
                .setPositiveButton("Sign out", (d, w) -> post(a, hub, "signout", email))
                .setNegativeButton("Cancel", null).show();
    }

    private static void post(Activity a, Hub hub, String action, String email) {
        Ui.bg(a, () -> hub.call("POST", "/v1/apps/gmail/" + action, new JSONObject().put("email", email)), r -> render(a, hub, r));
    }

    private static void add(Activity a, Hub hub, JSONObject r) {
        String web = r.isNull("web_client_id") ? "" : r.optString("web_client_id");
        Ui.prefs(a).edit().remove("gmail_why").apply();
        if (web.isEmpty()) {
            note(a, "this PC's Harbor has no Web client, so the browser");
            browser(a, hub, null);
        } else if (android.os.Build.VERSION.SDK_INT >= 34) {
            sheet(a, hub, web);
        } else {
            chooser(a, hub, web);
        }
    }

    /** Harbor's sign-in sheet: every Google account on the phone. Where it can't run, Android's
     *  own chooser: still native. */
    private static void sheet(Activity a, Hub hub, String web) {
        byte[] n = new byte[16];
        new java.security.SecureRandom().nextBytes(n);
        String nonce = android.util.Base64.encodeToString(n, android.util.Base64.URL_SAFE | android.util.Base64.NO_PADDING | android.util.Base64.NO_WRAP);
        GooglePicker.pick(a, web, nonce, new GooglePicker.Result() {
            @Override public void token(String idToken) {
                String email = emailOf(idToken);
                if (!email.isEmpty()) { authorize(a, hub, web, email); return; }
                note(a, "the sheet gave no address");
                chooser(a, hub, web);
            }
            @Override public void browser(String why) {
                note(a, "the account sheet failed: " + why);
                chooser(a, hub, web);
            }
            @Override public void canceled() { }
        });
    }

    private static void chooser(Activity a, Hub hub, String web) {
        picking = hub;
        pickingClient = web;
        Intent i = AccountManager.newChooseAccountIntent(null, null, new String[] {"com.google"}, null, null, null, null);
        try {
            a.startActivityForResult(i, PICK);
        } catch (Exception e) {
            note(a, "Android's chooser failed: " + e);
            browser(a, hub, null);
        }
    }

    /** Google's native authorization for the picked account: its consent screen when needed
     *  (forceCodeForRefreshToken: the PC always gets a refresh token), then the server code. */
    private static void authorize(Activity a, Hub hub, String web, String email) {
        Account acct = new Account(email, "com.google");
        try {
            AuthorizationRequest req = AuthorizationRequest.builder()
                    .setRequestedScopes(java.util.Arrays.asList(new Scope(SCOPES.split(" ")[0]), new Scope(SCOPES.split(" ")[1])))
                    .requestOfflineAccess(web, true)
                    .setAccount(acct)
                    .build();
            Identity.getAuthorizationClient(a.getApplicationContext()).authorize(req)
                    // Not the Activity overloads: they need AndroidX fragments, which the app doesn't carry.
                    .addOnSuccessListener(r -> {
                        if (a.isFinishing() || a.isDestroyed()) return;
                        if (r.hasResolution() && r.getPendingIntent() != null) {
                            picking = hub;
                            pickingClient = web;
                            pickingAccount = acct;
                            try {
                                a.startIntentSenderForResult(r.getPendingIntent().getIntentSender(), CONSENT, null, 0, 0, 0);
                            } catch (Exception e) {
                                note(a, "Google's consent didn't open: " + e);
                                code(a, hub, web, acct);
                            }
                        } else {
                            authorized(a, hub, web, acct, r.getServerAuthCode());
                        }
                    })
                    .addOnFailureListener(e -> {
                        if (a.isFinishing() || a.isDestroyed()) return;
                        note(a, "Google's authorization failed: " + e);
                        code(a, hub, web, acct);
                    });
        } catch (Exception | LinkageError e) {
            note(a, "Google's authorization isn't available: " + e);
            code(a, hub, web, acct);
        }
    }

    private static void authorized(Activity a, Hub hub, String web, Account acct, String code) {
        if (code == null || code.isEmpty()) {
            note(a, "Google's authorization gave no code");
            code(a, hub, web, acct);
        } else {
            send(a, hub, acct.name, code);
        }
    }

    /** The PC exchanges the one-time code for its own tokens. */
    private static void send(Activity a, Hub hub, String name, String code) {
        Ui.toast(a, "Connecting " + name + "…");
        Ui.bg(a, () -> hub.call("POST", "/v1/apps/gmail/code", new JSONObject().put("code", code), 60_000), r -> {
            Ui.toast(a, "Gmail connected: " + r.optString("email", name));
            render(a, hub, r);
        });
    }

    /** The `email` claim of a Google ID token (only a hint here: the PC checks what Google says). */
    static String emailOf(String idToken) {
        try {
            String[] p = idToken.split("\\.");
            byte[] b = android.util.Base64.decode(p[1], android.util.Base64.URL_SAFE | android.util.Base64.NO_PADDING | android.util.Base64.NO_WRAP);
            return new JSONObject(new String(b, StandardCharsets.UTF_8)).optString("email");
        } catch (Exception e) {
            return "";
        }
    }

    /** From the activity's onActivityResult: true when it was the chooser's or Google's consent. */
    static boolean result(Activity a, int req, int res, Intent data) {
        if (req != PICK && req != CONSENT) return false;
        Hub hub = picking;
        String web = pickingClient;
        Account acct = pickingAccount;
        picking = null;
        pickingAccount = null;
        if (hub == null || res != Activity.RESULT_OK) return true;
        if (req == PICK) {
            String name = data == null ? null : data.getStringExtra(AccountManager.KEY_ACCOUNT_NAME);
            if (name != null) authorize(a, hub, web, name);
            return true;
        }
        try {
            authorized(a, hub, web, acct, Identity.getAuthorizationClient(a.getApplicationContext()).getAuthorizationResultFromIntent(data).getServerAuthCode());
        } catch (Exception e) {
            note(a, "Google's consent failed: " + e);
            code(a, hub, web, acct);
        }
        return true;
    }

    /** The same one-time code through AccountManager (Android itself doesn't ask that the account
     *  was shown to Harbor; its Google authenticator decides); with the activity, Google's consent
     *  shows first when needed. Any failure: Google's page, the last resort. */
    private static void code(Activity a, Hub hub, String web, Account acct) {
        AccountManager am = AccountManager.get(a);
        String name = acct.name;
        String type = "oauth2:server:client_id:" + web + ":api_scope:" + SCOPES;
        try {
            am.getAuthToken(acct, type, null, a, f -> {
                String code;
                try {
                    Bundle b = f.getResult();
                    code = b.getString(AccountManager.KEY_AUTHTOKEN);
                } catch (OperationCanceledException e) {
                    return;
                } catch (Exception e) {
                    note(a, "Android's token request failed too: " + e);
                    browser(a, hub, name);
                    return;
                }
                if (code == null || code.isEmpty()) {
                    note(a, "Android's token request gave no code");
                    browser(a, hub, name);
                    return;
                }
                // A code works once: never let Android hand out this one again.
                am.invalidateAuthToken("com.google", code);
                send(a, hub, name, code);
            }, null);
        } catch (Exception e) {
            note(a, "Android's token request failed too: " + e);
            browser(a, hub, name);
        }
    }

    /** Google's page in a Custom Tab, back to a port on this phone's loopback; `hint`: the
     *  account picked already, if any. */
    private static void browser(Activity a, Hub hub, String hint) {
        Ui.pool.execute(() -> {
            try {
                ServerSocket ss = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"));
                ss.setSoTimeout(15 * 60_000);
                String redirect = "http://127.0.0.1:" + ss.getLocalPort() + "/";
                JSONObject st = hub.call("POST", "/v1/apps/gmail/start", new JSONObject().put("redirect_uri", redirect));
                String url = st.getString("url");
                // Without select_account, or Google shows its chooser whatever the hint says.
                if (hint != null) url = url.replace("select_account%20consent", "consent") + "&login_hint=" + Uri.encode(hint);
                String go = url;
                Ui.main.post(() -> open(a, go));
                String[] got = waitCode(ss);
                if (got == null) return;
                if (!st.getString("state").equals(got[1])) throw new java.io.IOException("Sign-in failed: state mismatch");
                JSONObject r = hub.call("POST", "/v1/apps/gmail/finish", new JSONObject().put("state", got[1]).put("code", got[0]), 60_000);
                Ui.main.post(() -> {
                    say(a, "Gmail connected: " + r.optString("email"));
                    if (!a.isFinishing() && !a.isDestroyed()) render(a, hub, r);
                });
            } catch (Exception e) {
                Ui.main.post(() -> say(a, "Gmail: " + Hub.why(e)));
            }
        });
    }

    private static void open(Activity a, String url) {
        // A Custom Tab without androidx.browser, as Account.browser does it.
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE);
        Bundle tab = new Bundle();
        tab.putBinder("android.support.customtabs.extra.SESSION", null);
        i.putExtras(tab);
        i.putExtra("android.support.customtabs.extra.TOOLBAR_COLOR", Ui.BG);
        try {
            a.startActivity(i);
        } catch (Exception e) {
            Ui.toast(a, "No browser to sign in with.");
        }
    }

    /** The browser's one visit to the loopback port: {code, state}, or null (an error, cancelled). */
    private static String[] waitCode(ServerSocket ss) throws Exception {
        try (ServerSocket server = ss) {
            while (true) {
                try (Socket s = server.accept()) {
                    s.setSoTimeout(5000);
                    String line = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8)).readLine();
                    String target = line == null ? "" : line.split(" ").length > 1 ? line.split(" ")[1] : "";
                    int q = target.indexOf('?');
                    if (q < 0) { reply(s.getOutputStream(), 404, ""); continue; }
                    String code = null, state = null, error = null;
                    for (String kv : target.substring(q + 1).split("&")) {
                        int e = kv.indexOf('=');
                        if (e < 0) continue;
                        String k = kv.substring(0, e), v = URLDecoder.decode(kv.substring(e + 1), "UTF-8");
                        if (k.equals("code")) code = v;
                        else if (k.equals("state")) state = v;
                        else if (k.equals("error")) error = v;
                    }
                    boolean ok = code != null && state != null;
                    reply(s.getOutputStream(), 200, ok ? "Done. Go back to Harbor: it's connecting the account." : "Sign-in didn't finish" + (error == null ? "" : " (" + error + ")") + ". Go back to Harbor and try again.");
                    return ok ? new String[] {code, state} : null;
                }
            }
        }
    }

    private static void reply(OutputStream o, int status, String msg) throws Exception {
        String html = "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><title>Harbor</title>"
                + "<body style='font:17px system-ui;padding:32px;background:#faf9f5;color:#141413'>" + msg.replace("<", "&lt;") + "</body>";
        byte[] b = html.getBytes(StandardCharsets.UTF_8);
        o.write(("HTTP/1.1 " + status + " OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: " + b.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
        o.write(b);
        o.flush();
    }
}
