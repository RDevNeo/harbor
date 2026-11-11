import { allowedAccounts, checkRun, isRunError, lockLeads } from "./runsettings.ts";
import type { providers, SentBy } from "@harbor/agents";
import { blankChat, githead, itemHash, liveSince, mention, parseAccess, repoDir, sidebartree, usertext, type Chat, type Item, type Mention, type Placement, type SentVia, type Store } from "@harbor/store";
import type { Call } from "./api.ts";
import { err, ok, urlEncode, type Reply } from "./http.ts";
import { deviceId, draftEmpty, draftJson, resolveUpload, type Hub } from "./hub.ts";
import { blocks, markCommits, type CommitRef } from "./markdown.ts";
import { CHAT_SCHEME, type ChatLinkWorld, chatLinkTargets, labelChatLinks } from "./chatlink.ts";
import { forHome, startsTurn, type Mesh } from "./mesh.ts";
import { Once, sendKey } from "./once.ts";
import { sameRemote } from "./meshstore.ts";
import type { StoreReplica } from "./meshstore.ts";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { hostLabel, hostname, ICONS, isFound, type RemoteHost } from "./remote.ts";
import { dest, type Peer } from "./shared.ts";
import { AUTO_DEVICE, ramText } from "./ram.ts";
import { accountOn, chatOwner, isSharedId, kindLabel, sharedAccess, sharedTarget, type SharedAccount } from "./meshaccounts.ts";
import type { MoveWant } from "./movepc.ts";
import { F64, hashStr, type Json } from "./wire.ts";
import { actions, cardMedia, groups, project, type Media, type Shown } from "./view.ts";
import { captchaRoles } from "./captchanote.ts";
import { cardLook } from "./look.ts";
import { pcOwner, phoneDev, type Viewer } from "./senders.ts";
import { RESUME_TEXT, resumeNow } from "./resume.ts";

const CLIP = 16 << 10;

/** Who wrote a message elsewhere, on what and on which device (`Item` user's `who`, `via` and `dev`). */
interface Who {
  who: string;
  via: SentVia | null;
  dev: string;
}

const NOBODY: Who = { who: "", via: null, dev: "" };
const now = (): number => Math.floor(Date.now() / 1000);
const utcOffset = (at: number): number => -new Date(at * 1000).getTimezoneOffset() * 60;

/** `@harbor/agents`' Engine as far as the phone routes use it. */
export interface PhoneEngine {
  running(id: number): boolean;
  runningSince(id: number): number | null;
  transcript(id: number): { items: Item[] };
  send(id: number, text: string, opts: { files?: string[]; mentions?: Mention[]; mode?: "steer" | "queue"; sender?: string; device?: string; who?: string; via?: SentVia | undefined; dev?: string; from?: SentBy | null }): void;
  stop(id: number): void;
  queued(id: number): readonly { intent: string; text: string; files: string[] }[];
  takeQueue(id: number): { text: string; files: string[] }[];
  queueJson(id: number): unknown[];
  steering(id: number): string;
  followDefault(): string;
  held(id: number): boolean;
  newThread(repo: number | null, first: string, sel: { account: string; model: string; effort: string; access: string; device: string }): Chat;
  reload(): void;
  queuePromote(id: number, qid: number): boolean;
  queueMove(id: number, qid: number, to: number): boolean;
  queueUpdate(id: number, qid: number, text: string | null, mentions: Mention[] | null, editing: string | null): boolean;
  queueRemove(id: number, qid: number): boolean;
  queueResume(id: number): void;
  /** The session recap (always null now: removed) and the suggested next message shown under the chat (recap.rs). */
  recap(id: number): [string | null, string | null];
  /** Finished while nobody had the chat open, not opened since; whether that last turn failed. */
  unread(id: number): boolean;
  failed(id: number): boolean;
  /** A phone opened the chat: both marks go; true when it had one. */
  opened(id: number): boolean;
  /** Messages held for a chat (api.rs `queued_count`). */
  queuedCount(id: number): number;
  /** Messages waiting for a lead's idle sub-agents. */
  subsQueued(lead: number): number;
  /** The folder of the git worktree the chat works in, when it has one. */
  worktreeOf?(id: number): string | null;
  /** Its account hit a usage limit: it waits for it to lift (the sidebar's amber "Limited"). */
  limited?(id: number): boolean;
  mainChat(repo: number): number | null;
  forksOf(id: number): [number, number][];
  /** PROTOCOL.md `wait`: what wakes the chat once its own turn is done, null for nothing (hubs from 0.149). */
  wait?(id: number): Json;
  /** Moves a chat to another account with its conversation (agents' Engine.switchAccount); throws why not. */
  switchAccount?(id: number, to: string, opts: { model?: string | undefined; effort?: string | undefined; why?: string }): string;
  chat?(id: number): Chat | undefined;
}

export type Choice = readonly [key: string, label: string, detail: string];

/** A provider account as `@harbor/agents` lists it (providers `Account`). */
export interface CatalogAccount {
  id: string;
  kind: string;
  name: string;
  badge: string;
  bin: string | null;
  loggedIn: boolean | null;
  /** Turned off in Settings › Providers: the phone isn't offered it. */
  off?: boolean;
  usage: { label: string; percent: number }[];
}

/** The providers' side of `/v1/state`: `@harbor/agents`' providers module and the app's lists. */
export interface Catalog {
  /** Provider kinds by label ("Claude", "Codex", …), in order. */
  kinds: readonly string[];
  accounts(): CatalogAccount[];
  models(kind: string): { id: string; label: string; more: boolean }[];
  efforts(kind: string): readonly Choice[];
  defaultEffort(kind: string): string;
  access(kind: string): readonly Choice[];
  hasFast(kind: string): boolean;
  /** The new-chat composer's picks (Rust's `draft.sel`). */
  defaults(): { account: string; model: string; effort: string; access: string; device: string };
  fast(): boolean;
  /** Why a started Claude chat can't move anywhere now (relocate.rs). */
  relocateBlocker?(chat: Chat): string | null;
  deviceWhy?(chat: Chat): Json;
  movingTo?(chat: Chat): string | null;
  /** This PC's and the mesh's accounts, each sign-in once (meshaccounts.ts `sharedAccounts`); absent: this PC's alone. */
  shared?(): SharedAccount[];
}

/** "Move to PC…" as the phone routes ask for it (movepcrun.ts `MovePc`). */
export interface PhoneMove {
  targetsJson(chat: number): Promise<Json>;
  /** `want`: the chat switched to one of `pc`'s accounts (meshaccounts.ts): it goes on there with that one. */
  movePc(chat: number, pc: string, want?: MoveWant | null): Promise<string>;
}

export interface PhoneDeps {
  store: Store;
  hub: Hub;
  replica: StoreReplica;
  mesh: Mesh | null;
  version: string;
  myFp: () => string;
  engine: PhoneEngine | null;
  uploadsDir?: string;
  catalog?: Catalog;
  /** `voice` in `/v1/state`: whether this PC transcribes a phone's recording, and in which language. */
  voice?: () => { transcribe: boolean; why: string | null; lang: string };
  updates?: () => { hub_update: Json };
  /** The media a text names or shows (media.rs `find`); none without the media package. */
  find?: (text: string, chat: Chat) => Media[];
  /** The app's version code and url (`GET /v1/app`). */
  app?: () => { version_code: number; url: string };
  /** The user-facing local time of a unix second, "11:40 AM" (team.rs `clock`). */
  clock?: (at: number) => string;
  refs?: MediaRefs;
  /** Whether chats homed on PC `home` show (account.ts `scopeHas`); absent: all do. */
  scope?: (home: string) => boolean;
  /** The commits a reply of `chat` names; their pills come once git has answered (then `chat` is touched). */
  commits?: (chat: Chat) => CommitLookup | null;
  /** What a PATCH of a chat's account, model, effort, access, device or fast mode is checked against. */
  runSettings?: RunSettings;
  /** Settings › Workspace as the desktop lists them: the configured SSH devices and the tailnet's PCs, with whether each is online (null: not known). */
  devices?: () => [RemoteHost, boolean | null][];
  /** The pull request of the branch a chat works on, as chat JSON `pr` says it (null: none); a copy's as its home PC says it. */
  pr?: (chat: Chat) => Json;
  /** The status bars of a chat of this PC: working, waiting, limit, agents and folder (api.rs `api_status`). */
  bars?: (chat: number, nowMs: number) => Record<string, Json>;
  /** "Is this you?": this PC's detected owner, until confirmed (null: nothing to ask). */
  profileCheck?: () => Json;
  /** The calls the app around answers beyond chats' core: a chat's actions, the snooze sheet, usage, people, palette…; null when the call is not one of them. */
  more?: (call: Call, chat: Chat | null) => Promise<Reply | null>;
  /** A chat an agent opened: its first notice names the chat that opened it (openchat.rs). */
  openedFrom?: (chat: number, gid: string, title: string) => void;
  /** "Move to PC…"; without it the two calls answer 404. */
  move?: PhoneMove;
  /** This PC's instructions and memory for a call that may start a turn on another PC, with `repo`'s memory (meshctx.ts `outgoingCtx`). */
  ctx?: (repo: number | null) => Json;
  /** What this PC lets `peer`'s chats do here (machines.rs level: "off", "read", "edit", "full"); absent: full. */
  shareLevel?: (peer: string) => string;
  /** Where a project's folder is when it isn't on this PC (null: it's here); its `pc` is a mesh PC's id ("": none known). */
  projectPlace?: (repo: number) => { pc: string; name: string; online: boolean } | null;
  /** The hash of a project's icon, as the desktop's sidebar shows it ("" none: its letter); `/v1/projects/icon` has the picture. */
  projectIcon?: (repo: number) => string;
  /** A started chat moved between this PC, its devices and other PCs (relocate.rs). */
  relocate?: { why(chatId: number, to: string): string | null; relocate(chatId: number, to: string): Promise<string> };
  /** A chat whose PC is off goes on on another PC (failover.ts): the line saying where, and its messages. */
  failover?: {
    line(c: Chat): { text: string; warn: boolean } | null;
    send(c: Chat, msg: { text: string; files: string[]; mentions: unknown[] }, to: string | null, sendHere: (own: Chat) => Promise<Reply>): Promise<Reply>;
    /** A new chat in a project whose folder's PC is off: where it starts ("" here, null nowhere now). */
    draft(repo: number): { to: string | null; line: string; off: string } | null;
    startedNotice(chat: number, off: string): void;
  };
  /** A new chat asked to start in a new worktree (worktree.rs): `make` is null for a project without Git; `made` is what `make` answered. */
  worktrees?: {
    make(repo: number | null, base: string, about: string): Promise<unknown>;
    attach(chat: number, made: unknown): void;
    discard(repo: number | null, made: unknown): void;
  };
  /** A chat is about to be deleted: its worktree goes too. */
  dropChat?: (chat: Chat) => void;
  /** The "Auto" pick of where a new chat runs (runon.ts): the PC with the most free memory. */
  auto?: PhoneAuto;
}

