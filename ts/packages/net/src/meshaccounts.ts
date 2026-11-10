import { createHash } from "node:crypto";
import { pickAuto } from "./ram.ts";
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
  /** The photo of the person it belongs to (`person`, else its PC's owner) as its PC's workspace directory has it: an
   *  HTTPS URL (Clerk's image), absent when it knows none. Older PCs don't say. */
  photo?: string;
}

const MODELS_MAX = 60;

const str = (v: unknown, n: number) => Array.from(typeof v === "string" ? v : "").slice(0, n).join("");

/** Only an HTTPS address is a photo (account.ts' rule). */
export const photoUrl = (v: unknown): string => (typeof v === "string" && v.startsWith("https://") && v.length <= 2048 ? v : "");

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
      const photo = photoUrl(o.photo);
      if (photo !== "") a.photo = photo;
      out.push(a);
    }
    if (out.length === 32) break;
  }
  return out;
}

export function meshAccountJson(a: MeshAccount): { [k: string]: string | boolean | string[][] } {
  const o: { [k: string]: string | boolean | string[][] } = { id: a.id, short: a.short, kind: a.kind, ident: a.ident, person: a.person, main: a.main, models: a.models };
  if (a.shared === false) o.shared = false;
  if (a.photo !== undefined && a.photo !== "") o.photo = a.photo;
  return o;
}

/** The identity of a sign-in as PCs compare it: a hash of provider and email, so the email itself never crosses the mesh. */
export function identOf(kind: string, email: string): string {
  const e = email.trim().toLowerCase();
  if (e === "") return "";
  return createHash("sha256").update(`${kind.toLowerCase()}:${e}`).digest("hex").slice(0, 24);
}

/** OpenCode's one entry: it has no sign-in (no account, nobody's), so it's the same tool on every PC. */
export const OPENCODE_IDENT = "any";

/** Who a told account is as the mesh groups it: its sign-in; OpenCode is one everywhere (`OPENCODE_IDENT`); a CLI that
 *  told none ("") stays the CLI on its PC. */
export function sharedIdent(acc: Pick<MeshAccount, "kind" | "ident">): string {
  return acc.kind === "opencode" ? OPENCODE_IDENT : acc.ident;
}

/** Where an account is the same as another: its sign-in, else the CLI on its PC. */
export function accountKey(kind: string, ident: string, pc: string, id: string): string {
  return ident !== "" ? `${kind}:${ident}` : `${kind}@${pc}/${id}`;
}

/** People's photos by name, from the workspace directory's members (and who is signed in here): the first one named so
 *  with a photo. Names are compared as people write them (case and spaces aside). */
export function photosByName(people: readonly { name: string; image?: string }[]): (name: string) => string {
  const m = new Map<string, string>();
  for (const p of people) {
    const k = nameKey(p.name);
    const url = photoUrl(p.image);
    if (k !== "" && url !== "" && !m.has(k)) m.set(k, url);
  }
  return (name) => m.get(nameKey(name)) ?? "";
}

const nameKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** A workspace member a sign-in turned out to be: their name there (it may be a nickname) and their photo. */
export interface WorkspaceFace {
  name: string;
  photo: string;
}

/** The workspace directory's people (and who is signed in here) as the picker finds their photos: by the email an
 *  account signs in with (this PC's own accounts), by its hash (another PC's: emails never cross the mesh), and only
 *  last by name, since a member's workspace name can be a nickname nobody's PC knows them by. */
export interface PhotoBook {
  /** The member whose email this is and who has a photo. */
  byEmail(email: string): WorkspaceFace | null;
  /** The member whose sign-in of `kind` has this hash (`identOf`) and who has a photo. */
  byIdent(kind: string, ident: string): WorkspaceFace | null;
  byName(name: string): string;
}

