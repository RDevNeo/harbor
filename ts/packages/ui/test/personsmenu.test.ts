import { describe, expect, test } from "bun:test";
import { aiMenu, blockedNote, composerHint, groupMove, messageMenu, moveEntries, placeOfRow, quoteInto, type MsgMenuIn } from "../src/tabs/persons/menus.ts";
import { chatRows, proposalCard, type ChatJson, type ProposalJson } from "../src/tabs/persons/view.ts";

const base: MsgMenuIn = { fromMe: false, hasText: true, hasFiles: false, canSend: true, aiOn: true, siteRequests: false };
const labels = (m: Partial<MsgMenuIn>): string[] => messageMenu({ ...base, ...m }).map((e) => (e.sep ? "|" : e.label));

describe("a site request message's menu (the same menu, as far as SpokPay's admin API goes)", () => {
  test("the store's message: Quote, Forward to AI, Forward to Projects | Copy text, Open attachment; no Reply, Open Site Request or Mark as unread", () => {
    expect(labels({ siteRequest: true, hasFiles: true })).toEqual(["Quote", "Forward to AI", "Forward to Projects", "|", "Copy text", "Open attachment"]);
    expect(labels({ siteRequest: true, fromMe: true })).toEqual(["Quote", "Forward to AI", "Forward to Projects", "|", "Copy text"]);
  });
  test("a picture alone has nothing to quote; a finished or unwritable request only copies and opens", () => {
    expect(labels({ siteRequest: true, hasText: false, hasFiles: true })).toEqual(["Forward to AI", "Forward to Projects", "|", "Open attachment"]);
    expect(labels({ siteRequest: true, canSend: false, aiOn: false })).toEqual(["Forward to Projects", "|", "Copy text"]);
  });
  test("Quote puts the words as > lines ahead of the draft", () => {
    expect(quoteInto("", "Boa noite!\nObtiveram progresso?")).toBe("> Boa noite!\n> Obtiveram progresso?\n\n");
    expect(quoteInto("  já vejo", "sim")).toBe("> sim\n\njá vejo");
    expect(quoteInto("x", "  ")).toBe("x");
  });
});

describe("a message's menu (Person Hub's MessageMenu)", () => {
  test("their message in a chat without site requests: Reply, Forward to AI, Forward to Projects | Copy text | Mark as unread", () => {
    expect(labels({})).toEqual(["Reply", "Forward to AI", "Forward to Projects", "|", "Copy text", "|", "Mark as unread"]);
  });
  test("SpokPay people and store owners: Open Site Request after Forward to Projects", () => {
    expect(labels({ siteRequests: true })).toEqual(["Reply", "Forward to AI", "Forward to Projects", "Open Site Request", "|", "Copy text", "|", "Mark as unread"]);
  });
  test("my own message: no Mark as unread (Open Site Request still, as Person Hub)", () => {
    expect(labels({ fromMe: true, siteRequests: true })).toEqual(["Reply", "Forward to AI", "Forward to Projects", "Open Site Request", "|", "Copy text"]);
  });
  test("no text: no Copy; a file: Open attachment", () => {
    expect(labels({ hasText: false, hasFiles: true })).toEqual(["Reply", "Forward to AI", "Forward to Projects", "|", "Open attachment", "|", "Mark as unread"]);
  });
  test("signed out and no AI: no Reply, no Forward to AI, no leading separator", () => {
    expect(labels({ canSend: false, aiOn: false })).toEqual(["Forward to Projects", "|", "Copy text", "|", "Mark as unread"]);
  });
  test("Forward to Projects right under Forward to AI, only for a message with words or files", () => {
    const l = labels({ siteRequests: true });
    expect(l.indexOf("Forward to Projects")).toBe(l.indexOf("Forward to AI") + 1);
    expect(labels({ hasText: false, hasFiles: false })).not.toContain("Forward to Projects");
    expect(labels({ siteRequest: true, hasText: false, hasFiles: false })).not.toContain("Forward to Projects");
  });
  test("a site request already drafting from it: not offered again", () => {
    expect(labels({ siteRequests: true, proposing: true })).not.toContain("Open Site Request");
  });
  test("icons where Person Hub had them, the shortcut on Mark as unread, nothing red", () => {
    const m = messageMenu({ ...base, siteRequests: true, hasFiles: true });
    expect(m.filter((e) => !e.sep).map((e) => e.icon)).toEqual(["REPLY", "SPARKLES", "FOLDER_INPUT", "FILE_PLUS", "COPY", "EXTERNAL", "MAIL_WARNING"]);
    expect(m.find((e) => e.action === "unread")?.hint).toBe("Alt+Click");
    expect(m.some((e) => e.danger)).toBe(false);
  });
});

describe("an AI answer's menu", () => {
  test("each ```reply draft, then Copy", () => {
    const m = aiMenu({ drafts: ["Oi!", "Olá"], text: "x", canSend: true });
    expect(m.map((e) => (e.sep ? "|" : e.label))).toEqual(["Use reply 1", "Use reply 2", "|", "Copy text"]);
    expect(m[1]?.use).toBe("Olá");
  });
  test("no channel: Copy only", () => {
    expect(aiMenu({ drafts: [], text: "x", canSend: false }).map((e) => e.label)).toEqual(["Copy text"]);
  });
});

