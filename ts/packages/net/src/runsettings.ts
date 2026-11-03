import type { Chat } from "@harbor/store";
import { providers } from "@harbor/agents";

type Account = providers.Account;
type Kind = providers.Kind;

export interface RunError {
  status: number;
  error: string;
}

/** The accounts a chat may switch to (app.rs `allowed_accounts`): a lead stays on Claude, a started chat on its provider. */
export function allowedAccounts(c: Chat, accounts: readonly Account[]): string[] {
  const locked: Kind | undefined = c.role === "lead" ? "Claude" : c.started ? accounts.find((a) => a.id === c.account)?.kind : undefined;
  return accounts.filter((a) => a.bin !== null && a.off !== true && (locked === undefined || a.kind === locked)).map((a) => a.id);
}

/**
 * A chat's run settings after a PATCH of account/model/effort/access/device/fast, checked with
 * the desktop composer's rules. Null: nothing asked; a RunError is thrown before anything changes.
 */
export function checkRun(c: Chat, body: Record<string, unknown>, accounts: readonly Account[], allowed: readonly string[], modelsFor: (k: Kind) => providers.Model[], devices: readonly string[]): { chat: Chat; fast: boolean | null } | null {
  const fail = (status: number, error: string): never => {
    throw { status, error } satisfies RunError;
  };
  const field = (k: string): string | null => {
    const v = body[k];
    if (v === undefined || v === null) return null;
    if (typeof v === "string") return v;
    return fail(400, `${k} must be a string`);
  };
  const account = field("account");
  const model = field("model");
  const effort = field("effort");
  const access = field("access");
  const device = field("device");
  const f = body.fast;
  const fast = f === undefined || f === null ? null : typeof f === "boolean" ? f : fail(400, "fast must be true or false");
  if (account === null && model === null && effort === null && access === null && device === null && fast === null) return null;
  const kindOf = (id: string): Kind | undefined => accounts.find((a) => a.id === id)?.kind;
  const oldKind = kindOf(c.account) ?? "Claude";
  const n: Chat = { ...c };
  if (account !== null) {
    const acc = accounts.find((x) => x.id === account && x.bin !== null);
    if (!acc) fail(400, `no account ${account}`);
    if (acc?.off === true && account !== c.account) fail(409, `${providers.short(acc)} is turned off in Settings › Providers on this PC`);
    if (!allowed.includes(account) && account !== c.account) fail(409, `can't switch to ${acc ? providers.short(acc) : account}: ${c.role === "lead" ? "a lead runs on Claude" : `a started chat stays on ${oldKind}`}`);
    n.account = account;
  }
  const kind = kindOf(n.account) ?? "Claude";
  const models = modelsFor(kind);
  if (model !== null) {
    if (models.length > 0 && !models.some((x) => x.id === model)) fail(400, `${kind} has no model ${model}`);
    n.model = model;
  } else if (kind !== oldKind) n.model = (models.find((m) => !m.more) ?? models[0])?.id ?? "";
  // Effort and access stay valid for the provider, as the composer keeps them.
  const efforts = providers.efforts(kind);
  if (effort !== null) {
    if (effort !== "" && !efforts.some((x) => x[0] === effort)) fail(400, `${kind} has no effort ${effort}`);
    n.effort = effort;
  } else if (n.effort !== "" && !efforts.some((x) => x[0] === n.effort)) n.effort = providers.defaultEffort(kind);
  const levels = providers.access(kind);
  if (access !== null) {
    if (!levels.some((x) => x[0] === access)) fail(400, `${kind} has no access level ${access}`);
    n.access = access as Chat["access"];
  } else if (!levels.some((x) => x[0] === n.access)) n.access = (levels[0]?.[0] ?? "full") as Chat["access"];
  if (device !== null && device !== c.device) {
    if (c.started) fail(409, "a started chat stays on the device it started on; start a new chat to use another");
    if (device !== "" && kind !== "Claude") fail(400, "only Claude chats run on another device");
    if (device !== "" && !devices.includes(device)) fail(400, `no device ${device}`);
    n.device = device;
  }
  if (fast === true && !providers.hasFast(kind)) fail(400, `${kind} has no fast mode`);
  return { chat: n, fast };
}

export function isRunError(e: unknown): e is RunError {
  return typeof e === "object" && e !== null && typeof (e as RunError).status === "number" && typeof (e as RunError).error === "string";
}
