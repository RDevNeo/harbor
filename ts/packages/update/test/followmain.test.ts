import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Updater } from "../src/delivery.ts";
import { defaultRunner, enabled, FollowMain, installLocal, isHarborRemote, localVersion, setEnabled, shipsInApp, statusLine, timelineText, type Runner } from "../src/followmain.ts";
import { begin, beat, earlyCrashes, end, readHealth, recordChecks, soak, type HealthFile } from "../src/health.ts";
import { rollback } from "../src/install.ts";
import { useEmbedded, type AppBundle } from "../src/launcher.ts";
import { nextVersion, pickRelease, releaseChangelog, setPackageVersion, ships, unreleased } from "../src/soak.ts";
import { buildOf, compare, newer, parse } from "../src/version.ts";
import { FakeHost, bundleSource, cleanup, configFor, makeInstall, makeKey, tmp, windowsTime } from "./support.ts";

windowsTime();

afterEach(cleanup);

test("a build of main is named 0.x.y+commit, and the commit doesn't order versions", () => {
  expect(localVersion("0.165.1", "abc1234def")).toBe("0.165.1+abc1234");
  expect(parse("0.165.1+abc1234")).toEqual([0, 165, 1, true]);
  expect(buildOf("0.165.1+abc1234")).toBe("abc1234");
  expect(buildOf("0.165.1")).toBeNull();
  expect(compare("0.165.1+abc1234", "0.165.1")).toBe(0);
  expect(newer("0.165.2", "0.165.1+abc1234")).toBe(true);
  expect(newer("0.165.1", "0.165.1+abc1234")).toBe(false);
  expect(newer("0.165.1+abc1234", "0.165.0")).toBe(true);
});

test("what the app bundle is built from: sources, packages, assets; not tests, docs, rigs or scripts", () => {
  for (const p of ["discord/SHA256SUMS", "whatsapp/SHA256SUMS", "ts/run.ts", "ts/packages/ui/src/shell.ts", "ts/package.json", "ts/bun.lock", "ts/packages/ui/slint/app.slint", "assets/fonts/lucide.ttf", "ts/scripts/build.ts"]) expect(shipsInApp(p)).toBe(true);
  for (const p of ["ts/test/x.test.ts", "ts/packages/update/test/support.ts", "ts/README.md", "ts/rig/phonehub.ts", "ts/scripts/soaked.ts", "ts/proto/main.ts", "ts/parity.ts", "android/app.java", "CHANGELOG.md", "docs/x.md"]) expect(shipsInApp(p)).toBe(false);
  expect(ships("android/src/Main.java")).toBe(true);
  expect(ships("ts/test/a.test.ts")).toBe(false);
  expect(isHarborRemote("git@github.com:RDevNeo/harbor.git")).toBe(true);
  expect(isHarborRemote("https://github.com/RDevNeo/harbor")).toBe(true);
  expect(isHarborRemote("https://github.com/someone/harbor-fork")).toBe(false);
});

test("a single executable runs a build of main put beside it, unless what it carries is newer", () => {
  const inst = makeInstall();
  const embedded = (v: string): AppBundle => ({ meta: { version: v, minRuntime: "0.1.0" }, main: () => 0 });
  const chosen = { kind: "release" as const, path: join(inst.dir, "harbor-app.js"), id: "", version: "1.0.0+abc1234" };
  expect(useEmbedded(chosen, embedded("1.0.0"))).toBe(false);
  expect(useEmbedded(chosen, embedded("1.0.1"))).toBe(true);
  expect(useEmbedded({ ...chosen, version: "1.0.0" }, embedded("1.0.0"))).toBe(true);
});

test("a release the running build of main already holds is kept out; any other installs", async () => {
  const key = await makeKey();
  const host = new FakeHost();
  const inst = makeInstall({ version: "1.0.0+abc1234" });
  const cfg = host.config(inst, key, { version: "1.0.0+abc1234", worker: null, sleep: async () => undefined });
  await host.publishTs(key, "1.1.0");
  const asked: string[] = [];
  const kept = new Updater(cfg, { keep: (v) => (asked.push(v), true) });
  await kept.onRelease("1.1.0");
  expect(asked).toEqual(["1.1.0"]);
  expect(kept.state().t).toBe("upToDate");
  expect(readFileSync(join(inst.dir, "VERSION"), "utf8")).toBe("1.0.0+abc1234");
  // Not asked for what isn't newer: the same release number as the build.
  await kept.onRelease("1.0.0");
  expect(asked).toEqual(["1.1.0"]);
  const swapped: string[] = [];
  const broken = new Updater(cfg, { keep: () => Promise.reject(new Error("no git")), swap: (v) => void swapped.push(v) });
  await broken.onRelease("1.1.0");
  expect(swapped).toEqual(["1.1.0"]);
});

