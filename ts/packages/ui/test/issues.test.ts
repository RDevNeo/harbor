import { describe, expect, test } from "bun:test";
import { issues as list, type ghapi } from "@harbor/mcp";
import { ago, hex, IssuesPage, type IssuesHost, issueGaps } from "../src/logic/issues.ts";

const issue = (n: number, author: string, over: Partial<ghapi.Issue> = {}): ghapi.Issue => ({
  number: n,
  title: `Issue ${n}`,
  url: `https://github.com/o/r/issues/${n}`,
  repo: "o/r",
  state: "open",
  created: n,
  updated: n,
  comments: 0,
  author,
  avatar: "",
  labels: [],
  assignees: [],
  milestone: null,
  mentions: [],
  accounts: [],
  linked_pr: false,
  author_trusted: true,
  ...over,
});

function host(items: ghapi.Issue[], projects: { id: number; name: string; repo: string }[] = []): IssuesHost {
  return {
    fetch: () => Promise.resolve({ viewer: "me", items: items.map((i) => ({ ...i, accounts: ["me"] })), sources: [] }),
    projects: () => projects,
    peer: () => undefined,
    details: { fetchIssue: () => Promise.reject(new Error("no")), fetchIssueOn: () => Promise.reject(new Error("no")), setIssueOpenOn: () => Promise.resolve(), gh: () => Promise.resolve("") },
    agentLabel: () => "Claude",
    agents: () => [],
    pickAgent: () => {},
    fix: () => {},
    openUrl: () => {},
    browse: () => {},
    copy: () => {},
    avatar: () => Promise.resolve(null),
    now: () => 1000,
  };
}

async function loaded(items: ghapi.Issue[], projects: { id: number; name: string; repo: string }[] = []): Promise<IssuesPage> {
  const page = new IssuesPage(host(items, projects), () => {});
  page.load();
  await Promise.resolve();
  await Promise.resolve();
  return page;
}

describe("issues.rs page", () => {
  test("ago says how long ago", () => {
    expect([ago(1000, 1000), ago(940, 1000), ago(1000 - 7200, 1000), ago(0, 86400 * 3), ago(0, 31_536_000 * 2)]).toEqual(["just now", "1m ago", "2h ago", "3d ago", "2y ago"]);
  });

  test("label colours are hex", () => {
    expect(hex([255, 0, 128])).toBe("#ff0080");
  });

  test("the list shows sections with their counts, then the issues", async () => {
    const page = await loaded([issue(1, "x", { assignees: ["me"] }), issue(2, "me"), issue(3, "x", { mentions: ["me"] }), issue(4, "x")]);
    const kinds = page.items().map((i) => (i.kind === "section" ? i.label : i.kind === "issue" ? i.number : "gap"));
    expect(kinds).toEqual(["Assigned", "#1", "gap", "Authored", "#2", "gap", "Mentioned", "#3", "gap", "Others", "#4", "gap"]);
  });

  test("a page without data is loading; an empty list explains why", async () => {
    const page = new IssuesPage(host([]), () => {});
    expect(page.body([]).kind).toBe("loading");
    const loadedPage = await loaded([]);
    expect(loadedPage.body([]).title).toBe("No issues");
    loadedPage.search = "zzz";
    expect(loadedPage.body([]).title).toBe("No issues match");
  });

  test("a failed fetch shows the error and a failed refresh keeps the list", async () => {
    const page = await loaded([issue(1, "me")]);
    page.loaded(2, "open", { err: "boom" });
    expect(page.body(page.items()).kind).toBe("rows");
    const fresh = new IssuesPage(host([]), () => {});
    fresh.loaded(0, "open", { err: "boom" });
    expect(fresh.body([])).toMatchObject({ kind: "error", title: "Couldn't load issues", desc: "boom" });
  });

  test("the Filters menu lists its rows and opens a submenu", async () => {
    const page = await loaded([issue(1, "me", { labels: [["bug", [255, 0, 0]]], milestone: "v1" })]);
    page.toggleMenu("filters");
    const m = page.menuView();
    expect(m.rows.filter((r) => r.kind === "row").map((r) => [r.label, r.value])).toEqual([
      ["State", "Open"],
      ["Involvement", "All"],
      ["Author", "Anyone"],
      ["Assignee", "Anyone"],
      ["Labels", "Any"],
      ["Milestone", "Any"],
      ["Project", "All projects"],
    ]);
    page.hoverMain(0);
    expect(page.menuView().sub?.head.map((r) => [r.label, r.checked])).toEqual([["All", false], ["Open", true], ["Closed", false]]);
  });

  test("picking in the State submenu changes the filter and closes the menus", async () => {
    const page = await loaded([issue(1, "me")]);
    page.toggleMenu("filters");
    page.hoverMain(0);
    page.pickSub(2);
    expect([page.filters.state, page.menu]).toEqual(["closed", null]);
  });

  test("the Labels submenu stays open and toggles", async () => {
    const page = await loaded([issue(1, "me", { labels: [["bug", [255, 0, 0]]] })]);
    page.toggleMenu("filters");
    page.hoverMain(4);
    expect(page.menuView().sub?.list.map((r) => [r.label, r.value, r.dot])).toEqual([["bug", "1", "#ff0000"]]);
    page.pickSub(1);
    expect([page.filters.labels, page.menu]).toEqual([["bug"], "filters"]);
    expect(page.activeFilters()).toBe(1);
    page.pickSub(1);
    expect(page.filters.labels).toEqual([]);
  });

  test("the Project submenu picks a project by id", async () => {
    const page = await loaded([issue(1, "me")], [{ id: 7, name: "app", repo: "o/r" }]);
    page.toggleMenu("filters");
    page.hoverMain(6);
    page.pickSub(1);
    expect(page.project).toBe(7);
    expect(page.groups().length).toBe(1);
    expect(page.filters.project).toBe("o/r");
  });

  test("menu keys move the highlight, enter a submenu and pick", async () => {
    const page = await loaded([issue(1, "me")]);
    page.toggleMenu("filters");
    expect(page.menuKey("down")).toBe(true);
    page.menuKey("right");
    expect([page.sub, page.subKeys?.hl]).toEqual(["state", 0]);
    page.menuKey("down");
    page.menuKey("down");
    page.menuKey("enter");
    expect([page.filters.state, page.menu]).toEqual(["closed", null]);
    expect(page.menuKey("down")).toBe(false);
  });

  test("the Sort menu picks and closes", async () => {
    const page = await loaded([]);
    page.toggleMenu("sort");
    expect(page.menuView().rows.map((r) => r.label)).toEqual(["Recently updated", "Least recently updated", "Newest", "Oldest", "Most commented", "Least commented"]);
    page.pickMain(2);
    expect([page.sort, page.menu]).toEqual(["newest", null]);
  });

  test("tabs are the open issues by number", async () => {
    const page = await loaded([issue(1, "me")]);
    page.open("https://github.com/o/r/issues/1");
    expect(page.tabs()).toEqual([{ icon: expect.any(String), text: "#1" }]);
    expect(page.items().find((i) => i.kind === "issue")?.selected).toBe(true);
  });

  test("issue markdown gaps follow the panel's spacing", () => {
    const g = issueGaps([
      { kind: "h", gap: 0 },
      { kind: "p", gap: 16 },
      { kind: "li", gap: 16 },
      { kind: "li", gap: 0 },
    ]);
    expect(g.map((b) => b.gap)).toEqual([21, 19, 24, 13]);
  });

});
