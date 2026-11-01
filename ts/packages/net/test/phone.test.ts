import { afterAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { blankChat, mention, Store, type Chat, type Mention } from "@harbor/store";
import { accountDecide, isHarborToken, verifyHarborToken, type AccountKey } from "../src/account.ts";
import { Api } from "../src/api.ts";
import { readAnswerHead } from "../src/client.ts";
import { err } from "../src/http.ts";
import { Hub } from "../src/hub.ts";
import { MemKv } from "../src/kv.ts";
import { Mesh } from "../src/mesh.ts";
import { newPeer } from "../src/shared.ts";
import { StoreReplica } from "../src/meshstore.ts";
import { cardJson, catalogOf, clock, PhoneRoutes, type CatalogAccount, type PhoneEngine } from "../src/phone.ts";
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
  test("a_chat_is_exported_to_peers_with_its_pull_request_and_worktree_name", () => {
    const store = Store.openAt(join(tmp, "export.db"));
    const c = store.createChat(blankChat({ title: "mine" }));
    const pr = { number: 7, state: "open", label: "PR #7 · Open", title: "Add it", url: "https://github.com/o/r/pull/7" };
    const hub = new Hub([], 0);
    const bare = new StoreReplica({ store, hub, version: "t" }).chats(0, true).chats[0] as Record<string, Json>;
    expect([bare.pr, bare.worktree]).toEqual([null, null]);
    const status = { queue: [], working: { since_ms: 1, subagents: 2, text: "Working…  ·  2 sub-agents running" }, waiting: null, limit: null, agents: null, folder: null, can_steer: true, held: false, follow_up: "steer" };
    const replica = new StoreReplica({ store, hub, version: "t", pr: (x) => (x.id === c.id ? pr : null), worktree: () => "fix-login", forks: () => [[3, 9]], queued: () => 2, status: () => status, about: () => ({ owner: "Ana Souza", github: "anasouza", owner_suggested: true }) });
    const out = replica.chats(0, true).chats[0] as Record<string, Json>;
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

  test("run settings follow the providers: a lead stays on Claude, a started chat on its provider", () => {
    const store = Store.openAt(join(tmp, "catalog.db"));
    const hub = new Hub([], 0);
    const replica = new StoreReplica({ store, hub, version: "t" });
    const acct = (id: string, kind: string, bin: string | null): CatalogAccount => ({ id, kind, name: id, badge: "AB", bin, loggedIn: true, usage: [{ label: "5h", percent: 0.4213 }] });
    const accounts = [acct("claude", "Claude", "/bin/true"), acct("claude2", "Claude", "/bin/true"), acct("codex", "Codex", "/bin/true"), acct("gemini", "Gemini", null)];
    store.set("default_effort", "high");
    const catalog = catalogOf(providers, () => accounts, store);
    const routes = new PhoneRoutes({ store, hub, replica, mesh: null, version: "t", myFp: () => "", engine: null, catalog });
    expect(store.get("default_effort")).toBe(providers.defaultEffort("Claude"));
    const lead = store.createChat(blankChat({ title: "l", role: "lead", account: "claude", started: true }));
    const sub = store.createChat(blankChat({ title: "s", role: "sub", account: "codex", started: true }));
    const fresh = store.createChat(blankChat({ title: "f", role: "chat", account: "codex" }));
    const s = routes.state("tok:0", false) as { chats: { id: number; allowed_accounts: string[]; switch_reason: Record<string, string>; switchable: Record<string, boolean> }[]; accounts: { id: string; label: string; usage: Json[] }[]; defaults: { model: string } };
    const of = (id: number) => s.chats.find((c) => c.id === id);
    expect(of(lead.id)?.allowed_accounts).toEqual(["claude", "claude2"]);
    expect(of(lead.id)?.switchable.account).toBe(true);
    expect(of(sub.id)?.allowed_accounts).toEqual(["codex"]);
    expect(of(sub.id)?.switch_reason.account).toBe("A started chat stays on Codex");
    expect(of(sub.id)?.switch_reason.device).toBe("Only Claude chats move between devices for now");
    expect(of(fresh.id)?.allowed_accounts).toEqual(["claude", "claude2", "codex"]);
    expect(of(fresh.id)?.switch_reason.device).toBe("Only Claude chats run on another device");
    expect(s.accounts.map((a) => [a.id, a.label])).toEqual([
      ["claude", "Claude · AB"],
      ["claude2", "Claude · AB"],
      ["codex", "Codex"],
    ]);
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
      recapSeen: (id) => {
        calls.push(`seen ${id}`);
      },
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
    expect(calls.at(-1)).toBe(`seen ${c.id}`);
    expect([items.status.recap, items.status.suggestion, items.status.can_steer, items.status.follow_up, items.status.queue]).toEqual(["Fixed the build.", "Run the tests", true, "queue", [{ id: 4, text: "next" }]]);
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
        store.saveItems(id, [...store.items(id), { kind: "user", text, files: [], at: 1761200000, mentions: [], sender: o.sender ?? "", intent: "" }, { kind: "text", text: `**echo** ${text}`, at: 1761200001 }]);
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
      recapSeen: () => {},
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
        const why = accountDecide(r.value, "org_a", { at: 0, workspaces: [] });
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
    expect(it.items[0]?.sender).toBe("Pixel (Sam Rig)");
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
