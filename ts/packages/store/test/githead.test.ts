import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchLabel, branchOf } from "../src/githead.ts";

test("a checkout's and a worktree's branch are read from their HEAD files", () => {
  const root = mkdtempSync(join(tmpdir(), "githead-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, ".git", "worktrees", "wt"), { recursive: true });
  writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  const wt = join(root, "wt");
  mkdirSync(wt);
  writeFileSync(join(wt, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "wt")}\n`);
  writeFileSync(join(repo, ".git", "worktrees", "wt", "HEAD"), "ref: refs/heads/harbor/fix-login\n");
  expect(branchOf(repo, 1)).toBe("main");
  expect(branchOf(wt, 1)).toBe("harbor/fix-login");
  // Detached, or no git at all: none.
  const det = join(root, "det");
  mkdirSync(join(det, ".git"), { recursive: true });
  writeFileSync(join(det, ".git", "HEAD"), "4f2a9c1e\n");
  expect(branchOf(det, 1)).toBe("");
  expect(branchOf(join(root, "nothing"), 1)).toBe("");
  // Read again only once the last read is 5 s old.
  writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/next\n");
  expect(branchOf(repo, 2000)).toBe("main");
  expect(branchOf(repo, 6000)).toBe("next");
});

test("the sidebar names a branch without Harbor's harbor/", () => {
  expect(branchLabel("harbor/video-transcription")).toBe("video-transcription");
  expect(branchLabel("feature/x")).toBe("feature/x");
  expect(branchLabel("harbor/")).toBe("harbor/");
  expect(branchLabel("main")).toBe("main");
});
