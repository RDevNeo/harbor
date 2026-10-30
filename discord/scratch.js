// SPDX-License-Identifier: GPL-3.0-or-later
// The low-level tools repair uses (eval, click, key, query, findModule). They only exist in
// scratch mode: a separate process with its own throwaway profile, on the logged-out login page.
// That page has all of Discord's code and none of the user's account, so what runs here can't
// read a message or send anything. main.js loads this file in no other mode.
let win, run;

function init(getWin, runner) {
    win = getWin;
    run = runner;
}

const clip = (s, n) => (s.length > n ? s.slice(0, n) + `…[+${s.length - n} chars]` : s);

const ops = {
    eval: async m => clip(JSON.stringify(await run(`(async () => { ${/\breturn\b/.test(m.code) ? m.code : "return (" + m.code + "\n)"} })()`)) ?? "undefined", 60_000),
    query: m => run(`[...document.querySelectorAll(${JSON.stringify(m.selector)})].slice(0, ${Math.min(m.limit ?? 20, 100)})
        .map(e => ({ tag: e.tagName.toLowerCase(), id: e.id || undefined, classes: [...e.classList], html: e.outerHTML.slice(0, 500) }))`),
    click: async m => {
        const r = await run(`(() => { const e = document.querySelectorAll(${JSON.stringify(m.selector)})[${m.index ?? 0}]; if (!e) return null;
            const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
        if (!r) throw new Error("selector matched nothing");
        const wc = win().webContents;
        const at = { x: Math.round(r.x), y: Math.round(r.y), button: "left", clickCount: 1 };
        wc.sendInputEvent({ type: "mouseDown", ...at });
        wc.sendInputEvent({ type: "mouseUp", ...at });
    },
    key: m => { const wc = win().webContents; for (const type of ["keyDown", "char", "keyUp"]) wc.sendInputEvent({ type, keyCode: m.key }); },
    // By property names, or by text in a module's source; matches come back as ids and export names.
    findModule: m => run(`(() => {
        const W = Vencord.Webpack, props = ${JSON.stringify(m.props ?? [])}, code = ${JSON.stringify(m.code ?? [])}, out = [];
        const has = e => e && (typeof e === "object" || typeof e === "function") && props.every(p => { try { return p in e; } catch { return false; } });
        for (const id of Object.keys(W.wreq.m)) {
            if (code.length && !code.every(c => String(W.wreq.m[id]).includes(c))) continue;
            let exp = W.wreq.c[id]?.exports, names = [];
            if (props.length) {
                if (!exp) continue;
                const hit = has(exp) ? exp : Object.values(exp).find(has) ?? (has(exp.default) ? exp.default : null);
                if (!hit) continue;
                names = Object.keys(hit).slice(0, 60);
            } else if (exp) names = Object.keys(exp).slice(0, 60);
            out.push({ id, exports: names });
            if (out.length >= 25) break;
        }
        return out;
    })()`),
    moduleSource: m => run(`(() => {
        const src = String(Vencord.Webpack.wreq.m[${JSON.stringify(m.moduleId)}] ?? "");
        const at = ${m.around ? `Math.max(0, src.indexOf(${JSON.stringify(m.around)}) - 1500)` : "0"};
        return { length: src.length, from: at, source: src.slice(at, at + 6000) };
    })()`),
};

module.exports = { init, ops };
