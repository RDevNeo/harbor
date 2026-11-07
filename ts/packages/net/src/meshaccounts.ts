import { createHash } from "node:crypto";
import type { Peer } from "./shared.ts";

/** One of a PC's agent accounts as it tells the mesh (`accounts` in hello, kv `mesh_peers`). Older PCs say only `id`,
 *  `short` and `kind`; the rest is then empty. Never a login, a key or an email: `ident` is a hash of the sign-in. */
export interface MeshAccount {
  /** Its id on its PC ("claude2", "opencode"). */
  id: string;
  /** "Claude · AB" or "OpenCode", as its PC names it. */
  short: string;
  /** "claude", "codex", "opencode". */
  kind: string;
  /** Who it signs in as: `identOf(kind, email)`; "" when its PC doesn't know (then it's that PC's CLI alone). */
  ident: string;
  /** The person it belongs to as its PC worked it out from the sign-in ("" not known). */
  person: string;
  /** Its PC's main sign-in of that kind (~/.claude, or the only CLI of a kind). */
  main: boolean;
  /** Its models there, [id, label] (empty: the kind's usual ones). */
  models: [string, string][];
  /** Its PC lets the PC it told run chats on it (Settings › Workspace there); older PCs don't say: yes. */
  shared?: boolean;
}

const MODELS_MAX = 60;

const str = (v: unknown, n: number) => Array.from(typeof v === "string" ? v : "").slice(0, n).join("");

/** `accounts` of a hello or of a saved peer, as far as it makes sense (at most 32). */
export function meshAccounts(v: unknown): MeshAccount[] {
  if (!Array.isArray(v)) return [];
  const out: MeshAccount[] = [];
  for (const x of v) {
    // kv `mesh_peers` of older versions kept [id, short, kind].
    if (Array.isArray(x)) {
      const [id, short, kind] = x;
      if (typeof id === "string" && id !== "") out.push({ id: str(id, 40), short: str(short, 60), kind: str(kind, 20).toLowerCase(), ident: "", person: "", main: false, models: [] });
    } else if (typeof x === "object" && x !== null) {
      const o = x as Record<string, unknown>;
      const id = str(o.id, 40);
      if (id === "") continue;
      const models: [string, string][] = [];
      for (const m of Array.isArray(o.models) ? o.models : []) {
        if (!Array.isArray(m) || typeof m[0] !== "string" || m[0] === "") continue;
        models.push([str(m[0], 120), str(typeof m[1] === "string" && m[1] !== "" ? m[1] : m[0], 80)]);
        if (models.length === MODELS_MAX) break;
      }
      const a: MeshAccount = { id, short: str(o.short, 60), kind: str(o.kind, 20).toLowerCase(), ident: str(o.ident, 64), person: str(o.person, 80), main: o.main === true, models };
      if (o.shared === false) a.shared = false;
      out.push(a);
    }
    if (out.length === 32) break;
  }
  return out;
}

export function meshAccountJson(a: MeshAccount): { [k: string]: string | boolean | string[][] } {
  const o: { [k: string]: string | boolean | string[][] } = { id: a.id, short: a.short, kind: a.kind, ident: a.ident, person: a.person, main: a.main, models: a.models };
  if (a.shared === false) o.shared = false;
  return o;
}

/** The identity of a sign-in as PCs compare it: a hash of provider and email, so the email itself never crosses the mesh. */
export function identOf(kind: string, email: string): string {
  const e = email.trim().toLowerCase();
  if (e === "") return "";
  return createHash("sha256").update(`${kind.toLowerCase()}:${e}`).digest("hex").slice(0, 24);
}

/** Where an account is the same as another: its sign-in, else the CLI on its PC. */
export function accountKey(kind: string, ident: string, pc: string, id: string): string {
  return ident !== "" ? `${kind}:${ident}` : `${kind}@${pc}/${id}`;
}

/** A person of the mesh: a PC's owner. */
export interface Person {
  name: string;
  github: string;
}

