import { describe, expect, test } from "bun:test";
import type { ghapi } from "@harbor/mcp";
import { ICONS } from "../src/icons.ts";
import {
  centered, emptyFor, fitChips, filtersMenu, listRows, type MenuCtx, OpenMenu, pickSub, providerMenu, rowActions, rowData, sortMenu, subAt, subMenu, subPos, toolbarWidths, ago, tabLabel,
} from "../src/logic/prs.ts";

const NOW = 1_800_000_000;
const pr = (n: number, o: Partial<ghapi.Pr> = {}): ghapi.Pr => ({
  number: n, title: `PR ${n}`, url: `https://github.com/o/r/pull/${n}`, repo: "O/R", state: "open", draft: false, adds: n, dels: 0, created: NOW - 9000, updated: NOW - 7300, branch: `b${n}`, head: "",
  review: "none", checks: "none", conflicting: false, author: "me", avatar: "", labels: [], review_requested: false, ...o,
});
const ctx = (o: Partial<MenuCtx> = {}): MenuCtx => ({
  filters: { state: "open", involvement: "all", labels: [] }, sort: "ready", githubOnly: false, project: undefined, projects: [], authors: [["me", 3], ["you", 1]], labels: [["bug", [255, 0, 0], 2], ["ui", [0, 0, 255], 1]],
  sortLabel: (s) => s, ...o,
});

describe("prs.rs rows", () => {
  test("a row shows the state, checks and review icons of the PR", () => {
    expect([rowData(pr(1, { state: "merged" }), false, NOW, 800).state_tip, rowData(pr(1, { state: "closed" }), false, NOW, 800).state_tip]).toEqual(["Merged", "Closed"]);
    expect(rowData(pr(1, { conflicting: true }), false, NOW, 800).state_tip).toBe("Has conflicts");
    expect(rowData(pr(1, { draft: true }), false, NOW, 800).state_icon).toBe(ICONS.PR_DRAFT);
    const r = rowData(pr(1, { checks: "failing", review: "approved" }), true, NOW, 800);
    expect([r.checks_tip, r.checks_tone, r.review_tip, r.review_tone, r.selected]).toEqual(["Checks failing", "red", "Approved", "blue", true]);
    expect(rowData(pr(1, { review: "required" }), false, NOW, 800).review_icon).toBe("");
  });

  test("a row shows size with thousands separators, the age and the lowercased repo", () => {
    const r = rowData(pr(5, { adds: 1204, dels: 980 }), false, NOW, 800);
    expect([r.adds, r.dels, r.age, r.repo, r.number, r.letter]).toEqual(["+1,204", "-980", "2h ago", "o/r", "#5", "M"]);
  });

  test("labels that don't fit the row become +N", () => {
    const labels: [string, ghapi.Rgb][] = [["bug", [255, 0, 0]], ["needs review", [0, 255, 0]], ["type:feature", [0, 0, 255]]];
    expect(fitChips(labels, 100, 1000)).toEqual({ chips: [{ name: "bug", color: "#ff0000" }, { name: "needs review", color: "#00ff00" }, { name: "type:feature", color: "#0000ff" }], more: "" });
    const cut = fitChips(labels, 100, 180);
    expect([cut.chips.length, cut.more]).toEqual([1, "+2"]);
  });

  test("the list has a header and gaps per group, and plain groups only a gap", () => {
    const g = (key: string, label: string, n: number): ghapi.Group<ghapi.Pr> => ({ key, label, items: Array.from({ length: n }, (_, i) => pr(i + 1)) });
    const rows = listRows([g("authored", "Authored", 2), g("others", "", 1)], "https://github.com/o/r/pull/2", NOW, 800);
    expect(rows.map((r) => [r.kind, r.height])).toEqual([["section", 34], ["row", 62], ["row", 62], ["gap", 14], ["gap", 6], ["row", 62], ["gap", 14]]);
    expect([rows[0]?.label, rows[0]?.count, rows[2]?.selected]).toEqual(["Authored", "2", true]);
  });

  test("the empty states say why", () => {
    expect(emptyFor("boom", true).title).toBe("Couldn't load pull requests");
    expect(emptyFor(null, true).title).toBe("No pull requests match");
    expect(emptyFor(null, false).title).toBe("No pull requests");
  });

  test("ago counts like the Rust app", () => {
    expect([ago(NOW - 5, NOW), ago(NOW - 90, NOW), ago(NOW - 7300, NOW), ago(NOW - 200_000, NOW), ago(NOW - 40_000_000, NOW)]).toEqual(["just now", "1m ago", "2h ago", "2d ago", "1y ago"]);
    expect(tabLabel("https://github.com/o/r/pull/128")).toBe("#128");
  });
});

