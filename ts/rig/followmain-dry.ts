// Follow-main end to end on this PC, beside the running Harbor and never touching it: throwaway install
// folders (a copy of a runtime, `.managed`, VERSION), throwaway data folders, the real public repository,
// the real `bun install` / tsc / build / smoke-bundle. Three runs:
//
//   A  cold, built here: what a PC without GitHub's build does (clone, bun install, tsc, build, smoke).
//   B  warm, built here: the same clone again, its packages installed for that lockfile (the shortcut).
//   C  GitHub's build: A's bundle signed with a throwaway key and served by a local fake of GitHub's
//      release downloads; a fresh install and data folder take it (no bun install, no tsc, no build).
//
//   bun rig/followmain-dry.ts --runtime EXE [--from COMMIT] [--keep]
//
// --from: the commit the throwaway install "runs" (default: the public main's parent, resolved in the
// checkout this runs from); it must be older than the public main and differ in what the app is built
// from. --runtime: the Harbor runtime to copy (an installed harbor / harbor.exe). Run it with a plain Bun
// (the pinned one), not `BUN_BE_BUN=1 harbor`: that variable would reach the runtime the checks start
// (Bun on Windows passes it on even once deleted from process.env). Prints the timings.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentArch, currentOs, sleep, type UpdateConfig } from "../packages/update/src/config.ts";
import { BUNDLE_FILE, RUNTIME_FILE } from "../packages/update/src/files.ts";
import { defaultRunner, FollowMain, localVersion, MAIN_BUILD_TAG, prebuiltComment, prebuiltName, REMOTE } from "../packages/update/src/followmain.ts";

