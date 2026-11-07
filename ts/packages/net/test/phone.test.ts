import { afterAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { blankChat, mention, Store, type Chat, type Item, type Mention } from "@harbor/store";
import { accountDecide, isHarborToken, verifyHarborToken, type AccountKey } from "../src/account.ts";
import { Api } from "../src/api.ts";
import { readAnswerHead } from "../src/client.ts";
import { err } from "../src/http.ts";
import { Hub } from "../src/hub.ts";
import { MemKv } from "../src/kv.ts";
import { Mesh } from "../src/mesh.ts";
import { newPeer } from "../src/shared.ts";
import { newHost, type RemoteHost } from "../src/remote.ts";
import { StoreReplica } from "../src/meshstore.ts";
import { GLYPHS } from "../src/glyphs.ts";
import { photoBook, sharedAccounts } from "../src/meshaccounts.ts";
import { cardJson, catalogOf, clock, composerDefaults, nothingToSend, PhoneRoutes, type CatalogAccount, type PhoneEngine } from "../src/phone.ts";
import { providers } from "@harbor/agents";
import { connect, generateIdentity } from "../src/tls.ts";
import { actions, project } from "../src/view.ts";
import { fixture } from "./fixture.ts";
import { wire, type Json } from "../src/wire.ts";

const tmp = mkdtempSync(join(tmpdir(), "harbor-phone-"));
const stops: (() => void)[] = [];
afterAll(() => {
  for (const s of stops) s();
  rmSync(tmp, { recursive: true, force: true });
});

const b64u = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");

/** A Harbor token as the account service signs it (PROTOCOL.md "Harbor tokens"). */
function token(key: KeyObject, claims: Record<string, unknown>): string {
  const h = b64u(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: "k1" }));
  const p = b64u(JSON.stringify(claims));
  return `${h}.${p}.${b64u(sign(null, Buffer.from(`${h}.${p}`), key))}`;
}

async function request(sock: TLSSocket, method: string, path: string, auth: string, body?: unknown): Promise<[number, unknown, string]> {
  const data = body === undefined ? "" : JSON.stringify(body);
  sock.write(`${method} ${path} HTTP/1.1\r\nHost: hub\r\nAuthorization: Bearer ${auth}\r\nX-Harbor-Device: Pixel\r\nX-Harbor-App: 108000\r\nX-Harbor-Ids: global\r\nContent-Length: ${Buffer.byteLength(data)}\r\n\r\n${data}`);
  const { head, rest } = await readAnswerHead(sock);
  let all = rest;
  await new Promise<void>((resolve) => {
    sock.on("data", (d: Buffer) => {
      all = Buffer.concat([all, d]);
    });
    sock.once("end", () => resolve());
    sock.once("close", () => resolve());
    sock.resume();
  });
  const text = all.toString();
  return [Number(head.split(" ")[1]), text === "" ? null : (JSON.parse(text) as unknown), text];
}

