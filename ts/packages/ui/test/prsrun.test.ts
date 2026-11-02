import { describe, expect, test } from "bun:test";
import type { ghapi } from "@harbor/mcp";
import { attachPrs, type PrsHost, type PrsPorts, type PrsView, tabAct } from "../src/prs.ts";
import { header as headerOf, newDetail } from "../src/logic/prdetail.ts";

const NOW = 1_800_000_000;
const pr = (n: number, o: Partial<ghapi.Pr> = {}): ghapi.Pr => ({
  number: n, title: `PR ${n}`, url: `https://github.com/o/r/pull/${n}`, repo: "o/r", state: "open", draft: false, adds: n, dels: 0, created: NOW - n, updated: NOW - n * 100, branch: `b${n}`, head: "",
  review: "none", checks: "none", conflicting: false, author: "me", avatar: "", labels: [], review_requested: false, ...o,
});

const none = (): void => {};
const nums = (v: PrsView): string[] => v.rows.filter((r) => r.kind === "row").map((r) => r.number);
const blank = (): PrsView => ({
  page_title: "", docked: true, list_w: 0, panel_w: 0, wrap: false, search_w: 0, search: "", hint: "", active_filters: 0, loading: false, github: { width: 0, height: 0, data: new Uint8Array() }, list_state: "",
  rows: [], empty_icon: "", empty_title: "", empty_desc: "", has_tabs: false, menu: "", menu_rows: [], menu_w: 0, menu_h: 0, menu_hl: -1, sub: "", sub_rows: [], sub_w: 0, sub_h: 0, sub_row_y: 0,
  sub_scroll_from: -1, sub_scroll_h: 0, sub_hl: -1, popup_items: [], popup_w: 0, popup_h: 0, popup_kind: "", tabs: [], active_tab: 0, maxed: false, head: headerOf(newDetail(), { url: "", list: undefined, project: undefined, now: NOW, notProject: "" }),
  tab: "summary", summary: { reviewers: [], labels: [], desc_open: true, body: [], checks_open: false, checks_icon: "", checks_tone: "subtle", checks_text: "", checks: [], has_checks: false, comments_open: true, comments_title: "", comments: [] },
  events: [], code_state: "", code_error: "", lines: [], agent: "",
  resized: none, edited: none, tool: none, row_open: none, row_menu: none, close_page: none, tab_act: none, toggle_panel: none, drag: none, menu_key: none, menu_hover: none, menu_pick: none, sub_hover: none,
  sub_pick: none, menu_close: none, popup_open: none, popup_pick: none, detail_act: none, pick_tab: none, detail_toggle: none, link: none, copy: none, open_check: none,
});

const full = (n: number): ghapi.PrFull => ({
  number: n, title: `PR ${n}`, url: `https://github.com/o/r/pull/${n}`, state: "OPEN", draft: true, author: "me", created: NOW - 1000, updated: NOW - 500, base: "main", head: "feat", adds: 3, dels: 1, files: 1, labels: [],
  reviewers: [], body: "", checks: [], comments: [], timeline: [], conflicting: false,
});

function setup(items: ghapi.Pr[], o: { fail?: string; diff?: string } = {}) {
  const calls: string[] = [];
  const ports: PrsPorts = {
    prs: {
      fetch: (state, repos) => {
        calls.push(`fetch ${state} ${repos.join(",")}`);
        return o.fail === undefined ? Promise.resolve({ viewer: "me", items: items.filter((p) => state === "all" || p.state === state) }) : Promise.reject(new Error(o.fail));
      },
      groups: (d, f) => {
        const items = d.items.filter((p) => f.project === undefined || p.repo === f.project);
        return items.length === 0 ? [] : [{ key: "others", label: "", items }];
      },
      authors: (d) => [...new Set(d.items.map((p) => p.author))].map((a): [string, number] => [a, 1]),
      labels: () => [],
      sortLabel: (s) => s,
    },
    details: {
      fetchPr: (url) => Promise.resolve(full(Number(url.split("/").at(-1)))),
      fetchIssue: () => Promise.reject(new Error("unused")),
      fetchIssueRaw: () => Promise.reject(new Error("unused")),
      fetchIssueOn: () => Promise.reject(new Error("unused")),
      setIssueOpenOn: () => Promise.reject(new Error("unused")),
      gh: (args) => {
        calls.push(`gh ${args.join(" ")}`);
        return Promise.resolve(o.diff ?? "");
      },
      parseDiff: () => [{ t: "add", text: "x" }],
    },
  };
  const host: PrsHost = {
    projects: () => [{ id: 4, name: "app", repo: "o/r" }],
    repos: () => Promise.resolve(["o/r"]),
    agentLabel: () => "Claude",
    accounts: () => [{ id: "claude", label: "Claude", current: true }],
    pickAccount: (id) => calls.push(`account ${id}`),
    openUrl: (u) => calls.push(`open ${u}`),
    openBrowser: (u) => calls.push(`browser ${u}`),
    copy: (t) => calls.push(`copy ${t}`),
    checkout: (id, n) => calls.push(`checkout ${id} ${n}`),
    review: (id, p) => calls.push(`review ${id} ${p.slice(0, 15)}`),
    merge: (id, p, ask) => calls.push(`merge ${id} ${p.number} ${ask}`),
    close: () => calls.push("close"),
    now: () => NOW,
    notProject: "no project",
  };
  const view = blank();
  const handle = attachPrs(view, ports, host);
  handle.resize(1144);
  return { view, handle, calls };
}

