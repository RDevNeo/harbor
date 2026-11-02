import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Store, blankChat, dataDir } from "../src/index.ts";

const [cmd, ...args] = process.argv.slice(2);

if (cmd === "make") {
  const [home = "", confirmed = ""] = args;
  const s = Store.open(dataDir());
  if (confirmed !== "") s.set("owner_name", confirmed);
  const repo = s.addRepo(home);
  const gone = s.addRepo(resolve(home, "../gone"));
  const away = s.addRepo(resolve(home, "../away"));
  const mk = (title: string, over: object = {}) => s.createChat(blankChat({ title, repoId: repo, account: "claude", ...over }));
  const lead = mk("Lead", { role: "lead", name: "lead" });
  const ids: Record<string, number> = { plain: mk("Plain").id, failing: mk("Failing").id, lead: lead.id, sub: mk("Sub", { role: "sub", parent: lead.id, name: "worker" }).id, other: mk("Other").id };
  const lim1 = mk("Limit waiting", { account: "claude2" });
  const lim2 = mk("Limit continuing", { account: "claude2" });
  const nof = s.createChat(blankChat({ title: "No folder", repoId: gone, account: "claude" }));
  const far = s.createChat(blankChat({ title: "Elsewhere", repoId: away, account: "claude", home: "pc:far", homeId: 1, gid: "00000000-0000-4000-8000-0000000000aa" }));
  ids.near = s.createChat(blankChat({ title: "Project is on another PC", repoId: away, account: "claude" })).id;
  const until = Math.floor(Date.now() / 1000) + 3 * 3600 + 17 * 60;
  s.set("limits", JSON.stringify({ blocks: { claude2: { until, kind: "five_hour", known: true, tries: 1, cap: null } }, paused: { [lim1.id]: { account: "claude2", resume: true, at: null, timer: null }, [lim2.id]: { account: "claude2", resume: true, at: until + 600, timer: null } }, pending: {}, quota: {} }));
  ids.lim1 = lim1.id;
  ids.lim2 = lim2.id;
  ids.nof = nof.id;
  ids.far = far.id;
  s.set("owner_suggested", JSON.stringify({ me: { owner: "Ana Souza", github: "anasouza", confidence: "high", why: "git user.name and gh login on this PC" }, peers: {}, by: "rules", at: 1, sig: "x" }));
  s.set("mesh_peers", JSON.stringify({ "pc:far": { id: "pc:far", name: "far", addr: "", dns: "", seen: 1, version: "0.108.0", node: "", phones: false, fp: "ab".repeat(32), addrs: [], owner: "", github: "", owner_suggested: false } }));
  s.set("chat_prs", JSON.stringify({ [lead.id]: { number: 7, state: "open", url: "https://github.com/o/r/pull/7", title: "Add it", branch: "add-it" }, [ids.other]: { number: 3, state: "merged", url: "https://github.com/o/r/pull/3", title: "Old", branch: "old" } }));
  s.setQuiet("api_enabled", "1");
  s.setQuiet("api_port", "47930");
  s.setQuiet("api_tokens", '[{"token":"0123456789abcdef0123456789abcdef0123456789abcdef","name":"","created":0,"group":"gggggggggggggggg","fp":""}]');
  s.setQuiet("mesh_id", "pc:cs");
  console.log(JSON.stringify(ids));
  s.close();
} else if (cmd === "status") {
  const [file = ""] = args;
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (typeof v !== "object" || v === null) return v;
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (k !== "since_ms") o[k] = k === "text" && typeof x === "string" ? x.replace(/\(in [^)]*\)/, "(in N)") : strip(x);
    return o;
  };
  console.log(JSON.stringify(strip((JSON.parse(readFileSync(file, "utf8")) as { status: unknown }).status)));
} else if (cmd === "pick") {
  const [file = ""] = args;
  const chats = (JSON.parse(readFileSync(file, "utf8")) as { chats: Record<string, unknown>[] }).chats;
  const keep = ["id", "title", "pr", "unread", "failed", "working", "running", "queued"];
  console.log(JSON.stringify(chats.map((c) => Object.fromEntries(keep.map((k) => [k, c[k]]))).sort((a, b) => Number(a.id) - Number(b.id))));
}
