// Open Site Request: the SpokPay agent's draft vs "Use the message" pressed while it drafts (siterequests.ts).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppData, Message, Person } from "../src/model/types.ts";
import { SiteRequests } from "../src/siterequests.ts";
import { createSpokpay } from "../src/spokpay.ts";
import type { Proposal } from "../src/spokpay-core.ts";
import { emptyBrief, takeOver, turnReply } from "../src/spokpay-view.ts";

const DRAFT = '```json\n{"store":"larpstore","category":"website","subject":"Banner da Larp","details":"Um banner com a coroa.","brief":{"change":"Banner"},"why":"Ele pediu um banner."}\n```';

describe("turnReply: the agent's answer in its chat", () => {
  const user = { kind: "user", text: "Propose…" };
  it("waits while the turn runs, is queued, or hasn't started", () => {
    expect(turnReply({ items: [user, { kind: "text", text: DRAFT }], running: true })).toEqual({ done: false });
    expect(turnReply({ items: [user], queued: 1 })).toEqual({ done: false });
    expect(turnReply({ items: [user] })).toEqual({ done: false });
    expect(turnReply({})).toEqual({ done: false });
  });
  it("takes the texts after the prompt", () => {
    expect(turnReply({ items: [user, { kind: "hidden" }, { kind: "text", markdown: "a" }, { kind: "text", text: "b" }] })).toEqual({ done: true, text: "a\n\nb" });
  });
  it("a turn that ended in an error says so instead of polling on", () => {
    expect(turnReply({ items: [user, { kind: "error", text: "Stopped." }] })).toEqual({ done: true, error: "Stopped." });
  });
});

describe("takeOver: the agent's draft over the message's proposal", () => {
  const f = { category: "website" as const, subject: "s", details: "d", brief: { ...emptyBrief(), change: "c" } };
  const p = (state: Proposal["state"], shown = f) => ({ state, agent: f, shown });
  it("replaces one that still waits as it was made", () => {
    expect(takeOver(p({ kind: "waiting" }))).toBe("replace");
    expect(takeOver(p({ kind: "failed", at: 1, reason: "x", fix: "none" }))).toBe("replace");
  });
  it("leaves edited, opened and discarded ones", () => {
    expect(takeOver(p({ kind: "waiting" }, { ...f, subject: "mine" }))).toBe("edited");
    expect(takeOver(p({ kind: "opening", startedAt: 1 }))).toBe("opened");
    expect(takeOver(p({ kind: "opened", at: 1, ref: "SR-1" }))).toBe("opened");
    expect(takeOver(p({ kind: "discarded", at: 1 }))).toBe("gone");
    expect(takeOver(undefined)).toBe("gone");
  });
});

