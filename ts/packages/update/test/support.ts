import { createHash } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { UpdateConfig } from "../src/config.ts";
import { sleep } from "../src/config.ts";

const here = import.meta.dir;
export const FAKE_RUNTIME = join(here, "fake-runtime.ts");

export interface TestKey {
  publicKey: string;
  sign: (data: Uint8Array, trustedComment: string, opts?: { legacy?: boolean }) => Promise<string>;
}

const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");
export async function makeKey(): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const id = crypto.getRandomValues(new Uint8Array(8));
  const pub = new Uint8Array(42);
  pub.set([0x45, 0x64], 0);
  pub.set(id, 2);
  pub.set(raw, 10);
  const edSign = async (m: Uint8Array<ArrayBuffer>): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, m));
  return {
    publicKey: b64(pub),
    async sign(data, tc, opts) {
      const legacy = opts?.legacy === true;
      const msg = legacy ? new Uint8Array(data) : new Uint8Array(createHash("blake2b512").update(data).digest());
      const sig = await edSign(msg);
      const line = new Uint8Array(74);
      line.set(legacy ? [0x45, 0x64] : [0x45, 0x44], 0);
      line.set(id, 2);
      line.set(sig, 10);
      const comment = new TextEncoder().encode(tc);
      const covered = new Uint8Array(64 + comment.length);
      covered.set(sig);
      covered.set(comment, 64);
      const global = await edSign(covered);
      return `untrusted comment: signature from minisign secret key\n${b64(line)}\ntrusted comment: ${tc}\n${b64(global)}\n`;
    },
  };
}

