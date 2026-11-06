import { describe, expect, test } from "bun:test";
import { ICONS } from "../src/icons.ts";
import { itemJson, paletteItem, paletteItems, rank, remember, RECENT_MAX, type Item, type Section } from "../src/logic/palette.ts";

const item = (id: string, s: Section, title: string, detail: string, at: number, keywords = ""): Item => paletteItem(id, s, ICONS.FILE, "file", title, detail, { kind: "prs" }, keywords, at);

function sample(): Item[] {
  return [
    item("act:new", "actions", "New chat", "harbor", 0, "thread start"),
    item("new:1", "actions", "New chat in harbor", "~/Projects/harbor", 0),
    item("project:1", "projects", "harbor", "~/Projects/harbor", 0),
    item("project:2", "projects", "site", "~/Projects/site", 0),
    item("chat:1", "chats", "Fix the composer", "harbor", 10),
    item("chat:2", "chats", "Palette design", "harbor · settled", 30),
    item("chat:3", "agents", "tests-runner", "harbor · Fix the composer", 20),
    item("settings:general", "pages", "General", "Settings", 0, "settings fast mode"),
  ];
}

const ids = (v: [Section, Item[]][]) => v.map(([s, r]) => [s, r.map((i) => i.id)] as const);

describe("palette.rs", () => {
  test("empty_query_shows_recent_first", () => {
    const v = ids(rank(sample(), "", ["chat:1", "gone:9", "project:2"]));
    expect(v[0]).toEqual(["recent", ["chat:1", "project:2"]]);
    expect(v.find(([s]) => s === "projects")?.[1]).toEqual(["project:1"]);
    expect(v.find(([s]) => s === "chats")?.[1]).toEqual(["chat:2"]);
    expect(v.map(([s]) => s)).toEqual(["recent", "actions", "projects", "chats", "agents", "pages"]);
  });

  test("query_ranks_and_groups", () => {
    const items = sample();
    expect(ids(rank(items, "harbor", []))[0]).toEqual(["projects", ["project:1"]]);
    expect(ids(rank(items, "new harbor", []))).toEqual([["actions", ["new:1", "act:new"]]]);
    expect(ids(rank(items, "composer", []))).toEqual([
      ["chats", ["chat:1"]],
      ["agents", ["chat:3"]],
    ]);
    expect(ids(rank(items, "fast", []))[0]?.[1]).toEqual(["settings:general"]);
    expect(ids(rank(items, "pltt", []))[0]?.[1]).toEqual(["chat:2"]);
    expect(rank(items, "zzzz", [])).toEqual([]);
  });

  test("ties_go_to_recent_picks", () => {
    const items = [item("chat:1", "chats", "Deploy", "a", 5), item("chat:2", "chats", "Deploy", "b", 1)];
    expect(ids(rank(items, "deploy", []))[0]?.[1]).toEqual(["chat:1", "chat:2"]);
    expect(ids(rank(items, "deploy", ["chat:2"]))[0]?.[1]).toEqual(["chat:2", "chat:1"]);
  });

  test("remembers_picks", () => {
    expect(remember(["a", "b"], "b")).toEqual(["b", "a"]);
    expect(remember(Array.from({ length: 30 }, (_, i) => String(i)), "x")).toHaveLength(RECENT_MAX);
  });

  test("phone_rows", () => {
    const v = itemJson(paletteItem("chat:4", "chats", ICONS.MESSAGE, "message", "T", "d", { kind: "chat", id: 4 }));
    expect([v?.kind, v?.chat, v?.icon]).toEqual(["chat", 4, "message"]);
    expect(itemJson(paletteItem("act:sidebar", "actions", ICONS.PANEL_LEFT, "panel", "S", "", { kind: "toggle_sidebar" }))).toBeNull();
    expect(itemJson(paletteItem("new:", "actions", ICONS.COMPOSE, "compose", "N", "", { kind: "new_chat", repo: null }))?.project).toBeNull();
    const p = itemJson(paletteItem("project:3", "projects", ICONS.FOLDER, "folder", "P", "", { kind: "project", id: 3 }));
    expect([p?.kind, p?.project, p?.main]).toEqual(["new_chat", 3, true]);
    expect(itemJson(paletteItem("new:3", "actions", ICONS.COMPOSE, "compose", "N", "", { kind: "new_chat", repo: 3 }))?.main).toBeUndefined();
  });

  test("the items: the open chat's actions first, a sub-agent under its lead, every Settings tab", () => {
    const v = paletteItems({
      repos: [{ id: 1, name: "harbor", dir: "~/Projects/harbor" }],
      chats: [
        { id: 1, title: "Fix it", role: "lead", parent: null, name: "lead", repoId: 1, settled: false, updated: 5 },
        { id: 2, title: "Tests", role: "sub", parent: 1, name: "tests", repoId: 1, settled: false, updated: 6 },
      ],
      devices: [],
      current: 1,
      draftRepo: null,
      fast: false,
      forkable: true,
    });
    expect(v.slice(0, 3).map((i) => i.id)).toEqual(["act:settle:1", "act:fork:1", "act:new"]);
    const sub = v.find((i) => i.id === "chat:2");
    expect([sub?.section, sub?.title, sub?.detail]).toEqual(["agents", "tests", "harbor · Fix it"]);
    expect(v.filter((i) => i.id.startsWith("settings:"))).toHaveLength(8);
  });
});
