/**
 * Account pins: the user keeps a chat, or every chat of a project, on one provider account. While a chat is pinned
 * nothing automatic moves it (limit failover, the automatic-switch list, a turned-off account's fallback, the lead's
 * switch_agent_account): at a limit it waits for the reset. The user may still pick another account by hand, which
 * moves the pin with it (`followPick`).
 *
 * - A chat's own pin wins over its project's. A project's pin covers its chats that haven't started, and started ones
 *   of the pin's provider (a started Codex chat isn't handed to Claude because its project got pinned); subagents
 *   follow their project's pin, never their lead's chat pin.
 * - Stored in kv, one key per pin (`pin_chat:<gid>`, `pin_project:<project>`), an account setting (settingsync.ts), so
 *   the user's other PCs get them through the account sync. "" is no pin (so an unpin syncs too).
 * - A pin names its account portably: its id here, its provider and `ident` (a hash of provider and sign-in, as the
 *   mesh compares accounts, meshaccounts.ts `identOf`). Another PC resolves it by `ident`, else by the same id and
 *   provider; with neither the pin is "missing" there and the chat waits for the user (Pick another account / Unpin).
 */

import { createHash } from "node:crypto";
import type { Chat, Repo, Store } from "./store.ts";

export interface Pin {
  /** The account's id on the PC that pinned it ("claude2"). */
  account: string;
  /** "claude", "codex", "opencode". */
  kind: string;
  /** `accountIdent(kind, email)`; "" when the sign-in isn't known. */
  ident: string;
  /** How it was named when pinned ("Claude · IG"), for notices on a PC that doesn't have it. */
  label: string;
}

export type PinScope = "chat" | "project";

/** An account as pins need it (providers.Account and the limits' AccountInfo both fit). */
export interface PinAccount {
  id: string;
  kind: string;
  email?: string;
  loggedIn: boolean | null;
  off?: boolean;
  bin?: string | null;
}

/** A chat's pin as it applies on this PC. `account`: the local id it resolves to (null: no such account here). `why`:
 *  "" when the account can run turns, else what's wrong with it ("is signed out", …). */
export interface Pinned {
  pin: Pin;
  scope: PinScope;
  account: string | null;
  why: string;
}

export const chatPinKey = (gid: string): string => `pin_chat:${gid}`;
export const projectPinKey = (project: string): string => `pin_project:${project}`;

const lowerAscii = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** The identity of a sign-in, as the mesh compares accounts (meshaccounts.ts `identOf` is this). */
export function accountIdent(kind: string, email: string): string {
  const e = email.trim().toLowerCase();
  if (e === "") return "";
  return createHash("sha256").update(`${kind.toLowerCase()}:${e}`).digest("hex").slice(0, 24);
}

/** A git remote as the same repository reads on every PC: host/owner/name, lower case, no scheme, user or `.git`. */
function remoteKey(url: string): string {
  let u = url.trim().replace(/\/+$/, "");
  if (u.endsWith(".git")) u = u.slice(0, -4);
  const scheme = u.indexOf("://");
  let rest: string;
  if (scheme >= 0) rest = u.slice(scheme + 3);
  else {
    const c = u.indexOf(":");
    rest = c >= 0 && !u.slice(0, c).includes("/") ? `${u.slice(0, c)}/${u.slice(c + 1)}` : u;
  }
  const at = rest.indexOf("@");
  if (at >= 0 && !rest.slice(0, at).includes("/")) rest = rest.slice(at + 1);
  return lowerAscii(rest.replace(/\/+$/, ""));
}

/** A project's key for its pin: its Git remote (the same on every PC that has it), else its name. */
export function projectKey(repo: Pick<Repo, "remote" | "name">): string {
  const r = remoteKey(repo.remote);
  return r !== "" ? `git:${r}` : `name:${repo.name.trim()}`;
}

export function pinOf(a: PinAccount & { short?: string; name?: string }, label?: string): Pin {
  return { account: a.id, kind: lowerAscii(a.kind), ident: accountIdent(a.kind, a.email ?? ""), label: label ?? a.short ?? a.name ?? a.id };
}

export function parsePin(v: string | null): Pin | null {
  if (v === null || v === "") return null;
  try {
    const o: unknown = JSON.parse(v);
    if (typeof o !== "object" || o === null) return null;
    const r = o as Record<string, unknown>;
    if (typeof r.account !== "string" || r.account === "") return null;
    const s = (x: unknown): string => (typeof x === "string" ? x : "");
    return { account: r.account, kind: lowerAscii(s(r.kind)), ident: s(r.ident), label: s(r.label) || r.account };
  } catch {
    return null;
  }
}

export function pinValue(p: Pin | null): string {
  return p === null ? "" : JSON.stringify({ account: p.account, kind: p.kind, ident: p.ident, label: p.label });
}