describe("SiteRequests: Use the message while the agent drafts", () => {
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ph-siterequests-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const person: Person = { id: "p1", name: "Larp", discordId: "1", discordUsername: "larp", storeIds: [], listIds: ["spokpay"], createdAt: "", updatedAt: "" };
  const message: Message = { id: "m1", channelId: "c", authorId: "1", fromMe: false, content: "Era pra fazer tipo esse banner\ncom o logo da larp", timestamp: "2026-11-27T17:07:00Z" };
  const data: AppData = { version: 1, people: [person], stores: [], lists: [], updatedAt: "" };

  /** Hub's API: the SpokPay project, a chat whose turn answers `reply` once `release()` is called. */
  const rig = (reply: { kind: string; text?: string }[]) => {
    let done = false;
    const calls: string[] = [];
    const call = async (method: string, p: string) => {
      calls.push(`${method} ${p}`);
      if (p === "v1/state") return { status: 200, body: { projects: [{ id: 7, name: "spokpay", path: "/x/spokpay" }] } };
      if (method === "POST" && p === "v1/chats") return { status: 200, body: { id: 1076 } };
      if (p === "v1/chats/1076/items") return { status: 200, body: done ? { items: [{ kind: "user", text: "Propose" }, ...reply], running: false, queued: 0 } : { items: [{ kind: "user", text: "Propose" }], running: true, queued: 0 } };
      return { status: 404, body: { error: "no" } };
    };
    const sp = createSpokpay({ dir, fetch: async () => new Response("{}", { status: 401 }) });
    const logs: string[] = [];
    const sites = new SiteRequests(sp, call, () => {}, async () => null, { pollMs: 5, log: (...a) => logs.push(a.join(" ")) });
    return { sp, sites, logs, calls, release: () => (done = true) };
  };
  const until = async (ok: () => boolean): Promise<void> => {
    for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(ok()).toBe(true);
  };
  const start = (sites: SiteRequests) => sites.fromMessage({ person, message, recent: [message], account: "spokpay", handle: "larp", data });

  it("the agent's draft becomes the proposal", async () => {
    const r = rig([{ kind: "text", text: DRAFT }]);
    start(r.sites);
    await until(() => r.calls.some((c) => c.startsWith("GET v1/chats/1076")));
    expect(r.sites.proposing("p1")).toHaveLength(1);
    r.release();
    await until(() => r.sites.proposals("p1").length === 1);
    expect(r.sites.proposing("p1")).toHaveLength(0);
    expect(r.sites.proposals("p1")[0]).toMatchObject({ from: { name: "SpokPay agent", chat: "1076" }, shown: { subject: "Banner da Larp" } });
  });

  it("pressed while drafting: the message's proposal now, replaced by the agent's draft when it comes unedited", async () => {
    const r = rig([{ kind: "text", text: DRAFT }]);
    start(r.sites);
    await until(() => r.calls.some((c) => c.startsWith("GET v1/chats/1076")));
    await r.sites.local("m1", { person, message, recent: [message], data });
    // the card is gone, the message's proposal shows, the agent keeps going
    expect(r.sites.proposing("p1")).toHaveLength(0);
    const [local] = r.sites.proposals("p1");
    expect(local).toMatchObject({ from: { name: "You" }, shown: { subject: "Era pra fazer tipo esse banner" } });
    r.release();
    await until(() => r.sites.proposals("p1")[0]?.from.name === "SpokPay agent");
    const all = r.sites.proposals("p1");
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: local!.id, from: { name: "SpokPay agent", chat: "1076" }, why: "Ele pediu um banner.", shown: { subject: "Banner da Larp" }, agent: { subject: "Banner da Larp" }, store: { slug: "larpstore" } });
  });

  it("an edited or opened one stays the user's", async () => {
    const r = rig([{ kind: "text", text: DRAFT }]);
    start(r.sites);
    await until(() => r.calls.some((c) => c.startsWith("GET v1/chats/1076")));
    await r.sites.local("m1", { person, message, recent: [message], data });
    const [local] = r.sites.proposals("p1");
    r.sp.saveProposal(local!.id, { fields: { ...local!.shown, subject: "Mine" } });
    r.release();
    await until(() => r.logs.some((l) => l.includes("kept aside")));
    expect(r.sites.proposals("p1")).toHaveLength(1);
    expect(r.sites.proposals("p1")[0]).toMatchObject({ from: { name: "You" }, shown: { subject: "Mine" } });
    expect(r.logs.join("\n")).toContain("was edited");
  });

  it("Cancel drops the agent's draft (and stops reading its chat)", async () => {
    const r = rig([{ kind: "text", text: DRAFT }]);
    start(r.sites);
    await until(() => r.calls.some((c) => c.startsWith("GET v1/chats/1076")));
    r.sites.dismiss("m1");
    r.release();
    await until(() => r.logs.some((l) => l.includes("dropped")));
    expect(r.sites.proposals("p1")).toHaveLength(0);
  });

  it("a turn that ends in an error shows it on the card; Use the message then makes the proposal", async () => {
    const r = rig([{ kind: "error", text: "Stopped." }]);
    start(r.sites);
    r.release();
    await until(() => !!r.sites.proposing("p1")[0]?.error);
    expect(r.sites.proposing("p1")[0]!.error).toContain("Stopped.");
    await r.sites.local("m1", { person, message, recent: [message], data });
    expect(r.sites.proposing("p1")).toHaveLength(0);
    expect(r.sites.proposals("p1")[0]).toMatchObject({ from: { name: "You" } });
  });
});
