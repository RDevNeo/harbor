// rig/machines.sh's TypeScript side, in the PC's own XDG folders.
//   seed ID ALLOW PROJECT [TITLE]: a TypeScript PC's db with one project and, given TITLE, a chat in it.
//   drive B_ID R_ID B_DB R_DB A_PROJECT: PC A's hub, then its chat's `machines` calls to B and R.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { startHub } from "../hub.ts";
import { seedWorkspace } from "../packages/net/src/index.ts";
import { machines } from "../packages/mcp/src/index.ts";
import { blankChat, dataDir, Store } from "../packages/store/src/index.ts";

const [cmd, ...args] = process.argv.slice(2);

if (cmd === "seed") {
  const [id = "", allow = "", project = "", title = ""] = args;
  const s = Store.open(dataDir());
  s.setQuiet("mesh_enabled", "1");
  s.setQuiet("mesh_id", id);
  s.setQuiet("net_map", "0");
  const list = allow.split(",").filter((x) => x !== "").map((x) => {
    const [fp = "", addr = ""] = x.split("=");
    return { fp, addrs: [addr] };
  });
  seedWorkspace(s, list);
  const repo = s.addRepo(project);
  if (title !== "") s.createChat(blankChat({ repoId: repo, title, account: "claude", model: "claude-opus-5-5", effort: "medium", access: "full", role: "lead", name: "lead" }));
  s.close();
  process.exit(0);
}

if (cmd !== "drive") throw new Error("usage: machines.ts seed|drive …");
const [bId = "", rId = "", bDb = "", rDb = "", aProject = ""] = args;
let fail = 0;
const ok = (what: string, good: boolean, got: unknown = ""): void => {
  console.log(`${good ? "PASS" : "FAIL"} ${what}${good ? "" : `: ${JSON.stringify(got)}`}`);
  if (!good) fail = 1;
};
const adopted = (db: string): boolean => {
  if (!existsSync(db)) return false;
  const d = new Database(db, { readonly: true });
  try {
    return d.query("SELECT 1 FROM repos WHERE path = ?1").get(aProject) !== null;
  } catch {
    return false;
  } finally {
    d.close();
  }
};

const h = await startHub({ version: "0.0.0-rig", hookPort: false });
const chat = h.store.chats().find((c) => c.title === "Chat in proj");
if (!chat) throw new Error("no seeded chat");
let ready = false;
for (let i = 0; i < 120 && !ready; i++) {
  await Bun.sleep(1000);
  const peers = [...h.hub.mesh.peers.values()];
  ready = [bId, rId].every((id) => peers.some((p) => p.id === id && p.online)) && adopted(bDb) && adopted(rDb);
}
ok("B (TypeScript) and R (Rust) are online and each adopted A's chat with an entry for A's folder", ready, [...h.hub.mesh.peers.values()].map((p) => [p.id, p.online]));
h.engine.reload();
const grant = h.engine.host.turnContext?.(chat, false).machines ?? null;
ok("the chat gets the machines server for its project", grant?.project === "proj", grant);
if (!grant) process.exit(1);

const call = async (name: string, a: Record<string, unknown>): Promise<{ text: string; error: boolean }> => {
  const r = await machines.mcp(grant, aProject, chat.id, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: a } });
  const res = (r as { result: { content: unknown; isError: boolean } }).result;
  const parts = Array.isArray(res.content) ? (res.content as { text?: string }[]) : [];
  return { text: parts.map((p) => p.text ?? "").join("").trim(), error: res.isError };
};

for (const [pc, id, home] of [["B (TypeScript)", bId, process.env.B_HOME ?? ""], ["R (Rust)", rId, process.env.R_HOME ?? ""]] as const) {
  const pwd = await call("bash", { machine: id, command: "pwd; cat marker.txt" });
  ok(`bash on ${pc} starts in its home, not in A's folder`, !pwd.error && pwd.text === `${home}\n${id}-home`, pwd);
  const read = await call("read", { machine: id, file_path: "marker.txt" });
  ok(`read of a relative path on ${pc} reads its home's file`, !read.error && read.text.includes(`${id}-home`), read);
  const glob = await call("glob", { machine: id, pattern: "*.txt" });
  ok(`glob on ${pc} searches its home`, !glob.error && glob.text.includes("marker.txt"), glob);
  const grep = await call("grep", { machine: id, pattern: `${id}-home`, output_mode: "files_with_matches" });
  ok(`grep on ${pc} searches its home`, !grep.error && grep.text.includes("marker.txt"), grep);
}

const list = await call("list", {});
const line = (id: string): string => list.text.split("\n").find((l) => l.startsWith(`- ${id.replace(/^pc:/, "")}`) || l.includes(id)) ?? "";
for (const [pc, id, home] of [["B", bId, process.env.B_HOME ?? ""], ["R", rId, process.env.R_HOME ?? ""]] as const) {
  ok(`list shows ${pc}'s own project and none of A's folders`, line(id).includes(`projects: ${home}/work (work)`) && !line(id).includes(aProject), list.text);
}

await h.stop();
h.store.close();
console.log(fail === 0 ? "DRIVE PASS" : "DRIVE FAIL");
process.exit(fail);
