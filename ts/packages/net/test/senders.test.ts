import { afterEach, expect, test } from "bun:test";
import { itemJson, parseItem, type Item } from "@harbor/store";
import { knowDevices, project, sentBy, type Viewer } from "../src/index.ts";

afterEach(() => knowDevices(null));

test("new messages carry who and on what", () => {
  expect(sentBy("Pixel 8 (Sam Rig)", "Sam Rig", "phone")).toEqual({ who: "Sam Rig", via: "phone" });
  expect(sentBy("work-pc (Sam Rig)", "Sam Rig", "pc")).toEqual({ who: "Sam Rig", via: "pc" });
  expect(sentBy("work-pc", "", "pc")).toEqual({ who: "work-pc", via: "pc" });
  expect(sentBy("")).toEqual({ who: "", via: "" });
});

test("old labels: the person in brackets, the device matched against known ones", () => {
  knowDevices({ pcs: () => [["work-pc", "Sam Rig"]], phones: () => [["SM-A000", "Alex Rig"]] });
  expect(sentBy("work-pc")).toEqual({ who: "Sam Rig", via: "pc" });
  expect(sentBy("SM-A000")).toEqual({ who: "Alex Rig", via: "phone" });
  expect(sentBy("Pixel 8 (Kim Rig)")).toEqual({ who: "Kim Rig", via: "phone" });
});

test("old labels with nothing known: host names are PCs, the rest phones", () => {
  expect(sentBy("other-pc (Sam Rig)")).toEqual({ who: "Sam Rig", via: "pc" });
  expect(sentBy("Pixel 8")).toEqual({ who: "Pixel 8", via: "phone" });
  expect(sentBy("Phone")).toEqual({ who: "Phone", via: "phone" });
  expect(sentBy("Phone via other-pc")).toEqual({ who: "Phone", via: "phone" });
});

test("who and via survive the item's JSON and reach the card; old items stay as they were", () => {
  const it: Item = { kind: "user", text: "hi", files: [], at: 1, mentions: [], sender: "Pixel 8 (Sam Rig)", intent: "", who: "Sam Rig", via: "phone" };
  const back = parseItem(itemJson(it));
  expect(back).toEqual(it);
  const old: Item = { kind: "user", text: "hi", files: [], at: 1, mentions: [], sender: "", intent: "" };
  expect(itemJson(old)).toBe('{"kind":"user","text":"hi","files":[],"at":1}');
  const card = project([it], false, [])[0]?.card;
  expect(card?.kind === "user" && [card.who, card.via]).toEqual(["Sam Rig", "phone"]);
});

const msg = (at: number, sender = "", who = "", via?: "phone" | "pc", intent = ""): Item => {
  const it: Item = { kind: "user", text: "m", files: [], at, mentions: [], sender, intent };
  if (who) it.who = who;
  if (via) it.via = via;
  return it;
};
const joined = (items: Item[], forks: [number, number][] = []) => project(items, false, forks).map((s) => (s.card.kind === "user" ? s.card.joined : null));

test("a user message joins the one right above from the same place within 5 minutes", () => {
  const sam = (at: number) => msg(at, "Pixel 8 (Sam Rig)", "Sam Rig", "phone");
  expect(joined([sam(100), sam(160), sam(160 + 300), sam(160 + 601)])).toEqual([false, true, true, false]);
  // Typed here, both of them.
  expect(joined([msg(100), msg(110)])).toEqual([false, true]);
  // Another person, another kind of device, or here after a phone: not joined.
  expect(joined([sam(100), msg(110, "work-pc (Kim Rig)", "Kim Rig", "pc")])).toEqual([false, false]);
  expect(joined([sam(100), msg(110, "work-pc (Sam Rig)", "Sam Rig", "pc")])).toEqual([false, false]);
  expect(joined([sam(100), msg(110)])).toEqual([false, false]);
  // A steer still joins (it keeps its Steer mark).
  expect(joined([sam(100), msg(110, "Pixel 8 (Sam Rig)", "Sam Rig", "phone", "steer")])).toEqual([false, true]);
});

