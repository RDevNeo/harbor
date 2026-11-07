import { expect, test } from "bun:test";
import { projectMenu } from "../packages/ui/src/logic/projectmenu.ts";

test("project_menu_matches_sidebar_rs_order", () => {
  const labels = (remote: string | null, main: boolean, customIcon: boolean, settled = false) => projectMenu({ remote, main, customIcon, settled }).map((i) => (i.sep ? `— ${i.label}` : i.label));
  expect(labels("https://github.com/sam/x", true, true)).toEqual(["Open terminal", "Pull requests", "Issues", "Open remote", "— Rename main chat", "Settle main chat", "— Refresh icon", "Choose icon…", "Use website icon", "— Settle project", "Move to PC…", "Remove from Harbor"]);
  expect(labels("https://gitlab.com/sam/x", false, false)).toEqual(["Open terminal", "Open remote", "— Refresh icon", "Choose icon…", "— Settle project", "Move to PC…", "Remove from Harbor"]);
  expect(labels(null, false, false)).toEqual(["Open terminal", "— Refresh icon", "Choose icon…", "— Settle project", "Move to PC…", "Remove from Harbor"]);
  expect(labels(null, false, false, true)).toEqual(["Open terminal", "— Refresh icon", "Choose icon…", "— Unsettle project", "Move to PC…", "Remove from Harbor"]);
});

test("project_menu_offers_move_to_workspace_greyed_with_why", () => {
  const items = (moveWhy: string | null) => projectMenu({ remote: null, main: false, customIcon: false, moveWhy });
  expect(items(null).map((i) => (i.sep ? `— ${i.label}` : i.label))).toEqual(["Open terminal", "— Refresh icon", "Choose icon…", "— Move to workspace…", "Settle project", "Move to PC…", "Remove from Harbor"]);
  expect(items(null).find((i) => i.act === "move_workspace")?.off).toBeUndefined();
  expect(items("Sign in first").find((i) => i.act === "move_workspace")).toMatchObject({ off: true, desc: "Sign in first" });
});

test("project_menu_offers_share_with_workspace_after_move_greyed_with_why", () => {
  const items = (shareWhy: string | null) => projectMenu({ remote: null, main: false, customIcon: false, moveWhy: shareWhy, shareWhy, shareLine: "Owned by Team · not shared" });
  expect(items(null).map((i) => (i.sep ? `— ${i.label}` : i.label))).toEqual(["Open terminal", "— Refresh icon", "Choose icon…", "— Move to workspace…", "Share with workspace…", "Settle project", "Move to PC…", "Remove from Harbor"]);
  // Its line says owner and shares; greyed, it says why instead.
  expect(items(null).find((i) => i.act === "share_workspace")).toMatchObject({ desc: "Owned by Team · not shared" });
  expect(items(null).find((i) => i.act === "share_workspace")?.off).toBeUndefined();
  expect(items("Sign in first").find((i) => i.act === "share_workspace")).toMatchObject({ off: true, desc: "Sign in first" });
});

test("project_menu_offers_clean_up_merged_worktrees_for_git_projects", () => {
  const labels = (git: boolean) => projectMenu({ remote: "https://github.com/sam/x", main: false, customIcon: false, git }).map((i) => (i.sep ? `— ${i.label}` : i.label));
  expect(labels(true).slice(0, 6)).toEqual(["Open terminal", "Pull requests", "Issues", "Open remote", "— Clean up merged worktrees", "— Refresh icon"]);
  expect(labels(false)).not.toContain("Clean up merged worktrees");
  expect(projectMenu({ remote: null, main: false, customIcon: false, git: true }).find((i) => i.act === "clean_worktrees")).toMatchObject({ label: "Clean up merged worktrees", sep: true });
});