describe("prs.rs page", () => {
  test("it fetches the open PRs of the projects' repos and shows them", async () => {
    const { view, handle, calls } = setup([pr(1), pr(2, { state: "merged" })]);
    expect(view.list_state).toBe("loading");
    await handle.idle();
    expect(calls).toEqual(["fetch open o/r"]);
    expect([view.list_state, nums(view), view.loading, view.page_title, view.hint]).toEqual(["list", ["#1"], false, "Pull Requests", "Search pull requests, or label:bug"]);
    expect([view.list_w, view.panel_w, view.search_w, view.wrap]).toEqual([1144, 0, 810, false]);
  });

  test("a failed fetch shows the error, and an empty list says what shows up here", async () => {
    const bad = setup([], { fail: "HTTP 502" });
    await bad.handle.idle();
    expect([bad.view.list_state, bad.view.empty_title, bad.view.empty_desc]).toEqual(["error", "Couldn't load pull requests", "HTTP 502"]);
    const empty = setup([]);
    await empty.handle.idle();
    expect([empty.view.list_state, empty.view.empty_title]).toEqual(["empty", "No pull requests"]);
    empty.view.edited("zzz");
    expect(empty.view.empty_title).toBe("No pull requests match");
  });

  test("the Sort menu opens under its button, picks a sort and closes", async () => {
    const { view, handle } = setup([pr(1)]);
    await handle.idle();
    view.tool("sort");
    expect([view.menu, view.menu_rows.length, view.menu_w]).toEqual(["sort", 7, 210]);
    view.menu_pick(3);
    expect(view.menu).toBe("");
    view.tool("sort");
    expect(view.menu_rows[3]?.active).toBe(true);
    view.tool("sort");
    expect(view.menu).toBe("");
  });

  test("Filters: hovering a row opens its submenu; picking State refetches", async () => {
    const { view, handle, calls } = setup([pr(1), pr(2, { state: "merged" })]);
    await handle.idle();
    view.tool("filters");
    expect(view.menu_rows.map((r) => r.label).filter(Boolean)).toEqual(["State", "Involvement", "Author", "Labels", "Draft", "Review", "Checks", "Project"]);
    view.menu_hover(0);
    expect([view.sub, view.sub_w, view.sub_rows.map((r) => r.label)]).toEqual(["state", 190, ["All", "Open", "Closed", "Merged"]]);
    view.sub_pick(3);
    expect([view.menu, view.active_filters]).toEqual(["", 1]);
    await handle.idle();
    expect(calls).toEqual(["fetch open o/r", "fetch merged o/r"]);
    expect(nums(view)).toEqual(["#2"]);
  });

  test("the Project filter narrows the list to that project's repo", async () => {
    const { view, handle } = setup([pr(1, { repo: "o/r" }), pr(2, { repo: "x/y" })]);
    await handle.idle();
    expect(nums(view).length).toBe(2);
    view.tool("filters");
    view.menu_hover(9);
    view.sub_pick(1);
    expect([nums(view), view.active_filters]).toEqual([["#1"], 1]);
  });

  test("keys walk the Filters menu into a submenu and back out", async () => {
    const { view, handle } = setup([pr(1)]);
    await handle.idle();
    view.tool("filters");
    view.menu_key("down");
    view.menu_key("down");
    expect(view.menu_rows.filter((r) => r.active).map((r) => r.label)).toEqual(["Involvement"]);
    view.menu_key("right");
    expect([view.sub, view.sub_hl]).toEqual(["involvement", 0]);
    view.menu_key("down");
    view.menu_key("enter");
    expect(view.menu).toBe("");
    expect(view.active_filters).toBe(1);
    view.tool("filters");
    view.menu_key("esc");
    expect(view.menu).toBe("");
  });

  test("opening a PR shows the panel with its tab, loads it, and the Code tab loads the diff", async () => {
    const { view, handle, calls } = setup([pr(1), pr(2)]);
    await handle.idle();
    view.row_open("https://github.com/o/r/pull/2");
    expect([view.panel_w, view.list_w, view.tabs.map((t) => t.text), view.has_tabs]).toEqual([572, 572, ["#2"], true]);
    await handle.idle();
    expect([view.head.title, view.head.has_full, view.head.draft, view.head.can_project, view.rows.find((r) => r.selected)?.number]).toEqual(["PR 2", true, true, true, "#2"]);
    view.pick_tab("code");
    await handle.idle();
    expect(calls.at(-1)).toBe("gh pr diff https://github.com/o/r/pull/2");
    expect([view.code_state, view.lines.length]).toEqual(["lines", 1]);
  });

  test("detail actions reach the host: copy, check out, review, merge, ready", async () => {
    const { view, handle, calls } = setup([pr(1)]);
    await handle.idle();
    view.row_open("https://github.com/o/r/pull/1");
    await handle.idle();
    for (const a of ["copy_link", "copy_number", "copy_checkout", "copy_branch", "web", "pane", "checkout", "merge", "merge_ask", "review"]) view.detail_act(a);
    expect(calls.slice(1)).toEqual([
      "copy https://github.com/o/r/pull/1", "copy 1", "copy gh pr checkout 1", "copy feat", "open https://github.com/o/r/pull/1", "browser https://github.com/o/r/pull/1", "checkout 4 1", "merge 4 1 false", "merge 4 1 true",
      "review 4 Review PR #1 (P",
    ]);
    view.detail_act("ready");
    expect(view.head.busy).toBe(true);
    await handle.idle();
    expect(calls).toContain("gh pr ready https://github.com/o/r/pull/1");
    expect(calls.filter((c) => c.startsWith("fetch")).length).toBe(2);
    expect(view.head.busy).toBe(false);
  });

  test("the panel's tabs close, hide and maximize through the split", async () => {
    const { view, handle } = setup([pr(1), pr(2)]);
    await handle.idle();
    view.row_open("https://github.com/o/r/pull/1");
    view.row_open("https://github.com/o/r/pull/2");
    expect(view.tabs.length).toBe(2);
    view.tab_act("toggle", -1);
    expect([view.panel_w, view.list_w]).toEqual([0, 1144]);
    view.tab_act(5, -1);
    expect(view.panel_w).toBe(572);
    view.tab_act("maximize", -1);
    expect([view.list_w, view.panel_w, view.maxed]).toEqual([0, 1144, true]);
    view.tab_act("close-all", -1);
    expect([view.panel_w, view.has_tabs, view.maxed]).toEqual([0, false, false]);
  });

  test("a row's context menu and the page's keys", async () => {
    const { view, handle, calls } = setup([pr(1)]);
    await handle.idle();
    view.row_menu("https://github.com/o/r/pull/1");
    expect([view.popup_kind, view.popup_items.map((i) => i.label).slice(-2)]).toEqual(["row", ["Merge with Claude", "Merge with instructions…"]]);
    view.popup_pick(3);
    expect([calls.at(-1), view.popup_kind]).toEqual(["copy https://github.com/o/r/pull/1", ""]);
    view.row_menu("https://github.com/o/r/pull/1");
    view.popup_pick(0);
    expect(view.panel_w).toBe(572);
    handle.shortcut("pr_copy_number");
    expect(calls.at(-1)).toBe("copy 1");
    handle.shortcut("list_close_tab");
    expect(view.has_tabs).toBe(false);
    handle.esc(true);
    expect(calls).not.toContain("close");
    handle.esc(false);
    expect(calls.at(-1)).toBe("close");
  });

  test("tab actions arrive as the Slint enum's name or index", () => {
    expect([tabAct("close-others", 2), tabAct(1, 4), tabAct("close-all", 0), tabAct("nope", 0)]).toEqual([{ kind: "close_others", i: 2 }, { kind: "close", i: 4 }, { kind: "close_all" }, null]);
  });
});
