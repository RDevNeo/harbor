// SPDX-License-Identifier: GPL-3.0-or-later
// Stands in for Vencord's renderer in tests: a webpack made of the fake page's stores, and a
// fetch that answers Discord's API without any network. Nothing here reaches discord.com.
(() => {
    const rig = location.origin;
    const report = (kind, data) => navigator.sendBeacon(rig + "/rig/" + kind, JSON.stringify(data ?? {}));
    const mods = () => window.FAKE?.mods ?? [];
    const flavour = /*FLAVOUR*/ "good";
    const hide = flavour === "bad" ? ["getChannelId"] : [];
    const hasAll = (m, props) => props.every(p => !hide.includes(p) && m && p in m);
    window.Vencord = {
        Plugins: {},
        Webpack: {
            get wreq() { return window.FAKE ? { m: window.FAKE.sources, c: {} } : undefined; },
            findByProps: (...p) => mods().find(m => hasAll(m, p)),
            findByCode: (...c) => window.FAKE?.CloudUpload,
            find: f => mods().find(m => { try { return f(m); } catch { return false; } }),
            findAll: f => mods().filter(m => { try { return f(m); } catch { return false; } }),
        },
    };
    const realFetch = window.fetch;
    window.fetch = async (url, init = {}) => {
        const u = new URL(url, location.href);
        if (u.origin === rig) return realFetch(url, init);
        const body = await window.FAKE.rest(init.method ?? "GET", u.pathname, u.searchParams, init);
        report("rest", { method: init.method ?? "GET", path: u.pathname, super: !!init.headers?.["x-super-properties"] });
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    };
})();
