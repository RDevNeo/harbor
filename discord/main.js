// SPDX-License-Identifier: GPL-3.0-or-later
// Harbor's Discord shell: one hidden, offscreen Discord page, driven over stdin/stdout by Harbor
// (JSON lines). It has no window, tray or UI of its own; a real window opens only when someone
// signs in with a password or has to solve a captcha. All the tool code is page/harbor.js:
// this file only hosts the page, so another engine could replace it.
const { app, BrowserWindow, Menu, ipcMain, session } = require("electron");
const fs = require("fs");
const path = require("path");

// mode "run": the signed-in page. "signin": the login page. "scratch": a throwaway logged-out page
// for repair. data: profile folder. page: the tool script. vencord: its files. url: page to load.
const cfg = JSON.parse(process.env.HARBOR_DISCORD || "{}");
delete process.env.HARBOR_DISCORD;
const WIDTH = 1280, HEIGHT = 720;
const IDLE_FPS = 1, BUSY_FPS = 15;
/** The QR socket gave up: no new code this long after it closed. */
const QR_STALE_MS = 20_000;

const send = o => fs.writeSync(1, JSON.stringify(o) + "\n");
const log = (...a) => process.stderr.write(a.join(" ") + "\n");

app.setPath("userData", cfg.data);
app.setPath("sessionData", cfg.data);
if (!app.requestSingleInstanceLock()) {
    send({ ev: "fatal", error: "Discord is already running on this profile" });
    app.exit(3);
}
Menu.setApplicationMenu(null);

const vencordFile = f => fs.readFileSync(path.join(cfg.vencord, f), "utf8");
const watchQr = cfg.mode !== "run";
ipcMain.on("harbor-cfg", e => { e.returnValue = { vencord: !!cfg.vencord, watchQr }; });
ipcMain.on("harbor-vencord", (e, f) => { e.returnValue = vencordFile(f); });