describe("the phone API's chats (api.rs App side)", () => {
  test("a_chat_is_exported_to_peers_with_its_pull_request_and_worktree_name", async () => {
    const store = Store.openAt(join(tmp, "export.db"));
    const c = store.createChat(blankChat({ title: "mine" }));
    const pr = { number: 7, state: "open", label: "PR #7 · Open", title: "Add it", url: "https://github.com/o/r/pull/7" };
    const hub = new Hub([], 0);
    const bare = (await new StoreReplica({ store, hub, version: "t" }).chats(0, true)).chats[0] as Record<string, Json>;
    expect([bare.pr, bare.worktree]).toEqual([null, null]);
    const status = { queue: [], working: { since_ms: 1, subagents: 2, text: "Working…  ·  2 sub-agents running" }, waiting: null, limit: null, agents: null, folder: null, can_steer: true, held: false, follow_up: "steer" };
    const replica = new StoreReplica({ store, hub, version: "t", pr: (x) => (x.id === c.id ? pr : null), worktree: () => "fix-login", forks: () => [[3, 9]], queued: () => 2, status: () => status, about: () => ({ owner: "Ana Souza", github: "anasouza", owner_suggested: true }) });
    const out = (await replica.chats(0, true)).chats[0] as Record<string, Json>;
    expect([out.pr, out.worktree, out.forks, out.queued, out.status]).toEqual([pr, "fix-login", [[3, 9]], 2, status]);
    expect(replica.helloExtra()).toMatchObject({ owner: "Ana Souza", github: "anasouza", owner_suggested: true });
    expect([bare.forks, bare.queued]).toEqual([[], 0]);
  });

  test("user_text_is_sent_in_parts_when_it_has_links_tags_or_commands", () => {
    const user = (text: string, mentions: Mention[] = []) => {
      const cards = project([{ kind: "user", text, files: [], at: 0, mentions, sender: "", intent: "" }], false, []);
      return cardJson(cards[0] as (typeof cards)[number], 1, () => [], "1");
    };
    expect(user("plain words").parts).toBeUndefined();
    const chat = mention({ kind: "chat", chat: "g-1", title: "Fix login" });
    expect(user("see Fix login /review", [chat]).parts).toEqual([{ text: "see " }, { text: "Fix login", kind: "chat", chat: "g-1" }, { text: " " }, { text: "/review", kind: "command" }]);
    expect(user("fix #4 in @src/a.ts").parts).toEqual([{ text: "fix " }, { text: "#4", kind: "tag" }, { text: " in " }, { text: "@src/a.ts", kind: "tag" }]);
  });

  test("a_mention_on_the_wire_is_its_first_line_or_its_chat_row", () => {
    const m = (over: Partial<Parameters<typeof mention>[0]>) => mention({ from: "me", ...over });
    const cards = project(
      [{ kind: "user", text: "see", files: [], at: 0, mentions: [m({ text: "\n  first line  \nsecond\n\nthird" }), m({ kind: "chat", chat: "g", title: "T", from: "Row line", text: "ignored" })], sender: "", intent: "" }],
      false,
      [],
    );
    const v = cardJson(cards[0] as (typeof cards)[number], 1, () => [], "1");
    expect(v.mentions).toEqual([
      { from: "me", text: "first line", excerpt: false, note: "" },
      { from: "Row line", text: "Row line", excerpt: false, note: "", kind: "chat", chat: "g", title: "T" },
    ]);
  });

  test("a_long_tool_result_is_cut_the_way_the_rust_hub_cuts_it", () => {
    const long = `${"é".repeat(9000)}tail`;
    const cards = project([{ kind: "tool", id: "t", name: "Bash", summary: "", input: "x".repeat(40000), result: long, is_error: false }], false, []);
    const v = cardJson(cards[0] as (typeof cards)[number], 1, () => [], "1");
    const result = String(v.result);
    expect(result).toMatch(/^(é)+\n… \(\d+ more bytes\)$/);
    const kept = Buffer.byteLength(result.split("\n… (")[0] ?? "");
    expect(kept).toBe(16384);
    expect(result.endsWith(`(${Buffer.byteLength(long) - kept} more bytes)`)).toBe(true);
    expect(String(v.input).length).toBeLessThan(16384 + 100);
  });

  test("card_images_name_their_chat", () => {
    const cards = project([{ kind: "user", text: "", files: ["/x/a.png"], at: 0, mentions: [], sender: "", intent: "" }], false, []);
    const v = cardJson(cards[0] as (typeof cards)[number], 1, () => [], "g 1");
    expect(v.images).toEqual([{ name: "a.png", url: "/v1/image?path=%2Fx%2Fa.png&max=512&chat=g%201" }]);
    const t = project([{ kind: "text", text: "hi", at: 0 }], false, []);
    expect(cardJson(t[0] as (typeof t)[number], 1, () => [], "1").images).toEqual([]);
  });

  test("the_phone_sees_what_the_desktop_draws", () => {
    const items = fixture();
    const desktop = project(items, true, [[8, 42]]);
    const phone = desktop.map((c) => cardJson(c, 1, () => [], "1"));
    expect(phone).toHaveLength(items.length);
    desktop.forEach((d, i) => {
      const p = phone[i] as Record<string, unknown>;
      expect([p.kind, p.seq, Array.isArray(p.forks_after) ? p.forks_after.length : 0]).toEqual([d.card.kind, d.seq, d.forksAfter.length]);
      expect(p.actions ?? []).toEqual(actions(d.card));
      const c = d.card;
      if (c.kind === "text") expect([p.markdown, p.forkable]).toEqual([c.text, c.forkable]);
      if (c.kind === "tool") expect(p.label).toBe(c.label);
      if (c.kind === "message") expect([p.from, p.to, p.text]).toEqual([c.from, c.to, c.text]);
      if (c.kind === "notice") expect(p.url).toBe(c.url);
    });
    expect(phone.filter((p) => p.kind !== "hidden").map((p) => p.kind)).toEqual(["user", "text", "text", "error"]);
    expect(phone[9]?.kind).toBe("hidden");
    expect(phone[8]?.forks_after).toEqual([42]);
  });

  test("card_json for a reply: blocks, actions, time, rev and the chat on image addresses", () => {
    const cards = project([{ kind: "user", text: "look", files: ["/p/a.png"], at: 1761200000, mentions: [], sender: "", intent: "" }], false, []);
    const v = cardJson(cards[0] as (typeof cards)[number], 7, () => [], "gid-1");
    expect(wire(v)).toBe(
      `{"actions":["copy","quote","mention"],"at":1761200000,"files":[],"images":[{"name":"a.png","url":"/v1/image?path=%2Fp%2Fa.png&max=512&chat=gid-1"}],"kind":"user","mentions":[],"rev":7,"sender":"","seq":0,"text":"look","time":"${clock(1761200000)}"}`,
    );
  });

  test("media_on_the_wire", () => {
    const m = (path: string, caption: string, video: boolean, shown: boolean) => ({ path, caption, video, shown, url: null });
    const refs = {
      strip: (md: string) => md.replace(/!\[[^\]]*\]\([^)]*\)/g, "").trim(),
      parts: (md: string) => md.split(/\n\n/).map((t) => (/^!\[[^\]]*\]\([^)]*\)$/.test(t.trim()) ? { type: "media" as const, text: t } : { type: "text" as const, text: t })),
    };
    const text = "See the chart\n\n![Chart](out/c.png)\n\nand the run\n\n![](/v/run.mp4)\n\nAlso /tmp/x.png";
    const cards = project([{ kind: "text", text, at: 1 }], false, []);
    const find = (t: string) =>
      t.includes("c.png") && !t.includes("run.mp4") ? [m("/p/out/c.png", "Chart", false, true)] : t.includes("run.mp4") && !t.includes("c.png") ? [m("/v/run.mp4", "", true, true)] : [m("/p/out/c.png", "Chart", false, true), m("/v/run.mp4", "", true, true), m("/tmp/x.png", "", false, false)];
    const v = cardJson(cards[0] as (typeof cards)[number], 3, find, "g1", clock, refs);
    expect(v.media).toEqual([
      { name: "c.png", caption: "Chart", kind: "image", url: "/v1/image?path=%2Fp%2Fout%2Fc.png&max=512&chat=g1", after: 1 },
      { name: "run.mp4", caption: "", kind: "video", url: "/v1/media?path=%2Fv%2Frun.mp4&chat=g1", poster: "/v1/image?path=%2Fv%2Frun.mp4&max=512&chat=g1", after: 2 },
    ]);
    expect(v.images).toHaveLength(2);
    expect(JSON.stringify(v.blocks)).not.toContain("c.png");
    expect(v.markdown).toContain("![Chart](out/c.png)");
    const plain = project([{ kind: "text", text: "hi", at: 1 }], false, []);
    expect(cardJson(plain[0] as (typeof plain)[number], 1, () => [], "1").media).toBeUndefined();
  });

  test("items_on_the_wire (without usertext parts)", () => {
    const cards = project([{ kind: "user", text: "hi", files: ["/a/b/photo.jpg", "/a/notes.txt"], at: 5, mentions: [], sender: "", intent: "" }], false, []);
    const v = cardJson(cards[0] as (typeof cards)[number], 9, () => [], "1");
    expect([v.kind, v.seq, v.rev]).toEqual(["user", 0, 9]);
    expect(v.files).toEqual(["notes.txt"]);
    expect(v.images).toEqual([{ name: "photo.jpg", url: "/v1/image?path=%2Fa%2Fb%2Fphoto.jpg&max=512&chat=1" }]);
    expect([v.actions, typeof v.time]).toEqual([["copy", "quote", "mention"], "string"]);
    expect(v.parts).toBeUndefined();
  });

  test("chat links in a reply read as their chat's title and carry what a tap opens (chat_links)", () => {
    const store = Store.openAt(join(tmp, "chatlinks.db"));
    const hub = new Hub([], 0);
    hub.mesh.on = true;
    hub.mesh.peers.set("pc:laptop", newPeer({ id: "pc:laptop", name: "laptop", online: false }));
    const replica = new StoreReplica({ store, hub, version: "t" });
    const routes = new PhoneRoutes({ store, hub, replica, mesh: null, version: "t", myFp: () => "", engine: null });
    const lead = store.createChat(blankChat({ title: "Fix login", role: "lead", name: "lead" }));
    const sub = store.createChat(blankChat({ title: "Check the API", role: "sub", parent: lead.id, name: "api" }));
    const copy = store.createChat(blankChat({ title: "Laptop's chat", home: "pc:laptop" }));
    const where = store.createChat(blankChat({ title: "where" }));
    const L = (gid: string, pc = "") => `harbor://chat/${gid}${pc === "" ? "" : `?pc=${pc}`}`;
    const text = `See ${L(sub.gid, "desk")}. Or [the lead](${L(lead.gid)}), ${L(copy.gid, "laptop")}, ${L("nope", "laptop")} and ${L("gone", "desk")}; not \`${L(lead.gid)}\`.`;
    store.saveItems(where.id, [{ kind: "text", text, at: 5 }]);
    const items = (global: boolean) => (routes.items(where, 0, null, global) as { items: Record<string, Json>[] }).items;
    const [v] = items(true);
    const links = v?.chat_links as Record<string, { title: string; chat: Json; missing: string }>;
    expect(links[L(sub.gid, "desk")]).toEqual({ title: "Fix login › api", chat: sub.gid, missing: "" });
    expect(links[L(lead.gid)]).toEqual({ title: "Fix login", chat: lead.gid, missing: "" });
    expect(links[L(copy.gid, "laptop")]).toEqual({ title: "Laptop's chat", chat: copy.gid, missing: "" });
    expect(links[L("nope", "laptop")]).toEqual({ title: "laptop is offline", chat: null, missing: "laptop is offline" });
    expect(links[L("gone", "desk")]).toEqual({ title: "Chat not found", chat: null, missing: "Chat not found" });
    // The blocks read as the titles, each span keeping the link as written; code stays as it is.
    const spans = ((v?.blocks as { spans: { text: string; link?: string }[] }[])[0]?.spans ?? []).filter((x) => x.link);
    expect(spans.map((x) => [x.text, x.link])).toEqual([
      ["Fix login › api", L(sub.gid, "desk")],
      ["the lead", L(lead.gid)],
      ["Laptop's chat", L(copy.gid, "laptop")],
      ["laptop is offline", L("nope", "laptop")],
      ["Chat not found", L("gone", "desk")],
    ]);
    expect(v?.markdown).toBe(text);
    // Without X-Harbor-Ids: global, this hub's ids.
    expect((items(false)[0]?.chat_links as Record<string, { chat: Json }>)[L(lead.gid)]?.chat).toBe(lead.id);
    // A reply without chat links sends none.
    store.saveItems(where.id, [{ kind: "text", text: "plain", at: 5 }]);
    expect(items(true)[0]?.chat_links).toBeUndefined();
    store.close();
  });

  test("each card's look is the desktop's; an earlier card comes again when its look changes", () => {
    const store = Store.openAt(join(tmp, "looks.db"));
    const hub = new Hub([], 0);
    const replica = new StoreReplica({ store, hub, version: "t" });
    const routes = new PhoneRoutes({ store, hub, replica, mesh: null, version: "t", myFp: () => "", engine: null });
    const c = store.createChat(blankChat({ title: "looks" }));
    const cap = (state: string): Item => ({ kind: "notice", icon: "captcha", text: `captcha ${state}`, detail: JSON.stringify({ captcha: "k", state, guild: "G" }) });
    const run: Item = { kind: "tool", id: "t", name: "Bash", summary: "ls", input: "{}", result: null, is_error: false };
    store.saveItems(c.id, [run, { kind: "text", text: "hi", at: 5 }, cap("pending"), { kind: "notice", icon: "report", text: "api finished", detail: "**Done**: tests" }, { kind: "notice", icon: "wake", text: "w", detail: "" }]);
    const get = (since = 0) => (routes.items(c, since, null, true) as { rev: number; items: Record<string, Json>[] });
    const first = get();
    const [t, text, pending, report, wake] = first.items;
    expect(t?.look).toEqual({ glyph: GLYPHS.LOADER, tone: "", run: { label: "1 tool call", pending: true } });
    expect(text?.look).toBeUndefined();
    expect(pending?.look).toEqual({ glyph: GLYPHS.USER_CHECK, text: "captcha pending", expandable: false, captcha: "card" });
    expect(report?.look).toMatchObject({ glyph: GLYPHS.BOT, expandable: true, blocks: [{ type: "paragraph", spans: [{ text: "Done", bold: true }, { text: ": tests" }] }] });
    expect(wake?.look).toEqual({ glyph: GLYPHS.ALARM, text: "w", expandable: false });
    // The call ends and the captcha is answered: the tool card and the pending notice come again.
    store.saveItems(c.id, [{ ...run, result: "ok" }, { kind: "text", text: "hi", at: 5 }, cap("pending"), { kind: "notice", icon: "report", text: "api finished", detail: "**Done**: tests" }, { kind: "notice", icon: "wake", text: "w", detail: "" }, cap("joined")]);
    const next = get(first.rev);
    expect(next.items.map((v) => v.seq)).toEqual([0, 2, 5]);
    expect(next.items[0]?.look).toEqual({ glyph: GLYPHS.CIRCLE_CHECK, tone: "green", run: { label: "1 tool call", pending: false } });
    expect(next.items[1]?.look).toMatchObject({ captcha: "none" });
    expect(next.items[2]?.look).toMatchObject({ captcha: "outcome", glyph: GLYPHS.USER_CHECK });
    store.close();
  });

  test("the phone sees the desktop's scope: no copies from PCs this account doesn't use, nor projects known only from them", () => {
    const store = Store.openAt(join(tmp, "scope.db"));
    const hub = new Hub([], 0);
    const replica = new StoreReplica({ store, hub, version: "t" });
    const routes = new PhoneRoutes({ store, hub, replica, mesh: null, version: "t", myFp: () => "", engine: null, scope: (home) => home === "ts:laptop" });
    const theirs = store.addRepo(join(tmp, "not-here-studio"));
    const mine = store.createChat(blankChat({ title: "mine", role: "lead" }));
    const used = store.createChat(blankChat({ title: "laptop's", role: "lead", home: "ts:laptop", homeId: 4 }));
    const hidden = store.createChat(blankChat({ title: "theirs", role: "lead", repoId: theirs, home: "ts:other", homeId: 9 }));
    const s = routes.state("tok:0", false) as { chats: { id: number }[]; projects: { id: number }[] };
    expect(s.chats.map((c) => c.id).sort()).toEqual([mine.id, used.id].sort());
    expect(s.chats.some((c) => c.id === hidden.id)).toBe(false);
    expect(s.projects.some((p) => p.id === theirs)).toBe(false);
    store.close();
  });

  test("a_retired_agent_is_not_writable_on_the_phone", () => {
    const store = Store.openAt(join(tmp, "retired.db"));
    const hub = new Hub([], 0);
    const replica = new StoreReplica({ store, hub, version: "t" });
    const routes = new PhoneRoutes({ store, hub, replica, mesh: null, version: "t", myFp: () => "", engine: null, catalog: catalogOf(providers, () => [], store) });
    const live = store.createChat(blankChat({ title: "live", role: "sub", parent: 1 }));
    const gone = store.createChat(blankChat({ title: "gone", role: "sub", parent: 1, retired: true }));
    const s = routes.state("tok:0", false) as { chats: { id: number; writable: boolean }[] };
    expect(s.chats.find((c) => c.id === live.id)?.writable).toBe(true);
    expect(s.chats.find((c) => c.id === gone.id)?.writable).toBe(false);
  });

  test("run settings follow the providers: a lead switches to any (OpenCode too), a started subagent stays on its provider", () => {
    const store = Store.openAt(join(tmp, "catalog.db"));
    const hub = new Hub([], 0);
    const replica = new StoreReplica({ store, hub, version: "t" });
    const acct = (id: string, kind: string, bin: string | null): CatalogAccount => ({ id, kind, name: id, badge: "AB", bin, loggedIn: true, usage: [{ label: "5h", percent: 0.4213 }] });
    const accounts = [acct("claude", "Claude", "/bin/true"), acct("claude2", "Claude", "/bin/true"), acct("codex", "Codex", "/bin/true"), acct("opencode", "OpenCode", "/bin/true"), acct("claude3", "Claude", null)];
    store.set("default_effort", "high");
    const catalog = catalogOf(providers, () => accounts, store);
    const routes = new PhoneRoutes({ store, hub, replica, mesh: null, version: "t", myFp: () => "", engine: null, catalog });
    expect(store.get("default_effort")).toBe(providers.defaultEffort("Claude"));
    const lead = store.createChat(blankChat({ title: "l", role: "lead", account: "claude", started: true }));
    const sub = store.createChat(blankChat({ title: "s", role: "sub", account: "codex", started: true }));
    const fresh = store.createChat(blankChat({ title: "f", role: "chat", account: "codex" }));
    // A lead that started on another device stays on Claude, the only provider that runs there.
    const away = store.createChat(blankChat({ title: "a", role: "lead", account: "claude", started: true, device: "ts:laptop" }));
    const s = routes.state("tok:0", false) as { chats: { id: number; allowed_accounts: string[]; switch_reason: Record<string, string>; switchable: Record<string, boolean> }[]; accounts: { id: string; label: string; usage: Json[] }[]; defaults: { model: string } };
    const of = (id: number) => s.chats.find((c) => c.id === id);
    expect(of(lead.id)?.allowed_accounts).toEqual(["claude", "claude2", "codex", "opencode"]);
    expect(of(lead.id)?.switchable.account).toBe(true);
    expect(of(away.id)?.allowed_accounts).toEqual(["claude", "claude2"]);
    expect(of(sub.id)?.allowed_accounts).toEqual(["codex"]);
    expect(of(sub.id)?.switch_reason.account).toBe("A started chat stays on Codex");
    expect(of(sub.id)?.switch_reason.device).toBe("Only Claude chats move between devices for now");
    expect(of(fresh.id)?.allowed_accounts).toEqual(["claude", "claude2", "codex", "opencode"]);
    expect(of(fresh.id)?.switch_reason.device).toBe("Only Claude chats run on another device");
    expect(s.accounts.map((a) => [a.id, a.label])).toEqual([
      ["claude", "Claude · AB"],
      ["claude2", "Claude · AB"],
      ["codex", "Codex"],
      ["opencode", "OpenCode"],
    ]);
    // Every provider can start a new chat (the phone's "Account" row lists them all).
    expect((s.accounts as unknown as { can_start: boolean }[]).every((a) => a.can_start)).toBe(true);
    expect(wire(s.accounts[0]?.usage ?? [])).toBe('[{"label":"5h","percent":42.1}]');
    expect(s.defaults.model).toBe("claude-opus-5-5");
  });

  test("the queue's calls reach the Engine, and a gone message is 404", async () => {
    const store = Store.openAt(join(tmp, "queue.db"));
    const hub = new Hub([], 0);
    const replica = new StoreReplica({ store, hub, version: "t" });
    const calls: string[] = [];
    const engine: PhoneEngine = {
      running: () => true,
      runningSince: () => 1761200000000,
      transcript: () => ({ items: [] }),
      send: () => {},
      stop: () => {},
      queued: () => [],
      takeQueue: () => [],
      queueJson: () => [{ id: 4, text: "next" }],
      steering: () => "now",
      followDefault: () => "queue",
      held: () => false,
      newThread: (repo) => store.createChat(blankChat({ repoId: repo })),
      reload: () => {},
      queuePromote: (_c, q) => (calls.push(`promote ${q}`), q === 4),
      queueMove: (_c, q, to) => (calls.push(`move ${q} ${to}`), true),
      queueUpdate: (_c, q, text, _m, editing) => (calls.push(`update ${q} ${text} ${editing}`), true),
      queueRemove: (_c, q) => (calls.push(`remove ${q}`), true),
      queueResume: () => {
        calls.push("resume");
      },
      recap: () => ["Fixed the build.", "Run the tests"],
      unread: () => false,
      failed: () => false,
      opened: () => false,
      subsQueued: () => 0,
      queuedCount: () => 0,
      mainChat: () => null,
      forksOf: () => [],
    };
    const routes = new PhoneRoutes({ store, hub, replica, mesh: null, version: "t", myFp: () => "", engine });
    const c = store.createChat(blankChat({ title: "q", role: "lead", name: "lead" }));
    const call = (method: string, path: string, body: unknown = null) => routes.route({ method, path: path.split("/"), query: [], body, token: "", device: "Pixel", global: false });
    expect((await call("POST", `v1/chats/${c.id}/queue/4/steer`)).status).toBe(200);
    expect((await call("POST", `v1/chats/${c.id}/queue/5/steer`)).status).toBe(404);
    expect((await call("POST", `v1/chats/${c.id}/queue/4/move`, { to: 0 })).status).toBe(200);
    expect((await call("POST", `v1/chats/${c.id}/queue/4/move`, {})).status).toBe(400);
    expect((await call("PATCH", `v1/chats/${c.id}/queue/4`, { text: " edited ", editing: true })).status).toBe(200);
    expect((await call("DELETE", `v1/chats/${c.id}/queue/4`)).status).toBe(200);
    expect((await call("POST", `v1/chats/${c.id}/resume`)).status).toBe(200);
    expect(calls).toEqual(["promote 4", "promote 5", "move 4 0", "update 4 edited Pixel", "remove 4", "resume"]);
    const items = (await call("GET", `v1/chats/${c.id}/items`)).body as { status: Record<string, unknown> };
    expect([items.status.recap, items.status.suggestion, items.status.can_steer, items.status.follow_up, items.status.queue]).toEqual(["Fixed the build.", "Run the tests", true, "queue", [{ id: 4, text: "next" }]]);
  });

  test("a_message_of_only_mentions_is_sent", async () => {
    expect(nothingToSend("", 0, 0)).toBe(true);
    expect(nothingToSend("  \n", 0, 0)).toBe(true);
    expect(nothingToSend("", 0, 1)).toBe(false);
    expect(nothingToSend("", 1, 0)).toBe(false);
    expect(nothingToSend("hi", 0, 0)).toBe(false);
    const store = Store.openAt(join(tmp, "mentions-only.db"));
    const hub = new Hub([], 0);
    const replica = new StoreReplica({ store, hub, version: "t" });
    const sent: Array<[string, Mention[]]> = [];
    const engine: PhoneEngine = {
      running: () => false,
      runningSince: () => 0,
      transcript: () => ({ items: [] }),
      send: (_id, text, o) => {
        sent.push([text, o.mentions ?? []]);
      },
      stop: () => {},
      queued: () => [],
      takeQueue: () => [],
      queueJson: () => [],
      steering: () => "now",
      followDefault: () => "queue",
      held: () => false,
      newThread: (repo) => store.createChat(blankChat({ repoId: repo })),
      reload: () => {},
      queuePromote: () => false,
      queueMove: () => false,
      queueUpdate: () => false,
      queueRemove: () => false,
      queueResume: () => {},
      recap: () => [null, null],
      unread: () => false,
      failed: () => false,
      opened: () => false,
      subsQueued: () => 0,
      queuedCount: () => 0,
      mainChat: () => null,
      forksOf: () => [],
    };
    const routes = new PhoneRoutes({ store, hub, replica, mesh: null, version: "t", myFp: () => "", engine });
    const c = store.createChat(blankChat({ title: "m" }));
    const call = (body: unknown) => routes.route({ method: "POST", path: `v1/chats/${c.id}/send`.split("/"), query: [], body, token: "", device: "Pixel", global: false });
    expect((await call({ text: " " })).status).toBe(400);
    expect((await call({ text: "", mentions: [{ item: 3, from: "Claude", text: "hi" }] })).status).toBe(200);
    expect(sent.map(([t, ms]) => [t, ms.map((m) => [m.item, m.from, m.text])])).toEqual([["", [[3, "Claude", "hi"]]]]);
    store.close();
  });

  test("a message another PC forwards keeps its sender and the context it sent; a phone's has none", async () => {
    const store = Store.openAt(join(tmp, "forwarded.db"));
    const hub = new Hub([], 0);
    hub.mesh.peers.set("pc-1", newPeer({ id: "pc-1", name: "Desk", online: true }));
    const sent: [string, string, unknown][] = [];
    const engine = {
      running: () => false,
      runningSince: () => 0,
      transcript: () => ({ items: [] }),
      send: (_id: number, _text: string, o: { sender?: string; device?: string; from?: unknown }) => {
        sent.push([o.sender ?? "", o.device ?? "", o.from ?? null]);
      },
      stop: () => {},
      queued: () => [],
      takeQueue: () => [],
      queueJson: () => [],
      steering: () => "now",
      followDefault: () => "queue",
      held: () => false,
      newThread: (repo: number | null) => store.createChat(blankChat({ repoId: repo })),
      reload: () => {},
      queuePromote: () => false,
      queueMove: () => false,
      queueUpdate: () => false,
      queueRemove: () => false,
      queueResume: () => {},
      recap: () => [null, null] as [null, null],
      unread: () => false,
      failed: () => false,
      opened: () => false,
      subsQueued: () => 0,
      queuedCount: () => 0,
      mainChat: () => null,
      forksOf: () => [],
    } satisfies PhoneEngine;
    let routes: PhoneRoutes | null = null;
    const replica = new StoreReplica({ store, hub, version: "t", route: (call) => (routes as PhoneRoutes).route(call) });
    routes = new PhoneRoutes({ store, hub, replica, mesh: null, version: "t", myFp: () => "", engine });
    const c = store.createChat(blankChat({ title: "m" }));
    const path = ["v1", "chats", String(c.id), "send"];
    const meshCall = (sender: string) => replica.route({ method: "POST", path: ["mesh", "v1", "call"], query: [], body: { method: "POST", path, body: { text: "hi" }, sender, device: "dev-9", ctx: { owner: "Ana" } }, token: "", device: "pc-1", global: false });
    expect((await meshCall("")).status).toBe(200);
    expect((await meshCall("Pixel 8 (Ana)")).status).toBe(200);
    expect((await routes.route({ method: "POST", path, query: [], body: { text: "hi" }, token: "", device: "Pixel", global: false })).status).toBe(200);
    const by = { peer: "pc-1", name: "Desk", ctx: { owner: "Ana" } };
    expect(sent).toEqual([
      ["Desk", "dev-9", by],
      ["Pixel 8 (Ana)", "dev-9", by],
      ["Pixel", "", null],
    ]);
    store.close();
  });

  test("a signed-in phone over pinned TLS starts a chat, reads it, sends, and hears of the reply", async () => {
    const hubId = generateIdentity();
    const phoneId = generateIdentity();
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const keys: AccountKey[] = [["k1", new Uint8Array(Buffer.from(String(publicKey.export({ format: "jwk" }).x), "base64url"))]];
    const store = Store.openAt(join(tmp, "hub.db"));
    const hub = new Hub([], 0);
    hub.enabled = true;
    hub.mesh.me = { id: "pc:desk", name: "desk" };
    const replica = new StoreReplica({ store, hub, version: "0.0.0-test" });
    const sent: string[] = [];
    const engine: PhoneEngine = {
      running: () => false,
      runningSince: () => null,
      transcript: (id) => ({ items: store.items(id) }),
      send: (id, text, o) => {
        sent.push(`${o.sender ?? ""}: ${text}`);
        const u: Item = { kind: "user", text, files: [], at: 1761200000, mentions: [], sender: o.sender ?? "", intent: "" };
        if (o.via) u.via = o.via;
        if (o.dev) u.dev = o.dev;
        store.saveItems(id, [...store.items(id), u, { kind: "text", text: `**echo** ${text}`, at: 1761200001 }]);
      },
      stop: () => {},
      queued: () => [],
      takeQueue: () => [],
      queueJson: () => [],
      steering: () => "no",
      followDefault: () => "steer",
      held: () => false,
      newThread: (repo, first, sel) => store.createChat(blankChat({ repoId: repo, title: first.split("\n")[0] ?? "", account: sel.account, model: sel.model, role: "lead", name: "lead" })),
      reload: () => {},
      queuePromote: () => false,
      queueMove: () => false,
      queueUpdate: () => false,
      queueRemove: () => false,
      queueResume: () => {},
      recap: () => [null, null],
      unread: () => false,
      failed: () => false,
      opened: () => false,
      subsQueued: () => 0,
      queuedCount: () => 0,
      mainChat: () => null,
      forksOf: () => [],
    };
    const mesh = new Mesh({ hub, kv: new MemKv(), id: () => hubId, app: replica, myAddrs: () => [], uploadsDir: tmp, upload: async () => err(404, "") });
    const routes = new PhoneRoutes({ store, hub, replica, mesh, version: "0.0.0-test", myFp: () => hubId.fp, engine, uploadsDir: tmp });
    const account = {
      isToken: isHarborToken,
      admit: (t: string, fp: string) => {
        const r = verifyHarborToken(t, keys, Math.floor(Date.now() / 1000));
        if (!r.ok) throw new Error(r.error);
        if (r.value.dev !== fp) throw new Error("this sign-in belongs to another device");
        const why = accountDecide(r.value, "org_a", { at: 0, peers: [], workspaces: [] });
        if (why) throw new Error(why);
        return r.value;
      },
      knownDevice: () => false,
    };
    const api = new Api({
      hub,
      id: () => hubId,
      uploadsDir: tmp,
      route: (c) => routes.route(c),
      account,
      appInfo: () => ({ version_code: 0, url: "/app.apk", hub: null }),
      apk: () => null,
      mesh: (p, q, r) => mesh.serve(p, q, r),
      meshAdmitted: () => false,
      relay: async () => {},
      hubs: () => mesh.hubs(),
    });
    await api.listen(["127.0.0.1"]);
    stops.push(() => api.close());
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: "harbor-accounts", sub: "user_1", email: "sam@example.com", name: "Sam Rig", ws: ["org_a"], dev: phoneId.fp, kind: "phone", iat: now - 5, exp: now + 600 };
    const tok = token(privateKey, claims);
    const call = async (method: string, path: string, body?: unknown, auth = tok, id = phoneId) => {
      const { sock } = await connect({ id, pin: hubId.fp, host: "127.0.0.1", port: api.port(), maxVersion: "TLSv1.2" });
      return request(sock, method, path, auth, body);
    };
    // Another device's token, or another workspace: refused with the protocol's words.
    const [st401, e401] = await call("GET", "/v1/state", undefined, tok, generateIdentity());
    expect([st401, (e401 as { signin: boolean }).signin]).toEqual([401, true]);
    const [st403] = await call("GET", "/v1/state", undefined, token(privateKey, { ...claims, ws: ["org_b"] }));
    expect(st403).toBe(403);
    let [st, v] = await call("GET", "/v1/state");
    expect(st).toBe(200);
    const s0 = v as { hub_fp: string; you: string; chats: unknown[]; rev: number };
    expect(s0.hub_fp).toBe(hubId.fp);
    expect(s0.you).toMatch(/^tok:[0-9a-f]{8}$/);
    expect(s0.chats).toEqual([]);
    [st, v] = await call("POST", "/v1/chats", { text: "Fix the build" });
    expect(st).toBe(200);
    const gid = (v as { id: string }).id;
    expect(sent).toEqual(["Pixel (Sam Rig): Fix the build"]);
    [st, v] = await call("GET", "/v1/state");
    const s1 = v as { chats: { id: string; title: string; writable: boolean; home: string }[]; tree: { threads: string[] } };
    expect(s1.chats.map((c) => [c.id, c.title, c.writable, c.home])).toEqual([[gid, "Fix the build", true, "pc:desk"]]);
    expect(s1.tree.threads).toEqual([gid]);
    [st, v] = await call("GET", `/v1/chats/${gid}/items?since=0`);
    const it = v as { count: number; items: { kind: string; text?: string; sender?: string; blocks?: unknown; rev: number }[] };
    expect(it.count).toBe(2);
    expect(it.items.map((x) => x.kind)).toEqual(["user", "text"]);
    // Its own message: no sender row on this phone (the item knows the phone by its key).
    expect(store.items(store.chats()[0]?.id ?? 0)[0]).toMatchObject({ sender: "Pixel (Sam Rig)", via: "phone", dev: `phone:${phoneId.fp}` });
    expect(it.items[0]?.sender).toBe("");
    expect(it.items[1]?.blocks).toEqual([{ type: "paragraph", spans: [{ text: "echo", bold: true }, { text: " Fix the build" }] }]);
    const since = Math.max(...it.items.map((x) => x.rev));
    // The long-poll hears of the next reply; only the new cards come again.
    const events = call("GET", `/v1/events?since=${hub.rev()}`);
    await Bun.sleep(100);
    [st, v] = await call("POST", `/v1/chats/${gid}/send`, { text: "and the tests", mode: "queue" });
    expect([st, v]).toEqual([200, { ok: true, queued: false, steering: false }]);
    const [, ev] = await events;
    expect((ev as { changed_chats: string[] }).changed_chats).toContain(gid);
    [, v] = await call("GET", `/v1/chats/${gid}/items?since=${since}`);
    expect((v as { count: number; items: { seq: number }[] }).items.map((x) => x.seq)).toEqual([2, 3]);
    expect(hub.localPhones()[0]?.app).toBe(108000);
    expect((await call("PATCH", `/v1/chats/${gid}`, { title: "Build fixed" }))[0]).toBe(200);
    expect(store.chats()[0]?.title).toBe("Build fixed");
    expect((await call("DELETE", `/v1/chats/${gid}`))[0]).toBe(200);
    expect(store.chats()).toEqual([]);
  }, 20_000);
});

