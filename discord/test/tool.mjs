// SPDX-License-Identifier: GPL-3.0-or-later
// One call as an agent makes it, through `harbor app discord`: node tool.mjs <harbor> tool <name> [json]
// `status` and `signout` ask the host directly.
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
const [harbor, what, name, json] = process.argv.slice(2);
const sock = path.join(process.env.XDG_DATA_HOME, "harbor/apps/discord/h.sock");
if (what !== "tool") {
    const s = net.connect(sock);
    let b = "";
    s.on("data", d => b += d);
    s.on("end", () => { console.log(JSON.stringify(JSON.parse(b).result ?? JSON.parse(b), null, 1)); });
    s.on("error", () => console.log("The host isn't running: nothing has started or it has gone idle."));
    s.write(JSON.stringify({ op: what }) + "\n");
} else {
    const c = spawn(harbor, ["app", "discord"], { stdio: ["pipe", "pipe", "inherit"] });
    let b = "";
    const t0 = Date.now();
    c.stdout.on("data", d => {
        b += d;
        let i;
        while ((i = b.indexOf("\n")) >= 0) {
            const m = JSON.parse(b.slice(0, i));
            b = b.slice(i + 1);
            if (m.id !== 2) continue;
            for (const p of m.result.content) console.log(p.text ?? `[${p.type} ${p.data?.length ?? 0} base64 chars]`);
            console.error(`(${Date.now() - t0} ms${m.result.isError ? ", error" : ""})`);
            c.kill();
        }
    });
    const send = (id, method, params) => c.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    send(1, "initialize", {});
    send(2, "tools/call", { name, arguments: JSON.parse(json ?? "{}") });
}
