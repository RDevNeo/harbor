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
// Harbor's captcha view (on unless the user turned it off). hCaptcha's frame is another site, and
// an offscreen page doesn't route input past its top frame into another site's process, so the
// view needs site isolation off. What makes that safe enough: the page may only ever hold frames
// from Discord and hCaptcha (`frameAllowed` below), so the only other site sharing the session's
// process is hCaptcha, which Discord itself embeds for its captchas.
const captchaView = cfg.mode === "run" && cfg.captchaView === true;
if (captchaView) app.commandLine.appendSwitch("disable-site-isolation-trials");

/** Where the page itself may go: Discord's own app (and a rig's fake one). */
const DISCORD_HOSTS = ["discord.com", "discordapp.com"];
/** What may be framed inside it besides Discord: hCaptcha (Discord's captchas, newassets.hcaptcha.com). */
const FRAME_HOSTS = [...DISCORD_HOSTS, "hcaptcha.com"];
const ownOrigin = (() => { try { return cfg.url ? new URL(cfg.url).origin : null; } catch { return null; } })();
const extraFrames = new Set((cfg.frames ?? []).map(String));
const hostIn = (host, list) => list.some(h => host === h || host.endsWith("." + h));
/** For the log: which site, never the rest of the address. */
const siteOf = url => { try { return new URL(url).host || new URL(url).protocol; } catch { return "?"; } };
function pageAllowed(url) {
    try {
        const u = new URL(url);
        if (u.origin === ownOrigin) return true;
        return u.protocol === "https:" && hostIn(u.hostname, DISCORD_HOSTS);
    } catch { return false; }
}
function frameAllowed(url) {
    if (url === "about:blank" || url === "about:srcdoc") return true;
    try {
        const u = new URL(url);
        if (u.protocol === "blob:") return frameAllowed(new URL(u.pathname).origin);
        if (u.origin === ownOrigin || extraFrames.has(u.origin)) return true;
        return u.protocol === "https:" && hostIn(u.hostname, FRAME_HOSTS);
    } catch { return false; }
}

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
        w.webContents.on("paint", (_e, dirty, image) => { if (w === win) painted(dirty, image); });
    }
    w.webContents.setUserAgent(UA);
    w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    // The page stays on Discord, and its frames on Discord and hCaptcha (the request filter in
    // whenReady catches the same frames by their requests, redirects included).
    const guard = what => (e, url, _inPlace, main) => {
        const u = e.url ?? url, top = e.isMainFrame ?? main ?? true;
        if (top ? pageAllowed(u) : frameAllowed(u)) return;
        log("blocked " + what + ": " + siteOf(u));
        e.preventDefault();
    };
    w.webContents.on("will-navigate", guard("a navigation"));
    w.webContents.on("will-frame-navigate", guard("a frame"));
    w.webContents.on("will-redirect", guard("a redirect"));
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

/** The page paints at 1 fps while idle; tools that read the page need it to keep up, and a
 * channel opening takes longer than a moment. */
let calm, calls = 0;
function fast() {
    if (!win?.webContents.isOffscreen()) return false;
    win.webContents.setFrameRate(BUSY_FPS);
    clearTimeout(calm);
    return true;
}
function busy() {
    if (fast() && !calls && !solving) calm = setTimeout(() => { if (win && !win.isDestroyed()) win.webContents.setFrameRate(IDLE_FPS); }, 3000);
}
/** Full speed for the length of a call. A waitForMessage only waits, for up to 10 minutes. */
async function during(name, run) {
    if (name === "discord_waitForMessage") return run();
    calls++;
    fast();
    try {
        return await run();
    } finally {
        calls--;
        busy();
    }
}

/** A captcha only a person may solve, on the hidden page: Harbor's window shows its frames, and
 * that person's pointer goes through, but only onto the captcha itself and only while one is
 * showing. Nothing here clicks by itself. */
