// The Node.js Harbor brings along, so node, npm and npx work for agents' shells and MCP servers (the built-in
// Playwright server is `npx …`) on a PC where nobody installed Node. A Node of the user's on PATH wins: then
// nothing is downloaded. Else the pinned LTS (@harbor/os nodedist) is fetched from nodejs.org in the
// background shortly after Harbor starts, checked against its pinned SHA-256, unpacked into a temporary folder
// and renamed into `<data>/runtimes/<folder>` whole: a half-done install is never seen and leaves nothing behind.
// A failure (offline, a hash that doesn't match) is logged and tried again on the next start (or after
// RETRY_MS); Harbor never waits for it, except an MCP server that is node, npm or npx (bridge.ts), which can.
import { createHash, randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { env as osEnv, type nodedist as NodeDistNs, nodedist } from "@harbor/os";
import { dataDir } from "./paths.ts";

type NodeDist = NodeDistNs.NodeDist;

export type Status =
  | { kind: "idle" }
  | { kind: "user" }
  | { kind: "installing" }
  | { kind: "ready"; bin: string }
  | { kind: "failed"; error: string; at: number }
  | { kind: "unsupported" };

/** A failed install is tried again after this long (and on every start). */
export const RETRY_MS = 10 * 60_000;
/** Bigger than any Node archive: a download past this is not one. */
const MAX_BYTES = 200 * 1024 * 1024;

/** Where Harbor's runtimes go: `<data>/runtimes`. */
export function runtimesDir(env: Record<string, string | undefined> = process.env): string {
  return join(dataDir(env), "runtimes");
}

/** The managed Node's programs folder for `dist` under `root`. */
export function binOf(root: string, dist: NodeDist): string {
  return dist.bin === "" ? join(root, dist.folder) : join(root, dist.folder, dist.bin);
}

let status: Status = { kind: "idle" };
let inflight: Promise<string | null> | null = null;
/** The managed bin folder once seen (it never goes away while Harbor runs), and when it was last looked for. */
let seen: string | null = null;
let lookedAt = 0;
const listeners = new Set<() => void>();

export function current(): Status {
  return status;
}

/** Called on every change of `current()` (the settings page draws the Playwright chip's tip from it). */
export function onChange(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

function set(s: Status): void {
  status = s;
  for (const f of listeners) {
    try {
      f();
    } catch {
      // a listener's own problem
    }
  }
}

/**
 * The managed Node's bin folder when it's installed, else null. Cheap enough for every childPath(): once found
 * it's remembered; not found, the disk is looked at again at most every 5 s (another Harbor process may install it).
 */
export function managedBin(env: Record<string, string | undefined> = process.env): string | null {
  if (seen !== null) return seen;
  const t = Date.now();
  if (t - lookedAt < 5000) return null;
  lookedAt = t;
  const dist = nodedist.distFor();
  if (dist === null) return null;
  const bin = binOf(runtimesDir(env), dist);
  if (isFile(join(bin, dist.node))) seen = bin;
  return seen;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** `name` as a program in one of `path`'s folders, Windows' suffixes too. */
export function onPath(name: string, path: string, skip: string | null = null): string | null {
  const suffixes = osEnv.execSuffixes();
  for (const d of path.split(delimiter)) {
    if (d === "" || (skip !== null && d === skip)) continue;
    for (const x of suffixes) {
      const p = join(d, name + x);
      if (isFile(p)) return p;
    }
  }
  return null;
}

/** Whether the user's own Node (node and npx) is on `path`, the managed one aside. */
export function userHasNode(path: string): boolean {
  const managed = managedBin();
  return onPath("node", path, managed) !== null && onPath("npx", path, managed) !== null;
}

export interface Options {
  /** PATH without the managed Node (providers.basePath()): a user's node and npx there mean nothing to do. */
  path: string;
  /** Where runtimes go (tests: a temporary folder). */
  root?: string;
  dist?: NodeDist | null;
  fetch?: typeof fetch;
  /** Checks the unpacked node runs here (default: `node --version`); throws when not. */
  check?: (node: string) => Promise<void>;
  /** Try now even if the last attempt failed less than RETRY_MS ago. */
  force?: boolean;
}

/**
 * The managed Node's bin folder, installing it first when needed: null when the user has their own Node, this
 * PC has no official build, or the install failed (current() says why). One install at a time per process.
 */
export function ensure(o: Options): Promise<string | null> {
  const root = o.root ?? runtimesDir();
  const dist = o.dist === undefined ? nodedist.distFor() : o.dist;
  if (dist === null) {
    set({ kind: "unsupported" });
    return Promise.resolve(null);
  }
  const bin = binOf(root, dist);
  if (o.root === undefined && seen !== null) return Promise.resolve(seen);
  if (isFile(join(bin, dist.node))) {
    if (o.root === undefined) seen = bin;
    if (status.kind !== "ready") set({ kind: "ready", bin });
    return Promise.resolve(bin);
  }
  if (userHasNode(o.path)) {
    if (status.kind !== "user") set({ kind: "user" });
    return Promise.resolve(null);
  }
  if (inflight) return inflight;
  // Tests never reach nodejs.org: they hand in their own fetch. HARBOR_NODE=0: never downloaded.
  if (o.fetch === undefined && (process.env.NODE_ENV === "test" || process.env.HARBOR_NODE === "0")) return Promise.resolve(null);
  if (status.kind === "failed" && !o.force && Date.now() - status.at < RETRY_MS) return Promise.resolve(null);
  set({ kind: "installing" });
  const started = Date.now();
  inflight = install(root, dist, o.fetch ?? fetch, o.check ?? runs)
    .then((b) => {
      if (o.root === undefined) seen = b;
      console.error(`harbor: Node.js ${dist.version} installed for agents in ${Math.round((Date.now() - started) / 1000)} s (${b})`);
      set({ kind: "ready", bin: b });
      return b as string | null;
    })
    .catch((e: unknown) => {
      const error = e instanceof Error ? e.message : String(e);
      console.error(`harbor: installing Node.js ${dist.version} for agents failed: ${error}`);
      set({ kind: "failed", error, at: Date.now() });
      return null;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * Starts ensure() in the background `delayMs` after Harbor starts (so the window comes first), unless the user
 * has their own Node. Never throws, never waits. Not under `bun test` (NODE_ENV=test) nor with HARBOR_NODE=0.
 */
export function startBackground(path: () => string, delayMs = 15_000): void {
  if (process.env.NODE_ENV === "test" || process.env.HARBOR_NODE === "0") return;
  const t = setTimeout(() => void ensure({ path: path() }), delayMs);
  (t as { unref?: () => void }).unref?.();
}

/** `node --version` from the unpacked folder: an archive that doesn't run here (a musl system, say) isn't installed. */
async function runs(node: string): Promise<void> {
  const p = Bun.spawn([node, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const kill = setTimeout(() => p.kill(), 30_000);
  try {
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code !== 0 || !/^v\d+\./.test(out.trim())) throw new Error(`node --version exited ${code}: ${(err || out).trim().slice(-200)}`);
  } finally {
    clearTimeout(kill);
  }
}

/**
 * Downloads `dist` into `root/.tmp-…`, checks its SHA-256 while it's written, unpacks it there, checks node runs,
 * then renames its folder into `root`. Every step is async (nothing on the caller's thread waits on the disk or
 * the network); the temporary folder goes, whatever happens. Returns the bin folder.
 */
export async function install(root: string, dist: NodeDist, fetchImpl: typeof fetch, check: (node: string) => Promise<void>): Promise<string> {
  await mkdir(root, { recursive: true });
  await sweep(root);
  const tmp = join(root, `.tmp-${process.pid}-${randomBytes(3).toString("hex")}`);
  await mkdir(tmp, { recursive: true });
  try {
    const archive = join(tmp, dist.archive);
    await download(dist.url, archive, dist.sha256, fetchImpl);
    const out = join(tmp, "x");
    await mkdir(out);
    await nodedist.extract(archive, dist.kind, out);
    const unpacked = join(out, dist.folder);
    const node = dist.bin === "" ? join(unpacked, dist.node) : join(unpacked, dist.bin, dist.node);
    if (!(await exists(node))) throw new Error(`${dist.archive} has no ${dist.folder}/${dist.bin === "" ? "" : `${dist.bin}/`}${dist.node}`);
    await check(node);
    const dest = join(root, dist.folder);
    await renameRetry(unpacked, dest);
    void prune(root, dist.folder);
    return binOf(root, dist);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** `url` into `file`, refused unless its SHA-256 is `sha256`. */
export async function download(url: string, file: string, sha256: string, fetchImpl: typeof fetch): Promise<void> {
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(15 * 60_000) });
  if (!r.ok || r.body === null) throw new Error(`download ${url}: HTTP ${r.status}`);
  const hash = createHash("sha256");
  const fh = await open(file, "w");
  let size = 0;
  try {
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > MAX_BYTES) throw new Error(`download ${url}: larger than ${MAX_BYTES} bytes`);
      hash.update(chunk);
      await fh.write(chunk);
    }
  } finally {
    await fh.close();
  }
  const got = hash.digest("hex");
  if (got !== sha256.toLowerCase()) throw new Error(`download ${url}: SHA-256 ${got}, expected ${sha256}`);
}

async function exists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** Windows: an antivirus may still hold a file just unpacked; the rename is tried for a few seconds. */
async function renameRetry(from: string, to: string): Promise<void> {
  for (let n = 0; ; n++) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      // Another Harbor process got there first: its copy is as good.
      try {
        if ((await stat(to)).isDirectory()) return;
      } catch {
        // not there: try again
      }
      if (n >= 20) throw e;
      await Bun.sleep(250);
    }
  }
}

/** Temporary folders an earlier, interrupted install left (older than an hour: not one running now). */
async function sweep(root: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return;
  }
  for (const n of names) {
    if (!n.startsWith(".tmp-")) continue;
    const p = join(root, n);
    try {
      if (Date.now() - (await stat(p)).mtimeMs > 3600_000) await rm(p, { recursive: true, force: true });
    } catch {
      // gone, or in use
    }
  }
}

/** Older managed Node versions, once a new one is in place (best effort: one still running stays). */
async function prune(root: string, keep: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return;
  }
  for (const n of names) {
    if (n === keep || !/^node-v\d+\.\d+\.\d+-/.test(n)) continue;
    await rm(join(root, n), { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Tests: forget what this process saw. */
export function resetForTests(): void {
  status = { kind: "idle" };
  inflight = null;
  seen = null;
  lookedAt = 0;
}

/** For the settings page: the tip of a chip whose server needs Node and isn't set up, or null. */
export function tip(): string | null {
  switch (status.kind) {
    case "installing":
      return "Installing Node.js for it\u{2026}";
    case "failed":
      return `Couldn't install Node.js: ${status.error.slice(0, 160)} \u{b7} tried again on the next start`;
    case "unsupported":
      return "Needs Node.js, which has no official build for this PC";
    default:
      return null;
  }
}