test("run health: uptime from beats, crashes from runs that never ended, shutdowns aren't crashes", () => {
  const dir = tmp();
  const t0 = 1_000_000;
  const dead = () => false;
  begin(dir, "c1", "1.0.0+c1", { pid: 10, boot: "b1", alive: dead }, t0);
  beat(dir, "c1", 10, t0 + 60_000);
  beat(dir, "c1", 10, t0 + 120_000);
  beat(dir, "c1", 10, t0 + 3_600_000); // a suspend: not counted
  expect(readHealth(dir).commits.c1?.uptimeMs).toBe(120_000);
  // Same boot, process gone without a word: a crash, an early one.
  begin(dir, "c1", "1.0.0+c1", { pid: 11, boot: "b1", alive: dead }, t0 + 3_700_000);
  let c1 = readHealth(dir).commits.c1;
  expect(c1?.crashes.length).toBe(1);
  // Another boot: the PC went down with it.
  begin(dir, "c1", "1.0.0+c1", { pid: 12, boot: "b2", alive: dead }, t0 + 4_000_000);
  expect(readHealth(dir).commits.c1?.crashes.length).toBe(1);
  end(dir, "c1", 12, 0, t0 + 4_060_000);
  c1 = readHealth(dir).commits.c1;
  expect(c1?.clean).toBe(1);
  expect(c1?.run).toBeNull();
  begin(dir, "c1", "1.0.0+c1", { pid: 13, boot: "b2", alive: dead }, t0 + 5_000_000);
  end(dir, "c1", 13, 1, t0 + 5_010_000);
  expect(readHealth(dir).commits.c1?.crashes.map((c) => c.why)).toContain("it exited with code 1");
  // The first crash came an hour into its run: only the last one was early.
  expect(earlyCrashes(readHealth(dir).commits.c1, t0 + 5_010_000)).toBe(1);
});

test("soaked: ran long enough, never crashed, checks passed", () => {
  const dir = tmp();
  const t0 = 1_000_000;
  begin(dir, "c", "1.0.0+c", { pid: 1, boot: "b", alive: () => true }, t0);
  for (let i = 1; i <= 7 * 60; i++) beat(dir, "c", 1, t0 + i * 60_000);
  const now = t0 + 7 * 3_600_000;
  expect(soak(readHealth(dir).commits.c, 6, now)).toEqual({ ok: false, why: "no checks recorded (not a follow-main build)" });
  recordChecks(dir, "c", "1.0.0+c", { tsc: true, smoke: true }, t0);
  expect(soak(readHealth(dir).commits.c, 6, now)).toEqual({ ok: true });
  expect(soak(readHealth(dir).commits.c, 8, now)).toEqual({ ok: false, why: "ran 7.0 h of 8 h" });
  expect(soak(undefined)).toEqual({ ok: false, why: "never ran here" });
});

const soakedHealth = (commits: Record<string, number>): HealthFile => ({
  commits: Object.fromEntries(
    Object.entries(commits).map(([c, h]) => [c, { commit: c, version: "", first: 0, uptimeMs: h * 3_600_000, crashes: [], checks: { tsc: true, smoke: true, at: 0 }, run: null, clean: 1 }]),
  ),
});

test("which commit a soaked release is cut at", () => {
  const commits = [
    { commit: "t", subject: "tip" },
    { commit: "m", subject: "middle" },
    { commit: "s", subject: "soaked" },
  ];
  const docsOnly = () => ["docs/a.md", "ts/test/x.test.ts"];
  const code = () => ["ts/run.ts"];
  const health = soakedHealth({ s: 7, m: 2 });
  expect(pickRelease({ commits, health, hours: 6, now: 0, changed: docsOnly })).toEqual({ kind: "tip", commit: "t", soakedAs: "s" });
  const p = pickRelease({ commits, health, hours: 6, now: 0, changed: code });
  expect(p.kind).toBe("soaked");
  expect(p.kind === "soaked" && p.commit).toBe("s");
  expect(pickRelease({ commits, health: soakedHealth({ m: 2 }), hours: 6, now: 0, changed: code }).kind).toBe("none");
  expect(pickRelease({ commits: [], health, hours: 6, now: 0, changed: code }).kind).toBe("none");
});