/** runon.ts's Auto for the phone's calls. */
export interface PhoneAuto {
  /** Where Auto would put a new chat of `kind` now ("" this PC); null: nowhere. */
  pick(kind: string): { id: string; name: string; ram: number | null } | null;
  /** "auto" as the PC picked now; other values as they are. */
  resolve(device: string, kind: string): { device: string; auto: boolean };
  mark(gid: string, place: string): void;
  /** "Auto → <PC>" while the chat is where Auto put it (`here`: this PC's name). */
  label(c: Chat, here: string): string | null;
  /** Auto picked in a started chat: it moves now to the PC with the most free memory, as a pick of that PC would. */
  relocate?(chatId: number, kind: string): Promise<{ to: string; name: string; moved: boolean }>;
  /** Why Auto can't move that started chat now; null: it can. */
  why?(chatId: number, kind: string): string | null;
}

export interface RunSettings {
  accounts(): providers.Account[];
  modelsFor(k: providers.Kind): providers.Model[];
  /** The ids of the devices there are. */
  devices(): string[];
  setFast(on: boolean): void;
}

/** What tells an item's versions apart without serializing it: a tool's input and result are set once, so their lengths stand in for them; replies and thinking grow while they stream; the rest are small. */
export function nothingToSend(text: string, files: number, mentions: number): boolean {
  return text.trim() === "" && files === 0 && mentions === 0;
}

export function fingerprint(it: Item): bigint {
  if (it.kind === "tool") return hashStr(JSON.stringify(["tool", it.id, it.name, it.summary, it.input.length, it.result === null ? null : it.result.length, it.is_error]));
  if (it.kind === "text") return hashStr(JSON.stringify([1, it.text, it.at]));
  if (it.kind === "thinking") return hashStr(JSON.stringify([2, it.text]));
  return itemHash(it);
}

