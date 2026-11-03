import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, createReadStream, createWriteStream, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join, isAbsolute } from "node:path";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";
import { dataDir, now, privateDir, writePrivate } from "@harbor/store";
import { isObj, message, sleep } from "./discordjson.ts";
import { selfExe } from "./sys.ts";
import SHELL_SUMS from "../../../../discord/SHA256SUMS" with { type: "text" };

export const ELECTRON = "45.1.0";
/** From the release's SHASUMS256.txt. */
export const ELECTRON_SUMS: Record<string, string> = {
  x64: "9dafab2c57ce209f8f716f8f3e4fddd8ffe0820e2455bfbbfc00b0fc13e03a3b",
  arm64: "64b78d93d1129ab805cdc0f2710f446716afbe814a1d08e639dab3175d2285a1",
};
const VENCORD_URL = "https://github.com/Vendicated/Vencord/releases/download/devbuild";
export const VENCORD_FILES = ["vencordDesktopMain.js", "vencordDesktopPreload.js", "vencordDesktopRenderer.js", "vencordDesktopRenderer.css"];
/** How often Vencord is checked for a new version. */
export const VENCORD_EVERY = 24 * 3600;
/** Versions kept on disk besides the current one, for rollback. */
const VENCORD_KEEP = 3;

export type Say = (s: string) => void;

export interface ClaudeAccount {
  bin: string;
  /** Variables to set; a null value removes the variable. */
  env: [string, string | null][];
}

/**
 * What the Discord app needs from the rest of Harbor. The update, agents and CLI packages aren't
 * ready to be imported, so the app wires them in with [`configure`].
 */
export interface Ports {
  /** The command that runs Harbor itself: `[...selfCommand, "app", "discord-host"]` starts the host. */
  selfCommand(): string[] | undefined;
  version(): string;
  /** The repository ref (commit or release tag) whose `discord/` goes with this build; undefined: a build from source. */
  shellRef(): string | undefined;
  /** A Claude Code login on this PC that repair may run; none: no account to use. */
  claude(): ClaudeAccount | undefined;
}

function defaultCommand(): string[] {
  if (process.env.HARBOR_EXE) return [selfExe()];
  return Bun.main.startsWith("/$bunfs/") ? [process.execPath] : [process.execPath, Bun.main];
}

let ports: Ports = { selfCommand: defaultCommand, version: () => "0.0.0", shellRef: () => undefined, claude: () => undefined };

export function configure(p: Partial<Ports>): void {
  ports = { ...ports, ...p };
}

export const version = (): string => ports.version();
export const selfCommand = (): string[] | undefined => ports.selfCommand();
export const claudeAccount = (): ClaudeAccount | undefined => ports.claude();

/** Harbor's own credential store. */
export function dir(): string {
  return privateDir(join(dataDir(), "apps"));
}

export function root(): string {
  return privateDir(join(dir(), "discord"));
}

/** The Chromium profile: the session, and nothing else of Harbor's. */
export function profile(): string {
  return privateDir(join(root(), "profile"));
}

/** The host's socket (short name: socket paths are limited). */
export function socket(): string {
  return join(root(), "h.sock");
}

export const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

export async function fileSha256(p: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(p)) h.update(chunk as Buffer);
  return h.digest("hex");
}


/** Fetches `url` to `to`, telling how far it got (bytes so far) about every half second. */
export async function download(url: string, to: string, progress: (n: number) => void = () => {}): Promise<void> {
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const abort = new AbortController();
    const connect = setTimeout(() => abort.abort(), 20_000);
    try {
      const res = await fetch(url, { signal: abort.signal, redirect: "follow" });
      clearTimeout(connect);
      if (!res.ok || res.body === null) {
        last = `HTTP ${res.status}`;
        if (res.status < 500 && res.status !== 408 && res.status !== 429) break;
        await sleep(500);
        continue;
      }
      const file = await open(to, "w");
      let got = 0;
      let reported = 0;
      try {
        for await (const chunk of res.body) {
          await file.write(chunk);
          got += chunk.byteLength;
          if (Date.now() - reported >= 500) {
            reported = Date.now();
            progress(got);
          }
        }
      } finally {
        await file.close();
      }
      progress(got);
      return;
    } catch (e) {
      clearTimeout(connect);
      last = message(e);
      await sleep(500);
    }
  }
  rmSync(to, { force: true });
  throw new Error(`Couldn't download ${url}: ${last}`);
}


function arch(): string {
  switch (process.arch) {
    case "x64":
      return "x64";
    case "arm64":
      return "arm64";
    default:
      throw new Error(`Discord needs Electron, which isn't built for ${process.arch}.`);
  }
}