describe("prs.rs toolbar", () => {
  test("the search takes what the buttons leave, or the whole row when they wrap", () => {
    expect(toolbarWidths(1096, 0)).toEqual({ search: 1096 - 286, wrap: false });
    expect(toolbarWidths(1096, 2).search).toBe(1096 - 316);
    expect(toolbarWidths(500, 0)).toEqual({ search: 498, wrap: true });
  });

  test("the column is centred with 24 pt gutters, 12 on narrow pages", () => {
    expect(centered(1144)).toEqual({ x: 24, w: 1096 });
    expect(centered(1800)).toEqual({ x: 310, w: 1180 });
    expect(centered(400)).toEqual({ x: 12, w: 376 });
  });
});

describe("prs.rs menus", () => {
  test("the sort menu marks the current sort", () => {
    const m = sortMenu(ctx({ sort: "newest" }));
    expect(m.rows.map((r) => r.active)).toEqual([false, false, false, true, false, false, false]);
    expect([m.rows[1]?.y, m.height]).toEqual([32, 224]);
  });

  test("the provider menu checks All or GitHub", () => {
    expect(providerMenu(ctx()).rows.map((r) => r.checked)).toEqual([true, false]);
    expect(providerMenu(ctx({ githubOnly: true })).rows.map((r) => [r.label, r.checked, r.mark])).toEqual([["All", false, ""], ["GitHub", true, "github"]]);
  });

  test("the filters menu shows each filter's value and separates the groups", () => {
    const f = { state: "merged" as const, involvement: "all" as const, labels: ["bug", "ui"], draft: true };
    const m = filtersMenu(ctx({ filters: f }), "labels", null);
    expect(m.rows.map((r) => (r.kind === "sep" ? "-" : `${r.label}=${r.value}`))).toEqual(["State=Merged", "Involvement=All", "-", "Author=Anyone", "Labels=2 selected", "Draft=Drafts only", "Review=All", "Checks=All", "-", "Project=All projects"]);
    expect(m.rows.filter((r) => r.active).map((r) => r.label)).toEqual(["Labels"]);
    expect(m.height).toBe(8 * 32 + 2 * 9);
  });

  test("filter rows map to their submenus, separators to none", () => {
    expect([0, 1, 2, 3, 8, 9].map(subAt)).toEqual(["state", "involvement", null, "author", null, "project"]);
  });

  test("submenus check the current choice", () => {
    const c = ctx({ filters: { state: "closed", involvement: "authored", labels: ["BUG"], author: "You" } });
    expect(subMenu("state", c).rows.map((r) => r.checked)).toEqual([false, false, true, false]);
    expect(subMenu("involvement", c).rows.map((r) => r.label)).toEqual(["All", "Reviewing", "Authored"]);
    expect(subMenu("review", c).rows.map((r) => r.label)).toEqual(["All", "Approved", "Changes requested", "Review required", "No reviews"]);
    expect(subMenu("author", c).rows.map((r) => [r.label, r.value, r.checked])).toEqual([["Anyone", "", false], ["", "", false], ["me", "3", false], ["you", "1", true]]);
    expect(subMenu("labels", c).rows.filter((r) => r.kind === "row" && r.checked).map((r) => r.label)).toEqual(["bug"]);
  });

  test("the long lists scroll below their fixed rows", () => {
    const labels = Array.from({ length: 20 }, (_, i): [string, ghapi.Rgb, number] => [`l${i}`, [1, 2, 3], 1]);
    const m = subMenu("labels", ctx({ labels }));
    expect([m.scroll_from, m.scroll_h, m.height]).toEqual([2, 320, 2 * 32 + 9 - 32 + 320]);
    expect(subMenu("state", ctx()).scroll_from).toBe(-1);
  });

  test("an empty label or project list says so", () => {
    expect(subMenu("labels", ctx({ labels: [] })).rows.at(-1)?.label).toBe("No labels in these pull requests.");
    expect(subMenu("project", ctx()).rows.at(-1)?.label).toBe("No projects with a GitHub remote.");
  });

  test("picking in a submenu sets the filter and closes, except labels which toggle", () => {
    let f = ctx().filters;
    let project: number | undefined = 9;
    const set = { filters: (n: typeof f) => (f = n), project: (id: number | undefined) => (project = id) };
    expect(pickSub("state", 2, ctx(), set)).toBe(true);
    expect(f.state).toBe("closed");
    expect(pickSub("draft", 1, ctx({ filters: f }), set)).toBe(true);
    expect(f.draft).toBe(true);
    expect(pickSub("draft", 0, ctx({ filters: f }), set)).toBe(true);
    expect(f.draft).toBeUndefined();
    expect(pickSub("author", 3, ctx({ filters: f }), set)).toBe(true);
    expect(f.author).toBe("you");
    expect(pickSub("author", 0, ctx({ filters: f }), set)).toBe(true);
    expect(f.author).toBeUndefined();
    expect(pickSub("labels", 2, ctx({ filters: f }), set)).toBe(false);
    expect(f.labels).toEqual(["bug"]);
    expect(pickSub("labels", 2, ctx({ filters: f }), set)).toBe(false);
    expect(f.labels).toEqual([]);
    expect(pickSub("project", 0, ctx(), set)).toBe(true);
    expect(project).toBeUndefined();
    const projects = [{ id: 4, name: "app", repo: "o/r" }];
    expect(pickSub("project", 1, ctx({ projects }), set)).toBe(true);
    expect(project).toBe(4);
  });

  test("a submenu opens to the right of its row, or to the left without room", () => {
    expect(subPos(100, 350, 50, 190, 1400)).toEqual([360, 44]);
    expect(subPos(1145, 1391, 120, 190, 1400)).toEqual([931, 114]);
  });
});

