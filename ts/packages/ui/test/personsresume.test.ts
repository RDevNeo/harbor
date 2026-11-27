import { expect, test } from "bun:test";
import { draftsFrom, draftsJson, personsSnapFrom } from "../src/tabs/persons/ui.ts";

test("Persons drafts go to kv and back: empty ones and odd values left out", () => {
  const drafts = new Map([
    ["p1:stores:person", "oi, tudo bem?"],
    ["p1:stores:ai", "  "],
    ["sr:SR-1:person", "resposta"],
  ]);
  const toAi = new Map([
    ["p1:stores", true],
    ["p2:creators", false],
  ]);
  const back = draftsFrom(draftsJson(drafts, toAi));
  expect([...back.drafts]).toEqual([
    ["p1:stores:person", "oi, tudo bem?"],
    ["sr:SR-1:person", "resposta"],
  ]);
  expect([...back.toAi]).toEqual([["p1:stores", true]]);
  expect(draftsFrom(JSON.stringify({ drafts: { a: 3, b: "x" }, toAi: { c: "yes" } }))).toEqual({ drafts: new Map([["b", "x"]]), toAi: new Map() });
  expect(draftsFrom("{oops").drafts.size).toBe(0);
  expect(draftsFrom(null).drafts.size).toBe(0);
});

test("a Persons snapshot comes back whole; junk is dropped", () => {
  const snap = {
    open: { id: "p1", section: "stores", store: "s1" },
    allActive: false,
    sr: null,
    query: "ana",
    panelOpen: false,
    sideHidden: true,
    aiMode: true,
    draft: "pergunta",
    cursor: 4,
    subject: "",
    replyTo: { id: "m1", name: "Ana", text: "oi" },
    forwarded: null,
    files: ["/tmp/a.png"],
    aiFiles: [],
    srFiles: [],
    places: [
      ["p1:stores", { end: false, id: "m7", off: -120 }],
      ["p2:creators", { end: true, id: "", off: 0 }],
    ] as [string, { end: boolean; id: string; off: number }][],
  };
  expect(personsSnapFrom(JSON.parse(JSON.stringify(snap)))).toEqual(snap);
  const junk = personsSnapFrom({ open: { id: 3 }, cursor: -2, replyTo: { name: "x" }, files: [1, "/a"], places: [["a", { off: 3 }], "x", ["b", { id: "m1", off: "no" }]] });
  expect(junk?.open).toBeNull();
  expect(junk?.cursor).toBe(-1);
  expect(junk?.replyTo).toBeNull();
  expect(junk?.files).toEqual(["/a"]);
  expect(junk?.places).toEqual([["b", { end: false, id: "m1", off: 0 }]]);
  expect(personsSnapFrom("x")).toBeNull();
});
