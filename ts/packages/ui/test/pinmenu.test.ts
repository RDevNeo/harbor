import { expect, test } from "bun:test";
import type { pins } from "@harbor/store";
import { chipPin, pinNotice, pinRows } from "../src/logic/pinmenu.ts";

const pinned = (account: string | null, scope: "chat" | "project" = "chat", why = ""): pins.Pinned => ({ pin: { account: account ?? "x", kind: "claude", ident: "", label: "Claude · IG" }, scope, account, why });
const sel = { account: "claude2", name: "Claude · IG" };
const base = { chat: true, pinned: null, pinName: "", sel, waiting: null, project: "harbor" };
const labels = (r: ReturnType<typeof pinRows>) => r.rows.map((x) => x.label);

test("the picker's pin rows: keep this chat on its account, unpin, use another this time", () => {
  expect(pinRows(base)).toEqual({ rows: [{ label: "Keep this chat on Claude · IG", sub: "Harbor won't switch its account by itself", warn: false, enabled: true }], acts: [{ kind: "pin", account: "claude2" }] });
  const on = { ...base, pinned: pinned("claude2"), pinName: "Claude · IG" };
  expect(labels(pinRows(on))).toEqual(["Unpin from Claude · IG"]);
  expect(pinRows(on).acts).toEqual([{ kind: "unpin" }]);
  // Waiting at the limit: one click goes on elsewhere this time; with nowhere to go, only Unpin.
  expect(labels(pinRows({ ...on, waiting: { other: "Claude · FS" } }))).toEqual(["Use Claude · FS this time", "Unpin from Claude · IG"]);
  expect(pinRows({ ...on, waiting: { other: "Claude · FS" } }).acts[0]).toEqual({ kind: "other" });
  expect(labels(pinRows({ ...on, waiting: { other: null } }))).toEqual(["Unpin from Claude · IG"]);
});

test("a broken pin: an amber line that does nothing, and Unpin for the chat's own; picking another account is the other way out", () => {
  const r = pinRows({ ...base, pinned: pinned(null, "chat", "is signed out"), pinName: "Claude · IG" });
  expect(r.rows[0]).toEqual({ label: "Pinned to Claude · IG, which is signed out", sub: "Pick another account above, or unpin", warn: true, enabled: false });
  expect(r.acts).toEqual([{ kind: "none" }, { kind: "unpin" }]);
  // Its project's: the chat can't unpin it here.
  expect(pinRows({ ...base, pinned: pinned(null, "project", "isn't on this PC"), pinName: "Claude · IG" }).acts).toEqual([{ kind: "none" }]);
});

test("a project's pin: the chat can pin itself to another account; the draft just says where new chats go", () => {
  const p = pinned("claude", "project");
  expect(labels(pinRows({ ...base, pinned: p, pinName: "Claude · CL" }))).toEqual(["Keep this chat on Claude · IG"]);
  expect(pinRows({ ...base, pinned: p, pinName: "Claude · CL" }).rows[0]?.sub).toBe("Its project keeps it on Claude · CL; this pins the chat itself");
  expect(labels(pinRows({ ...base, pinned: pinned("claude2", "project"), pinName: "Claude · IG" }))).toEqual(["Kept on Claude · IG by its project"]);
  expect(pinRows({ ...base, chat: false, pinned: p, pinName: "Claude · CL" }).rows).toEqual([{ label: "harbor keeps its chats on Claude · CL", sub: "New chats here start there; Harbor won't switch them", warn: false, enabled: false }]);
  expect(pinRows({ ...base, chat: false })).toEqual({ rows: [], acts: [] });
});

test("the composer chip's lock and the line over the composer", () => {
  expect(chipPin(null, "")).toEqual({ pin: "", tip: "" });
  expect(chipPin(pinned("claude2"), "Claude · IG")).toEqual({ pin: "ok", tip: "Pinned to Claude · IG: Harbor won't switch it" });
  expect(chipPin(pinned(null, "project", "isn't on this PC"), "Claude · IG").pin).toBe("error");
  expect(pinNotice(pinned("claude2"), "Claude · IG", null)).toBe("");
  expect(pinNotice(pinned("claude2"), "Claude · IG", "at 14:05")).toBe("Pinned to Claude · IG: waiting for its limit to reset (at 14:05). The account menu below can use another account this time, or unpin.");
  expect(pinNotice(pinned(null, "chat", "is signed out"), "Claude · IG", null)).toStartWith("Pinned to Claude · IG, which is signed out. Messages wait");
});