export function clock(at: number): string {
  const d = new Date(at * 1000);
  const h = d.getHours();
  const m = d.getMinutes();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function clipped(s: string): string {
  const b = Buffer.from(s);
  if (b.length <= CLIP) return s;
  let end = CLIP;
  while (end > 0 && ((b[end] ?? 0) & 0xc0) === 0x80) end--;
  return `${b.subarray(0, end).toString("utf8")}\n… (${b.length - end} more bytes)`;
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

function deviceIcon(h: RemoteHost): string {
  if (ICONS.some(([n]) => n === h.icon)) return h.icon;
  if (h.os === "macOS") return "laptop";
  return h.os === "" && !isFound(h) ? "terminal" : "monitor";
}

function mentionJson(m: { from: string; text: string; excerpt: boolean; note: string; kind: string; chat: string; title: string }): Json {
  const text = m.kind === "chat" ? m.from : (m.text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "");
  const v: Record<string, Json> = { from: m.from, text, excerpt: m.excerpt, note: m.note.trim() };
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
/** The commits a reply names, found in the chat's project (agents' `commits.ofText`), and how a text splits into tokens. */
export interface CommitLookup {
  ofText(md: string): Map<string, CommitRef>;
  tokens(text: string): [number, number][];
}

/** A reply's chat links as this hub resolves them (`chat_links`): link as written → `{title, chat, missing}`, `chat` already in the caller's ids. */
export type LinkTargets = (md: string) => Record<string, { title: string; chat: Json; missing: string }>;

/** `look`: how the card draws, as the desktop decides it (look.ts `cardLook`, PROTOCOL.md `look`); null: nothing to say. */
export function cardJson(s: Shown, rev: number, find: (t: string) => Media[], chat: string, time: (at: number) => string = clock, refs: MediaRefs | null = null, commits: CommitLookup | null = null, links: LinkTargets | null = null, look: Record<string, Json> | null = null): Record<string, Json> {
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
      // Hubs from 0.115: the bubble's "<person> <phone or PC icon>" line (older apps show `sender`).
      if (c.via !== "") {
        v.who = c.who;
        v.via = c.via;
      }
      // Joins the user card before it (hubs from 0.115): no sender row, a small gap.
      if (c.joined) v.joined = true;
      if (c.intent !== "") v.intent = c.intent;
      {
        const ps = usertext.parts(c.text, c.mentions);
        if (!usertext.plain(ps)) v.parts = usertext.wire(ps);
      }
      break;
    case "text": {
      // A chat link reads as its chat's title, as on the desktop (api.rs `chat_links`).
      const targets = links && c.text.includes(CHAT_SCHEME) ? links(c.text) : {};
      const titled = Object.keys(targets).length > 0;
      const label = (md: string) => {
        const t = refs ? refs.strip(md) : md;
        return titled ? labelChatLinks(t, (u) => targets[u]?.title ?? u) : t;
      };
      const ps = refs ? refs.parts(c.text) : [];
      if (ps.length > 1) {
        let n = 0;
        for (const p of ps) {
          if (p.type === "text") n += blocks(label(p.text)).length;
          else for (const m of find(p.text)) if (m.shown) placed.push([m.path, n]);
        }
      }
      const bs = blocks(label(c.text));
      const known = commits ? commits.ofText(c.text) : new Map<string, CommitRef>();
      if (commits) markCommits(bs, known, (t) => commits.tokens(t));
      v = { markdown: c.text, blocks: bs as Json, images, at: c.at, forkable: c.forkable };
      if (titled) v.chat_links = targets;
      if (known.size > 0) v.commits = Object.fromEntries([...known.values()].map((x) => [x.sha, { sha: x.sha, short: x.short, subject: x.subject, author: x.author, at: x.at }]));
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
  if (look !== null) {
    // A markdown detail (a sub-agent's report) comes as blocks too, drawn as a reply's are.
    const l = { ...look };
    if (c.kind === "notice" && c.markdown && l.expandable === true) l.blocks = blocks(c.detail.length > CLIP ? clipped(c.detail) : c.detail) as Json;
    v.look = l;
  }
  return v;
}

const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export class PhoneRoutes {
  private revs = new Map<string, [bigint, number][]>();
  /** A phone's send repeated with the same client id (its retry) runs once (Once). */
  private sends = new Once<Reply>();


  constructor(readonly d: PhoneDeps) {}

  /** The chats a phone sees: this PC's own and copies from the PCs this account uses (account.ts `pcScope`). */
  private chats(): Chat[] {
    const all = this.d.store.chats();
    const has = this.d.scope;
    return has === undefined ? all : all.filter((c) => c.home === "" || has(c.home));
  }

  /** The projects a phone sees (sidebartree.inScope): not those known only from chats of PCs outside the account's scope. */
  private repos() {
    const repos = this.d.store.repos();
    const has = this.d.scope;
    return has === undefined ? repos : sidebartree.inScope(this.d.store.chats(), repos, has, (r) => existsSync(repoDir(r))).repos;
  }

  private chatOf(ref: string): Chat | null {
    const id = /^-?\d+$/.test(ref) ? Number(ref) : this.d.hub.mesh.byGid(ref);
    return id === null ? null : (this.chats().find((c) => c.id === id) ?? null);
  }

  private writable(c: Chat): boolean {
    return !c.retired && (c.home === "" || this.d.hub.mesh.online(c.home) || this.d.failover !== undefined);
  }

  since(id: number): number | null {
    return liveSince(this.d.engine?.runningSince(id) ?? null, this.d.replica.remote.get(id));
  }

  /** api.rs `team_working`: a lead works while a sub-agent runs or has work queued. */
  private teamWorking(c: Chat): boolean {
    if (c.role !== "lead") return this.running(c);
    const team = [c, ...this.d.store.subs(c.id).filter((x) => x.role === "sub")];
    return team.some((x) => this.since(x.id) !== null) || (this.d.engine?.subsQueued(c.id) ?? 0) > 0;
  }

  /** What wakes the chat once its turn is done (statusbars.ts `waitJson`); a copy's as its home PC says it in its status. */
  private wait(c: Chat): Json {
    if (c.home !== "") {
      const st = this.d.replica.remote.get(c.id)?.status;
      return st !== null && typeof st === "object" && !Array.isArray(st) ? ((st as Record<string, Json>).wait ?? null) : null;
    }
    return this.d.engine?.wait?.(c.id) ?? null;
  }

  queuedCount(c: Chat): number {
    if (c.home !== "") return this.d.replica.remote.get(c.id)?.queued ?? 0;
    return this.d.engine?.queuedCount(c.id) ?? 0;
  }

  private running(c: Chat): boolean {
    if (c.home !== "") return this.d.replica.remote.get(c.id)?.running ?? false;
    return this.d.engine?.running(c.id) ?? false;
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
    if (!r) {
      const dr = this.d.hub.draft(chat);
      return dr ? draftJson(dr) : null;
    }
    if (!r.draft) return null;
    // Another PC's chat leaves `files` out (PROTOCOL.md "Typing"): they're that PC's uploads, never
    // this PC's (the lease forwards none), and an empty list would take back the files a phone attached.
    // A cleared draft (a message went out: nobody wrote it) empties them too: they went with the message.
    const { files: _files, ...rest } = draftJson(r.draft) as Record<string, Json>;
    return r.draft.by === "" && draftEmpty(r.draft) ? { ...rest, files: [] } : rest;
  }

  /** api.rs `api_status`: the bars under the transcript; a copy's as its home PC says them. */
  status(id: number): Json {
    const c = { id };
    const r = this.d.replica.remote.get(c.id);
    if (r) return r.status;
    const e = this.d.engine;
    const since = e?.runningSince(c.id) ?? null;
    const bars = this.d.bars?.(c.id, Date.now());
    const out: Record<string, Json> = {
      queue: (e?.queueJson(c.id) ?? []) as Json[],
      working: since === null ? null : { since_ms: since, subagents: 0, text: "Working…" },
      waiting: null,
      limit: null,
      agents: null,
      folder: null,
      wait: null,
      ...bars,
      can_steer: e !== null && e.steering(c.id) !== "no",
      held: e?.held(c.id) ?? false,
      follow_up: e?.followDefault() ?? "steer",
    };
    const [recap, suggestion] = e?.recap(c.id) ?? [null, null];
    if (recap !== null) out.recap = recap;
    if (suggestion !== null) out.suggestion = suggestion;
    return out;
  }

  private idOf(c: Chat, global: boolean): Json {
    return global ? c.gid : c.id;
  }

  /** `place`: where Move to workspace… put chats and projects (read once for a whole list). */
  chatJson(c: Chat, global: boolean, place: Placement = this.d.store.placement()): Json {
    const hub = this.d.hub;
    const repos = this.d.store.repos();
    const parent = c.parent === null ? null : (this.d.store.chat(c.parent) ?? null);
    const project = c.repoId === null ? null : (repos.find((r) => r.id === c.repoId) ?? null);
    return {
      id: this.idOf(c, global),
      project_id: project === null ? null : global ? project.path : project.id,
      title: c.title,
      device: c.device,
      // "Auto → <PC>" while the chat is where Auto put it; null otherwise.
      auto_label: this.d.auto?.label(c, hub.mesh.me.name === "" ? hostname() : hub.mesh.me.name) ?? null,
      account: c.account,
      model: c.model,
      effort: c.effort,
      access: c.access,
      fast: this.d.catalog?.fast() ?? false,
      settled: c.settled,
      retired: c.retired,
      running: this.running(c),
      queued: this.queuedCount(c),
      working: this.teamWorking(c),
      wait: this.wait(c),
      updated_ms: c.updated * 1000,
      rev: hub.chatRev(c.id),
      gid: c.gid,
      home: c.home !== "" ? c.home : hub.mesh.me.id,
      home_name: c.home !== "" ? hub.mesh.nameOf(c.home) : hub.mesh.me.name,
      writable: this.writable(c),
      // Its PC is off: where the next message goes (another PC takes the chat over), or that it waits.
      failover: this.d.failover?.line(c)?.text ?? null,
      failover_warn: this.d.failover?.line(c)?.warn === true,
      role: c.role,
      parent: parent === null ? null : this.idOf(parent, global),
      main: this.isMain(c),
      typing: this.typing(c.id),
      draft: this.draft(c.id),
      unread: this.d.engine?.unread(c.id) ?? false,
      failed: this.d.engine?.failed(c.id) ?? false,
      viewing: hub.viewing(c.id).map((t) => ({ device: t.device, kind: t.kind, label: t.label })),
      ...this.runSettings(c),
      worktree: this.worktree(c),
      // The branch it works on as the sidebar names it (its worktree's, else its project's checkout's); "" none known.
      branch: this.branch(c, project),
      limited: this.d.engine?.limited?.(c.id) ?? false,
      // Someone else's chat (its account is theirs): their initials and photo on its row; null for yours.
      owner: this.owner(c),
      pr: this.d.pr?.(c) ?? null,
      snoozed_until_ms: this.snoozeUntil(`c${c.id}`) === null ? null : (this.snoozeUntil(`c${c.id}`) ?? 0) * 1000,
      snoozed_label: sidebartree.snoozedLabel(this.snoozeUntil(`c${c.id}`), now(), utcOffset(now())),
      // The workspace it was moved to (its own, its lead's or its project's); "": its home PC's.
      workspace: sidebartree.movedTo(c, (id) => this.d.store.chat(id), place),
      // Share with workspace…: the workspaces it shows in besides that one (its own, its lead's, its project's).
      shared: sidebartree.sharedWith(c, (id) => this.d.store.chat(id), place).all,
    };
  }

  private snoozeUntil(key: string): number | null {
    try {
      const v: unknown = JSON.parse(this.d.store.get("snoozed") ?? "{}");
      const t = typeof v === "object" && v !== null ? (v as Record<string, unknown>)[key] : undefined;
      return typeof t === "number" && t > now() ? t : null;
    } catch {
      return null;
    }
  }

  private isMain(c: Chat): boolean {
    if (c.repoId === null) return false;
    return this.d.store.mainChats().get(c.repoId) === c.id && sidebartree.isMainOf(c, c.repoId);
  }

  private branch(c: Chat, project: Parameters<typeof repoDir>[0] | null): string {
    if (c.home !== "") {
      const r = this.d.replica.remote.get(c.id);
      return r?.branch || githead.branchLabel(r?.worktree ?? "");
    }
    const dir = this.d.engine?.worktreeOf?.(c.id) ?? (project === null ? null : repoDir(project));
    return dir === null ? "" : githead.branchLabel(githead.branchOf(dir));
  }

  private owner(c: Chat): Json {
    const o = chatOwner(this.d.catalog?.shared?.() ?? [], c);
    return o === null ? null : { mark: o.mark ?? o.badge, name: o.shown === "" ? o.person : o.shown, photo: o.photo };
  }

  private worktree(c: Chat): Json {
    if (c.home !== "") {
      const name = this.d.replica.remote.get(c.id)?.worktree ?? null;
      return name === null ? null : { name, path: null, gone: false };
    }
    const w = this.d.engine?.worktreeOf?.(c.id) ?? null;
    if (w === null) return null;
    let gone = true;
    try {
      gone = !statSync(w).isDirectory();
    } catch {
      // the folder is gone
    }
    return { name: basename(w), path: w, gone };
  }

  private kindOf(c: Chat): string {
    return this.d.catalog?.accounts().find((a) => a.id === c.account)?.kind ?? "Claude";
  }

  /** api.rs `allowed_accounts`; a lead on this PC (not on a device) may also switch to another PC's account, which moves it there. */
  allowedAccounts(c: Chat): string[] {
    const cat = this.d.catalog;
    if (!cat) return [];
    const locked = lockLeads(c, (id) => cat.accounts().find((a) => a.id === id)?.kind);
    const own = cat
      .accounts()
      .filter((a) => a.bin !== null && a.off !== true && (locked === undefined || a.kind === locked))
      .map((a) => a.id);
    if (c.role === "sub" || c.device !== "" || locked !== undefined || !this.d.move) return own;
    const other = (cat.shared?.() ?? []).filter((x) => x.pc !== "" && x.pc !== c.home && x.why === "").map((x) => x.id);
    return [...own, ...other];
  }

  /** `switchable`, `allowed_accounts`, `switch_reason`, `device_why`, `moving_to` (api.rs `chat_json`). */
  private runSettings(c: Chat): Record<string, Json> {
    const cat = this.d.catalog;
    const kind = this.kindOf(c);
    const allowed = this.allowedAccounts(c);
    const efforts = cat?.efforts(kind) ?? [];
    const access = cat?.access(kind) ?? [];
    const fast = cat?.hasFast(kind) ?? false;
    const blocker = c.started && kind === "Claude" ? (cat?.relocateBlocker?.(c) ?? null) : null;
    const why: Record<string, Json> = {};
    if (!allowed.some((a) => a !== c.account)) why.account = c.role === "lead" && c.started && c.device !== "" ? "Only Claude runs on another device" : c.started && c.role !== "lead" ? `A started chat stays on ${kind}` : "No other account";
    if (efforts.length === 0) why.effort = `${kind} has no effort levels`;
    if (access.length <= 1) why.access = `${kind} has one access level`;
    if (c.started && kind === "Claude") {
      if (blocker !== null) why.device = blocker;
    } else if (c.started) why.device = "Only Claude chats move between devices for now";
    else if (kind !== "Claude") why.device = "Only Claude chats run on another device";
    if (!fast) why.fast = `${kind} has no fast mode`;
    return {
      switchable: { account: allowed.some((a) => a !== c.account), model: true, effort: efforts.length > 0, access: access.length > 1, device: kind === "Claude" && (!c.started || blocker === null), fast },
      allowed_accounts: allowed,
      switch_reason: why,
      device_why: !c.started || c.home !== "" ? null : this.deviceWhy(c, kind),
      // Its Device picker has Auto: a started Claude chat of this PC moves to the PC with the most free memory.
      auto_moves: c.started && c.home === "" && kind === "Claude" && this.d.auto?.relocate !== undefined,
      moving_to: cat?.movingTo?.(c) ?? null,
    };
  }

  /** A started chat's `device_why` (by device id), with Auto's ("auto") when its best PC can't take the chat now. */
  private deviceWhy(c: Chat, kind: string): Record<string, Json> {
    const base = this.d.catalog?.deviceWhy?.(c) ?? {};
    const m: Record<string, Json> = typeof base === "object" && base !== null && !Array.isArray(base) ? { ...(base as Record<string, Json>) } : {};
    const w = kind === "Claude" ? (this.d.auto?.why?.(c.id, kind) ?? null) : null;
    if (w !== null) m[AUTO_DEVICE] = w;
    return m;
  }

  state(you: string, global: boolean): Json {
    const hub = this.d.hub;
    const chats = this.chats();
    const repos = this.repos();
    const pid = (id: number) => (global ? (repos.find((r) => r.id === id)?.path ?? id) : id);
    const settledRepos = this.d.store.settledProjects();
    const place = this.d.store.placement();
    const carried = sidebartree.carriedProjects(chats, place);
    const placed = sidebartree.tree(repos.map((r) => r.id), chats, this.d.store.mainChats(), (key) => this.snoozeUntil(key) !== null, new Set(settledRepos.keys()));
    const idsOf = (list: number[]): Json[] => list.map((id) => this.idOf(chats.find((c) => c.id === id) as Chat, global));
    // A snoozed project or chat keeps its place: the project says when it wakes (`snoozed_label`,
    // the chat its own), for its row to show it muted. No `snoozed: true` (older apps left
    // those projects out) and no list of snoozed chats (they searched those apart).
    const t = now();
    const tree = {
      projects: placed.projects.map((p) => ({
        id: pid(p.id),
        main: p.main === null ? null : idsOf([p.main])[0] ?? null,
        chats: idsOf(p.chats),
        snoozed_label: p.snoozed ? sidebartree.snoozedLabel(this.snoozeUntil(`r${p.id}`), t, utcOffset(t)) : null,
      })),
      threads: idsOf(placed.threads),
      settled: idsOf(placed.settled),
      settled_projects: placed.settledProjects.map(pid),
    };
    const cat = this.d.catalog;
    const slug = (k: string) => k.toLowerCase();
    const choice = (c: Choice) => ({ id: c[0], label: c[1], desc: c[2] });
    const perKind = <T extends Json>(f: (k: string) => T): Record<string, Json> => Object.fromEntries((cat?.kinds ?? []).map((k) => [slug(k), f(k)]));
    // Each sign-in once, badged with its owner (meshaccounts.ts); another PC's run there, and say which and whether it's on.
    const shared = cat?.shared?.() ?? null;
    const accounts: Json[] = (cat?.accounts() ?? [])
      .filter((a) => a.bin !== null && a.off !== true)
      .flatMap((a) => {
        const sh = shared?.find((x) => x.pc === "" && x.account === a.id);
        // A second profile signed in as the same person as an earlier one is that one.
        if (shared !== null && sh === undefined && a.loggedIn !== false) return [];
        const o: Record<string, Json> = {
          id: a.id,
          label: sh ? sh.label : a.kind === "Claude" ? `Claude · ${a.badge}` : a.kind,
          name: a.name,
          kind: slug(a.kind),
          signed_in: a.loggedIn ?? true,
          // Every provider can lead a new chat (OpenCode's has no team tools: it works alone).
          can_start: true,
          usage: a.usage.map((u) => ({ label: u.label, percent: new F64(Math.round(u.percent * 1000) / 10) })),
        };
        if (sh) Object.assign(o, { badge: sh.badge, owner: sh.person, pc: "", pc_name: sh.pcName }, sh.photo === "" ? {} : { photo: sh.photo });
        return [o];
      });
    for (const sh of shared ?? []) {
      if (sh.pc === "") continue;
      accounts.push({
        id: sh.id,
        label: sh.label,
        name: `${sh.shown === "" ? kindLabel(sh.kind) : sh.shown} on ${sh.pcName}`,
        kind: sh.kind,
        signed_in: true,
        // Picked, a new chat starts on that PC, which runs it with its own sign-in.
        can_start: sh.why === "",
        usage: [],
        badge: sh.badge,
        ...(sh.photo === "" ? {} : { photo: sh.photo }),
        owner: sh.person,
        pc: sh.pc,
        pc_name: sh.pcName,
        why: sh.why === "" ? null : sh.why,
        models: sh.models.length === 0 ? null : sh.models.map(([id, label]) => ({ id, label, more: false })),
      });
    }
    const sel = cat?.defaults() ?? { account: "", model: "", effort: "", access: "full", device: "" };
    const updates = this.d.updates?.() ?? { hub_update: null };
    const me = hub.mesh.me;
    const peers = hub.mesh.on ? [...hub.mesh.peers.values()].sort((x, y) => Number(y.online) - Number(x.online) || Buffer.compare(Buffer.from(x.name), Buffer.from(y.name))) : [];
    const here = me.name === "" ? hostname() : me.name;
    const devices: Record<string, Json>[] = [{ id: "", label: here, icon: "monitor", online: true }];
    if (this.d.auto) {
      // Second, so a phone whose pick is gone still falls back to this PC (the first).
      const best = this.d.auto.pick("Claude");
      const name = best === null ? "" : best.id === "" ? here : best.name;
      devices.push({
        id: AUTO_DEVICE,
        label: "Auto",
        pick_label: best === null ? "Auto" : `Auto \u{2192} ${name}`,
        icon: "sparkles",
        online: true,
        auto: true,
        enabled: best !== null,
        desc: best === null ? "No PC can take it now" : `Most free memory now: ${name}${best.ram === null ? "" : ` \u{b7} ${ramText(best.ram)}`}`,
      });
    }
    for (const [h, online] of this.d.devices?.() ?? []) if (!h.hidden) devices.push({ id: h.id, label: hostLabel(h), icon: deviceIcon(h), online });
    for (const x of peers) {
      const d = devices.find((y) => y.id === x.id);
      if (d) {
        d.hub = true;
        d.online = x.online;
      } else devices.push({ id: x.id, label: x.name, icon: "monitor", online: x.online, hub: true });
    }
    return {
      version: this.d.version,
      hub_id: me.id,
      hub_fp: this.d.myFp(),
      hub_addrs: hub.net.addrs,
      hub_port: hub.port,
      mesh: hub.mesh.on,
      hubs: [{ id: me.id, name: me.name, online: true }, ...peers.map((x) => ({ id: x.id, name: x.name, online: x.online }))],
      hub_name: me.name === "" ? hostname() : me.name,
      you,
      rev: hub.rev(),
      projects: repos.map((r) => {
        const at = this.placeJson(r.id);
        // Where it was moved: here, or (its folder on another PC) as that PC says it in its chats' copies; "": its PC's.
        const moved = place.repos.get(r.id) ?? (at.here === true ? "" : (carried.get(r.id) ?? ""));
        return { id: pid(r.id), name: r.name, path: r.path, settled: settledRepos.has(r.id), workspace: moved, shared: [...(place.shared?.repos.get(r.id) ?? [])], icon: this.d.projectIcon?.(r.id) ?? "", ...at };
      }),
      chats: chats.map((c) => this.chatJson(c, global, place)),
      tree,
      accounts,
      models: perKind((k) => (cat?.models(k) ?? []).map((m) => ({ id: m.id, label: m.label, more: m.more }))),
      efforts: perKind((k) => (cat?.efforts(k) ?? []).map(choice)),
      default_efforts: perKind((k) => cat?.defaultEffort(k) ?? ""),
      access: perKind((k) => (cat?.access(k) ?? []).map(choice)),
      devices,
      fast: cat?.fast() ?? false,
      defaults: { ...sel, project_id: null },
      app: this.d.app?.() ?? { version_code: 0, url: "/app.apk" },
      hub_update: updates.hub_update,
      profile_check: this.d.profileCheck?.() ?? null,
      voice: this.d.voice?.() ?? { transcribe: false, why: "voice isn't in this build yet", lang: "auto" },
    };
  }

  /** A phone looking at `c` (senders.ts Viewer): its own messages show no sender row, the home PC's its owner. */
  /**
   * A project's place in `/v1/state`: `here` false when its folder isn't on this PC, then `pc`
   * and `pc_name` say which PC holds it ("" when none is known) and `pc_online` whether it's on.
   * Two projects with one name are told apart by it, and a new chat in it starts on that PC.
   */
  private placeJson(repo: number): Record<string, Json> {
    const p = this.d.projectPlace?.(repo) ?? null;
    if (p === null) return { here: true, pc: "", pc_name: "", pc_online: false };
    // Its PC is off: `failover` says where a new chat starts instead (failover.ts); the phone shows it as the draft's line.
    const fo = p.online ? null : (this.d.failover?.draft(repo) ?? null);
    return { here: false, pc: p.pc, pc_name: p.name, pc_online: p.online, ...(fo !== null ? { failover: fo.line } : {}) };
  }

  viewer(c: Chat, token: string, device: string): Viewer {
    const hub = this.d.hub;
    const peer = c.home === "" ? null : hub.mesh.peer(c.home);
    const me = hub.mesh.me.name;
    const home = c.home === "" ? { name: me === "" ? hostname() : me, owner: pcOwner(me) } : { name: peer?.name ?? hub.mesh.nameOf(c.home), owner: peer?.owner ?? "" };
    return { dev: phoneDev(hub.groupOf(token)), label: hub.callerLabel(token, device), home };
  }

  /** What chat links resolve against here: this PC's chats (copies included) and the mesh's PCs. */
  private linkWorld(): ChatLinkWorld {
    const m = this.d.hub.mesh;
    return { chats: this.chats(), peers: m.on ? [...m.peers.values()].map((p) => ({ name: p.name, online: p.online })) : [], me: m.me.name === "" ? hostname() : m.me.name };
  }

  items(c: Chat, since: number, viewer: Viewer | null = null, global = false): Json {
    const hub = this.d.hub;
    const items: Item[] = this.d.engine && c.home === "" ? this.d.engine.transcript(c.id).items : this.d.store.items(c.id);
    if (this.d.engine?.opened(c.id)) hub.bump();
    const forks = c.home !== "" ? (this.d.replica.remote.get(c.id)?.forks ?? []) : (this.d.engine?.forksOf(c.id) ?? []);
    const cards = project(items, c.role === "lead", forks, viewer);
    // The sender rows depend on who looks: each viewer has its own revisions of the chat's cards.
    const key = `${c.id}|${viewer ? `${viewer.dev}|${viewer.label}|${viewer.home.name}|${viewer.home.owner}` : ""}`;
    const revs = this.revs.get(key) ?? [];
    const look = this.d.commits?.(c) ?? null;
    let world: ChatLinkWorld | null = null;
    const byId = (id: number | null): Json => {
      if (id === null) return null;
      const x = global ? (world ??= this.linkWorld()).chats.find((y) => y.id === id) : null;
      return global ? (x?.gid ?? null) : id;
    };
    const links: LinkTargets = (md) => {
      const out: Record<string, { title: string; chat: Json; missing: string }> = {};
      for (const [u, t] of Object.entries(chatLinkTargets((world ??= this.linkWorld()), md))) out[u] = { title: t.title, chat: byId(t.chat), missing: t.missing };
      return out;
    };
    const linkSig = (text: string) => (text.includes(CHAT_SCHEME) ? JSON.stringify(links(text)) : "");
    // How each card draws (look.ts): a captcha that ended or a run that grew changes an earlier card's look.
    const roles = captchaRoles(items);
    const runs = groups(cards);
    const looks = cards.map((s) => cardLook(s, roles.get(s.seq) ?? null, runs));
    const hashes = cards.map((s, i) => {
      const it = items[i];
      const shas = look && s.card.kind === "text" ? [...look.ofText(s.card.text).keys()].sort().join(",") : "";
      const extra = `${s.card.kind}|${s.card.kind === "text" && s.card.forkable}|${s.card.kind === "user" && `${s.card.joined}|${s.card.sender}|${s.card.who}|${s.card.via}`}|${s.forksAfter.join(",")}|${s.group ?? ""}|${shas}|${s.card.kind === "text" ? linkSig(s.card.text) : ""}|${JSON.stringify(looks[i] ?? null)}`;
      return (it ? fingerprint(it) : 0n) ^ hashStr(extra);
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
    this.revs.set(key, revs);
    const find = (t: string) => this.d.find?.(t, c) ?? [];
    const out = cards
      .filter((s) => (revs[s.seq]?.[1] ?? 0) > since)
      .map((s) => {
        const v = cardJson(s, revs[s.seq]?.[1] ?? 0, find, c.gid === "" ? String(c.id) : c.gid, this.d.clock ?? clock, this.d.refs ?? null, look, links, looks[s.seq] ?? null);
        if (v.kind === "chat_link") v.chat = byId(this.chats().find((x) => x.gid === v.gid)?.id ?? null);
        // The chat a fork came from, in the caller's ids (a phone opens it by its gid).
        if (v.kind === "forked_from" && global && typeof v.chat === "number") v.chat = this.d.store.chat(v.chat)?.gid ?? v.chat;
        return v;
      });
    return { rev: hub.rev(), count: items.length, running: this.running(c), queued: this.queuedCount(c), typing: this.typing(c.id), draft: this.draft(c.id), status: this.status(c.id), items: out };
  }

  /** api.rs `api_route` for the calls this build answers. */
  async route(call: Call): Promise<Reply> {
    const p = call.path;
    const m = call.method;
    const body = obj(call.body);
    const by = call.from ? { peer: call.from.peer, name: call.from.name, ctx: call.from.ctx } : null;
    const sender = call.from ? call.from.sender || call.from.name : this.d.hub.callerLabel(call.token, call.device);
    const device = call.from?.device ?? "";
    // Who wrote it and on what: a phone here, else as the forwarding PC says (older PCs: unknown).
    const who: Who = call.from ? { who: call.from.who, via: call.from.via, dev: call.from.dev } : { who: this.d.hub.callerWho(call.token), via: "phone", dev: phoneDev(this.d.hub.groupOf(call.token)) };
    if (m === "GET" && p.length === 2 && p[1] === "state") return ok(this.state(deviceId(call.token), call.global));
    if (p[0] !== "v1" || p[1] !== "chats") return (await this.d.more?.(call, null)) ?? err(404, "no such call");
    if (m === "POST" && p.length === 2) return this.create(body, sender, call.global, by, who);
    const c = this.chatOf(p[2] ?? "");
    if (!c) return err(404, "no such chat");
    // A send the phone repeats (it never got the answer) is answered, not run again; a copy's
    // send goes on to its home PC with the same client id, which does the same there.
    if (m === "POST" && p.length === 4 && p[3] === "send") {
      const key = sendKey(c.gid === "" ? String(c.id) : c.gid, body);
      const run = () => (c.home !== "" ? this.forward(c, m, p, body, sender, call.global, who) : this.send(c, body, sender, device, by, who));
      if (key !== null) return this.sends.run(key, run);
    }
    if (c.home !== "" && forHome(m, p)) return this.forward(c, m, p, body, sender, call.global, who);
    if (m === "GET" && p.length === 4 && p[3] === "items") {
      const since = Number(call.query.find(([k]) => k === "since")?.[1] ?? "0");
      return ok(this.items(c, Number.isFinite(since) ? since : 0, call.from ? null : this.viewer(c, call.token, call.device), call.global));
    }
    if (m === "POST" && p.length === 4 && p[3] === "send") return this.send(c, body, sender, device, by, who);
    if (m === "GET" && p.length === 4 && p[3] === "move_targets") return this.d.move ? ok(await this.d.move.targetsJson(c.id)) : err(404, "no such call");
    if (m === "POST" && p.length === 4 && p[3] === "move_pc") return this.movePc(c, body);
    if (m === "POST" && p.length === 4 && p[3] === "stop") {
      const e = this.d.engine;
      if (!e) return err(503, "agents aren't available in this build");
      const hold = body.hold === true;
      e.stop(c.id);
      const returned = hold ? [] : e.takeQueue(c.id).map((q) => ({ text: q.text, files: q.files.map((f) => this.uploadId(f)).filter((x): x is string => x !== null) }));
      this.d.hub.touch(c.id, true);
      return ok({ ok: true, returned, held: e.held(c.id) });
    }
    if (p[3] === "queue" || (m === "POST" && p.length === 4 && p[3] === "resume")) return this.queue(c, m, p, body, call.device);
    if (m === "PATCH" && p.length === 3) {
      const title = typeof body.title === "string" ? body.title.trim() : null;
      if (title === "") return err(400, "empty title");
      let n: Chat = c;
      let fast: boolean | null = null;
      // Auto in a started chat: the PC with the most free memory now, moved to as a pick of it would be (nothing moves
      // when the chat is there already).
      const auto = c.started && body.device === AUTO_DEVICE;
      if (auto) {
        if (!this.d.auto?.relocate) return err(409, "can't move it there: this Harbor can't do that");
        const w = this.d.auto.why?.(c.id, this.kindOf(c)) ?? null;
        if (w !== null) return err(409, `can't move it there: ${w}`);
        delete body.device;
      }
      // Another PC's account (meshaccounts.ts): the chat moves to that PC and goes on there with it; this PC's own is a
      // plain switch.
      if (typeof body.account === "string" && isSharedId(body.account)) {
        const t = sharedTarget(this.d.catalog?.shared?.() ?? [], body.account);
        if (t === null) return err(400, `no account ${body.account}`);
        if (t.why !== "") return err(409, t.why);
        if (t.pc === "") body.account = t.account;
        else {
          if (!this.d.move) return err(409, "can't move it there: this Harbor can't move chats");
          try {
            const to = await this.d.move.movePc(c.id, t.pc, { account: t.account, kind: t.kind, model: typeof body.model === "string" ? body.model : "" });
            return { status: 202, body: { ok: true, moving: true, to, account: t.label } };
          } catch (e) {
            return err(409, `can't switch to ${t.label}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
      const moving = !auto && c.started && typeof body.device === "string" && body.device !== c.device ? body.device : null;
      if (moving !== null) {
        const w = this.d.relocate ? this.d.relocate.why(c.id, moving) : "this Harbor can't move a started chat";
        if (w !== null) return err(409, `can't move it there: ${w}`);
        delete body.device;
      }
      const rs = this.d.runSettings;
      if (rs) {
        const accounts = rs.accounts();
        try {
          const r = checkRun(c, body, accounts, allowedAccounts(c, accounts), (k) => rs.modelsFor(k), rs.devices());
          if (r) [n, fast] = [r.chat, r.fast];
        } catch (e) {
          if (isRunError(e)) return err(e.status, e.error);
          throw e;
        }
      } else if (["account", "model", "effort", "access", "device", "fast"].some((k) => body[k] !== undefined && body[k] !== null)) return err(503, "run settings can't change in this build");
      // A started subagent moves with its session (and goes on if it waited at a limit), as the desktop's Agents panel;
      // while its turn runs it moves when that turn ends.
      const eng = this.d.engine;
      if (eng?.switchAccount && c.role === "sub" && c.started && c.home === "" && n.account !== c.account) {
        try {
          eng.switchAccount(c.id, n.account, { model: n.model, effort: n.effort, why: "switched on the phone" });
        } catch (e) {
          return err(409, e instanceof Error ? e.message : String(e));
        }
        const m = eng.chat?.(c.id);
        if (m) n = { ...n, account: m.account, model: m.model, effort: m.effort, access: m.access, started: m.started, sessionId: m.sessionId };
      }
      if (title !== null) n = { ...n, title: [...title].slice(0, 200).join("") };
      if (typeof body.settled === "boolean") {
        n = { ...n, settled: body.settled };
        this.d.engine?.opened(c.id);
      }
      if (n !== c) {
        this.d.store.saveChat(n);
        this.d.engine?.reload();
        this.d.replica.touch(c.id);
      }
      if (fast !== null) rs?.setFast(fast);
      if (moving !== null || auto) {
        try {
          if (auto) await this.d.auto?.relocate?.(c.id, this.kindOf(c));
          else if (moving !== null) await this.d.relocate?.relocate(c.id, moving);
        } catch (e) {
          return err(409, e instanceof Error ? e.message : String(e));
        }
      }
      return ok({ ok: true, chat: this.chatJson(this.chats().find((x) => x.id === c.id) ?? n, call.global) });
    }
    if (m === "DELETE" && p.length === 3) {
      this.d.engine?.stop(c.id);
      this.d.dropChat?.(c);
      this.d.store.deleteChat(c.id);
      const rev = this.d.hub.touch(null, true);
      this.d.hub.mesh.gone.push([rev, c.id]);
      this.d.replica.reload();
      this.d.engine?.reload();
      return ok({ ok: true });
    }
    return (await this.d.more?.(call, c)) ?? err(404, "no such call");
  }

  /** api.rs `api_route`'s queue ops (queue.rs). */
  private queue(c: Chat, m: string, p: string[], body: Record<string, unknown>, device: string): Reply {
    const e = this.d.engine;
    if (!e) return err(503, "agents aren't available in this build");
    if (p[3] === "resume") {
      e.queueResume(c.id);
      return ok({ ok: true });
    }
    const q = /^\d+$/.test(p[4] ?? "") ? Number(p[4]) : null;
    if (q === null) return err(404, "no such queued message");
    const gone = err(404, "no such queued message (it may have started)");
    let done: boolean;
    if (m === "POST" && p.length === 6 && p[5] === "steer") done = e.queuePromote(c.id, q);
    else if (m === "POST" && p.length === 6 && p[5] === "move") {
      if (typeof body.to !== "number" || !Number.isInteger(body.to) || body.to < 0) return err(400, 'send {"to": position}');
      done = e.queueMove(c.id, q, body.to);
    } else if (m === "PATCH" && p.length === 5) {
      const text = typeof body.text === "string" ? body.text.trim() : null;
      const mentions = Array.isArray(body.mentions) ? body.mentions.map((x) => mention(typeof x === "object" && x !== null ? (x as Partial<Mention>) : {})) : null;
      const editing = body.editing === true ? device || "Phone" : body.editing === false ? "" : null;
      done = e.queueUpdate(c.id, q, text, mentions, editing);
    } else if (m === "DELETE" && p.length === 5) done = e.queueRemove(c.id, q);
    else return err(404, "no such queue action");
    return done ? ok({ ok: true }) : gone;
  }

  uploadId(path: string): string | null {
    const dir = this.d.uploadsDir;
    if (!dir || !path.startsWith(`${dir}/`)) return null;
    const rel = path.slice(dir.length + 1);
    return resolveUpload(dir, rel) === null ? null : rel;
  }

  private async send(c: Chat, body: Record<string, unknown>, sender: string, device = "", from: SentBy | null = null, who: Who = NOBODY): Promise<Reply> {
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const files: string[] = [];
    for (const f of Array.isArray(body.files) ? body.files : []) {
      const id = typeof f === "string" ? f : "";
      const path = this.d.uploadsDir ? resolveUpload(this.d.uploadsDir, id) : null;
      if (path === null) return err(400, `unknown upload ${id}`);
      files.push(path);
    }
    const mentions = (Array.isArray(body.mentions) ? body.mentions : []).map((m) => mention(typeof m === "object" && m !== null ? (m as Partial<Mention>) : {}));
    const e = this.d.engine;
    // `resume`: an empty composer's send (resume.ts), as the desktop's: the queue a Stop held starts, or the agent is asked to go on.
    let resumed = false;
    if (body.resume === true && nothingToSend(text, files.length, mentions.length)) {
      if (c.retired) return err(409, "this agent was retired");
      if (!e) return err(503, "agents aren't available in this build");
      const kind = resumeNow(e, c.id);
      if (kind === null) return err(409, "nothing to resume");
      if (kind === "queue") {
        e.queueResume(c.id);
        this.d.replica.touch(c.id);
        return ok({ ok: true, queued: false, steering: false, resumed: "queue" });
      }
      resumed = true;
    }
    const said = resumed ? RESUME_TEXT : text;
    if (nothingToSend(said, files.length, mentions.length)) return err(400, "nothing to send");
    if (c.retired) return err(409, "this agent was retired");
    if (!e) return err(503, "agents aren't available in this build");
    const before = e.queued(c.id).filter((q) => q.intent === "").length;
    const running = e.running(c.id);
    const mode = body.mode === "steer" ? "steer" : "queue";
    this.d.hub.clearDraft(c.id);
    e.send(c.id, said, { files, mentions, mode, sender, device, from, who: who.who, via: who.via ?? undefined, dev: who.dev });
    const queued = e.queued(c.id).filter((q) => q.intent === "").length > before;
    this.d.replica.touch(c.id);
    return ok({ ok: true, queued, steering: running && !queued && c.home === "", ...(resumed ? { resumed: "reply" } : {}) });
  }

  /** api.rs `api_create_repo`: the project a new chat asks for (`project_id`, or `project` from another PC); a reply when it can't be had. */
  private createRepo(body: Record<string, unknown>): { repo: number | null } | Reply {
    const repos = this.d.store.repos();
    const pref = body.project_id;
    if ((pref === undefined || pref === null) && typeof body.project === "object" && body.project !== null && !Array.isArray(body.project)) {
      const p = body.project as Record<string, unknown>;
      const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : "");
      const [path, name, remote] = [str("path"), str("name"), str("remote")];
      const found = repos.find((r) => r.path === path) ?? repos.find((r) => sameRemote(r.remote, remote)) ?? repos.find((r) => name !== "" && r.name === name);
      if (found) {
        if (!existsSync(repoDir(found)) && remote !== "" && found.remote !== remote) this.d.store.setRepoRemote(found.id, remote);
        return { repo: found.id };
      }
      if (remote !== "" && path !== "") {
        const id = this.d.store.addRepo(path);
        this.d.store.setRepoRemote(id, remote);
        this.d.engine?.reload();
        return { repo: id };
      }
      const here = hostname();
      if (remote === "") return err(409, `${name} isn't a project on ${here} and has no Git remote to clone there: add its folder to Harbor on that PC first`);
      return err(409, `${name} isn't a project on ${here} yet`);
    }
    if (pref === undefined || pref === null) return { repo: null };
    if (typeof pref === "string") {
      const r = repos.find((x) => x.path === pref);
      return r ? { repo: r.id } : err(400, "no such project");
    }
    const r = typeof pref === "number" && Number.isInteger(pref) ? repos.find((x) => x.id === pref) : undefined;
    return r ? { repo: r.id } : err(400, "no such project");
  }

  /** The PC a new chat of project `repo` asked for on `device` ("" this PC) goes to instead: the one its folder is on, when it isn't here. */
  private folderPeer(repo: number, device: string): Peer | null {
    const p = this.d.projectPlace?.(repo) ?? null;
    if (p === null || p.pc === "" || !p.online || !this.d.mesh) return null;
    if (device !== "" && this.d.devices?.().some(([h]) => h.id === device && h.device_files)) return null;
    return this.d.hub.mesh.peer(p.pc);
  }

  /** mesh.rs `mesh_proxy` and `map_new`: a new chat on another PC's Harbor, answered with the copy of it that arrives here. */
  private async createOnPeer(peer: Peer, body: Record<string, unknown>, sender: string, global: boolean, who: Who): Promise<Reply> {
    if (!peer.online || !this.d.mesh) return err(409, `${peer.name} is off: pick a PC that's on`);
    const pref = body.project_id;
    const repos = this.d.store.repos();
    const repo = typeof pref === "string" ? repos.find((r) => r.path === pref) : typeof pref === "number" ? repos.find((r) => r.id === pref) : undefined;
    const { project_id: _p, files: ids, ...rest } = body;
    const ctx = this.d.ctx?.(repo?.id ?? null) ?? null;
    const r = await this.d.mesh.forward(dest(peer), peer.name, "POST", ["v1", "chats"], { ...rest, device: "", project: repo ? { name: repo.name, path: repo.path, remote: repo.remote } : null }, this.uploads(ids), [sender, "", who.who, who.via ?? "", who.dev], ctx);
    return this.mapNew(peer.id, r, global);
  }

  /** mesh.rs `files_of`: a phone's upload ids, as the files here. */
  private uploads(ids: unknown): { name: string; data: Uint8Array }[] {
    const files: { name: string; data: Uint8Array }[] = [];
    for (const f of Array.isArray(ids) ? ids : []) {
      const path = this.d.uploadsDir && typeof f === "string" ? resolveUpload(this.d.uploadsDir, f) : null;
      if (path !== null) files.push({ name: basename(path), data: readFileSync(path) });
    }
    return files;
  }

  /** mesh.rs `map_new`: a chat made on another PC, answered with its copy's id here (waited for a few seconds). */
  async mapNew(home: string, r: Reply, global: boolean): Promise<Reply> {
    const rb = obj(r.body);
    const hid = typeof rb.id === "number" && Number.isInteger(rb.id) && r.status < 300 ? rb.id : null;
    if (hid === null) return r;
    if (global) return { status: r.status, body: { ...(rb as Record<string, Json>), id: (rb.gid ?? null) as Json } };
    const until = Date.now() + 8000;
    for (;;) {
      const local = this.d.hub.mesh.localId(home, hid);
      if (local !== null) return { status: r.status, body: { ...(rb as Record<string, Json>), id: local } };
      if (Date.now() >= until) return { status: r.status, body: { ...(rb as Record<string, Json>), id: null } };
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** api.rs `api_create_in`. */
  private async create(body: Record<string, unknown>, sender: string, global: boolean, from: SentBy | null = null, who: Who = NOBODY): Promise<Reply> {
    // Another PC's account (meshaccounts.ts): the chat starts on that PC (or another that has the same sign-in, when it's
    // off) and runs there with its own login; this PC never holds it.
    if (typeof body.account === "string" && isSharedId(body.account)) {
      const t = sharedTarget(this.d.catalog?.shared?.() ?? [], body.account);
      if (t === null) return err(400, `no account ${body.account}`);
      if (t.why !== "") return err(409, t.why);
      body = { ...body, account: t.account, device: t.pc, shared_account: true };
      if (t.pc === "") return this.createAt(body, sender, global, from, who);
      const peer = this.d.hub.mesh.peer(t.pc);
      if (peer === null) return err(409, "that PC isn't in the mesh anymore");
      return this.createOnPeer(peer, body, sender, global, who);
    }
    // "Auto": the PC with the most free memory now, decided once here; the chat stays there. `auto_placed`: another PC's
    // Auto sent it here, so this PC remembers it too.
    let auto = body.auto_placed === true;
    if (body.device === AUTO_DEVICE) {
      const r = this.d.auto?.resolve(AUTO_DEVICE, "Claude") ?? { device: "", auto: true };
      body = { ...body, device: r.device, auto_placed: true };
      auto = true;
    }
    // This PC's account run on another PC: that PC's id for the same sign-in ("claude" here may be "claude2" there).
    if (typeof body.account === "string" && typeof body.device === "string" && body.device !== "") body = { ...body, account: accountOn(this.d.catalog?.shared?.() ?? [], body.account, body.device) };
    // A first message to a project's main chat may join the one there is: that chat isn't Auto's.
    const had = auto && body.main === true ? new Set(this.d.store.chats().map((c) => c.gid)) : null;
    const r = await this.createAt(body, sender, global, from, who);
    if (auto && r.status < 300) {
      const gid = obj(r.body).gid;
      if (typeof gid === "string" && gid !== "" && !had?.has(gid)) this.d.auto?.mark(gid, typeof body.device === "string" ? body.device : "");
    }
    return r;
  }

  private async createAt(body: Record<string, unknown>, sender: string, global: boolean, from: SentBy | null, who: Who): Promise<Reply> {
    const peer = this.d.hub.mesh.on && typeof body.device === "string" ? this.d.hub.mesh.peer(body.device) : null;
    if (peer !== null) return this.createOnPeer(peer, body, sender, global, who);
    const found = this.createRepo(body);
    if (!("repo" in found)) return found;
    const repo = found.repo;
    // A project whose folder is on another PC: the chat starts there (as the desktop's draft does), unless it's
    // asked for on a device with files of its own; here, or on a device working in this PC's files, it would only
    // fail with "isn't on this PC".
    // (Not for a chat another PC asked for: it picked this one.)
    const there = repo === null || from !== null ? null : this.folderPeer(repo, typeof body.device === "string" ? body.device : "");
    if (there !== null) return this.createOnPeer(there, { ...body, project_id: repo, device: "" }, sender, global, who);
    // Its folder's PC is off: the chat starts on a PC that has the project or can clone it (failover.ts), or not now.
    const fo = repo === null || from !== null || (typeof body.device === "string" && body.device !== "") ? null : (this.d.failover?.draft(repo) ?? null);
    if (fo !== null && fo.to === null) return err(409, fo.line);
    const foPeer = fo !== null && fo.to !== null && fo.to !== "" ? this.d.hub.mesh.peer(fo.to) : null;
    if (foPeer !== null) return this.createOnPeer(foPeer, { ...body, project_id: repo, device: "", failover_off: fo?.off ?? "" }, sender, global, who);
    let made: unknown = null;
    if (body.worktree === true && (typeof body.device !== "string" || body.device === "") && this.d.worktrees) {
      const about = [body.title, body.text].find((t) => typeof t === "string" && t.trim() !== "");
      try {
        made = await this.d.worktrees.make(repo, typeof body.base === "string" ? body.base : "", typeof about === "string" ? about : "");
      } catch (x) {
        return err(409, x instanceof Error ? x.message : String(x));
      }
    }
    const r = await this.createHere(body, sender, global, repo, made, from, who);
    if (made !== null && r.status >= 300) this.d.worktrees?.discard(repo, made);
    // Started here because its project's PC is off (here, or asked by the PC the user is on): it says so.
    const off = fo !== null ? fo.off : typeof body.failover_off === "string" ? body.failover_off : "";
    const made2 = obj(r.body).id;
    if (r.status < 300 && off !== "") {
      const id = typeof made2 === "number" ? made2 : typeof made2 === "string" ? this.d.hub.mesh.byGid(made2) : null;
      if (id !== null) this.d.failover?.startedNotice(id, off);
    }
    return r;
  }

  private async createHere(body: Record<string, unknown>, sender: string, global: boolean, repo: number | null, wt: unknown, from: SentBy | null, who: Who): Promise<Reply> {
    const cat = this.d.catalog;
    const d = cat?.defaults() ?? { account: "claude", model: "", effort: "", access: "full", device: "" };
    const s = (k: string, dflt: string) => (typeof body[k] === "string" ? (body[k] as string) : dflt);
    const account = s("account", d.account);
    const kindOf = (id: string): string | undefined => cat?.accounts().find((a) => a.id === id)?.kind;
    const kind = cat ? kindOf(account) : "Claude";
    if (kind === undefined) return err(400, `no account ${account}`);
    const effort = s("effort", kind === (kindOf(d.account) ?? "Claude") ? d.effort : "");
    if (cat && effort !== "" && !cat.efforts(kind).some((e) => e[0] === effort)) return err(400, `${kind} has no effort ${effort}`);
    let access = s("access", "full");
    // Another PC's chat on one of this PC's accounts does at most what this PC's owner lets that PC's chats do here.
    if (from !== null && body.shared_account === true) {
      const me = this.d.hub.mesh.me.name === "" ? hostname() : this.d.hub.mesh.me.name;
      const r = sharedAccess(this.d.shareLevel?.(from.peer) ?? "full", access, (cat?.access(kind) ?? []).map((a) => a[0]), { me, kind: kind.toLowerCase() });
      if ("why" in r) return err(403, r.why);
      access = r.access;
    }
    if (cat && !cat.access(kind).some((a) => a[0] === access)) return err(400, `${kind} has no access level ${access}`);
    // Only Claude runs on another device.
    const device = kind === "Claude" ? s("device", "") : "";
    const text = s("text", "").trim();
    const files: string[] = [];
    for (const f of Array.isArray(body.files) ? body.files : []) {
      const id = typeof f === "string" ? f : "";
      const path = this.d.uploadsDir ? resolveUpload(this.d.uploadsDir, id) : null;
      if (path === null) return err(400, `unknown upload ${id}`);
      files.push(path);
    }
    if (typeof body.fast === "boolean" && body.fast !== (cat?.fast() ?? false)) this.d.runSettings?.setFast(body.fast);
    const model = s("model", account === d.account ? d.model : "");
    const e = this.d.engine;
    const main = repo !== null && body.main === true ? repo : null;
    if (main !== null && e) {
      const m = e.mainChat(main);
      if (m !== null) {
        const mc = this.chats().find((x) => x.id === m);
        // The main chat of a project shared with you is its owner's, a copy here: the message goes to its home PC.
        if (mc && mc.home !== "" && (text !== "" || files.length > 0)) {
          const r = await this.forward(mc, "POST", ["v1", "chats", String(mc.id), "send"], { text, files: body.files ?? [] }, sender, global, who);
          if (r.status >= 300) return r;
        } else if (mc && (text !== "" || files.length > 0)) await this.send(mc, { text, files: body.files ?? [] }, sender, "", from, who);
        return ok({ id: global ? (mc?.gid ?? "") : m, gid: mc?.gid ?? "" });
      }
    }
    const sel = { account, model, effort, access, device };
    const made = e ? e.newThread(repo, text, sel) : this.d.store.createChat(blankChat({ repoId: repo, title: text.split("\n")[0]?.trim().slice(0, 60) || "New thread", ...sel, access: parseAccess(access), role: "lead", name: "lead" }));
    if (main !== null) this.d.store.setMainChat(main, made.id);
    if (wt !== null) this.d.worktrees?.attach(made.id, wt);
    let c: Chat = { ...made, effort, access: parseAccess(access), device };
    const title = typeof body.title === "string" ? [...body.title.trim()].slice(0, 80).join("") : "";
    if (title !== "") c = { ...c, title };
    this.d.store.saveChat(c);
    e?.reload();
    const opened = obj(body.opened_from);
    if (typeof opened.gid === "string" && typeof opened.title === "string") this.d.openedFrom?.(c.id, opened.gid, opened.title);
    this.d.replica.touch(c.id);
    if (text !== "" || files.length > 0) {
      const sent = await this.send(c, { text, files: body.files ?? [] }, sender, "", from, who);
      if (sent.status !== 200) return sent;
    }
    return ok({ id: global ? c.gid : c.id, gid: c.gid });
  }

  /** 202 once the handoff runs; its outcome shows in the chat. */
  private async movePc(c: Chat, body: Record<string, unknown>): Promise<Reply> {
    if (!this.d.move) return err(404, "no such call");
    try {
      const w = typeof body.want === "object" && body.want !== null ? (body.want as Record<string, unknown>) : null;
      const want: MoveWant | null = w && typeof w.account === "string" && typeof w.kind === "string" ? { account: w.account, kind: w.kind, model: typeof w.model === "string" ? w.model : "" } : null;
      const to = await this.d.move.movePc(c.id, typeof body.pc === "string" ? body.pc : "", want);
      return { status: 202, body: { ok: true, moving: true, to } };
    } catch (e) {
      return err(409, e instanceof Error ? e.message : String(e));
    }
  }

  /** mesh.rs `mesh_proxy`: a call about a copy, made at its home PC and answered with this PC's ids. */
  private async forward(c: Chat, method: string, p: string[], body: Record<string, unknown>, sender: string, global: boolean, who: Who): Promise<Reply> {
    const peer = this.d.hub.mesh.peer(c.home);
    // Its PC is off: a message goes on on another PC (failover.ts), or waits here.
    if (!peer?.online && method === "POST" && p.length === 4 && p[3] === "send" && this.d.failover) {
      const files = (Array.isArray(body.files) ? body.files : []).map((f) => (this.d.uploadsDir && typeof f === "string" ? resolveUpload(this.d.uploadsDir, f) : null)).filter((x): x is string => x !== null);
      const to = typeof body.failover_to === "string" ? body.failover_to : null;
      const { failover_to: _, ...rest } = body;
      return this.d.failover.send(c, { text: typeof body.text === "string" ? body.text : "", files, mentions: Array.isArray(body.mentions) ? body.mentions : [] }, to, (own) => this.send(own, rest, sender, "", null, who));
    }
    if (!peer?.online || !this.d.mesh) return err(409, `${this.d.hub.mesh.nameOf(c.home)} is off: the chat is read-only until it's back`);
    // Moving is its home's to do; a home before it would only say "unknown call".
    if ((p[3] === "move_pc" || p[3] === "move_targets") && !peer.moves) return err(409, `${this.d.hub.mesh.nameOf(c.home)} runs an older Harbor that can't move chats: update it first`);
    const path = ["v1", "chats", String(c.homeId), ...p.slice(3)];
    const { files: ids, ...rest } = body;
    const ctx = startsTurn(method, p.slice(3)) ? (this.d.ctx?.(c.repoId) ?? null) : null;
    let r = await this.d.mesh.forward(dest(peer), peer.name, method, path, rest, this.uploads(ids), [sender, "", who.who, who.via ?? "", who.dev], ctx);
    if (p[3] === "fork") r = await this.mapNew(c.home, r, global);
    const rb = obj(r.body);
    const ch = typeof rb.chat === "object" && rb.chat !== null && !Array.isArray(rb.chat) ? (rb.chat as Record<string, Json>) : null;
    if (ch === null && !Array.isArray(rb.returned)) return r;
    const out: Record<string, Json> = { ...(rb as Record<string, Json>) };
    if (ch !== null) {
      const repo = c.repoId === null ? null : (this.d.store.repos().find((x) => x.id === c.repoId) ?? null);
      const parent = c.parent === null ? null : (this.d.store.chat(c.parent) ?? null);
      out.chat = global
        ? { ...ch, id: c.gid, project_id: repo ? repo.path : null, parent: parent ? parent.gid : null, gid: c.gid }
        : { ...ch, id: c.id, project_id: c.repoId, parent: c.parent, gid: c.gid };
    }
    // Messages handed back: their files are the home PC's uploads, not this one's.
    if (Array.isArray(rb.returned)) out.returned = rb.returned.map((q) => (typeof q === "object" && q !== null && !Array.isArray(q) ? { ...(q as Record<string, Json>), files: [] } : (q as Json)));
    return { status: r.status, body: out };
  }
}

/** The new-chat composer's picks as the Rust app reads them at start (app.rs `Sel`), Claude's old High default moved to Medium once. */
export function composerDefaults(kv: { get(k: string): string | null; set(k: string, v: string): void }, accounts: CatalogAccount[], claudeDefault: string): { account: string; model: string; effort: string; access: string; device: string } {
  // A default saved on a provider Harbor dropped (Cursor, Gemini, …) reads as Claude's defaults.
  const dropped = !/^claude\+?\d*$/.test(kv.get("default_account") ?? "claude") && kv.get("default_account") !== "codex" && kv.get("default_account") !== "opencode";
  const get = (k: string, d: string) => (dropped ? d : (kv.get(k) ?? d));
  // "" is OpenCode's own default model; for Claude it was Opus.
  const aliases: Record<string, string> = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5" };
  if (get("default_account", "claude") !== "opencode") aliases[""] = "claude-opus-5-5";
  const m = get("default_model", "claude-opus-5-5");
  let effort = get("default_effort", "");
  if (kv.get("effort_default_medium") === null) {
    const account = get("default_account", "claude");
    const a = accounts.find((x) => x.id === account);
    if ((a === undefined || a.kind === "Claude") && effort === "high") {
      effort = claudeDefault;
      kv.set("default_effort", effort);
    }
    kv.set("effort_default_medium", "1");
  }
  let account = get("default_account", "claude");
  let model = aliases[m] ?? m;
  // The default turned off on this PC (it syncs from others): the first account that's on, the same provider first.
  const off = accounts.find((x) => x.id === account && x.off === true);
  if (off !== undefined) {
    const on = accounts.filter((x) => x.bin !== null && x.loggedIn !== false && x.off !== true);
    const alt = on.find((x) => x.kind === off.kind) ?? on[0];
    if (alt !== undefined) {
      account = alt.id;
      if (alt.kind !== off.kind) model = "";
    }
  }
  return { account, model, effort, access: get("default_access", "full"), device: get("default_device", "") };
}

/** `@harbor/agents`' providers module as far as the catalog needs it. */
export interface ProvidersModule<K extends string> {
  KINDS: readonly K[];
  staticModels(k: K): { id: string; label: string; more: boolean }[];
  efforts(k: K): readonly Choice[];
  defaultEffort(k: K): string;
  access(k: K): readonly Choice[];
  hasFast(k: K): boolean;
}

/** `models` overrides `staticModels` per kind; the composer's defaults are read once, here. */
export function catalogOf<K extends string>(p: ProvidersModule<K>, accounts: () => CatalogAccount[], kv: { get(k: string): string | null; set(k: string, v: string): void }, models: Map<string, { id: string; label: string; more: boolean }[]> = new Map()): Catalog {
  const kind = (s: string): K | undefined => p.KINDS.find((x) => x === s);
  const claude = kind("Claude");
  const sel = composerDefaults(kv, accounts(), claude === undefined ? "" : p.defaultEffort(claude));
  const per = <T>(s: string, f: (k: K) => T, none: T): T => {
    const k = kind(s);
    return k === undefined ? none : f(k);
  };
  return {
    kinds: p.KINDS,
    accounts,
    models: (s) => models.get(s) ?? per(s, (k) => p.staticModels(k), []),
    efforts: (s) => per(s, (k) => p.efforts(k), []),
    defaultEffort: (s) => per(s, (k) => p.defaultEffort(k), ""),
    access: (s) => per(s, (k) => p.access(k), []),
    hasFast: (s) => per(s, (k) => p.hasFast(k), false),
    defaults: () => sel,
    fast: () => kv.get("fast_mode") === "1",
  };
}
