import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { http, jsonBody } from "./client.ts";
import { now, type Kv } from "./kv.ts";
import { loadProfileDetected } from "./profile.ts";
import type { Dest, Peer } from "./shared.ts";
import type { Sighting } from "./hub.ts";
import { newestVersion, pcLine as harborLine, phoneShort, type PcVersion } from "./versions.ts";
import { Ordered, wire, type Json } from "./wire.ts";

const INSTR_MAX = 40_000;
const MEM_FILE_MAX = 64 * 1024;
const MEM_TOTAL_MAX = 512 * 1024;
const MEM_FILES_MAX = 100;
/** Claude Code settings that are the person's, not the PC's: never hooks, permissions, env or helpers, which would run things on the host. */
export const CTX_SETTINGS = ["language", "outputStyle", "alwaysThinkingEnabled", "includeCoAuthoredBy", "attribution", "autoMemoryEnabled"];
/** How long a memory folder handed out stays writable by the PC that got it (s). */
const MEM_TTL = 30 * 86400;
const MEM_KEY = "ctx_memory";
/** kv: "0" = don't send this PC's instructions and memory with chats on other PCs. */
export const SEND_KEY = "ctx_send";
/** kv: the owner's name and GitHub login as this PC tells the mesh (empty: guessed). */
export const OWNER_KEY = "owner_name";
export const GITHUB_KEY = "owner_github";
const GUESTS_KEY = "ctx_guests";

/** Where this PC keeps things; injected so tests use a temp folder. */
export interface CtxEnv {
  home: string;
  dataDir: string;
  hostname: string;
}

/** What the owner is worked out from besides kv: the account, the PC's full name and Harbor's GitHub sign-in. */
export interface OwnerSources {
  accountOwnerName(): string | null;
  signedIn(): boolean;
  fullName(): string;
  githubUser(): string | null;
}

export function memNameOk(n: string): boolean {
  return Buffer.byteLength(n) <= 120 && n.endsWith(".md") && !n.startsWith(".") && /^[A-Za-z0-9._ -]+$/.test(n);
}

/** This PC's person's Claude profile: the default one (~/.claude). Other profiles may be other people's logins. */
export function ctxProfile(env: Pick<CtxEnv, "home">): string {
  return join(env.home, ".claude");
}

/** Claude Code's folder name for a working directory: the real path with every character but ASCII letters and digits turned into '-'. */
export function projectSlug(cwd: string): string {
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {
    // not there yet: the path as given
  }
  return [...real].map((c) => (/[A-Za-z0-9]/.test(c) ? c : "-")).join("");
}

/** The auto-memory folder of `project` in the profile `config`. */
export function memoryDir(config: string, project: string): string {
  return join(config, "projects", projectSlug(project), "memory");
}

/** `t`'s first `max` bytes at most, cut at a character boundary. */
export function cutBytes(t: string, max: number): string {
  const b = Buffer.from(t);
  if (b.length <= max) return t;
  let i = max;
  while (i > 0 && ((b[i] as number) & 0xc0) === 0x80) i--;
  return b.subarray(0, i).toString("utf8");
}

function readText(p: string): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(p));
  } catch {
    return null;
  }
}

function readCap(p: string, max: number): string {
  const t = readText(p) ?? "";
  return Buffer.byteLength(t) <= max ? t : `${cutBytes(t, max)}\n[… cut]`;
}

