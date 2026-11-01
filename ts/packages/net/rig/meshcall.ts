// meshcall.ts STATE_DIR ID NAME ADDR FP METHOD PATH [JSON]: one mesh call as the PC whose identity is in STATE_DIR.
import { httpRaw, jsonBody, setHello } from "../src/client.ts";
import { loadOrCreate } from "../src/tls.ts";

const [state, id, name, addr, fp, method, path, body] = process.argv.slice(2);
if (!state || !id || !name || !addr || fp === undefined || !method || !path) throw new Error("usage: meshcall.ts STATE_DIR ID NAME ADDR FP METHOD PATH [JSON]");
const me = loadOrCreate(state);
setHello(id, name, me);
const a = await httpRaw({ addr, fp, as: me }, method, path, body === undefined ? null : jsonBody(JSON.parse(body)), 10_000);
console.log(`${a.status} ${new TextDecoder().decode(a.body).trim()}`);
process.exit(0);
