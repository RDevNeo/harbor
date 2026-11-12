import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { ALIVE_WAIT_MS } from "./api.ts";
import { now as unixNow, type Kv } from "./kv.ts";
import { Ordered, wire, type Json } from "./wire.ts";
import { PassThrough } from "node:stream";
import { notify as osNotify } from "@harbor/os";

/** Notes with one key this close together are one (the newest, with a count), in seconds. */
export const COALESCE_S = 90;
/** How long a note is kept for phones that check in late. */
const KEEP_S = 24 * 3600;
const KEEP_N = 200;
/** Without a key or the mouse on a focused Harbor window this long, you're away from the PC. */
export const AWAY_S = 120;

/** The kinds, as the wire, the settings and Android's channels name them. */
export const NOTE_KINDS: readonly (readonly [string, string])[] = [
  ["input", "An agent needs you"],
  ["done", "A lead chat finished"],
  ["agent", "A sub-agent finished"],
  ["ci", "CI or PR checks failed"],
  ["limit", "Usage limit hit or back"],
  ["pc", "Another PC went offline"],
  ["discord", "Discord: a captcha, a sign-out, a repair"],
  ["whatsapp", "WhatsApp: the link ended"],
];

export interface Note {
  /** Grows; phones ask for what's newer than the last they saw. */
  id: number;
  /** Unix seconds. */
  at: number;
  kind: string;
  /** What it coalesces by: "chat:<gid>", "ci:<repo>#<n>", "limit:<account>", "pc:<id>". */
  key: string;
  title: string;
  body: string;
  /** The chat (global id) it opens, when it's about one; a reply goes there. */
  chat: string;
  /** How many events it stands for (coalesced). */
  count: number;
  /** The user wasn't at this PC when it happened. */
  away: boolean;
  /** The chat takes a reply. */
  reply: boolean;
  /** A web page it opens instead of a chat (a PR whose checks failed). */
  url: string;
  /** An action besides Open and Reply: "continue". */
  act: string;
  /** The PC it happened on (name), for notes from another PC of the mesh. */
  from: string;
}

export function newNote(n: Partial<Note> = {}): Note {
  return { id: 0, at: 0, kind: "", key: "", title: "", body: "", chat: "", count: 0, away: false, reply: false, url: "", act: "", from: "", ...n };
}

/** The note as it goes on the wire (a json! value, so keys sort in `wire`); empty chat/url/act/from are left out. */
export function noteJson(n: Note): Json {
  const o: { [k: string]: Json } = { id: n.id, at: n.at, kind: n.kind, key: n.key, title: n.title, body: n.body };
  if (n.chat !== "") o.chat = n.chat;
  o.count = n.count;
  o.away = n.away;
  o.reply = n.reply;
  if (n.url !== "") o.url = n.url;
  if (n.act !== "") o.act = n.act;
  if (n.from !== "") o.from = n.from;
  return o;
}

function uint(v: unknown): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0;
}