export function photoBook(people: readonly { name: string; email?: string; image?: string }[]): PhotoBook {
  const emails = new Map<string, WorkspaceFace>();
  for (const p of people) {
    const e = (p.email ?? "").trim().toLowerCase();
    const photo = photoUrl(p.image);
    if (e !== "" && photo !== "" && !emails.has(e)) emails.set(e, { name: p.name.trim(), photo });
  }
  const idents = new Map<string, Map<string, WorkspaceFace>>();
  const identsOf = (kind: string) => {
    const k = kind.toLowerCase();
    let m = idents.get(k);
    if (!m) {
      m = new Map();
      for (const [e, f] of emails) m.set(identOf(k, e), f);
      idents.set(k, m);
    }
    return m;
  };
  const byName = photosByName(people);
  return {
    byEmail: (email) => emails.get(email.trim().toLowerCase()) ?? null,
    byIdent: (kind, ident) => (ident === "" ? null : (identsOf(kind).get(ident) ?? null)),
    byName,
  };
}

/** A book that knows nobody. */
export const NO_PHOTOS: PhotoBook = { byEmail: () => null, byIdent: () => null, byName: () => "" };

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

/** Whether two names are one person's: the same name, or one is the other's first name (a workspace nickname). */
export function samePerson(a: string, b: string): boolean {
  const [x, y] = [words(a).map((w) => w.toLowerCase()), words(b).map((w) => w.toLowerCase())];
  if (x.length === 0 || y.length === 0) return false;
  if (x.join(" ") === y.join(" ")) return true;
  return (x.length === 1 || y.length === 1) && x[0] === y[0];
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

/** This PC's usable accounts as hello tells them: sign-ins of one identity once (the first), each with who it is and, when
 *  `photos` knows one, that person's photo: the workspace member who signs in with its email, else the person by name
 *  (`owner`'s, this PC's owner, for one nobody else is known to own). */
export function helloAccounts(local: readonly LocalAccount[], people: readonly Person[], photos?: { owner: string; book: PhotoBook }): MeshAccount[] {
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
    const person = a.email === "" ? "" : personOfEmail(a.email, people);
    const m: MeshAccount = { id: a.id, short: a.short, kind, ident, person, main: a.id === kind || kinds.get(kind) === 1, models: (a.models ?? []).slice(0, MODELS_MAX) };
    const photo = photos ? photoUrl(photos.book.byEmail(a.email)?.photo || photos.book.byName(person !== "" ? person : photos.owner)) : "";
    if (photo !== "") m.photo = photo;
    out.push(m);
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
  /** Who it belongs to ("" not known) and their badge: their initials, drawn only where no photo is known. */
  person: string;
  /** What the label calls them: their workspace name when the sign-in is a workspace member's (it may be a nickname),
   *  else `person`. */
  shown: string;
  badge: string;
  /** Their workspace photo (an HTTPS URL; "" none known), drawn round in place of the initials. */
  photo: string;
  /** The mesh has other PCs, so the badge says whose it is, and no photo of them is known: their initials stand in. */
  noPhoto: boolean;
  /** "Claude · DR", "OpenCode · ML"; with a photo, their name (`shown`): "Claude · Dana Reyes". */
  label: string;
  /** It's someone else's: its person is known and isn't this PC's owner (the sidebar marks their chats). */
  others?: boolean;
  /** Their initials as the sidebar's mark shows them: `badge` while the mesh has other PCs, else from `person`. */
  mark?: string;
  models: [string, string][];
  /** Why it can't be picked now ("" it can). */
  why: string;
  /** The other PCs that have it too (names). */
  also: string[];
  /** Every PC's copy of this sign-in ("" this PC) with the id it has there: "claude" here can be "claude2" there. */
  copies?: { pc: string; account: string; online: boolean }[];
}

export interface SharedInput {
  me: { id: string; name: string; owner: string; github: string };
  local: readonly LocalAccount[];
  /** The mesh's PCs (none while the mesh is off). */
  peers: readonly (Pick<Peer, "id" | "name" | "online" | "owner" | "github" | "accounts"> & { ram?: number | null })[];
  /** Each peer's accounts as it told them (`Peer.provs`); a peer missing here is read from its `accounts`. */
  provs: ReadonlyMap<string, readonly MeshAccount[]>;
  /** This PC's workspace directory's photos (`photoBook`): by sign-in first, by name last; else the one their PC told. */
  photos?: PhotoBook;
}

interface Holder {
  pc: string;
  pcName: string;
  online: boolean;
  owner: string;
  /** Its PC's free memory (MB, `Peer.ram`); null not known. */
  ram: number | null;
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
    const key = accountKey(h.acc.kind, sharedIdent(h.acc), h.pc, h.acc.id);
    const g = groups.get(key);
    if (g) g.push(h);
    else {
      groups.set(key, [h]);
      order.push(key);
    }
  };
  const mine = helloAccounts(i.local, people);
  for (const acc of mine) add({ pc: "", pcName: i.me.name, online: true, owner: i.me.owner, ram: null, acc, local: i.local.find((a) => a.id === acc.id) ?? null });
  const peers = [...i.peers].sort((a, b) => byStr(a.id, b.id));
  for (const p of peers) {
    if (p.id === i.me.id) continue;
    const told: readonly MeshAccount[] = i.provs.get(p.id) ?? p.accounts.map(([id, short, kind]): MeshAccount => ({ id, short, kind: kind.toLowerCase(), ident: "", person: "", main: false, models: [] }));
    const seen = new Set<string>();
    for (const acc of told) {
      const key = accountKey(acc.kind, sharedIdent(acc), p.id, acc.id);
      // One its PC doesn't let this PC use isn't offered (it still counts for Runs on, which asks that PC itself).
      if (acc.id === "" || acc.shared === false || seen.has(key)) continue;
      seen.add(key);
      add({ pc: p.id, pcName: p.name === "" ? p.id : p.name, online: p.online, owner: p.owner, ram: p.ram ?? null, acc, local: null });
    }
  }
  // The workspace member each one signs in as: this PC's own by its email, another PC's by the hash it told.
  const book = i.photos ?? NO_PHOTOS;
  const faces = new Map<string, WorkspaceFace>();
  for (const key of order) {
    for (const h of groups.get(key) ?? []) {
      if (h.acc.kind === "opencode") break;
      const f = h.local !== null ? book.byEmail(h.local.email) : book.byIdent(h.acc.kind, h.acc.ident);
      if (f) {
        faces.set(key, f);
        break;
      }
    }
  }
  // Who each one is: a sign-in's email names them; else the workspace member it signs in as; else the owner of a PC
  // where it's the main one; else its PC's owner.
  const owners = new Map<string, string>();
  for (const key of order) {
    const hs = groups.get(key) ?? [];
    // OpenCode is nobody's: no badge, no photo, just "OpenCode".
    if (hs[0]?.acc.kind === "opencode") {
      owners.set(key, "");
      continue;
    }
    const claimed = hs.find((h) => h.acc.person !== "")?.acc.person;
    const main = hs.find((h) => h.acc.main && h.owner !== "");
    const face = faces.get(key)?.name;
    owners.set(key, claimed ?? (face || undefined) ?? main?.owner ?? hs.find((h) => h.owner !== "")?.owner ?? "");
  }
  // Alone (no other PC), the accounts keep their own badges: the owner's would be the same on every one.
  const alone = !i.peers.some((p) => p.id !== i.me.id);
  const badges = alone ? new Map<string, string>() : personBadges([...owners.values()]);
  // The photos PCs told, by whose they are (the account's person, else that PC's owner): the first of each.
  const told = new Map<string, string>();
  for (const hs of groups.values())
    for (const h of hs) {
      const who = h.acc.person !== "" ? h.acc.person : h.owner;
      if (who !== "" && (h.acc.photo ?? "") !== "" && !told.has(who)) told.set(who, h.acc.photo ?? "");
    }
  const out: SharedAccount[] = [];
  for (const key of order) {
    const hs = groups.get(key) ?? [];
    const run = hs.find((h) => h.pc === "") ?? (hs[0]?.acc.kind === "opencode" ? autoHolder(hs) : undefined) ?? hs.find((h) => h.online) ?? hs[0];
    if (!run) continue;
    const person = owners.get(key) ?? "";
    const own = run.acc.kind === "claude" ? (run.local?.badge ?? "") : "";
    const badge = alone ? own : (badges.get(person) ?? own);
    // Their photo: the workspace member's it signs in as (alone too: that's certain); while the badge says whose it is,
    // else the one its PC told, this PC's directory's by name, or one a PC told with any of theirs.
    const face = faces.get(key);
    const byWho = alone || person === "" ? "" : hs.map((h) => h.acc.photo ?? "").find((u) => u !== "") || book.byName(person) || (told.get(person) ?? "");
    const photo = face?.photo || byWho;
    const shown = face && face.name !== "" ? face.name : person;
    const label = photo !== "" && shown !== "" ? `${kindLabel(run.acc.kind)} \u{b7} ${shown}` : badge === "" ? kindLabel(run.acc.kind) : `${kindLabel(run.acc.kind)} \u{b7} ${badge}`;
    out.push({
      key,
      kind: run.acc.kind,
      id: run.pc === "" ? run.acc.id : key,
      account: run.acc.id,
      pc: run.pc,
      pcName: run.pcName,
      person,
      shown,
      badge,
      photo,
      noPhoto: !alone && photo === "" && badge !== "",
      label,
      others: person !== "" && i.me.owner !== "" && !samePerson(person, i.me.owner),
      mark: alone || badge === "" ? initials(person) : badge,
      models: run.acc.models,
      why: run.online ? "" : `${run.pcName} is offline`,
      copies: hs.map((h) => ({ pc: h.pc, account: h.acc.id, online: h.online })),
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
      s.label = s.photo !== "" && s.shown !== "" ? `${kindLabel(s.kind)} \u{b7} ${s.shown} ${n}` : `${kindLabel(s.kind)} \u{b7} ${s.badge}`;
    }
  }
  return out;
}

/** Where OpenCode runs when this PC has none: Auto's pick (`pickAuto`, the most free memory) of the PCs that are on. */
function autoHolder(hs: readonly Holder[]): Holder | undefined {
  const on = hs.filter((h) => h.online);
  const best = pickAuto(on.map((h) => ({ id: h.pc, name: h.pcName, ram: h.ram })));
  return best === null ? undefined : on.find((h) => h.pc === best.id);
}

/** Where a picked account runs: this PC's own id, or another PC's account (null: no such account, or why it can't now). */
export function sharedTarget(list: readonly SharedAccount[], id: string): { pc: string; account: string; kind: string; label: string; why: string } | null {
  const s = list.find((x) => x.id === id) ?? list.find((x) => x.key === id);
  return s ? { pc: s.pc, account: s.account, kind: s.kind, label: s.label, why: s.why } : null;
}

/** The id a picked account has on PC `pc` (Runs on picked it): the same sign-in's id there, else `id` unchanged. */
export function accountOn(list: readonly SharedAccount[], id: string, pc: string): string {
  const s = list.find((x) => x.id === id) ?? list.find((x) => x.key === id);
  return s?.copies?.find((h) => h.pc === pc)?.account ?? id;
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
    const named = s.photo !== "" && s.shown !== "";
    v.push(s.person === "" || (named && s.shown === s.person) ? s.label : `${s.label} (${s.person})`);
    out.set(s.pc, v);
  }
  return out;
}