test("the release commit: version and changelog", () => {
  expect(nextVersion("0.165.1", "v0.165.1", false)).toBe("0.165.2");
  expect(nextVersion("0.165.1", "v0.165.1", true)).toBe("0.166.0");
  expect(nextVersion("0.165.1", "v0.165.3", false)).toBe("0.165.4");
  expect(setPackageVersion('{\n  "name": "x",\n  "version": "0.1.0",\n  "dependencies": { "a": "1" }\n}', "0.2.0")).toContain('"version": "0.2.0"');
  const log = "# Changelog\n\nintro\n\n## [Unreleased]\n\n### Fixed\n- a thing\n\n## [0.1.0] - 2026-01-01\n\n- old\n";
  expect(unreleased(log)).toBe("### Fixed\n- a thing");
  const out = releaseChangelog(log, "0.1.1", "2026-11-08");
  expect(out).toBe("# Changelog\n\nintro\n\n## [Unreleased]\n\n## [0.1.1] - 2026-11-08\n\n### Fixed\n- a thing\n\n## [0.1.0] - 2026-01-01\n\n- old\n");
  expect(() => releaseChangelog("## [Unreleased]\n\n## [0.1.0]\n", "0.1.1", "d")).toThrow("pass --note");
  expect(releaseChangelog("## [Unreleased]\n\n## [0.1.0]\n", "0.1.1", "d", { note: "faster" })).toContain("## [0.1.1] - d\n\n### Changed\n- faster\n");
  // An older commit's entries, merged into a main that wrote more since: the newer ones stay unreleased.
  const later = "## [Unreleased]\n\n### Added\n- newer\n\n### Fixed\n- a thing\n\n## [0.1.0] - 2026-01-01\n";
  expect(releaseChangelog(later, "0.1.1", "d", { only: "### Fixed\n- a thing" })).toBe("## [Unreleased]\n\n### Added\n- newer\n\n## [0.1.1] - d\n\n### Fixed\n- a thing\n\n## [0.1.0] - 2026-01-01\n");
  expect(() => releaseChangelog(later, "0.1.1", "d", { only: "### Fixed\n- other" })).toThrow("by hand");
});

test("a build of main installs like a release: what ran is kept, and a rollback brings it back", () => {
  const inst = makeInstall();
  const cfg = configFor(inst);
  const built = join(tmp(), "harbor-app.js");
  writeFileSync(built, bundleSource("1.0.0+abc1234"));
  installLocal(cfg, built, "1.0.0+abc1234");
  expect(readFileSync(join(inst.dir, "VERSION"), "utf8")).toBe("1.0.0+abc1234");
  expect(readFileSync(join(inst.dir, ".previous", "VERSION"), "utf8")).toBe("1.0.0");
  expect(readFileSync(join(inst.dir, "harbor-app.js"), "utf8")).toContain("1.0.0+abc1234");
  const r = rollback({ ...cfg, version: "1.0.0+abc1234" }, "test");
  expect(r.restored).toBe("1.0.0");
  expect(readFileSync(join(inst.dir, "harbor-app.js"), "utf8")).toContain('"1.0.0"');
});

// ---- follow-main against real git repositories, with the Bun steps faked ----

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

function rig(opts: { runningVersion?: string; running?: string; tsc?: () => number } = {}) {
  const repo = tmp("hfm-repo-");
  sh(repo, "git", "init", "-q", "-b", "main");
  const base = commit(repo, { "ts/package.json": '{ "version": "1.0.0", "packageManager": "bun@1.4.3" }\n', "ts/app.ts": "1\n", "ts/runtime.ts": "r\n" }, "1.0.0");
  sh(repo, "git", "tag", "v1.0.0");
  const running = opts.running ?? base;
  const version = opts.runningVersion ?? "1.0.0";
  const inst = makeInstall({ version });
  const cfg = configFor(inst, { version });
  const kv = new Map<string, string>([["follow_main_checkout", repo]]);
  const data = tmp("hfm-data-");
  const calls: string[] = [];
  const run: Runner = async (cmd, o) => {
    if (cmd[0] === "git") return defaultRunner(cmd, o);
    const step = cmd.slice(1).join(" ");
    calls.push(step.includes("bin/tsc") ? "check" : step.split(" ")[0] ?? "");
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
    run,
    watchRefs: () => () => undefined,
    boot: "boot-1",
  });
  return { repo, base, inst, cfg, kv, data, fm, calls };
}

