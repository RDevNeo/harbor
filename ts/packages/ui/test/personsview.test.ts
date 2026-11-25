import { describe, expect, test } from "bun:test";
import { chatRows, fitImage, listRows, shortAgo, sideRows, type ChatJson, type PersonJson, type StateJson, type UiState } from "../src/tabs/persons/view.ts";

const row = (lastAt: string | null, unread = 0) => ({ lastAt, unread, presence: null, status: null, channel: "discord", typing: null });
const person = (id: string, name: string, o: Partial<PersonJson> = {}, lastAt: string | null = null): PersonJson => ({
  id,
  name,
  initials: name.slice(0, 2).toUpperCase(),
  color: "#3b82f6",
  avatar: null,
  avatarPath: null,
  storeIds: [],
  listIds: [],
  settled: {},
  rows: { "": row(lastAt), stores: row(lastAt), spokpay: row(lastAt, 2), creators: row(lastAt) },
  search: name.toLowerCase(),
  ...o,
});

const state = (): StateJson => ({
  rev: 1,
  unread: 0,
  connections: [{ id: "stores", kind: "discord", section: "stores", status: "connected", gateway: "up", label: "Discord", who: "igor", error: null, qr: null, contacts: null }],
  stores: [
    { id: "s2", name: "Shark Store", color: "#10b981", image: null, imagePath: null, ownerId: "o", count: 2 },
    { id: "s1", name: "Meoow Store", color: "#3b82f6", image: null, imagePath: null, ownerId: null, count: 0 },
  ],
  lists: [{ id: "creators", name: "Creators", accountId: "gmail" }, { id: "spokpay", name: "SpokPay", accountId: "spokpay" }],
  people: [
    person("o", "Owner", { storeIds: ["s2"] }, "2026-11-20T10:00:00Z"),
    person("m", "Member", { storeIds: ["s2"] }, "2026-11-24T10:00:00Z"),
    person("a", "Ana", { listIds: ["spokpay"] }, "2026-11-23T10:00:00Z"),
    person("b", "Bia", { listIds: ["spokpay"] }, "2026-11-24T12:00:00Z"),
    person("z", "Zed", { listIds: ["spokpay"], settled: { spokpay: true } }),
  ],
});
const ui = (o: Partial<UiState> = {}): UiState => ({ closed: new Set(), stores: new Set(), settledOpen: new Set(), open: null, allActive: true, ...o });

describe("Persons sidebar", () => {
  test("stores sorted by name, folded until opened; an opened store lists its owner first, then members by last message", () => {
    const folded = sideRows(state(), ui()).map((r) => `${r.kind}:${r.name}`);
    expect(folded.slice(0, 4)).toEqual(["all:All people", "section:STORES", "store:Meoow Store", "store:Shark Store"]);
    // A store's lead square shows its initial when it has no picture (ds-list.slint LeadLetter).
    expect(sideRows(state(), ui()).filter((r) => r.kind === "store").map((r) => r.initials)).toEqual(["M", "S"]);
    const open = sideRows(state(), ui({ stores: new Set(["s2"]) }));
    const shark = open.findIndex((r) => r.kind === "store" && r.id === "s2");
    expect(open.slice(shark + 1, shark + 3).map((r) => [r.name, r.owner, r.depth])).toEqual([["Owner", true, 1], ["Member", false, 1]]);
  });

  test("a list's people by newest message, the settled ones in a folded Settled (N)", () => {
    const rows = sideRows(state(), ui());
    const i = rows.findIndex((r) => r.kind === "section" && r.section === "spokpay");
    expect(rows[i]!.unread).toBe(4);
    expect(rows.slice(i + 1).map((r) => `${r.kind}:${r.name || r.count}`)).toEqual(["person:Bia", "person:Ana", "settled:1"]);
    const unfolded = sideRows(state(), ui({ settledOpen: new Set(["spokpay"]) }));
    expect(unfolded.at(-1)).toMatchObject({ kind: "person", name: "Zed", dim: true });
  });

  test("a folded section hides its rows; only the row the person was opened from is active", () => {
    const rows = sideRows(state(), ui({ closed: new Set(["spokpay"]), open: { id: "m", section: "stores", store: "s2" }, stores: new Set(["s2"]) }));
    expect(rows.at(-1)).toMatchObject({ kind: "section", section: "spokpay", expanded: false });
    expect(rows.filter((r) => r.active).map((r) => r.id)).toEqual(["m"]);
  });

  test("All people: search over names and ids, newest first", () => {
    expect(listRows(state(), "", null).map((r) => r.name)).toEqual(["Bia", "Member", "Ana", "Owner", "Zed"]);
    expect(listRows(state(), "an", null).map((r) => r.name)).toEqual(["Ana"]);
  });
});

describe("Persons chat rows", () => {
  const msg = (id: string, at: string, fromMe = false, o: Partial<ChatJson["messages"][number]> = {}) => ({ id, fromMe, text: id, at, edited: false, subject: null, threadId: null, status: null, voice: false, embed: false, reply: null, files: [], ...o });
  const chat = (o: Partial<ChatJson> = {}): ChatJson => ({
    person: { id: "p", name: "Ana", initials: "AN", color: "#000", avatar: null, avatarPath: null, presence: null, status: null },
    account: { id: "stores", kind: "discord", section: "stores", label: "Discord", connected: true },
    accounts: [],
    peer: "1",
    typing: null,
    more: false,
    unreadFrom: null,
    messages: [],
    outgoing: [],
    ai: [],
    ...o,
  });

  test("day separators, the unread line, groups by side and time, AI bubbles by time", () => {
    const now = Date.parse("2026-11-25T12:00:00");
    const rows = chatRows(chat({
      messages: [msg("a", "2026-11-24T10:00:00"), msg("b", "2026-11-24T10:02:00"), msg("c", "2026-11-25T09:00:00", true), msg("d", "2026-11-25T09:30:00")],
      unreadFrom: "d",
      ai: [{ id: "1", role: "assistant", text: "draft", at: "2026-11-25T09:40:00" }],
    }), now);
    expect(rows.map((r) => (r.kind === "msg" ? `${r.id}${r.first ? "*" : ""}` : r.kind === "day" ? r.text : r.kind))).toEqual(["Yesterday", "a*", "b", "Today", "c*", "unread", "d*", "ai"]);
  });

  test("email subjects start a thread; pictures fit the bubble; failed sends are marked", () => {
    const rows = chatRows(chat({
      messages: [msg("e1", "2026-11-25T09:00:00Z", false, { subject: "Parceria", threadId: "t1", files: [{ name: "a.png", url: "/f", raw: "x", type: "image/png", size: 1, width: 1000, height: 500, kind: "image", image: true, duration: null }] })],
      outgoing: [{ key: "k", text: "oi", status: "failed", error: "paced", at: "2026-11-25T09:10:00Z", subject: null, files: [] }],
    }));
    expect(rows.map((r) => r.kind)).toEqual(["day", "subject", "msg", "out"]);
    expect([rows[2]!.imgW, rows[2]!.imgH]).toEqual([280, 140]);
    expect(rows[3]).toMatchObject({ failed: true, meta: "paced" });
    expect(fitImage(null, null)).toEqual([280, 185]);
  });

  test("shortAgo", () => {
    const now = Date.parse("2026-11-25T12:00:00Z");
    expect(shortAgo("2026-11-25T11:59:30Z", now)).toBe("now");
    expect(shortAgo("2026-11-25T11:00:00Z", now)).toBe("1h ago");
    expect(shortAgo("2026-11-22T12:00:00Z", now)).toBe("3d ago");
  });
});
