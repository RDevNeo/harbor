// Soak-gated releases (ts/scripts/soaked.ts): which commit may be released, from health.json (health.ts),
// and the release commit's edits. Plain functions; the script does the git work.
import { shipsInApp } from "./followmain.ts";
import { soak, type CommitHealth, type HealthFile } from "./health.ts";
import { parse } from "./version.ts";

/** What a release ships beyond the app bundle: a change here since the soaked commit wasn't soaked. */
export function ships(path: string): boolean {
  return shipsInApp(path) || /^(android|browser|video|slint|packaging|discord|whatsapp)\//.test(path);
}

export interface Candidate {
  commit: string;
  subject: string;
}

export type Pick =
  | { kind: "tip"; commit: string; soakedAs: string }
  | { kind: "soaked"; commit: string; tip: string; why: string }
  | { kind: "none"; why: string };

export interface PickInput {
  /** main's commits since the last release, newest first (git rev-list). */
  commits: Candidate[];
  health: HealthFile;
  hours: number;
  now: number;
  /** Files changed between two commits (git diff --name-only a b). */
  changed: (from: string, to: string) => string[];
}

/**
 * The newest soaked commit, and whether main's tip is the same release: nothing that ships changed since.
 * Then the release is cut at the tip as always; otherwise at the soaked commit itself.
 */
export function pickRelease(i: PickInput): Pick {
  const tip = i.commits[0];
  if (tip === undefined) return { kind: "none", why: "nothing on main since the last release" };
  const soaked = i.commits.find((c) => soak(i.health.commits[c.commit], i.hours, i.now).ok);
  if (soaked === undefined) {
    const best = i.commits.map((c) => i.health.commits[c.commit]).find((h): h is CommitHealth => h !== undefined);
    const why = best === undefined ? "no commit since the last release ran here through follow-main" : `the newest that ran here, ${best.commit.slice(0, 7)}, ${(soak(best, i.hours, i.now) as { why: string }).why}`;
    return { kind: "none", why: `no commit has soaked ${i.hours} h: ${why}` };
  }
  if (soaked.commit === tip.commit) return { kind: "tip", commit: tip.commit, soakedAs: soaked.commit };
  const moved = i.changed(soaked.commit, tip.commit).filter(ships);
  if (moved.length === 0) return { kind: "tip", commit: tip.commit, soakedAs: soaked.commit };
  return { kind: "soaked", commit: soaked.commit, tip: tip.commit, why: `main changed ${moved.length} shipped file${moved.length === 1 ? "" : "s"} since (${moved.slice(0, 3).join(", ")}${moved.length > 3 ? ", …" : ""})` };
}

export function nextVersion(current: string, latestTag: string, minor: boolean): string {
  const p = parse(current);
  const t = parse(latestTag);
  if (p === null) throw new Error(`can't read version ${current}`);
  let [ma, mi, pa] = p;
  if (t !== null && (t[0] > ma || (t[0] === ma && (t[1] > mi || (t[1] === mi && t[2] > pa))))) [ma, mi, pa] = t;
  return minor ? `${ma}.${mi + 1}.0` : `${ma}.${mi}.${pa + 1}`;
}

export function setPackageVersion(text: string, version: string): string {
  const out = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
  if (out === text && !text.includes(`"version": "${version}"`)) throw new Error("no version field in ts/package.json");
  return out;
}

const UNRELEASED = /^## \[Unreleased\][^\n]*\n/m;

/** The [Unreleased] section's text (what the release notes will say), trimmed. */
export function unreleased(changelog: string): string {
  const m = UNRELEASED.exec(changelog);
  if (m === null) return "";
  const rest = changelog.slice(m.index + m[0].length);
  const next = rest.search(/^## /m);
  return (next < 0 ? rest : rest.slice(0, next)).trim();
}

/**
 * The release's CHANGELOG: [Unreleased]'s entries go under `## [version] - date`, or, when `only` is given
 * (a release of an older commit, merged back into a main that wrote more since), only those entries do and
 * the newer ones stay under [Unreleased]. `note` adds a line under "### Changed" when there's nothing else.
 */
export function releaseChangelog(changelog: string, version: string, date: string, opts: { only?: string; note?: string } = {}): string {
  const m = UNRELEASED.exec(changelog);
  if (m === null) throw new Error("CHANGELOG.md has no ## [Unreleased] heading");
  const head = changelog.slice(0, m.index + m[0].length);
  let rest = changelog.slice(m.index + m[0].length);
  const heading = `## [${version}] - ${date}\n`;
  const body = unreleased(changelog);
  let notes = opts.only === undefined ? body : opts.only.trim();
  if (notes === "" && opts.note !== undefined) notes = `### Changed\n- ${opts.note.trim()}`;
  if (notes === "") throw new Error("nothing under [Unreleased] in CHANGELOG.md for the release notes (pass --note)");
  if (opts.only === undefined) {
    const next = rest.search(/^## /m);
    rest = next < 0 ? "" : rest.slice(next);
    return `${head}\n${heading}\n${notes}\n\n${rest}`;
  }
  // The older commit's entries are a block of today's [Unreleased]: it moves under the heading.
  const sectionEnd = rest.search(/^## /m);
  const section = sectionEnd < 0 ? rest : rest.slice(0, sectionEnd);
  const at = opts.only.trim() === "" ? -1 : section.indexOf(notes);
  if (at < 0 && opts.only.trim() !== "") throw new Error("CHANGELOG.md's [Unreleased] changed around the soaked commit's entries: cut this release by hand");
  const newer = (at < 0 ? section : section.slice(0, at) + section.slice(at + notes.length)).trim();
  const after = sectionEnd < 0 ? "" : rest.slice(sectionEnd);
  return `${head}${newer === "" ? "" : `\n${newer}\n`}\n${heading}\n${notes}\n\n${after}`;
}
