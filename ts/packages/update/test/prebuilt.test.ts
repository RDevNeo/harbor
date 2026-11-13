// Follow-main's builds of main made once on GitHub (main.yml's `main-build` prerelease), and the lockfile
// shortcut of the builds made here: against real git repositories and a fake GitHub, the Bun steps faked.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  defaultRunner,
  FollowMain,
  installLocal,
  installKeyOf,
  MAIN_BUILD_TAG,
  parsePrebuiltComment,
  prebuiltComment,
  prebuiltName,
  PREBUILT_POLL_MS,
  PREBUILT_WAIT_MS,
  statusLine,
  timelineText,
  type Runner,
} from "../src/followmain.ts";
import { readHealth } from "../src/health.ts";
import { hasPrevious, rollback } from "../src/install.ts";
import { useEmbedded, type AppBundle } from "../src/launcher.ts";
import { parsePublicKey, verifyAsset } from "../src/minisign.ts";
import { FakeHost, bundleSource, cleanup, configFor, makeInstall, makeKey, tmp, windowsTime, type TestKey } from "./support.ts";

windowsTime();

afterEach(cleanup);

function sh(cwd: string, ...cmd: string[]): string {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function commit(repo: string, files: Record<string, string>, msg: string): string {
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(repo, f, ".."), { recursive: true });
    writeFileSync(join(repo, f), body);
  }
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", msg);
  return sh(repo, "git", "rev-parse", "HEAD");
}

const fmHome = (data: string) => join(data, "follow-main");

test("GitHub's build is signed for one commit of main: a release's check never takes it", async () => {
  const sha = "a".repeat(40);
  const tc = prebuiltComment(sha, `1.0.0+${sha.slice(0, 7)}`, "0.9.0");
  expect(tc).toBe(`harbor main ${sha} v1.0.0+aaaaaaa min 0.9.0 harbor-app.js`);
  expect(parsePrebuiltComment(tc)).toEqual({ commit: sha, version: "1.0.0+aaaaaaa", minRuntime: "0.9.0" });
  expect(parsePrebuiltComment("harbor v1.0.0 harbor-app.js")).toBeNull();
  expect(prebuiltName(sha)).toBe(`harbor-app-${sha}.js`);
  const key = await makeKey();
  const file = join(tmp(), "harbor-app.js");
  writeFileSync(file, bundleSource("1.0.0+aaaaaaa"));
  const pk = await parsePublicKey(key.publicKey);
  const sig = await key.sign(new Uint8Array(readFileSync(file)), tc);
  await expect(verifyAsset(pk, file, sig, "1.0.0", "harbor-app.js")).rejects.toThrow("signed for another release");
});

test("the lockfile shortcut's key: bun.lock and every package.json, and the runtime that installs them", () => {
  const tree = (lock: string, pkg: string, src = "2222") =>
    [`100644 blob ${lock}\tts/bun.lock`, `100644 blob ${pkg}\tts/package.json`, "100644 blob 1111\tts/packages/ui/package.json", `100644 blob ${src}\tts/packages/ui/src/shell.ts`].join("\n");
  const k = installKeyOf(tree("aaaa", "bbbb"), "1.0.0");
  expect(k).toMatch(/^[0-9a-f]{64}$/);
  // Sources don't count; the lockfile, a package.json and the runtime do.
  expect(installKeyOf(tree("aaaa", "bbbb", "3333"), "1.0.0")).toBe(k);
  expect(installKeyOf(tree("aaab", "bbbb"), "1.0.0")).not.toBe(k);
  expect(installKeyOf(tree("aaaa", "bbbc"), "1.0.0")).not.toBe(k);
  expect(installKeyOf(tree("aaaa", "bbbb"), "1.0.1")).not.toBe(k);
  // No lockfile: no shortcut.
  expect(installKeyOf("100644 blob 1111\tts/package.json", "1.0.0")).toBe("");
});

type PublishOpts = { version?: string; min?: string; tc?: string; signer?: TestKey };