function text(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** A note from the wire (another PC's `/mesh/v1/notes`); every field defaults. */
export function parseNote(v: unknown): Note | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  return {
    id: uint(o.id),
    at: typeof o.at === "number" && Number.isInteger(o.at) ? o.at : 0,
    kind: text(o.kind),
    key: text(o.key),
    title: text(o.title),
    body: text(o.body),
    chat: text(o.chat),
    count: uint(o.count),
    away: o.away === true,
    reply: o.reply === true,
    url: text(o.url),
    act: text(o.act),
    from: text(o.from),
  };
}

export function parseNotes(v: unknown): Note[] {
  return Array.isArray(v) ? v.map(parseNote).filter((n): n is Note => n !== null) : [];
}

/** What the desktop shows (kv `notify`). Phones keep their own choices. */
export interface Prefs {
  /** Kind to on. */
  kinds: Record<string, boolean>;
  quiet: boolean;
  /** Quiet hours, "HH:MM" local time; may wrap midnight. */
  quiet_from: string;
  quiet_to: string;
  /** Desktop: only while away from the PC. */
  away_only: boolean;
}

export function defaultPrefs(): Prefs {
  return { kinds: {}, quiet: false, quiet_from: "22:00", quiet_to: "07:00", away_only: false };
}

/** Sub-agents are off unless asked for; everything else on. */
export function prefsOn(p: Prefs, kind: string): boolean {
  const v = Object.hasOwn(p.kinds, kind) ? p.kinds[kind] : undefined;
  return v ?? kind !== "agent";
}

/** "HH:MM" to minutes since midnight. */
export function hm(s: string): number | null {
  const t = s.trim();
  const i = t.indexOf(":");
  if (i < 0) return null;
  const a = t.slice(0, i);
  const b = t.slice(i + 1);
  if (!/^\+?\d+$/.test(a) || !/^\+?\d+$/.test(b)) return null;
  const h = Number(a);
  const m = Number(b);
  return h < 24 && m < 60 ? h * 60 + m : null;
}

/** Within quiet hours at `minute` (minutes since local midnight). */
export function quietAt(p: Prefs, minute: number): boolean {
  if (!p.quiet) return false;
  const a = hm(p.quiet_from);
  const b = hm(p.quiet_to);
  if (a === null || b === null || a === b) return false;
  return a < b ? minute >= a && minute < b : minute >= a || minute < b;
}

export function loadPrefs(kv: Kv): Prefs {
  const t = kv.get("notify");
  if (t === null) return defaultPrefs();
  try {
    const v: unknown = JSON.parse(t);
    if (typeof v !== "object" || v === null || Array.isArray(v)) return defaultPrefs();
    const o = v as Record<string, unknown>;
    const d = defaultPrefs();
    const kinds: Record<string, boolean> = {};
    if (typeof o.kinds === "object" && o.kinds !== null && !Array.isArray(o.kinds)) {
      for (const [k, on] of Object.entries(o.kinds)) if (typeof on === "boolean") kinds[k] = on;
    }
    return {
      kinds,
      quiet: d.quiet,
      quiet_from: typeof o.quiet_from === "string" ? o.quiet_from : d.quiet_from,
      quiet_to: typeof o.quiet_to === "string" ? o.quiet_to : d.quiet_to,
      away_only: d.away_only,
    };
  } catch {
    return defaultPrefs();
  }
}

export function savePrefs(kv: Kv, p: Prefs): void {
  const o = new Ordered([
    ["kinds", p.kinds],
    ["quiet", p.quiet],
    ["quiet_from", p.quiet_from],
    ["quiet_to", p.quiet_to],
    ["away_only", p.away_only],
  ]);
  kv.set("notify", wire(o));
}

export interface NotesOptions {
  /** The hub's start time in ms: ids begin there, so a restarted hub's ids are higher. */
  startMs?: number;
  /** Unix seconds. */
  clock?: () => number;
}

/** The hub's notes. */
export class Notes {
  private list: Note[] = [];
  private next: number;
  private readonly clock: () => number;
  private waiters = new Set<() => void>();

  constructor(opts: NotesOptions = {}) {
    this.next = opts.startMs ?? Date.now();
    this.clock = opts.clock ?? unixNow;
  }

  /** Adds a note (coalesced with one of its key from within COALESCE_S); returns it as kept. */
  push(input: Note): Note {
    const n: Note = { ...input };
    const now = this.clock();
    n.at = now;
    n.count = Math.max(n.count, 1);
    let i = -1;
    for (let j = this.list.length - 1; j >= 0; j--) {
      const o = this.list[j] as Note;
      if (o.key === n.key && now - o.at < COALESCE_S) {
        i = j;
        break;
      }
    }
    if (i >= 0) {
      const old = this.list.splice(i, 1)[0] as Note;
      n.count += old.count;
      // An agent that needs you stays that, whatever finished after.
      if (old.kind === "input" && n.kind !== "input" && n.key === old.key) {
        n.kind = old.kind;
        n.title = old.title;
      }
      n.away = n.away || old.away;
    }
    this.next += 1;
    n.id = this.next;
    this.list.push({ ...n });
    while (this.list.length > KEEP_N || (this.list[0] !== undefined && now - this.list[0].at > KEEP_S)) this.list.shift();
    for (const w of [...this.waiters]) w();
    return n;
  }

  /** The notes newer than `since` (all kept ones for 0, or an id from the future: a restarted hub), and the newest id. */
  since(since: number): [Note[], number] {
    const last = this.next;
    const s = since > last ? 0 : since;
    return [this.list.filter((n) => n.id > s).map((n) => ({ ...n })), last];
  }

  /** The newest id. */
  last(): number {
    return this.next;
  }

  /** This PC's own notes newer than `since`, for the other PCs of the mesh (`from` empty; nor PCs going offline, which each PC says itself). */
  ownSince(since: number): [Note[], number] {
    const [all, last] = this.since(since);
    return [all.filter((n) => n.from === "" && n.kind !== "pc"), last];
  }

  /** Notes another PC of the mesh had (`from` its name): kept for phones, never shown here. */
  relay(from: string, notes: readonly Note[]): void {
    for (const n of notes) this.push({ ...n, from });
  }

  private ready(since: number): boolean {
    const back = this.list[this.list.length - 1];
    return since > this.next || (back !== undefined && back.id > since);
  }

  /** Like `since`, waiting up to `waitMs` for one. */
  async wait(since: number, waitMs: number): Promise<[Note[], number]> {
    const deadline = Date.now() + waitMs;
    while (!this.ready(since)) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          this.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, left);
        this.waiters.add(done);
      });
    }
    return this.since(since);
  }
}

