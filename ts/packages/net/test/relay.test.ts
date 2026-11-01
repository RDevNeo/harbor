import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Api } from "../src/api.ts";
import { http, setHello } from "../src/client.ts";
import { err, ok } from "../src/http.ts";
import { Hub } from "../src/hub.ts";
import { findPc, relayServe, relayTargets } from "../src/relay.ts";
import type { Allowed } from "../src/shared.ts";
import { generateIdentity, type Identity } from "../src/tls.ts";

const tmp = mkdtempSync(join(tmpdir(), "harbor-relay-"));
const apis: Api[] = [];
afterAll(() => {
  for (const a of apis) a.close();
  rmSync(tmp, { recursive: true, force: true });
});

function allowed(fp: string, addr: string, name = ""): Allowed {
  return { node: "", name, fp, id: "", addrs: [addr] };
}

/** A PC that answers `/mesh/v1/hello` with its name to the keys it allows, and relays for them. */
async function pc(id: Identity, name: string, allow: () => Allowed[]): Promise<{ hub: Hub; port: number }> {
  const hub = new Hub([], 0);
  hub.mesh.on = true;
  hub.mesh.workspacePeers = allow;
  const api = new Api({
    hub,
    id: () => id,
    uploadsDir: join(tmp, name),
    route: async () => err(404, "no such call"),
    account: null,
    appInfo: () => null,
    apk: () => null,
    mesh: async (p) => (p.via.kind === "tls" && p.via.fp !== null && hub.mesh.allowedFp(p.via.fp) ? ok({ name }) : err(403, "not allowed")),
    meshAdmitted: () => false,
    relay: (p, req, r, w) => relayServe({ hub, myFp: () => id.fp, isPhone: () => false }, p, req, r, w),
    hubs: () => null,
  });
  await api.listen(["127.0.0.1"]);
  apis.push(api);
  return { hub, port: api.port() };
}

describe("relay (relay.rs)", () => {
  test("finds_the_pc_a_device_is", () => {
    const a: Allowed = { node: "", fp: "a".repeat(64), id: "ts:desk", name: "desk", addrs: ["10.0.0.5:47930"] };
    const b: Allowed = { node: "", fp: "b".repeat(64), id: "pc:laptop", name: "Laptop", addrs: ["[fd00::7]:47931"] };
    const old: Allowed = { node: "nX", name: "old", fp: "", id: "", addrs: [] };
    const list = [a, b, old];
    expect(findPc(list, "ts:desk", "desk.example.ts.net")?.name).toBe("desk");
    expect(findPc(list, "", "desk.example.ts.net")?.name).toBe("desk");
    expect(findPc(list, "", "laptop")?.name).toBe("Laptop");
    expect(findPc(list, "", "fd00::7")?.name).toBe("Laptop");
    expect(findPc(list, "", "10.0.0.5")?.id).toBe("ts:desk");
    expect(findPc(list, "", "old")).toBeNull();
    expect(findPc(list, "", "elsewhere.example.org")).toBeNull();
    expect(relayTargets(["[fd7a:115c:a1e0::1]:47930", "10.0.0.5:47930", "junk"], 22)).toEqual(["10.0.0.5:22", "[fd7a:115c:a1e0::1]:22"]);
  });

  test("a PC reaches another through a third, pinned to the far one's key end to end", async () => {
    const me = generateIdentity();
    const far = generateIdentity();
    const mid = generateIdentity();
    let farPort = 0;
    const f = await pc(far, "far", () => [allowed(me.fp, "127.0.0.1:1")]);
    farPort = f.port;
    const m = await pc(mid, "mid", () => [allowed(me.fp, "127.0.0.1:1"), allowed(far.fp, `127.0.0.1:${farPort}`, "far")]);
    setHello("pc:me", "me", me);
    const via = { addr: `127.0.0.1:${m.port}`, fp: mid.fp };
    const [st, v] = await http({ addr: `127.0.0.1:${farPort}`, fp: far.fp, via }, "GET", "/mesh/v1/hello", null, 8_000);
    expect([st, v]).toEqual([200, { name: "far" }]);
    // The far PC's key is checked inside: another pin fails even though the relay answers.
    expect(http({ addr: `127.0.0.1:${farPort}`, fp: me.fp, via }, "GET", "/mesh/v1/hello", null, 8_000)).rejects.toThrow();
    // Only to PCs on the relay's list.
    expect(http({ addr: "127.0.0.1:9", fp: "c".repeat(64), via }, "GET", "/mesh/v1/hello", null, 8_000)).rejects.toThrow("isn't paired");
  });
});