async function prebuiltRig(opts: { cold?: boolean; checkout?: boolean; tsc?: () => number } = {}) {
  const key = await makeKey();
  const host = new FakeHost();
  const upstream = tmp("hfm-up-");
  sh(upstream, "git", "init", "-q", "-b", "main");
  // node_modules is ignored as ts/.gitignore does (the build's `git clean` keeps it).
  const base = commit(upstream, { "ts/.gitignore": "node_modules/\n", "ts/package.json": '{ "version": "1.0.0", "packageManager": "bun@1.4.3" }\n', "ts/bun.lock": "lock 1\n", "ts/app.ts": "1\n", "ts/runtime.ts": "r\n" }, "1.0.0");
  sh(upstream, "git", "tag", "v1.0.0");
  const running = commit(upstream, { "ts/app.ts": "running\n" }, "what runs");
  const inst = makeInstall({ version: "1.0.0" });
  const clock = { now: 1_000_000, slept: [] as number[], onSleep: (_n: number): void => undefined };
  const cfg = host.config(inst, key, {
    version: "1.0.0",
    worker: null,
    now: () => clock.now,
    sleep: async (ms) => {
      clock.slept.push(ms);
      clock.now += ms;
      clock.onSleep(clock.slept.length);
    },
  });
  const kv = new Map<string, string>();
  let checkout: string | null = null;
  if (opts.checkout) {
    checkout = join(tmp("hfm-co-"), "harbor");
    sh(upstream, "git", "clone", "-q", upstream, checkout);
    kv.set("follow_main_checkout", checkout);
  }
  const data = tmp("hfm-data-");
  const calls: string[] = [];
  const run: Runner = async (cmd, o) => {
    if (cmd[0] === "git") return defaultRunner(cmd, o);
    const step = cmd.slice(1).join(" ");
    calls.push(step.includes("bin/tsc") ? "check" : (step.split(" ")[0] ?? ""));
    // A cold PC: its installs never leave node_modules behind (as if each were the first).
    if (step.startsWith("install") && !opts.cold) mkdirSync(join(o.cwd, "node_modules"), { recursive: true });
    if (step.includes("bin/tsc")) return { code: opts.tsc?.() ?? 0, out: "" };
    if (step.startsWith("scripts/build.ts")) writeFileSync(cmd[3] as string, bundleSource(cmd[cmd.indexOf("--version") + 1] as string));
    return { code: 0, out: "" };
  };
  const fm = new FollowMain({
    cfg,
    kv: { get: (k) => kv.get(k) ?? null, set: (k, v) => void kv.set(k, v) },
    dataDir: data,
    repos: () => [],
    busy: () => false,
    commit: running,
    remote: upstream,
    prebuilt: true,
    run,
    watchRefs: () => () => undefined,
    boot: "boot-1",
  });
  /** main.yml's publishing of `sha`: signed now, put on the fake GitHub when the returned function is called. */
  const mainBuild = async (sha: string, o: PublishOpts = {}): Promise<() => void> => {
    const version = o.version ?? `1.0.0+${sha.slice(0, 7)}`;
    const body = bundleSource(version);
    const sig = await (o.signer ?? key).sign(new TextEncoder().encode(body), o.tc ?? prebuiltComment(sha, version, o.min ?? "1.0.0"));
    return () => {
      host.assets.set(`${MAIN_BUILD_TAG}/${prebuiltName(sha)}`, { body });
      host.assets.set(`${MAIN_BUILD_TAG}/${prebuiltName(sha)}.minisig`, { body: sig });
    };
  };
  const asked = () => host.hits.filter((h) => h.includes(`/releases/download/${MAIN_BUILD_TAG}/`));
  const state = () => JSON.parse(readFileSync(join(fmHome(data), "state.json"), "utf8")) as { pending: { via?: string } | null; prebuiltBad?: string; buildMs?: number };
  return { key, host, upstream, base, running, checkout, inst, data, fm, calls, clock, mainBuild, asked, state };
}

test("follow-main takes GitHub's build of a pushed commit when it's there: nothing is built here", async () => {
  const r = await prebuiltRig();
  r.fm.start();
  await r.fm.poke();
  expect(r.fm.status()).toMatchObject({ state: "idle", commit: r.running });
  expect(r.calls).toEqual(["install"]);
  const c = commit(r.upstream, { "ts/app.ts": "pushed\n" }, "pushed");
  (await r.mainBuild(c))();
  await r.fm.poke();
  const v = `1.0.0+${c.slice(0, 7)}`;
  expect(r.fm.status()).toMatchObject({ state: "swapping", commit: c, version: v });
  expect(readFileSync(join(r.inst.dir, "VERSION"), "utf8")).toBe(v);
  expect(readFileSync(join(r.inst.dir, "harbor-app.js"), "utf8")).toContain(v);
  expect(readFileSync(join(r.inst.dir, ".previous", "VERSION"), "utf8")).toBe("1.0.0");
  // No bun install, tsc or build here; checks recorded for the soak gate (tsc ran on GitHub, the smoke here).
  expect(r.calls).toEqual(["install"]);
  expect(readHealth(fmHome(r.data)).commits[c]?.checks).toMatchObject({ tsc: true, smoke: true });
  expect(r.state().pending?.via).toBe("github");
  expect(r.asked()).toEqual([`GET /o/r/releases/download/main-build/harbor-app-${c}.js.minisig`, `GET /o/r/releases/download/main-build/harbor-app-${c}.js`]);
  expect(r.clock.slept).toEqual([]);
  r.fm.stop();
});

