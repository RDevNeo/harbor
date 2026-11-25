import { describe, expect, test } from "bun:test";
import { aiFolds, aiPreview, chatRows, fitImage, listRows, shortAgo, sideRows, type ChatJson, type PersonJson, type StateJson, type UiState } from "../src/tabs/persons/view.ts";

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

describe("the Person AI's answer", () => {
  test("its markdown becomes Projects' blocks and its ```reply drafts cards, in order", async () => {
    const { aiSlintParts, DRAFT_GAP } = await import("../src/tabs/persons/aiparts.ts");
    // as the engine splits it (persons aiparts.ts, tested there)
    const parts = aiSlintParts([
      { type: "text", text: "The payment side is fixed.\n\n- **#28853 is paid.** Approved at 00:29.\n- Deliver to `Rafarib113`.\n\nHere's an update:" },
      { type: "draft", text: "Opa Yagas, verifiquei aqui." },
      { type: "text", text: "Anything else?" },
    ]);
    expect(parts.map((p) => (p.draft ? `draft:${p.text}` : p.block.kind))).toEqual(["p", "li", "li", "p", "draft:Opa Yagas, verifiquei aqui.", "p"]);
    // no literal markers left: bold and inline code are styling, the bullet is the list's
    expect(parts[1]?.block.plain).toBe("#28853 is paid. Approved at 00:29.");
    expect(parts[2]?.block.plain).toBe("Deliver to Rafarib113.");
    const { blocks } = await import("../src/markdown.ts");
    expect(blocks("**#28853 is paid.** Approved", true)[0]).toMatchObject({ text: "**\\#28853 is paid\\.** Approved" });
    expect(parts.every((p) => !p.block.plain.includes("**") && !p.block.plain.includes("```"))).toBe(true);
    // a bubble's spacing: half of Projects' blank row, and a gap around the draft
    expect(parts.map((p) => p.block.gap)).toEqual([0, 11, 0, 11, 0, 0]);
    expect(parts.map((p) => p.gap)).toEqual([0, 0, 0, 0, DRAFT_GAP, DRAFT_GAP]);
  });

  test("chat rows carry the parts; an answer without them is all markdown; a question is to the AI", () => {
    const c: ChatJson = { person: { id: "p", name: "Ana", initials: "AN", color: "#000", avatar: null, avatarPath: null, presence: null, status: null }, account: null, accounts: [], peer: null, typing: null, more: false, unreadFrom: null, messages: [], outgoing: [], ai: [
      { id: "q", role: "user", text: "Has it been resolved?", at: "2026-11-25T10:33:00" },
      { id: "a", role: "assistant", text: "**Yes.**", at: "2026-11-25T10:35:00" },
    ] };
    const rows = chatRows(c, Date.parse("2026-11-25T12:00:00")).filter((r) => r.kind !== "day");
    expect(rows.map((r) => [r.kind, r.toAi, r.meta, r.parts])).toEqual([
      ["out", true, "", []],
      ["ai", false, "", [{ type: "text", text: "**Yes.**" }]],
    ]);
  });

  test("older answers start folded, the newest one open; the user's toggle wins; one being written never folds", () => {
    const c: ChatJson = { person: { id: "p", name: "Ana", initials: "AN", color: "#000", avatar: null, avatarPath: null, presence: null, status: null }, account: null, accounts: [], peer: null, typing: null, more: false, unreadFrom: null, messages: [], outgoing: [], ai: [
      { id: "1", role: "assistant", text: "old", at: "2026-11-24T10:00:00", parts: [{ type: "text", text: "First **answer**." }, { type: "draft", text: "Opa Ana" }] },
      { id: "2", role: "assistant", text: "mid", at: "2026-11-25T09:00:00" },
      { id: "q", role: "user", text: "And now?", at: "2026-11-25T10:00:00" },
      { id: "3", role: "assistant", text: "new", at: "2026-11-25T10:01:00" },
    ] };
    const folds = (toggled = new Map<string, boolean>(), cc = c) => aiFolds(chatRows(cc), toggled).filter((r) => r.kind === "ai").map((r) => `${r.id}:${r.folded ? "folded" : "open"}`);
    expect(folds()).toEqual(["ai1:folded", "ai2:folded", "ai3:open"]);
    // the user opened an old one and folded the newest: kept, also once a newer answer comes
    const t = new Map([["ai1", false], ["ai3", true]]);
    expect(folds(t)).toEqual(["ai1:open", "ai2:folded", "ai3:folded"]);
    const more = { ...c, ai: [...c.ai, { id: "4", role: "assistant" as const, text: "", at: "2026-11-25T10:05:00", streaming: true }] };
    expect(folds(t, more)).toEqual(["ai1:open", "ai2:folded", "ai3:folded", "ai4:open"]);
    // a folded answer keeps its first draft and a plain preview
    const r = chatRows(c).find((x) => x.id === "ai1")!;
    expect([r.preview, r.draft]).toEqual(["First answer.", "Opa Ana"]);
  });

  test("a folded answer's preview is one plain paragraph", () => {
    expect(aiPreview([{ type: "text", text: "The payment is fixed.\n\n- **#28853 is paid.** See [the order](https://x.y/1).\n- Deliver to `Rafarib113`.\n\n```\ncode\n```" }, { type: "draft", text: "Opa" }])).toBe("The payment is fixed. #28853 is paid. See the order. Deliver to Rafarib113. code");
    expect(aiPreview([{ type: "text", text: "x".repeat(500) }]).length).toBe(400);
  });
});
