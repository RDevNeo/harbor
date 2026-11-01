import { blankChat, itemHash, type Chat, type Item, type Store } from "@harbor/store";
import type { Call } from "./api.ts";
import { err, ok, urlEncode, type Reply } from "./http.ts";
import { deviceId, draftJson, type Hub } from "./hub.ts";
import { blocks } from "./markdown.ts";
import { forHome, type Mesh } from "./mesh.ts";
import type { StoreReplica } from "./meshstore.ts";
import { dest } from "./shared.ts";
import { hashStr, type Json } from "./wire.ts";
import { actions, cardMedia, project, type Media, type Shown } from "./view.ts";

const CLIP = 16 << 10;

/** What the agents do for the phone routes (the agents package). */
export interface PhoneAgents {
  running(chat: number): boolean;
  /** A message to one of this PC's chats: starts a turn, or steers/queues behind a running one. */
  send(chat: Chat, text: string, files: string[], mode: "steer" | "queue" | null, sender: string): Promise<{ queued: boolean; steering: boolean }>;
  stop(chat: Chat): Promise<void>;
}

/** The providers' lists `/v1/state` carries (the agents package's providers). */
export interface PhoneProviders {
  accounts: Json[];
  models: Record<string, Json>;
  efforts: Record<string, Json>;
  defaultEfforts: Record<string, Json>;
  access: Record<string, Json>;
  defaults: { account: string; model: string; effort: string; access: string };
  /** The accounts a chat may switch to (api.rs `allowed_accounts`). */
  allowedAccounts(c: Chat): string[];
}

export interface PhoneDeps {
  store: Store;
  hub: Hub;
  replica: StoreReplica;
  mesh: Mesh | null;
  version: string;
  myFp: () => string;
  agents: PhoneAgents | null;
  providers?: () => PhoneProviders;
  /** The media a text names or shows (media.rs `find`); none without the media package. */
  find?: (text: string, chat: Chat) => Media[];
  /** The app's version code and url (`GET /v1/app`). */
  app?: () => { version_code: number; url: string };
  /** The user-facing local time of a unix second, "11:40 AM" (team.rs `clock`). */
  clock?: (at: number) => string;
  refs?: MediaRefs;
}