export function tmp(prefix = "hupd-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

export const cleanups: Array<() => void | Promise<void>> = [];

export async function cleanup(): Promise<void> {
  for (const c of cleanups.splice(0)) await c();
}

export const bundleSource = (version: string, body = "return 0;"): string =>
  `export const meta = { version: ${JSON.stringify(version)}, minRuntime: "0.1.0" };\nexport async function main(argv) { ${body} }\n`;

/** Windows starts only real programs: there the fake runtime is fake-runtime.ts built into an .exe. */
export const WINDOWS = process.platform === "win32";
/** The runtime's file in an install (update/src/files.ts RUNTIME_FILE). */
export const RUNTIME = WINDOWS ? "harbor.exe" : "harbor";
/** The release's runtime asset the tests' configs ask for (install.ts runtimeAsset). */
export const RUNTIME_ASSET = WINDOWS ? "harbor-runtime-x86_64-windows.exe" : "harbor-runtime-x86_64";

/**
 * Windows: a small program built once per test run that does what the Linux script does (runs Bun on
 * fake-runtime.ts with FAKE_RUNTIME_VERSION and FAKE_EXE set; a program built by Bun can't load the sources'
 * workspace packages itself). A new 96 MB program's first start takes Windows over 10 s and a hard link to one
 * that ran 0.1 s, so an install's runtime is a link to it and says the version in its folder's RUNTIME file; a
 * downloaded one (no RUNTIME beside it) takes the last one published (FAKE_PUBLISHED).
 */
const shimSource = (bun: string, script: string): string => `import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
let version: string;
try {
  version = readFileSync(join(dirname(process.execPath), "RUNTIME"), "utf8").trim();
} catch {
  const s = JSON.parse(readFileSync(process.env.FAKE_PUBLISHED ?? "", "utf8"));
  if (s.exit !== undefined) process.exit(s.exit);
  version = s.runtime;
}
const p = Bun.spawn([${JSON.stringify(bun)}, ${JSON.stringify(script)}, ...process.argv.slice(2)], {
  stdin: "inherit", stdout: "inherit", stderr: "inherit",
  env: { ...process.env, FAKE_RUNTIME_VERSION: version, FAKE_EXE: process.execPath },
});
process.exit(await p.exited);
`;
let compiled: string | undefined;
function fakeExe(): string {
  if (compiled !== undefined) return compiled;
  const dir = mkdtempSync(join(tmpdir(), "hupd-fake-"));
  const out = join(dir, "fake-runtime.exe");
  const entry = join(dir, "shim.ts");
  writeFileSync(entry, shimSource(process.execPath, FAKE_RUNTIME));
  const r = Bun.spawnSync([process.execPath, "build", "--compile", entry, "--outfile", out], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`fake runtime didn't build: ${r.stderr.toString()}`);
  process.env.FAKE_PUBLISHED = join(dir, "published.json");
  writeFileSync(process.env.FAKE_PUBLISHED, JSON.stringify({ runtime: "0.0.0" }));
  // Its first start, here: not inside a test's time.
  Bun.spawnSync([out, "runtime-version"], { stdout: "ignore", stderr: "ignore" });
  compiled = out;
  return out;
}
// Built before any test (test/preload.ts gives Windows' tests more time: a downloaded runtime is a new copy).
if (WINDOWS) fakeExe();

/**
 * A fake Harbor runtime that says it is `runtime` and runs the launcher for the install at `exe` ("$0": its own
 * file); `exitCode` makes one that exits with it at once (one that doesn't run here). A `#!` script, or on Windows
 * the built program's bytes ("$0" ones: the next runtime downloaded takes these settings).
 */
export function fakeRuntimeScript(runtime: string, exe: string, extraEnv = "", exitCode?: number): string | Uint8Array {
  if (!WINDOWS) {
    if (exitCode !== undefined) return `#!/bin/sh\nexit ${exitCode}\n`;
    return `#!/bin/sh\nFAKE_RUNTIME_VERSION=${runtime} FAKE_EXE=${JSON.stringify(exe)} ${extraEnv} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_RUNTIME)} "$@"\n`;
  }
  const out = fakeExe();
  if (exe === "$0") writeFileSync(process.env.FAKE_PUBLISHED ?? "", JSON.stringify({ runtime, ...(exitCode === undefined ? {} : { exit: exitCode }) }));
  return new Uint8Array(readFileSync(out));
}

/** An install's fake runtime at `exe`: a script, or on Windows a hard link to the built program. */
function writeFakeRuntime(exe: string, runtime: string): void {
  if (!WINDOWS) {
    writeFileSync(exe, fakeRuntimeScript(runtime, exe));
    chmodSync(exe, 0o755);
    return;
  }
  linkSync(fakeExe(), exe);
}

/** A fake runtime's settings, as text ("FAKE_RUNTIME_VERSION=1.0.0 …"): its script, or on Windows what it reads. */
export function runtimeText(path: string): string {
  if (!WINDOWS) return readFileSync(path, "utf8");
  let v = "";
  try {
    v = readFileSync(join(dirname(path), "RUNTIME"), "utf8").trim();
  } catch {
    v = (JSON.parse(readFileSync(process.env.FAKE_PUBLISHED ?? "", "utf8")) as { runtime: string }).runtime;
  }
  return `FAKE_RUNTIME_VERSION=${v}`;
}

export interface Install {
  dir: string;
  exe: string;
}
export function makeInstall(opts: { version?: string; runtime?: string; bundle?: string } = {}): Install {
  const dir = tmp("hupd-install-");
  const exe = join(dir, RUNTIME);
  const version = opts.version ?? "1.0.0";
  writeFileSync(join(dir, ".managed"), "");
  writeFakeRuntime(exe, opts.runtime ?? "1.0.0");
  writeFileSync(join(dir, "harbor-app.js"), opts.bundle ?? bundleSource(version));
  writeFileSync(join(dir, "VERSION"), version);
  writeFileSync(join(dir, "RUNTIME"), opts.runtime ?? "1.0.0");
  return { dir, exe };
}

export function configFor(inst: Install | null, over: Partial<UpdateConfig> = {}): UpdateConfig {
  return {
    dir: inst?.dir ?? null,
    version: "1.0.0",
    runtime: "1.0.0",
    preview: false,
    arch: "x86_64",
    repo: "o/r",
    github: "http://127.0.0.1:1",
    worker: null,
    pubkey: "",
    fetch: globalThis.fetch,
    log: () => undefined,
    now: Date.now,
    sleep,
    random: () => 0.5,
    exe: inst?.exe ?? "/nonexistent/harbor",
    ...(WINDOWS ? { os: "windows" as const } : {}),
    glibc: () => [2, 40],
    ...over,
  };
}

export interface Asset {
  body: string | Uint8Array;
  status?: number;
}
// A fake of the release host and the account worker: local, so nothing reaches the real ones.
export class FakeHost {
  readonly assets = new Map<string, Asset>();
  readonly hits: string[] = [];
  latest: string | null = null;
  workerAnswers: Array<{ status: number; version?: string }> = [];
  waits: string[] = [];
  private server: ReturnType<typeof Bun.serve>;
  private sendWait: Array<(r: Response) => void> = [];

  constructor(readonly repo = "o/r") {
    this.server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => this.handle(req) });
    cleanups.push(() => void this.server.stop(true));
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  private async handle(req: Request): Promise<Response> {
    const u = new URL(req.url);
    this.hits.push(`${req.method} ${u.pathname}${u.search}`);
    if (u.pathname === `/${this.repo}/releases/latest`) {
      if (this.latest === null) return new Response(null, { status: 302, headers: { location: `${this.url}/${this.repo}/releases` } });
      return new Response(null, { status: 302, headers: { location: `${this.url}/${this.repo}/releases/tag/v${this.latest}` } });
    }
    if (u.pathname.startsWith(`/${this.repo}/releases/download/`)) {
      const a = this.assets.get(u.pathname.slice(`/${this.repo}/releases/download/`.length));
      if (a === undefined) return new Response("not found", { status: 404 });
      return new Response(a.body, { status: a.status ?? 200 });
    }
    if (u.pathname === "/v1/release/wait") {
      this.waits.push(u.searchParams.get("have") ?? "");
      const next = this.workerAnswers.shift();
      if (next === undefined) return new Promise<Response>((resolve) => this.sendWait.push(resolve));
      if (next.status === 200) return Response.json({ version: next.version });
      return new Response(null, { status: next.status });
    }
    return new Response("nope", { status: 404 });
  }
  answerWait(status: number, version?: string): void {
    const send = this.sendWait.shift();
    send?.(status === 200 ? Response.json({ version }) : new Response(null, { status }));
  }

  held(): number {
    return this.sendWait.length;
  }

  put(release: string, name: string, body: string | Uint8Array): void {
    this.assets.set(`v${release}/${name}`, { body });
  }

  async publish(
    key: TestKey,
    release: string,
    files: Record<string, string | Uint8Array>,
    opts: { signAs?: (name: string) => string } = {},
  ): Promise<void> {
    for (const [name, body] of Object.entries(files)) {
      const data = typeof body === "string" ? new TextEncoder().encode(body) : body;
      this.put(release, name, body);
      this.put(release, `${name}.minisig`, await key.sign(data, opts.signAs?.(name) ?? `harbor v${release} ${name}`));
    }
  }
  async publishTs(key: TestKey, version: string, o: { minRuntime?: string; runtime?: string; runtimeFrom?: string; bundle?: string; setLatest?: boolean } = {}): Promise<void> {
    const runtime = o.runtime ?? "1.0.0";
    const manifest = { version, minRuntime: o.minRuntime ?? runtime, runtime };
    const files: Record<string, string | Uint8Array> = {
      "harbor-app.json": JSON.stringify(manifest),
      "harbor-app.js": o.bundle ?? bundleSource(version),
    };
    await this.publish(key, version, files);
    if (o.runtimeFrom !== undefined) {
      const script = fakeRuntimeScript(runtime, "$0");
      await this.publish(key, o.runtimeFrom, { [RUNTIME_ASSET]: script });
    }
    if (o.setLatest !== false) this.latest = version;
  }

  config(inst: Install | null, key: TestKey, over: Partial<UpdateConfig> = {}): UpdateConfig {
    return configFor(inst, { github: this.url, repo: this.repo, worker: this.url, pubkey: key.publicKey, ...over });
  }
}

export const wait = async (cond: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(20);
  }
  throw new Error("timed out waiting");
};

export const ensure = (p: string): void => void mkdirSync(p, { recursive: true });
