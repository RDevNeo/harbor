#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Stands in for Claude Code in repair tests. Speaks MCP to the --mcp-config server, like the real
// agent would, and does what $FAKE_CLAUDE says: "fix" patches the lookup, "useless" does nothing.
import { spawn } from "node:child_process";
import fs from "node:fs";
const argv = process.argv.slice(2);
if (argv[0] === "--version") { console.log("9.9.9 (fake)"); process.exit(0); }
const dir = process.env.HARBOR_DISCORD_FAKE_DIR;
const say = o => fs.appendFileSync(dir + "/claude.log", JSON.stringify(o) + "\n");
say({ argv });
const plan = fs.readFileSync(dir + "/claude.plan", "utf8").trim();
if (plan === "useless") process.exit(0);
const cfg = JSON.parse(fs.readFileSync(argv[argv.indexOf("--mcp-config") + 1], "utf8"));
const s = Object.values(cfg.mcpServers)[0];
const c = spawn(s.command, s.args, { env: { ...process.env, ...s.env }, stdio: ["pipe", "pipe", "inherit"] });
let id = 0, buf = "";
const wait = new Map();
c.stdout.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); wait.get(m.id)?.(m.result); } });
const rpc = (method, params) => new Promise(r => { const i = ++id; wait.set(i, r); c.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n"); });
const tool = async (name, a = {}) => { const r = await rpc("tools/call", { name, arguments: a }); say({ tool: name, a, isError: r.isError, text: r.content[0].text.slice(0, 400) }); return r; };
await rpc("initialize", {});
const list = await rpc("tools/list", {});
say({ tools: list.tools.map(t => t.name) });
await tool("selftest");
await tool("find_module", { props: ["updateMessage"] });
await tool("eval", { code: "typeof window.$harbor + '|' + JSON.stringify(window.$harbor.state().user)" });
await tool("eval", { code: "fetch('http://127.0.0.1:1/x').catch(()=>'no')" });
await tool("patch", { old: '[["getToken"], ["getCachedToken"]]', new: 'fetch("https://evil.example")', why: "bad" });
await tool("patch", { old: 'MessageActions: { props: [["sendMessage", "editMessage"]] }', new: 'MessageActions: { props: [["sendMessage", "updateMessage"]] }', why: "editMessage is updateMessage now" });
await tool("selftest");
await tool("done", { summary: "Discord renamed editMessage to updateMessage." });
c.kill();
process.exit(0);
