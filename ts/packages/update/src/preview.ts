import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, chmodSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import type { UpdateConfig } from "./config.ts";
import { ensureDir, isFile, readJson, remove, replace, RUNTIME_FILE } from "./files.ts";
import { onDisk, runSmoke } from "./install.ts";
import { forget, OPT_IN, OUT, readMeta, SLOT, writeMeta, type Meta } from "./previewmeta.ts";
import { newer } from "./version.ts";

export { readMeta, type Meta };

export interface Offer {
  id: string;
  sha256: string;
  note: string;
  // The Rust app's previews are binaries: an offer without this is refused.
  kind: "bundle";
}

export interface PushRequest {
  path: string;
  id: string;
  note?: string;
}

export const USAGE = "Usage: harbor preview [status [--json]|on|off|back|push <bundle> --id <id> [--note <text>] [--wait]]";

const WAIT_LIMIT_MS = 30_000 + 10_000;

export const running = (cfg: UpdateConfig): boolean => cfg.preview;

export const enabled = (cfg: UpdateConfig): boolean => cfg.dir !== null && isFile(join(cfg.dir, OPT_IN));

export function setEnabled(cfg: UpdateConfig, on: boolean): void {
  if (cfg.dir === null) throw new Error("this copy wasn't installed by install.sh");
  if (on) writeFileSync(join(cfg.dir, OPT_IN), "");
  else remove(join(cfg.dir, OPT_IN));
}

export const meta = (cfg: UpdateConfig): Meta | null => (cfg.dir === null ? null : readMeta(cfg.dir));

export async function sha256(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

export function versionIn(line: string): string | null {
  const w = line.trim().split(/\s+/);
  return w[0] === "harbor" && w[1] !== undefined && w[1] !== "" ? w[1] : null;
}

export const superseded = (version: string, release: string | null): boolean => release !== null && newer(release, version);

async function install(cfg: UpdateConfig, dir: string, src: string, id: string, note: string, from: string): Promise<Meta> {
  const fresh = join(dir, "harbor-preview.new.js");
  copyFileSync(src, fresh);
  try {
    chmodSync(fresh, 0o644);
    const said = await runSmoke(join(dir, RUNTIME_FILE), ["smoke-bundle", fresh]).catch((e: Error) => {
      throw new Error(`it doesn't run here: ${e.message}`);
    });
    const version = versionIn(said);
    if (version === null) throw new Error("that isn't Harbor");
    const release = onDisk(cfg);
    if (superseded(version, release)) throw new Error(`this build is ${version}, older than the release here (${release ?? ""})`);
    const sha = await sha256(fresh);
    const m: Meta = { id: id.slice(0, 40), sha256: sha, version, note: note.slice(0, 120), from, at: Math.floor(cfg.now() / 1000), stage: "trying", why: "", shown_ms: 0 };
    replace(fresh, join(dir, SLOT));
    writeMeta(dir, m);
    return m;
  } catch (e) {
    remove(fresh);
    throw e;
  }
}

function keep(dir: string, src: string, o: Offer): void {
  const out = ensureDir(join(dir, OUT));
  const tmp = join(out, "harbor-app.js.new");
  copyFileSync(src, tmp);
  replace(tmp, join(out, "harbor-app.js"));
  writeFileSync(join(out, "offer.json"), JSON.stringify(o));
}

export async function received(cfg: UpdateConfig, v: Partial<PushRequest>): Promise<{ here: boolean; offer: Offer }> {
  if (cfg.dir === null) throw new Error("this copy wasn't installed by install.sh");
  const dir = cfg.dir;
  if (typeof v.path !== "string" || typeof v.id !== "string" || v.id === "") throw new Error("a preview needs a path and an id");
  if (!isFile(v.path)) throw new Error(`no such file: ${v.path}`);
  const note = v.note ?? "";
  const here = enabled(cfg) ? await install(cfg, dir, v.path, v.id, note, "") : null;
  const offer: Offer = { id: v.id, sha256: here?.sha256 ?? (await sha256(v.path)), note, kind: "bundle" };
  keep(dir, v.path, offer);
  return { here: here !== null, offer };
}

export function offeredFile(cfg: UpdateConfig, kind: string, id: string): string | null {
  if (cfg.dir === null || kind !== "bundle") return null;
  const out = join(cfg.dir, OUT);
  const o = readJson<Partial<Offer>>(join(out, "offer.json"));
  const p = join(out, "harbor-app.js");
  return o !== null && o.id === id && isFile(p) ? p : null;
}

export function refuses(cfg: UpdateConfig, fullAccess: boolean, offer?: { kind?: unknown }): string | null {
  if (!enabled(cfg)) return "previews are off on this PC";
  if (!fullAccess) return "this PC doesn't give that one full access (Settings › Workspace)";
  if (offer !== undefined && offer.kind !== "bundle") return "that preview is a build of the Rust app, which this PC can't run";
  return null;
}

export async function fetchOffer(cfg: UpdateConfig, o: Offer, from: string, get: (kind: "bundle", to: string) => Promise<void>): Promise<Meta> {
  if (cfg.dir === null) throw new Error("not an installed copy");
  const dir = cfg.dir;
  const tmp = join(dir, ".preview-fetch");
  try {
    await get("bundle", tmp);
    if ((await sha256(tmp)) !== o.sha256) throw new Error("the file that came isn't the one offered");
    cfg.log(`preview ${o.id} from ${from}`);
    return await install(cfg, dir, tmp, o.id, o.note, from);
  } finally {
    remove(tmp);
  }
}

export function takes(update: unknown): boolean {
  if (typeof update !== "object" || update === null) return false;
  const u = update as Record<string, unknown>;
  return u.preview_on === true && u.preview_kind === "bundle";
}

export function giveUp(cfg: UpdateConfig): void {
  if (cfg.dir !== null) forget(cfg.dir);
}

export const failed = (cfg: UpdateConfig): Meta | null => {
  const m = meta(cfg);
  return m !== null && m.stage === "failed" ? m : null;
};

export function label(cfg: UpdateConfig): string | null {
  return running(cfg) ? `preview ${meta(cfg)?.id ?? "?"}` : null;
}

export function previewInfo(cfg: UpdateConfig): { preview_on: boolean; preview_kind: "bundle"; preview: { id: string; note: string; from: string; at: number } | null } {
  const m = running(cfg) ? meta(cfg) : null;
  return { preview_on: enabled(cfg), preview_kind: "bundle", preview: m === null ? null : { id: m.id, note: m.note, from: m.from, at: m.at } };
}

export interface Hooks {
  announce: (o: Offer) => void;
  restart: () => void | Promise<void>;
}

export async function pushed(cfg: UpdateConfig, v: Partial<PushRequest>, hooks: Hooks): Promise<{ ok: boolean; restarting?: boolean; text: string }> {
  try {
    const { here, offer } = await received(cfg, v);
    hooks.announce(offer);
    if (here) await hooks.restart();
    return { ok: true, restarting: here, text: here ? "" : "Previews are off on this PC (harbor preview on): only offered to the other PCs." };
  } catch (e) {
    return { ok: false, text: e instanceof Error ? e.message : String(e) };
  }
}

export async function back(cfg: UpdateConfig, off: boolean, restart: () => void | Promise<void>): Promise<void> {
  giveUp(cfg);
  if (off) setEnabled(cfg, false);
  if (running(cfg)) await restart();
}

export function ask(v: unknown, path: string, timeoutMs = 60_000): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const s = createConnection(path);
    let buf = "";
    const done = (r: Record<string, unknown> | null): void => {
      s.destroy();
      resolve(r);
    };
    s.setTimeout(timeoutMs, () => done(null));
    s.on("connect", () => s.write(`${JSON.stringify(v)}\n`));
    s.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      try {
        done(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>);
      } catch {
        done(null);
      }
    });
    s.on("error", () => done(null));
    s.on("close", () => done(null));
  });
}

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
  ask: (v: unknown) => Promise<Record<string, unknown> | null>;
  sleep: (ms: number) => Promise<void>;
}