describe("phone: Move to PC…", () => {
  test("move_targets and move_pc reach the move, and a copy's go to its home PC", async () => {
    const store = Store.openAt(join(tmp, "move.db"));
    const hub = new Hub([], 0);
    const replica = new StoreReplica({ store, hub, version: "t" });
    const asked: string[] = [];
    const move = {
      targetsJson: async (chat: number): Promise<Json> => ({ why: null, targets: [{ id: "pc:b", name: "b", why: null }, { id: `chat:${chat}`, name: "c", why: "x" }] }),
      movePc: async (chat: number, pc: string): Promise<string> => {
        asked.push(`${chat} ${pc}`);
        if (pc === "") throw new Error("that PC isn't one of this PC's");
        return "b";
      },
    };
    const routes = new PhoneRoutes({ store, hub, replica, mesh: null, version: "t", myFp: () => "", engine: null, move });
    const c = store.createChat(blankChat({ title: "m", role: "lead", name: "lead" }));
    const call = (method: string, path: string, body: unknown = null) => routes.route({ method, path: path.split("/"), query: [], body, token: "", device: "Pixel", global: false });
    expect((await call("GET", `v1/chats/${c.id}/move_targets`)).body).toEqual({ why: null, targets: [{ id: "pc:b", name: "b", why: null }, { id: `chat:${c.id}`, name: "c", why: "x" }] });
    const r = await call("POST", `v1/chats/${c.id}/move_pc`, { pc: "pc:b" });
    expect([r.status, r.body]).toEqual([202, { ok: true, moving: true, to: "b" }]);
    const bad = await call("POST", `v1/chats/${c.id}/move_pc`, {});
    expect([bad.status, bad.body]).toEqual([409, { error: "that PC isn't one of this PC's" }]);
    expect(asked).toEqual([`${c.id} pc:b`, `${c.id} `]);
    // Without the feature (an older build): not a call.
    const none = new PhoneRoutes({ store, hub, replica, mesh: null, version: "t", myFp: () => "", engine: null });
    expect((await none.route({ method: "GET", path: ["v1", "chats", String(c.id), "move_targets"], query: [], body: null, token: "", device: "", global: false })).status).toBe(404);
    // A copy of a PC that runs an older Harbor says so itself.
    hub.mesh.peers.set("pc:old", newPeer({ id: "pc:old", name: "old", online: true, moves: false, addr: "127.0.0.1:1" }));
    const copy = store.createChat(blankChat({ title: "theirs", role: "lead", name: "lead", gid: "g-old", home: "pc:old", homeId: 4 }));
    const mesh = new Mesh({ hub, kv: new MemKv(), id: () => generateIdentity(), app: replica, myAddrs: () => [], uploadsDir: tmp, upload: async () => err(404, "") });
    const withMesh = new PhoneRoutes({ store, hub, replica, mesh, version: "t", myFp: () => "", engine: null, move });
    const old = await withMesh.route({ method: "POST", path: ["v1", "chats", String(copy.id), "move_pc"], query: [], body: { pc: "pc:b" }, token: "", device: "", global: false });
    expect([old.status, old.body]).toEqual([409, { error: "old runs an older Harbor that can't move chats: update it first" }]);
    store.close();
  });
});