/** Wire form for phones (and other PCs of the mesh). */
export function notesWire(notes: readonly Note[], last: number): Json {
  return { notes: notes.map(noteJson), last };
}

/** `POST /v1/alive`'s notes part: nothing for a missing `since`, only `last` for 0, else the notes since it (waiting up to `wait_ms`). */
export async function aliveNotes(notes: Notes, body: unknown): Promise<Json | null> {
  const o = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const since = o.since;
  if (typeof since !== "number" || !Number.isInteger(since) || since < 0) return null;
  if (since === 0) return notesWire([], notes.last());
  const w = o.wait_ms;
  const wait = typeof w === "number" && Number.isInteger(w) && w >= 0 ? Math.min(w, ALIVE_WAIT_MS) : 0;
  const [got, last] = await notes.wait(since, wait);
  return notesWire(got, last);
}

/** `GET /mesh/v1/notes?since=`: this PC's own notes since it (0 or missing: only the newest id). */
export function meshNotes(notes: Notes, sinceParam: string | null): Json {
  const since = sinceParam !== null && /^\+?\d+$/.test(sinceParam) ? Number(sinceParam) : 0;
  if (since === 0) return notesWire([], notes.last());
  const [own, last] = notes.ownSince(since);
  return notesWire(own, last);
}

/** Whether a reply asks the user something: its last line ends with a question mark. */
export function asks(text: string): boolean {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  const last = lines[lines.length - 1] ?? "";
  return last.replace(/[*_`) "]+$/, "").endsWith("?");
}

/** A short excerpt for a notification: the last paragraph, its markdown marks dropped. */
export function excerpt(text: string): string {
  const paras = text.split("\n\n").map((p) => p.trim()).filter((p) => p !== "");
  const para = paras[paras.length - 1] ?? "";
  const flat = para
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^[#\-*>]+/, "").trim())
    .join(" ")
    .replaceAll("**", "")
    .replaceAll("`", "");
  const chars = [...flat];
  return chars.length > 160 ? `${chars.slice(0, 159).join("")}…` : flat;
}


/** A running notify-send: the lines it prints (the notification's id, then the clicked action), its pid, and its end. */
export interface NotifyProc {
  pid: number;
  lines: AsyncIterable<string>;
  kill(): void;
  exited: Promise<void>;
}

/** Starts notify-send with `args`; null when it can't start. */
export type NotifySend = (args: string[]) => NotifyProc | null;

/** notify-send's arguments as the Desktop class gives them: the title and body, a note to replace, whether it's quiet, its actions. */
export function notifySendArgs(args: readonly string[]): { title: string; body: string; replace: number | null; quiet: boolean; actions: string[] } {
  const pos: string[] = [];
  const actions: string[] = [];
  let replace: number | null = null;
  let quiet = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "-p") continue;
    if (a.startsWith("--replace-id=")) replace = Number(a.slice(13)) || null;
    else if (a === "-A") actions.push((args[++i] ?? "").split("=")[0] ?? "");
    else if (a === "-h") {
      const hint = args[++i] ?? "";
      if (hint.includes("suppress-sound:true")) quiet = true;
    }
    else if (["-a", "-u", "-t", "-i", "-c"].includes(a)) i++;
    else pos.push(a);
  }
  return { title: pos[0] ?? "", body: pos[1] ?? "", replace, quiet, actions };
}

let macNoteId = 0;

/**
 * macOS (inside Harbor.app): os.notify behind notify-send's protocol, so the Desktop class works as on
 * Linux: the note's id on the first line, then "default" when it's clicked. A note without an action
 * ends at once; one with an action waits for its click (or 6 hours, as an unanswered notify-send ends).
 */