const fmHome = (data: string) => join(data, "follow-main");

test("follow-main: a commit that changes the app is built in its own clone, checked and installed", async () => {
  const r = rig();
  r.fm.start();
  const c = commit(r.repo, { "ts/app.ts": "2\n" }, "change the app");
  await r.fm.poke();
  const v = `1.0.0+${c.slice(0, 7)}`;
  expect(r.fm.status().state).toBe("swapping");
  expect(readFileSync(join(r.inst.dir, "VERSION"), "utf8")).toBe(v);
  expect(readFileSync(join(r.inst.dir, ".previous", "VERSION"), "utf8")).toBe("1.0.0");
  expect(r.calls).toEqual(["install", "check", "scripts/build.ts"]);
  expect(readHealth(fmHome(r.data)).commits[c]?.checks).toMatchObject({ tsc: true, smoke: true });
  // Never the checkout's working tree: the clone is under the data folder.
  expect(existsSync(join(fmHome(r.data), "src", "ts", "app.ts"))).toBe(true);
  expect(statusLine(r.fm.status(), true)).toBe(`Restarting into ${v}…`);
  r.fm.stop();
});

test("follow-main: tests and docs alone build nothing; a runtime change is skipped and says why", async () => {
  const r = rig();
  r.fm.start();
  const docs = commit(r.repo, { "ts/README.md": "x\n", "ts/test/a.test.ts": "x\n" }, "docs");
  await r.fm.poke();
  expect(r.fm.status()).toMatchObject({ state: "idle", commit: docs });
  expect(r.fm.status().reason).toContain("changed nothing the app is built from");
  commit(r.repo, { "ts/runtime.ts": "r2\n" }, "runtime");
  await r.fm.poke();
  expect(r.fm.status().state).toBe("skipped");
  expect(r.fm.status().reason).toContain("needs a new runtime (ts/runtime.ts is part of the runtime)");
  // Only the one-time `bun install` that gets a PC ready for the first build.
  expect(r.calls).toEqual(["install"]);
  expect(readFileSync(join(r.inst.dir, "VERSION"), "utf8")).toBe("1.0.0");
  r.fm.stop();
});

test("follow-main: a failed build isn't tried again until main moves", async () => {
  let tsc = 1;
  const r = rig({ tsc: () => tsc });
  r.fm.start();
  const bad = commit(r.repo, { "ts/app.ts": "broken\n" }, "broken");
  await r.fm.poke();
  expect(r.fm.status()).toMatchObject({ state: "failed", commit: bad, reason: "tsc found errors" });
  await r.fm.poke();
  expect(r.calls).toEqual(["install", "check"]);
  expect(readHealth(fmHome(r.data)).commits[bad]?.checks).toMatchObject({ tsc: false });
  tsc = 0;
  const fixed = commit(r.repo, { "ts/app.ts": "fixed\n" }, "fixed");
  await r.fm.poke();
  expect(r.fm.status()).toMatchObject({ state: "swapping", commit: fixed });
  r.fm.stop();
});

test("follow-main: origin/main counts when it is ahead of main (a push from a worktree)", async () => {
  const r = rig();
  const c = commit(r.repo, { "ts/app.ts": "pushed\n" }, "pushed");
  sh(r.repo, "git", "update-ref", "refs/remotes/origin/main", c);
  sh(r.repo, "git", "update-ref", "refs/heads/main", r.base);
  sh(r.repo, "git", "checkout", "-q", "--detach", r.base);
  expect(await r.fm.tipOf(r.repo)).toBe(c);
  r.fm.start();
  await r.fm.poke();
  expect(r.fm.status()).toMatchObject({ state: "swapping", commit: c });
  r.fm.stop();
});