const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const runtimeExe = opt("--runtime") ?? "";
if (runtimeExe === "" || process.env.BUN_BE_BUN) {
  console.error("usage: bun rig/followmain-dry.ts --runtime EXE [--from COMMIT] [--keep] (a plain Bun, not BUN_BE_BUN=1 harbor)");
  process.exit(2);
}
const keep = argv.includes("--keep");
const t0 = Date.now();
const say = (m: string): void => console.error(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${m}`);

function git(...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

const tip = git("ls-remote", "--", REMOTE, "refs/heads/main").split(/\s/)[0] ?? "";
git("fetch", "--quiet", "--", REMOTE, "+refs/heads/main:refs/follow-dry/main");
const from = git("rev-parse", opt("--from") ?? "refs/follow-dry/main~1");
const runtimeVersion = Bun.spawnSync([runtimeExe, "runtime-version"], { stdout: "pipe" }).stdout.toString().trim();
const pkgVersion = (JSON.parse(git("show", `${tip}:ts/package.json`)) as { version: string }).version;
const version = localVersion(pkgVersion, tip);
say(`public main ${tip.slice(0, 7)} (${version}); the throwaway installs run ${from.slice(0, 7)}; runtime ${runtimeVersion} (${runtimeExe})`);

const work = mkdtempSync(join(tmpdir(), "followmain-dry-"));

function install(name: string): string {
  const dir = join(work, name, "install");
  mkdirSync(dir, { recursive: true });
  copyFileSync(runtimeExe, join(dir, RUNTIME_FILE));
  writeFileSync(join(dir, ".managed"), "");
  writeFileSync(join(dir, "VERSION"), "0.0.1");
  writeFileSync(join(dir, "RUNTIME"), runtimeVersion);
  return dir;
}

function config(dir: string, over: Partial<UpdateConfig> = {}): UpdateConfig {
  return {
    dir,
    os: currentOs(),
    version: "0.0.1",
    runtime: runtimeVersion,
    preview: false,
    arch: currentArch(),
    repo: "RDevNeo/harbor",
    github: "https://github.com",
    worker: null,
    pubkey: "",
    fetch: globalThis.fetch,
    log: (m) => say(`  log: ${m}`),
    now: Date.now,
    sleep,
    random: Math.random,
    exe: join(dir, RUNTIME_FILE),
    glibc: () => null,
    ...over,
  };
}

async function look(name: string, cfg: UpdateConfig, data: string, prebuilt: boolean): Promise<{ ms: number; state: string; via: string }> {
  const kv = new Map<string, string>();
  const fm = new FollowMain({
    cfg,
    kv: { get: (k) => kv.get(k) ?? null, set: (k, v) => void kv.set(k, v) },
    dataDir: data,
    repos: () => [],
    busy: () => false,
    commit: from,
    remote: REMOTE,
    prebuilt,
    run: defaultRunner,
    watchRefs: () => () => undefined,
    changed: () => {
      const s = fm.status();
      say(`  ${name}: ${s.state}${s.reason ? ` (${s.reason})` : ""}`);
    },
  });
  const start = Date.now();
  fm.start();
  await fm.poke();
  const ms = Date.now() - start;
  fm.stop();
  const st = JSON.parse(readFileSync(join(data, "follow-main", "state.json"), "utf8")) as { pending?: { via?: string } };
  const installed = readFileSync(join(cfg.dir ?? "", "VERSION"), "utf8");
  say(`${name}: ${fm.status().state} in ${(ms / 1000).toFixed(1)} s; VERSION ${installed}; via ${st.pending?.via ?? "here"}`);
  if (installed !== version) throw new Error(`${name}: expected ${version} installed`);
  return { ms, state: fm.status().state, via: st.pending?.via ?? "here" };
}

// A throwaway minisign key (the release key's secret is GitHub's alone).
async function key(): Promise<{ pub: string; sign: (data: Uint8Array, tc: string) => Promise<string> }> {
  const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");
  const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const id = crypto.getRandomValues(new Uint8Array(8));
  const pub = new Uint8Array(42);
  pub.set([0x45, 0x64], 0);
  pub.set(id, 2);
  pub.set(raw, 10);
  const ed = async (m: Uint8Array<ArrayBuffer>): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, m));
  return {
    pub: b64(pub),
    async sign(data, tc) {
      const sig = await ed(new Uint8Array(createHash("blake2b512").update(data).digest()));
      const line = new Uint8Array(74);
      line.set([0x45, 0x44], 0);
      line.set(id, 2);
      line.set(sig, 10);
      const comment = new TextEncoder().encode(tc);
      const covered = new Uint8Array(64 + comment.length);
      covered.set(sig);
      covered.set(comment, 64);
      return `untrusted comment: signature from minisign secret key\n${b64(line)}\ntrusted comment: ${tc}\n${b64(await ed(covered))}\n`;
    },
  };
}

try {
  const dataA = join(work, "a", "data");
  const a = await look("A cold, built here", config(install("a")), dataA, false);
  const b = await look("B warm, built here", config(install("b")), dataA, false);
  const log = readFileSync(join(dataA, "follow-main", "build.log"), "utf8");
  if (!log.includes("bun install skipped")) throw new Error("B: bun install wasn't skipped");
  const bundle = join(dataA, "follow-main", "out", BUNDLE_FILE);
  const k = await key();
  const body = readFileSync(bundle);
  const sig = await k.sign(body, prebuiltComment(tip, version, runtimeVersion));
  const served: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      served.push(path);
      const at = `/RDevNeo/harbor/releases/download/${MAIN_BUILD_TAG}/${prebuiltName(tip)}`;
      if (path === at) return new Response(body);
      if (path === `${at}.minisig`) return new Response(sig);
      return new Response("not found", { status: 404 });
    },
  });
  const dataC = join(work, "c", "data");
  const c = await look("C GitHub's build", config(install("c"), { github: `http://127.0.0.1:${server.port}`, pubkey: k.pub }), dataC, true);
  void server.stop(true);
  if (c.via !== "github") throw new Error("C: GitHub's build wasn't taken");
  if (existsSync(join(dataC, "follow-main", "src", "ts", "node_modules"))) throw new Error("C: bun install ran");
  say(`served: ${served.join(", ")}`);
  console.log(`followmain-dry ok: A cold here ${(a.ms / 1000).toFixed(1)} s, B warm here ${(b.ms / 1000).toFixed(1)} s, C GitHub's build ${(c.ms / 1000).toFixed(1)} s`);
} finally {
  git("update-ref", "-d", "refs/follow-dry/main");
  if (keep) say(`kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