export const osNotifySend: NotifySend = (args) => {
  const a = notifySendArgs(args);
  const n = a.replace ?? ++macNoteId;
  const out = new PassThrough();
  let ended = false;
  let end: () => void = () => {};
  const exited = new Promise<void>((r) => (end = r));
  const finish = (): void => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    out.end();
    end();
  };
  const timer = setTimeout(finish, 6 * 3600_000);
  (timer as { unref?: () => void }).unref?.();
  out.write(`${n}\n`);
  const click = a.actions.includes("default")
    ? () => {
        out.write("default\n");
        finish();
      }
    : undefined;
  osNotify.post({ id: `harbor-${n}`, title: a.title, body: a.body, sound: !a.quiet, ...(click ? { onClick: click } : {}) });
  if (!click) finish();
  return { pid: n, lines: createInterface({ input: out }), kill: () => (osNotify.remove(`harbor-${n}`), finish()), exited };
};

/** The real notify-send (macOS's own notifications from inside Harbor.app). */
export const spawnNotifySend: NotifySend = (args) => {
  if (osNotify.available()) return osNotifySend(args);
  const child = spawn("notify-send", args, { stdio: ["ignore", "pipe", "ignore"] });
  // Before anything else: a notify-send that isn't there (macOS, a bare Linux) fails with an "error" event,
  // which nothing would hear when the pid is missing below.
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  if (child.pid === undefined || child.stdout === null) return null;
  return {
    pid: child.pid,
    lines: createInterface({ input: child.stdout }),
    kill: () => {
      child.kill("SIGTERM");
    },
    exited,
  };
};

/** GitHub's CLI is on PATH (the PR list needs it). */
export function hasGh(path: string | undefined = process.env.PATH): boolean {
  if (path === undefined) return false;
  return path.split(delimiter).some((d) => {
    if (d === "") return false;
    try {
      const f = join(d, "gh");
      return statSync(f).isFile() && (accessSync(f, constants.F_OK), true);
    } catch {
      return false;
    }
  });
}

/** A key pops up again at most this often (ms); in between its notification is replaced quietly. */
export const REPOP_MS = 30_000;

interface Shown {
  id: number;
  at: number;
  pid: number;
  kill: () => void;
}

export interface DesktopOptions {
  send: NotifySend;
  prefs?: Prefs;
  /** Unix seconds. */
  clock?: () => number;
  /** Monotonic milliseconds. */
  mono?: () => number;
  /** Minutes since local midnight. */
  localMinute?: () => number;
  /** Called when a notification was clicked and its chat waits in `takeOpen`. */
  onOpen?: () => void;
}

/** This PC's own notifications (notify-send), shown only while Harbor's window isn't in front. */
export class Desktop {
  prefs: Prefs;
  /** Harbor's window is in front (focused and visible): no desktop popups then. */
  focused = false;
  /** When the user last used a focused Harbor window (unix s). */
  atPcAt = 0;
  private readonly send: NotifySend;
  private readonly clock: () => number;
  private readonly mono: () => number;
  private readonly minute: () => number;
  private readonly onOpen: () => void;
  private readonly shown = new Map<string, Shown>();
  private opened: string[] = [];
  private pending = new Set<Promise<void>>();

  constructor(o: DesktopOptions) {
    this.send = o.send;
    this.prefs = o.prefs ?? defaultPrefs();
    this.clock = o.clock ?? unixNow;
    this.mono = o.mono ?? Date.now;
    this.minute =
      o.localMinute ??
      (() => {
        const d = new Date();
        return d.getHours() * 60 + d.getMinutes();
      });
    this.onOpen = o.onOpen ?? (() => {});
  }

  /** The user is at this PC: Harbor's window is in front and was used within AWAY_S. */
  atPc(): boolean {
    return this.focused && this.clock() - this.atPcAt < AWAY_S;
  }

  /** Each frame: whether Harbor is in front and whether the user did something in it. */
  frame(front: boolean, used: boolean): void {
    this.focused = front;
    if (front && used) this.atPcAt = this.clock();
  }

  /** Chats (gid) a desktop notification was clicked for; the UI opens them. */
  takeOpen(): string[] {
    const v = this.opened;
    this.opened = [];
    return v;
  }

