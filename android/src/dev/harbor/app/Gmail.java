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
 *  adding one. Adding uses Android's own account sheet: AccountManager's chooser, then a
 *  one-time server code for the PC's Web client (`oauth2:server:client_id:…`), which the PC
 *  exchanges for a refresh token of its own: agents run there, so the tokens live there.
 *  Framework APIs only (the app has no Play libraries). Where that can't work (the PC has no
 *  Web client, no Google account on the phone, Google refuses), Google's page opens in a Custom
 *  Tab instead and comes back to a loopback port on this phone, whose code the PC exchanges. */
final class Gmail {
    static final int PICK = 0x6a1;
    static final String SCOPES = "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.settings.basic";
    private static Sheet sheet;
    /** Runs when the sheet closes (Settings updates its row). */
    static Runnable changed;
    /** The PC an account is being picked for (the chooser's result comes back to Settings). */
    private static Hub picking;
    private static String pickingClient;

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
        if (web.isEmpty()) {
            browser(a, hub, null);
            return;
        }
        picking = hub;
        pickingClient = web;
        Intent i = AccountManager.newChooseAccountIntent(null, null, new String[] {"com.google"}, null, null, null, null);
        try {
            a.startActivityForResult(i, PICK);
        } catch (Exception e) {
            browser(a, hub, null);
        }
    }

    /** From the activity's onActivityResult: true when it was the account chooser's. */
    static boolean result(Activity a, int req, int res, Intent data) {
        if (req != PICK) return false;
        Hub hub = picking;
        String web = pickingClient;
        picking = null;
        String name = data == null ? null : data.getStringExtra(AccountManager.KEY_ACCOUNT_NAME);
        if (res != Activity.RESULT_OK || hub == null || name == null) return true;
        AccountManager am = AccountManager.get(a);
        Account acct = new Account(name, "com.google");
        // A one-time code for the PC's Web client; with the activity, Android shows Google's own
        // consent screen first when needed.
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
                    browser(a, hub, name);
                    return;
                }
                if (code == null || code.isEmpty()) { browser(a, hub, name); return; }
                // A code works once: never let Android hand out this one again.
                am.invalidateAuthToken("com.google", code);
                Ui.toast(a, "Connecting " + name + "…");
                String once = code;
                Ui.bg(a, () -> hub.call("POST", "/v1/apps/gmail/code", new JSONObject().put("code", once), 60_000), r -> {
                    Ui.toast(a, "Gmail connected: " + r.optString("email", name));
                    render(a, hub, r);
                });
            }, null);
        } catch (Exception e) {
            browser(a, hub, name);
        }
        return true;
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
                if (hint != null) url += "&login_hint=" + Uri.encode(hint);
                String go = url;
                Ui.main.post(() -> open(a, go));
                String[] got = waitCode(ss);
                if (got == null) return;
                if (!st.getString("state").equals(got[1])) throw new java.io.IOException("Sign-in failed: state mismatch");
                JSONObject r = hub.call("POST", "/v1/apps/gmail/finish", new JSONObject().put("state", got[1]).put("code", got[0]), 60_000);
                Ui.main.post(() -> {
                    Ui.toast(a, "Gmail connected: " + r.optString("email"));
                    if (!a.isFinishing() && !a.isDestroyed()) render(a, hub, r);
                });
            } catch (Exception e) {
                Ui.main.post(() -> Ui.toast(a, Hub.why(e)));
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
