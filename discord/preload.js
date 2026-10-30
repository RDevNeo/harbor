// SPDX-License-Identifier: GPL-3.0-or-later
// Runs in the Discord page before Discord's code, sandboxed: stock Vencord, and on the login page
// a listener on Discord's own QR socket. Nothing here touches Discord's code.
const { contextBridge, ipcRenderer, webFrame } = require("electron");

const cfg = ipcRenderer.sendSync("harbor-cfg");

if (cfg.watchQr) webFrame.executeJavaScript(`(() => {
    const W = window.WebSocket;
    window.$harborQr = { at: 0, opens: 0 };
    window.WebSocket = new Proxy(W, { construct(t, a) {
        const ws = new t(...a);
        if (String(a[0]).includes("remote-auth")) {
            $harborQr.opens++;
            $harborQr.closed = null;
            ws.addEventListener("message", ev => { try {
                const m = JSON.parse(ev.data);
                if (m.op === "pending_remote_init") { $harborQr.fingerprint = m.fingerprint; $harborQr.at = Date.now(); }
            } catch {} });
            ws.addEventListener("close", ev => { $harborQr.closed = ev.code; $harborQr.closedAt = Date.now(); });
        }
        return ws;
    } });
})()`);

if (cfg.vencord) {
    // Vencord's Vesktop build asks for these two; Vesktop itself isn't here.
    contextBridge.exposeInMainWorld("VesktopNative", { app: { getVersion: () => "0.0.0", isOutdated: async () => false } });
    Function("require", "process", ipcRenderer.sendSync("harbor-vencord", "vencordDesktopPreload.js"))(require, process);
    webFrame.executeJavaScript(ipcRenderer.sendSync("harbor-vencord", "vencordDesktopRenderer.js"));
}