const letters = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The person an email is most likely: their name (words joined) or GitHub login inside its local part; "" none or two. */
export function personOfEmail(email: string, people: readonly Person[]): string {
  const local = letters(email.split("@")[0] ?? "");
  if (local === "") return "";
  let best = "";
  let len = 0;
  let tie = false;
  const seen = new Set<string>();
  for (const p of people) {
    if (p.name === "" || seen.has(p.name)) continue;
    seen.add(p.name);
    for (const c of [letters(p.name), letters(p.github)]) {
      if (c.length < 4 || !local.includes(c)) continue;
      if (c.length > len) [best, len, tie] = [p.name, c.length, false];
      else if (c.length === len && p.name !== best) tie = true;
    }
  }
  return tie ? "" : best;
}

const cap = (s: string) => (s === "" ? "" : s[0]!.toUpperCase() + s.slice(1).toLowerCase());

function words(name: string): string[] {
  return name.split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, "")).filter((w) => w !== "");
}

/** A person's badge: the initials of their first and last name ("Dana Reyes" is FS), a single name's first two letters. */
export function initials(name: string): string {
  const w = words(name);
  if (w.length === 0) return "";
  if (w.length === 1) return Array.from(w[0]!).slice(0, 2).join("").toUpperCase();
  return (Array.from(w[0]!)[0]! + Array.from(w[w.length - 1]!)[0]!).toUpperCase();
}

/** Each person's badge; two people with the same initials are told apart by more of the first name ("DR" and "DaR"):
 *  the first by name keeps the plain initials, so every PC gives the same badges. */
export function personBadges(names: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  const sorted = [...new Set(names.filter((n) => n.trim() !== ""))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const n of sorted) {
    const base = initials(n);
    let b = base;
    const w = words(n);
    const first = Array.from(w[0] ?? "");
    const last = w.length > 1 ? (Array.from(w[w.length - 1]!)[0] ?? "").toUpperCase() : "";
    for (let k = 2; used.has(b) && k <= first.length; k++) b = cap(first.slice(0, k).join("")) + last;
    for (let i = 2; used.has(b); i++) b = `${base}${i}`;
    used.add(b);
    out.set(n, b);
  }
  return out;
}

/** This PC's own account as the shared list reads it (providers `Account`). */
export interface LocalAccount {
  id: string;
  kind: string;
  email: string;
  /** Its own badge (from the email or the profile folder), for when nobody is known to own it. */
  badge: string;
  short: string;
  usable: boolean;
  models?: [string, string][];
}

/** This PC's usable accounts as hello tells them: sign-ins of one identity once (the first), each with who it is. */
export function helloAccounts(local: readonly LocalAccount[], people: readonly Person[]): MeshAccount[] {
  const out: MeshAccount[] = [];
  const seen = new Set<string>();
  const kinds = new Map<string, number>();
  for (const a of local) if (a.usable) kinds.set(a.kind.toLowerCase(), (kinds.get(a.kind.toLowerCase()) ?? 0) + 1);
  for (const a of local) {
    if (!a.usable) continue;
    const kind = a.kind.toLowerCase();
    const ident = identOf(kind, a.email);
    const key = accountKey(kind, ident, "", a.id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: a.id, short: a.short, kind, ident, person: a.email === "" ? "" : personOfEmail(a.email, people), main: a.id === kind || kinds.get(kind) === 1, models: (a.models ?? []).slice(0, MODELS_MAX) });
  }
  return out;
}

/** One entry of the mesh's shared accounts: every sign-in once, run on the PC that has it. */
export interface SharedAccount {
  key: string;
  /** "claude", "codex", "opencode". */
  kind: string;
  /** The id pickers use: the account's own for this PC's, `key` for another PC's. */
  id: string;
  /** The account's id on the PC that runs it. */
  account: string;
  /** That PC: "" this one. */
  pc: string;
  pcName: string;
  /** Who it belongs to ("" not known) and their badge. */
  person: string;
  badge: string;
  /** "Claude · DR", "OpenCode · ML". */
  label: string;
  models: [string, string][];
  /** Why it can't be picked now ("" it can). */
  why: string;
  /** The other PCs that have it too (names). */
  also: string[];
}