describe("phone: a copy's calls at its home PC (mesh.rs mesh_proxy)", () => {
  test("a message on a copy goes home with this PC's context and the phone's files, and the answer has this PC's ids", async () => {
    const store = Store.openAt(join(tmp, "proxy.db"));
    const hub = new Hub([], 0);
    hub.mesh.on = true;
    hub.mesh.peers.set("pc:home", newPeer({ id: "pc:home", name: "home", online: true, addr: "127.0.0.1:1" }));
    const replica = new StoreReplica({ store, hub, version: "t" });
    const repo = store.addRepo("/home/owner/code/app");
    const copy = store.createChat(blankChat({ title: "theirs", repoId: repo, gid: "g-copy", home: "pc:home", homeId: 7 }));
    const uploads = join(tmp, "proxy-uploads");
    mkdirSync(join(uploads, "u1"), { recursive: true });
    writeFileSync(join(uploads, "u1", "shot.png"), "png");
    const mesh = new Mesh({ hub, kv: new MemKv(), id: () => generateIdentity(), app: replica, myAddrs: () => [], uploadsDir: tmp, upload: async () => err(404, "") });
    const sent: { path: string[]; files: string[]; ctx: Json }[] = [];
    mesh.forward = async (_d, _name, _method, path, _body, files, _sender, ctx) => {
      sent.push({ path, files: files.map((f) => f.name), ctx });
      return { status: 200, body: { ok: true, chat: { id: 7, project_id: 3, parent: null, gid: "g-copy", title: "theirs" }, returned: [{ text: "held", files: ["x/y.png"] }] } };
    };
    const routes = new PhoneRoutes({ store, hub, replica, mesh, version: "t", myFp: () => "", engine: null, uploadsDir: uploads, ctx: (r) => ({ owner: "Ann", memory_id: `m-${r}` }) });
    const send = (global: boolean, tail: string, body: Record<string, unknown>) =>
      routes.route({ method: "POST", path: ["v1", "chats", String(copy.id), tail], query: [], body, token: "", device: "Pixel", global });
    const r = await send(false, "send", { text: "hi", files: ["u1/shot.png"] });
    expect(sent[0]).toEqual({ path: ["v1", "chats", "7", "send"], files: ["shot.png"], ctx: { owner: "Ann", memory_id: `m-${repo}` } });
    expect(r.body).toEqual({ ok: true, chat: { id: copy.id, project_id: repo, parent: null, gid: "g-copy", title: "theirs" }, returned: [{ text: "held", files: [] }] });
    const g = await send(true, "send", { text: "again" });
    expect((g.body as { chat: Json }).chat).toEqual({ id: "g-copy", project_id: "/home/owner/code/app", parent: null, gid: "g-copy", title: "theirs" });
    await send(false, "title", { title: "renamed" });
    expect(sent[2]?.ctx).toBeNull();
    store.close();
  });
});

