import { expect, test } from "bun:test";
import { MemKv } from "@harbor/net";
import { tabFromSlug, TAB_ORDER, TABS } from "../src/logic/pages.ts";
import { generalSections, navTabs, setGeneral } from "../src/logic/settings.ts";

test("Settings has ten pages, Workspace first, with old phone links reaching Devices", () => {
  expect(TAB_ORDER.map((t) => TABS[t].label)).toEqual(["Workspace", "General", "Notifications", "Appearance", "Keybindings", "Voice", "Providers", "Integrations", "Secrets", "Devices"]);
  expect(tabFromSlug("phones")).toBe("devices");
  expect(tabFromSlug("webhooks")).toBe("general");
  expect(tabFromSlug("nope")).toBeNull();
  expect(navTabs("microphone").map((t) => t.slug)).toEqual(["voice"]);
});

test("General only exposes login startup, automatic work and the version", () => {
  const kv = new MemKv();
  const sections = generalSections(kv, { autostart: true, version: "0.124.0" });
  expect(sections.map((s) => s.title)).toEqual(["Background", "Issues and pull requests", "Updates"]);
  expect(sections.flatMap((s) => s.rows).map((r) => r.key)).toEqual(["autostart", "auto_fix", "auto_merge", "version"]);
  expect(sections.at(-1)?.rows[0]).toMatchObject({ title: "Harbor 0.124.0", desc: "" });
  for (const key of ["follow_up", "resume_on_restart", "order_by_activity", "fast_mode", "bg_keep", "suggest_enabled", "auto_update"]) expect(setGeneral(kv, key, false)).toBe(false);
  expect(setGeneral(kv, "auto_fix", true)).toBe(true);
  expect(kv.get("auto_fix")).toBe("1");
});