  /** Resolves when every notification being watched has ended. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  /** Shows `n` unless Harbor is in front, it's off in the settings, it's quiet hours, or (away only) the user is at the PC. Clicking it opens the chat. */
  show(n: Note): void {
    if (this.focused) return;
    const p = this.prefs;
    if (!prefsOn(p, n.kind) || quietAt(p, this.minute()) || (p.away_only && !n.away)) return;
    const prev = this.shown.get(n.key);
    let replace: number | undefined;
    let quiet = false;
    if (prev) {
      // The one it replaces waits for a click that can't come any more.
      if (prev.pid > 0) prev.kill();
      replace = prev.id;
      quiet = this.mono() - prev.at < REPOP_MS;
    }
    const title = n.count > 1 ? `${n.title} (${n.count})` : n.title;
    const args = ["-a", "Harbor", "-p", "-u", n.kind === "input" ? "critical" : "normal"];
    if (replace !== undefined) args.push(`--replace-id=${replace}`);
    if (quiet) args.push("-h", "boolean:suppress-sound:true", "-h", "boolean:transient:true");
    if (n.chat !== "") args.push("-A", "default=Open");
    args.push(title, n.body);
    const proc = this.send(args);
    if (!proc) return;
    const job = this.watch(proc, n.key, n.chat, quiet).finally(() => this.pending.delete(job));
    this.pending.add(job);
  }

  private async watch(proc: NotifyProc, key: string, chat: string, quiet: boolean): Promise<void> {
    const it = proc.lines[Symbol.asyncIterator]();
    const first = await it.next();
    if (!first.done) {
      const t = String(first.value).trim();
      if (/^\+?\d+$/.test(t) && Number(t) <= 0xffff_ffff) {
        const at = quiet ? (this.shown.get(key)?.at ?? this.mono()) : this.mono();
        this.shown.set(key, { id: Number(t), at, pid: proc.pid, kill: () => proc.kill() });
      }
    }
    // Clicked (the default action): open the chat in the window.
    const second = await it.next();
    if (!second.done && String(second.value).trim() === "default" && chat !== "") {
      this.opened.push(chat);
      this.onOpen();
    }
    await proc.exited;
    // Done: nothing to end when it's replaced.
    const e = this.shown.get(key);
    if (e && e.pid === proc.pid) e.pid = 0;
  }

  /** Settings' test: shown here whatever the window and the settings. */
  async testPopup(n: Note): Promise<void> {
    const proc = this.send(["-a", "Harbor", n.title, n.body]);
    if (proc) await proc.exited;
  }
}

/** Settings > Notifications > Send a test. */
export function testNote(): Note {
  return newNote({ kind: "test", key: "test", title: "Test from Harbor", body: "Notifications work." });
}


/** A chat whose turn ended, as note_turn needs it. */
export interface TurnChat {
  gid: string;
  title: string;
  name: string;
  /** The PC it lives on when it is a copy of another PC's chat ("" for this PC's own). */
  home: string;
  /** The name of its project, when it has one. */
  project: string | null;
}

/** A PC of the mesh as the peer worker sees it. */
export interface PeerState {
  id: string;
  name: string;
  online: boolean;
}

export type PrState = "open" | "closed" | "merged";

export interface PrItem {
  repo: string;
  number: number;
  head: string;
  title: string;
  url: string;
  author: string;
  state: PrState;
  checks: "failing" | "passing" | "pending" | "none";
}

/** A fresh PR list. */
export interface FetchedPrs {
  viewer: string;
  items: readonly PrItem[];
}

export interface NotifierOptions {
  notes: Notes;
  desktop?: Desktop;
}

/** What the app does with an event: a Note for phones, and a desktop popup when the settings say. */
export class Notifier {
  readonly notes: Notes;
  readonly desktop: Desktop | undefined;
  private online = new Map<string, boolean>();
  private went: string[] = [];
  private failed: Set<string> | null = null;

  constructor(o: NotifierOptions) {
    this.notes = o.notes;
    this.desktop = o.desktop;
  }

  /** Keeps `n` for phones (and the mesh); `desk`: may pop up on this desktop too. */
  push(input: Note, desk: boolean): Note {
    const n: Note = { ...input, body: [...input.body].slice(0, 240).join(""), away: !(this.desktop?.atPc() ?? false) };
    const kept = this.notes.push(n);
    if (desk) this.desktop?.show(kept);
    return kept;
  }

  /** A note for an event here: kept for phones, and shown on this desktop when the settings say. */
  post(kind: string, key: string, title: string, body: string, chat: string, reply: boolean): void {
    this.push(newNote({ kind, key, title, body, chat, reply }), true);
  }