async function wait(cfg: UpdateConfig, dir: string, id: string, pushedMs: number, io: Io): Promise<number> {
  const start = cfg.now();
  for (;;) {
    const m = readMeta(dir);
    const mine = m !== null && m.id === id ? m : null;
    const waited = cfg.now() - start;
    if (mine?.stage === "ok") {
      io.out(`on screen ${mine.shown_ms - pushedMs} ms after the push, confirmed ${cfg.now() - pushedMs} ms after it`);
      return 0;
    }
    if (mine?.stage === "failed") {
      io.err(`harbor: ${id} failed to start (${mine.why}): back on the release`);
      return 1;
    }
    if (mine === null && waited > 5000) {
      io.err(`harbor: ${id} isn't this PC's preview any more`);
      return 1;
    }
    if (waited > WAIT_LIMIT_MS) {
      io.err(`harbor: no word from ${id}`);
      return 1;
    }
    await io.sleep(50);
  }
}

export async function cli(cfg: UpdateConfig, args: string[], io: Io): Promise<number> {
  const opt = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
  };
  const verb = args[0] ?? "status";
  switch (verb) {
    case "status": {
      const m = meta(cfg);
      if (args.includes("--json")) io.out(JSON.stringify({ on: enabled(cfg), preview: m, managed: cfg.dir !== null }));
      else {
        io.out(`Previews are ${enabled(cfg) ? "on" : "off"} on this PC.`);
        io.out(m === null ? "Running the release." : `${m.id}: ${m.stage}${m.note === "" ? "" : `, ${m.note}`}${m.why === "" ? "" : ` (${m.why})`}`);
      }
      return 0;
    }
    case "on":
      try {
        setEnabled(cfg, true);
      } catch (e) {
        io.err(`harbor: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
      io.out("Previews are on: this PC restarts into a build as soon as one arrives, from this PC or another with full access here.");
      return 0;
    case "off":
    case "back": {
      const off = verb === "off";
      if ((await io.ask({ preview_back: true, off })) === null) {
        giveUp(cfg);
        if (off && cfg.dir !== null) setEnabled(cfg, false);
      }
      io.out(`Back on the release${off ? ", previews off" : ""}.`);
      return 0;
    }
    case "push": {
      const path = args[1];
      const id = opt("--id");
      if (path === undefined || id === undefined) {
        io.err(USAGE);
        return 2;
      }
      if (!isFile(path)) {
        io.err(`harbor: no such file: ${path}`);
        return 2;
      }
      const pushedMs = cfg.now();
      const call = { path: resolve(path), id, note: opt("--note") ?? "" };
      const r =
        (await io.ask({ preview: call })) ??
        (await received(cfg, call).then(
          (x) => ({ ok: true, restarting: false, here: x.here }) as Record<string, unknown>,
          (e: Error) => ({ ok: false, text: e.message }) as Record<string, unknown>,
        ));
      if (r.ok !== true) {
        io.err(`harbor: ${typeof r.text === "string" ? r.text : "Harbor did not answer"}`);
        return 1;
      }
      if (r.restarting !== true) {
        io.out(typeof r.text === "string" && r.text !== "" ? r.text : "Kept: the next start runs it.");
        return 0;
      }
      return args.includes("--wait") && cfg.dir !== null ? wait(cfg, cfg.dir, id, pushedMs, io) : 0;
    }
    default:
      io.err(USAGE);
      return 2;
  }
}