export function clock(at: number): string {
  const d = new Date(at * 1000);
  const h = d.getHours();
  const m = d.getMinutes();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function clipped(s: string): string {
  if (Buffer.byteLength(s) <= CLIP) return s;
  let out = "";
  let n = 0;
  for (const ch of s) {
    n += Buffer.byteLength(ch);
    if (n > CLIP) break;
    out += ch;
  }
  return `${out}…`;
}

export function fileName(p: string): string {
  return p.split("/").filter((x) => x !== "").pop() ?? p;
}

export function imageUrl(path: string): string {
  return `/v1/image?path=${urlEncode(path)}&max=512`;
}

export function mediaUrl(path: string): string {
  return `/v1/media?path=${urlEncode(path)}`;
}

function mediaName(m: Media): string {
  return fileName((m.url ?? m.path).split(/[?#]/)[0] ?? m.path);
}

function mediaJson(m: Media): Record<string, Json> {
  const v: Record<string, Json> = { name: mediaName(m), caption: m.caption, kind: m.video ? "video" : "image", url: m.video ? mediaUrl(m.path) : imageUrl(m.path) };
  if (m.video) v.poster = imageUrl(m.path);
  return v;
}

function mentionJson(m: { from: string; text: string; excerpt: boolean; note: string; kind: string; chat: string; title: string }): Json {
  const v: Record<string, Json> = { from: m.from, text: m.text, excerpt: m.excerpt, note: m.note.trim() };
  if (m.kind === "chat") {
    v.kind = "chat";
    v.chat = m.chat;
    v.title = m.title;
  }
  return v;
}

/** How a reply's markdown images are told apart (media.rs `strip_refs`, `parts`). */
export interface MediaRefs {
  strip(md: string): string;
  parts(md: string): { type: "text" | "media"; text: string }[];
}

/** One card for the phone (api.rs `card_json`), its image addresses naming `chat`. */
export function cardJson(s: Shown, rev: number, find: (t: string) => Media[], chat: string, time: (at: number) => string = clock, refs: MediaRefs | null = null): Record<string, Json> {
  const all = cardMedia(s.card, find);
  const images: Json[] = all.filter((m) => !m.video).map((m) => ({ name: m.url !== null ? mediaName(m) : fileName(m.path), url: imageUrl(m.path) }));
  const large = all.filter((m) => m.shown || m.video);
  const media = large.map(mediaJson);
  const placed: [string, number][] = [];
  const c = s.card;
  let v: Record<string, Json>;
  switch (c.kind) {
    case "hidden":
      v = {};
      break;
    case "user":
      v = { text: c.text, files: c.files.map(fileName), images, mentions: c.mentions.map(mentionJson), at: c.at, sender: c.sender };
      if (c.intent !== "") v.intent = c.intent;
      break;
    case "text": {
      const label = (md: string) => (refs ? refs.strip(md) : md);
      const ps = refs ? refs.parts(c.text) : [];
      if (ps.length > 1) {
        let n = 0;
        for (const p of ps) {
          if (p.type === "text") n += blocks(label(p.text)).length;
          else for (const m of find(p.text)) if (m.shown) placed.push([m.path, n]);
        }
      }
      v = { markdown: c.text, blocks: blocks(label(c.text)) as Json, images, at: c.at, forkable: c.forkable };
      break;
    }
    case "thinking":
      v = { text: c.text };
      break;
    case "tool":
      v = { label: c.label, summary: c.summary, input: clipped(c.input), result: c.result === null ? null : clipped(c.result), done: c.result !== null, is_error: c.is_error, images };
      break;
    case "forked_from":
      v = { chat: c.chat, seq: c.seq };
      break;
    case "chat_link":
      v = { gid: c.gid, text: c.text };
      break;
    case "notice":
      v = { icon: c.icon, text: c.text, detail: clipped(c.detail), detail_markdown: c.markdown, url: c.url };
      break;
    case "message":
      v = { from: c.from, to: c.to, text: clipped(c.text) };
      break;
    case "error":
      v = { text: clipped(c.text) };
      break;
  }
  for (const list of [v.images, media]) {
    if (!Array.isArray(list)) continue;
    for (const i of list) {
      if (typeof i !== "object" || i === null || Array.isArray(i)) continue;
      const o = i as Record<string, Json>;
      for (const k of ["url", "poster"]) if (typeof o[k] === "string") o[k] = `${o[k]}&chat=${urlEncode(chat)}`;
    }
  }
  large.forEach((m, i) => {
    const at = placed.find(([p]) => p === m.path);
    const j = media[i];
    if (at && j) j.after = at[1];
  });
  if (media.length > 0) v.media = media;
  v.kind = c.kind;
  const acts = actions(c);
  if (acts.length > 0) v.actions = acts;
  if (typeof v.at === "number" && v.at > 0) v.time = time(v.at);
  v.seq = s.seq;
  v.rev = rev;
  if (s.forksAfter.length > 0) v.forks_after = s.forksAfter;
  if (s.group !== null) v.group = s.group;
  return v;
}

const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export class PhoneRoutes {
  private revs = new Map<number, [bigint, number][]>();


  constructor(readonly d: PhoneDeps) {}

  private chats(): Chat[] {
    return this.d.store.chats();
  }

  private chatOf(ref: string): Chat | null {
    const id = /^-?\d+$/.test(ref) ? Number(ref) : this.d.hub.mesh.byGid(ref);
    return id === null ? null : (this.chats().find((c) => c.id === id) ?? null);
  }

  private writable(c: Chat): boolean {
    return c.home === "" || this.d.hub.mesh.online(c.home);
  }

  private running(c: Chat): boolean {
    if (c.home !== "") return this.d.replica.remote.get(c.id)?.running ?? false;
    return this.d.agents?.running(c.id) ?? false;
  }

  private typing(chat: number): Json[] {
    const r = this.d.replica.remote.get(chat);
    const list = r ? r.typing : this.d.hub.typing(chat);
    return list.map((t) => {
      const v: Record<string, Json> = { device: t.device, kind: t.kind, label: t.label };
      if (t.text !== "") v.text = t.text;
      return v;
    });
  }

  private draft(chat: number): Json {
    const r = this.d.replica.remote.get(chat);
    const dr = r ? r.draft : this.d.hub.draft(chat);
    return dr ? draftJson(dr) : null;
  }

  private status(c: Chat): Json {
    const r = this.d.replica.remote.get(c.id);
    if (r) return r.status;
    const live = this.d.agents?.running(c.id) ?? false;
    return { queue: [], working: live ? { since_ms: Date.now(), subagents: 0, text: "Working…" } : null, waiting: null, limit: null, agents: null, folder: null, can_steer: false, held: false, follow_up: "steer" };
  }

  private idOf(c: Chat, global: boolean): Json {
    return global ? c.gid : c.id;
  }

  chatJson(c: Chat, global: boolean): Json {
    const hub = this.d.hub;
    const repos = this.d.store.repos();
    const parent = c.parent === null ? null : (this.chats().find((x) => x.id === c.parent) ?? null);
    const project = c.repoId === null ? null : (repos.find((r) => r.id === c.repoId) ?? null);
    return {
      id: this.idOf(c, global),
      project_id: project === null ? null : global ? project.path : project.id,
      title: c.title,
      device: c.device,
      account: c.account,
      model: c.model,
      effort: c.effort,
      access: c.access,
      fast: false,
      settled: c.settled,
      retired: c.retired,
      running: this.running(c),
      queued: c.home !== "" ? (this.d.replica.remote.get(c.id)?.queued ?? 0) : 0,
      working: this.running(c),
      updated_ms: c.updated * 1000,
      rev: hub.chatRev(c.id),
      gid: c.gid,
      home: c.home !== "" ? c.home : hub.mesh.me.id,
      home_name: c.home !== "" ? hub.mesh.nameOf(c.home) : hub.mesh.me.name,
      writable: this.writable(c),
      role: c.role,
      parent: parent === null ? null : this.idOf(parent, global),
      main: false,
      typing: this.typing(c.id),
      draft: this.draft(c.id),
      unread: false,
      failed: false,
      viewing: hub.viewing(c.id).map((t) => ({ device: t.device, kind: t.kind, label: t.label })),
      switchable: { account: false, model: false, effort: false, access: false, device: false, fast: false },
      allowed_accounts: this.d.providers?.().allowedAccounts(c) ?? [],
      worktree: null,
      pr: null,
      snoozed_until_ms: null,
      snoozed_label: null,
    };
  }

  state(you: string, global: boolean): Json {
    const hub = this.d.hub;
    const chats = this.chats();
    const repos = this.d.store.repos();
    const pid = (id: number) => (global ? (repos.find((r) => r.id === id)?.path ?? id) : id);
    const leads = chats.filter((c) => c.role === "lead").sort((a, b) => b.updated - a.updated || b.id - a.id);
    const tree = {
      projects: repos.map((r) => ({ id: pid(r.id), snoozed: false, main: null, chats: leads.filter((c) => !c.settled && c.repoId === r.id).map((c) => this.idOf(c, global)) })),
      threads: leads.filter((c) => !c.settled && (c.repoId === null || !repos.some((r) => r.id === c.repoId))).map((c) => this.idOf(c, global)),
      settled: leads.filter((c) => c.settled).map((c) => this.idOf(c, global)),
      snoozed: [],
    };
    const p = this.d.providers?.() ?? { accounts: [], models: {}, efforts: {}, defaultEfforts: {}, access: {}, defaults: { account: "", model: "", effort: "", access: "full" }, allowedAccounts: () => [] };
    const me = hub.mesh.me;
    const peers = hub.mesh.on ? [...hub.mesh.peers.values()] : [];
    const devices: Json[] = [{ id: "", label: me.name, icon: "monitor", online: true }, ...peers.map((x) => ({ id: x.id, label: x.name, icon: "monitor", online: x.online, hub: true }))];
    return {
      version: this.d.version,
      hub_id: me.id,
      hub_fp: this.d.myFp(),
      hub_addrs: hub.net.addrs,
      hub_port: hub.port,
      mesh: hub.mesh.on,
      hubs: [{ id: me.id, name: me.name, online: true }, ...peers.map((x) => ({ id: x.id, name: x.name, online: x.online }))],
      hub_name: me.name,
      you,
      rev: hub.rev(),
      projects: repos.map((r) => ({ id: pid(r.id), name: r.name, path: r.path })),
      chats: chats.map((c) => this.chatJson(c, global)),
      tree,
      accounts: p.accounts,
      models: p.models,
      efforts: p.efforts,
      default_efforts: p.defaultEfforts,
      access: p.access,
      devices,
      fast: false,
      defaults: { ...p.defaults, device: "", project_id: null },
      app: this.d.app?.() ?? { version_code: 0, url: "/app.apk" },
      hub_update: null,
      provider_updates: null,
      profile_check: null,
      voice: { transcribe: false, why: "voice isn't in this build yet", lang: "auto" },
    };
  }

  items(c: Chat, since: number): Json {
    const hub = this.d.hub;
    const items: Item[] = this.d.store.items(c.id);
    const forks = this.d.replica.remote.get(c.id)?.forks ?? [];
    const cards = project(items, c.role === "lead", forks);
    const revs = this.revs.get(c.id) ?? [];
    const hashes = cards.map((s, i) => {
      const it = items[i];
      const extra = `${s.card.kind}|${s.card.kind === "text" && s.card.forkable}|${s.forksAfter.join(",")}|${s.group ?? ""}`;
      return (it ? itemHash(it) : 0n) ^ hashStr(extra);
    });
    revs.length = Math.min(revs.length, hashes.length);
    if (hashes.some((h, i) => revs[i]?.[0] !== h)) {
      const rev = hub.bump();
      hashes.forEach((h, i) => {
        const r = revs[i];
        if (!r) revs.push([h, rev]);
        else if (r[0] !== h) revs[i] = [h, rev];
      });
    }
    this.revs.set(c.id, revs);
    const find = (t: string) => this.d.find?.(t, c) ?? [];
    const out = cards
      .filter((s) => (revs[s.seq]?.[1] ?? 0) > since)
      .map((s) => {
        const v = cardJson(s, revs[s.seq]?.[1] ?? 0, find, c.gid === "" ? String(c.id) : c.gid, this.d.clock ?? clock, this.d.refs ?? null);
        if (v.kind === "chat_link") v.chat = this.chats().find((x) => x.gid === v.gid)?.id ?? null;
        return v;
      });
    return { rev: hub.rev(), count: items.length, running: this.running(c), queued: 0, typing: this.typing(c.id), draft: this.draft(c.id), status: this.status(c), items: out };
  }

  /** api.rs `api_route` for the calls this build answers. */
  async route(call: Call): Promise<Reply> {
    const p = call.path;
    const m = call.method;
    const body = obj(call.body);
    const sender = this.d.hub.callerLabel(call.token, call.device);
    if (m === "GET" && p.length === 2 && p[1] === "state") return ok(this.state(deviceId(call.token), call.global));
    if (p[0] !== "v1" || p[1] !== "chats") return err(404, "no such call");
    if (m === "POST" && p.length === 2) return this.create(body, sender, call.global);
    const c = this.chatOf(p[2] ?? "");
    if (!c) return err(404, "no such chat");
    if (c.home !== "" && forHome(m, p)) return this.forward(c, m, p, body, sender);
    if (m === "GET" && p.length === 4 && p[3] === "items") {
      const since = Number(call.query.find(([k]) => k === "since")?.[1] ?? "0");
      return ok(this.items(c, Number.isFinite(since) ? since : 0));
    }
    if (m === "POST" && p.length === 4 && p[3] === "send") return this.send(c, body, sender);
    if (m === "POST" && p.length === 4 && p[3] === "stop") {
      if (!this.d.agents) return err(503, "agents aren't available in this build");
      await this.d.agents.stop(c);
      this.d.hub.touch(c.id, true);
      return ok({ ok: true, returned: [], held: body.hold === true });
    }
    if (m === "PATCH" && p.length === 3) {
      if (typeof body.title === "string" && body.title.trim() !== "") {
        this.d.store.saveChat({ ...c, title: body.title.trim() });
        this.d.replica.touch(c.id);
      }
      return ok({ ok: true });
    }
    if (m === "DELETE" && p.length === 3) {
      if (this.d.agents?.running(c.id)) return err(409, "the chat is running: stop it first");
      this.d.store.deleteChat(c.id);
      const rev = this.d.hub.touch(null, true);
      this.d.hub.mesh.gone.push([rev, c.id]);
      this.d.replica.reload();
      return ok({ ok: true });
    }
    return err(404, "no such call");
  }

  private async send(c: Chat, body: Record<string, unknown>, sender: string): Promise<Reply> {
    const text = typeof body.text === "string" ? body.text : "";
    const files = Array.isArray(body.files) ? body.files.filter((f): f is string => typeof f === "string") : [];
    if (text.trim() === "" && files.length === 0) return err(400, "an empty message");
    if (c.retired) return err(409, "this agent was retired: its chat is read-only");
    if (!this.d.agents) return err(503, "agents aren't available in this build");
    const mode = body.mode === "steer" || body.mode === "queue" ? body.mode : null;
    const r = await this.d.agents.send(c, text, files, mode, sender);
    this.d.hub.clearDraft(c.id);
    this.d.replica.touch(c.id);
    return ok({ ok: true, queued: r.queued, steering: r.steering });
  }

  private async create(body: Record<string, unknown>, sender: string, global: boolean): Promise<Reply> {
    const repos = this.d.store.repos();
    const pref = body.project_id;
    const repo = typeof pref === "number" ? (repos.find((r) => r.id === pref) ?? null) : typeof pref === "string" ? (repos.find((r) => r.path === pref) ?? null) : null;
    if (pref !== undefined && pref !== null && !repo) return err(404, "no such project");
    const p = this.d.providers?.().defaults;
    const s = (k: string, d: string) => (typeof body[k] === "string" ? (body[k] as string) : d);
    const text = s("text", "");
    const title = s("title", "") || text.split("\n")[0]?.trim().slice(0, 80) || "New chat";
    const c = this.d.store.createChat(
      blankChat({ repoId: repo?.id ?? null, title, account: s("account", p?.account ?? "claude"), model: s("model", p?.model ?? ""), effort: s("effort", p?.effort ?? ""), role: "lead", name: "lead" }),
    );
    this.d.replica.touch(c.id);
    if (text.trim() !== "") {
      const sent = await this.send(c, { text, files: body.files ?? [] }, sender);
      if (sent.status !== 200) return sent;
    }
    return ok({ id: global ? c.gid : c.id, gid: c.gid });
  }

  private async forward(c: Chat, method: string, p: string[], body: Record<string, unknown>, sender: string): Promise<Reply> {
    const peer = this.d.hub.mesh.peer(c.home);
    if (!peer?.online || !this.d.mesh) return err(409, `${this.d.hub.mesh.nameOf(c.home)} is off: the chat is read-only until it's back`);
    const path = ["v1", "chats", String(c.homeId), ...p.slice(3)];
    const { files: _files, ...rest } = body;
    return this.d.mesh.forward(dest(peer), peer.name, method, path, rest, [], [sender, ""], null);
  }
}