/** The Electron binary; `HARBOR_DISCORD_ELECTRON` points a test rig at its own. */
export function electronBin(): string {
  return process.env.HARBOR_DISCORD_ELECTRON ?? join(root(), `electron-${ELECTRON}`, "electron");
}

/** Downloads and unpacks Electron once. */
export async function ensureElectron(say: Say, sums: Record<string, string> = ELECTRON_SUMS): Promise<void> {
  if (existsSync(electronBin())) return;
  const a = arch();
  const want = sums[a];
  if (want === undefined) throw new Error("no pinned Electron");
  const name = `electron-v${ELECTRON}-linux-${a}.zip`;
  const zip = join(root(), `${name}.part`);
  const override = process.env.HARBOR_DISCORD_ELECTRON_URL;
  const url = override !== undefined ? `${override}/${name}` : `https://github.com/electron/electron/releases/download/v${ELECTRON}/${name}`;
  await download(url, zip, (n) => say(`Downloading Electron… ${n >> 20} MB of 120`));
  say("Checking the download…");
  if ((await fileSha256(zip)) !== want) {
    rmSync(zip, { force: true });
    throw new Error("The Electron download doesn't match its checksum.");
  }
  say("Unpacking…");
  const tmp = join(root(), `electron-${ELECTRON}.tmp`);
  rmSync(tmp, { recursive: true, force: true });
  await unzip(zip, tmp);
  rmSync(zip, { force: true });
  renameSync(tmp, join(root(), `electron-${ELECTRON}`));
}

const le = (b: Buffer, at: number, n: number): number => {
  let v = 0;
  for (let i = n - 1; i >= 0; i--) v = v * 256 + (b[at + i] ?? 0);
  return v;
};

const DAMAGED = "The zip file is damaged.";

function readAt(fd: number, at: number, len: number): Buffer {
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = readSync(fd, buf, got, len - got, at + got);
    if (n === 0) throw new Error(DAMAGED);
    got += n;
  }
  return buf;
}

/** Unpacks a zip (stored or deflated, no zip64: Electron's isn't) with its file modes. */
export async function unzip(zip: string, to: string): Promise<void> {
  const fd = openSync(zip, "r");
  try {
    const len = fstatSync(fd).size;
    const tail = Math.min(len, 70_000);
    const end = readAt(fd, len - tail, tail);
    const eocd = end.lastIndexOf(Buffer.from("PK\x05\x06", "latin1"));
    if (eocd < 0) throw new Error(DAMAGED);
    const count = le(end, eocd + 10, 2);
    const size = le(end, eocd + 12, 4);
    const start = le(end, eocd + 16, 4);
    const dirBytes = readAt(fd, start, size);
    let at = 0;
    for (let i = 0; i < count; i++) {
      if (dirBytes.length < at + 46 || dirBytes.toString("latin1", at, at + 4) !== "PK\x01\x02") throw new Error(DAMAGED);
      const method = le(dirBytes, at + 10, 2);
      const comp = le(dirBytes, at + 20, 4);
      const nlen = le(dirBytes, at + 28, 2);
      const xlen = le(dirBytes, at + 30, 2);
      const clen = le(dirBytes, at + 32, 2);
      const attrs = Math.floor(le(dirBytes, at + 38, 4) / 65536);
      const local = le(dirBytes, at + 42, 4);
      if (dirBytes.length < at + 46 + nlen) throw new Error(DAMAGED);
      const name = dirBytes.toString("utf8", at + 46, at + 46 + nlen);
      at += 46 + nlen + xlen + clen;
      if (isAbsolute(name) || name.split("/").includes("..")) throw new Error(DAMAGED);
      const out = join(to, name);
      if (name.endsWith("/")) {
        mkdirSync(out, { recursive: true });
        continue;
      }
      mkdirSync(dirname(out), { recursive: true });
      const head = readAt(fd, local, 30);
      if (head.toString("latin1", 0, 4) !== "PK\x03\x04") throw new Error(DAMAGED);
      const data = local + 30 + le(head, 26, 2) + le(head, 28, 2);
      if (method !== 0 && method !== 8) throw new Error(DAMAGED);
      const body = (): NodeJS.ReadableStream => createReadStream(zip, { start: data, end: data + comp - 1 });
      // A symlink's contents are its target (attrs: st_mode in the high half).
      if ((attrs & 0o170000) === 0o120000) {
        const raw = readAt(fd, data, comp);
        const target = method === 8 ? (await inflate(raw)).toString("utf8") : raw.toString("utf8");
        symlinkSync(target, out);
        continue;
      }
      if (comp === 0) {
        writeFileSync(out, "");
      } else if (method === 0) {
        await pipeline(body(), createWriteStream(out));
      } else {
        await pipeline(body(), createInflateRaw(), createWriteStream(out));
      }
      if ((attrs & 0o777) !== 0) chmodSync(out, attrs & 0o777);
    }
  } finally {
    closeSync(fd);
  }
}

