import { expect, test } from "bun:test";
import { Shared, newPeer } from "@harbor/net";
import { meshPort } from "../src/ghmesh.ts";

function shared(addr = "127.0.0.1:1"): Shared {
  const s = new Shared();
  s.on = true;
  s.me = { id: "me", name: "Desk" };
  s.peers.set("p1", newPeer({ id: "p1", name: "Laptop", addr, fp: "", online: true }));
  s.peers.set("p2", newPeer({ id: "p2", name: "Old", addr, online: false }));
  return s;
}

const fwd = { forward: async () => ({ status: 200, body: {} }) };

test("the port lists the mesh's PCs and finds one by id", () => {
  const m = meshPort(shared(), fwd);
  expect(m.enabled()).toBe(true);
  expect(m.me().name).toBe("Desk");
  expect(m.peers().map((p) => [p.id, p.name, p.online])).toEqual([["p1", "Laptop", true], ["p2", "Old", false]]);
  expect(m.peer("p1")?.dest.addr).toBe("127.0.0.1:1");
  expect(m.peer("nope")).toBeUndefined();
});

test("http reaches a peer's address and returns its status and JSON", async () => {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      seen.push(`${req.method} ${new URL(req.url).pathname} ${await req.text()}`);
      return Response.json({ hello: "there" });
    },
  });
  const m = meshPort(shared(`127.0.0.1:${server.port}`), fwd);
  const dest = m.peer("p1")?.dest;
  if (!dest) throw new Error("no peer");
  expect(await m.http(dest, "POST", "/mesh/v1/x", { a: 1 }, 5000)).toEqual([200, { hello: "there" }]);
  expect(seen).toEqual(['POST /mesh/v1/x {"a":1}']);
  void server.stop(true);
});

test("forward hands the call to the mesh with the peer's name and address", async () => {
  const calls: unknown[] = [];
  const m = meshPort(shared(), {
    forward: async (d, name, method, path, body, files, sender, ctx) => {
      calls.push({ addr: d.addr, name, method, path, body, files, sender, ctx });
      return { status: 201, body: { id: 5, gid: "g" } };
    },
  });
  const peer = m.peer("p1");
  if (!peer) throw new Error("no peer");
  const r = await m.forward(peer, { method: "POST", path: ["v1", "issues", "fix"], body: { url: "u" }, sender: ["Phone via Desk", "dev"], ctx: { v: 1 } });
  expect(r).toEqual({ status: 201, body: { id: 5, gid: "g" } });
  expect(calls).toEqual([{ addr: "127.0.0.1:1", name: "Laptop", method: "POST", path: ["v1", "issues", "fix"], body: { url: "u" }, files: [], sender: ["Phone via Desk", "dev"], ctx: { v: 1 } }]);
});

test("a chat made on another PC gets this PC's id once it arrives", async () => {
  const s = shared();
  const m = meshPort(s, fwd, 400);
  const reply = { status: 201, body: { id: 9, gid: "g-9" } };
  expect((await m.mapNew("p1", reply, true)).body).toEqual({ id: "g-9", gid: "g-9" });
  expect((await m.mapNew("p1", { status: 500, body: { id: 9 } }, false)).body).toEqual({ id: 9 });
  expect((await m.mapNew("p1", reply, false)).body).toEqual({ id: null, gid: "g-9" });
  s.ids.set("p1\u00009", 42);
  expect((await m.mapNew("p1", reply, false)).body).toEqual({ id: 42, gid: "g-9" });
});