const UA = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome.split(".")[0]}.0.0.0 Safari/537.36`;
const pageUrl = cfg.url || (cfg.mode === "run" ? "https://discord.com/app" : "https://discord.com/login");

let win = null;
let shown = false;

function open(offscreen) {
    const w = new BrowserWindow({
        width: WIDTH,
        height: HEIGHT,
        show: !offscreen,
        title: "Sign in to Discord",
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false,
            offscreen,
            spellcheck: false,
            // Never a debugger on this session: opening DevTools makes Discord hide the token.
            devTools: false,
        },
    });
    if (offscreen) {
        w.webContents.setFrameRate(IDLE_FPS);
        w.webContents.on("paint", () => {});
    }
    w.webContents.setUserAgent(UA);
    w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const wc = w.webContents;
    wc.on("did-finish-load", () => { if (w === win) loaded(); });
    wc.on("did-fail-load", (_e, code, desc, _url, main) => {
        if (main && code !== -3 && w === win) {
            log("load failed:", desc);
            setTimeout(() => { if (w === win && !w.isDestroyed()) w.loadURL(pageUrl).catch(() => {}); }, 2000);
        }
    });
    wc.on("render-process-gone", (_e, d) => {
        log("renderer gone:", d.reason);
        if (w === win) setTimeout(() => { if (!w.isDestroyed()) w.loadURL(pageUrl).catch(() => {}); }, 2000);
    });
    w.on("closed", () => {
        if (w === win) {
            win = null;
            if (shown) send({ ev: "window-closed" });
        }
    });
    win = w;
    w.loadURL(pageUrl).catch(() => {});
    return w;
}

const run = code => win.webContents.executeJavaScript(code, true);

/** Puts the tool script in the page: at every load, and after repair changes it. */
async function inject() {
    await run(fs.readFileSync(cfg.page, "utf8"));
}

let loads = 0;
async function loaded() {
    const load = ++loads;
    try {
        await inject();
        for (let i = 0; i < 240 && load === loads; i++) {
            if (await run("!!window.$harbor?.ready()")) {
                send({ ev: "ready", state: await run("$harbor.state()") });
                return;
            }
            await sleep(250);
        }
        if (load === loads) send({ ev: "not-ready" });
    } catch (e) {
        if (load === loads) send({ ev: "not-ready", error: String(e) });
    }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** The page paints at 1 fps while idle; tools that read the page need it to keep up. */
let calm;
function busy() {
    if (!win?.webContents.isOffscreen()) return;
    win.webContents.setFrameRate(BUSY_FPS);
    clearTimeout(calm);
    calm = setTimeout(() => { if (win && !win.isDestroyed()) win.webContents.setFrameRate(IDLE_FPS); }, 3000);
}

/** What the login page shows, for Harbor's own sign-in card. */
function watchSignin() {
    let last = "", qr = "";
    const tick = async () => {
        if (!win || win.isDestroyed()) return;
        try {
            const s = await run(`(() => {
                const q = window.$harborQr ?? {};
                const st = window.$harbor?.state?.() ?? {};
                return { ...st, fingerprint: q.fingerprint, stale: q.closed != null && Date.now() - q.closedAt > ${QR_STALE_MS} };
            })()`);
            if (s.user) {
                send({ ev: "signed-in", user: s.user });
                return;
            }
            // Past its second expiry the page stops asking for new codes.
            if (s.stale && !s.scanned && !shown) {
                log("QR stopped rotating; reloading the login page");
                win.loadURL(pageUrl).catch(() => {});
            }
            const url = s.fingerprint ? "https://discord.com/ra/" + s.fingerprint : "";
            if (url !== qr) {
                qr = url;
                send({ ev: "qr", url });
            }
            const now = JSON.stringify([!!s.scanned, !!s.captcha]);
            if (now !== last) {
                last = now;
                send({ ev: "login-page", scanned: !!s.scanned, captcha: !!s.captcha });
            }
        } catch { /* the page is between loads */ }
        setTimeout(tick, 1000);
    };
    tick();
}

/** Discord ended this session (the page fell back to the login form). */
function watchSession() {
    setInterval(async () => {
        try {
            if (win && !win.isDestroyed() && await run(`location.pathname.startsWith("/login")`)) send({ ev: "signed-out" });
        } catch { /* between loads */ }
    }, 30_000);
}

async function capture(opts) {
    const wc = win.webContents;
    busy();
    wc.invalidate();
    await sleep(350);
    let img = await wc.capturePage(opts.rect, { stayHidden: true });
    let { width, height } = img.getSize();
    if (width < 1 || height < 1) throw new Error("capturePage returned an empty image");
    const max = opts.maxWidth > 0 ? Math.floor(opts.maxWidth) : 1280;
    if (width > max) {
        img = img.resize({ width: max, quality: "better" });
        ({ width, height } = img.getSize());
    }
    const jpeg = opts.format !== "png";
    const buf = jpeg ? img.toJPEG(Math.min(100, Math.max(1, Math.floor(opts.quality ?? 70)))) : img.toPNG();
    return { data: buf.toString("base64"), mimeType: jpeg ? "image/jpeg" : "image/png", width, height, bytes: buf.length };
}

async function quit() {
    // A hard kill can lose the newest writes to the profile, the session among them.
    try {
        await session.defaultSession.flushStorageData();
        await session.defaultSession.cookies.flushStore();
    } catch { /* quitting anyway */ }
    app.exit(0);
}

const scratch = cfg.mode === "scratch" ? require("./scratch.js") : null;

const ops = {
    call: m => { busy(); return run(`$harbor.call(${JSON.stringify(m.name)}, ${JSON.stringify(m.args ?? {})})`); },
    rect: m => { busy(); return run(`$harbor.elementRect(${JSON.stringify(m.selector)})`); },
    capture,
    selftest: () => run("$harbor.selftest()"),
    state: () => run("$harbor.state()"),
    inject,
    logout: () => run("$harbor.logout()"),
    // The real window, on the same session; the hidden page goes.
    show: () => {
        const old = win;
        shown = true;
        win = null;
        open(false);
        old?.destroy();
    },
    quit,
};

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", d => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) handle(JSON.parse(line));
    }
});
// Harbor went away: nobody can use this page any more.
process.stdin.on("end", quit);

async function handle(m) {
    try {
        const op = ops[m.op] ?? scratch?.ops[m.op];
        if (!op) throw new Error("no such op: " + m.op);
        send({ id: m.id, ok: true, result: await op(m) ?? null });
    } catch (e) {
        send({ id: m.id, ok: false, error: String(e?.message ?? e) });
    }
}

app.on("window-all-closed", () => {});
app.whenReady().then(() => {
    process.env.VENCORD_USER_DATA_DIR = cfg.data;
    if (cfg.vencord) require(path.join(cfg.vencord, "vencordDesktopMain.js"));
    session.defaultSession.setUserAgent(UA);
    scratch?.init(() => win, run);
    open(true);
    if (cfg.mode === "signin") watchSignin();
    if (cfg.mode === "run") watchSession();
    send({ ev: "started", electron: process.versions.electron });
});
