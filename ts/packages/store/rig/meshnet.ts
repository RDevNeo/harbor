import { seedWorkspace } from "../../net/src/account.ts";
import { blankChat, dataDir, stateDir, Store } from "../src/index.ts";

const [cmd, ...args] = process.argv.slice(2);

if (cmd === "fp") {
  const { loadOrCreate } = await import("../../net/src/index.ts");
  console.log(loadOrCreate(stateDir()).fp);
} else if (cmd === "seed") {
  const [id = "", title = "", allow = ""] = args;
  const s = Store.open(dataDir());
  s.setQuiet("mesh_enabled", "1");
  s.setQuiet("mesh_id", id);
  s.setQuiet("net_map", "0");
  if (allow !== "") {
    const list = allow.split(",").map((x) => {
      const [fp = "", addr = ""] = x.split("=");
      return { fp, addrs: [addr] };
    });
    seedWorkspace(s, list);
  }
  if (title !== "") {
    const c = s.createChat(blankChat({ title, account: "claude", model: "claude-opus-5-5", effort: "medium", access: "full", role: "lead" }));
    s.saveItems(c.id, [
      { kind: "user", text: `hello from ${id}`, files: [], at: 1761200000, mentions: [], sender: "", intent: "" },
      { kind: "text", text: `a reply on ${id}`, at: 1761200001 },
    ]);
  }
  s.close();
} else if (cmd === "show") {
  const s = Store.open(dataDir());
  for (const c of s.chats()) console.log(`${c.home === "" ? "(own)" : c.home}|${c.gid.slice(0, 8)}|${c.title}|${s.items(c.id).length}`);
  s.close();
}
