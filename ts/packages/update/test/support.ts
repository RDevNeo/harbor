import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { UpdateConfig } from "../src/config.ts";
import { sleep } from "../src/config.ts";

const here = dirname(new URL(import.meta.url).pathname);
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

export function fakeRuntimeScript(runtime: string, exe: string, extraEnv = ""): string {
  return `#!/bin/sh\nFAKE_RUNTIME_VERSION=${runtime} FAKE_EXE=${JSON.stringify(exe)} ${extraEnv} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_RUNTIME)} "$@"\n`;
}

export interface Install {
  dir: string;
  exe: string;
}
export function makeInstall(opts: { version?: string; runtime?: string; bundle?: string } = {}): Install {
  const dir = tmp("hupd-install-");
  const exe = join(dir, "harbor");
  const version = opts.version ?? "1.0.0";
  writeFileSync(join(dir, ".managed"), "");
  writeFileSync(exe, fakeRuntimeScript(opts.runtime ?? "1.0.0", exe));
  chmodSync(exe, 0o755);
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
      await this.publish(key, o.runtimeFrom, { "harbor-runtime-x86_64": script });
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
