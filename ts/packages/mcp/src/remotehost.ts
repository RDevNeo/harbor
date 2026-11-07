// A single-host integration (WhatsApp, Discord) that another PC of the account runs: the hub's
// controller (ts/singlehost.ts) writes `remote.json` in the app's folder while that PC holds the
// vault's lease, and the app's relay here sends each request to it over the mesh
// (`POST /mesh/v1/app`), which answers only PCs signed in to the same account. Nothing secret is
// in the file: the other PC's mesh address and key, and the linked account's display name.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Dest, http, jsonBody, loadOrCreate, setHello } from "@harbor/net";
import { stateDir, writePrivate } from "@harbor/store";

export interface RemoteHost {
  /** The PC that runs it: its mesh id, name and how to reach it. */
  pc: { id: string; name: string; dest: Dest };
  /** This PC, as it says hello. */
  me: { id: string; name: string };
  /** The linked account as the host shows it ("Sam (+1 555…)"), "" when it isn't linked. */
  account: string;
  /** When the controller last wrote it (ms): an old file is ignored (the hub stopped). */
  at: number;
}

/** A file older than this is from a hub that's gone: the app runs here as it would alone. */
const FRESH = 5 * 60_000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function isDest(v: unknown): v is Dest {
  return isObj(v) && typeof v.addr === "string" && typeof v.fp === "string" && (v.via === undefined || v.via === null || isDest(v.via));
}

export const remotePath = (root: string): string => join(root, "remote.json");

export function remoteOf(root: string, now = Date.now()): RemoteHost | undefined {
  const p = remotePath(root);
  if (!existsSync(p)) return undefined;
  try {
    const v: unknown = JSON.parse(readFileSync(p, "utf8"));
    if (!isObj(v) || !isObj(v.pc) || !isObj(v.me) || typeof v.at !== "number" || now - v.at > FRESH) return undefined;
    const pc = v.pc;
    if (typeof pc.id !== "string" || typeof pc.name !== "string" || !isDest(pc.dest)) return undefined;
    return { pc: { id: pc.id, name: pc.name, dest: pc.dest }, me: { id: String(v.me.id ?? ""), name: String(v.me.name ?? "") }, account: typeof v.account === "string" ? v.account : "", at: v.at };
  } catch {
    return undefined;
  }
}

export function writeRemote(root: string, r: RemoteHost | null): void {
  if (r === null) rmSync(remotePath(root), { force: true });
  else writePrivate(remotePath(root), JSON.stringify(r));
}

let helloed = false;

/** One request to the app's host on the other PC; its answer as the local host gives it (`result`), or an error. */
export async function askRemote(app: string, r: RemoteHost, req: Record<string, unknown>, waitMs: number): Promise<unknown> {
  if (!helloed) {
    // A relay process of its own (an agent's turn): it speaks for this PC with this PC's key.
    try {
      setHello(r.me.id, r.me.name, loadOrCreate(stateDir()));
      helloed = true;
    } catch (e) {
      throw new Error(`This PC can't reach ${r.pc.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  let status: number;
  let body: unknown;
  try {
    [status, body] = await http(r.pc.dest, "POST", "/mesh/v1/app", jsonBody({ app, req: req as never, wait: waitMs }), waitMs + 15_000);
  } catch (e) {
    throw new Error(`${label(app)} runs on ${r.pc.name}, which this PC can't reach right now (${e instanceof Error ? e.message : String(e)}).`);
  }
  const o = isObj(body) ? body : {};
  if (status !== 200) throw new Error(typeof o.error === "string" ? o.error : `${r.pc.name} answered ${status}.`);
  if (o.ok === true) return o.result ?? null;
  throw new Error(typeof o.error === "string" ? o.error : `${label(app)} failed on ${r.pc.name}.`);
}

let claimHook: (app: string) => Promise<void> = async () => {};

/** The hub's controller (singlehost.ts): before a sign-in or link starts here, this PC takes the integration over. */
export function onSignInHere(f: (app: string) => Promise<void>): void {
  claimHook = f;
}

/** A sign-in or link of `app` starts on this PC: it becomes the PC that runs it (a no-op without the controller, in a relay). */
export async function claimHere(app: string): Promise<void> {
  try {
    await claimHook(app);
  } catch {
    // the controller's next round sorts it out
  }
}

const label = (app: string): string => (app === "whatsapp" ? "WhatsApp" : app === "discord" ? "Discord" : app);
