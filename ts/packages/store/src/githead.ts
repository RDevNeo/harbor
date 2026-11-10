import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** How long a folder's branch is trusted before its HEAD is read again (the sidebar asks on every redraw). */
const TTL_MS = 5000;
const known = new Map<string, { at: number; branch: string }>();

/**
 * The branch checked out in `dir` (a repository or one of its worktrees), read from its HEAD file
 * without running git: "" when it's detached, not a git folder, or can't be read.
 */
export function branchOf(dir: string, now = Date.now()): string {
  const k = known.get(dir);
  if (k && now - k.at < TTL_MS) return k.branch;
  const branch = readBranch(dir);
  known.set(dir, { at: now, branch });
  return branch;
}

function readBranch(dir: string): string {
  try {
    const dotGit = join(dir, ".git");
    // A worktree's .git is a file naming its own git folder ("gitdir: …"); a checkout's is the folder.
    let gitDir = dotGit;
    if (!statSync(dotGit).isDirectory()) {
      const line = readFileSync(dotGit, "utf8").trim();
      if (!line.startsWith("gitdir:")) return "";
      const p = line.slice(7).trim();
      gitDir = isAbsolute(p) ? p : join(dir, p);
    }
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    return head.startsWith("ref: refs/heads/") ? head.slice(16) : "";
  } catch {
    return "";
  }
}

/** A branch as the sidebar names it: without the "harbor/" Harbor puts before the worktrees it makes. */
export function branchLabel(branch: string): string {
  return branch.startsWith("harbor/") && branch.length > 7 ? branch.slice(7) : branch;
}
