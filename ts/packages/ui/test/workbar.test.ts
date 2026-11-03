import { expect, test } from "bun:test";
import { ICONS } from "../src/icons.ts";
import { branchClick, prChip, renameBranchNote, renameFolderNote, workBar, type WsInfo, wsClick } from "../src/logic/workbar.ts";

const checkout: WsInfo = { git: true, mode: "checkout", name: null, path: "/src/app", branch: "main", dirty: 0, base: "", can_move: true, can_rename: false, can_rename_folder: false, pending: null };
const own: WsInfo = { ...checkout, mode: "worktree", name: "app-fix-login", path: "/data/worktrees/app-fix-login", branch: "harbor/fix-login", can_rename: true, can_rename_folder: true, pushed: "origin" };
const o = { draft: false, marker: null, pr: null, home: "", pending: null };

test("a chat in the checkout, one in its own worktree, a new chat's picks", () => {
  const a = workBar(checkout, o);
  expect([a.shown, a.ws?.text, a.ws?.icon, a.branch?.text, a.live]).toEqual([true, "Current checkout", ICONS.FOLDER, "main", true]);
  const b = workBar(own, o);
  expect([b.ws?.text, b.ws?.icon, b.branch?.text]).toEqual(["Worktree · app-fix-login", ICONS.FOLDER_GIT, "harbor/fix-login"]);
  const c = workBar({ ...checkout, mode: "worktree", base: "main" }, { ...o, draft: true });
  expect([c.ws?.text, c.branch?.text]).toEqual(["New worktree", "from main"]);
  expect(workBar({ git: false }, o).shown).toBe(false);
  expect(workBar(null, o).shown).toBe(false);
});

test("gone, another PC's worktree, another PC's checkout with a PR", () => {
  const gone = workBar(own, { ...o, marker: { name: "app-fix-login", gone: true } });
  expect([gone.ws?.text, gone.ws?.tone, gone.branch]).toEqual(["Worktree gone", "red", null]);
  const far = workBar({ git: false }, { ...o, marker: { name: "app-fix", gone: false }, home: "laptop" });
  expect([far.ws?.text, far.ws?.tip, far.branch, far.live]).toEqual(["Worktree · app-fix", "Runs in its own worktree on laptop, app-fix", null, false]);
  const pr = { state: "merged", label: "PR #12 · Merged", title: "Fix login", url: "https://example.org/pr/12" };
  const onlyPr = workBar({ git: false }, { ...o, pr });
  expect([onlyPr.shown, onlyPr.ws, onlyPr.pr?.text, onlyPr.pr?.tone]).toEqual([true, null, "PR #12 · Merged", "purple"]);
  expect(prChip({ ...pr, state: "open" })?.icon).toBe(ICONS.PR_OPEN);
});

test("what git is doing shows on its chip", () => {
  expect(workBar(checkout, { ...o, pending: { branch: true, what: "Switching to dev…" } }).branch?.text).toBe("Switching to dev…");
  expect(workBar({ ...checkout, pending: "Creating worktree…" }, o).ws?.text).toBe("Creating worktree…");
});

test("a chat's own worktree goes straight to renaming; elsewhere the menu and the picker", () => {
  expect([wsClick(own, false), branchClick(own, false)]).toEqual(["rename", "rename"]);
  expect([wsClick(checkout, false), branchClick(checkout, false)]).toEqual(["menu", "picker"]);
  expect([wsClick(own, true), branchClick(own, true)]).toEqual(["menu", "picker"]);
  // Detached: the folder still renames, the branch chip picks one.
  expect(branchClick({ ...own, branch: "", can_rename: false }, false)).toBe("picker");
  expect(wsClick({ git: false }, false)).toBe("none");
  expect(renameBranchNote({ ...own, folder_waits: "an agent works in it" })).toBe("The worktree's folder follows the new name once nothing works in it (an agent works in it now).");
  expect(renameBranchNote({ ...own, folder_named: true })).toBe("The folder keeps its name, app-fix-login: you named it.");
  expect(renameFolderNote(own)).toStartWith("Stays in /data/worktrees;");
});
