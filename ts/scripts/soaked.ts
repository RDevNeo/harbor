// Soak-gated releases: a release tag only for a commit that ran on this PC (follow-main) for some hours
// without a crash, and whose checks passed. Manual tagging works as before; this is the careful way.
//
//   bun ts/scripts/soaked.ts [status]          main's commits since the last release, and how each soaked
//   bun ts/scripts/soaked.ts gate [COMMIT]     exit 0 when COMMIT (default origin/main) may be released
//   bun ts/scripts/soaked.ts release [--minor] [--note TEXT] [--message TEXT] [--no-check] [--dry-run]
//                                              bump, commit, push main, tag (see below)
//   options: --hours N (default 6), --data DIR (Harbor's data folder), --offline (no git fetch)
//
// release picks the newest soaked commit. When nothing that ships changed on main since (only tests,
// docs, scripts), the release is cut at main's tip as always: CHANGELOG's [Unreleased] goes under the
// new version, ts/package.json says it, that commit goes to main and gets the tag. Otherwise the release
// is the soaked commit itself: the version commit is made on it and tagged, and a merge commit brings it
// into main (the newer [Unreleased] entries stay there). Before anything is pushed, scripts/boat/check
// runs on the release commit (--no-check skips it). Run it from a clone of Harbor; it works in a
// temporary worktree and never touches yours.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataDir } from "../packages/store/src/paths.ts";
import { DIR } from "../packages/update/src/followmain.ts";
import { hoursText, readHealth, soak, SOAK_HOURS } from "../packages/update/src/health.ts";
import { nextVersion, pickRelease, releaseChangelog, setPackageVersion, unreleased, type Candidate } from "../packages/update/src/soak.ts";

const args = process.argv.slice(2);
const flag = (n: string): boolean => args.includes(n);
const opt = (n: string): string | undefined => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const verb = args[0] !== undefined && !args[0].startsWith("--") ? args[0] : "status";
const hours = Number(opt("--hours") ?? SOAK_HOURS);
const data = join(opt("--data") ?? dataDir(), DIR);

function git(a: string[], cwd = process.cwd(), allowFail = false): string {
  const r = Bun.spawnSync(["git", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0 && !allowFail) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString().trim()}`);
  return r.exitCode === 0 ? r.stdout.toString().trim() : "";
}

const die = (m: string, code = 1): never => {
  console.error(`soaked: ${m}`);
  process.exit(code);
};

if (!Number.isFinite(hours) || hours < 0) die("--hours wants a number");
const top = git(["rev-parse", "--show-toplevel"], process.cwd(), true) || die("run it inside a clone of Harbor");
if (!flag("--offline")) git(["fetch", "--quiet", "--tags", "origin"], top, true);
const main = git(["rev-parse", "refs/remotes/origin/main"], top);
const lastTag = git(["describe", "--tags", "--abbrev=0", "--match", "v*", main], top, true);
const range = lastTag === "" ? main : `${lastTag}..${main}`;
const commits: Candidate[] = git(["log", "--format=%H%x09%s", range], top)
  .split("\n")
  .filter(Boolean)
  .map((l) => ({ commit: l.slice(0, 40), subject: l.slice(41) }));
const health = readHealth(data);
const now = Date.now();
const changed = (a: string, b: string): string[] => git(["diff", "--name-only", a, b], top).split("\n").filter(Boolean);

if (verb === "status") {
  console.log(`since ${lastTag || "the start"}: ${commits.length} commit(s) on origin/main; soak ${hours} h; health from ${data}`);
  for (const c of commits) {
    const h = health.commits[c.commit];
    const s = soak(h, hours, now);
    const ran = h === undefined ? "" : ` [ran ${hoursText(h.uptimeMs)}]`;
    console.log(`${c.commit.slice(0, 7)} ${s.ok ? "soaked " : "-      "} ${c.subject.slice(0, 70)}${ran}${s.ok || h === undefined ? "" : `: ${s.why}`}`);
  }
  const p = pickRelease({ commits, health, hours, now, changed });
  console.log(p.kind === "none" ? `\nnothing to release: ${p.why}` : p.kind === "tip" ? `\nrelease would be main's tip ${p.commit.slice(0, 7)} (soaked as ${p.soakedAs.slice(0, 7)})` : `\nrelease would be ${p.commit.slice(0, 7)} itself: ${p.why}`);
  process.exit(0);
}