export interface SharedInput {
  me: { id: string; name: string; owner: string; github: string };
  local: readonly LocalAccount[];
  /** The mesh's PCs (none while the mesh is off). */
  peers: readonly Pick<Peer, "id" | "name" | "online" | "owner" | "github" | "accounts">[];
  /** Each peer's accounts as it told them (`Peer.provs`); a peer missing here is read from its `accounts`. */
  provs: ReadonlyMap<string, readonly MeshAccount[]>;
}

interface Holder {
  pc: string;
  pcName: string;
  online: boolean;
  owner: string;
  acc: MeshAccount;
  local: LocalAccount | null;
}

const KIND_LABEL: Record<string, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode" };

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? cap(kind);
}

const byStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Every account of this PC and of the mesh's PCs, each sign-in once: this PC's own when it has it, else a PC that has
 *  it (the first by id that is on, so every PC picks the same; one that is off says why). Badges are the owner's. */
export function sharedAccounts(i: SharedInput): SharedAccount[] {
  const people: Person[] = [{ name: i.me.owner, github: i.me.github }, ...i.peers.map((p) => ({ name: p.owner, github: p.github }))];
  const groups = new Map<string, Holder[]>();
  const order: string[] = [];
  const add = (h: Holder) => {
    const key = accountKey(h.acc.kind, h.acc.ident, h.pc, h.acc.id);
    const g = groups.get(key);
    if (g) g.push(h);
    else {
      groups.set(key, [h]);
      order.push(key);
    }
  };
  const mine = helloAccounts(i.local, people);
  for (const acc of mine) add({ pc: "", pcName: i.me.name, online: true, owner: i.me.owner, acc, local: i.local.find((a) => a.id === acc.id) ?? null });
  const peers = [...i.peers].sort((a, b) => byStr(a.id, b.id));
  for (const p of peers) {
    if (p.id === i.me.id) continue;
    const told: readonly MeshAccount[] = i.provs.get(p.id) ?? p.accounts.map(([id, short, kind]): MeshAccount => ({ id, short, kind: kind.toLowerCase(), ident: "", person: "", main: false, models: [] }));
    const seen = new Set<string>();
    for (const acc of told) {
      const key = accountKey(acc.kind, acc.ident, p.id, acc.id);
      // One its PC doesn't let this PC use isn't offered (it still counts for Runs on, which asks that PC itself).
      if (acc.id === "" || acc.shared === false || seen.has(key)) continue;
      seen.add(key);
      add({ pc: p.id, pcName: p.name === "" ? p.id : p.name, online: p.online, owner: p.owner, acc, local: null });
    }
  }
  // Who each one is: a sign-in's email names them; else the owner of a PC where it's the main one; else its PC's owner.
  const owners = new Map<string, string>();
  for (const key of order) {
    const hs = groups.get(key) ?? [];
    const claimed = hs.find((h) => h.acc.person !== "")?.acc.person;
    const main = hs.find((h) => h.acc.main && h.owner !== "");
    owners.set(key, claimed ?? main?.owner ?? hs.find((h) => h.owner !== "")?.owner ?? "");
  }
  // Alone (no other PC), the accounts keep their own badges: the owner's would be the same on every one.
  const alone = !i.peers.some((p) => p.id !== i.me.id);
  const badges = alone ? new Map<string, string>() : personBadges([...owners.values()]);
  const out: SharedAccount[] = [];
  for (const key of order) {
    const hs = groups.get(key) ?? [];
    const run = hs.find((h) => h.pc === "") ?? hs.find((h) => h.online) ?? hs[0];
    if (!run) continue;
    const person = owners.get(key) ?? "";
    const own = run.acc.kind === "claude" ? (run.local?.badge ?? "") : "";
    const badge = alone ? own : (badges.get(person) ?? own);
    const label = badge === "" ? kindLabel(run.acc.kind) : `${kindLabel(run.acc.kind)} \u{b7} ${badge}`;
    out.push({
      key,
      kind: run.acc.kind,
      id: run.pc === "" ? run.acc.id : key,
      account: run.acc.id,
      pc: run.pc,
      pcName: run.pcName,
      person,
      badge,
      label,
      models: run.acc.models,
      why: run.online ? "" : `${run.pcName} is offline`,
      also: hs.filter((h) => h !== run).map((h) => h.pcName),
    });
  }
  // One person's two sign-ins of a kind would read the same: the second gets a number.
  const labels = new Map<string, number>();
  for (const s of out) {
    const n = (labels.get(s.label) ?? 0) + 1;
    labels.set(s.label, n);
    if (n > 1 && s.badge !== "") {
      s.badge = `${s.badge}${n}`;
      s.label = `${kindLabel(s.kind)} \u{b7} ${s.badge}`;
    }
  }
  return out;
}