let solving = false, solveRect = null, solveAt = 0, pressed = false;

/* A chat's card sees the captcha live: every paint that touches it is a new frame (`seq`), and a
 * card's request waits for the next one (`after`) instead of asking on a timer. Frames are cut
 * from the paint itself (no capture), encoded once per size, and nothing is sent when nothing
 * changed. While a captcha shows the page draws at SOLVE_FPS. */
const SOLVE_FPS = 30;
const live = { seq: 0, image: null, wake: [], encoded: null };
const cropOf = r => {
    if (!r) return null;
    const pad = 24;
    const x = Math.max(0, r.x - pad), y = Math.max(0, r.y - pad);
    return { x, y, width: Math.min(WIDTH - x, r.width + 2 * pad), height: Math.min(HEIGHT - y, r.height + 2 * pad) };
};
const meets = (a, b) => !!a && !!b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
function painted(dirty, image) {
    if (!solving) return;
    live.image = image;
    if (!meets(dirty, cropOf(solveRect)) && live.seq > 0) return;
    live.seq++;
    for (const w of live.wake.splice(0)) w();
}
/** The captcha's part of the newest paint, at most `max` wide; the same seq and size are encoded once. */
function liveFrame(crop, max) {
    const key = `${live.seq}:${max}:${crop.x},${crop.y},${crop.width},${crop.height}`;
    if (live.encoded?.key === key) return live.encoded.frame;
    let img = live.image.crop(crop);
    let { width, height } = img.getSize();
    if (max > 0 && width > max) {
        img = img.resize({ width: max, quality: "good" });
        ({ width, height } = img.getSize());
    }
    const frame = { width, height, data: img.toJPEG(70).toString("base64") };
    live.encoded = { key, frame };
    return frame;
}
async function captchaLook() {
    const s = await run("$harbor.captcha()");
    solveRect = s.showing ? s.rect : null;
    solveAt = Date.now();
    return s;
}
const inside = (r, x, y) => !!r && x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;
const viewOnly = f => async m => {
    if (!captchaView) throw new Error("Harbor's captcha view is off.");
    return f(m);
};
const captchaOps = {
    captcha: captchaLook,
    // The whole page (the overlay), or with `crop` only the captcha and a margin around it, at
    // most `max` pixels wide: what a chat's card shows, over the mesh or to a phone.
    captcha_frame: viewOnly(async m => {
        const s = await captchaLook();
        if (!s.showing) return s;
        solving = true;
        fast();
        // A card that has seen frame `after` waits here for the next one (or says nothing changed).
        if (m?.crop && s.rect && Number.isInteger(m.after)) {
            win.webContents.setFrameRate(SOLVE_FPS);
            const crop = cropOf(s.rect);
            if (live.seq <= m.after || !live.image) {
                if (!live.image) win.webContents.invalidate();
                const wait = Math.min(Math.max(Number(m.wait) || 2000, 100), 8000);
                await new Promise(r => { const t = setTimeout(r, wait); live.wake.push(() => { clearTimeout(t); r(); }); });
            }
            if (!live.image || live.seq <= m.after) return { ...s, crop, seq: live.seq, same: true };
            const max = Number(m.max) > 0 ? Math.floor(Number(m.max)) : 0;
            return { ...s, crop, seq: live.seq, mimeType: "image/jpeg", ...liveFrame(crop, max) };
        }
        let crop;
        if (m?.crop && s.rect) {
            const pad = 24;
            const x = Math.max(0, s.rect.x - pad), y = Math.max(0, s.rect.y - pad);
            crop = { x, y, width: Math.min(WIDTH - x, s.rect.width + 2 * pad), height: Math.min(HEIGHT - y, s.rect.height + 2 * pad) };
        }
        let img = await win.webContents.capturePage(crop, { stayHidden: true });
        let { width, height } = img.getSize();
        if (width < 1 || height < 1) throw new Error("capturePage returned an empty image");
        const max = Number(m?.max) > 0 ? Math.floor(Number(m.max)) : 0;
        if (max > 0 && width > max) {
            img = img.resize({ width: max, quality: "good" });
            ({ width, height } = img.getSize());
        }
        return { ...s, width, height, crop: crop ?? { x: 0, y: 0, width: WIDTH, height: HEIGHT }, mimeType: "image/jpeg", data: img.toJPEG(crop ? 75 : 80).toString("base64") };
    }),
    captcha_input: viewOnly(async m => {
        const x = Math.round(Number(m.x)), y = Math.round(Number(m.y));
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("no position");
        // The captcha moves (its challenge opens beside the checkbox): a look that's old is looked again.
        if (Date.now() - solveAt > 1000) await captchaLook();
        const releasing = m.kind === "up" && pressed;
        if (!releasing && !inside(solveRect, x, y)) return { taken: false };
        const wc = win.webContents;
        switch (m.kind) {
            case "move": wc.sendInputEvent({ type: "mouseMove", x, y }); break;
            case "down": pressed = true; wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 }); break;
            case "up": pressed = false; wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 }); break;
            case "wheel": wc.sendInputEvent({ type: "mouseWheel", x, y, deltaX: 0, deltaY: -Math.round(Number(m.dy) || 0), canScroll: true }); break;
            default: throw new Error("no such input: " + m.kind);
        }
        return { taken: true };
    }),
    // Discord's own way out of its captcha dialog; the join it held fails.
    captcha_cancel: viewOnly(async () => {
        // A click on the captcha leaves the keyboard in its frame, where Discord's dialog never hears the key.
        await run("document.activeElement?.blur?.(); window.focus(); true").catch(() => {});
        win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    }),
    captcha_end: async () => {
        solving = false;
        live.image = null;
        live.encoded = null;
        for (const w of live.wake.splice(0)) w();
        solveRect = null;
        pressed = false;
        busy();
        await run("$harbor.captchaDone()");
    },
};

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
        await ops.flush();
    } catch { /* quitting anyway */ }
    app.exit(0);
}

