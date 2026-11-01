import { readFileSync } from "node:fs";
import { Store, blankChat, dataDir } from "../src/index.ts";

const [cmd, ...args] = process.argv.slice(2);

if (cmd === "make") {
  const [home = ""] = args;
  const s = Store.open(dataDir());
  const repo = s.addRepo(home);
  const mk = (title: string, over: object = {}) => s.createChat(blankChat({ title, repoId: repo, account: "claude", ...over }));
  const lead = mk("Lead", { role: "lead", name: "lead" });
  const ids = { plain: mk("Plain").id, failing: mk("Failing").id, lead: lead.id, sub: mk("Sub", { role: "sub", parent: lead.id, name: "worker" }).id, other: mk("Other").id };
  s.set("chat_prs", JSON.stringify({ [lead.id]: { number: 7, state: "open", url: "https://github.com/o/r/pull/7", title: "Add it", branch: "add-it" }, [ids.other]: { number: 3, state: "merged", url: "https://github.com/o/r/pull/3", title: "Old", branch: "old" } }));
  s.setQuiet("api_enabled", "1");
  s.setQuiet("api_port", "47930");
  s.setQuiet("api_tokens", '[{"token":"0123456789abcdef0123456789abcdef0123456789abcdef","name":"","created":0,"group":"gggggggggggggggg","fp":""}]');
  s.setQuiet("mesh_id", "pc:cs");
  console.log(JSON.stringify(ids));
  s.close();
} else if (cmd === "pick") {
  const [file = ""] = args;
  const chats = (JSON.parse(readFileSync(file, "utf8")) as { chats: Record<string, unknown>[] }).chats;
  const keep = ["id", "title", "pr", "unread", "failed", "working", "running", "queued"];
  console.log(JSON.stringify(chats.map((c) => Object.fromEntries(keep.map((k) => [k, c[k]]))).sort((a, b) => Number(a.id) - Number(b.id))));
}