test("follow-main with packages installed for the lockfile builds a push here at once, without bun install", async () => {
  const r = await prebuiltRig();
  r.fm.start();
  await r.fm.poke();
  const c = commit(r.upstream, { "ts/app.ts": "pushed\n" }, "pushed");
  await r.fm.poke();
  expect(r.fm.status()).toMatchObject({ state: "swapping", commit: c });
  // One look for GitHub's build, then no waiting: tsc and the build here, the install skipped.
  expect(r.asked()).toEqual([`GET /o/r/releases/download/main-build/harbor-app-${c}.js.minisig`]);
  expect(r.clock.slept).toEqual([]);
  expect(r.calls).toEqual(["install", "check", "scripts/build.ts"]);
  expect(readFileSync(join(fmHome(r.data), "build.log"), "utf8")).toContain("bun install skipped");
  expect(r.state().pending?.via).toBeUndefined();
  expect(typeof r.state().buildMs).toBe("number");
  r.fm.stop();
});

test("follow-main: a new lockfile isn't installed here, so GitHub's build is waited for and taken", async () => {
  const r = await prebuiltRig();
  r.fm.start();
  await r.fm.poke();
  const c = commit(r.upstream, { "ts/bun.lock": "lock 2\n", "ts/app.ts": "pushed\n" }, "new package");
  const publish = await r.mainBuild(c);
  r.clock.onSleep = (n) => {
    if (n === 2) publish();
  };
  await r.fm.poke();
  expect(r.fm.status()).toMatchObject({ state: "swapping", commit: c });
  expect(r.clock.slept).toEqual([PREBUILT_POLL_MS, PREBUILT_POLL_MS]);
  expect(r.calls).toEqual(["install"]);
  expect(r.state().pending?.via).toBe("github");
  r.fm.stop();
});

test("follow-main: when GitHub's build doesn't come, the push is built here once the wait is over", async () => {
  const r = await prebuiltRig({ cold: true });
  r.fm.start();
  await r.fm.poke();
  const c = commit(r.upstream, { "ts/app.ts": "pushed\n" }, "pushed");
  await r.fm.poke();
  expect(r.fm.status()).toMatchObject({ state: "swapping", commit: c });
  expect(r.clock.slept.reduce((a, b) => a + b, 0)).toBe(PREBUILT_WAIT_MS);
  // Cold: the warm-up's install, then the build's own.
  expect(r.calls).toEqual(["install", "install", "check", "scripts/build.ts"]);
  expect(r.state().pending?.via).toBeUndefined();
  r.fm.stop();
});

test("follow-main: GitHub's build signed by another key, for another commit or version, or needing a newer runtime is built here", async () => {
  const other = await makeKey();
  const cases: Array<(running: string) => PublishOpts> = [
    () => ({ signer: other }),
    (running) => ({ tc: prebuiltComment(running, `1.0.0+${running.slice(0, 7)}`, "1.0.0") }),
    () => ({ min: "9.0.0" }),
    () => ({ version: "1.0.0+0000000" }),
  ];
  for (const opts of cases) {
    const r = await prebuiltRig({ cold: true });
    r.fm.start();
    await r.fm.poke();
    const c = commit(r.upstream, { "ts/app.ts": "pushed\n" }, "pushed");
    (await r.mainBuild(c, opts(r.running)))();
    await r.fm.poke();
    expect(r.fm.status()).toMatchObject({ state: "swapping", commit: c });
    expect(readFileSync(join(r.inst.dir, "VERSION"), "utf8")).toBe(`1.0.0+${c.slice(0, 7)}`);
    expect(readFileSync(join(r.inst.dir, "harbor-app.js"), "utf8")).toContain(`1.0.0+${c.slice(0, 7)}`);
    expect(r.calls.slice(-2)).toEqual(["check", "scripts/build.ts"]);
    expect(r.clock.slept).toEqual([]);
    expect(r.state().prebuiltBad).toBe(c);
    r.fm.stop();
  }
});