test("follow-main: a build that keeps crashing early is rolled back and not built again until main moves", async () => {
  const first = rig();
  first.fm.start();
  const c = commit(first.repo, { "ts/app.ts": "crashy\n" }, "crashy");
  await first.fm.poke();
  first.fm.stop();
  const v = `1.0.0+${c.slice(0, 7)}`;
  // Two starts of it that died without a word.
  const home = fmHome(first.data);
  begin(home, c, v, { pid: 999_991, boot: "boot-1", alive: () => false }, Date.now() - 60_000);
  begin(home, c, v, { pid: 999_992, boot: "boot-1", alive: () => false }, Date.now() - 30_000);
  const kv = first.kv;
  const again = new FollowMain({
    cfg: configFor(first.inst, { version: v }),
    kv: { get: (k) => kv.get(k) ?? null, set: (k, val) => void kv.set(k, val) },
    dataDir: first.data,
    repos: () => [],
    busy: () => false,
    commit: c,
    run: defaultRunner,
    watchRefs: () => () => undefined,
    boot: "boot-1",
    pid: 999_993,
  });
  again.start();
  expect(again.status().state).toBe("failed");
  expect(again.status().reason).toContain("crashed 2 times");
  expect(readFileSync(join(first.inst.dir, "VERSION"), "utf8")).toBe("1.0.0");
  expect(readHealth(home).commits[c]?.crashes.length).toBeGreaterThanOrEqual(2);
  again.stop();
  // The release that came back looks at main again: the same commit isn't built.
  first.fm.start();
  await first.fm.poke();
  expect(first.fm.status().state).toBe("failed");
  expect(first.fm.status().reason).toContain("waiting for main to move");
  first.fm.stop();
});

test("follow-main: a release whose tag the build of main already holds is kept out", async () => {
  const r = rig();
  const tagged = commit(r.repo, { "ts/app.ts": "released\n" }, "1.0.1");
  sh(r.repo, "git", "tag", "v1.0.1");
  const later = commit(r.repo, { "ts/app.ts": "later\n" }, "later");
  sh(r.repo, "git", "checkout", "-q", "-b", "side", r.base);
  commit(r.repo, { "ts/other.ts": "x\n" }, "1.0.2");
  sh(r.repo, "git", "tag", "v1.0.2");
  sh(r.repo, "git", "checkout", "-q", "main");
  const kv = r.kv;
  const fm = new FollowMain({
    cfg: configFor(r.inst, { version: `1.0.0+${later.slice(0, 7)}` }),
    kv: { get: (k) => kv.get(k) ?? null, set: (k, v) => void kv.set(k, v) },
    dataDir: r.data,
    repos: () => [],
    busy: () => false,
    commit: later,
    run: defaultRunner,
    watchRefs: () => () => undefined,
  });
  expect(tagged).not.toBe(later);
  expect(await fm.keeps("1.0.1")).toBe(true);
  expect(await fm.keeps("1.0.2")).toBe(false);
  kv.set("follow_main_off", "1");
  expect(await fm.keeps("1.0.1")).toBe(false);
});

test("follow-main is on by default where there's a Harbor checkout; off only when turned off; 0.166's opt-in key is ignored", () => {
  const kv = new Map<string, string>();
  const store = { get: (k: string) => kv.get(k) ?? null, set: (k: string, v: string) => void kv.set(k, v) };
  let repos: { path: string; remote: string; local: string | null }[] = [];
  const fm = new FollowMain({ cfg: configFor(makeInstall({ version: "1.0.0" }), { version: "1.0.0" }), kv: store, dataDir: tmp("hfm-def-"), repos: () => repos, busy: () => false, commit: null, run: defaultRunner, watchRefs: () => () => undefined });
  expect(enabled(store)).toBe(true);
  // No checkout: releases only, and nothing to say about it.
  expect(fm.on()).toBe(false);
  repos = [{ path: "/src/harbor", remote: "git@github.com:RDevNeo/harbor.git", local: null }];
  expect(fm.on()).toBe(true);
  kv.set("follow_main", "0");
  expect(fm.on()).toBe(true);
  fm.setOn(false);
  expect(kv.get("follow_main_off")).toBe("1");
  expect(fm.on()).toBe(false);
  setEnabled(store, true);
  expect(fm.on()).toBe(true);
});

test("the edit-to-running line", () => {
  expect(timelineText({ commit: "c", version: "1.0.0+c", committedAt: 0, noticedAt: 3000, builtAt: 9000, liveAt: 12000 })).toBe("1.0.0+c ran 12 s after its commit (noticed 3 s, built 6 s, restarted 3 s).");
});

// ---- the public main, without a checkout or ahead of a stale one ----

