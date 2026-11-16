import { expect, test } from "bun:test";
import { MemKv } from "@harbor/net";
import { tabFromSlug, TAB_ORDER, TABS } from "../src/logic/pages.ts";
import { adminDesc, generalSections, navTabs, projectsSection, PROJECTS_DIR, RUN_AS_ADMIN, setGeneral } from "../src/logic/settings.ts";

test("Settings has nine pages, General then Workspace, with old Devices and Phones links reaching Workspace", () => {
  expect(TAB_ORDER.map((t) => TABS[t].label)).toEqual(["General", "Workspace", "Notifications", "Keybindings", "Voice", "Providers", "Integrations", "Secrets"]);
  expect(tabFromSlug("devices")).toBe("account");
  expect(tabFromSlug("phones")).toBe("account");
  expect(navTabs("android").map((t) => t.slug)).toEqual(["account"]);
  expect(tabFromSlug("webhooks")).toBe("general");
  expect(tabFromSlug("nope")).toBeNull();
  expect(navTabs("microphone").map((t) => t.slug)).toEqual(["voice"]);
});

test("General only exposes login startup, automatic work and the version", () => {
  const kv = new MemKv();
  const sections = generalSections(kv, { autostart: true, version: "0.124.0" });
  expect(sections.map((s) => s.title)).toEqual(["Background", "Issues and pull requests", "Projects", "Worktrees", "Updates"]);
  expect(sections.flatMap((s) => s.rows).map((r) => r.key)).toEqual(["autostart", "auto_fix", "auto_merge", "projects_dir:change", "wt_clean_merged", "wt_clean_branch", "wt_clean_remote", "version"]);
  expect(sections.at(-1)?.rows[0]).toMatchObject({ title: "Harbor 0.124.0", desc: "" });
  for (const key of ["follow_up", "resume_on_restart", "order_by_activity", "fast_mode", "bg_keep", "suggest_enabled", "auto_update"]) expect(setGeneral(kv, key, false)).toBe(false);
  expect(setGeneral(kv, "auto_fix", true)).toBe(true);
  expect(kv.get("auto_fix")).toBe("1");
  // Delete merged worktrees and their branches are on until turned off; the remote branch only when asked.
  const wt = () => sections2().find((s) => s.title === "Worktrees")?.rows.map((r) => [r.key, r.on, r.enabled]);
  const sections2 = () => generalSections(kv, { autostart: true, version: "0.124.0" });
  expect(wt()).toEqual([["wt_clean_merged", true, true], ["wt_clean_branch", true, true], ["wt_clean_remote", false, true]]);
  expect(setGeneral(kv, "wt_clean_merged", false)).toBe(true);
  expect(kv.get("wt_clean_merged")).toBe("0");
  expect(wt()).toEqual([["wt_clean_merged", false, true], ["wt_clean_branch", true, false], ["wt_clean_remote", false, false]]);
});

test("Projects folder: ~/Projects until one is picked, then a way back", () => {
  const kv = new MemKv();
  const s = () => projectsSection(kv, "/home/sam");
  expect(s().rows.map((r) => [r.key, r.title, r.label])).toEqual([[PROJECTS_DIR.change, "Projects folder", "Change…"]]);
  expect(s().rows[0]?.desc).toStartWith("~/Projects. New projects and clones go here.");
  kv.set("projects_dir", "/home/sam/Documents/work");
  expect(s().rows.map((r) => r.key)).toEqual([PROJECTS_DIR.change, PROJECTS_DIR.reset]);
  expect(s().rows[0]?.desc).toBe("~/Documents/work. New projects and clones go here, worktrees in its .worktrees folder and chats without a project in its chats folder.");
  expect(s().rows[1]?.title).toBe("Back to ~/Projects");
});

test("Run as administrator: a row on Windows only, off by default, its trade-offs and what's true now", () => {
  const kv = new MemKv();
  const row = (admin: Parameters<typeof adminDesc>[0]) => generalSections(kv, { autostart: true, version: "0.1.0", admin }).find((s) => s.title === "Administrator")?.rows[0];
  expect(generalSections(kv, { autostart: true, version: "0.1.0" }).some((s) => s.title === "Administrator")).toBe(false);
  const off = row({ on: false, elevated: false, canElevate: true, busy: false });
  expect(off).toMatchObject({ kind: "toggle", key: RUN_AS_ADMIN, title: "Run as administrator", on: false, enabled: true });
  expect(off?.desc).toContain("full control of this PC");
  expect(off?.desc).toContain("can't be dropped on Harbor's window");
  expect(off?.desc).toEndWith("Now: Harbor runs with your normal rights.");
  expect(row({ on: true, elevated: true, canElevate: true, busy: false })?.desc).toEndWith("Now: Harbor runs as administrator.");
  expect(row({ on: true, elevated: false, canElevate: true, busy: false })?.desc).toContain("this Harbor has your normal rights");
  // A standard account: nothing to raise, so it can't be turned on (but can be turned off).
  expect(row({ on: false, elevated: false, canElevate: false, busy: false })).toMatchObject({ enabled: false });
  expect(row({ on: true, elevated: false, canElevate: false, busy: false })).toMatchObject({ enabled: true });
  expect(row({ on: false, elevated: false, canElevate: true, busy: true })).toMatchObject({ enabled: false });
  expect(row({ on: false, elevated: false, canElevate: true, busy: true })?.desc).toEndWith("Waiting for Windows…");
});
