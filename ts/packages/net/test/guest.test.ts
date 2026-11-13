import { describe, expect, test } from "bun:test";
import { guestAccess, guestJson, guestLevel } from "../src/guest.ts";

const pcs = [
  { id: "ts:igor-win", owner: "u_igor" },
  { id: "ts:igor-linux", owner: "u_igor" },
  { id: "ts:mac", owner: "u_fagner" },
];

describe("guest: someone else's phone on this PC", () => {
  test("the owner's phones (and phones from before accounts) have no limit", () => {
    expect(guestLevel("u_fagner", "u_fagner", pcs, () => "off")).toBeNull();
    expect(guestLevel("", "u_fagner", pcs, () => "off")).toBeNull();
  });

  test("another member's phone gets the most any of their PCs gets here, full when none is set", () => {
    const levels = new Map([["ts:igor-win", "read"]]);
    const of = (pc: string) => levels.get(pc) ?? "full";
    // Only one of Igor's PCs was limited: the other still gets the default.
    expect(guestLevel("u_igor", "u_fagner", pcs, of)).toBe("full");
    levels.set("ts:igor-linux", "edit");
    expect(guestLevel("u_igor", "u_fagner", pcs, of)).toBe("edit");
    levels.set("ts:igor-linux", "off");
    levels.set("ts:igor-win", "off");
    expect(guestLevel("u_igor", "u_fagner", pcs, of)).toBe("off");
    // No PC of theirs in the directory: the levels' default.
    expect(guestLevel("u_sam", "u_fagner", pcs, () => "off")).toBe("full");
    // A level this build doesn't know is skipped.
    expect(guestLevel("u_igor", "u_fagner", pcs, () => "weird")).toBe("full");
  });

  test("whether it may start chats: within the level, with an account that runs there", () => {
    const claude = { kind: "Claude", access: ["plan", "edits", "full"] };
    const opencode = { kind: "OpenCode", access: ["full"] };
    expect(guestJson("full", "Fagner", "mac", [claude])).toEqual({ level: "full", start: true, why: null });
    expect(guestJson("read", "Fagner", "mac", [claude, opencode]).start).toBe(true);
    expect(guestJson("read", "Fagner", "mac", [opencode])).toEqual({ level: "read", start: false, why: "Fagner lets your chats only read on mac, and its accounts run with full access only" });
    expect(guestJson("off", "Fagner", "mac", [claude])).toEqual({ level: "off", start: false, why: "Fagner doesn't let your PCs' chats use mac" });
    expect(guestJson("off", "", "mac", [claude]).why).toBe("mac's owner doesn't let your PCs' chats use mac");
    expect(guestJson("full", "Fagner", "mac", [])).toEqual({ level: "full", start: false, why: "mac has no agent account signed in" });
  });

  test("a chat it starts runs at most at its level", () => {
    const all = ["plan", "edits", "full"];
    const who = { me: "mac", owner: "Fagner" };
    expect(guestAccess("full", "full", all, who)).toEqual({ access: "full" });
    expect(guestAccess("edit", "full", all, who)).toEqual({ access: "edits" });
    expect(guestAccess("read", "edits", all, who)).toEqual({ access: "plan" });
    expect(guestAccess("edit", "plan", all, who)).toEqual({ access: "plan" });
    expect(guestAccess("read", "full", ["full"], who)).toEqual({ why: "Fagner lets your chats only read on mac, and this account runs with full access only" });
    expect("why" in guestAccess("off", "plan", all, who)).toBe(true);
  });
});