describe("listdetail.rs menu keys on the page's menus", () => {
  test("Down then Enter on a Filters row enters its submenu, Left leaves it, Esc closes", () => {
    const m = new OpenMenu();
    m.toggle("filters");
    expect(m.key("down", 8, 0)).toEqual({ in: "main" });
    const r = m.key("enter", 8, 0);
    expect(r).toEqual({ in: "main", pick: 0, enterSub: true });
    m.enterSub("state");
    expect(m.subKeys?.hl).toBe(0);
    expect(m.key("down", 8, 4)).toEqual({ in: "sub" });
    expect(m.key("enter", 8, 4)).toEqual({ in: "sub", pick: 1 });
    expect(m.key("left", 8, 4)).toEqual({ in: "sub", leave: true });
    expect(m.sub).toBeNull();
    expect(m.key("esc", 8, 0)).toEqual({ in: "main", close: true });
  });

  test("Enter on the sort menu picks without a submenu; toggling the same tool closes it", () => {
    const m = new OpenMenu();
    m.toggle("sort");
    m.key("end", 7, 0);
    expect(m.key("enter", 7, 0)).toEqual({ in: "main", pick: 6 });
    m.toggle("sort");
    expect(m.tool).toBeNull();
    m.toggle("sort");
    m.toggle("provider");
    expect(m.tool).toBe("provider");
  });
});

describe("prs.rs row menu", () => {
  test("a PR in a project offers check out and review; an open one offers merge", () => {
    const labels = (inProject: boolean, p = pr(1)) => rowActions(p, inProject, "Claude", "not a project").map((a) => `${a.sep ? "|" : ""}${a.label}${a.enabled ? "" : "!"}`);
    expect(labels(true)).toEqual(["Open in side panel", "Open on GitHub", "Copy link", "|Check out", "Review with an agent", "Merge with Claude", "Merge with instructions…"]);
    expect(labels(false)).toEqual(["Open in side panel", "Open on GitHub", "Copy link", "|Merge with Claude!", "Merge with instructions…!"]);
    expect(labels(true, pr(1, { state: "merged" })).at(-1)).toBe("Review with an agent");
    expect(rowActions(pr(1), false, "Claude", "not a project").at(-1)?.tip).toBe("not a project");
  });
});