/** The memory files of a folder: name to text, within the limits. */
export function readMemory(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  let total = 0;
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter(memNameOk).sort();
  } catch {
    return out;
  }
  // The index first: it's what Claude Code loads.
  const i = names.indexOf("MEMORY.md");
  if (i >= 0) names = ["MEMORY.md", ...names.filter((n) => n !== "MEMORY.md")];
  const read = new Map<string, string>();
  for (const n of names.slice(0, MEM_FILES_MAX)) {
    const t = readText(join(dir, n));
    if (t === null) continue;
    const len = Buffer.byteLength(t);
    if (len > MEM_FILE_MAX || total + len > MEM_TOTAL_MAX) continue;
    total += len;
    read.set(n, t);
  }
  return new Map([...read].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Only the person's own settings, in a fixed order. */
export function settingsOf(v: unknown): { [k: string]: Json } {
  const out: { [k: string]: Json } = {};
  if (!isObject(v)) return out;
  for (const k of CTX_SETTINGS) if (Object.hasOwn(v, k)) out[k] = v[k] as Json;
  return out;
}

function parseObject(t: string | null): Record<string, unknown> {
  if (t === null) return {};
  try {
    const v: unknown = JSON.parse(t);
    return isObject(v) ? v : {};
  } catch {
    return {};
  }
}

function privateDir(p: string): string {
  mkdirSync(p, { recursive: true });
  try {
    chmodSync(p, 0o700);
  } catch {
    // not ours to change
  }
  return p;
}

function memEntryFresh(v: unknown, at: number): boolean {
  return isObject(v) && at - (typeof v.at === "number" ? v.at : 0) < MEM_TTL;
}

/** A stable id for memory folder `dir` (the same folder keeps its id), noted with the time. */
function register(kv: Kv, dir: string, at: number): string {
  const m = parseObject(kv.get(MEM_KEY));
  const fresh: Record<string, Json> = {};
  for (const [k, v] of Object.entries(m)) if (memEntryFresh(v, at)) fresh[k] = v as Json;
  const found = Object.entries(fresh).find(([, v]) => isObject(v) && v.dir === dir);
  const id = found ? found[0] : randomBytes(12).toString("hex");
  fresh[id] = { dir, at };
  kv.set(MEM_KEY, wire(fresh));
  return id;
}

/** The memory ids handed out and still good: a call showing one is for a chat this PC commanded. */
export function issuedIds(kv: Kv, at: number = now()): Set<string> {
  const m = parseObject(kv.get(MEM_KEY));
  return new Set(Object.entries(m).filter(([, v]) => memEntryFresh(v, at)).map(([k]) => k));
}

export type CtxResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** `POST /mesh/v1/memory` `{id, files: {name: text | null}}`: written into (null: removed from) the memory folder `id` names here. How many changed. */
export function acceptMemory(kv: Kv, body: unknown, at: number = now()): CtxResult<number> {
  const b = isObject(body) ? body : {};
  const m = parseObject(kv.get(MEM_KEY));
  const id = typeof b.id === "string" ? b.id : "";
  const entry = Object.hasOwn(m, id) ? m[id] : undefined;
  if (id === "" || !isObject(entry) || !memEntryFresh(entry, at)) return { ok: false, error: "no such memory here" };
  const dir = typeof entry.dir === "string" ? entry.dir : "";
  if (!isAbsolute(dir)) return { ok: false, error: "no such memory here" };
  if (!isObject(b.files)) return { ok: false, error: "files is required" };
  const files = Object.entries(b.files);
  if (files.length > MEM_FILES_MAX) return { ok: false, error: "too many files" };
  let n = 0;
  try {
    for (const [name, text] of files) {
      if (!memNameOk(name)) continue;
      const f = join(dir, name);
      if (typeof text === "string" && Buffer.byteLength(text) <= MEM_FILE_MAX) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(f, text);
        n++;
      } else if (text === null) {
        try {
          rmSync(f);
          n++;
        } catch {
          // already gone
        }
      }
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, value: n };
}

/** A peer id as one folder name. */
function folder(peer: string): string {
  const s = [...peer].map((c) => (/[A-Za-z0-9_-]/.test(c) ? c : "-")).slice(0, 80).join("");
  return s === "" ? "unknown" : s;
}

/** The overlay profile (`CLAUDE_CONFIG_DIR`) turns commanded from `peer` run with. */
export function overlay(env: Pick<CtxEnv, "dataDir">, peer: string): string {
  return privateDir(join(privateDir(join(env.dataDir, "guests")), folder(peer)));
}

/** Every overlay profile here (their sessions may be resumed by the chat's next turn). */
export function overlays(env: Pick<CtxEnv, "dataDir">): string[] {
  const root = join(env.dataDir, "guests");
  try {
    return readdirSync(root).map((n) => join(root, n)).filter((p) => statSync(p).isDirectory());
  } catch {
    return [];
  }
}

/** A chat commanded from another PC: who, and the memory id to send changes back with. */
export interface Guest {
  /** The commanding PC's peer id and name. */
  peer: string;
  name: string;
  /** Its owner and GitHub login, as it said. */
  owner: string;
  github: string;
  memory_id: string;
  /** It sent no instructions or memory (turned off there, or a Harbor before 0.44). */
  off: boolean;
}

function sameGuest(a: Guest, b: Guest): boolean {
  return a.peer === b.peer && a.name === b.name && a.owner === b.owner && a.github === b.github && a.memory_id === b.memory_id && a.off === b.off;
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;

function hash(t: string): bigint {
  let h = FNV_OFFSET;
  for (const b of Buffer.from(t)) h = BigInt.asUintN(64, (h ^ BigInt(b)) * FNV_PRIME);
  return h;
}

/** What the overlay's memory folder held when it came (name to hash), and whether changes made there since haven't reached the commanding PC yet. */
interface MemState {
  id: string;
  base: Map<string, bigint>;
  pending: boolean;
}

function stateFile(mem: string): string {
  return join(dirname(mem), "harbor-memory.json");
}

function loadState(mem: string): MemState {
  const empty: MemState = { id: "", base: new Map(), pending: false };
  const t = readText(stateFile(mem));
  if (t === null) return empty;
  try {
    // The hashes are u64 numbers: quoted before parsing so they keep every digit.
    const v: unknown = JSON.parse(t.replace(/("[^"]*"\s*:\s*)(\d{16,})/g, '$1"$2"'));
    if (!isObject(v) || typeof v.id !== "string" || !isObject(v.base)) return empty;
    const base = new Map<string, bigint>();
    for (const [n, h] of Object.entries(v.base)) base.set(n, BigInt(h as string | number));
    return { id: v.id, base, pending: v.pending === true };
  } catch {
    return empty;
  }
}

function saveState(mem: string, st: MemState): void {
  mkdirSync(dirname(mem), { recursive: true });
  const base = [...st.base].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([n, h]) => `${JSON.stringify(n)}:${h}`);
  writeFileSync(stateFile(mem), `{"id":${JSON.stringify(st.id)},"base":{${base.join(",")}},"pending":${st.pending}}`);
}

function cap80(v: unknown): string {
  return typeof v === "string" ? [...v].slice(0, 80).join("") : "";
}

/** The `ctx` of a call from `peer` (`name`), for a chat working in `cwd` here: written into the peer's overlay; memory changes that haven't reached the peer yet stay and go with the next push. */
export function applyCtx(env: Pick<CtxEnv, "dataDir">, peer: string, name: string, ctx: unknown, cwd: string): Guest {
  const o = overlay(env, peer);
  const c = isObject(ctx) ? ctx : {};
  const g: Guest = { peer, name, owner: cap80(c.owner), github: cap80(c.github), memory_id: cap80(c.memory_id), off: !isObject(ctx) || c.off === true };
  const instr = typeof c.instructions === "string" ? c.instructions : "";
  const claudeMd = join(o, "CLAUDE.md");
  if (instr.trim() === "") rmSync(claudeMd, { force: true });
  else writeFileSync(claudeMd, cutBytes(instr, INSTR_MAX + 16));
  // Checked again here: hooks and the like would run on this PC.
  writeFileSync(join(o, "settings.json"), wire(settingsOf(c.settings)));
  const mem = memoryDir(o, cwd);
  const st = loadState(mem);
  const incoming = new Map<string, string>();
  if (isObject(c.memory)) {
    const entries = Object.entries(c.memory).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const [n, t] of entries) {
      if (incoming.size >= MEM_FILES_MAX) break;
      if (memNameOk(n) && typeof t === "string" && Buffer.byteLength(t) <= MEM_FILE_MAX) incoming.set(n, t);
    }
  }
  mkdirSync(mem, { recursive: true });
  const here = readMemory(mem);
  const changed = new Set<string>();
  if (st.pending && st.id === g.memory_id) for (const [n, t] of here) if (st.base.get(n) !== hash(t)) changed.add(n);
  for (const n of here.keys()) if (!incoming.has(n) && !changed.has(n)) rmSync(join(mem, n), { force: true });
  for (const [n, t] of incoming) if (!changed.has(n)) writeFileSync(join(mem, n), t);
  st.base = new Map([...incoming].map(([n, t]) => [n, hash(t)]));
  st.pending = changed.size > 0;
  st.id = g.memory_id;
  saveState(mem, st);
  return g;
}

/** The overlay's memory changes since it came: `{name: text | null}`, names sorted. */
function changesOf(mem: string, st: MemState): Map<string, string | null> {
  const now_ = readMemory(mem);
  const out = new Map<string, string | null>();
  for (const [n, t] of now_) if (st.base.get(n) !== hash(t)) out.set(n, t);
  for (const n of st.base.keys()) if (!now_.has(n)) out.set(n, null);
  return new Map([...out].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}

/** The overlay's memory changes of a chat of `g` working in `cwd`, as `push` would send them. */
export function memoryChanges(env: Pick<CtxEnv, "dataDir">, g: Guest, cwd: string): Map<string, string | null> {
  const mem = memoryDir(overlay(env, g.peer), cwd);
  return changesOf(mem, loadState(mem));
}

/** Sends the memory body to the commanding PC; resolves its HTTP status. Injected for tests. */
export type MemorySender = (dest: Dest, body: Json) => Promise<number>;

export const sendMemoryHttp: MemorySender = async (dest, body) => (await http(dest, "POST", "/mesh/v1/memory", jsonBody(body), 20_000))[0];

/** After a turn of `g`'s chat (in `cwd` here): memory it saved goes to the commanding PC. Kept as pending when that PC doesn't take it (sent with the next turn's push). */
export async function pushMemory(env: Pick<CtxEnv, "dataDir">, dest: Dest, g: Guest, cwd: string, send: MemorySender = sendMemoryHttp): Promise<void> {
  if (g.memory_id === "") return;
  const mem = memoryDir(overlay(env, g.peer), cwd);
  const st = loadState(mem);
  if (st.id !== g.memory_id) return;
  const files = changesOf(mem, st);
  if (files.size === 0) return;
  st.pending = true;
  saveState(mem, st);
  let status: number | null = null;
  try {
    status = await send(dest, { id: g.memory_id, files: Object.fromEntries(files) });
  } catch {
    status = null;
  }
  if (status === 200) {
    for (const [n, t] of files) {
      if (t !== null) st.base.set(n, hash(t));
      else st.base.delete(n);
    }
    st.pending = false;
    saveState(mem, st);
  } else {
    console.error(`harbor: memory for ${g.name} not sent back yet: ${status}`);
  }
}

function guestJson(g: Guest): Ordered {
  return new Ordered([
    ["peer", g.peer],
    ["name", g.name],
    ["owner", g.owner],
    ["github", g.github],
    ["memory_id", g.memory_id],
    ["off", g.off],
  ]);
}

/** The chats commanded from other PCs, as saved. */
export function loadGuests(kv: Kv): Map<number, Guest> {
  const out = new Map<number, Guest>();
  const t = kv.get(GUESTS_KEY);
  if (t === null) return out;
  try {
    const v: unknown = JSON.parse(t);
    if (!isObject(v)) return out;
    for (const [id, g] of Object.entries(v)) {
      if (!isObject(g) || typeof g.peer !== "string" || typeof g.name !== "string" || !/^-?\d+$/.test(id)) return new Map();
      // serde: a field that is there must have its type.
      const s = (k: string): string | null => (g[k] === undefined ? "" : typeof g[k] === "string" ? (g[k] as string) : null);
      const [owner, github, memoryId] = [s("owner"), s("github"), s("memory_id")];
      if (owner === null || github === null || memoryId === null || (g.off !== undefined && typeof g.off !== "boolean")) return new Map();
      out.set(Number(id), { peer: g.peer, name: g.name, owner, github, memory_id: memoryId, off: g.off === true });
    }
  } catch {
    return new Map();
  }
  return out;
}

export function saveGuests(kv: Kv, guests: ReadonlyMap<number, Guest>): void {
  const entries = [...guests].sort((a, b) => a[0] - b[0]).map(([id, g]): [string, Json] => [String(id), guestJson(g)]);
  kv.set(GUESTS_KEY, wire(new Ordered(entries)));
}

/** Told to a guest turn's agent: whose chat it is and what that means here. */
export function guestNote(g: Guest, me: string, signedIn: boolean): string {
  const who = g.owner === "" ? `the person at '${g.name}'` : `${g.owner} (at '${g.name}')`;
  let s = `This chat is commanded from another PC of the user's Harbor mesh: you work for ${who}, not for the owner of '${me}', the PC you run on. `;
  if (g.off) s += `'${g.name}' sent no user instructions or memory, so none are loaded; '${me}'s own aren't either. `;
  else s += `The user instructions, auto-memory and settings loaded are theirs, sent by Harbor from '${g.name}'; memory you save goes back there. `;
  s += `'${me}' only lends its compute, files and tools: paths are '${me}' paths.`;
  if (!signedIn) s += ` '${me}'s GitHub and app sign-ins belong to its owner, so they are off in this chat (gh is signed out).`;
  return s;
}

/** The folder (relative to home) a device keeps this PC's empty profile in, so its own user instructions and memory don't load for this PC's chats. */
export function deviceProfile(myId: string): string {
  return `.local/state/harbor/guests/${folder(myId)}`;
}

/** Told to an agent on an SSH device: this PC's person's instructions and memory, and where to save memory (`workspace`: through the workspace tools, when it works on this PC's files). */
export function deviceNote(env: Pick<CtxEnv, "home" | "hostname">, project: string | null, workspace: boolean): string {
  const p = ctxProfile(env);
  const host = env.hostname;
  let s = "";
  const instr = readCap(join(p, "CLAUDE.md"), 20_000);
  if (instr.trim() !== "") s += `The user's own instructions (their global CLAUDE.md on '${host}'; the device's are not loaded):\n\n${instr.trim()}`;
  if (project !== null) {
    const dir = memoryDir(p, project);
    const index = readCap(join(dir, "MEMORY.md"), 20_000);
    const save = workspace
      ? "Save new memories there with the workspace tools (mcp__origin__write/edit), one file per memory plus a line in MEMORY.md"
      : "This chat can't write there (it works on the device's files), so don't save memories";
    const tail = index.trim() === "" ? " It's empty so far." : ` Its index, MEMORY.md:\n\n${index.trim()}`;
    s += `\n\nThe user's auto-memory for this project is on '${host}' in ${dir} (the device's own memory is off). ${save}.${tail}`;
  }
  return s.trim();
}

/** This PC's owner as it tells the mesh: what the user typed, else what profile.ts detected, else the account's full name. A signed-in account's own name beats any guess. */
export function ownerOf(kv: Kv, src: OwnerSources): string {
  const detected = src.accountOwnerName() ?? loadProfileDetected(kv)?.me.owner ?? null;
  return pick(kv.get(OWNER_KEY), detected, () => src.fullName());
}

/** The GitHub login: typed, else detected, else Harbor's GitHub sign-in. */
export function githubOf(kv: Kv, src: OwnerSources): string {
  const t = (v: string | null): string | null => (v === null ? null : v.trim().replace(/^@+/, ""));
  return pick(t(kv.get(GITHUB_KEY)), t(loadProfileDetected(kv)?.me.github ?? null), () => src.githubUser() ?? "");
}

/** Typed beats detected beats the fallback; blanks don't count. */
export function pick(typed: string | null, detected: string | null, fallback: () => string): string {
  const ok = (v: string | null): string | null => (v !== null && v.trim() !== "" ? v.trim() : null);
  return ok(typed) ?? ok(detected) ?? fallback();
}

/** The user has said who owns this PC: typed a name, confirmed the detected one, or signed in. */
export function ownerConfirmed(kv: Kv, src: Pick<OwnerSources, "signedIn">): boolean {
  const t = kv.get(OWNER_KEY);
  return (t !== null && t.trim() !== "") || src.signedIn();
}

/** Confirm: what shows now (detected or fallback) becomes the user's own, in the fields that are still empty; a typed value stays as it is. */
export function confirmOwner(kv: Kv, src: OwnerSources): void {
  const o = ownerOf(kv, src);
  const g = githubOf(kv, src);
  if (!ownerConfirmed(kv, src) && o !== "") kv.set(OWNER_KEY, o);
  const typed = kv.get(GITHUB_KEY);
  if ((typed === null || typed.trim() === "") && g !== "") kv.set(GITHUB_KEY, g);
}

/** `{owner, github, owner_suggested}` for `hello` and `/mesh/v1/phones`. */
export function aboutOwner(kv: Kv, src: OwnerSources): { owner: string; github: string; owner_suggested: boolean } {
  const owner = ownerOf(kv, src);
  return { owner, github: githubOf(kv, src), owner_suggested: owner !== "" && !ownerConfirmed(kv, src) };
}

/** The `ctx` a forwarded call carries: this PC's person's instructions, the memory of `project` (this PC's folder of the chat's project, or null), settings, and the id the home PC sends memory back with. `{"v": 1, "off": true}` when the user doesn't send it. */
export function outgoingCtx(kv: Kv, env: CtxEnv, src: OwnerSources, project: string | null, at: number = now()): Json {
  const me = aboutOwner(kv, src);
  if (kv.get(SEND_KEY) === "0") return { v: 1, off: true, owner: me.owner, github: me.github };
  const p = ctxProfile(env);
  const settings = parseObject(readText(join(p, "settings.json")));
  // A chat without a project runs in home there: its memory is home's here.
  const dir = memoryDir(p, project ?? env.home);
  const memory = readMemory(dir);
  const id = register(kv, dir, at);
  return {
    v: 1,
    instructions: readCap(join(p, "CLAUDE.md"), INSTR_MAX),
    memory: Object.fromEntries(memory),
    memory_id: id,
    settings: settingsOf(settings),
    owner: me.owner,
    github: me.github,
  };
}

/** One PC of the mesh, for the agent and the people lists. */
export interface Pc {
  id: string;
  name: string;
  me: boolean;
  online: boolean;
  owner: string;
  github: string;
  phones: string[];
  accounts: string[];
  /** Owner and login are a detection nobody has confirmed (profile.ts). */
  suggested: boolean;
  /** Made by this PC about a peer that says nothing itself. */
  guessed: boolean;
  /** The detection's evidence, where this PC has it. */
  why: string;
  /** Its Harbor in a line (versions.ts). */
  harbor: string;
  /** Phone name to "app 0.66.0", for the phones whose app said its version. */
  phone_apps: Map<string, string>;
}

export function newPc(p: Partial<Pc> = {}): Pc {
  return { id: "", name: "", me: false, online: false, owner: "", github: "", phones: [], accounts: [], suggested: false, guessed: false, why: "", harbor: "", phone_apps: new Map(), ...p };
}

/** A Pc as the people lists send it (without `line` and `share`). */
export function pcJson(p: Pc): { [k: string]: Json } {
  const o: { [k: string]: Json } = {
    id: p.id,
    name: p.name,
    self: p.me,
    online: p.online,
    owner: p.owner,
    github: p.github,
    phones: p.phones,
    accounts: p.accounts,
    suggested: p.suggested,
    guessed: p.guessed,
  };
  if (p.why !== "") o.why = p.why;
  if (p.harbor !== "") o.harbor = p.harbor;
  if (p.phone_apps.size > 0) o.phone_apps = Object.fromEntries(p.phone_apps);
  return o;
}

function ownerLabel(p: Pc): string {
  if (p.guessed) return `${p.owner} (guessed here, not confirmed)`;
  if (p.suggested) return `${p.owner} (detected, not confirmed)`;
  return p.owner;
}

/** One PC in a line: owner, GitHub, phones, accounts. */
export function peoplePcLine(p: Pc): string {
  const parts = [p.owner === "" ? "Owner not set" : ownerLabel(p)];
  if (p.github !== "") parts.push(`GitHub ${p.github}`);
  if (p.phones.length > 0) parts.push(`phones: ${p.phones.join(", ")}`);
  if (p.accounts.length > 0) parts.push(p.accounts.join(", "));
  if (!p.me && !p.online) parts.push("offline");
  return parts.join(" · ");
}

/** Told to every turn while the mesh has other PCs: who has which PC, phone and accounts. */
export function peopleNote(pcs: readonly Pc[]): string {
  if (pcs.length < 2) return "";
  let s = 'Harbor mesh, who is who (each PC\'s Harbor says its owner; PCs share chats; "not confirmed" ones were detected from the PC\'s accounts and settings):';
  for (const p of pcs) {
    const parts = [p.owner === "" ? "owner not set" : `owner ${ownerLabel(p)}`];
    if (p.github !== "") parts.push(`GitHub ${p.github}`);
    if (p.harbor !== "") parts.push(`Harbor ${p.harbor}`);
    if (p.phones.length > 0) {
      const phones = p.phones.map((n) => {
        const a = p.phone_apps.get(n);
        return a === undefined ? n : `${n} (${a})`;
      });
      parts.push(`phones: ${phones.join(", ")}`);
    }
    if (p.accounts.length > 0) parts.push(`agent accounts: ${p.accounts.join(", ")}`);
    const state = p.me ? " (this PC, where you run)" : p.online ? "" : " (offline)";
    s += `\n- ${p.name}${state}: ${parts.join("; ")}`;
  }
  s += "\nThe files, shell and GitHub of the other PCs are reachable with the mcp__machines__* tools (pass `machine`; `list` shows what each PC's owner allows this chat there).";
  return s;
}

/** What `mesh_pcs` reads from the app and the hub. */
export interface MeshPcsInput {
  kv: Kv;
  owners: OwnerSources;
  me: { id: string; name: string };
  hostname: string;
  meshOn: boolean;
  /** The phones paired with this PC itself. */
  localPhones: readonly { name: string; app: number }[];
  /** versions.gather's PCs: this one first. */
  versions: readonly PcVersion[];
  /** Short names of this PC's installed agent accounts. */
  accounts: readonly string[];
  /** Every PC's accounts, each sign-in once (meshaccounts.ts `accountsByPc`, "" this PC): used instead of `accounts` and what peers said. */
  byPc?: ReadonlyMap<string, readonly string[]>;
  /** The mesh's PCs (this PC's `mesh_hosts`). */
  hosts: readonly Peer[];
  elsewhere: ReadonlyMap<string, readonly [string, readonly Sighting[]]>;
  at?: number;
}

function phoneApps(phones: readonly { name: string; app: number }[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of phones) {
    if (p.name === "") continue;
    const a = phoneShort(p.app);
    if (a !== null) m.set(p.name, a);
  }
  return m;
}

/** Names once each, in order (a phone paired twice is one phone), without empty ones. */
function uniq(v: readonly string[]): string[] {
  return [...new Set(v.filter((n) => n !== ""))];
}

/** This PC and the mesh's other PCs, with owners, phones and accounts. */
export function meshPcs(i: MeshPcsInput): Pc[] {
  const name = i.me.name === "" ? i.hostname : i.me.name;
  const newest = newestVersion(i.versions);
  const harborOf = (id: string): string => {
    const v = i.versions.find((x) => x.id === id);
    return v ? harborLine(v, newest, i.at) : "";
  };
  const detected = loadProfileDetected(i.kv);
  const mine = aboutOwner(i.kv, i.owners);
  const suggested = mine.owner_suggested;
  const first = i.versions[0];
  const v: Pc[] = [
    newPc({
      id: i.me.id,
      name,
      me: true,
      online: true,
      owner: mine.owner,
      github: mine.github,
      phones: uniq(i.localPhones.map((p) => p.name)),
      accounts: [...(i.byPc ? (i.byPc.get("") ?? []) : i.accounts)],
      suggested,
      why: suggested && detected ? detected.me.why : "",
      harbor: first ? harborLine(first, newest, i.at) : "",
      phone_apps: phoneApps(i.localPhones),
    }),
  ];
  if (!i.meshOn) return v;
  for (const p of i.hosts) {
    const sightings = i.elsewhere.get(p.id)?.[1] ?? [];
    const pc = newPc({
      id: p.id,
      name: p.name,
      online: p.online,
      owner: p.owner,
      github: p.github,
      phones: uniq(sightings.map((x) => x.name)),
      accounts: i.byPc ? [...(i.byPc.get(p.id) ?? [])] : uniq(p.accounts.map((a) => a[1])),
      suggested: p.owner_suggested,
      harbor: harborOf(p.id),
      phone_apps: phoneApps(sightings),
    });
    // A peer that says nothing (before 0.44, or nothing found there): this PC's guess.
    if (pc.owner === "" && pc.github === "") {
      const g = detected?.peers.get(p.id);
      if (g) Object.assign(pc, { owner: g.owner, github: g.github, why: g.why, suggested: true, guessed: true });
    }
    v.push(pc);
  }
  return v;
}

/** The call context of a message another PC forwarded, or null for one typed here (its phones too). */
export interface CallCtx {
  peer: string;
  name: string;
  ctx: unknown;
}

/** In `send_to`: a forwarded message makes the chat run with that PC's context (written into its overlay now); one typed here makes it this PC's again. Returns the notice to show, if any. */
export function adoptCtx(a: { kv: Kv; env: Pick<CtxEnv, "dataDir">; guests: Map<number, Guest>; chatId: number; cwd: string | null; call: CallCtx | null; me: string }): string | null {
  let changed: boolean;
  let said: string | null;
  if (a.call) {
    if (a.cwd === null) return null;
    const g = applyCtx(a.env, a.call.peer, a.call.name, a.call.ctx, a.cwd);
    const who = g.owner === "" ? a.call.name : `${g.owner} (${a.call.name})`;
    const old = a.guests.get(a.chatId);
    if (old && old.peer === g.peer && old.off === g.off) said = null;
    else if (g.off) said = `Runs for ${who}, without user instructions or memory`;
    else said = `Runs with the instructions and memory of ${who}`;
    changed = !old || !sameGuest(old, g);
    a.guests.set(a.chatId, g);
  } else if (a.guests.delete(a.chatId)) {
    changed = true;
    said = `Runs with ${a.me}'s own instructions and memory again`;
  } else {
    changed = false;
    said = null;
  }
  if (changed) saveGuests(a.kv, a.guests);
  return said;
}

/** The chat commanded from another PC that a chat belongs to (itself, or its lead). */
export function guestOf(guests: ReadonlyMap<number, Guest>, chat: { id: number; parent: number | null }): Guest | null {
  return guests.get(chat.id) ?? (chat.parent === null ? null : (guests.get(chat.parent) ?? null));
}

/** The guest part of a turn's context (`remote`: it runs on an SSH device): the note, the overlay and whether this PC's sign-ins stay on. */
export function guestTurn(a: { env: Pick<CtxEnv, "dataDir">; guest: Guest; me: string; hostGithub: string; remote: boolean; note: string }): { note: string; overlay: string | null; signedIn: boolean } {
  const g = a.guest;
  const same = g.github !== "" && g.github.toLowerCase() === a.hostGithub.toLowerCase();
  const note = `${guestNote(g, a.me, same || a.remote)}\n\n${a.note}`.trim();
  return a.remote ? { note, overlay: null, signedIn: false } : { note, overlay: overlay(a.env, g.peer), signedIn: same };
}

/** `PATCH /v1/people` hooks: what the body can ask beyond the kv writes. */
export interface PeopleHooks {
  confirm(): void;
  detect(): void;
  /** Whether the mesh has this PC (a share is set for known PCs only). */
  hasPeer(id: string): boolean;
  setShare(pc: string, level: string): void;
  /** The levels machines.rs knows; others are ignored. */
  levelOk(level: string): boolean;
  setShareGithub(on: boolean): void;
  /** Called last: the about shared with the mesh changed. */
  republish(): void;
}

/** `PATCH /v1/people` `{owner?, github?, send_context?, share_github?, share?, op?}`. */
export function apiPeopleSet(kv: Kv, body: unknown, h: PeopleHooks): void {
  const b = isObject(body) ? body : {};
  if (b.op === "confirm") h.confirm();
  else if (b.op === "detect") h.detect();
  if (typeof b.owner === "string") kv.set(OWNER_KEY, [...b.owner].slice(0, 80).join(""));
  if (typeof b.github === "string") kv.set(GITHUB_KEY, [...b.github].slice(0, 60).join(""));
  if (typeof b.send_context === "boolean") kv.set(SEND_KEY, b.send_context ? "1" : "0");
  if (typeof b.share_github === "boolean") h.setShareGithub(b.share_github);
  const share = isObject(b.share) ? b.share : {};
  if (typeof share.pc === "string" && typeof share.level === "string" && h.levelOk(share.level) && h.hasPeer(share.pc)) h.setShare(share.pc, share.level);
  h.republish();
}

/** What `GET /v1/people` reads from the app besides kv. */
export interface PeopleView {
  pcs: readonly Pc[];
  /** machines.rs: what a PC's chats may do here; not asked for this PC. */
  share(id: string): { slug: string; label: string };
  levels: readonly { id: string; label: string; about: string }[];
  detecting: boolean;
  check: Json;
  shareGithub: boolean;
}

/** `GET /v1/people`: the who is who, and this PC's own entries (the phone's Settings > People). */
export function apiPeople(kv: Kv, src: OwnerSources, v: PeopleView): Json {
  const d = loadProfileDetected(kv);
  return {
    pcs: v.pcs.map((p) => {
      const o = pcJson(p);
      o.line = peoplePcLine(p);
      if (!p.me) {
        const l = v.share(p.id);
        o.share = l.slug;
        o.share_label = l.label;
      }
      return o;
    }),
    levels: v.levels.map((l) => ({ id: l.id, label: l.label, about: l.about })),
    me: {
      owner: kv.get(OWNER_KEY) ?? "",
      owner_hint: ownerOf(kv, src),
      github: kv.get(GITHUB_KEY) ?? "",
      github_hint: githubOf(kv, src),
      suggested: d ? { owner: d.me.owner, github: d.me.github, confidence: d.me.confidence, why: d.me.why, by: d.by, at: d.at } : null,
      confirmed: ownerConfirmed(kv, src),
      detecting: v.detecting,
      check: v.check,
      send_context: kv.get(SEND_KEY) !== "0",
      share_github: v.shareGithub,
    },
  };
}

/** `ctx_after_turn`: memory a chat commanded from another PC saved goes back, when that PC is online and the chat runs here (`device` empty). */
export async function ctxAfterTurn(a: {
  env: Pick<CtxEnv, "dataDir">;
  guest: Guest | null;
  device: string;
  peer(id: string): { online: boolean; dest: Dest } | null;
  cwd: string;
  send?: MemorySender;
}): Promise<void> {
  if (!a.guest || a.device !== "") return;
  const p = a.peer(a.guest.peer);
  if (!p || !p.online) return;
  await pushMemory(a.env, p.dest, a.guest, a.cwd, a.send);
}
