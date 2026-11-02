import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { http, loadOrCreate } from "../../net/src/index.ts";
import { stateDir } from "../src/index.ts";

const [cmd = "", addr = "", fp = "", out = "", ...chats] = process.argv.slice(2);
const id = loadOrCreate(stateDir());

if (cmd === "fp") {
  console.log(id.fp);
} else {
  const dest = { addr, fp, as: id };
  const names = ["hello", "chats?since=0&epoch=0", "phones", ...chats.map((c) => `chats/${c}/items?since=0&epoch=0`)];
  for (const n of names) {
    const [status, v] = await http(dest, "GET", `/mesh/v1/${n}`, null, 20_000);
    writeFileSync(join(out, `${n.replace(/[^a-z0-9]+/gi, "_")}.json`), JSON.stringify({ status, v }));
  }
}
