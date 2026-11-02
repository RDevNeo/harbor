import { afterEach, expect, test } from "bun:test";
import { itemJson, parseItem, type Item } from "@harbor/store";
import { knowDevices, project, sentBy } from "../src/index.ts";

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
