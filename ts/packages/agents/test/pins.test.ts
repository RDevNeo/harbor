import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Chat, pins, Store } from "@harbor/store";
import { Engine } from "../src/engine.ts";
import type { Account } from "../src/providers.ts";
import { teamTool } from "../src/tools.ts";

// No turn runs here: every call below is refused, or moves a chat that hasn't started and has nothing waiting.
const base = mkdtempSync(join(tmpdir(), "hts-pins-"));
const env = { XDG_STATE_HOME: process.env.XDG_STATE_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
process.env.XDG_STATE_HOME = join(base, "state");
process.env.XDG_DATA_HOME = join(base, "data");
afterAll(() => {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(base, { recursive: true, force: true });
});

const claude = (id: string, badge: string, over: Partial<Account> = {}): Account => ({ id, kind: "Claude", name: "Claude", email: `${badge.toLowerCase()}@example.com`, badge, plan: "", configDir: null, bin: "/nonexistent/claude", loggedIn: true, usage: [], ...over });
const codex: Account = { id: "codex", kind: "Codex", name: "Codex", email: "", badge: "", plan: "", configDir: null, bin: "/nonexistent/codex", loggedIn: true, usage: [] };

const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

function setup(accounts: Account[] = [claude("claude", "CL"), claude("claude3", "FS"), codex]) {
  const store = Store.openTemp();
  stores.push(store);
  const repo = store.addRepo(join(base, "proj"));
  const mk = (over: Partial<Chat>): Chat =>
    store.createChat({ id: 0, repoId: repo, title: "t", sessionId: crypto.randomUUID(), started: false, account: "claude", model: "", effort: "", access: "full", settled: false, updated: 0, role: "chat", parent: null, name: "", device: "", gid: crypto.randomUUID(), home: "", homeId: 0, retired: false, ...over });
  const lead = mk({ role: "lead", name: "lead", account: "claude3" });
  const sub = mk({ role: "sub", parent: lead.id, name: "worker", account: "claude" });
  const list = { accounts };
  const e = new Engine({ store, accounts: () => list.accounts, changed: () => {} });
  e.reload();
  return { e, store, repo, lead, sub, list };
}

test("switch_agent_account refuses a subagent the user pinned (itself or through its project); the user still moves it, and the pin follows", async () => {
  const { e, store, repo, lead, sub } = setup();
  e.pinChat(sub.id, "claude");
  expect(e.pinOf(sub.id)).toMatchObject({ scope: "chat", account: "claude", why: "" });
  await expect(teamTool(e, lead, "switch_agent_account", { agent: "worker", account: "claude3" })).rejects.toThrow("worker stays on Claude · CL: it's pinned to that account by the user, so Harbor won't switch it");
  expect(e.chat(sub.id)?.account).toBe("claude");
  // The pinned account itself is no move.
  expect(await teamTool(e, lead, "switch_agent_account", { agent: "worker", account: "claude" })).toBe("worker is already on Claude · CL (account 'claude').");
  // list_agents tells the lead not to.
  expect(await teamTool(e, lead, "list_agents", {})).toContain("[pinned by the user to Claude · CL: don't switch it]");
  // The user moves it by hand: allowed, and the pin goes with it.
  expect(e.switchAccount(sub.id, "claude3", { why: "switched by hand", byUser: true })).toStartWith("Moved worker to Claude · FS");
  expect(e.pinOf(sub.id)).toMatchObject({ scope: "chat", account: "claude3" });
  // Unpinned, its project's pin governs it: the lead is refused again, with why.
  e.pinChat(sub.id, null);
  expect(e.pinOf(sub.id)).toBeNull();
  e.pinProject(repo, "claude3");
  expect(e.pinOf(sub.id)).toMatchObject({ scope: "project", account: "claude3" });
  await expect(teamTool(e, lead, "switch_agent_account", { agent: "worker", account: "codex" })).rejects.toThrow("its project is pinned to that account by the user");
  expect(store.chat(sub.id)?.account).toBe("claude3");
});

test("spawn_agent and open_chat in a pinned project: its account by default, another named one refused; a lead's own pin doesn't pass to its agents", async () => {
  const { e, repo, lead, sub, list } = setup();
  // The lead's own chat pin: its subagents aren't pinned by it.
  e.pinChat(lead.id, "claude3");
  expect(e.pinOf(lead.id)?.scope).toBe("chat");
  expect(e.pinOf(sub.id)).toBeNull();
  // The project's pin.
  e.pinProject(repo, "claude");
  expect(e.pinOf(sub.id)).toMatchObject({ scope: "project", account: "claude" });
  // The lead's own pin still wins for the lead.
  expect(e.pinOf(lead.id)).toMatchObject({ scope: "chat", account: "claude3" });
  expect(e.projectAccount(repo, "claude3")).toBe("claude");
  expect(e.projectAccount(null, "claude3")).toBe("claude3");
  await expect(teamTool(e, lead, "spawn_agent", { name: "b", task: "do it", account: "claude3" })).rejects.toThrow("the user pinned this project to Claude · CL (account 'claude')");
  await expect(teamTool(e, lead, "open_chat", { prompt: "hi", account: "codex" })).rejects.toThrow("the user pinned this project to Claude · CL");
  expect(await teamTool(e, lead, "list_models", {})).toStartWith("The user pinned this project to Claude · CL");
  // The pinned account signed out: new agents aren't put elsewhere, they're refused with why.
  list.accounts = [claude("claude", "CL", { loggedIn: false }), claude("claude3", "FS"), codex];
  expect(() => e.projectAccount(repo, "claude3")).toThrow("is pinned to Claude · CL, which is signed out");
  await expect(teamTool(e, lead, "spawn_agent", { name: "c", task: "do it" })).rejects.toThrow("which is signed out");
});

test("a pick by hand in a chat its project pins makes the pick the chat's own pin; unpinning the project frees the rest", () => {
  const { e, store, repo, lead, sub } = setup();
  e.pinProject(repo, "claude");
  expect(e.pickedByHand(sub.id, "claude")).toBe(false);
  expect(e.pickedByHand(sub.id, "claude3")).toBe(true);
  expect(e.pinOf(sub.id)).toMatchObject({ scope: "chat", account: "claude3" });
  expect(e.transcript(sub.id).items.some((i) => i.kind === "notice" && i.text === "Pinned to Claude · FS now (picked by hand)")).toBe(true);
  e.pinProject(repo, null);
  expect(e.pinOf(lead.id)).toBeNull();
  expect(e.pinOf(sub.id)?.scope).toBe("chat");
  // Kept in kv by the chat's gid and the project's key, so it holds across a restart (and syncs as an account setting).
  expect(pins.parsePin(store.get(pins.chatPinKey(sub.gid)))?.account).toBe("claude3");
  const again = new Engine({ store, accounts: () => [claude("claude", "CL"), claude("claude3", "FS"), codex], changed: () => {} });
  again.reload();
  expect(again.pinOf(sub.id)).toMatchObject({ scope: "chat", account: "claude3" });
});

test("another PC: the pin finds the same sign-in under its own id there, or says it isn't there", () => {
  const { e, store, sub } = setup();
  e.pinChat(sub.id, "claude");
  // The same store read by a PC where that sign-in is "claude7", and by one without it.
  const there = new Engine({ store, accounts: () => [claude("claude7", "CL"), claude("claude3", "FS")], changed: () => {} });
  there.reload();
  expect(there.pinOf(sub.id)).toMatchObject({ account: "claude7", why: "" });
  const none = new Engine({ store, accounts: () => [claude("claude3", "FS")], changed: () => {} });
  none.reload();
  expect(none.pinOf(sub.id)).toMatchObject({ account: null, why: "isn't on this PC" });
});

test("a message to a chat whose pinned account is signed out waits, with a notice, on the same account; nothing switches", () => {
  const { e, lead, list } = setup();
  e.store.set("limit_switch", "1");
  e.store.set("limit_switch_accounts", '["claude"]');
  e.pinChat(lead.id, "claude3");
  list.accounts = [claude("claude", "CL"), claude("claude3", "FS", { loggedIn: false }), codex];
  e.send(lead.id, "hello");
  expect(e.running(lead.id)).toBe(false);
  expect(e.chat(lead.id)?.account).toBe("claude3");
  expect(e.pending.get(lead.id)).toEqual(["hello"]);
  expect(e.transcript(lead.id).items.some((i) => i.kind === "notice" && i.text === "Pinned to Claude · FS, which is signed out: pick another account or unpin this chat")).toBe(true);
});