const scratch = cfg.mode === "scratch" ? require("./scratch.js") : null;

const ops = {
    call: m => during(m.name, () => run(`$harbor.call(${JSON.stringify(m.name)}, ${JSON.stringify(m.args ?? {})})`)),
    rect: m => { busy(); return run(`$harbor.elementRect(${JSON.stringify(m.selector)})`); },
    capture,
    selftest: () => run("$harbor.selftest()"),
    state: () => run("$harbor.state()"),
    inject,
    logout: () => run("$harbor.logout()"),
    // Before a freeze: a frozen client can be lost with the PC.
    flush: async () => {
        await session.defaultSession.flushStorageData();
        await session.defaultSession.cookies.flushStore();
    },
    thawed: () => { busy(); return run("$harbor.thawed()"); },
    settled: () => run("$harbor.settled()"),
    gateway: () => run("$harbor.gateway()"),
    ...captchaOps,
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
    // Every frame request (a frame's page, or a redirect of one) is checked against the list.
    session.defaultSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (d, done) => {
        const frame = d.resourceType === "subFrame" || d.resourceType === "mainFrame";
        const ok = !frame || (d.resourceType === "mainFrame" ? pageAllowed(d.url) : frameAllowed(d.url));
        if (!ok) log("blocked a frame request: " + siteOf(d.url));
        done({ cancel: !ok });
    });
    process.env.VENCORD_USER_DATA_DIR = cfg.data;
    if (cfg.vencord) require(path.join(cfg.vencord, "vencordDesktopMain.js"));
    session.defaultSession.setUserAgent(UA);
    scratch?.init(() => win, run);
    open(true);
    if (cfg.mode === "signin") watchSignin();
    if (cfg.mode === "run") watchSession();
    send({ ev: "started", electron: process.versions.electron });
});