function remoteRig(opts: { checkout?: boolean; worker?: string; fetch?: typeof fetch } = {}) {
  const upstream = tmp("hfm-up-");
  sh(upstream, "git", "init", "-q", "-b", "main");
  const base = commit(upstream, { "ts/package.json": '{ "version": "1.0.0", "packageManager": "bun@1.4.3" }\n', "ts/app.ts": "1\n", "ts/runtime.ts": "r\n" }, "1.0.0");
  sh(upstream, "git", "tag", "v1.0.0");
  const running = commit(upstream, { "ts/app.ts": "running\n" }, "what runs");
  const inst = makeInstall({ version: "1.0.0" });
  const cfg = configFor(inst, { version: "1.0.0", ...(opts.worker ? { worker: opts.worker } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}) });
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
    run,
    watchRefs: () => () => undefined,
    boot: "boot-1",
  });
  return { upstream, base, running, checkout, inst, data, fm, calls, kv };
}

test("follow-main without a checkout: the public main is cloned into the data folder and built", async () => {
  const r = remoteRig();
  expect(r.fm.on()).toBe(true);
  r.fm.start();
  await r.fm.poke();
  expect(r.fm.status()).toMatchObject({ state: "idle", commit: r.running });
  const c = commit(r.upstream, { "ts/app.ts": "pushed\n" }, "pushed");
  await r.fm.poke();
  expect(r.fm.status()).toMatchObject({ state: "swapping", commit: c, version: `1.0.0+${c.slice(0, 7)}` });
  expect(readFileSync(join(r.inst.dir, "VERSION"), "utf8")).toBe(`1.0.0+${c.slice(0, 7)}`);
  // The first look found nothing to build: the clone got ready (`bun install`) for the first push.
  expect(r.calls).toEqual(["install", "install", "check", "scripts/build.ts"]);
  expect(sh(join(fmHome(r.data), "src"), "git", "config", "remote.origin.url")).toBe(r.upstream);
  expect(r.fm.status().checkout).toBe(r.upstream);
  r.fm.stop();
});

test("follow-main without a checkout: a rewritten main (force-push) that doesn't descend from what runs is skipped", async () => {
  const r = remoteRig();
  r.fm.start();
  sh(r.upstream, "git", "reset", "-q", "--hard", r.base);
  const rewritten = commit(r.upstream, { "ts/app.ts": "other history\n" }, "rewritten");
  await r.fm.poke();
  expect(r.fm.status()).toMatchObject({ state: "skipped", commit: rewritten });
  expect(r.fm.status().reason).toContain("doesn't descend from what runs");
  expect(r.calls.filter((c) => c !== "install")).toEqual([]);
  expect(readFileSync(join(r.inst.dir, "VERSION"), "utf8")).toBe("1.0.0");
  r.fm.stop();
});

test("follow-main with a stale checkout builds the public main; with the checkout ahead, the checkout's", async () => {
  const r = remoteRig({ checkout: true });
  r.fm.start();
  const pushed = commit(r.upstream, { "ts/app.ts": "from elsewhere\n" }, "pushed from another PC");
  await r.fm.poke();
  expect(r.fm.status()).toMatchObject({ state: "swapping", commit: pushed });
  r.fm.stop();
  const co = r.checkout as string;
  sh(co, "git", "pull", "-q", "--ff-only");
  const local = commit(co, { "ts/app.ts": "not pushed yet\n" }, "local");
  const kv = r.kv;
  const next = new FollowMain({
    cfg: configFor(r.inst, { version: `1.0.0+${pushed.slice(0, 7)}` }),
    kv: { get: (k) => kv.get(k) ?? null, set: (k, v) => void kv.set(k, v) },
    dataDir: r.data,
    repos: () => [],
    busy: () => false,
    commit: pushed,
    remote: r.upstream,
    run: async (cmd, o) => (cmd[0] === "git" ? defaultRunner(cmd, o) : (cmd.join(" ").includes("scripts/build.ts") && writeFileSync(cmd[3] as string, bundleSource(cmd[cmd.indexOf("--version") + 1] as string)), { code: 0, out: "" })),
    watchRefs: () => () => undefined,
  });
  next.start();
  await next.poke();
  expect(next.status()).toMatchObject({ state: "swapping", commit: local, checkout: co });
  next.stop();
});