describe("phone: a project whose folder is on another PC", () => {
  test("a new chat in it starts on that PC (the default device doesn't count), and its main chat's message goes there", async () => {
    const store = Store.openAt(join(tmp, "away-new.db"));
    const hub = new Hub([], 0);
    hub.mesh.on = true;
    hub.mesh.me = { id: "pc:desk", name: "desk" };
    hub.mesh.peers.set("pc:home", newPeer({ id: "pc:home", name: "home", online: true, addr: "127.0.0.1:1" }));
    const replica = new StoreReplica({ store, hub, version: "t" });
    const repo = store.addRepo("/home/owner/Documents/game");
    const mesh = new Mesh({ hub, kv: new MemKv(), id: () => generateIdentity(), app: replica, myAddrs: () => [], uploadsDir: tmp, upload: async () => err(404, "") });
    const sent: { path: string[]; body: Record<string, unknown> }[] = [];
    mesh.forward = async (_d, _name, _method, path, body) => {
      sent.push({ path, body });
      return { status: 200, body: { id: 9, gid: "g-there", ok: true } };
    };
    let online = true;
    const devices = (): [RemoteHost, boolean | null][] => [
      [newHost({ id: "ssh:1", name: "mac", host: "mac" }), true],
      [newHost({ id: "ssh:2", name: "box", host: "box", device_files: true }), true],
    ];
    const routes = new PhoneRoutes({ store, hub, replica, mesh, version: "t", myFp: () => "", engine: null, devices, projectPlace: (r) => (r === repo ? { pc: "pc:home", name: "home", online } : null) });
    const create = (body: Record<string, unknown>, from: boolean = false) =>
      routes.route({ method: "POST", path: ["v1", "chats"], query: [], body, token: "", device: "Pixel", global: true, ...(from ? { from: { peer: "pc:x", name: "x", ctx: null, sender: "", device: "", who: "", dev: "", via: null } } : {}) });
    // No device, or one working in this PC's files (the saved default): the PC its folder is on.
    for (const device of ["", "ssh:1"]) {
      const r = await create({ project_id: repo, device, account: "claude", text: "hi", main: true });
      expect(r.status).toBe(200);
      expect(sent.at(-1)?.path).toEqual(["v1", "chats"]);
      expect(sent.at(-1)?.body).toMatchObject({ device: "", main: true, text: "hi", project: { path: "/home/owner/Documents/game", name: "game" } });
    }
    expect(sent.length).toBe(2);
    // A device with its own files, that PC off, or a chat another PC asked for here: made here as asked.
    expect((await create({ project_id: repo, device: "ssh:2", account: "claude", text: "" })).status).toBe(200);
    online = false;
    expect((await create({ project_id: repo, device: "", account: "claude", text: "" })).status).toBe(200);
    online = true;
    expect((await create({ project_id: repo, device: "", account: "claude", text: "" }, true)).status).toBe(200);
    expect(sent.length).toBe(2);
    // The project's main chat is the home PC's (a copy here): a message to it goes there, not into the copy.
    const copy = store.createChat(blankChat({ title: "Game", repoId: repo, role: "lead", gid: "g-main", home: "pc:home", homeId: 7 }));
    store.setMainChat(repo, copy.id);
    const engine = { mainChat: (r: number) => (r === repo ? copy.id : null), send: () => { throw new Error("ran here"); } } as unknown as PhoneEngine;
    const withEngine = new PhoneRoutes({ store, hub, replica, mesh, version: "t", myFp: () => "", engine });
    const m = await withEngine.route({ method: "POST", path: ["v1", "chats"], query: [], body: { project_id: repo, main: true, account: "claude", text: "next" }, token: "", device: "Pixel", global: true });
    expect(m.status).toBe(200);
    expect(sent.at(-1)).toMatchObject({ path: ["v1", "chats", "7", "send"], body: { text: "next" } });
    expect(m.body).toMatchObject({ id: "g-main", gid: "g-main" });
    store.close();
  });
});