test("anything drawn between breaks a run; hidden cards don't", () => {
  const a = msg(100);
  const reply: Item = { kind: "text", text: "ok", at: 105 };
  const result: Item = { kind: "result", cost_usd: 0, duration_ms: 1, turns: 1, input_tokens: 0, output_tokens: 0, cached: 0, at: 106, account: "", model: "" };
  expect(joined([a, reply, msg(110)])).toEqual([false, null, false]);
  expect(joined([a, result, msg(110)])).toEqual([false, null, true]);
  // A fork divider under the first.
  expect(joined([a, msg(110)], [[0, 7]])).toEqual([false, false]);
});

const phoneViewer: Viewer = { dev: "phone:aaaa", label: "Pixel 8 (Sam Rig)", home: { name: "home-pc", owner: "Kim Rig" } };
const rows = (items: Item[], viewer: Viewer | null) =>
  project(items, false, [], viewer).map((s) => (s.card.kind === "user" ? [s.card.sender, s.card.who, s.card.via, s.card.joined] : null));
const typedHome = (at: number): Item => msg(at);
const fromPhone = (at: number, dev = "phone:aaaa", label = "Pixel 8 (Sam Rig)", who = "Sam Rig"): Item => ({ ...msg(at, label, who, "phone"), dev }) as Item;

test("a phone sees who wrote every message but its own; typed on the home PC is its owner's", () => {
  expect(rows([typedHome(100), fromPhone(1000), fromPhone(2000, "phone:bbbb", "Galaxy (Alex Rig)", "Alex Rig")], phoneViewer)).toEqual([
    ["home-pc (Kim Rig)", "Kim Rig", "pc", false],
    ["", "", "", false],
    ["Galaxy (Alex Rig)", "Alex Rig", "phone", false],
  ]);
  // A home PC without an owner: its name.
  expect(rows([typedHome(100)], { ...phoneViewer, home: { name: "home-pc", owner: "" } })).toEqual([["home-pc", "home-pc", "pc", false]]);
  // The same person on another phone isn't this one.
  expect(rows([fromPhone(100, "phone:cccc")], phoneViewer)).toEqual([["Pixel 8 (Sam Rig)", "Sam Rig", "phone", false]]);
});

test("messages from before device ids are matched by the viewer's label", () => {
  const old = msg(100, "Pixel 8 (Sam Rig)", "Sam Rig", "phone");
  expect(rows([old], phoneViewer)).toEqual([["", "", "", false]]);
  expect(rows([msg(100, "Pixel 8 (Kim Rig)", "Kim Rig", "phone")], phoneViewer)).toEqual([["Pixel 8 (Kim Rig)", "Kim Rig", "phone", false]]);
});

test("the home PC's desktop is unchanged: its own messages have no row, the others theirs", () => {
  expect(rows([typedHome(100), fromPhone(1000)], null)).toEqual([
    ["", "", "", false],
    ["Pixel 8 (Sam Rig)", "Sam Rig", "phone", false],
  ]);
});

test("another PC's desktop with a copy: what it forwarded is its own, the home PC's shows its owner", () => {
  const desk: Viewer = { dev: "pc:work-pc", label: "work-pc (Sam Rig)", home: { name: "home-pc", owner: "Kim Rig" } };
  const forwarded = { ...msg(1000, "work-pc (Sam Rig)", "Sam Rig", "pc"), dev: "pc:work-pc" } as Item;
  const before = msg(2000, "work-pc (Sam Rig)", "Sam Rig", "pc");
  expect(rows([typedHome(100), forwarded, before, fromPhone(3000)], desk)).toEqual([
    ["home-pc (Kim Rig)", "Kim Rig", "pc", false],
    ["", "", "", false],
    ["", "", "", false],
    ["Pixel 8 (Sam Rig)", "Sam Rig", "phone", false],
  ]);
});

test("runs follow the viewer: the home PC's messages join on a phone, its own join too, a switch breaks them", () => {
  expect(rows([typedHome(100), typedHome(110), fromPhone(120), fromPhone(130), typedHome(140)], phoneViewer).map((r) => r?.[3])).toEqual([false, true, false, true, false]);
  // On the home desktop the same run reads the other way round.
  expect(rows([typedHome(100), typedHome(110), fromPhone(120), fromPhone(130)], null).map((r) => r?.[3])).toEqual([false, true, false, true]);
});