test("follow-main hears of a push from the worker's long poll and looks at once", async () => {
  const asked: string[] = [];
  let answer: ((sha: string) => void) | null = null;
  const fake = Object.assign(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      asked.push(url.replace(/^.*\/v1/, "/v1"));
      return new Promise<Response>((resolve) => {
        answer = (sha) => resolve(Response.json({ sha, at: 1234 }));
        init?.signal?.addEventListener("abort", () => resolve(new Response(null, { status: 204 })), { once: true });
      });
    },
    { preconnect: () => undefined },
  ) as typeof fetch;
  const r = remoteRig({ worker: "http://worker", fetch: fake });
  r.fm.start();
  await r.fm.poke();
  await Bun.sleep(20);
  expect(asked).toEqual(["/v1/main/wait?have="]);
  (answer as unknown as (sha: string) => void)(r.running);
  await Bun.sleep(20);
  expect(asked[1]).toBe(`/v1/main/wait?have=${r.running}`);
  const c = commit(r.upstream, { "ts/app.ts": "pushed\n" }, "pushed");
  (answer as unknown as (sha: string) => void)(c);
  for (let i = 0; i < 100 && r.fm.status().state !== "swapping"; i++) await Bun.sleep(50);
  expect(r.fm.status()).toMatchObject({ state: "swapping", commit: c });
  const st = JSON.parse(readFileSync(join(fmHome(r.data), "state.json"), "utf8")) as { pending: { pushedAt?: number } };
  expect(st.pending.pushedAt).toBe(1234);
  r.fm.stop();
});

test("the push-to-running line", () => {
  expect(timelineText({ commit: "c", version: "1.0.0+c", committedAt: 0, pushedAt: 10_000, noticedAt: 11_000, builtAt: 16_000, liveAt: 19_000 })).toBe("1.0.0+c ran 9 s after its push (heard 1 s, built 5 s, restarted 3 s).");
});

test("a push from this PC's checkout tells the worker at once, with this PC's token, once per commit", async () => {
  const posts: { url: string; auth: string | null; body: string }[] = [];
  let posted: () => void = () => undefined;
  const whenPosted = new Promise<void>((resolve) => (posted = resolve));
  const fake = Object.assign(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.includes("/v1/main/wait")) return new Promise<Response>((resolve) => init?.signal?.addEventListener("abort", () => resolve(new Response(null, { status: 204 })), { once: true }));
      posts.push({ url: url.replace(/^.*\/v1/, "/v1"), auth: new Headers(init?.headers).get("authorization"), body: String(init?.body) });
      posted();
      return Response.json({ ok: true }, { status: 202 });
    },
    { preconnect: () => undefined },
  ) as typeof fetch;
  const upstream = tmp("hfm-up-");
  sh(upstream, "git", "init", "-q", "-b", "main");
  const base = commit(upstream, { "ts/package.json": '{ "version": "1.0.0" }\n', "ts/app.ts": "1\n" }, "1.0.0");
  sh(upstream, "git", "checkout", "-q", "--detach");
  const checkout = join(tmp("hfm-co-"), "harbor");
  sh(upstream, "git", "clone", "-q", upstream, checkout);
  let fire: () => void = () => undefined;
  let token: string | null = "pc-token";
  const kv = new Map<string, string>([["follow_main_checkout", checkout]]);
  const fm = new FollowMain({
    cfg: configFor(makeInstall({ version: "1.0.0" }), { version: "1.0.0", worker: "http://worker", fetch: fake }),
    kv: { get: (k) => kv.get(k) ?? null, set: (k, v) => void kv.set(k, v) },
    dataDir: tmp("hfm-data-"),
    repos: () => [],
    busy: () => false,
    commit: base,
    remote: upstream,
    token: () => token,
    run: defaultRunner,
    watchRefs: (_dir, on) => ((fire = on), () => undefined),
  });
  try {
    fm.start();
    // A push from the checkout: a new commit lands upstream and origin/main moves.
    const c = commit(checkout, { "ts/app.ts": "2\n" }, "pushed from here");
    sh(checkout, "git", "push", "-q", "origin", "HEAD:main");
    fire();
    fire();
    await whenPosted;
    expect(posts).toEqual([{ url: "/v1/main", auth: "Bearer pc-token", body: JSON.stringify({ sha: c }) }]);
    // The same commit again (any other ref write): nothing more. Signed out: nothing.
    expect(await fm.nudge(checkout)).toBe(false);
    token = null;
    sh(checkout, "git", "commit", "-q", "--allow-empty", "-m", "x");
    sh(checkout, "git", "push", "-q", "origin", "HEAD:main");
    expect(await fm.nudge(checkout)).toBe(false);
    expect(posts.length).toBe(1);
  } finally {
    fm.stop();
  }
}, 10_000);