/** A shared account in a tooltip: who it is and where it runs, and that its badge is their initials when the workspace
 *  has no photo of them. */
export function sharedTip(s: SharedAccount): string {
  // Their workspace name, and the name their PCs know them by when that's another ("Fizz's (Filip Sato), …").
  const shown = s.shown === "" ? s.person : s.shown;
  const who = shown === "" ? "" : s.person !== "" && s.person !== shown ? `${shown}'s (${s.person}), ` : `${shown}'s, `;
  const also = s.also.length === 0 ? "" : ` (also on ${s.also.join(", ")})`;
  const initials = s.noPhoto ? ` \u{b7} no workspace photo${s.person === "" ? "" : ` of ${s.person}`}, so the badge is ${s.badge}` : "";
  return `${who}runs on ${s.pc === "" ? "this PC" : s.pcName}${also}${initials}`;
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

/** The account chat `c` runs on (another PC's copy runs on that PC's, `home`), when it's someone else's (`others`): the
 *  sidebar marks the chat with their photo or initials. Null for yours, or an account not known. */
export function chatOwner(list: readonly SharedAccount[], c: { home: string; account: string }): SharedAccount | null {
  const a = list.find((x) => (c.home === "" ? x.pc === "" && (x.id === c.account || x.account === c.account) : x.pc === c.home && x.account === c.account));
  return a && a.others === true ? a : null;
}
