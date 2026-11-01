import { describe, expect, test } from "bun:test";
import { cost, itemJson, type Item } from "@harbor/store";
import { searchTabs, sumResults, tabFromSlug, TAB_ORDER, TABS } from "../src/logic/pages.ts";

const result = (account: string, tin: number, tout: number, at: number): Item => ({ kind: "result", cost_usd: 0.5, duration_ms: 0, turns: 1, input_tokens: tin, output_tokens: tout, cached: 0, at, account, model: "" });

describe("pages.rs", () => {
  test("usage_sums_results_per_account_and_day", () => {
    const today = 20_000;
    const chats = new Map<number, [string, string]>([
      [1, ["claude", "harbor"]],
      [2, ["codex", ""]],
    ]);
    const t = sumResults(
      [
        [1, result("", 1000, 10, today * 86400)],
        [1, result("claude2", 2000, 20, today * 86400)],
        [2, result("", 3000, 30, (today - 20) * 86400)],
        [2, { kind: "error", text: "x" }],
      ],
      chats,
      today,
    );
    expect(t.byAccount.get("claude")).toEqual([1, 1000, 10, 0.5]);
    expect(t.byAccount.get("claude2")).toEqual([1, 2000, 20, 0.5]);
    expect(t.byAccount.get("codex")).toEqual([1, 3000, 30, 0.5]);
    expect([...t.byDay]).toEqual([[today, 3030]]);
    const d = t.days.get(today) ?? cost.emptyUsage();
    expect([d.turns, cost.tokens(d)]).toEqual([2, 3030]);
    expect([t.byProject.get("harbor")?.turns, t.byProject.get("")?.input]).toEqual([2, 3000]);
    expect([t.byChat.get(1)?.output, t.byChat.get(2)?.turns]).toEqual([30, 1]);
  });

  test("result_rows_are_found_by_their_prefix", () => {
    expect(itemJson(result("a", 1, 1, 1)).startsWith('{"kind":"result"')).toBe(true);
  });

  test("settings tabs: order, slugs and the search", () => {
    expect(TAB_ORDER.map((t) => TABS[t].label)).toEqual(["Account", "General", "Notifications", "Appearance", "Keybindings", "Voice", "Providers", "Usage", "Integrations", "Secrets", "Devices", "Phones", "Webhooks"]);
    expect(tabFromSlug("limits")).toBe("usage");
    expect(tabFromSlug("nope")).toBeNull();
    expect(searchTabs("tailscale")).toEqual(["devices"]);
    expect(searchTabs("SIGN in")).toEqual(["account", "providers", "integrations", "phones"]);
    expect(searchTabs("")).toHaveLength(13);
  });
});
