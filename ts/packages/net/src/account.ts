import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { type Kv } from "./kv.ts";
import { loadRemote, newHost, saveRemote } from "./remote.ts";
import { peerDevices, type Allowed, type Me, type PeerDevice } from "./shared.ts";
import { sha256Hex, short, signWith, spkiOf, type Identity } from "./tls.ts";
import type { Vault } from "./vault.ts";
import type { ChatCloud } from "./chatcloud.ts";
import { wire, type Json } from "./wire.ts";
import { desktop } from "@harbor/os";

/** Clerk's Frontend API of Harbor's Clerk app (OAuth endpoints). */
export const CLERK_URL = "https://maximum-feline-2818.clerk.accounts.dev";
/** The OAuth application Harbor signs in with (a public client: PKCE, no secret). */
export const ACCOUNT_CLIENT_ID = "FWUnta6BgUIwVT9O";
/** Harbor's account service (worker/). */
export const ACCOUNTS_URL = "https://harbor-accounts.rdevneo.workers.dev";
/** The public keys the service signs Harbor tokens with: [kid, base64url Ed25519 key]. Empty: this build trusts the keys fetched from `/v1/keys`. */
export const ACCOUNT_KEYS: readonly (readonly [string, string])[] = [["k1", "AKiosel0Qd-0CFV2NmRpLpM8zchoVP1iDrpt_OgyoII"]];

const SCOPE = "openid profile email offline_access";
const ISSUER = "harbor-accounts";
/** A Harbor token lasts 7 days; a new one is asked for once a day. */
const RENEW_AFTER = 24 * 3600;
const DIR_EVERY = 120_000;
/** The service pushes changes (GET /v1/events, a WebSocket): invitations are asked for on their own only while it's
 * down, this often; and once on every (re)connect. */
const INVITES_FALLBACK = 60_000;
/** The push socket: a keepalive this often (the service answers "pong" without waking anything), and reconnects that
 * back off from 1 s to this. */
const EVENTS_PING = 30_000;
const EVENTS_BACKOFF_MAX = 60_000;
/** A stranger's knock (a PC that may have just joined a workspace) fetches the directory again at most this often. */
const SOON_EVERY = 20_000;
/** An answered invitation stays hidden this long even if a fetch that began before the answer still lists it. */
const ANSWERED_MS = 10 * 60_000;
const PC_EVERY = 300_000;
const SYNC_EVERY = 60_000;
/** The vault's round: also what renews a single-host integration's lease (vault.ts LEASE_TTL is three times it). */
const VAULT_EVERY = 20_000;
const KEYS_EVERY = 6 * 3600_000;
const HTTP_TIMEOUT = 20_000;
/** A vault round the loop waits for at most: one that hangs (a single-host check that never answers) runs on by itself,
 * and the loop goes on fetching the directory, the settings and the rest. */
const VAULT_WAIT = 60_000;

export type AccountRole = "owner" | "member";

const roleOf = (s: string): AccountRole => (s === "owner" ? "owner" : "member");

export interface AccountWorkspace {
  id: string;
  name: string;
  /** An owner invites and removes people. */
  role: AccountRole;
  /** The account's own, made at its first sign-in. */
  personal: boolean;
}

export interface AccountMember {
  id: string;
  name: string;
  email: string;
  role: AccountRole;
  /** Their photo (an HTTPS URL); none: "" or missing. */
  image?: string;
}

/** A PC of a workspace as the directory lists it. */
export interface AccountPc {
  fp: string;
  /** Its mesh id. */
  id: string;
  name: string;
  addrs: string[];
  /** Who signed it into the workspace (account id, name). */
  owner: string;
  owner_name: string;
  seen: number;
  version: string;
  /** In `peers`: the names of the workspaces this PC's owner shares with that PC's owner. */
  via?: string[];
}

export interface AccountInvite {
  id: string;
  email: string;
  at: number;
  /** No Harbor account has this verified address: nobody can accept it as it is. */
  no_account: boolean;
  /** The address of someone already in one of your workspaces that differs by a typo, or "". */
  near: string;
}

/** An invitation waiting for this account (`GET /v1/invites`): only Accept joins. */
export interface AccountPendingInvite {
  id: string;
  ws: string;
  ws_name: string;
  inviter_name: string;
  email: string;
  at: number;
}

/** One workspace in the directory. */
export interface AccountDir extends AccountWorkspace {
  members: AccountMember[];
  pcs: AccountPc[];
  /** The TLS keys of every member's phones and PCs. */
  devices: string[];
  /** Waiting invitations (owners only). */
  invites: AccountInvite[];
}

/** The directory as last fetched (kv `account_dir`): `at` is the service's clock, in ms. */
export interface AccountDirectory {
  at: number;
  workspaces: AccountDir[];
  /** The PCs this PC trusts: every PC whose owner is a member of a workspace this PC's owner is a member of (the service
   * works it out, both ways alike). The only PCs it shares chats with, relays to and lets move chats here. */
  peers: AccountPc[];
}

/** Who is signed in here (kv `account`): no secrets. */
export interface AccountUser {
  id: string;
  email: string;
  name: string;
  image: string;
  workspaces: AccountWorkspace[];
}

/** What the desktop shows about the account (Settings, the sign-in page, banners). */
export interface AccountStatus {
  /** A sign-in waits for the browser. */
  signingIn: boolean;
  /** The URL to open by hand. */
  url: string;
  error: string;
  /** Clerk ended this PC's session: sign in again. Everything keeps working meanwhile. */
  expired: boolean;
  /** The service didn't answer since then (unix s; 0: it did). */
  offlineSince: number;
  /** Signed in, in several workspaces, and this PC is in none: the user picks one. */
  pick: boolean;
  /** The last directory fetched (unix s). */
  syncedAt: number;
  /** An action from Settings is running. */
  busy: boolean;
  /** Something to tell once, taken by the desktop's toast. */
  notice: string;
}

/** What a Harbor token says. */
export interface HarborClaims {
  iss: string;
  sub: string;
  email: string;
  name: string;
  ws: string[];
  /** The fingerprint of the device's TLS key: the token works only with it. */
  dev: string;
  kind: string;
  iat: number;
  exp: number;
}

export type AccountResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** A public key a token may be signed with: [kid, 32 raw bytes]. */
export type AccountKey = readonly [string, Uint8Array];

/** The shape api.ts's `Account` dependency asks for; `admit` throws with the reason. */
export interface AccountApi {
  isToken(t: string): boolean;
  admit(t: string, fp: string): HarborClaims;
  knownDevice(fp: string): boolean;
}

export function directoryOf(d: AccountDirectory, ws: string): AccountDir | undefined {
  return d.workspaces.find((w) => w.id === ws);
}

/** Each PC the directory lists, by mesh id, with its workspace's id. */
export function directoryPcWorkspaces(d: AccountDirectory): Map<string, string> {
  const out = new Map<string, string>();
  for (const w of d.workspaces) for (const p of w.pcs) if (p.id !== "") out.set(p.id, w.id);
  return out;
}

/** The other PCs of account `me` the directory lists (by mesh id, `self` left out): store.ts `Placement.mates`. */
export function directoryMates(d: AccountDirectory, me: string, self: string): Set<string> {
  const out = new Set<string>();
  if (me === "") return out;
  for (const p of [...d.workspaces.flatMap((w) => w.pcs), ...d.peers]) if (p.owner === me && p.id !== "" && p.id !== self) out.add(p.id);
  return out;
}

/**
 * The workspace a chat person `person` (an account id) starts here goes in when it has no project: the workspace of
 * their PCs (this PC's `mine` when one of them is in it), else one they own; "" when it's this PC's own or none is known
 * here (the directory lists only the workspaces this PC's owner is a member of): the chat then stays in this PC's.
 */
export function personWorkspace(d: AccountDirectory, person: string, mine: string): string {
  if (person === "") return "";
  const theirs = d.workspaces.filter((w) => w.pcs.some((p) => p.owner === person)).map((w) => w.id);
  const owned = d.workspaces.filter((w) => w.members.some((m) => m.id === person && m.role === "owner")).map((w) => w.id);
  const ws = theirs.length > 0 ? theirs : owned;
  if (ws.length === 0 || ws.includes(mine)) return "";
  return ws[0] ?? "";
}

/** The account that owns PC `id` (mesh id) as the directory lists it, "" when not known. */
export function directoryPcOwner(d: AccountDirectory, id: string): string {
  if (id === "") return "";
  for (const p of [...d.workspaces.flatMap((w) => w.pcs), ...d.peers]) if (p.id === id && p.owner !== "") return p.owner;
  return "";
}

export function workspaceOwner(w: AccountWorkspace): boolean {
  return w.role === "owner";
}

export function emptyDirectory(): AccountDirectory {
  return { at: 0, workspaces: [], peers: [] };
}

type Obj = Record<string, unknown>;

class Odd extends Error {}

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function need(v: unknown): Obj {
  if (!isObj(v)) throw new Odd("expected an object");
  return v;
}

function str(o: Obj, k: string, required = false): string {
  const v = o[k];
  if (v === undefined) {
    if (required) throw new Odd(`missing field \`${k}\``);
    return "";
  }
  if (typeof v !== "string") throw new Odd(`invalid type for \`${k}\``);
  return v;
}

function int(o: Obj, k: string): number {
  const v = o[k];
  if (v === undefined) return 0;
  if (typeof v !== "number" || !Number.isInteger(v)) throw new Odd(`invalid type for \`${k}\``);
  return v;
}

function bool(o: Obj, k: string): boolean {
  const v = o[k];
  if (v === undefined) return false;
  if (typeof v !== "boolean") throw new Odd(`invalid type for \`${k}\``);
  return v;
}

function list<T>(o: Obj, k: string, f: (v: unknown) => T): T[] {
  const v = o[k];
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Odd(`invalid type for \`${k}\``);
  return v.map(f);
}

function strs(o: Obj, k: string): string[] {
  return list(o, k, (x) => {
    if (typeof x !== "string") throw new Odd(`invalid type for \`${k}\``);
    return x;
  });
}