describe("the composer's words", () => {
  test("placeholders", () => {
    expect(composerHint({ toAi: false, forwarded: false, name: "Lua", kind: "discord", me: "" })).toBe("Message Lua on Discord");
    expect(composerHint({ toAi: false, forwarded: false, name: "Truth", kind: "spokpay", me: "" })).toBe("Message Truth on SpokPay");
    expect(composerHint({ toAi: false, forwarded: false, name: "Lua", kind: "gmail", me: "igor" })).toBe("Email Lua as igor…");
    expect(composerHint({ toAi: true, forwarded: false, name: "Lua", kind: "discord", me: "" })).toBe("Tell the AI what to do about Lua");
    expect(composerHint({ toAi: true, forwarded: true, name: "Lua", kind: "discord", me: "" })).toContain("What should I reply to this?");
  });
  test("why it can't write", () => {
    expect(blockedNote({ hasAccount: true, hasPeer: true, connected: true, kind: "discord" })).toBeNull();
    expect(blockedNote({ hasAccount: true, hasPeer: false, connected: true, kind: "gmail" })).toBe("Add their email address (Edit) to message them here.");
    expect(blockedNote({ hasAccount: true, hasPeer: true, connected: false, kind: "whatsapp" })).toContain("Sign in to WhatsApp");
    expect(blockedNote({ hasAccount: false, hasPeer: false, connected: false, kind: "" })).toContain("No channel");
  });
});

const proposal = (o: Partial<ProposalJson> = {}): ProposalJson => ({ id: "x1", at: "2026-11-25T10:00:00.000Z", messageId: "m1", store: { slug: "shark", name: "Shark Store" }, category: "website", subject: "Trocar banner", details: "Novo banner", brief: {}, why: "they asked", from: "SpokPay agent", chat: "12", images: 2, state: { kind: "waiting" }, ...o });

describe("site request cards", () => {
  test("a waiting proposal", () => {
    expect(proposalCard(proposal())).toEqual({ title: "Trocar banner", sub: "Shark Store · Website · 2 images", state: "waiting", note: "", why: "SpokPay agent: they asked", chat: true });
  });
  test("no store: asks to pick it; opened and failed say so", () => {
    expect(proposalCard(proposal({ store: null })).note).toBe("Pick the store (Edit) before opening it.");
    expect(proposalCard(proposal({ state: { kind: "opened", at: 1, ref: "SR-7" } })).note).toBe("Opened as SR-7");
    expect(proposalCard(proposal({ state: { kind: "failed", at: 1, reason: "no key", fix: "none" } })).note).toBe("Not opened: no key");
  });
  const chat = (o: Partial<ChatJson>): ChatJson => ({ person: { id: "p", name: "Lua", initials: "LU", color: "#000", avatar: null, avatarPath: null, presence: null, status: null }, account: null, accounts: [], peer: null, typing: null, more: false, unreadFrom: null, messages: [], outgoing: [], ai: [], ...o });
  test("proposals and drafting ones sit in the chat by time", () => {
    const rows = chatRows(chat({ proposals: [proposal()], proposing: [{ personId: "p", messageId: "m2", at: "2026-11-25T10:05:00.000Z", chat: null, error: null }] }), Date.parse("2026-11-25T12:00:00Z"));
    expect(rows.map((r) => r.kind)).toEqual(["day", "proposal", "proposing"]);
    expect(rows[2]?.card.state).toBe("drafting");
  });
  test("a forwarded note shows the quote and the question", () => {
    const rows = chatRows(chat({ ai: [{ id: "h1", role: "user", text: "", at: "2026-11-25T10:00:00.000Z", forwarded: { from: "Lua", text: "Oi" } }] }), Date.parse("2026-11-25T12:00:00Z"));
    expect(rows[1]).toMatchObject({ kind: "out", toAi: true, reply: "Lua: Oi", text: "What should I reply to this?" });
  });
});

describe("moveEntries", () => {
  const stores = [{ id: "b", name: "Beta" }, { id: "a", name: "Alfa" }];
  test("SpokPay, Creators, Stores › stores then New store…, Neobux, Personal; the current place checked", () => {
    const m = moveEntries({ places: ["store:a"], from: "store:a", stores });
    expect(m.map((e) => [e.to, !!e.here])).toEqual([["spokpay", false], ["creators", false], ["stores", false], ["neobux", false], ["personal", false]]);
    expect(moveEntries({ places: ["neobux"], from: "neobux", stores: [] })[3]!.here).toBe(true);
    expect(moveEntries({ places: ["personal"], from: "personal", stores: [] })[4]!.here).toBe(true);
    expect(m[2]!.sub!.map((e) => (e.sep ? "-" : `${e.label}${e.here ? " ✓" : ""}`))).toEqual(["Alfa ✓", "Beta", "-", "New store…"]);
    expect(moveEntries({ places: ["spokpay"], from: "spokpay", stores: [] })[0]!.here).toBe(true);
    expect(moveEntries({ places: [], from: "", stores: [] })[2]!.sub!.map((e) => e.to)).toEqual(["new-store"]);
  });
  test("All people: every place they're in is checked", () => {
    const m = moveEntries({ places: ["creators", "store:b"], from: "", stores });
    expect(m[1]!.here).toBe(true);
    expect(m[2]!.sub!.find((e) => e.to === "store:b")!.here).toBe(true);
    expect(placeOfRow("stores", "b")).toBe("store:b");
    expect(placeOfRow("", "")).toBe("");
    expect(placeOfRow("neobux", "")).toBe("neobux");
  });
});

describe("groupMove (SpokPay › Clients / Leads)", () => {
  test("a Lead moves to Clients, a Client to Leads, nothing outside SpokPay", () => {
    expect(groupMove({ listIds: ["spokpay"], spokpayGroup: "leads" })).toEqual({ to: "clients", label: "Move to Clients" });
    expect(groupMove({ listIds: ["spokpay"] })).toEqual({ to: "clients", label: "Move to Clients" });
    expect(groupMove({ listIds: ["creators", "spokpay"], spokpayGroup: "clients" })).toEqual({ to: "leads", label: "Move to Leads" });
    expect(groupMove({ listIds: ["creators"], spokpayGroup: "clients" })).toBeNull();
  });
});
