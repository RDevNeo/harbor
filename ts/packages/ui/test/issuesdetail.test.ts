import { describe, expect, test } from "bun:test";
import type { ghapi } from "@harbor/mcp";
import { keyName, tabAct } from "../src/issues.ts";
import { type IssuesHost, IssuesPage, NOT_PROJECT } from "../src/logic/issues.ts";
import { detailAct, detailView } from "../src/logic/issuesdetail.ts";

const URL = "https://github.com/o/r/issues/3";

const full = (over: Partial<ghapi.IssueFull> = {}): ghapi.IssueFull => ({
  number: 3,
  title: "T",
  url: URL,
  state: "open",
  author: "a",
  created: 100,
  updated: 900,
  labels: [["bug", [0, 255, 0]]],
  assignees: ["b"],
  milestone: "v1",
  body: "hello",
  comments: [{ author: "c", at: 500, body: "hi" }],
  ...over,
});

interface Log {
  gh: string[][];
  fix: [number, number, boolean][];
  copied: string[];
  opened: string[];
}

function setup(f: ghapi.IssueFull, projects: { id: number; name: string; repo: string }[] = [], failFetch = false) {
  const log: Log = { gh: [], fix: [], copied: [], opened: [] };
  const host: IssuesHost = {
    fetch: () => Promise.resolve({ viewer: "me", items: [], sources: [] }),
    projects: () => projects,
    peer: () => undefined,
    details: {
      fetchIssue: () => (failFetch ? Promise.reject(new Error("gh failed")) : Promise.resolve(f)),
      fetchIssueOn: () => Promise.reject(new Error("no")),
      setIssueOpenOn: () => Promise.resolve(),
      gh: (a) => {
        log.gh.push(a);
        return Promise.resolve("");
      },
    },
    agentLabel: () => "Claude",
    agents: () => [{ id: "claude", label: "Claude", current: true }],
    pickAgent: () => {},
    fix: (p, i, ask) => log.fix.push([p, i.number, ask]),
    openUrl: (u) => log.opened.push(u),
    copy: (t) => log.copied.push(t),
    avatar: () => Promise.resolve(null),
    now: () => 1000,
  };
  const page = new IssuesPage(host, () => {});
  return { page, log };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

describe("issuedetail.rs panel", () => {
  test("the panel loads the issue once and shows its parts", async () => {
    const { page } = setup(full(), [{ id: 1, name: "r", repo: "o/r" }]);
    page.open(URL);
    expect(detailView(page, URL).loading).toBe(true);
    await settle();
    const v = detailView(page, URL);
    expect(v).toMatchObject({
      repo_line: "o/r #3",
      title: "T",
      state_text: "Open",
      opened: "opened 15m ago",
      updated: "· updated 1m ago",
      milestone: "v1",
      has_milestone: true,
      comments_title: "Comments (1)",
      is_open: true,
      fix_label: "Fix with Claude",
      fix_enabled: true,
    });
    expect(v.assignees.map((a) => a.login)).toEqual(["b"]);
    expect(v.labels).toEqual([{ name: "bug", color: "#00ff00" }]);
    expect(v.comments[0]).toMatchObject({ author: "c", what: "commented · 8m ago", letter: "C" });
  });

  test("a failed load says why, and a repo that is no project turns Fix off", async () => {
    const { page } = setup(full(), [], true);
    page.open(URL);
    detailView(page, URL);
    await settle();
    const v = detailView(page, URL);
    expect(v.error).toBe("gh failed");
    expect(v.has_full).toBe(false);
    expect([v.fix_enabled, v.fix_tip]).toEqual([false, NOT_PROJECT]);
  });

  test("a closed issue offers Reopen and no Fix", async () => {
    const { page } = setup(full({ state: "done" }));
    page.open(URL);
    detailView(page, URL);
    await settle();
    const v = detailView(page, URL);
    expect([v.is_open, v.act_tip, v.state_text]).toEqual([false, "Reopen the issue (gh issue reopen)", "Closed as completed"]);
  });

  test("Close runs gh issue close and refreshes", async () => {
    const { page, log } = setup(full());
    page.open(URL);
    detailView(page, URL);
    await settle();
    detailAct(page, URL, "close");
    expect(detailView(page, URL).busy).toBe(true);
    await settle();
    expect(log.gh).toEqual([["issue", "close", URL]]);
    expect(detailView(page, URL).busy).toBe(false);
  });

  test("Fix starts a thread in the project, with or without instructions", async () => {
    const { page, log } = setup(full(), [{ id: 4, name: "r", repo: "O/R" }]);
    page.open(URL);
    detailView(page, URL);
    await settle();
    detailAct(page, URL, "fix");
    detailAct(page, URL, "fix-ask");
    expect(log.fix).toEqual([[4, 3, false], [4, 3, true]]);
  });

  test("copy and open actions", async () => {
    const { page, log } = setup(full());
    page.open(URL);
    detailView(page, URL);
    await settle();
    for (const a of ["copy-link", "copy-number", "open-web"] as const) detailAct(page, URL, a);
    expect([log.copied, log.opened]).toEqual([[URL, "3"], [URL]]);
  });

  test("the sections fold", async () => {
    const { page } = setup(full());
    page.open(URL);
    detailView(page, URL);
    await settle();
    detailAct(page, URL, "toggle-desc");
    detailAct(page, URL, "toggle-comments");
    const v = detailView(page, URL);
    expect([v.desc_open, v.comments_open]).toEqual([false, false]);
  });

  test("the window's keys and tab actions map to the page's", () => {
    expect([keyName("w"), keyName("\u0017"), keyName("B")]).toEqual(["w", "w", "b"]);
    expect([tabAct("close-others", 2), tabAct("close-all", -1), tabAct("activate", 1)]).toEqual([{ kind: "close_others", i: 2 }, { kind: "close_all" }, { kind: "activate", i: 1 }]);
  });
});
