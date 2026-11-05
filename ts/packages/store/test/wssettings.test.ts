import { afterEach, expect, test } from "bun:test";
import { Store, settingsync, wssettings as ws } from "../src/index.ts";

const stores: Store[] = [];
const open = (): Store => {
  const s = Store.openTemp();
  stores.push(s);
  return s;
};

afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

test("voice cleanup is a workspace setting", () => {
  expect(settingsync.classOf("voice_cleanup")).toBe("workspace");
  expect(ws.SHARED).toContain("voice_cleanup");
});

test("a change here gets a time and pokes the mesh; the same value again doesn't", () => {
  const s = open();
  let pokes = 0;
  ws.onChanged(s, () => pokes++);
  expect(ws.snapshot(s)).toEqual({});
  s.set("voice_cleanup", "1");
  const [v, at] = ws.snapshot(s).voice_cleanup ?? ["", 0];
  expect(v).toBe("1");
  expect(at).toBeGreaterThan(0);
  expect(pokes).toBe(1);
  s.set("voice_cleanup", "1");
  expect(pokes).toBe(1);
  expect(ws.snapshot(s).voice_cleanup?.[1]).toBe(at);
});

test("only the store's own listener hears of its change, and one that throws doesn't stop the change", () => {
  const a = open();
  const b = open();
  let aPokes = 0;
  ws.onChanged(a, () => aPokes++);
  ws.onChanged(b, () => {
    throw new Error("closed");
  });
  b.set("voice_cleanup", "1");
  expect(aPokes).toBe(0);
  expect(b.get("voice_cleanup")).toBe("1");
  a.set("voice_cleanup", "1");
  expect(aPokes).toBe(1);
});

test("the newest value wins on every PC", () => {
  const a = open();
  const b = open();
  a.set("voice_cleanup", "0");
  b.set("voice_cleanup", "1");
  // b changed last: a takes it, b keeps its own.
  const bAt = ws.snapshot(b).voice_cleanup?.[1] ?? 0;
  const aAt = ws.snapshot(a).voice_cleanup?.[1] ?? 0;
  expect(bAt).toBeGreaterThanOrEqual(aAt);
  const later = { voice_cleanup: ["1", aAt + 10] };
  expect(ws.adopt(a, later)).toEqual(["voice_cleanup"]);
  expect(a.get("voice_cleanup")).toBe("1");
  // An older one changes nothing.
  expect(ws.adopt(a, { voice_cleanup: ["0", aAt] })).toEqual([]);
  expect(a.get("voice_cleanup")).toBe("1");
  // Taken values aren't changes of this PC: no push back.
  let pokes = 0;
  ws.onChanged(b, () => pokes++);
  ws.adopt(b, { voice_cleanup: ["0", bAt + 100] });
  expect(b.get("voice_cleanup")).toBe("0");
  expect(pokes).toBe(0);
  expect(ws.snapshot(b).voice_cleanup).toEqual(["0", bAt + 100]);
});

test("a PC that never changed it takes the first change anywhere", () => {
  const s = open();
  s.setQuiet("voice_cleanup", "0");
  expect(ws.snapshot(s).voice_cleanup).toEqual(["0", 0]);
  expect(ws.adopt(s, { voice_cleanup: ["1", 5] })).toEqual(["voice_cleanup"]);
});

test("junk from a peer is ignored", () => {
  const s = open();
  for (const v of [null, 3, "x", [], { voice_cleanup: "1" }, { voice_cleanup: ["1"] }, { voice_cleanup: [1, 9] }, { voice_cleanup: ["1", "9"] }, { other: ["1", 9] }]) {
    expect(ws.adopt(s, v)).toEqual([]);
  }
  expect(s.get("voice_cleanup")).toBeNull();
});