async function inflate(raw: Buffer): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const z = createInflateRaw();
  z.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((res, rej) => {
    z.once("end", res);
    z.once("error", rej);
  });
  z.end(raw);
  await done;
  return Buffer.concat(chunks);
}


/** (hash, relative path) of each of the shell's files. */
export function shellFiles(): [string, string][] {
  const out: [string, string][] = [];
  for (const l of SHELL_SUMS.split("\n")) {
    const i = l.indexOf("  ");
    if (i >= 0) out.push([l.slice(0, i), l.slice(i + 2)]);
  }
  return out;
}

/** The commit (or tag) of this repository whose `discord/` this build goes with: the build's own, never a version guessed at run time. */
export function shellRef(): string {
  const r = process.env.HARBOR_DISCORD_REF ?? ports.shellRef();
  if (r === undefined || r === "") throw new Error("This Harbor was built from source without its commit, so it can't fetch its Discord shell (a rig sets HARBOR_DISCORD_SHELL).");
  return r;
}

/** Where the shell's files come from. */
export function shellBase(): string {
  // HARBOR_DISCORD_SHELL_ORIGIN: a test's stand-in for GitHub, with the same paths.
  return process.env.HARBOR_DISCORD_SHELL_URL ?? `${process.env.HARBOR_DISCORD_SHELL_ORIGIN ?? "https://raw.githubusercontent.com"}/RDevNeo/harbor/${shellRef()}/discord`;
}

/** Downloads that a process left half done (`shell-….tmp-<pid>`, or an older Harbor's `shell-….tmp`). */
function staleTmp(name: string): boolean {
  const m = /^shell-.*\.tmp(?:-(\d+))?$/.exec(name);
  if (m === null) return false;
  if (m[1] === undefined) return true;
  try {
    process.kill(Number(m[1]), 0);
    return Number(m[1]) === process.pid;
  } catch {
    return true;
  }
}

/** The installed shell; `HARBOR_DISCORD_SHELL` points a test rig at a checkout's `discord/`. */
export function shellDir(): string {
  return process.env.HARBOR_DISCORD_SHELL ?? join(root(), `shell-${sha256Hex(SHELL_SUMS).slice(0, 12)}`);
}

