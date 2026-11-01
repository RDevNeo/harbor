import { expect, test } from "bun:test";
import type { Item } from "../src/index.ts";
import * as cost from "../src/cost.ts";

const { compact, dayLabel, detail, fixed, money, ofItems, short, sumResults, usageJson, tokens, apiUsage } = cost;

const result = (tin: number, tout: number, cached: number, c: number, account = "", at = 0): Item => ({
  kind: "result", cost_usd: c, duration_ms: 0, turns: 1, input_tokens: tin, output_tokens: tout, cached, at, account, model: "",
});

test("days", () => {
  expect(dayLabel(0)).toBe("Thu 1 Jan");
  expect(dayLabel(20_752)).toBe("Mon 26 Oct");
});

test("compact numbers", () => {
  expect(short(950)).toBe("950");
  expect(short(12_400)).toBe("12.4k");
  expect(short(12_000)).toBe("12k");
  expect(short(189_400)).toBe("189k");
  expect(short(1_250_000)).toBe("1.2M");
  expect(money(0)).toBe("");
  expect(money(0.001)).toBe("<$0.01");
  expect(money(0.1849)).toBe("$0.18");
  expect(money(12.4)).toBe("$12.40");
  expect([fixed(0.125, 2), fixed(0.375, 2), fixed(2.5, 0), fixed(12.25, 1), fixed(0.1849, 2)]).toEqual(["0.12", "0.38", "2", "12.2", "0.18"]);
});

test("sums turns", () => {
  const items: Item[] = [result(10_000, 400, 8_000, 0.12), { kind: "error", text: "x" }, result(2_000, 100, 0, 0.06)];
  const u = ofItems(items);
  expect(u).toEqual({ turns: 2, input: 12_000, output: 500, cached: 8_000, cost: 0.12 + 0.06 });
  expect(compact(u)).toBe("12.5k tok · $0.18");
  expect(detail(u)).toBe("12k in (8k cached) · 500 out · $0.18 · 2 turns");
  const one = ofItems([result(1_500, 20, 0, 0)]);
  expect([compact(one), detail(one)]).toEqual(["1.5k tok", "1.5k in · 20 out · 1 turn"]);
  expect(usageJson(one).label).toBe("1.5k tok");
});

test("usage sums results per account and day", () => {
  const today = 20_000;
  const chats = new Map<number, [string, string]>([[1, ["claude", "harbor"]], [2, ["codex", ""]]]);
  const t = sumResults(
    [
      [1, result(1000, 10, 0, 0.5, "", today * 86400)],
      [1, result(2000, 20, 0, 0.5, "claude2", today * 86400)],
      [2, result(3000, 30, 0, 0.5, "", (today - 20) * 86400)],
      [2, { kind: "error", text: "x" }],
    ],
    chats,
    today,
  );
  expect(t.byAccount.get("claude")).toEqual({ turns: 1, input: 1000, output: 10, cost: 0.5 });
  expect(t.byAccount.get("claude2")).toEqual({ turns: 1, input: 2000, output: 20, cost: 0.5 });
  expect(t.byAccount.get("codex")).toEqual({ turns: 1, input: 3000, output: 30, cost: 0.5 });
  expect(t.byDay).toEqual(new Map([[today, 3030]]));
  const d = t.days.get(today);
  expect([d?.turns, d && tokens(d)]).toEqual([2, 3030]);
  expect([t.byProject.get("harbor")?.turns, t.byProject.get("")?.input]).toEqual([2, 3000]);
  expect([t.byChat.get(1)?.output, t.byChat.get(2)?.turns]).toEqual([30, 1]);
  const api = apiUsage(t, today, (a) => a.toUpperCase());
  expect(api.days.map((r) => r.name)).toEqual(["Today"]);
  expect(api.projects.map((r) => r.name)).toEqual(["harbor", "No project"]);
  expect(api.accounts.map((r) => r.name)).toEqual(["CLAUDE", "CLAUDE2", "CODEX"]);
  expect(cost.isEmpty(cost.emptyUsage())).toBe(true);
});
