// Persons' Discord session helper: a tiny Electron main script, run with Hub's pinned Electron as a
// short-lived process of its own (no UI of Hub's). It opens Discord's web app on one connection's
// persistent session (Person Hub's partitions: persist:discord, persist:discord-spokpay,
// persist:conn-<id>), reads the session's token from the page's own API requests (or its
// localStorage), writes ONE JSON line on stdout and quits:
//   token mode   (hidden window)  {token, superProps, locale, timezone} | {signedOut:true} | {error}
//   signin mode  (shown window)   {token, superProps, locale, timezone} | {cancelled:true} | {error}
//   signout mode (no window)      {ok:true} | {error}   (clears the session's storage)
// Args: --user-data DIR --partition NAME --mode token|signin|signout [--app-name NAME]
// The token goes to stdout only (a pipe to Hub): never to stderr, a log or a file.
"use strict";
const { app, BrowserWindow, Menu, session } = require("electron");
const fs = require("fs");

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const userData = arg("user-data");
const partition = arg("partition");
const mode = arg("mode") || "token";
const appName = arg("app-name");
// A rig's fake Discord; the real one otherwise.
const ORIGIN = (process.env.PERSONS_DISCORD_ORIGIN || "https://discord.com").replace(/\/$/, "");
const originUrl = new URL(ORIGIN);
const HOSTS = ["discord.com", "discordapp.com", "discord.gg", "hcaptcha.com", "discord.new"];
const LIMIT_MS = mode === "signin" ? 14 * 60_000 : 80_000;

let done = false;
function finish(o) {
  if (done) return;
  done = true;
  try {
    fs.writeSync(1, JSON.stringify(o) + "\n");
  } catch {
    // Hub is gone: nothing to tell
  }
  void flushAndQuit();
}
async function flushAndQuit() {
  try {
    const ses = session.fromPartition(partition);
    await ses.flushStorageData?.();
    await ses.cookies.flushStore();
  } catch {
    // quitting anyway
  }
  app.exit(0);
}

if (!userData || !partition || !["token", "signin", "signout"].includes(mode)) {
  fs.writeSync(1, JSON.stringify({ error: "usage: --user-data DIR --partition NAME --mode token|signin|signout" }) + "\n");
  process.exit(2);
}
if (appName) app.setName(appName);
app.setPath("userData", userData);
app.setPath("sessionData", userData);
if (!app.requestSingleInstanceLock()) {
  fs.writeSync(1, JSON.stringify({ error: "This Discord session is busy" }) + "\n");
  app.exit(3);
}
if (mode !== "signin") app.disableHardwareAcceleration();
Menu.setApplicationMenu(null);
app.on("window-all-closed", () => {
  if (!done) finish(mode === "signin" ? { cancelled: true } : { error: "The Discord page closed" });
});
setTimeout(() => finish({ error: "Discord didn't answer in time" }), LIMIT_MS);

const pageAllowed = (url) => {
  try {
    const u = new URL(url);
    if (u.host === originUrl.host) return true;
    return u.protocol === "https:" && HOSTS.some((h) => u.hostname === h || u.hostname.endsWith("." + h));
  } catch {
    return url === "about:blank";
  }
};

app.whenReady().then(async () => {
  const ses = session.fromPartition(partition);
  if (mode === "signout") {
    try {
      await ses.clearStorageData();
      await ses.clearCache();
      finish({ ok: true });
    } catch (e) {
      finish({ error: String(e?.message || e) });
    }
    return;
  }

  const chrome = String(process.versions.chrome || "140").split(".")[0];
  ses.setUserAgent(`Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome}.0.0.0 Safari/537.36`);
  ses.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === "clipboard-sanitized-write"));

  let token = null;
  let tokenAt = 0;
  const client = { superProps: null, locale: null, timezone: null };
  const result = () => ({ token, ...client });
  // With the token known, wait a little for the client headers (they come with the page's API calls).
  function maybeDone() {
    if (!token || done) return;
    if (client.superProps || Date.now() - tokenAt > 8000) finish(result());
  }
  const setToken = (t) => {
    if (!t || token === t) return;
    token = t;
    tokenAt = Date.now();
    setTimeout(maybeDone, 8100);
    maybeDone();
  };

  // The page's own API calls carry its token and client headers.
  ses.webRequest.onBeforeSendHeaders({ urls: [`${originUrl.protocol}//${originUrl.hostname}/api/*`] }, (d, cb) => {
    try {
      const h = {};
      for (const [k, v] of Object.entries(d.requestHeaders)) h[k.toLowerCase()] = v;
      if (h["x-super-properties"]) {
        client.superProps = h["x-super-properties"];
        client.locale = h["x-discord-locale"] || client.locale;
        client.timezone = h["x-discord-timezone"] || client.timezone;
      }
      if (h.authorization && !/^\/(login|register)/.test(pagePath())) setToken(h.authorization);
      maybeDone();
    } catch {
      // never block the page
    }
    cb({ requestHeaders: d.requestHeaders });
  });

  const win = new BrowserWindow({
    width: 1040,
    height: 780,
    show: mode === "signin",
    title: "Sign in to Discord · Hub",
    autoHideMenuBar: true,
    backgroundColor: "#1e1f22",
    webPreferences: { partition, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false },
  });
  const wc = win.webContents;
  const pagePath = () => {
    try {
      return new URL(wc.getURL()).pathname;
    } catch {
      return "";
    }
  };
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("will-navigate", (e, url) => {
    if (!pageAllowed(url)) e.preventDefault();
  });
  wc.on("will-redirect", (e, url) => {
    if (!pageAllowed(url)) e.preventDefault();
  });
  win.on("page-title-updated", (e) => e.preventDefault());
  wc.on("render-process-gone", () => {
    if (!done) setTimeout(() => void win.loadURL(ORIGIN + "/app").catch(() => {}), 3000);
  });

  let reading = false;
  async function onPage() {
    if (done || win.isDestroyed()) return;
    if (!wc.getURL().startsWith(ORIGIN)) return;
    if (/^\/(login|register)/.test(pagePath())) {
      if (mode === "token") finish({ signedOut: true });
      return;
    }
    if (token || reading) return;
    reading = true;
    try {
      // The token is in the page's localStorage; the isolated world can read it (the page's own
      // world hides localStorage). Retried for a while: the client writes it right after a login.
      for (let i = 0; i < 20 && !token && !done && !win.isDestroyed(); i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (token || done || win.isDestroyed()) break;
        if (/^\/(login|register)/.test(pagePath())) {
          if (mode === "token") finish({ signedOut: true });
          return;
        }
        try {
          const raw = await wc.executeJavaScriptInIsolatedWorld(1717, [{ code: 'try { localStorage.getItem("token") } catch (e) { null }' }]);
          if (raw) setToken(JSON.parse(raw));
        } catch {
          // between loads
        }
      }
      if (!token && mode === "token" && !done) finish({ signedOut: true });
    } finally {
      reading = false;
    }
  }
  wc.on("did-navigate", () => void onPage());
  wc.on("did-navigate-in-page", () => void onPage());
  wc.on("did-finish-load", () => void onPage());

  void win.loadURL(ORIGIN + (mode === "signin" ? "/login" : "/app")).catch(() => {});
  if (mode === "signin") {
    win.show();
    win.focus();
  }
});
