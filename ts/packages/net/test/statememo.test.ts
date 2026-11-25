import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankChat, Store } from "@harbor/store";
import { providers } from "@harbor/agents";
import { Hub } from "../src/hub.ts";
import { StoreReplica } from "../src/meshstore.ts";
import { catalogOf, memoStore, PhoneRoutes } from "../src/phone.ts";

const tmp = mkdtempSync(join(tmpdir(), "harbor-statememo-"));
afterAll(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Windows holds an open store's file
  }
});

describe("state reads the store once", () => {
  test("memoStore asks each read once, hands out copies, and forgets on any other call", () => {
    const store = Store.openAt(join(tmp, "memo.db"));
    let asked = 0;
    const real = store.repos.bind(store);
    store.repos = () => {
      asked++;
      return real();
    };
    const m = memoStore(store);
    store.addRepo(join(tmp, "a"));
    const one = m.repos();
    one.pop();
    expect(m.repos().length).toBe(1);
    expect(asked).toBe(1);
    m.addRepo(join(tmp, "b"));
    expect(m.repos().length).toBe(2);
    expect(asked).toBe(2);
    store.close();
  });

  test("/v1/state is the same with the memo, and quicker with many chats", () => {
    const store = Store.openAt(join(tmp, "many.db"));
    const hub = new Hub([], 0);
    const replica = new StoreReplica({ store, hub, version: "t" });
    const routes = new PhoneRoutes({ store, hub, replica, mesh: null, version: "t", myFp: () => "", engine: null, catalog: catalogOf(providers, () => [], store) });
    const repos = Array.from({ length: 15 }, (_, i) => store.addRepo(join(tmp, `p${i}`)));
    for (let i = 0; i < 300; i++) {
      const lead = store.createChat(blankChat({ title: `lead ${i}`, role: "lead", repoId: repos[i % repos.length] ?? null }));
      store.createChat(blankChat({ title: `sub ${i}a`, role: "sub", parent: lead.id, repoId: lead.repoId }));
      store.createChat(blankChat({ title: `sub ${i}b`, role: "sub", parent: lead.id, repoId: lead.repoId }));
    }
    store.set("snoozed", JSON.stringify({ c1: 9_999_999_999, r1: 9_999_999_999 }));
    const plain = routes as unknown as { stateNow(you: string, global: boolean, caller: string): unknown };
    const strip = (j: unknown) => JSON.stringify(j, (k, v) => (k === "rev" ? undefined : v));
    expect(strip(routes.state("tok:0", false))).toBe(strip(plain.stateNow("tok:0", false, "")));
    const time = (f: () => unknown) => {
      const t = performance.now();
      for (let i = 0; i < 3; i++) f();
      return (performance.now() - t) / 3;
    };
    const before = time(() => plain.stateNow("tok:0", false, ""));
    const after = time(() => routes.state("tok:0", false));
    console.log(`/v1/state with 900 chats: ${before.toFixed(0)} ms without the memo, ${after.toFixed(0)} ms with it`);
    expect(after).toBeLessThan(before);
    store.close();
  });
});

describe("wire's key order", () => {
  test("keys sort by their UTF-8 bytes, also past the BMP", async () => {
    const { wire } = await import("../src/wire.ts");
    const bytes = (keys: string[]) => [...keys].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    // read from the text: JSON.parse would put "1" first again
    const order = (s: string) => [...s.matchAll(/"((?:[^"\\]|\\.)*)":1/g)].map((m) => JSON.parse(`"${m[1] ?? ""}"`) as string);
    const bmp = ["z", "Z", "é", "a_b", "aB", "中", "�", "", "1"];
    expect(order(wire(Object.fromEntries(bmp.map((k) => [k, 1]))))).toEqual(bytes(bmp));
    // U+1F600 is above U+FFFD in UTF-8 but its surrogates sort below it in UTF-16
    const astral = ["�", "\u{1F600}", "a"];
    expect(order(wire(Object.fromEntries(astral.map((k) => [k, 1]))))).toEqual(bytes(astral));
  });
});