/** The local account a pin names: the same sign-in (ident), else the same id of the same provider. */
export function resolvePin(pin: Pin, accounts: readonly PinAccount[]): PinAccount | undefined {
  const kind = (a: PinAccount) => lowerAscii(a.kind);
  if (pin.ident !== "") {
    const same = accounts.find((a) => kind(a) === pin.kind && a.email !== undefined && accountIdent(a.kind, a.email) === pin.ident);
    if (same) return same;
  }
  return accounts.find((a) => a.id === pin.account && (pin.kind === "" || kind(a) === pin.kind));
}

/** What's wrong with a pinned account here ("" nothing). */
export function pinTrouble(a: PinAccount | undefined): string {
  if (a === undefined) return "isn't on this PC";
  if (a.bin === null) return "isn't installed on this PC";
  if (a.off === true) return "is turned off in Settings › Providers";
  if (a.loggedIn === false) return "is signed out";
  return "";
}

/** The pin that governs `chat` (its own, else its project's), or null. Pure: the getters read kv. */
export function governing(chat: Pick<Chat, "gid" | "started" | "account">, chatPin: Pin | null, projectPin: Pin | null, kindOf: (account: string) => string | undefined): { pin: Pin; scope: PinScope } | null {
  if (chatPin) return { pin: chatPin, scope: "chat" };
  if (!projectPin) return null;
  // A started chat of another provider keeps its own: a project pin doesn't hand its conversation to another provider.
  const k = kindOf(chat.account);
  if (chat.started && k !== undefined && projectPin.kind !== "" && lowerAscii(k) !== projectPin.kind) return null;
  return { pin: projectPin, scope: "project" };
}

/** Pins in a Store's kv. */
export class Pins {
  constructor(readonly store: Pick<Store, "get" | "set">) {}

  chat(gid: string): Pin | null {
    return gid === "" ? null : parsePin(this.store.get(chatPinKey(gid)));
  }

  project(repo: Pick<Repo, "remote" | "name"> | null | undefined): Pin | null {
    return repo ? parsePin(this.store.get(projectPinKey(projectKey(repo)))) : null;
  }

  setChat(gid: string, pin: Pin | null): void {
    if (gid === "") return;
    const k = chatPinKey(gid);
    const v = pinValue(pin);
    if ((this.store.get(k) ?? "") !== v) this.store.set(k, v);
  }

  setProject(repo: Pick<Repo, "remote" | "name">, pin: Pin | null): void {
    const k = projectPinKey(projectKey(repo));
    const v = pinValue(pin);
    if ((this.store.get(k) ?? "") !== v) this.store.set(k, v);
  }

  /** The pin that applies to `chat` here, resolved against this PC's accounts; null: not pinned. */
  of(chat: Pick<Chat, "gid" | "started" | "account">, repo: Pick<Repo, "remote" | "name"> | null | undefined, accounts: readonly PinAccount[]): Pinned | null {
    const kindOf = (id: string) => accounts.find((a) => a.id === id)?.kind;
    const g = governing(chat, this.chat(chat.gid), this.project(repo), kindOf);
    if (!g) return null;
    const a = resolvePin(g.pin, accounts);
    return { pin: g.pin, scope: g.scope, account: a?.id ?? null, why: pinTrouble(a) };
  }

  /** The user picked `to` by hand for a chat a pin governs: the pin goes with it (a chat pin, also when it was its
   *  project's that governed it). True when a pin moved. */
  followPick(chat: Pick<Chat, "gid" | "started" | "account">, repo: Pick<Repo, "remote" | "name"> | null | undefined, to: PinAccount & { short?: string; name?: string }, accounts: readonly PinAccount[]): boolean {
    const p = this.of(chat, repo, accounts);
    if (!p || p.account === to.id) return false;
    this.setChat(chat.gid, pinOf(to));
    return true;
  }
}

/** "Pinned to Claude · IG: Harbor won't switch it" (the composer's tooltip, the phone's too). */
export function pinTip(p: Pinned, name: string): string {
  const whose = p.scope === "project" ? " (this project's pin)" : "";
  if (p.why !== "") return `Pinned to ${name}${whose}, which ${p.why}: pick another account or unpin`;
  return `Pinned to ${name}${whose}: Hub won't switch it`;
}

/** A pin as the phone gets it (chat JSON `pin`, a project's `pin`): `account` its id here (null: not on this PC),
 *  `label` its name, `why` what's wrong with it ("" nothing), `tip` the line to show. */
export interface PinJson {
  account: string | null;
  label: string;
  scope: PinScope;
  why: string;
  tip: string;
  [k: string]: string | null;
}

export function pinJson(p: Pinned | null, nameOf: (id: string) => string | undefined): PinJson | null {
  if (p === null) return null;
  const label = (p.account === null ? undefined : nameOf(p.account)) ?? p.pin.label;
  return { account: p.account, label, scope: p.scope, why: p.why, tip: pinTip(p, label) };
}

/** A project's own pin as it applies here (for its menu and the phone), or null. */
export function projectPinned(pin: Pin | null, accounts: readonly PinAccount[]): Pinned | null {
  if (pin === null) return null;
  const a = resolvePin(pin, accounts);
  return { pin, scope: "project", account: a?.id ?? null, why: pinTrouble(a) };
}
