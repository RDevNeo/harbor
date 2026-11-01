// The rig's TypeScript PC: env DIR, PORT, ID, NAME, ALLOW (fp=addr,…), SEED (an own chat's title), SECS.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { blankChat, Store, type Item } from "@harbor/store";
import { Api, Hub, loadOrCreate, Mesh, PhoneRoutes, StoreReplica, relayServe, setHello, type Allowed } from "@harbor/net";

const dir = process.env.DIR ?? "";
const port = Number(process.env.PORT ?? "47931");
mkdirSync(dir, { recursive: true });
const store = Store.open(join(dir, "data"));
const id = loadOrCreate(dir);
console.log(`fp ${id.fp}`);
const allowed: Allowed[] = (process.env.ALLOW ?? "")
  .split(",")
  .filter((x) => x !== "")
  .map((x) => {
    const [fp = "", addr = ""] = x.split("=");
    return { node: "", name: "", fp, id: "", addrs: [addr] };
  });
store.set("mesh_allowed", JSON.stringify(allowed));
store.set("mesh_enabled", "1");
if (process.env.SEED) {
  const c = store.createChat(blankChat({ title: process.env.SEED, account: "claude", model: "claude-opus-5-5", effort: "medium", access: "full", role: "lead", name: "lead" }));
  const items: Item[] = [
    { kind: "user", text: `hello from ${process.env.NAME}`, files: [], at: 1761200000, mentions: [], sender: "", intent: "" },
    { kind: "text", text: `a reply on ${process.env.NAME}`, at: 1761200001 },
  ];
  store.saveItems(c.id, items);
}
const token = process.env.TOKEN ?? "";
const hub = new Hub(token === "" ? [] : [{ token, name: "", created: 0, group: "g".repeat(16), fp: "", account: "", account_name: "" }], port);
hub.enabled = token !== "";
hub.mesh.me = { id: process.env.ID ?? "pc:ts", name: process.env.NAME ?? "ts" };
setHello(hub.mesh.me.id, hub.mesh.me.name, id);
const replica = new StoreReplica({ store, hub, version: "0.0.0-ts" });
let api: Api;
let phone: PhoneRoutes;
const mesh = new Mesh({
  hub,
  kv: store,
  id: () => id,
  app: replica,
  myAddrs: () => [`127.0.0.1:${port}`],
  uploadsDir: join(dir, "uploads"),
  upload: (r, req) => api.upload(r, req),
});
api = new Api({
  hub,
  id: () => id,
  uploadsDir: join(dir, "uploads"),
  route: (c) => phone.route(c),
  account: null,
  appInfo: () => ({ version_code: 0, url: "/app.apk", hub: null }),
  apk: () => null,
  mesh: (p, req, r) => mesh.serve(p, req, r),
  meshAdmitted: (p, req) => mesh.admitted(p, req),
  relay: (p, req, r, w) => relayServe({ hub, myFp: () => id.fp, isPhone: () => false }, p, req, r, w),
  hubs: () => mesh.hubs(),
  forwardLease: (...a) => mesh.forwardLease(...a),
});
phone = new PhoneRoutes({ store, hub, replica, mesh, version: "0.0.0-ts", myFp: () => id.fp, agents: null });
await api.listen(["127.0.0.1"]);
mesh.start();
const secs = Number(process.env.SECS ?? "20");
await Bun.sleep(secs * 1000);
for (const c of store.chats()) {
  console.log(`chat ${c.id} home=${c.home || "(own)"} gid=${c.gid.slice(0, 8)} title=${JSON.stringify(c.title)} items=${store.items(c.id).length}`);
}
for (const p of hub.mesh.peers.values()) console.log(`peer ${p.id} online=${p.online} via=${p.via ? p.via.addr : "-"} version=${p.version}`);
mesh.stop();
api.close();
process.exit(0);