/** Where a picked account runs: this PC's own id, or another PC's account (null: no such account, or why it can't now). */
export function sharedTarget(list: readonly SharedAccount[], id: string): { pc: string; account: string; kind: string; label: string; why: string } | null {
  const s = list.find((x) => x.id === id) ?? list.find((x) => x.key === id);
  return s ? { pc: s.pc, account: s.account, kind: s.kind, label: s.label, why: s.why } : null;
}

/** An account id another PC runs (`sharedAccounts`' key): never one of this PC's own ids ("claude2", "opencode"). */
export function isSharedId(id: string): boolean {
  return id.includes(":") || id.includes("@");
}

/** Each PC's agent accounts for the who is who, each sign-in once: under the PC that runs it. */
export function accountsByPc(list: readonly SharedAccount[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const s of list) {
    const v = out.get(s.pc) ?? [];
    v.push(s.person === "" ? s.label : `${s.label} (${s.person})`);
    out.set(s.pc, v);
  }
  return out;
}

/** A shared account in a tooltip: who it is and where it runs. */
export function sharedTip(s: SharedAccount): string {
  const who = s.person === "" ? "" : `${s.person}'s, `;
  const also = s.also.length === 0 ? "" : ` (also on ${s.also.join(", ")})`;
  return `${who}runs on ${s.pc === "" ? "this PC" : s.pcName}${also}`;
}

const RANK: Record<string, number> = { plan: 0, edits: 1, full: 2 };
/** What a chat may do here for each machines.rs level another PC's chats get ("off": nothing). */
const LEVEL_CAP: Record<string, string> = { read: "plan", edit: "edits", full: "full" };

/** Whether this PC offers an account to a PC it shares `level` with: not when it shares nothing, nor a kind that can't
 *  run within it (OpenCode has full access only). `choices`: the kind's access levels. */
export function sharedWith(level: string, choices: readonly string[]): boolean {
  const cap = LEVEL_CAP[level];
  return cap !== undefined && choices.some((c) => (RANK[c] ?? 2) <= (RANK[cap] ?? 2));
}

/** The access a chat another PC starts here on one of this PC's accounts runs with: what it asked for, at most what this
 *  PC's owner lets that PC's chats do here (Settings › Workspace, the `machines` levels). */
export function sharedAccess(level: string, asked: string, choices: readonly string[], who: { me: string; kind: string }): { access: string } | { why: string } {
  const cap = LEVEL_CAP[level];
  if (cap === undefined) return { why: `${who.me} doesn't share its accounts with this PC (its owner can change that in Settings › Workspace there)` };
  const want = (RANK[asked] ?? 2) <= (RANK[cap] ?? 2) ? asked : cap;
  if (choices.includes(want)) return { access: want };
  return { why: `${who.me} lets this PC's chats only ${level === "read" ? "read" : "edit files"} there, and ${kindLabel(who.kind)} runs with full access only` };
}
