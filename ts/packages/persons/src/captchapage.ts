// The page a person solves Discord's captcha on, in Hub: hCaptcha's own widget with the sitekey and rqdata Discord
// answered with, the way Discord's client renders it. It must load as https://discord.com/… (hCaptcha only takes
// Discord's sitekey on Discord's host): the desktop serves it to a hidden Chromium under that address, the phone's
// WebView loads it with that base URL. Nothing here answers the captcha: the token comes from the person's solve.
// The page tells its host through `hubCaptchaReady("1")` once the widget is drawn, `hubCaptchaSolved(token)` when the
// person solved it and `hubCaptchaError(code)` when hCaptcha can't load or errors: CDP bindings on the desktop, the
// phone's JS interface `window.hubCaptcha` (its `ready`, `solved`, `error`).

/** The address the page is served under (desktop) or based at (phone). */
export const CAPTCHA_PAGE_URL = "https://discord.com/hub-captcha";

/** What Discord answered with (captcha_sitekey, captcha_rqdata): enough to draw the widget. */
export interface CaptchaPageAsk {
  sitekey: string;
  rqdata?: string | null;
}

/** JSON inside a <script>: no `</script>` or `<!--` can close it. */
const js = (v: unknown): string => JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

/** The page's HTML: black, the widget in the middle, dark theme. */
export function captchaPage(ask: CaptchaPageAsk): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Captcha</title>
<style>
html,body{margin:0;background:#000;color:#d2d2d2;font:14px system-ui,sans-serif}
#box{display:flex;flex-direction:column;align-items:center;padding-top:24px;min-height:100vh;box-sizing:border-box}
#note{margin-top:14px;font-size:13px;color:#8a8a8a}
</style></head>
<body><div id="box"><div id="w"></div><div id="note">Loading…</div></div>
<script>
(function(){
  var ask = ${js({ sitekey: ask.sitekey, rqdata: ask.rqdata ?? null })};
  function tell(name, v){
    try {
      if (window.hubCaptcha && window.hubCaptcha[name]) return window.hubCaptcha[name](String(v));
      var f = window["hubCaptcha" + name.charAt(0).toUpperCase() + name.slice(1)];
      if (typeof f === "function") f(String(v));
    } catch (e) {}
  }
  window.hubLoad = function(){
    try {
      var id = hcaptcha.render("w", {
        sitekey: ask.sitekey,
        theme: "dark",
        callback: function(t){ document.getElementById("note").textContent = "Solved"; tell("solved", t); },
        "expired-callback": function(){ document.getElementById("note").textContent = "It expired: solve it again"; },
        "error-callback": function(e){ tell("error", e || "error"); }
      });
      if (ask.rqdata) hcaptcha.setData(id, { rqdata: ask.rqdata });
      document.getElementById("note").textContent = "";
      tell("ready", "1");
    } catch (e) { tell("error", "render: " + (e && e.message || e)); }
  };
  var s = document.createElement("script");
  s.src = "https://js.hcaptcha.com/1/api.js?render=explicit&onload=hubLoad&recaptchacompat=off";
  s.async = true;
  s.onerror = function(){ tell("error", "hCaptcha didn't load"); };
  document.head.appendChild(s);
})();
</script></body></html>`;
}