  /** A turn ended: the lead (needs you when it asks something, failed, or finished), or a sub-agent. Copies of another PC's chats are that PC's to notify. */
  noteTurn(c: TurnChat | null, sub: boolean, failed: boolean, said: string): void {
    if (!c || c.home !== "" || c.gid === "") return;
    const who = sub && c.name !== "" ? c.name : c.title !== "" ? c.title : "A chat";
    let kind: string;
    let title: string;
    if (sub) {
      kind = "agent";
      title = `${who} finished`;
    } else if (failed) {
      kind = "done";
      title = `${who} stopped with an error`;
    } else if (asks(said)) {
      kind = "input";
      title = `${who} needs you`;
    } else {
      kind = "done";
      title = `${who} finished`;
    }
    const t = excerpt(said);
    const body = c.project !== null ? (t !== "" ? `${c.project} · ${t}` : c.project) : t;
    this.post(kind, `chat:${c.gid}`, title, body, c.gid, true);
  }

  /** A usage limit stopped a chat: waiting for you needs you (Continue on the phone), continuing by itself later is news about the account. `accountName`: the account as people see it. */
  noteLimit(c: { gid: string; title: string; home: string } | null, account: string, accountName: string, waits: boolean, text: string): void {
    if (!c || c.home !== "") return;
    const n = waits
      ? newNote({ kind: "input", key: `chat:${c.gid}`, title: `${c.title} waits for you`, body: `${accountName}: ${text}`, chat: c.gid, act: "continue" })
      : newNote({ kind: "limit", key: `limit:${account}`, title: `${accountName} hit its usage limit`, body: `${c.title}: ${text}`, chat: c.gid });
    this.push(n, true);
  }

  /** The limit reset and the chat continues (`desk`: the desktop shows it only with "Notify me when work resumes"). */
  noteResumed(c: { gid: string; title: string } | null, account: string, accountName: string, text: string, desk: boolean): void {
    if (!c) return;
    this.push(newNote({ kind: "limit", key: `limit:${account}`, title: `${accountName}: usage limit reset`, body: `${c.title} · ${text}`, chat: c.gid }), desk);
  }

  /** PCs of the mesh that went offline (or came back): their transitions only, not the start of Harbor or the mesh being turned off. */
  notePeers(peers: readonly PeerState[], meshOn: boolean): void {
    for (const p of peers) {
      const was = this.online.get(p.id);
      this.online.set(p.id, p.online);
      const name = p.name === "" ? "A PC" : p.name;
      if (was === true && !p.online && meshOn) {
        this.post("pc", `pc:${p.id}`, `${name} went offline`, "Harbor there doesn't answer any more.", "", false);
      } else if (was === false && p.online && meshOn && this.went.includes(p.id)) {
        this.post("pc", `pc:${p.id}`, `${name} is back online`, "", "", false);
      }
      if (p.online) this.went = this.went.filter((x) => x !== p.id);
      else if (was === true && meshOn) this.went.push(p.id);
    }
  }

  /** New PR lists: the user's open PRs whose checks just failed (once per head commit). The first list after start only says what failed already. */
  noteChecks(f: FetchedPrs): void {
    const primed = this.failed !== null;
    const set = (this.failed ??= new Set<string>());
    for (const pr of f.items) {
      if (pr.state !== "open" || pr.checks !== "failing" || (f.viewer !== "" && pr.author !== f.viewer)) continue;
      const mark = `${pr.repo}#${pr.number}@${pr.head}`;
      if (set.has(mark)) continue;
      set.add(mark);
      if (!primed) continue;
      this.push(
        newNote({
          kind: "ci",
          key: `ci:${pr.repo}#${pr.number}`,
          title: `Checks failed on #${pr.number} in ${pr.repo.slice(pr.repo.lastIndexOf("/") + 1)}`,
          body: pr.title,
          url: pr.url,
        }),
        true,
      );
    }
  }
}

/** Seconds between PR refreshes for failed checks. */
export const PR_REFRESH_S = 600;

/** Whether the PR list should be loaded again: CI notes are wanted when the desktop has them on or a phone is paired (it may want them). */
export function prRefreshDue(a: { prefs: Prefs; phonesPaired: boolean; loading: boolean; now: number; last: number; ghInstalled: boolean }): boolean {
  const ci = prefsOn(a.prefs, "ci") || a.phonesPaired;
  return ci && !a.loading && a.now - a.last >= PR_REFRESH_S && a.ghInstalled;
}
