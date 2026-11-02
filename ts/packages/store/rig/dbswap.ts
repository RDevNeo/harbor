import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type Item, Store, blankChat, dataDir } from "../src/index.ts";

const [cmd, ...args] = process.argv.slice(2);

function strip(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(strip);
  if (typeof v === "object" && v !== null) {
    return Object.fromEntries(Object.entries(v).filter(([k]) => !/^(rev|updated_ms|since_ms)$/.test(k)).map(([k, x]) => [k, strip(x)]));
  }
  return v;
}

function load(path: string): unknown {
  const t = existsSync(path) ? readFileSync(path, "utf8") : "";
  return t === "" ? null : strip(JSON.parse(t));
}

if (cmd === "same") {
  const [a = "", b = ""] = args;
  const x = JSON.stringify(load(a));
  const y = JSON.stringify(load(b));
  if (x === y && x !== "null") console.log(`same ${a.split("/").pop()} ${b.split("/").pop()}`);
  else {
    console.log(`DIFFERENT ${a} ${b}\n  ${x.slice(0, 300)}\n  ${y.slice(0, 300)}`);
    process.exit(1);
  }
} else if (cmd === "samedir") {
  const [dir = "", from = "", to = ""] = args;
  const names = readdirSync(dir).filter((f) => f.startsWith(`${from}-`));
  const bad = names.filter((f) => JSON.stringify(load(join(dir, f))) !== JSON.stringify(load(join(dir, f.replace(`${from}-`, `${to}-`)))));
  console.log(`${names.length} files compared, ${names.length - bad.length} identical, ${bad.length} differ${bad.length > 0 ? `: ${bad.slice(0, 5).join(", ")}` : ""}`);
  if (bad.length > 0 || names.length === 0) process.exit(1);
} else if (cmd === "statediff") {
  const [x = "", y = "", mode = ""] = args;
  const out = new Map<string, number>();
  const sortKey = (v: unknown): string => {
    const o = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
    return String(o.id ?? o.gid ?? o.title ?? JSON.stringify(v));
  };
  const walk = (a: unknown, b: unknown, p: string): void => {
    const q = p.replace(/\[\d+\]/g, "[]").replace(/\.[0-9a-f-]{32,36}(?=\.|$)/g, ".<gid>");
    const note = (kind: string): void => void out.set(`${q} ${kind}`, (out.get(`${q} ${kind}`) ?? 0) + 1);
    if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || (a === null) !== (b === null)) return note("type");
    if (Array.isArray(a) && Array.isArray(b)) {
      if (mode.includes("sort")) {
        a.sort((x, y) => sortKey(x).localeCompare(sortKey(y)));
        b.sort((x, y) => sortKey(x).localeCompare(sortKey(y)));
      }
      if (a.length !== b.length) note("length");
      a.slice(0, b.length).forEach((v, i) => walk(v, b[i], `${p}[${i}]`));
    } else if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
      const o = a as Record<string, unknown>;
      const n = b as Record<string, unknown>;
      for (const k of new Set([...Object.keys(o), ...Object.keys(n)])) {
        if (/^(rev|updated_ms|since_ms|seen|mem_available_mb|web_client_id|browser)$/.test(k) || (k === "until_ms" && p.includes(".presets[")) || (k === "at" && (p.endsWith(".mention") || p.endsWith(".suggested"))) || (k === "gid" && mode.includes("byid")) || (k === "hub" && p === "") || (k === "updated" && p.includes(".items[")) || ((k === "at" || k === "time") && p.includes(".items["))) continue;
        if (!(k in n)) out.set(`${q}.${k} only in Rust`, (out.get(`${q}.${k} only in Rust`) ?? 0) + 1);
        else if (!(k in o)) out.set(`${q}.${k} only in TS`, (out.get(`${q}.${k} only in TS`) ?? 0) + 1);
        else walk(o[k], n[k], `${p}.${k}`);
      }
    } else if (a !== b) note("value");
  };
  const byGid = (v: unknown): unknown => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return v;
    const o = { ...(v as Record<string, unknown>) };
    if (Array.isArray(o.chats)) o.chats = Object.fromEntries((o.chats as { gid?: string; id?: number }[]).map((c) => [mode.includes("byid") ? String(c.id) : (c.gid ?? String(c.id)), c]));
    return o;
  };
  walk(byGid(load(x)), byGid(load(y)), "");
  for (const [k, n] of [...out].sort((p, q) => q[1] - p[1])) console.log(`  ${n} x ${k}`);
  console.log(`  ${out.size} kinds of difference in /v1/state`);
} else if (cmd === "read") {
  const s = Store.open(dataDir());
  const chats = s.chats();
  let items = 0;
  for (const c of chats) items += s.items(c.id).length;
  const n = (s.db.query("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n;
  console.log(JSON.stringify({ repos: s.repos().length, chats: chats.length, items, rows: n, kv: (s.db.query("SELECT COUNT(*) AS n FROM kv").get() as { n: number }).n }));
  if (items !== n) process.exit(1);
  s.close();
} else if (cmd === "write") {
  const s = Store.open(dataDir());
  const repo = s.addRepo(join(process.env.HOME ?? "/", "ts-project"));
  const all: Item[] = [
    { kind: "user", text: "from TS \"quoted\" é ✓", files: ["/tmp/a.png"], at: 100, mentions: [{ item: 0, from: "x", at: 1, text: "m", len: 1, excerpt: false, note: "", kind: "", chat: "", title: "" }], sender: "phone", intent: "" },
    { kind: "text", text: "a reply\nwith lines", at: 101 },
    { kind: "thinking", text: "thought" },
    { kind: "tool", id: "tu1", name: "Bash", summary: "ls", input: "{\"command\":\"ls\"}", result: "a\nb", is_error: false },
    { kind: "tool", id: "tu2", name: "Read", summary: "", input: "{}", result: null, is_error: false },
    { kind: "result", cost_usd: 0.1849, duration_ms: 1500, turns: 2, input_tokens: 1200, output_tokens: 80, cached: 900, at: 102, account: "claude", model: "claude-opus-5-5" },
    { kind: "error", text: "boom" },
    { kind: "notice", icon: "clock", text: "waiting", detail: "d" },
    { kind: "message", from: "lead", to: "tests", text: "hi" },
  ];
  const lead = s.createChat(blankChat({ repoId: repo, title: "TS lead", role: "lead", name: "lead", model: "claude-opus-5-5" }));
  s.saveItems(lead.id, all);
  s.setMainChat(repo, lead.id);
  const sub = s.createChat(blankChat({ repoId: repo, title: "TS sub", role: "sub", parent: lead.id, name: "tests" }));
  s.saveItems(sub.id, all.slice(0, 3));
  const first = s.chats().find((c) => c.id === Number(args[2]));
  if (first) {
    const it = s.items(first.id);
    it.push({ kind: "text", text: "appended by TS", at: 200 });
    s.saveItems(first.id, it);
  }
  const rust = s.chats().find((c) => c.id === Number(args[0]));
  if (rust) {
    const it = s.items(rust.id);
    it.push({ kind: "notice", icon: "clock", text: "TS note", detail: "" });
    s.saveItems(rust.id, it);
    rust.title = `${rust.title} (renamed by TS)`;
    s.saveChat(rust);
  }
  s.deleteChat(Number(args[1]));
  s.addTimer(lead.id, 4_000_000_000, "wake later");
  s.addWebhook(repo, "ci", "ts-hook-token", "from TS");
  s.set("theme", "light");
  s.setQuiet("ts_marker", "1");
  console.log(JSON.stringify({ lead: lead.id, sub: sub.id, repo }));
  s.close();
} else if (cmd === "fresh") {
  const s = Store.open(dataDir());
  const c = s.createChat(blankChat({ title: "TS made this db", role: "lead" }));
  s.saveItems(c.id, [{ kind: "user", text: "hello", files: [], at: 1, mentions: [], sender: "", intent: "" }, { kind: "text", text: "world", at: 2 }]);
  s.setQuiet("api_enabled", "1");
  s.setQuiet("api_port", "47930");
  s.setQuiet("api_tokens", '[{"token":"0123456789abcdef0123456789abcdef0123456789abcdef","name":"","created":0,"group":"gggggggggggggggg","fp":""}]');
  console.log(JSON.stringify({ chat: c.id }));
  s.close();
}
