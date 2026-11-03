import { describe, expect, test } from "bun:test";
import { itemJson, type Item } from "@harbor/store";
import { searchTabs, tabFromSlug, TAB_ORDER, TABS } from "../src/logic/pages.ts";
import { generalSections, navTabs, setGeneral } from "../src/logic/settings.ts";

const result = (account: string, tin: number, tout: number, at: number): Item => ({ kind: "result", cost_usd: 0.5, duration_ms: 0, turns: 1, input_tokens: tin, output_tokens: tout, cached: 0, at, account, model: "" });

describe("pages.rs", () => {
  test("result_rows_are_found_by_their_prefix", () => {
    expect(itemJson(result("a", 1, 1, 1)).startsWith('{"kind":"result"')).toBe(true);
  });

  test("settings tabs: order, slugs and the search", () => {
    expect(TAB_ORDER.map((t) => TABS[t].label)).toEqual(["Account", "General", "Notifications", "Appearance", "Keybindings", "Voice", "Providers", "Integrations", "Secrets", "Devices", "Phones", "Webhooks"]);
    expect(tabFromSlug("limits")).toBeNull();
    expect(tabFromSlug("nope")).toBeNull();
    expect(searchTabs("tailscale")).toEqual(["devices"]);
    expect(searchTabs("SIGN in")).toEqual(["account", "providers", "integrations", "phones"]);
    expect(searchTabs("")).toHaveLength(12);
  });
});

describe("Settings › General (pages.rs general_tab)", () => {
  const kv = () => {
    const m = new Map<string, string>();
    return { m, get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v) };
  };
  const env = { trayActive: false, autostart: false, version: "0.108.0", updateStatus: "s", managed: false };

  test("defaults read as the Rust app reads them", () => {
    const s = generalSections(kv(), env);
    expect(s.map((x) => x.title)).toEqual(["", "Background", "Suggestions", "Issues and pull requests", "Updates"]);
    const on = Object.fromEntries(s.flatMap((x) => x.rows).map((r) => [r.key, r.kind === "choice" ? r.selected : r.on]));
    expect(on).toMatchObject({ follow_up: 1, resume_on_restart: true, order_by_activity: false, fast_mode: false, bg_keep: true, suggest_enabled: true, auto_fix: false, auto_merge: false, auto_update: 0 });
    expect(s[1]?.rows[2]?.desc.endsWith("No tray was found on this desktop, so quit from here.")).toBe(true);
    expect(generalSections(kv(), { ...env, trayActive: true })[1]?.rows[2]?.desc.endsWith("Also in the tray icon's menu.")).toBe(true);
  });

  test("changes go to the kv keys the Rust app uses", () => {
    const k = kv();
    expect(setGeneral(k, "follow_up", 0)).toBe(true);
    expect(setGeneral(k, "fast_mode", true)).toBe(true);
    expect(setGeneral(k, "bg_keep", false)).toBe(true);
    expect(setGeneral(k, "auto_update", 1)).toBe(true);
    expect(setGeneral(k, "quit", true)).toBe(false);
    expect([...k.m]).toEqual([
      ["follow_up", "queue"],
      ["fast_mode", "1"],
      ["bg_keep", "0"],
      ["auto_update", "1"],
    ]);
    expect(generalSections(k, env)[0]?.rows[0]?.selected).toBe(0);
  });

  test("the nav filters like sidebar.rs: the whole query in a name or the keywords", () => {
    expect(navTabs("tailscale").map((t) => t.slug)).toEqual(["devices"]);
    expect(navTabs("ACCOUNT").map((t) => t.slug)).toEqual(["account", "providers"]);
    expect(navTabs("zzz")).toEqual([]);
  });
});
