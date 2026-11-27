package dev.harbor.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.Dialog;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

import java.util.Collections;
import java.util.HashSet;
import java.util.Set;

/** Discord's captcha for Persons (a friend request, a message Discord held), solved on the phone:
 *  a full-screen dialog over the chat with the PC's page (the captcha's `html`: hCaptcha's own
 *  widget with Discord's sitekey and rqdata) in a WebView based at its `url`, https://discord.com/…
 *  (hCaptcha takes Discord's sitekey only there). The token goes back to the PC (POST
 *  chat/:id/captcha), which sends the held request again with it. The person solves it; nothing
 *  here answers it. "Don't add" / "Don't send", the X or Back gives it up. When the page can't
 *  load (no WebView, hCaptcha unreachable), it's given up and the old advice shows: do it in
 *  Discord's app. A dialog, not a screen of its own: no new APK needed. */
final class PersonsCaptcha {
    /** Captchas already brought up (their ids): a chat read again doesn't bring one up twice. */
    static final Set<String> shown = Collections.synchronizedSet(new HashSet<>());

    private final Activity a;
    private final Hub hub;
    private final String path, section, who;
    private JSONObject cap;
    private Dialog d;
    private WebView web;
    private TextView status;
    /** The answer is on its way or it's given up: nothing else goes. */
    private boolean done;

    /** Brings the captcha up over `a` unless it already was. `path`: the chat's route (…/chat/:id). */
    static void open(Activity a, Hub hub, String path, String section, JSONObject captcha, String who) {
        if (hub == null || captcha == null || a.isFinishing() || !shown.add(captcha.optString("id"))) return;
        new PersonsCaptcha(a, hub, path, section, captcha, who).show();
    }

    private PersonsCaptcha(Activity a, Hub hub, String path, String section, JSONObject cap, String who) {
        this.a = a;
        this.hub = hub;
        this.path = path;
        this.section = section;
        this.cap = cap;
        this.who = who == null || who.isEmpty() ? "them" : who;
    }

    private boolean friend() { return "friend".equals(cap.optString("what")); }

    private void show() {
        d = new Dialog(a, android.R.style.Theme_Black_NoTitleBar);
        android.view.Window win = d.getWindow();
        if (win != null) {
            win.setStatusBarColor(Ui.BG);
            win.setNavigationBarColor(Ui.BG);
            win.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
        LinearLayout col = Ui.col(a);
        col.setBackgroundColor(Ui.BG);
        col.setPadding(Ui.dp(16), Ui.dp(8), Ui.dp(16), Ui.dp(16));
        LinearLayout top = Ui.row(a);
        top.addView(Ui.title(a, "Discord needs a captcha", 22), Ui.weight());
        top.addView(Ui.iconButton(a, Ui.I_X, Ui.FG, v -> giveUp()));
        col.addView(top, Ui.margins(Ui.fill(), 4, 0, 0, 6));
        col.addView(Ui.text(a, (friend() ? "To add " + who + " as a friend" : "To send your message to " + who)
            + ", Discord wants a person to solve this. Hub never answers it for you.", 15, Ui.G700), Ui.margins(Ui.fill(), 4, 0, 4, 10));
        status = Ui.text(a, "Loading the captcha…", 13, Ui.G700);
        col.addView(status, Ui.margins(Ui.fill(), 4, 0, 4, 8));
        try {
            web = page();
        } catch (Throwable t) {
            // no WebView on this phone (it's being updated, or turned off)
            failed();
            return;
        }
        col.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
        col.addView(Ui.button(a, friend() ? "Don't add" : "Don't send", false, v -> giveUp()), Ui.margins(Ui.fill(), 0, 12, 0, 0));
        d.setContentView(col);
        d.setOnCancelListener(x -> giveUp());
        d.setOnDismissListener(x -> {
            if (web != null) {
                web.removeJavascriptInterface("hubCaptcha");
                web.destroy();
                web = null;
            }
        });
        d.show();
        load();
    }

    @SuppressLint({ "SetJavaScriptEnabled", "AddJavascriptInterface" })
    private WebView page() {
        WebView w = new WebView(a);
        w.setBackgroundColor(0xff000000);
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        // Only the captcha: the page never goes anywhere else (hCaptcha's own frames load inside it).
        w.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) { return true; }
        });
        w.addJavascriptInterface(new Bridge(), "hubCaptcha");
        return w;
    }

    private void load() {
        if (web != null) web.loadDataWithBaseURL(cap.optString("url", "https://discord.com/hub-captcha"), cap.optString("html"), "text/html", "utf-8", null);
    }

    /** What the page says (on WebView's thread). */
    private final class Bridge {
        @JavascriptInterface public void ready(String v) {
            Ui.main.post(() -> { if (!done) status.setVisibility(View.GONE); });
        }
        @JavascriptInterface public void solved(String token) {
            Ui.main.post(() -> answer(token));
        }
        @JavascriptInterface public void error(String why) {
            // hCaptcha's errors once it's up (a network blip, a closed challenge) leave it there to try again
            Ui.main.post(() -> { if (!done && status.getVisibility() == View.VISIBLE) failed(); });
        }
    }

    private JSONObject body() {
        JSONObject b = PersonsUi.put(new JSONObject(), "section", section);
        PersonsUi.put(b, "account", cap.optString("account"));
        return PersonsUi.put(b, "id", cap.optString("id"));
    }

    private void answer(String token) {
        if (done || token == null || token.isEmpty()) return;
        done = true;
        status.setText(friend() ? "Sending the friend request…" : "Sending…");
        status.setVisibility(View.VISIBLE);
        JSONObject b = PersonsUi.put(body(), "key", token);
        Ui.bg(a, () -> {
            try { return hub.call("POST", path + "/captcha", b, 90_000); }
            catch (Exception e) { return PersonsUi.put(PersonsUi.put(new JSONObject(), "ok", false), "error", Hub.why(e)); }
        }, r -> {
            JSONObject again = r.optJSONObject("captcha");
            if (again != null && web != null) {
                // Discord wants another one (the answer was stale): the new one, here
                shown.add(again.optString("id"));
                cap = again;
                done = false;
                status.setText("Discord asked again: solve this one");
                load();
                return;
            }
            if (!r.optBoolean("ok", false)) Ui.toast(a, r.optString("error", friend() ? "The friend request didn't go" : "Not sent"));
            else if (friend()) Ui.toast(a, "Friend request sent");
            close();
        });
    }

    private void close() {
        try { d.dismiss(); } catch (Exception ignored) { }
    }

    /** Gives it up: the PC drops the held request. */
    private void giveUp() {
        if (!done) {
            done = true;
            cancelOnPc();
        }
        close();
    }

    private void failed() {
        if (done) return;
        done = true;
        cancelOnPc();
        Ui.toast(a, friend() ? "Discord asked for a captcha. Add them from the Discord app." : "Discord asked for a captcha. Send this one from the Discord app.");
        close();
    }

    private void cancelOnPc() {
        JSONObject b = PersonsUi.put(body(), "cancel", true);
        Ui.pool.execute(() -> { try { hub.call("POST", path + "/captcha", b); } catch (Exception ignored) { } });
    }
}
