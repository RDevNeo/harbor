// Where the WhatsApp app keeps things on this PC, and its engine: `whatsapp/` of this repository
// (GPL, since Baileys' Signal code is), fetched at the build's commit and checked against the
// hashes this build carries, its npm packages installed from the pinned lockfile by Harbor's own
// runtime. Nothing of it ships inside Harbor.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, privateDir } from "@harbor/store";
import ENGINE_SUMS from "../../../../whatsapp/SHA256SUMS" with { type: "text" };
import { buildRef, download, fileSha256, sha256Hex } from "./discordsetup.ts";

export const NAME = "whatsapp";
export const HOST = "whatsapp-host";

export function root(): string {
  return privateDir(join(privateDir(join(dataDir(), "apps")), NAME));
}

/** The host's socket (short name: socket paths are limited). */
export const socket = (): string => join(root(), "h.sock");
export const lockPath = (): string => join(root(), "h.lock");
export const authDir = (): string => join(root(), "auth");
export const dbPath = (): string => join(root(), "wa.db");
/** Written when the link is up, removed when it ends: what "linked" means to the rest of Harbor (no database to open for it). */
export const linkedPath = (): string => join(root(), "linked.json");
export const noticesPath = (): string => join(root(), "notices.jsonl");
export const logPath = (): string => join(root(), "host.log");

export interface Linked {
  jid: string;
  name: string;
  at: number;
}

export function linked(): Linked | undefined {
  try {
    const v = JSON.parse(readFileSync(linkedPath(), "utf8")) as Partial<Linked>;
    return typeof v.jid === "string" ? { jid: v.jid, name: typeof v.name === "string" ? v.name : "", at: typeof v.at === "number" ? v.at : 0 } : undefined;
  } catch {
    return undefined;
  }
}

/** Something for the user: the app turns it into a Harbor notification. */
export function notice(title: string, body: string, key: string): void {
  try {
    writeFileSync(noticesPath(), `${JSON.stringify({ title, body, key, at: Date.now() })}\n`, { flag: "a", mode: 0o600 });
  } catch {
    // a notice is a nicety
  }
}

/** The link's keys and mark (the host empties its database itself; the engine stays). */
export function wipe(): void {
  rmSync(authDir(), { recursive: true, force: true });
  rmSync(linkedPath(), { force: true });
}

/** (hash, file) of the engine's files. */
export function engineFiles(): [string, string][] {
  return ENGINE_SUMS.split("\n").flatMap((l): [string, string][] => {
    const i = l.indexOf("  ");
    return i >= 0 ? [[l.slice(0, i), l.slice(i + 2).trim()]] : [];
  });
}

/** The installed engine; `HARBOR_WHATSAPP_ENGINE` points a rig at a folder with the engine and its node_modules. */
export function engineDir(): string {
  return process.env.HARBOR_WHATSAPP_ENGINE ?? join(root(), `engine-${sha256Hex(ENGINE_SUMS).slice(0, 12)}`);
}

export function engineBase(): string {
  const ref = process.env.HARBOR_WHATSAPP_REF ?? buildRef();
  if (ref === undefined || ref === "") throw new Error("This Harbor was built from source without its commit, so it can't fetch its WhatsApp engine (a rig sets HARBOR_WHATSAPP_ENGINE).");
  return process.env.HARBOR_WHATSAPP_ENGINE_URL ?? `${process.env.HARBOR_WHATSAPP_ENGINE_ORIGIN ?? "https://raw.githubusercontent.com"}/RDevNeo/harbor/${ref}/whatsapp`;
}

/** Harbor's own runtime as Bun: `BUN_BE_BUN=1 <it> …` runs Bun's CLI (install, a script). */
export function bunCommand(): { exe: string; env: Record<string, string> } {
  return { exe: process.env.HARBOR_WHATSAPP_BUN ?? process.execPath, env: { BUN_BE_BUN: "1" } };
}

function run(exe: string, args: string[], cwd: string, env: Record<string, string>, ms: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      out += d.toString();
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), ms);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(out.trim().split("\n").slice(-3).join(" ") || `exit ${code}`));
    });
  });
}

const READY = ".installed";

/** The engine, fetched and installed once for this version of Harbor. */
export async function ensureEngine(say: (s: string) => void = () => {}): Promise<string> {
  const target = engineDir();
  if (process.env.HARBOR_WHATSAPP_ENGINE !== undefined) return target;
  if (existsSync(join(target, READY))) return target;
  const r = root();
  for (const n of readdirSync(r)) {
    const m = /^engine-.*\.tmp-(\d+)$/.exec(n);
    if (m !== null && !alive(Number(m[1]))) rmSync(join(r, n), { recursive: true, force: true });
  }
  const tmp = `${target}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  try {
    say("Downloading WhatsApp's engine…");
    const base = engineBase();
    for (const [want, rel] of engineFiles()) {
      const to = join(tmp, rel);
      try {
        await download(`${base}/${rel}`, to);
      } catch (e) {
        throw new Error(`Harbor couldn't download its WhatsApp engine (${rel}): ${e instanceof Error ? e.message : String(e)}`);
      }
      if ((await fileSha256(to)) !== want) throw new Error(`Harbor's WhatsApp engine (${rel}) doesn't match this version of Harbor.`);
    }
    say("Installing WhatsApp's engine…");
    const bun = bunCommand();
    // The lockfile pins every package and its hash; no install scripts run.
    await run(bun.exe, ["install", "--frozen-lockfile", "--production", "--omit", "peer", "--ignore-scripts", "--no-progress"], tmp, bun.env, 300_000);
    writeFileSync(join(tmp, READY), new Date().toISOString());
    for (const n of readdirSync(r)) if (/^engine-[0-9a-f]+$/.test(n) && join(r, n) !== target) rmSync(join(r, n), { recursive: true, force: true });
    try {
      renameSync(tmp, target);
    } catch (e) {
      if (!existsSync(join(target, READY))) throw e;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return target;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return pid !== process.pid;
  } catch {
    return false;
  }
}