test("a default saved on a provider Harbor dropped reads as Claude's defaults", () => {
  const kv = new Map<string, string>([
    ["default_account", "cursor"],
    ["default_model", "auto"],
    ["default_effort", "minimal"],
    ["default_access", "ask"],
    ["effort_default_medium", "1"],
  ]);
  const store = { get: (k: string) => kv.get(k) ?? null, set: (k: string, v: string) => void kv.set(k, v) };
  expect(composerDefaults(store, [], "medium")).toEqual({ account: "claude", model: "claude-opus-5-5", effort: "", access: "full", device: "" });
  kv.set("default_account", "codex");
  expect(composerDefaults(store, [], "medium")).toMatchObject({ account: "codex", model: "auto", effort: "minimal" });
  // OpenCode is driven again; its "Default" model is "", not Claude's Opus.
  kv.set("default_account", "opencode");
  kv.set("default_model", "");
  expect(composerDefaults(store, [], "medium")).toMatchObject({ account: "opencode", model: "" });
  kv.set("default_model", "nvidia/z-ai/glm-5.3-flash");
  expect(composerDefaults(store, [], "medium")).toMatchObject({ account: "opencode", model: "nvidia/z-ai/glm-5.3-flash" });
});

describe("phone: Runs on › Auto", () => {
  test("the state lists Auto second; a new chat on Auto goes where it says, once, and says so after", async () => {
    const store = Store.openAt(join(tmp, "auto.db"));
    const hub = new Hub([], 0);
    hub.mesh.on = true;
    hub.mesh.me = { id: "pc:desk", name: "desk" };
    hub.mesh.peers.set("pc:a", newPeer({ id: "pc:a", name: "laptop", online: true, addr: "127.0.0.1:1", accounts: [["claude", "Claude", "claude"]] }));
    const replica = new StoreReplica({ store, hub, version: "t" });
    const mesh = new Mesh({ hub, kv: new MemKv(), id: () => generateIdentity(), app: replica, myAddrs: () => [], uploadsDir: tmp, upload: async () => err(404, "") });
    const forwarded: Record<string, unknown>[] = [];
    mesh.forward = async (_d, _name, _method, _path, body) => {
      forwarded.push(body);
      return { status: 200, body: { id: 9, gid: "g-there" } };
    };
    let best: { id: string; name: string; ram: number | null } | null = { id: "pc:a", name: "laptop", ram: 12_595 };
    const marks = new Map<string, string>();
    const auto = {
      pick: () => best,
      resolve: (device: string) => (device === "auto" ? { device: best?.id ?? "", auto: true } : { device, auto: false }),
      mark: (gid: string, place: string) => void marks.set(gid, place),
      label: (c: Chat, here: string) => (marks.has(c.gid) ? `Auto → ${marks.get(c.gid) === "" ? here : "laptop"}` : null),
    };
    const routes = new PhoneRoutes({ store, hub, replica, mesh, version: "t", myFp: () => "", engine: null, auto });
    const call = (method: string, path: string, body: unknown = null) => routes.route({ method, path: path.split("/"), query: [], body, token: "", device: "Pixel", global: true });
    const devices = () => ((routes.state("", true) as { devices: Record<string, Json>[] }).devices);
    expect(devices().map((d) => d.id)).toEqual(["", "auto", "pc:a"]);
    expect(devices()[1]).toMatchObject({ label: "Auto", pick_label: "Auto → laptop", auto: true, enabled: true, desc: "Most free memory now: laptop · 12.3 GB free" });
    // Auto picked the laptop: the chat starts there, told it was Auto's.
    const r = await call("POST", "v1/chats", { device: "auto", account: "claude", text: "hi" });
    expect(r.status).toBe(200);
    expect(forwarded[0]).toMatchObject({ device: "", auto_placed: true, text: "hi" });
    expect(marks.get("g-there")).toBe("pc:a");
    // Then this PC: made here on "", remembered as Auto's, and its chat says so.
    best = { id: "", name: "desk", ram: 20_000 };
    const h = await call("POST", "v1/chats", { device: "auto", account: "claude", text: "" });
    const gid = (h.body as { gid: string }).gid;
    const made = store.chats().find((c) => c.gid === gid);
    expect(made?.device).toBe("");
    expect(marks.get(gid)).toBe("");
    expect((routes.chatJson(made as Chat, true) as { auto_label: Json }).auto_label).toBe("Auto → desk");
    // Another PC's Auto sent one here: this PC remembers it too. A chat picked by hand isn't Auto's.
    const sent = await call("POST", "v1/chats", { device: "", auto_placed: true, account: "claude", text: "" });
    expect(marks.get((sent.body as { gid: string }).gid)).toBe("");
    const plain = await call("POST", "v1/chats", { device: "", account: "claude", text: "" });
    expect(marks.has((plain.body as { gid: string }).gid)).toBe(false);
    // Nowhere to go: greyed.
    best = null;
    expect(devices()[1]).toMatchObject({ pick_label: "Auto", enabled: false, desc: "No PC can take it now" });
    store.close();
  });

  test("Auto in a started chat moves it at the pick, through runon's move; a reason greys it", async () => {
    const store = Store.openAt(join(tmp, "auto-started.db"));
    const hub = new Hub([], 0);
    const replica = new StoreReplica({ store, hub, version: "t" });
    const moved: [number, string][] = [];
    let why: string | null = null;
    const auto = {
      pick: () => ({ id: "pc:a", name: "Sam-Laptop", ram: 9000 }),
      resolve: (device: string) => ({ device, auto: false }),
      mark: () => {},
      label: () => null,
      why: () => why,
      relocate: async (chatId: number, kind: string) => {
        moved.push([chatId, kind]);
        return { to: "pc:a", name: "Sam-Laptop", moved: true };
      },
    };
    const mesh = new Mesh({ hub, kv: new MemKv(), id: () => generateIdentity(), app: replica, myAddrs: () => [], uploadsDir: tmp, upload: async () => err(404, "") });
    const routes = new PhoneRoutes({ store, hub, replica, mesh, version: "t", myFp: () => "", engine: null, auto });
    const c = store.createChat(blankChat({ title: "t", role: "lead", account: "claude", started: true, gid: "g-started" }));
    const fresh = store.createChat(blankChat({ title: "n", role: "lead", account: "claude", gid: "g-new" }));
    const json = (x: Chat) => routes.chatJson(x, true) as { auto_moves: Json; device_why: Record<string, Json> | null };
    // Its picker has Auto (auto_moves); a chat not started has nothing to move.
    expect(json(c).auto_moves).toBe(true);
    expect(json(fresh).auto_moves).toBe(false);
    expect(json(c).device_why).toEqual({});
    const call = (body: unknown) => routes.route({ method: "PATCH", path: ["v1", "chats", String(c.id)], query: [], body, token: "", device: "Pixel", global: true });
    const r = await call({ device: "auto" });
    expect(r.status).toBe(200);
    expect(moved).toEqual([[c.id, "Claude"]]);
    // The chat's own device isn't set to "auto": the move sets it.
    expect(store.chat(c.id)?.device).toBe("");
    // Its best PC can't take it now: the picker greys Auto with the reason, and a pick is refused.
    why = "it is running: move it once its turn ends";
    expect(json(c).device_why).toEqual({ auto: why });
    const no = await call({ device: "auto" });
    expect(no.status).toBe(409);
    expect(moved.length).toBe(1);
    store.close();
  });
});