/** Fetches the shell once, for this version of Harbor. */
export async function ensureShell(say: Say): Promise<void> {
  const target = shellDir();
  for (const name of readdirSync(root())) if (staleTmp(name)) rmSync(join(root(), name), { recursive: true, force: true });
  if (existsSync(join(target, "main.js"))) return;
  say("Downloading Harbor's Discord shell…");
  // Its own folder: another of Harbor's processes may be fetching the same shell right now.
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    const base = shellBase();
    for (const [want, rel] of shellFiles()) {
      const to = join(tmp, rel);
      mkdirSync(dirname(to), { recursive: true });
      try {
        await download(`${base}/${rel}`, to);
      } catch (e) {
        throw new Error(`Harbor couldn't download its Discord shell (${rel} from ${base}): ${e instanceof Error ? e.message : String(e)}`);
      }
      if ((await fileSha256(to)) !== want) throw new Error(`Harbor's Discord shell (${rel}) doesn't match this version of Harbor.`);
    }
    if (existsSync(join(target, "main.js"))) return;
    // Earlier Harbors' shells: this one replaces them (not what other processes are still fetching).
    for (const name of readdirSync(root())) {
      const p = join(root(), name);
      if (name.startsWith("shell-") && p !== tmp && !/\.tmp-\d+$/.test(name)) rmSync(p, { recursive: true, force: true });
    }
    try {
      renameSync(tmp, target);
    } catch (e) {
      // Another process got there first with the same files.
      if (!existsSync(join(target, "main.js"))) throw e;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}


/** Which Vencord runs (`vencord.json`). Versions are folders under `vencord/`, named by content. */
export class Vencords {
  /** What the next start uses. */
  current = "";
  /** The last one that passed the self-test. */
  good = "";
  /** Failed it: never tried again. */
  bad: string[] = [];
  /** When a new version was last looked for. */
  checked = 0;

  /** A version was downloaded: the next start tries it, unless it already failed. */
  offer(id: string): void {
    if (!this.bad.includes(id)) this.current = id;
  }

  /** It passed the self-test. */
  passed(): void {
    this.good = this.current;
  }

  /**
   * It failed. True: went back to the last good version, try that. False: there's nothing to go
   * back to, so it isn't Vencord's update that broke things.
   */
  rollback(): boolean {
    if (this.good === "" || this.current === this.good) return false;
    this.bad.push(this.current);
    this.current = this.good;
    return true;
  }

  static load(): Vencords {
    const v = new Vencords();
    try {
      const j: unknown = JSON.parse(readFileSync(vencordsPath(), "utf8"));
      if (typeof j === "object" && j !== null) {
        const o = j as Record<string, unknown>;
        if (typeof o.current === "string") v.current = o.current;
        if (typeof o.good === "string") v.good = o.good;
        if (Array.isArray(o.bad)) v.bad = o.bad.filter((b): b is string => typeof b === "string");
        if (typeof o.checked === "number") v.checked = o.checked;
      }
    } catch {
      // no file yet, or one that isn't ours: start clean
    }
    return v;
  }

  save(): void {
    try {
      writePrivate(vencordsPath(), JSON.stringify({ current: this.current, good: this.good, bad: this.bad, checked: this.checked }, null, 2));
    } catch {
      // the next check writes it again
    }
  }
}

const vencordsPath = (): string => join(root(), "vencord.json");
const vencordRoot = (): string => privateDir(join(root(), "vencord"));

export const vencordDir = (id: string): string => join(vencordRoot(), id);

/** Downloads Vencord's current release; its id. The files only count once all are here. */
export async function fetchVencord(): Promise<string> {
  const base = process.env.HARBOR_DISCORD_VENCORD_URL ?? VENCORD_URL;
  const tmp = join(vencordRoot(), `new-${process.pid}`);
  mkdirSync(tmp, { recursive: true });
  for (const f of VENCORD_FILES) {
    try {
      await download(`${base}/${f}`, join(tmp, f));
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
  }
  const id = (await fileSha256(join(tmp, "vencordDesktopRenderer.js"))).slice(0, 12);
  const target = vencordDir(id);
  if (existsSync(target)) {
    rmSync(tmp, { recursive: true, force: true });
  } else {
    writeFileSync(join(tmp, "package.json"), "{}");
    renameSync(tmp, target);
  }
  return id;
}

/** Has a Vencord to run; a failed check just keeps what's here. */
export async function ensureVencord(say: Say): Promise<Vencords> {
  const v = Vencords.load();
  if (v.current === "" || !existsSync(vencordDir(v.current))) {
    say("Downloading Vencord…");
    v.offer(await fetchVencord());
    v.checked = now();
    v.save();
  }
  return v;
}

/**
 * Looks for a new Vencord, at most daily, or hourly when something's `broken` and a newer one
 * might be the fix. True: the next start runs another version.
 */
export async function checkVencord(broken: boolean): Promise<boolean> {
  const v = Vencords.load();
  if (now() - v.checked < (broken ? 3600 : VENCORD_EVERY)) return false;
  v.checked = now();
  const was = v.current;
  try {
    v.offer(await fetchVencord());
  } catch {
    // offline: what's here keeps running
  }
  v.save();
  pruneVencords(v);
  return v.current !== was;
}

function pruneVencords(v: Vencords): void {
  const dirs: [number, string][] = [];
  for (const name of readdirSync(vencordRoot())) {
    if (name === v.current || name === v.good) continue;
    const p = join(vencordRoot(), name);
    try {
      dirs.push([statSync(p).mtimeMs, p]);
    } catch {
      continue;
    }
  }
  dirs.sort((a, b) => b[0] - a[0]);
  for (const [, d] of dirs.slice(VENCORD_KEEP)) rmSync(d, { recursive: true, force: true });
}


/**
 * Text that repair may never add to the tool script: nothing it adds may reach the network or the
 * session, or hide what it does. The self-test and the notice are the other half of the check.
 */
const NOT_IN_EDITS = [
  "fetch(", "api(", "XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon", "postMessage", "eval(", "Function(", "import(", "require(", "localStorage", "sessionStorage", "indexedDB",
  "document.cookie", "getToken", "getCachedToken", "getAuthToken", "http:", "https:", "ws:", "wss:", "//", "atob", "btoa", "fromCharCode", "constructor", "__proto__", "\\x", "\\u", "$harbor",
];

export interface Edit {
  old: string;
  new: string;
  why: string;
}

/**
 * Repair's local edits to the tool script. They belong to one version of it (`base`, its hash): a
 * new Harbor brings its own script, and with it the real fix.
 */
export interface Override {
  base: string;
  edits: Edit[];
  at: number;
}

const overridePath = (): string => join(root(), "override.json");

export function baseScript(): string {
  return readFileSync(join(shellDir(), "page/harbor.js"), "utf8");
}

function countOf(s: string, needle: string): number {
  if (needle === "") return s.length + 1;
  let n = 0;
  for (let i = s.indexOf(needle); i >= 0; i = s.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** `script` with `edits` applied; each one's old text must be there exactly once. */
export function applyEdits(script: string, edits: Edit[]): string {
  let s = script;
  for (const e of edits) {
    const w = NOT_IN_EDITS.find((x) => e.new.includes(x) && !e.old.includes(x));
    if (w !== undefined) throw new Error(`Edits can't add \`${w}\`: repairs only change how Discord's internals are found.`);
    const n = countOf(s, e.old);
    if (n === 0) throw new Error("`old` isn't in the script: read it again first.");
    if (n > 1) throw new Error(`\`old\` is in the script ${n} times: give more of its surroundings.`);
    const i = s.indexOf(e.old);
    s = s.slice(0, i) + e.new + s.slice(i + e.old.length);
  }
  return s;
}

export function loadOverride(base: string): Override | undefined {
  try {
    const o = JSON.parse(readFileSync(overridePath(), "utf8")) as Partial<Override>;
    if (typeof o.base !== "string" || !Array.isArray(o.edits) || o.base !== sha256Hex(base)) return undefined;
    const edits = o.edits.map((e): Edit => ({ old: String(e.old ?? ""), new: String(e.new ?? ""), why: String(e.why ?? "") }));
    return { base: o.base, edits, at: typeof o.at === "number" ? o.at : 0 };
  } catch {
    return undefined;
  }
}

/** Adds repair's edit to the override. */
export function addEdit(e: Edit): void {
  const base = baseScript();
  const o = loadOverride(base) ?? { base: sha256Hex(base), edits: [], at: 0 };
  o.edits.push(e);
  applyEdits(base, o.edits);
  o.at = now();
  writePrivate(overridePath(), JSON.stringify(o, null, 2));
}

/** The tool script as it runs: the shell's, with repair's edits. Written where the shell reads it. */
export function writeLiveScript(): string {
  const base = baseScript();
  const edits = loadOverride(base)?.edits ?? [];
  // Edits that no longer apply are dropped, not fatal: the plain script still runs.
  let s = base;
  try {
    s = applyEdits(base, edits);
  } catch {
    s = base;
  }
  const p = join(root(), "page.js");
  writePrivate(p, s);
  return p;
}

export function liveScript(): string {
  return readFileSync(writeLiveScript(), "utf8");
}


/**
 * The signed-in account (`account.json`): its name for the card. The session itself is in the
 * profile, so this holds no secret.
 */
export type Account = {
  id: string;
  username: string;
  name: string;
  at: number;
};

export const accountPath = (): string => join(root(), "account.json");

/**
 * Harbor's captcha view: on unless turned off (a file `no-captcha-view` here; the rigs set
 * HARBOR_DISCORD_CAPTCHA_VIEW=0). It needs the signed-in page without site isolation; the shell
 * then lets the page hold frames from Discord and hCaptcha only. It takes effect when the client
 * next starts. Off, a join behind a captcha is for the user's own Discord app.
 */
export function captchaView(): boolean {
  return process.env.HARBOR_DISCORD_CAPTCHA_VIEW !== "0" && !existsSync(join(root(), "no-captcha-view"));
}

export function account(): Account | undefined {
  try {
    const a: unknown = JSON.parse(readFileSync(accountPath(), "utf8"));
    if (!isObj(a) || typeof a.id !== "string" || typeof a.username !== "string" || typeof a.name !== "string") return undefined;
    return { id: a.id, username: a.username, name: a.name, at: typeof a.at === "number" ? a.at : 0 };
  } catch {
    return undefined;
  }
}

/** A note for Harbor's notifications: the running app picks these up (discord.ts `watch`). */
/** `key`: notifications with the same key replace each other; the phone opens the captcha for `discord-captcha`. */
export function notice(title: string, body: string, key?: string): void {
  try {
    appendFileSync(join(root(), "notices.jsonl"), `${JSON.stringify({ title, body, at: now(), ...(key !== undefined ? { key } : {}) })}\n`);
  } catch {
    // a note nobody can read is not worth failing for
  }
}