/** A workspace's default name as the service made it ("Sam's workspace", worker ensurePersonal before 0.169.5),
 *  shown as "Sam's Workspace". Harbor has no way to name a workspace; any other name stays as it is. */
export function wsLabel(name: string): string {
  return name.replace(/'s workspace$/, "'s Workspace");
}

function parseWorkspace(v: unknown): AccountWorkspace {
  const o = need(v);
  return { id: str(o, "id", true), name: wsLabel(str(o, "name")), role: roleOf(str(o, "role")), personal: bool(o, "personal") };
}

function parseMember(v: unknown): AccountMember {
  const o = need(v);
  const m: AccountMember = { id: str(o, "id", true), name: str(o, "name"), email: str(o, "email"), role: roleOf(str(o, "role")) };
  const image = photoUrl(str(o, "image"));
  if (image !== "") m.image = image;
  return m;
}

/** Only an HTTPS address is a photo. */
const photoUrl = (s: string): string => (s.startsWith("https://") && s.length <= 2048 ? s : "");

function parsePc(v: unknown): AccountPc {
  const o = need(v);
  return {
    fp: str(o, "fp", true),
    id: str(o, "id"),
    name: str(o, "name"),
    addrs: strs(o, "addrs"),
    owner: str(o, "owner"),
    owner_name: str(o, "owner_name"),
    seen: int(o, "seen"),
    version: str(o, "version"),
  };
}

/** What to add after "Invited <email>" when the invitation can't reach anyone as it is. */
export function inviteNote(i: AccountInvite): string {
  if (!i.no_account) return "";
  return i.near === "" ? " · no Harbor account uses this address yet" : ` · no Harbor account uses this address: did you mean ${i.near}?`;
}

function parseInvite(v: unknown): AccountInvite {
  const o = need(v);
  return { id: str(o, "id", true), email: str(o, "email", true), at: int(o, "at"), no_account: bool(o, "no_account"), near: str(o, "near") };
}

function parsePending(v: unknown): AccountPendingInvite {
  const o = need(v);
  return {
    id: str(o, "id", true),
    ws: str(o, "ws", true),
    ws_name: wsLabel(str(o, "ws_name")),
    inviter_name: str(o, "inviter_name"),
    email: str(o, "email"),
    at: int(o, "at"),
  };
}

function parsePeer(v: unknown): AccountPc {
  const o = need(v);
  return { ...parsePc(o), via: strs(o, "via").map(wsLabel) };
}

function parseDir(v: unknown): AccountDir {
  const o = need(v);
  return {
    ...parseWorkspace(o),
    members: list(o, "members", parseMember),
    pcs: list(o, "pcs", parsePc),
    devices: strs(o, "devices"),
    invites: list(o, "invites", parseInvite),
  };
}

function parseDirectory(v: unknown): AccountDirectory {
  const o = need(v);
  return { at: int(o, "at"), workspaces: list(o, "workspaces", parseDir), peers: list(o, "peers", parsePeer) };
}

function parseUser(v: unknown): AccountUser {
  const o = need(v);
  return {
    id: str(o, "id", true),
    email: str(o, "email"),
    name: str(o, "name"),
    image: str(o, "image"),
    workspaces: list(o, "workspaces", parseWorkspace),
  };
}

/** Parses JSON text, null when it isn't valid or doesn't fit. */
function tryParse<T>(text: string | null, f: (v: unknown) => T): T | null {
  if (text === null) return null;
  try {
    const v: unknown = JSON.parse(text);
    return f(v);
  } catch {
    return null;
  }
}

/**
 * The one rule for other PCs, everywhere (Runs on, Auto, Move to PC, the sidebar's chats and projects, the workspace
 * filter, Settings › Devices, phones): this account uses a PC only when it is a member of the workspace that PC is in,
 * that is, the PC's owner invited it there and it accepted. The directory lists exactly those workspaces with their PCs.
 * It isn't symmetric: inviting someone into your workspace lets them use your PCs, not you theirs.
 */
export interface PcScope {
  /** A directory was fetched (signed in): without one nothing is filtered (rigs, tests, builds without accounts). */
  known: boolean;
  /** Keys and mesh ids of the PCs this account may use, this PC aside. */
  fps: ReadonlySet<string>;
  ids: ReadonlySet<string>;
  /** Mesh ids of every Harbor PC the directory names (usable or not): an SSH device with one of these ids is that PC. */
  harbor: ReadonlySet<string>;
}

export function pcScope(d: AccountDirectory, mine: string): PcScope {
  const fps = new Set<string>();
  const ids = new Set<string>();
  const harbor = new Set<string>();
  for (const w of d.workspaces) {
    for (const p of w.pcs) {
      if (p.id !== "") harbor.add(p.id);
      if (p.fp === "" || p.fp === mine) continue;
      fps.add(p.fp);
      if (p.id !== "") ids.add(p.id);
    }
  }
  for (const p of d.peers) if (p.id !== "") harbor.add(p.id);
  return { known: d.at > 0, fps, ids, harbor };
}

/** The PCs this account may use (`pcScope`), once each, with `via` naming the workspaces they're in; by name. */
export function usablePcs(d: AccountDirectory, mine: string): AccountPc[] {
  const out: AccountPc[] = [];
  for (const w of d.workspaces) {
    for (const p of w.pcs) {
      if (p.fp === "" || p.fp === mine) continue;
      const had = out.find((x) => x.fp === p.fp);
      if (had) had.via = [...new Set([...(had.via ?? []), w.name])];
      else out.push({ ...p, addrs: [...p.addrs], via: [w.name] });
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Whether chats homed on PC `id` ("": this PC) show here and whether it can be used. */
export function scopeHas(s: PcScope, id: string): boolean {
  return id === "" || !s.known || s.ids.has(id);
}

/** Whether a Runs on / Settings › Devices entry with this id shows: plain SSH hosts always; a Harbor PC by `scopeHas`. */
export function scopeHasDevice(s: PcScope, id: string, peer = false): boolean {
  return !(peer || s.harbor.has(id)) || scopeHas(s, id);
}

/**
 * The PCs this PC trusts, as the mesh's allowed list: those this account may use (`use` true), and those whose owner is a
 * member of this PC's workspace `ws`, so may use it (`use` false: they reach this PC, this PC doesn't follow them).
 */
function peersOf(d: AccountDirectory, mine: string, ws = ""): Allowed[] {
  const s = pcScope(d, mine);
  const members = new Set((directoryOf(d, ws)?.members ?? []).map((m) => m.id).filter((x) => x !== ""));
  const out: Allowed[] = [];
  const add = (p: AccountPc, use: boolean) => {
    if (p.fp === "" || p.fp === mine || out.some((a) => a.fp === p.fp)) return;
    out.push({ node: "", name: p.name, fp: p.fp, id: p.id, addrs: [...p.addrs], use });
  };
  for (const p of d.peers) if (s.fps.has(p.fp) || (p.owner !== "" && members.has(p.owner))) add(p, s.fps.has(p.fp));
  for (const w of d.workspaces) for (const p of w.pcs) add(p, true);
  return out;
}

/**
 * The workspace a PC lands in at sign-in: the one it's registered in, else the one it was in, else the account's
 * only one, else the account's own personal workspace (a new PC of someone also in others' workspaces goes where
 * their other PCs usually are; Settings › Workspace moves it). "": none, the person picks.
 */
export function signInWorkspace(workspaces: readonly AccountWorkspace[], registered: string | null, current: string): string {
  if (registered !== null) return registered;
  if (workspaces.some((w) => w.id === current)) return current;
  const only = workspaces.length === 1 ? workspaces[0] : undefined;
  if (only) return only.id;
  const own = workspaces.filter((w) => w.personal && w.role === "owner");
  return own.length === 1 ? (own[0]?.id ?? "") : "";
}

/** Rigs and tests: a one-workspace directory in kv, as the account loop leaves it after a sign-in, listing these PCs
 * (this PC among them or not): they are the PCs this one trusts. */
export function seedWorkspace(kv: Kv, pcs: { fp: string; addrs?: string[]; id?: string; name?: string }[], ws = "org_rig"): void {
  kv.set("account_ws", ws);
  const list = pcs.map((p) => ({ fp: p.fp, id: p.id ?? "", name: p.name ?? "", addrs: p.addrs ?? [], owner: "", owner_name: "", seen: 0, version: "" }));
  kv.set("account_dir", JSON.stringify({ at: 1, workspaces: [{ id: ws, name: "Rig", role: "owner", personal: true, members: [], pcs: list, devices: [], invites: [] }], peers: list.map((p) => ({ ...p, via: ["Rig"] })) }));
}

/** Screenshots only (HARBOR_FAKE_ACCOUNT=<json file>, ram.ts's fakePeers alike): a signed-in look from a file
 * `{account, ws, directory, phones?: [{name, account, account_name}], online?: [fp], ssh_devices?: [{id, name, host, os}],
 * peer_devices?: {fp: [{id, name, os}]}}` written into the rig's own kv (kv `account`, `account_ws`, `account_dir`, phones
 * as `api_tokens`, this PC's SSH devices as `remote_devices`); "SELF" stands for this PC's key. Returns the keys to show
 * online. Nothing is fetched or signed: the account loop doesn't run without account.json. */
export function fakeAccount(kv: Kv, path: string, mine: string): string[] {
  let v: Record<string, unknown>;
  try {
    v = need(JSON.parse(readFileSync(path, "utf8").replaceAll("SELF", mine)) as unknown);
  } catch {
    return [];
  }
  if (isObj(v.account)) kv.set("account", JSON.stringify(v.account));
  if (typeof v.ws === "string") kv.set("account_ws", v.ws);
  if (isObj(v.directory)) kv.set("account_dir", JSON.stringify(v.directory));
  const phones = Array.isArray(v.phones) ? v.phones.filter(isObj) : [];
  if (phones.length > 0) {
    const tokens = phones.map((p, i) => ({ token: `fake-${i}`, name: textOf(p, "name"), created: 0, group: `fake-${i}`, fp: createHash("sha256").update(`fake-phone-${i}`).digest("hex"), account: textOf(p, "account"), account_name: textOf(p, "account_name") }));
    kv.set("api_tokens", JSON.stringify(tokens));
  }
  const ssh = Array.isArray(v.ssh_devices) ? v.ssh_devices.filter(isObj) : [];
  if (ssh.length > 0) {
    const cfg = loadRemote(kv);
    saveRemote(kv, { ...cfg, devices: [...cfg.devices, ...ssh.map((d) => newHost({ id: textOf(d, "id"), name: textOf(d, "name"), host: textOf(d, "host"), os: textOf(d, "os") }))] });
  }
  return Array.isArray(v.online) ? v.online.filter((x): x is string => typeof x === "string") : [];
}

/** HARBOR_FAKE_ACCOUNT's `peer_devices`: the SSH devices each peer (by key) says it added, as its hello would. */
export function fakePeerDevices(path: string, mine: string): Map<string, PeerDevice[]> {
  const out = new Map<string, PeerDevice[]>();
  try {
    const v = need(JSON.parse(readFileSync(path, "utf8").replaceAll("SELF", mine)) as unknown);
    if (isObj(v.peer_devices)) for (const [fp, d] of Object.entries(v.peer_devices)) out.set(fp, peerDevices(d));
  } catch {
    // no file, or not JSON: none
  }
  return out;
}

/** This PC's workspace's PCs as last fetched (kv `account_dir`), for commands that run without the account loop (`harbor nc`). */
export function cachedMeshPeers(kv: Kv, mine: string): Allowed[] {
  const dir = tryParse(kv.get("account_dir"), parseDirectory) ?? emptyDirectory();
  return peersOf(dir, mine, kv.get("account_ws") ?? "");
}

function pending(v: unknown): AccountPendingInvite[] {
  return (Array.isArray(v) ? v : []).flatMap((i: unknown) => {
    try {
      return [parsePending(i)];
    } catch {
      return [];
    }
  });
}

function pluck(v: unknown, k: string): unknown {
  return isObj(v) ? v[k] : undefined;
}

function textOf(v: unknown, k: string): string {
  const x = pluck(v, k);
  return typeof x === "string" ? x : "";
}

/** A lenient decoder like the Rust one: `-`/`+` and `_`/`/` both, `=` skipped, anything else fails. */
export function b64urlDecode(s: string): Uint8Array | null {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let v: number;
    if (c >= 65 && c <= 90) v = c - 65;
    else if (c >= 97 && c <= 122) v = c - 97 + 26;
    else if (c >= 48 && c <= 57) v = c - 48 + 52;
    else if (c === 45 || c === 43) v = 62;
    else if (c === 95 || c === 47) v = 63;
    else if (c === 61) continue;
    else return null;
    acc = ((acc << 6) | v) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

export function b64urlEncode(data: Uint8Array | string): string {
  return Buffer.from(data).toString("base64url");
}

function jsonOf(b64: string): unknown {
  const b = b64urlDecode(b64);
  if (!b) return undefined;
  try {
    const v: unknown = JSON.parse(Buffer.from(b).toString("utf8"));
    return v;
  } catch {
    return undefined;
  }
}

const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");

function edVerify(msg: Uint8Array, sig: Uint8Array, key: Uint8Array): boolean {
  try {
    const k = createPublicKey({ key: Buffer.concat([ED25519_SPKI, key]), format: "der", type: "spki" });
    return verify(null, msg, k, sig);
  } catch {
    return false;
  }
}

function parseClaims(v: unknown): HarborClaims | null {
  try {
    const o = need(v);
    return {
      iss: str(o, "iss"),
      sub: str(o, "sub"),
      email: str(o, "email"),
      name: str(o, "name"),
      ws: strs(o, "ws"),
      dev: str(o, "dev"),
      kind: str(o, "kind"),
      iat: int(o, "iat"),
      exp: int(o, "exp"),
    };
  } catch {
    return null;
  }
}

const NOT_A_TOKEN = "not a Harbor token";

/** A Harbor token's claims, when one of `keys` signed it and it hasn't run out (`now`: unix s). */
export function verifyHarborToken(token: string, keys: readonly AccountKey[], now: number): AccountResult<HarborClaims> {
  const parts = token.split(".");
  const [h, p, s] = parts;
  if (parts.length !== 3 || h === undefined || p === undefined || s === undefined) return { ok: false, error: NOT_A_TOKEN };
  const header = jsonOf(h);
  if (pluck(header, "alg") !== "EdDSA") return { ok: false, error: NOT_A_TOKEN };
  const kid = textOf(header, "kid");
  const sig = b64urlDecode(s);
  if (!sig) return { ok: false, error: NOT_A_TOKEN };
  const signed = Buffer.from(token).subarray(0, Buffer.byteLength(h) + 1 + Buffer.byteLength(p));
  const good = keys.filter(([k]) => kid === "" || k === kid).some(([, key]) => edVerify(signed, sig, key));
  if (!good) return { ok: false, error: "the account service didn't sign this token" };
  const c = parseClaims(jsonOf(p));
  if (!c) return { ok: false, error: NOT_A_TOKEN };
  if (c.iss !== ISSUER || c.sub === "") return { ok: false, error: NOT_A_TOKEN };
  if (c.exp <= now) return { ok: false, error: "this sign-in ran out: open Harbor on the phone to sign in again" };
  return { ok: true, value: c };
}

/** The reason a valid token may not use a PC of workspace `ws`, or null: it must name it, and a directory newer than the token must still list the account and its device. */
export function accountDecide(c: HarborClaims, ws: string, dir: AccountDirectory): string | null {
  if (ws === "") return "this PC isn't in a workspace: sign in on it first";
  if (!c.ws.includes(ws)) return "this PC belongs to a workspace you aren't in: ask its owner to invite you";
  const d = directoryOf(dir, ws);
  if (d && dir.at > c.iat * 1000) {
    if (!d.members.some((m) => m.id === c.sub)) return "you were removed from this PC's workspace";
    if (!d.devices.includes(c.dev)) return "this device was signed out of the account";
  }
  return null;
}

/** Looks like a Harbor token (a JWT), not an old pairing token (hex). */
export function isHarborToken(s: string): boolean {
  return s.startsWith("eyJ") && s.split(".").length === 3;
}

/** Why a call to Clerk or the service failed. */
export class AccountFail extends Error {
  constructor(
    readonly kind: "expired" | "refused" | "offline",
    /** The service's sentence (refused) or the transport's (offline). */
    readonly detail: string,
    /** The service's JSON answer, for a refusal. */
    readonly body: unknown = null,
    /** The HTTP status of a refusal (0: none). */
    readonly code = 0,
  ) {
    super(detail);
  }

  static expired(): AccountFail {
    return new AccountFail("expired", "");
  }

  static refused(detail: string, body: unknown = null, code = 0): AccountFail {
    return new AccountFail("refused", detail, body, code);
  }

  static offline(detail: string): AccountFail {
    return new AccountFail("offline", detail);
  }

  text(): string {
    switch (this.kind) {
      case "expired":
        return "Your sign-in ran out: sign in again.";
      case "refused":
        return this.detail;
      case "offline":
        return `The account service didn't answer (${this.detail}).`;
    }
  }
}

function asFail(e: unknown): AccountFail {
  return e instanceof AccountFail ? e : AccountFail.offline(e instanceof Error ? e.message : String(e));
}

function unreserved(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45 || c === 46 || c === 95 || c === 126;
}

function enc(s: string): string {
  let out = "";
  for (const b of Buffer.from(s)) out += unreserved(b) ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  return out;
}

/** application/x-www-form-urlencoded, leaving out the empty values. */
function form(pairs: [string, string][]): string {
  return pairs
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${enc(k)}=${enc(v)}`)
    .join("&");
}

function dec(s: string): string {
  const b = Buffer.from(s);
  const out: number[] = [];
  for (let i = 0; i < b.length; i++) {
    const c = b[i] ?? 0;
    if (c === 0x2b) out.push(0x20);
    else if (c === 0x25 && i + 2 < b.length) {
      const hex = b.subarray(i + 1, i + 3).toString("latin1");
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
      } else out.push(c);
    } else out.push(c);
  }
  return Buffer.from(out).toString("utf8");
}

function callbackPage(ok: boolean, error: string): string {
  const esc = (t: string) => t.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const title = ok ? "You're signed in" : "Sign-in didn't finish";
  const line = ok ? "Harbor is back in front. You can close this tab." : error === "" ? "Go back to Harbor and try again." : `${esc(error)}. Go back to Harbor and try again.`;
  const mark = ok ? "&#10003;" : "!";
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Harbor</title>
<style>
:root{--bg:#fafafa;--card:#fff;--fg:#171717;--sub:#737373;--border:#e5e5e5;--mark:${ok ? "#0070f3" : "#e5484d"};--markfg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0a0a0a;--card:#171717;--fg:#ededed;--sub:#a1a1a1;--border:#2e2e2e;--markfg:#0a0a0a}}
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--fg);font:14px/1.5 Geist,"Geist Sans",Inter,system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;align-items:center;justify-content:center}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:32px 36px;max-width:380px;width:calc(100% - 32px);text-align:center;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.mark{width:40px;height:40px;border-radius:999px;background:var(--mark);color:var(--markfg);display:inline-flex;align-items:center;justify-content:center;font-size:20px;font-weight:600}
.brand{font-weight:600;letter-spacing:-.01em;color:var(--sub);margin:14px 0 2px}
h1{font-size:20px;letter-spacing:-.02em;margin:0 0 6px}p{margin:0;color:var(--sub)}
</style>
<div class="card"><div class="mark">${mark}</div><div class="brand">Harbor</div><h1>${title}</h1><p>${line}</p></div>
<script>setTimeout(function(){window.close()},${ok ? 600 : 600000})</script>
</html>`;
}

/** What the desktop's settings sync (settingsync.rs, @harbor/store) gives the account loop. */
export interface AccountSettingsSync {
  /** The cached state, at start. */
  load(): void;
  /** The sign-in just completed: before the account is published. */
  signedIn(): void;
  /** One turn of the sync: `pull` asks the account for newer values too. Throws `AccountFail`. Uses `AccountService.settingsCall`. */
  sync(token: string, pull: boolean): Promise<void>;
}

export interface AccountOptions {
  kv: Kv;
  /** Where `account.json` lives (the private state directory). */
  stateDir: string;
  /** This PC's TLS identity (throws when it has none). */
  identity: () => Identity;
  /** This PC in the mesh: its id and name. */
  me: () => Me;
  /** This PC's addresses as peers should try them ("host:port"). */
  addrs: () => string[];
  /** The Harbor version sent to the service. */
  version: string;
  hostname?: (() => string) | undefined;
  /** Opens the sign-in URL in the browser. */
  open?: ((url: string) => void) | undefined;
  /** Brings Harbor's window back in front after the browser's callback. */
  focus?: (() => void) | undefined;
  /** Called when anything the desktop shows changed. */
  onChange?: (() => void) | undefined;
  settings?: AccountSettingsSync | undefined;
  /** The account vault (vault.ts): synced on each turn of the loop while signed in, handed back on a sign-out. */
  vault?: Vault | undefined;
  /** The workspace cloud (chatcloud.ts): this PC's chats and projects up, the workspaces' down; a round each turn, never waited for. */
  cloud?: ChatCloud | undefined;
  /** Tests: how long a turn waits for the vault's round (VAULT_WAIT). */
  vaultWaitMs?: number | undefined;
  env?: Record<string, string | undefined> | undefined;
  /** Keys shipped in this build; defaults to `ACCOUNT_KEYS`. */
  keys?: readonly (readonly [string, string])[] | undefined;
  /** Milliseconds since the epoch. */
  clock?: (() => number) | undefined;
  /** How long a sign-in waits for the browser. */
  signInTimeoutMs?: number | undefined;
  /** The loop's longest sleep. */
  loopMs?: number | undefined;
  /** The pause after a setting changed, before it goes to the account. */
  syncPauseMs?: number | undefined;
  /** Listen to the service's pushes (GET /v1/events); false: polls alone (tests). Default true. */
  events?: boolean | undefined;
}

interface Secrets {
  access: string;
  refresh: string;
  access_exp: number;
  token: string;
  token_exp: number;
  token_at: number;
}

const noSecrets = (): Secrets => ({ access: "", refresh: "", access_exp: 0, token: "", token_exp: 0, token_at: 0 });

interface Timers {
  keys: number | null;
  dir: number | null;
  inv: number | null;
  pc: number | null;
  pull: number | null;
  addrs: string[];
  /** The name this PC was last registered under: a rename registers again at once. */
  name: string;
}

const freshTimers = (keys: number | null = null): Timers => ({ keys, dir: null, inv: null, pc: null, pull: null, addrs: [], name: "" });

interface Session {
  account: AccountUser;
  token: string;
  exp: number;
  /** This PC's workspace as the service has it, and whether this account is a member of it. */
  pc: { ws: string; wsName: string; owner: string; member: boolean } | null;
  invites: AccountPendingInvite[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class AccountService {
  private readonly o: AccountOptions;
  private acct: AccountUser | null = null;
  private ws = "";
  private dir: AccountDirectory = emptyDirectory();
  private scoped: { dir: AccountDirectory; fp: string; s: PcScope } | null = null;
  private peersMemo: { dir: AccountDirectory; fp: string; ws: string; v: Allowed[] } | null = null;
  private pendingInvites: AccountPendingInvite[] = [];
  /** Invitations accepted or declined here: id → when (they go from the list at once, before the service answers). */
  private answered = new Map<string, number>();
  /** Counts the actions that changed the account (an accept, a removal): a fetch begun before one is stale. */
  private acted = 0;
  private listeners = new Set<() => void>();
  private soonAt = 0;
  /** The push socket (GET /v1/events): open, or being opened; null between tries. */
  private sock: WebSocket | null = null;
  private pushing = false;
  private sockAt = 0;
  private sockWait = 1000;
  private sockSeq = -1;
  private sockPing: ReturnType<typeof setInterval> | null = null;
  /** A push came: the loop runs a turn now, also if it was in the middle of one when it came. */
  private pushed = false;
  private fetchedKeys: AccountKey[] = [];
  /** The vault changed on another PC (a push): its round runs this turn. */
  private vaultDue = true;
  private vaultAt = 0;
  private st: AccountStatus = {
    signingIn: false,
    url: "",
    error: "",
    expired: false,
    offlineSince: 0,
    pick: false,
    syncedAt: 0,
    busy: false,
    notice: "",
  };
  private cancelled = false;
  private cancelNow: (() => void) | null = null;
  private renew = false;
  private enable = false;
  private pokeLevel = 0;
  private pokeWake: (() => void) | null = null;
  private timers: Timers = freshTimers();
  private stopped = false;
  private loop: Promise<void> | null = null;

  constructor(options: AccountOptions) {
    this.o = options;
  }

  private env(name: string): string | undefined {
    return (this.o.env ?? process.env)[name];
  }

  private conf(name: string, fallback: string): string {
    const v = (this.env(name) ?? "").trim().replace(/\/+$/, "");
    return v !== "" ? v : fallback;
  }

  clerkUrl(): string {
    return this.conf("HARBOR_CLERK_URL", CLERK_URL);
  }

  clientId(): string {
    return this.conf("HARBOR_CLERK_CLIENT_ID", ACCOUNT_CLIENT_ID);
  }

  serviceUrl(): string {
    return this.conf("HARBOR_ACCOUNTS_URL", ACCOUNTS_URL);
  }

  /** This build talks to a real account service (not the placeholders): only then does the desktop ask to sign in first. */
  configured(): boolean {
    return !this.clerkUrl().includes("harbor.example") && !this.serviceUrl().includes("harbor.example");
  }

  private nowMs(): number {
    return (this.o.clock ?? Date.now)();
  }

  private nowSec(): number {
    return Math.floor(this.nowMs() / 1000);
  }

  private log(what: () => string): void {
    if (this.env("HARBOR_ACCOUNT_LOG") === "1") process.stderr.write(`account: ${what()}\n`);
  }

  private hostname(): string {
    if (this.o.hostname) return this.o.hostname();
    try {
      return readFileSync("/etc/hostname", "utf8").trim() || "this PC";
    } catch {
      return "this PC";
    }
  }

  private myFp(): string {
    try {
      return this.o.identity().fp;
    } catch {
      return "";
    }
  }

  private changed(): void {
    this.o.onChange?.();
    for (const f of [...this.listeners]) {
      try {
        f();
      } catch (e) {
        this.log(() => `a listener failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** Calls `f` whenever anything the desktop shows changed (Settings, the invitation toast); returns the unsubscribe. */
  subscribe(f: () => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  private setStatus(f: (s: AccountStatus) => void): void {
    f(this.st);
    this.changed();
  }

  status(): AccountStatus {
    return { ...this.st };
  }

  account(): AccountUser | null {
    return this.acct;
  }

  signedIn(): boolean {
    return this.acct !== null;
  }

  /** The workspaces of whoever is signed in here (none while nobody is). */
  workspaces(): AccountWorkspace[] {
    return this.acct?.workspaces ?? [];
  }

  /** This PC's workspace id ("" when it's in none). */
  workspace(): string {
    return this.ws;
  }

  directory(): AccountDirectory {
    return this.dir;
  }

  /** Invitations waiting for this account. */
  invites(): AccountPendingInvite[] {
    if (!this.acct) return [];
    const t = this.nowMs();
    for (const [id, at] of this.answered) if (t - at > ANSWERED_MS) this.answered.delete(id);
    return this.pendingInvites.filter((i) => !this.answered.has(i.id));
  }

  /** This PC's workspace as the directory has it. */
  myDir(): AccountDir | undefined {
    return directoryOf(this.dir, this.ws);
  }

  /** The desktop shows only the sign-in page: nobody signed in on a configured build. */
  gate(): boolean {
    return this.configured() && !this.signedIn() && this.env("HARBOR_TEST_NO_SIGNIN") !== "1";
  }

  /** The other PCs of this PC's workspace, as entries of the mesh's allowed list: they link with this one without pairing. */
  meshPeers(): Allowed[] {
    // Asked on every mesh request: worked out again only when the directory, the key or the workspace changed.
    const fp = this.myFp();
    const m = this.peersMemo;
    if (m?.dir === this.dir && m.fp === fp && m.ws === this.ws) return m.v;
    const v = peersOf(this.dir, fp, this.ws);
    this.peersMemo = { dir: this.dir, fp, ws: this.ws, v };
    return v;
  }

  /** Which other PCs this account uses (`pcScope`): the one rule every list of PCs, chats and projects goes through. */
  scope(): PcScope {
    const fp = this.myFp();
    if (this.scoped?.dir !== this.dir || this.scoped.fp !== fp) this.scoped = { dir: this.dir, fp, s: pcScope(this.dir, fp) };
    return this.scoped.s;
  }

  /** A key this PC's workspace knows (a PC or a member's device): it may complete a TLS handshake from the internet. */
  knownDevice(fp: string): boolean {
    const d = this.myDir();
    return this.dir.peers.some((p) => p.fp === fp) || (d !== undefined && (d.devices.includes(fp) || d.pcs.some((p) => p.fp === fp)));
  }

  /** The owner name this PC says it has: the signed-in account's. */
  ownerName(): string | null {
    const a = this.acct;
    if (!a) return null;
    const n = a.name !== "" ? a.name : a.email;
    return n !== "" ? n : null;
  }

  /** The desktop should turn phones and PC sharing on (a sign-in just completed). */
  takeEnable(): boolean {
    const e = this.enable;
    this.enable = false;
    return e;
  }

  /** A notice for the desktop's toast, once. */
  takeNotice(): string | null {
    if (this.st.notice === "") return null;
    const n = this.st.notice;
    this.st.notice = "";
    return n;
  }

  /** The keys tokens may be signed with: `HARBOR_ACCOUNTS_KEYS` (tests), else the shipped ones, else the fetched ones. */
  keys(): AccountKey[] {
    const parse = (l: [string, string][]): AccountKey[] =>
      l.flatMap(([k, x]) => {
        const b = b64urlDecode(x);
        return b && b.length === 32 ? [[k, b] as const] : [];
      });
    const fromEnv = this.env("HARBOR_ACCOUNTS_KEYS");
    if (fromEnv !== undefined) {
      return parse(
        fromEnv.split(",").flatMap((e): [string, string][] => {
          const t = e.trim();
          const i = t.indexOf(":");
          return i < 0 ? [] : [[t.slice(0, i), t.slice(i + 1)]];
        }),
      );
    }
    const shipped = this.o.keys ?? ACCOUNT_KEYS;
    if (shipped.length > 0) return parse(shipped.map(([k, x]): [string, string] => [k, x]));
    return this.fetchedKeys;
  }

  /** A phone's call with Harbor token `token` over a TLS connection with client key `fp`: the claims, or why not. */
  admit(token: string, fp: string): AccountResult<HarborClaims> {
    const r = verifyHarborToken(token, this.keys(), this.nowSec());
    if (!r.ok) return r;
    const c = r.value;
    if (c.kind !== "phone") return { ok: false, error: "not a phone's sign-in" };
    if (c.dev !== fp) return { ok: false, error: "this sign-in belongs to another device" };
    const why = accountDecide(c, this.ws, this.dir);
    return why === null ? r : { ok: false, error: why };
  }

  private async call(method: string, url: string, bearer: string | null, body: { type: string; data: string } | null): Promise<{ code: number; body: unknown }> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (bearer !== null) headers.Authorization = `Bearer ${bearer}`;
    if (body) headers["Content-Type"] = body.type;
    let text: string;
    let code: number;
    try {
      const res = await fetch(url, { method, headers, ...(body ? { body: body.data } : {}), redirect: "manual", signal: AbortSignal.timeout(HTTP_TIMEOUT) });
      code = res.status;
      text = await res.text();
    } catch (e) {
      throw AccountFail.offline((e instanceof Error ? e.message : String(e)).slice(0, 200));
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text.slice(0, 300);
    }
    return { code, body: parsed };
  }

  private async service(method: string, path: string, bearer: string, body?: Json): Promise<unknown> {
    const data = body === undefined ? null : { type: "application/json", data: wire(body) };
    const { code, body: v } = await this.call(method, `${this.serviceUrl()}${path}`, bearer, data);
    if (code >= 200 && code <= 299) return v;
    if (code === 401) throw AccountFail.expired();
    if (code >= 500) throw AccountFail.offline(`HTTP ${code}`);
    const e = pluck(v, "error");
    throw AccountFail.refused(typeof e === "string" ? e : `The account service refused (${code}).`, v, code);
  }

  /** What api.ts needs: the token check per request and the known keys. */
  phoneAuth(): AccountApi {
    return {
      isToken: isHarborToken,
      admit: (t, fp) => {
        const r = this.admit(t, fp);
        if (!r.ok) throw new Error(r.error);
        return r.value;
      },
      knownDevice: (fp) => this.knownDevice(fp),
    };
  }

  /** `GET`/`PUT /v1/settings` for the settings sync. */
  settingsCall(token: string, body?: Json): Promise<unknown> {
    return body === undefined ? this.service("GET", "/v1/settings", token) : this.service("PUT", "/v1/settings", token, body);
  }

  private secretsPath(): string {
    return join(this.o.stateDir, "account.json");
  }

  private loadSecrets(): Secrets {
    try {
      const o = need(JSON.parse(readFileSync(this.secretsPath(), "utf8")) as unknown);
      return { access: str(o, "access"), refresh: str(o, "refresh"), access_exp: int(o, "access_exp"), token: str(o, "token"), token_exp: int(o, "token_exp"), token_at: int(o, "token_at") };
    } catch {
      return noSecrets();
    }
  }

  private saveSecrets(s: Secrets): void {
    try {
      mkdirSync(this.o.stateDir, { recursive: true, mode: 0o700 });
      chmodSync(this.o.stateDir, 0o700);
      const path = this.secretsPath();
      const tmp = join(this.o.stateDir, "account.tmp");
      writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, path);
    } catch (e) {
      process.stderr.write(`harbor: couldn't save the sign-in: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }

  /** This PC's Harbor token for the account worker's own calls (follow-main's push nudge), if signed in. */
  bearer(): string | null {
    return this.harborToken();
  }

  /** The Harbor token this PC has now (for the account service and Settings), if any. */
  private harborToken(): string | null {
    const s = this.loadSecrets();
    return s.token !== "" && s.token_exp > this.nowSec() ? s.token : null;
  }

  private tokenReply(s: Secrets, status: number, t: unknown): void {
    const access = textOf(t, "access_token");
    if (status === 400 || status === 401) throw AccountFail.expired();
    if (status < 200 || status >= 300 || access === "") throw AccountFail.offline(`Clerk answered ${status}`);
    s.access = access;
    const r = textOf(t, "refresh_token");
    if (r !== "") s.refresh = r;
    const exp = pluck(t, "expires_in");
    s.access_exp = this.nowSec() + (typeof exp === "number" && Number.isInteger(exp) ? exp : 3600);
  }

  private async clerkToken(body: string): Promise<{ code: number; body: unknown }> {
    return this.call("POST", `${this.clerkUrl()}/oauth/token`, null, { type: "application/x-www-form-urlencoded", data: body });
  }

  /** A Clerk access token good for a while yet: refreshed when it's about to run out. */
  private async freshAccess(s: Secrets): Promise<string> {
    if (s.access !== "" && s.access_exp - this.nowSec() > 300) return s.access;
    if (s.refresh === "") throw AccountFail.expired();
    const r = await this.clerkToken(
      form([
        ["grant_type", "refresh_token"],
        ["refresh_token", s.refresh],
        ["client_id", this.clientId()],
      ]),
    );
    this.tokenReply(s, r.code, r.body);
    this.saveSecrets(s);
    return s.access;
  }

  /** The proof that this PC holds its TLS key: a signature over the time and the access token's hash. */
  private deviceProof(access: string): Record<string, Json> {
    let id: Identity;
    try {
      id = this.o.identity();
    } catch (e) {
      throw AccountFail.refused(`This PC has no key: ${e instanceof Error ? e.message : String(e)}`);
    }
    const ts = this.nowSec();
    const msg = `harbor-device-v1\n${ts}\n${sha256Hex(access)}`;
    let sig: Uint8Array;
    let spki: Uint8Array;
    try {
      sig = signWith(id, msg);
    } catch {
      throw AccountFail.refused("This PC couldn't sign with its key.");
    }
    try {
      spki = spkiOf(id);
    } catch {
      throw AccountFail.refused("This PC's key is unreadable.");
    }
    return { kind: "pc", name: this.hostname(), spki: Buffer.from(spki).toString("base64"), ts, sig: Buffer.from(sig).toString("base64") };
  }

  private async session(access: string): Promise<Session> {
    const body = { device: this.deviceProof(access), app: this.o.version };
    const v = await this.service("POST", "/v1/session", access, body);
    const a = pluck(v, "account");
    const workspaces = (Array.isArray(pluck(v, "workspaces")) ? (pluck(v, "workspaces") as unknown[]) : []).flatMap((w) => {
      try {
        return [parseWorkspace(w)];
      } catch {
        return [];
      }
    });
    const account: AccountUser = { id: textOf(a, "id"), email: textOf(a, "email"), name: textOf(a, "name"), image: textOf(a, "image"), workspaces };
    const token = textOf(v, "token");
    if (account.id === "" || token === "") throw AccountFail.offline("an answer without an account");
    const p = pluck(v, "pc");
    const pc = isObj(p) ? { ws: textOf(p, "ws"), wsName: textOf(p, "ws_name"), owner: textOf(p, "owner"), member: p.member === true } : null;
    const exp = pluck(v, "exp");
    return { account, token, exp: typeof exp === "number" && Number.isInteger(exp) ? exp : this.nowSec() + 7 * 86400, pc, invites: pending(pluck(v, "invites")) };
  }

  /** `POST /v1/pcs`: this PC's entry in its workspace's directory (also Option A's check). */
  private async register(token: string, ws: string): Promise<void> {
    const me = this.o.me();
    const name = me.name === "" ? this.hostname() : me.name;
    const addrs = this.o.addrs().slice(0, 16);
    try {
      await this.service("POST", "/v1/pcs", token, { ws, id: me.id, name, addrs, version: this.o.version });
    } catch (e) {
      const f = asFail(e);
      // Someone else's PC (Option A): this account doesn't get it.
      if (f.kind === "refused" && typeof pluck(f.body, "ws") === "string") this.setStatus((s) => (s.error = f.detail));
      throw f;
    }
  }

  private async fetchDirectory(token: string): Promise<void> {
    const acted = this.acted;
    const v = await this.service("GET", "/v1/directory", token);
    // An action ended while this was on its way: what it fetched after is newer than this answer.
    if (acted !== this.acted) return;
    let dir: AccountDirectory;
    try {
      dir = parseDirectory(v);
    } catch (e) {
      throw AccountFail.offline(`an odd directory: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.o.kv.set("account_dir", JSON.stringify(dir));
    const a = this.acct;
    if (a) {
      // Workspaces joined or left since the token: a new one names them.
      const ids = dir.workspaces.map((d) => d.id);
      if (ids.length !== a.workspaces.length || a.workspaces.some((w) => !ids.includes(w.id))) this.renew = true;
      a.workspaces = dir.workspaces.map(({ id, name, role, personal }) => ({ id, name, role, personal }));
      this.o.kv.set("account", JSON.stringify(a));
    }
    // This PC's workspace is gone (it was removed, or this account left it): out of it.
    if (this.ws !== "" && !directoryOf(dir, this.ws) && this.acct) {
      this.ws = "";
      this.o.kv.set("account_ws", "");
      this.st.pick = (this.acct?.workspaces.length ?? 0) > 1;
    }
    this.dir = dir;
    this.st.syncedAt = this.nowSec();
    this.changed();
  }

  private async fetchInvites(token: string): Promise<void> {
    const acted = this.acted;
    const v = await this.service("GET", "/v1/invites", token);
    if (acted !== this.acted) return;
    const next = pending(pluck(v, "invites"));
    if (JSON.stringify(next) !== JSON.stringify(this.pendingInvites)) {
      this.pendingInvites = next;
      this.changed();
    }
  }

  private async fetchKeys(): Promise<void> {
    if ((this.o.keys ?? ACCOUNT_KEYS).length > 0 || this.env("HARBOR_ACCOUNTS_KEYS") !== undefined) return;
    let r: { code: number; body: unknown };
    try {
      r = await this.call("GET", `${this.serviceUrl()}/v1/keys`, null, null);
    } catch {
      return;
    }
    if (r.code !== 200) return;
    const raw = pluck(r.body, "keys");
    const keys = (Array.isArray(raw) ? raw : []).flatMap((k: unknown): [string, string][] => {
      const kid = pluck(k, "kid");
      const x = pluck(k, "x");
      return pluck(k, "alg") === "EdDSA" && typeof kid === "string" && typeof x === "string" ? [[kid, x]] : [];
    });
    if (keys.length === 0) return;
    this.o.kv.set("account_keys", JSON.stringify(keys));
    this.fetchedKeys = this.decodeKeys(keys);
  }

  private decodeKeys(keys: [string, string][]): AccountKey[] {
    return keys.flatMap(([k, x]) => {
      const b = b64urlDecode(x);
      return b && b.length === 32 ? [[k, b] as const] : [];
    });
  }

  /** Signs in with Google in the browser; Settings and the sign-in page show `status()`. A sign-in already waiting is left alone. */
  async signIn(): Promise<void> {
    if (this.st.signingIn) return;
    this.st.signingIn = true;
    this.st.error = "";
    this.st.url = "";
    this.cancelled = false;
    this.changed();
    let error: string | null = null;
    try {
      await this.signInFlow();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    this.setStatus((s) => {
      s.signingIn = false;
      s.url = "";
      if (error === null) {
        s.error = "";
        s.expired = false;
      } else s.error = error;
    });
    this.poke();
  }

  cancelSignIn(): void {
    this.cancelled = true;
    this.cancelNow?.();
  }

  /** The whole sign-in; throws an Error with the sentence to show. Also what `harbor account login` runs. */
  async signInFlow(): Promise<void> {
    if (!this.configured() && this.env("HARBOR_CLERK_URL") === undefined) throw new Error("This build of Harbor has no account service set up.");
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const addr = server.address();
      if (addr === null || typeof addr === "string") throw new Error("no loopback port");
      const redirect = `http://127.0.0.1:${addr.port}/callback`;
      const verifier = b64urlEncode(randomBytes(32));
      const challenge = b64urlEncode(createHash("sha256").update(verifier).digest());
      const state = b64urlEncode(randomBytes(16));
      const q = form([
        ["response_type", "code"],
        ["client_id", this.clientId()],
        ["redirect_uri", redirect],
        ["scope", SCOPE],
        ["code_challenge", challenge],
        ["code_challenge_method", "S256"],
        ["state", state],
        // Signing in again (another Google account) shows the account chooser, not the last one.
        ["prompt", "login"],
      ]);
      const url = `${this.clerkUrl()}/oauth/authorize?${q}`;
      const waiting = this.waitCallback(server, "/callback", state);
      waiting.catch(() => {});
      this.openUrl(url);
      this.setStatus((s) => (s.url = url));
      const code = await waiting;
      await this.finishSignIn(code, redirect, verifier);
    } finally {
      server.close();
      server.closeAllConnections();
    }
  }

  private openUrl(url: string): void {
    if (this.o.open) {
      this.o.open(url);
      return;
    }
    // Without an opener the URL is still in the status, to open by hand.
    desktop.open(url);
  }

  private async finishSignIn(code: string, redirect: string, verifier: string): Promise<void> {
    const body = form([
      ["grant_type", "authorization_code"],
      ["code", code],
      ["redirect_uri", redirect],
      ["client_id", this.clientId()],
      ["code_verifier", verifier],
    ]);
    const sec = noSecrets();
    let t: { code: number; body: unknown };
    try {
      t = await this.clerkToken(body);
    } catch (e) {
      throw new Error(asFail(e).detail);
    }
    try {
      this.tokenReply(sec, t.code, t.body);
    } catch (e) {
      const f = asFail(e);
      if (f.kind === "expired") {
        const why = textOf(t.body, "error_description") || textOf(t.body, "error");
        throw new Error(`Clerk refused the sign-in: ${why}`);
      }
      throw new Error(f.text());
    }
    let s: Session;
    try {
      s = await this.session(sec.access);
    } catch (e) {
      throw new Error(asFail(e).text());
    }
    // Option A: someone else's PC stays theirs.
    if (s.pc && !s.pc.member) {
      const whose = s.pc.owner === "" ? `“${s.pc.wsName}”` : `“${s.pc.wsName}” (${s.pc.owner})`;
      throw new Error(`This PC belongs to ${whose}. Signing in here gives you nothing without an invite: ask its owner to invite ${s.account.email === "" ? "you" : s.account.email}, then sign in again.`);
    }
    sec.token = s.token;
    sec.token_exp = s.exp;
    sec.token_at = this.nowSec();
    this.saveSecrets(sec);
    const ws = signInWorkspace(s.account.workspaces, s.pc?.ws ?? null, this.ws);
    const pick = ws === "" && s.account.workspaces.length > 1;
    // Everything before the account is published: a running Harbor takes over from there.
    this.o.settings?.signedIn();
    if (ws !== "") await this.register(sec.token, ws).catch(() => {});
    this.setAccount(s.account, ws);
    this.setStatus((st) => (st.pick = pick));
    this.pendingInvites = s.invites;
    this.enable = true;
  }

  /** Waits for the browser's `GET <want>?code&state` on the loopback listener. */
  private waitCallback(server: Server, want: string, state: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let over = false;
      const end = (f: () => void) => {
        if (over) return;
        over = true;
        clearTimeout(timer);
        this.cancelNow = null;
        f();
      };
      const timer = setTimeout(() => end(() => reject(new Error("Sign-in timed out."))), this.o.signInTimeoutMs ?? 600_000);
      this.cancelNow = () => end(() => reject(new Error("Sign-in was cancelled.")));
      if (this.cancelled) this.cancelNow();
      server.on("request", (req, res) => {
        const target = req.url ?? "";
        const i = target.indexOf("?");
        if (i < 0) {
          res.writeHead(404, { "Content-Length": "0", Connection: "close" });
          res.end();
          return;
        }
        if (target.slice(0, i) !== want) {
          req.socket.destroy();
          return;
        }
        const params = new Map<string, string>();
        for (const kv of target.slice(i + 1).split("&")) {
          const j = kv.indexOf("=");
          if (j >= 0) params.set(dec(kv.slice(0, j)), dec(kv.slice(j + 1)));
        }
        const ok = params.get("state") === state && params.has("code");
        const why = params.get("error_description") ?? params.get("error") ?? "";
        const html = callbackPage(ok, why);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": String(Buffer.byteLength(html)), Connection: "close" });
        res.end(html);
        this.o.focus?.();
        if (ok) end(() => resolve(params.get("code") ?? ""));
        else end(() => reject(new Error(`Sign-in failed: ${why === "" ? "state mismatch" : why}`)));
      });
    });
  }

  /** Saves who is signed in (null: signed out) and this PC's workspace (null: unchanged). */
  private setAccount(a: AccountUser | null, ws: string | null): void {
    const kv = this.o.kv;
    // The workspace first: whoever reads kv never sees an account without it.
    if (ws !== null) kv.set("account_ws", ws);
    kv.set("account", a ? JSON.stringify(a) : "");
    this.acct = a;
    if (ws !== null) {
      if (ws !== this.ws) {
        this.dir = emptyDirectory();
        kv.set("account_dir", "");
      }
      this.ws = ws;
    }
    this.changed();
  }

  /** Signs this PC out: Clerk's tokens go. The PC stays in its workspace and keeps serving its members with what it has cached (Option A: only a member takes it out). */
  signOut(): void {
    // The vault takes what changed here and this PC's copies go (it holds the token it was last given).
    void this.o.vault?.leave();
    this.o.cloud?.leave();
    rmSync(this.secretsPath(), { force: true });
    this.hangUp();
    this.setAccount(null, null);
    this.setStatus((s) => {
      s.expired = false;
      s.pick = false;
      s.error = "";
    });
  }

  /** An action on the account service; then the directory is fetched again. Never rejects: the outcome is in `status()`. */
  private async runAction(f: (token: string) => Promise<void>): Promise<void> {
    this.setStatus((s) => {
      s.busy = true;
      s.error = "";
    });
    let failure: AccountFail | null = null;
    const token = this.harborToken();
    try {
      if (token === null) throw AccountFail.expired();
      await f(token);
    } catch (e) {
      failure = asFail(e);
    }
    this.acted++;
    this.setStatus((s) => {
      s.busy = false;
      if (failure?.kind === "expired") s.expired = true;
      else if (failure) s.error = failure.text();
    });
    const t = this.harborToken();
    if (t !== null) {
      await this.fetchDirectory(t).catch(() => {});
      await this.fetchInvites(t).catch(() => {});
    }
    this.poke();
  }

  /** Puts this PC in workspace `ws` (Settings › Account, the picker after sign-in). */
  chooseWorkspace(ws: string): Promise<void> {
    return this.runAction(async (token) => {
      await this.register(token, ws);
      this.setAccount(this.acct, ws);
      this.setStatus((s) => (s.pick = false));
    });
  }

  invite(ws: string, email: string): Promise<void> {
    return this.runAction(async (token) => {
      await this.service("POST", `/v1/workspaces/${encodeURIComponent(ws)}/invites`, token, { email: email.trim() });
      // No email goes out: the invitation waits in their Harbor.
      const note = `Invited ${email.trim()}: they'll see it in Harbor when they sign in with that Google account.`;
      this.setStatus((s) => (s.notice = note));
    });
  }

  /** Accepts an invitation made to this account: it joins that workspace (the PC stays in its own; Settings › Account moves it). */
  acceptInvite(id: string): Promise<void> {
    return this.answerInvite(id, true);
  }

  declineInvite(id: string): Promise<void> {
    return this.answerInvite(id, false);
  }

  private answerInvite(id: string, accept: boolean): Promise<void> {
    // Gone from Settings and the toast at once; back only if the service refuses.
    this.answered.set(id, this.nowMs());
    this.changed();
    return this.runAction(async (token) => {
      let v: unknown;
      try {
        v = await this.service("POST", `/v1/invites/${encodeURIComponent(id)}/${accept ? "accept" : "decline"}`, token);
      } catch (e) {
        // Already answered (here or on another device): it stays gone.
        if (asFail(e).code !== 404) this.answered.delete(id);
        throw e;
      }
      this.pendingInvites = this.pendingInvites.filter((i) => i.id !== id);
      // The workspaces as they are now: the workspace filter and Move to workspace… have the new one at once.
      const ws = pluck(v, "workspaces");
      const a = this.acct;
      if (a && Array.isArray(ws) && ws.length > 0) {
        a.workspaces = ws.flatMap((w) => {
          try {
            return [parseWorkspace(w)];
          } catch {
            return [];
          }
        });
        this.o.kv.set("account", JSON.stringify(a));
      }
      const name = wsLabel(textOf(pluck(v, "joined"), "name"));
      if (name !== "") {
        const note = `You joined ${name}. Its PCs and chats reach you on your phone; to move this PC there, use Settings › Account.`;
        this.setStatus((s) => (s.notice = note));
      }
      // A token that names the new workspace.
      this.renew = true;
    });
  }

  cancelInvite(ws: string, id: string): Promise<void> {
    return this.runAction(async (token) => {
      await this.service("DELETE", `/v1/workspaces/${encodeURIComponent(ws)}/invites/${encodeURIComponent(id)}`, token);
    });
  }

  /** Removes a member (an owner), or the account itself from a workspace it was invited to. */
  removeMember(ws: string, user: string): Promise<void> {
    return this.runAction(async (token) => {
      await this.service("DELETE", `/v1/workspaces/${encodeURIComponent(ws)}/members/${encodeURIComponent(user)}`, token);
      this.renew = true;
    });
  }

  /** Signs a device of the account out (a lost phone): PCs refuse its token once their directory no longer lists it. */
  removeDevice(fp: string): Promise<void> {
    return this.runAction(async (token) => {
      await this.service("DELETE", `/v1/devices/${encodeURIComponent(fp)}`, token);
    });
  }

  /** Wakes the loop now (a sign-in, an action in Settings): everything is fetched again. */
  poke(): void {
    this.pokeLevel = 2;
    this.pokeWake?.();
  }

  /** Whether the service's pushes reach this PC now (the socket is open). */
  listening(): boolean {
    return this.pushing;
  }

  /**
   * Keeps the push socket open (GET /v1/events): the service says "invites" or "directory" changed the moment an
   * invitation is made, answered or cancelled, or a workspace gains or loses a member or a PC, and this PC fetches it
   * at once. On every connect it fetches both (what it missed). Reconnects back off up to EVENTS_BACKOFF_MAX.
   */
  private listen(token: string): void {
    if (this.o.events === false || this.stopped || this.sock !== null) return;
    if (this.nowMs() - this.sockAt < this.sockWait) return;
    this.sockAt = this.nowMs();
    const url = `${this.serviceUrl().replace(/^http/, "ws")}/v1/events`;
    let ws: WebSocket;
    try {
      // Bun takes headers here (a browser can't): the token never goes in the URL.
      // The User-Agent Bun's fetch sends: Cloudflare's bot check refuses some others (error 1010).
      ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}`, "User-Agent": `Bun/${Bun.version}` } } as unknown as string[]);
    } catch (e) {
      this.log(() => `events: ${e instanceof Error ? e.message : String(e)}`);
      this.sockWait = Math.min(this.sockWait * 2, EVENTS_BACKOFF_MAX);
      return;
    }
    this.sock = ws;
    ws.onopen = () => {
      if (this.sock !== ws) return;
      this.pushing = true;
      this.sockWait = 1000;
      this.sockPing = setInterval(() => {
        try {
          ws.send("ping");
        } catch {
          // closing: onclose follows
        }
      }, EVENTS_PING);
      this.log(() => "events: listening");
    };
    ws.onmessage = (ev) => {
      if (this.sock !== ws) return;
      let m: unknown;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return; // "pong"
      }
      const seq = typeof pluck(m, "seq") === "number" ? (pluck(m, "seq") as number) : -1;
      const what = textOf(m, "what");
      if (what === "hello") {
        // A connect: what changed while it was away isn't known, unless nothing did since the last one.
        if (seq !== this.sockSeq || seq < 0) this.timers.dir = null;
      } else if (what === "invites") this.timers.inv = null;
      else if (what === "vault") this.vaultDue = true;
      else if (what === "cloud") {
        // A workspace's chats changed in the cloud (another PC sent them): read now, the loop's turn isn't needed.
        this.o.cloud?.pullSoon();
        if (seq >= 0) this.sockSeq = seq;
        return;
      } else this.timers.dir = null;
      if (seq >= 0) this.sockSeq = seq;
      this.pushed = true;
      this.pokeWake?.();
    };
    const gone = () => {
      if (this.sock !== ws) return;
      this.sock = null;
      this.pushing = false;
      if (this.sockPing !== null) clearInterval(this.sockPing);
      this.sockPing = null;
      this.sockWait = Math.min(this.sockWait * 2, EVENTS_BACKOFF_MAX);
      this.sockAt = this.nowMs();
      this.log(() => "events: closed");
      // The next try comes on the loop's turn after the wait.
      if (!this.stopped) setTimeout(() => this.pokeWake?.(), this.sockWait + 10);
    };
    ws.onclose = gone;
    ws.onerror = gone;
  }

  private hangUp(): void {
    const ws = this.sock;
    this.sock = null;
    this.pushing = false;
    if (this.sockPing !== null) clearInterval(this.sockPing);
    this.sockPing = null;
    try {
      ws?.close();
    } catch {
      // already closed
    }
  }

  /** A PC this one doesn't trust knocked: it may have just joined this PC's workspace (an accepted invitation), so the
   * directory is fetched again now rather than within two minutes. At most every SOON_EVERY. */
  refreshSoon(): void {
    const t = this.nowMs();
    if (!this.signedIn() || t - this.soonAt < SOON_EVERY) return;
    this.soonAt = t;
    this.timers.dir = null;
    this.pokeWake?.();
  }

  /** A setting changed here: it goes to the account after a short pause (a burst of changes, one call). */
  pokeSync(): void {
    this.pokeLevel = Math.max(this.pokeLevel, 1);
    this.pokeWake?.();
  }

  /** What's cached: who is signed in, this PC's workspace and directory, the keys. */
  load(): void {
    const kv = this.o.kv;
    const a = tryParse(kv.get("account"), parseUser);
    this.acct = a && a.id !== "" ? a : null;
    this.ws = kv.get("account_ws") ?? "";
    this.dir = tryParse(kv.get("account_dir"), parseDirectory) ?? emptyDirectory();
    this.fetchedKeys = this.cachedKeys();
    this.st.pick = this.acct !== null && this.ws === "" && this.acct.workspaces.length > 1;
    this.o.settings?.load();
    // Screenshots only: invitations with no service ("Sam_Lee|Team;Ana|Lab", "_" for a space).
    const fake = this.env("HARBOR_FAKE_INVITES");
    if (fake !== undefined && fake !== "") {
      this.pendingInvites = fake.split(";").map((x, i) => {
        const [by = "", ws = ""] = x.replace(/_/g, " ").split("|");
        return { id: `inv_fake${i}`, ws: `org_fake${i}`, ws_name: ws, inviter_name: by, email: this.acct?.email ?? "", at: Math.floor(this.nowMs() / 1000) };
      });
    }
  }

  private cachedKeys(): AccountKey[] {
    const raw = tryParse(this.o.kv.get("account_keys"), (v) => {
      if (!Array.isArray(v)) throw new Odd("keys");
      return v.map((p: unknown): [string, string] => {
        if (!Array.isArray(p) || typeof p[0] !== "string" || typeof p[1] !== "string") throw new Odd("keys");
        return [p[0], p[1]];
      });
    });
    return this.decodeKeys(raw ?? []);
  }

  /** Loads what's cached and starts the account loop (once). */
  start(): void {
    this.load();
    if (this.loop) return;
    this.stopped = false;
    this.loop = this.run();
  }

  /** Stops the loop; an unfinished turn finishes first. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.hangUp();
    this.pokeWake?.();
    await this.loop;
    this.loop = null;
  }

  private waitPoke(ms: number): Promise<number> {
    return new Promise((resolve) => {
      const take = () => {
        clearTimeout(timer);
        this.pokeWake = null;
        const why = this.pokeLevel;
        this.pokeLevel = 0;
        this.pushed = false;
        resolve(why);
      };
      const timer = setTimeout(take, ms);
      this.pokeWake = take;
      if (this.pokeLevel !== 0 || this.stopped || this.pushed) take();
    });
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.tick();
      } catch (e) {
        this.log(() => `tick failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      const why = await this.waitPoke(this.o.loopMs ?? 20_000);
      if (this.stopped) break;
      if (why === 2) this.timers = freshTimers(this.timers.keys);
      else if (why === 1) await sleep(this.o.syncPauseMs ?? 2000);
    }
  }

  private due(at: number | null, everyMs: number): boolean {
    return at === null || this.nowMs() - at >= everyMs;
  }

  /** The account as kv has it now: `harbor account login|logout` on a terminal changes it under a running Harbor, which follows within a turn of the loop. */
  private followKv(t: Timers): void {
    const kv = this.o.kv;
    const a = tryParse(kv.get("account"), parseUser);
    const next = a && a.id !== "" ? a : null;
    const ws = kv.get("account_ws") ?? "";
    if ((this.acct?.id ?? null) === (next?.id ?? null) && this.ws === ws) return;
    this.log(() => `kv changed: account ${JSON.stringify(next?.email ?? null)} ws ${JSON.stringify(ws)}`);
    if ((this.acct?.id ?? null) !== (next?.id ?? null)) {
      this.hangUp();
      // Signed out from a terminal (`harbor account logout`): the vault is handed back as on the button.
      if (this.acct !== null) {
        void this.o.vault?.leave();
        this.o.cloud?.leave();
      }
    }
    const came = next !== null && !this.signedIn();
    this.acct = next;
    if (this.ws !== ws) this.dir = tryParse(kv.get("account_dir"), parseDirectory) ?? emptyDirectory();
    this.ws = ws;
    if (came) {
      this.o.settings?.load();
      this.enable = true;
    }
    Object.assign(t, freshTimers(t.keys));
    this.changed();
  }

  private offline(now: number): void {
    this.setStatus((st) => (st.offlineSince = st.offlineSince === 0 ? now : st.offlineSince));
  }

  /** One turn of the loop: keys, a new Harbor token when due, this PC's registration, the directory and invites, the settings. `fresh`: everything is due. */
  async tick(fresh = false): Promise<void> {
    if (fresh) this.timers = freshTimers(this.timers.keys);
    const t = this.timers;
    this.followKv(t);
    this.log(() => `tick: signed in ${this.signedIn()} ws ${JSON.stringify(this.ws)}`);
    if (this.due(t.keys, KEYS_EVERY) && (this.signedIn() || this.ws !== "")) {
      t.keys = this.nowMs();
      await this.fetchKeys();
    }
    if (!this.signedIn()) return;
    const sec = this.loadSecrets();
    const now = this.nowSec();
    if (sec.token === "" || now - sec.token_at > RENEW_AFTER || sec.token_exp - now < 2 * 86400 || this.takeRenew()) {
      try {
        const acted = this.acted;
        const s = await this.session(await this.freshAccess(sec));
        sec.token = s.token;
        sec.token_exp = s.exp;
        sec.token_at = now;
        this.saveSecrets(sec);
        if (acted === this.acted) {
          this.setAccount(s.account, null);
          this.pendingInvites = s.invites;
        } else {
          // An accept or a removal ended meanwhile: this answer's workspaces may be from before it; the next turn asks again.
          this.renew = true;
        }
        this.setStatus((st) => {
          st.expired = false;
          st.offlineSince = 0;
        });
      } catch (e) {
        const f = asFail(e);
        if (f.kind === "expired") this.setStatus((st) => (st.expired = true));
        else if (f.kind === "offline") this.offline(now);
        else this.setStatus((st) => (st.error = f.text()));
      }
    }
    if (sec.token === "" || sec.token_exp <= now) return;
    const token = sec.token;
    this.listen(token);
    const cloudWs = this.runCloud(token);
    const result = (f: AccountFail | null) => {
      if (f === null) {
        if (this.st.offlineSince !== 0) this.setStatus((st) => (st.offlineSince = 0));
      }
      else if (f.kind === "expired") this.renew = true;
      else if (f.kind === "offline") this.offline(now);
    };
    const attempt = async (f: () => Promise<void>): Promise<AccountFail | null> => {
      try {
        await f();
        return null;
      } catch (e) {
        return asFail(e);
      }
    };
    const ws = this.ws;
    const addrs = this.o.addrs();
    const name = this.o.me().name;
    if (ws !== "" && (this.due(t.pc, PC_EVERY) || addrs.join("\n") !== t.addrs.join("\n") || name !== t.name)) {
      t.pc = this.nowMs();
      t.addrs = addrs;
      t.name = name;
      const r = await attempt(() => this.register(token, ws));
      this.log(() => `register: ${r ? r.text() : "ok"}`);
      result(r);
    }
    if (this.due(t.dir, DIR_EVERY)) {
      t.dir = this.nowMs();
      t.inv = this.nowMs();
      const r = await attempt(async () => {
        await this.fetchDirectory(token);
        await this.fetchInvites(token);
      });
      this.log(() => `directory: ${r ? r.text() : "ok"}`);
      result(r);
    } else if (t.inv === null || (!this.pushing && this.due(t.inv, INVITES_FALLBACK))) {
      t.inv = this.nowMs();
      const r = await attempt(() => this.fetchInvites(token));
      if (r) this.log(() => `invites: ${r.text()}`);
      result(r);
    }
    const pull = this.due(t.pull, SYNC_EVERY);
    if (pull) t.pull = this.nowMs();
    const settings = this.o.settings;
    if (settings) {
      const r = await attempt(() => settings.sync(token, pull));
      if (r || pull) this.log(() => `settings: ${r ? r.text() : "ok"}`);
      result(r);
    }
    const vault = this.o.vault;
    const who = this.acct?.id ?? "";
    // Every turn while something's due (a push, a change here is found by the round itself), at least each VAULT_EVERY.
    if (vault && who !== "" && (this.vaultDue || this.due(this.vaultAt, VAULT_EVERY))) {
      this.vaultDue = false;
      this.vaultAt = this.nowMs();
      const round = vault.sync(who, (method, path, body) => this.service(method, path, token, body));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = await Promise.race([round.then(() => false), new Promise<boolean>((r) => (timer = setTimeout(() => r(true), this.o.vaultWaitMs ?? VAULT_WAIT)))]);
      clearTimeout(timer);
      if (late) this.log(() => "the vault's round is taking long: the loop goes on without it");
    }
    // The directory may have changed this turn (a workspace joined): the cloud reads it now, not a turn later.
    if (this.dir.workspaces.map((w) => w.id).join("\n") !== cloudWs) this.runCloud(token);
  }

  /** A round of the workspace cloud, never waited for: first thing in a turn, so a slow vault, settings or directory never holds this PC's chats back. Returns the workspaces it read. */
  private runCloud(token: string): string {
    const cloud = this.o.cloud;
    const who = this.acct?.id ?? "";
    const workspaces = this.dir.workspaces.map((w) => w.id);
    if (cloud && who !== "") void cloud.sync({ account: who, mine: this.ws, workspaces, call: (method, path, body) => this.service(method, path, token, body) });
    return workspaces.join("\n");
  }

  /** Something Settings and the window show changed outside the loop (a single-host lease, settings from the account). */
  notifyChanged(): void {
    this.changed();
  }

  /** Runs the vault's round on the next turn (a sign-in of an integration here, Settings). */
  pokeVault(): void {
    this.vaultDue = true;
    this.pokeWake?.();
  }

  private takeRenew(): boolean {
    const r = this.renew;
    this.renew = false;
    return r;
  }

  /** `harbor account [status|login|logout]`: the exit code. Signing in from a terminal prints the URL to open anywhere that reaches this PC's loopback (e.g. through `ssh -L`). */
  async cli(args: string[], io: { out: (line: string) => void; err: (line: string) => void }): Promise<number> {
    switch (args[0] ?? "status") {
      case "login": {
        this.load();
        let shown = "";
        const watch = setInterval(() => {
          const url = this.st.url;
          if (url !== "" && url !== shown) {
            shown = url;
            io.out(`Sign in with Google in the browser that opened, or open:\n${shown}`);
          }
        }, 200);
        try {
          await this.signInFlow();
        } catch (e) {
          io.err(`harbor: ${e instanceof Error ? e.message : String(e)}`);
          return 1;
        } finally {
          clearInterval(watch);
        }
        const a = this.acct;
        io.out(`Signed in as ${a?.name ?? ""} <${a?.email ?? ""}>.`);
        if (this.ws === "" && a && a.workspaces.length > 1) io.out(`Pick this PC's workspace in Harbor › Settings › Account: ${a.workspaces.map((w) => w.name).join(", ")}`);
        return 0;
      }
      case "logout":
        this.load();
        this.signOut();
        io.out("Signed out. This PC stays in its workspace.");
        return 0;
      case "status": {
        const kv = this.o.kv;
        const parsed = tryParse(kv.get("account"), parseUser);
        const a = parsed && parsed.id !== "" ? parsed : null;
        const ws = kv.get("account_ws") ?? "";
        const dir = tryParse(kv.get("account_dir"), parseDirectory) ?? emptyDirectory();
        io.out(`service:   ${this.serviceUrl()}${this.configured() ? "" : " (placeholder: not set up)"}`);
        io.out(a ? `account:   ${a.name} <${a.email}> (${a.id})` : "account:   not signed in");
        const name = directoryOf(dir, ws)?.name ?? a?.workspaces.find((w) => w.id === ws)?.name ?? "";
        io.out(`workspace: ${ws === "" ? "none" : `${name} (${ws})`}`);
        const d = directoryOf(dir, ws);
        if (d) {
          io.out(`members:   ${d.members.map((m) => `${m.name} <${m.email}> ${m.role}`).join(", ")}`);
          for (const p of d.pcs) io.out(`pc:        ${p.name} ${short(p.fp)} ${p.addrs.join(" ")}`);
          io.out(`devices:   ${d.devices.length}`);
        }
        io.out(`this pc:   ${this.myFp()}`);
        return 0;
      }
      default:
        io.err("usage: harbor account [status|login|logout]\nOr sign in and out in Harbor › Settings › Account.");
        return 2;
    }
  }
}