describe("phone: the mesh's shared accounts", () => {
  test("another PC's account is listed with its owner's badge, and a chat on it starts on that PC with its own id", async () => {
    const store = Store.openAt(join(tmp, "shared.db"));
    const hub = new Hub([], 0);
    hub.mesh.on = true;
    hub.mesh.me = { id: "ts:desk", name: "desk" };
    const replica = new StoreReplica({ store, hub, version: "t" });
    const mesh = new Mesh({ hub, kv: new MemKv(), id: () => generateIdentity(), app: replica, myAddrs: () => [], uploadsDir: tmp, upload: async () => err(404, "") });
    const forwarded: [string, Record<string, unknown>][] = [];
    mesh.forward = async (d, _name, _method, _path, body) => {
      forwarded.push([d.addr, body]);
      return { status: 200, body: { id: 9, gid: "g-there" } };
    };
    const laptop = newPeer({ id: "ts:laptop", name: "laptop", owner: "Sam Lee", online: true, addr: "10.0.0.2:1", provs: [{ id: "opencode", short: "OpenCode", kind: "opencode", ident: "", person: "", main: true, models: [["nvidia/glm", "GLM"]] }] });
    const off = newPeer({ id: "ts:off", name: "tower", owner: "Kim Ro", online: false, addr: "10.0.0.3:1", provs: [{ id: "codex", short: "Codex", kind: "codex", ident: "", person: "", main: true, models: [] }] });
    hub.mesh.peers.set(laptop.id, laptop);
    hub.mesh.peers.set(off.id, off);
    const acct = (id: string, kind: string): CatalogAccount => ({ id, kind, name: id, badge: "AB", bin: "/bin/true", loggedIn: true, usage: [] });
    const catalog = catalogOf(providers, () => [acct("claude", "Claude")], store);
    const input = {
      me: { id: "ts:desk", name: "desk", owner: "Ana Lu", github: "" },
      local: [{ id: "claude", kind: "Claude", email: "ana@example.com", badge: "AB", short: "Claude · AB", usable: true }],
      peers: [laptop, off],
      provs: new Map([laptop, off].map((p) => [p.id, p.provs])),
    };
    const shared = Object.assign(() => sharedAccounts(input), { input });
    catalog.shared = shared;
    const routes = new PhoneRoutes({ store, hub, replica, mesh, version: "t", myFp: () => "", engine: null, catalog });
    const s = routes.state("", true) as { accounts: Record<string, Json>[] };
    expect(s.accounts.map((a) => [a.id, a.label, a.pc, a.can_start])).toEqual([
      ["claude", "Claude · AL", "", true],
      ["opencode@ts:laptop/opencode", "OpenCode · SL", "ts:laptop", true],
      ["codex@ts:off/codex", "Codex · KR", "ts:off", false],
    ]);
    expect(s.accounts[1]).toMatchObject({ name: "Sam Lee on laptop", owner: "Sam Lee", pc_name: "laptop", models: [{ id: "nvidia/glm", label: "GLM", more: false }] });
    expect(s.accounts[2]?.why).toBe("tower is offline");
    // No photo known: no `photo`, the initials stay.
    expect(s.accounts.some((a) => "photo" in a)).toBe(false);
    // With the owners' workspace photos: each account carries its owner's, and its label names them.
    catalog.shared = () => sharedAccounts({ ...shared.input, photos: photoBook([{ name: "Sam Lee", image: "https://img.example/sam.png" }, { name: "Ana Lu", image: "https://img.example/ana.png" }]) });
    const p = routes.state("", true) as { accounts: Record<string, Json>[] };
    expect(p.accounts.map((a) => [a.label, a.photo ?? null])).toEqual([
      ["Claude · Ana Lu", "https://img.example/ana.png"],
      ["OpenCode · Sam Lee", "https://img.example/sam.png"],
      ["Codex · KR", null],
    ]);
    // The workspace knows the account's email as "Nana": that member's photo and name, on the phone too.
    catalog.shared = () => sharedAccounts({ ...shared.input, photos: photoBook([{ name: "Nana", email: "ana@example.com", image: "https://img.example/nana.png" }]) });
    const n = routes.state("", true) as { accounts: Record<string, Json>[] };
    expect([n.accounts[0]?.label, n.accounts[0]?.photo, n.accounts[0]?.owner]).toEqual(["Claude · Nana", "https://img.example/nana.png", "Nana"]);
    catalog.shared = shared;
    const call = (body: Record<string, unknown>) => routes.route({ method: "POST", path: ["v1", "chats"], query: [], body, token: "", device: "Pixel", global: true });
    // Picked: the chat starts on the laptop, on the laptop's own OpenCode; this PC's device pick doesn't matter.
    const r = await call({ account: "opencode@ts:laptop/opencode", model: "nvidia/glm", device: "", text: "hi" });
    expect(r.status).toBe(200);
    expect(forwarded[0]?.[0]).toBe("10.0.0.2:1");
    expect(forwarded[0]?.[1]).toMatchObject({ account: "opencode", model: "nvidia/glm", device: "", shared_account: true, text: "hi" });
    // An off PC's, or one that's gone: said, nothing forwarded, nothing made here.
    expect(await call({ account: "codex@ts:off/codex", text: "hi" })).toMatchObject({ status: 409, body: { error: "tower is offline" } });
    expect((await call({ account: "claude:feedfeed", text: "hi" })).status).toBe(400);
    expect(forwarded.length).toBe(1);
    expect(store.chats().length).toBe(0);
    store.close();
  });

  test("a chat another PC starts on one of this PC's accounts does at most what this PC shares with that PC", async () => {
    const store = Store.openAt(join(tmp, "shared-owner.db"));
    const hub = new Hub([], 0);
    hub.mesh.me = { id: "ts:laptop", name: "laptop" };
    const replica = new StoreReplica({ store, hub, version: "t" });
    const acct = (id: string, kind: string): CatalogAccount => ({ id, kind, name: id, badge: "SL", bin: "/bin/true", loggedIn: true, usage: [] });
    const catalog = catalogOf(providers, () => [acct("claude", "Claude"), acct("opencode", "OpenCode")], store);
    const levels = new Map<string, string>([["ts:desk", "read"]]);
    const routes = new PhoneRoutes({ store, hub, replica, mesh: null, version: "t", myFp: () => "", engine: null, catalog, shareLevel: (p) => levels.get(p) ?? "full" });
    const from = { peer: "ts:desk", name: "desk", ctx: null, sender: "", device: "", who: "", dev: "", via: null };
    const call = (body: Record<string, unknown>) => routes.route({ method: "POST", path: ["v1", "chats"], query: [], body: { shared_account: true, text: "", ...body }, token: "", device: "", global: true, from });
    const made = await call({ account: "claude", access: "full" });
    expect(made.status).toBe(200);
    expect(store.chats().find((c) => c.gid === (made.body as { gid: string }).gid)?.access).toBe("plan");
    expect(await call({ account: "opencode", access: "full" })).toMatchObject({ status: 403, body: { error: "laptop lets this PC's chats only read there, and OpenCode runs with full access only" } });
    levels.set("ts:desk", "off");
    expect((await call({ account: "claude" })).status).toBe(403);
    // A chat not on a shared account (Runs on › that PC) keeps what it asked for, as before.
    const plain = await routes.route({ method: "POST", path: ["v1", "chats"], query: [], body: { account: "claude", access: "full", text: "" }, token: "", device: "", global: true, from });
    expect(store.chats().find((c) => c.gid === (plain.body as { gid: string }).gid)?.access).toBe("full");
    store.close();
  });
});