test("follow-main: a checkout's commits not pushed yet are built here; GitHub isn't asked", async () => {
  const r = await prebuiltRig({ checkout: true });
  r.fm.start();
  await r.fm.poke();
  const c = commit(r.checkout as string, { "ts/app.ts": "not pushed\n" }, "local");
  await r.fm.poke();
  expect(r.fm.status()).toMatchObject({ state: "swapping", commit: c });
  expect(r.asked()).toEqual([]);
  expect(r.calls.slice(-2)).toEqual(["check", "scripts/build.ts"]);
  r.fm.stop();
});

test("follow-main: main moving during the wait for GitHub's build leaves it for the newer commit", async () => {
  const r = await prebuiltRig({ cold: true });
  r.fm.start();
  await r.fm.poke();
  const c1 = commit(r.upstream, { "ts/app.ts": "first\n" }, "first");
  const c2 = { sha: "" };
  r.clock.onSleep = (n) => {
    if (n !== 1) return;
    c2.sha = commit(r.upstream, { "ts/app.ts": "second\n" }, "second");
    void r.mainBuild(c2.sha).then((publish) => {
      publish();
      void r.fm.poke();
    });
  };
  await r.fm.poke();
  for (let i = 0; i < 200 && r.fm.status().state !== "swapping"; i++) await Bun.sleep(20);
  expect(c2.sha).not.toBe(c1);
  expect(r.fm.status()).toMatchObject({ state: "swapping", commit: c2.sha });
  expect(r.calls).toEqual(["install"]);
  expect(r.state().pending?.via).toBe("github");
  r.fm.stop();
});

test("follow-main: a step that fails after a skipped bun install runs again after one", async () => {
  let tscRuns = 0;
  const r = await prebuiltRig({ tsc: () => (tscRuns++ === 0 ? 1 : 0) });
  r.fm.start();
  await r.fm.poke();
  const c = commit(r.upstream, { "ts/app.ts": "pushed\n" }, "pushed");
  await r.fm.poke();
  expect(r.fm.status()).toMatchObject({ state: "swapping", commit: c });
  expect(r.calls).toEqual(["install", "check", "install", "check", "scripts/build.ts"]);
  r.fm.stop();
});

test("the status and timeline lines for GitHub's build", () => {
  expect(statusLine({ state: "fetching", checkout: "", commit: "abcdef0123", subject: "", version: "1.0.0+abcdef0", reason: "waiting for GitHub's build", at: 0 }, true)).toBe(
    "Getting 1.0.0+abcdef0 from GitHub: waiting for GitHub's build…",
  );
  expect(timelineText({ commit: "c", version: "1.0.0+c", committedAt: 0, pushedAt: 10_000, noticedAt: 11_000, builtAt: 50_000, liveAt: 53_000, via: "github" })).toBe(
    "1.0.0+c ran 43 s after its push (heard 1 s, got GitHub's build 39 s, restarted 3 s).",
  );
});

test("a build of main over a single executable keeps a link to it, so a start that fails goes back to its own bundle", () => {
  const inst = makeInstall();
  rmSync(join(inst.dir, "harbor-app.js"));
  const cfg = configFor(inst);
  expect(hasPrevious(cfg)).toBe(false);
  const built = join(tmp(), "harbor-app.js");
  writeFileSync(built, bundleSource("1.0.0+abc1234"));
  installLocal(cfg, built, "1.0.0+abc1234");
  expect(hasPrevious(cfg)).toBe(true);
  const r = rollback({ ...cfg, version: "1.0.0+abc1234" }, "it showed no frame in time");
  expect(r).toEqual({ restored: "1.0.0", gaveUp: "1.0.0+abc1234" });
  expect(readFileSync(join(inst.dir, "VERSION"), "utf8")).toBe("1.0.0");
  expect(existsSync(inst.exe)).toBe(true);
  // VERSION back at the executable's own release: it runs the bundle it carries, not the build of main beside it.
  const embedded: AppBundle = { meta: { version: "1.0.0", minRuntime: "0.1.0" }, main: () => 0 };
  expect(useEmbedded({ kind: "release", path: join(inst.dir, "harbor-app.js"), id: "", version: "1.0.0" }, embedded)).toBe(true);
});