if (verb === "gate") {
  const want = git(["rev-parse", `${args[1] && !args[1].startsWith("--") ? args[1] : main}^{commit}`], top);
  const own = soak(health.commits[want], hours, now);
  if (own.ok) process.exit((console.log(`${want.slice(0, 7)} soaked`), 0));
  // A commit after a soaked one that changed nothing that ships counts as that one.
  const at = commits.findIndex((c) => c.commit === want);
  const p = pickRelease({ commits: at < 0 ? [] : commits.slice(at), health, hours, now, changed });
  if (p.kind === "tip") process.exit((console.log(`${want.slice(0, 7)} soaked as ${p.soakedAs.slice(0, 7)}`), 0));
  die(`${want.slice(0, 7)} isn't soaked: ${p.kind === "none" ? p.why : own.why}`);
}

if (verb !== "release") die("usage: soaked.ts [status|gate [COMMIT]|release] [--hours N] [--minor] [--note TEXT] [--message TEXT] [--no-check] [--dry-run] [--data DIR] [--offline]", 2);

const pick = pickRelease({ commits, health, hours, now, changed });
if (pick.kind === "none") die(pick.why);
const base = pick.commit;
const show = (ref: string, file: string): string => git(["show", `${ref}:${file}`], top);
const pkg = show(base, "ts/package.json");
const version = nextVersion((JSON.parse(pkg) as { version: string }).version, lastTag, flag("--minor"));
const date = new Date().toISOString().slice(0, 10);
const note = opt("--note");
const notes = unreleased(show(base, "CHANGELOG.md"));
const firstLine = (notes.split("\n").find((l) => l.startsWith("- ")) ?? `- ${note ?? ""}`).slice(2).replace(/\s+/g, " ").trim();
const message = `${version}: ${opt("--message") ?? (firstLine || commits.find((c) => c.commit === base)?.subject || "release")}`;

const wt = mkdtempSync(join(tmpdir(), "harbor-soaked-"));
const cleanup = (): void => {
  git(["worktree", "remove", "--force", wt], top, true);
  rmSync(wt, { recursive: true, force: true });
};
try {
  git(["worktree", "add", "--quiet", "--detach", wt, base], top);
  const edit = (file: string, f: (t: string) => string): void => writeFileSync(join(wt, file), f(readFileSync(join(wt, file), "utf8")));
  edit("ts/package.json", (t) => setPackageVersion(t, version));
  edit("CHANGELOG.md", (t) => releaseChangelog(t, version, date, note === undefined ? {} : { note }));
  git(["commit", "--quiet", "-m", `${message}\n\nSoaked: ${pick.kind === "tip" ? pick.soakedAs : pick.commit} ran ${hours} h or more on follow-main without a crash.`, "--", "ts/package.json", "CHANGELOG.md"], wt);
  const release = git(["rev-parse", "HEAD"], wt);
  let toMain = release;
  if (pick.kind === "soaked") {
    // Into main: main's tree, the release as a second parent, the version and the heading on top.
    git(["checkout", "--quiet", "--detach", pick.tip], wt);
    git(["merge", "--quiet", "--no-commit", "-s", "ours", release], wt);
    edit("ts/package.json", (t) => setPackageVersion(t, version));
    edit("CHANGELOG.md", (t) => releaseChangelog(t, version, date, { only: notes, ...(note === undefined ? {} : { note }) }));
    git(["add", "ts/package.json", "CHANGELOG.md"], wt);
    git(["commit", "--quiet", "-m", `Merge release ${version} (${base.slice(0, 7)}) into main`], wt);
    toMain = git(["rev-parse", "HEAD"], wt);
  }
  console.log(`release ${version} at ${release.slice(0, 7)} (${pick.kind === "tip" ? "main's tip" : `soaked ${base.slice(0, 7)}; ${pick.why}`}): ${message}`);
  if (!flag("--no-check")) {
    git(["checkout", "--quiet", "--detach", release], wt);
    console.log("scripts/boat/check on the release commit…");
    const r = Bun.spawnSync([join(wt, "scripts/boat/check"), "-q", "--no-release"], { cwd: wt, stdout: "inherit", stderr: "inherit" });
    if (r.exitCode !== 0) die(`scripts/boat/check failed on ${release.slice(0, 7)}: nothing was pushed`);
  }
  if (flag("--dry-run")) {
    console.log(`dry run: would push ${toMain.slice(0, 7)} to main and tag ${release.slice(0, 7)} as v${version}`);
  } else {
    git(["push", "--quiet", "origin", `${toMain}:refs/heads/main`], top);
    git(["tag", `v${version}`, release], top);
    git(["push", "--quiet", "origin", `v${version}`], top);
    console.log(`pushed main (${toMain.slice(0, 7)}) and v${version}`);
  }
} finally {
  cleanup();
}