describe("phone: a started chat switched to another PC's account", () => {
  test("it's offered to a lead here, and picking it moves the chat there with that account", async () => {
    const store = Store.openAt(join(tmp, "shared-switch.db"));
    const hub = new Hub([], 0);
    hub.mesh.on = true;
    hub.mesh.me = { id: "ts:desk", name: "desk" };
    const replica = new StoreReplica({ store, hub, version: "t" });
    const laptop = newPeer({ id: "ts:laptop", name: "laptop", owner: "Sam Lee", online: true, provs: [{ id: "opencode", short: "OpenCode", kind: "opencode", ident: "", person: "", main: true, models: [] }] });
    hub.mesh.peers.set(laptop.id, laptop);
    const acct = (id: string, kind: string): CatalogAccount => ({ id, kind, name: id, badge: "AB", bin: "/bin/true", loggedIn: true, usage: [] });
    const catalog = catalogOf(providers, () => [acct("claude", "Claude")], store);
    catalog.shared = () =>
      sharedAccounts({ me: { id: "ts:desk", name: "desk", owner: "Ana Lu", github: "" }, local: [{ id: "claude", kind: "Claude", email: "ana@example.com", badge: "AB", short: "Claude · AB", usable: true }], peers: [laptop], provs: new Map([[laptop.id, laptop.provs]]) });
    const moves: [number, string, unknown][] = [];
    let refuse: string | null = null;
    const move = {
      targetsJson: async () => ({}),
      movePc: async (chat: number, pc: string, want?: unknown) => {
        if (refuse !== null) throw new Error(refuse);
        moves.push([chat, pc, want]);
        return "laptop";
      },
    };
    const routes = new PhoneRoutes({ store, hub, replica, mesh: null, version: "t", myFp: () => "", engine: null, catalog, move, runSettings: { accounts: () => [], modelsFor: () => [], devices: () => [], setFast: () => {} } as never });
    const lead = store.createChat(blankChat({ title: "l", role: "lead", account: "claude", started: true, sessionId: "s" }));
    const sub = store.createChat(blankChat({ title: "s", role: "sub", account: "claude", started: true, parent: lead.id }));
    const id = "opencode@ts:laptop/opencode";
    expect(routes.allowedAccounts(lead)).toEqual(["claude", id]);
    // A sub-agent moves with its lead.
    expect(routes.allowedAccounts(sub)).toEqual(["claude"]);
    const patch = (body: Record<string, unknown>) => routes.route({ method: "PATCH", path: ["v1", "chats", String(lead.id)], query: [], body, token: "", device: "Pixel", global: false });
    expect(await patch({ account: id, model: "nvidia/glm" })).toMatchObject({ status: 202, body: { ok: true, moving: true, to: "laptop", account: "OpenCode · SL" } });
    expect(moves).toEqual([[lead.id, "ts:laptop", { account: "opencode", kind: "opencode", model: "nvidia/glm" }]]);
    // Its account here didn't change: the chat goes on there.
    expect(store.chat(lead.id)?.account).toBe("claude");
    refuse = "laptop has no project named x";
    expect(await patch({ account: id })).toMatchObject({ status: 409, body: { error: "can't switch to OpenCode · SL: laptop has no project named x" } });
    store.close();
  });
});
