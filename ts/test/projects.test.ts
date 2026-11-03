import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Call, err, ok, type Reply } from "../packages/net/src/index.ts";
import { blankChat, Store } from "../packages/store/src/index.ts";
import { realDisk } from "../packages/ui/src/addproject.ts";
import type { GhList } from "../packages/ui/src/logic/addproject.ts";
import { ProjectsApi, type ProjectsHost } from "../projectsapi.ts";

let root: string;
let home: string;
let store: Store;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "hts-projects-"));
  home = join(root, "home");
  mkdirSync(join(home, "Projects", "old"), { recursive: true });
  mkdirSync(join(home, "Documents"), { recursive: true });
  store = Store.open(join(root, "data"));
});

afterAll(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

type Forwarded = { peer: string; path: string[]; body: Record<string, unknown> };

function api(over: Partial<ProjectsHost> = {}): { api: ProjectsApi; touched: () => number; forwarded: Forwarded[] } {
  let touched = 0;
  const forwarded: Forwarded[] = [];
  const peers: Record<string, { id: string; name: string; online: boolean }> = { "pc:laptop": { id: "pc:laptop", name: "laptop", online: true }, "pc:off": { id: "pc:off", name: "sam-work", online: false } };
  const a = new ProjectsApi({
    store,
    reload: () => {},
    touch: () => touched++,
    me: () => ({ id: "pc:desk", name: "desk" }),
    peer: (id) => peers[id] ?? null,
    forward: async (peer, path, body) => {
      forwarded.push({ peer, path, body });
      return ok({ ok: true, id: 7, name: "made", path: "/home/sam/Projects/made", remote: "", existing: false, git: true, pc: peer, pc_name: "laptop" });
    },
    sender: () => "Pixel",
    disk: () => ({ ...realDisk(), home }),
    clones: () => new Map(),
    origin: () => "",
    ...over,
  });
  return { api: a, touched: () => touched, forwarded };
}

const call = (path: string, body: unknown, global = true): Call => ({ method: "POST", path: path.split("/").filter(Boolean), query: [], body, token: "", device: "", global });
const body = (r: Reply | null): Record<string, unknown> => (r?.body ?? {}) as Record<string, unknown>;

test("a_phone_reads_the_desktops_add_project_rows", async () => {
  const { api: a } = api();
  const sources = body(await a.route(call("v1/projects/rows", {})));
  expect(sources).toMatchObject({ pc: "pc:desk", pc_name: "desk", step: "sources", label: "Sources" });
  expect((sources.rows as { title: string; act: unknown }[]).map((r) => [r.title, r.act])).toEqual([
    ["New project", { kind: "step", step: "new" }],
    ["Local folder", { kind: "step", step: "local" }],
    ["Git URL", { kind: "step", step: "url" }],
    ["GitHub repository", { kind: "step", step: "github" }],
  ]);
  const fresh = body(await a.route(call("v1/projects/rows", { step: "new", query: "demo" })));
  expect(fresh.rows).toEqual([
    { icon: "folder-git", title: "Create “demo”", detail: "git init in ~/Projects/demo", act: { kind: "create", name: "demo", git: true } },
    { icon: "folder", title: "Create “demo” without Git", detail: "Plain folder in ~/Projects/demo, no Git or GitHub", act: { kind: "create", name: "demo", git: false } },
  ]);
  expect(body(await a.route(call("v1/projects/rows", { step: "new" }))).statuses).toEqual([{ text: "Type a name, then Enter", tone: "subtle" }]);
  const browse = body(await a.route(call("v1/projects/rows", { step: "local", dir: "~/Projects" })));
  expect(browse).toMatchObject({ dir: join(home, "Projects"), dir_label: "~/Projects" });
  expect((browse.rows as { title: string }[]).map((r) => r.title)).toEqual(["..", "old"]);
  expect(body(await a.route(call("v1/projects/rows", { step: "local", dir: "~/nope" }))).statuses).toContainEqual({ text: "Not a folder: ~/nope", tone: "error" });
  expect(await a.route({ ...call("v1/projects/rows", {}), method: "GET" })).toBeNull();
  expect(await a.route(call("v1/chats", {}))).toBeNull();
});

test("a_phone_creates_a_project_with_or_without_git_and_hears_why_it_cant", async () => {
  const { api: a, touched } = api();
  const r = await a.route(call("v1/projects", { act: { kind: "create", name: "demo", git: true } }));
  const dir = join(home, "Projects", "demo");
  expect(r?.status).toBe(200);
  expect(body(r)).toMatchObject({ ok: true, id: dir, name: "demo", path: dir, existing: false, git: true, pc: "pc:desk", pc_name: "desk" });
  expect(existsSync(join(dir, ".git"))).toBe(true);
  expect(store.repos().some((x) => x.path === dir)).toBe(true);
  expect(touched()).toBeGreaterThan(0);
  const again = await a.route(call("v1/projects", { act: { kind: "create", name: "demo", git: true } }));
  expect([again?.status, body(again).error]).toEqual([409, "~/Projects/demo already exists"]);
  const plain = await a.route(call("v1/projects", { act: { kind: "create", name: "notes", git: false } }, false));
  const id = store.repos().find((x) => x.path === join(home, "Projects", "notes"))?.id;
  expect(body(plain)).toMatchObject({ id, git: false });
  expect(existsSync(join(home, "Projects", "notes", ".git"))).toBe(false);
  for (const name of ["", "a/b", ".."]) expect((await a.route(call("v1/projects", { act: { kind: "create", name, git: true } })))?.status).toBe(400);
  expect((await a.route(call("v1/projects", { act: { kind: "explode" } })))?.status).toBe(400);
});

test("a_phone_adds_an_existing_folder", async () => {
  const { api: a } = api();
  const docs = join(home, "Documents");
  expect(body(await a.route(call("v1/projects", { act: { kind: "add", dir: "~/Documents" } })))).toMatchObject({ id: docs, existing: false });
  expect(body(await a.route(call("v1/projects", { act: { kind: "add", dir: docs } })))).toMatchObject({ id: docs, existing: true });
  const gone = await a.route(call("v1/projects", { act: { kind: "add", dir: "~/gone" } }));
  expect([gone?.status, body(gone).error]).toEqual([409, "Not a folder: ~/gone"]);
});

test("a_clone_runs_in_the_background_and_the_phone_polls_it", async () => {
  let finish: (e: string | null) => void = () => {};
  const asked: [string, string, boolean][] = [];
  const { api: a } = api({
    clone: (url, dir, github) => {
      asked.push([url, dir, github]);
      return new Promise((resolve) => {
        finish = (e) => {
          if (e === null) mkdirSync(join(dir, ".git"), { recursive: true });
          resolve(e);
        };
      });
    },
  });
  const started = await a.route(call("v1/projects", { act: { kind: "clone", url: "o/tool", name: "tool", github: true } }));
  expect(started?.status).toBe(202);
  const job = body(started).job as string;
  expect(body(started)).toMatchObject({ ok: true, text: "Cloning o/tool…", into: "~/Projects/tool" });
  expect(asked).toEqual([["o/tool", join(home, "Projects", "tool"), true]]);
  expect((await a.route(call("v1/projects/job", { job })))?.status).toBe(202);
  finish(null);
  await Bun.sleep(5);
  const done = await a.route(call("v1/projects/job", { job }));
  const dir = join(home, "Projects", "tool");
  expect([done?.status, body(done).id, body(done).path]).toEqual([200, dir, dir]);
  expect(store.get(`untrusted:${dir}`)).toBe("1");
  const failing = await a.route(call("v1/projects", { act: { kind: "clone", url: "https://example.com/x.git", name: "x" } }));
  expect(asked.at(-1)?.[2]).toBe(false);
  finish("fatal: repository not found");
  await Bun.sleep(5);
  const failed = await a.route(call("v1/projects/job", { job: body(failing).job }));
  expect([failed?.status, body(failed).error]).toEqual([409, "fatal: repository not found"]);
  expect((await a.route(call("v1/projects/job", { job: "nope" })))?.status).toBe(404);
  expect((await a.route(call("v1/projects", { act: { kind: "clone", url: "o/tool", name: "tool" } })))?.status).toBe(409);
});

test("github_rows_load_in_the_background", async () => {
  let give: (l: GhList) => void = () => {};
  const { api: a } = api({ github: () => new Promise((resolve) => (give = resolve)) });
  const first = body(await a.route(call("v1/projects/rows", { step: "github" })));
  expect(first.loading).toBe(true);
  expect(first.statuses).toContainEqual({ text: "Loading your repositories…", tone: "subtle" });
  give({ ok: [["o/tool", "A tool"]] });
  await Bun.sleep(5);
  const later = body(await a.route(call("v1/projects/rows", { step: "github" })));
  expect(later.loading).toBe(false);
  expect(later.rows).toEqual([{ icon: "github", title: "o/tool", detail: "Already in Harbor: ~/Projects/tool", act: { kind: "add", dir: join(home, "Projects", "tool") } }]);
  const other = body(await a.route(call("v1/projects/rows", { step: "github", query: "o/new" })));
  expect((other.rows as { act: unknown }[])[0]?.act).toEqual({ kind: "clone", url: "o/new", name: "new", github: true });
});

test("another_pc_makes_the_project_and_it_is_listed_here_too", async () => {
  const { api: a, forwarded } = api();
  const r = await a.route(call("v1/projects", { pc: "pc:laptop", act: { kind: "create", name: "made", git: true } }, false));
  expect(forwarded).toEqual([{ peer: "pc:laptop", path: ["v1", "projects"], body: { act: { kind: "create", name: "made", git: true } } }]);
  const here = store.repos().find((x) => x.path === "/home/sam/Projects/made");
  expect(here).toBeDefined();
  expect(body(r)).toMatchObject({ id: here?.id, path: "/home/sam/Projects/made", pc: "pc:laptop", pc_name: "laptop" });
  expect(body(await a.route(call("v1/projects", { pc: "pc:laptop", act: { kind: "create", name: "made" } }))).id).toBe("/home/sam/Projects/made");
  expect(store.repos().filter((x) => x.path === "/home/sam/Projects/made")).toHaveLength(1);
  await a.route(call("v1/projects/rows", { pc: "pc:laptop", step: "new" }));
  expect(forwarded.at(-1)).toEqual({ peer: "pc:laptop", path: ["v1", "projects", "rows"], body: { step: "new" } });
  expect(body(await a.route(call("v1/projects/rows", { pc: "pc:desk" }))).pc).toBe("pc:desk");
  expect(body(await a.route(call("v1/projects", { pc: "pc:off", act: { kind: "create", name: "x" } })))).toEqual({ error: "sam-work is off: pick a PC that's on" });
  expect((await a.route(call("v1/projects", { pc: "pc:who", act: { kind: "create", name: "x" } })))?.status).toBe(404);
  const old = api({ forward: async () => err(404, "no such call") }).api;
  expect(body(await old.route(call("v1/projects/rows", { pc: "pc:laptop" }))).error).toBe("laptop runs an older Harbor that can't add projects from a phone: update it there first");
  const down = api({ forward: async () => err(503, "laptop is off or unreachable: the chat is read-only until it's back") }).api;
  expect(body(await down.route(call("v1/projects/rows", { pc: "pc:laptop" }))).error).toBe("laptop is off or unreachable");
});

test("the_phones_project_sheet_lists_what_the_desktops_project_menu_does", async () => {
  const dir = join(home, "Projects", "menu-gh");
  mkdirSync(dir, { recursive: true });
  const id = store.addRepo(dir);
  store.setRepoRemote(id, "git@github.com:sam/menu-gh.git");
  const { api: a } = api({ mainChat: (repo, global) => (repo === id ? { id: global ? "pc:desk/41" : 41, title: "Main work" } : null), customIcon: () => true });
  const m = body(await a.route(call("v1/projects/menu", { project: dir })));
  expect(m).toMatchObject({ id: dir, path: dir, remote: "https://github.com/sam/menu-gh", github: "sam/menu-gh", main: { id: "pc:desk/41", title: "Main work" }, snoozed: null });
  expect((m.row as { act: string; label: string }[]).map((r) => r.label)).toEqual(["New chat in this project", "Snooze"]);
  const items = m.items as { act: string; label: string; icon: string; sep: boolean; enabled: boolean; desc: string }[];
  expect(items.map((i) => [i.label, i.icon, i.sep, i.enabled])).toEqual([
    ["Open terminal", "terminal", false, false],
    ["Pull requests", "pr", false, true],
    ["Issues", "circle-dot", false, true],
    ["Open remote", "external", false, true],
    ["Rename main chat", "", true, true],
    ["Settle main chat", "", false, true],
    ["Refresh icon", "", true, true],
    ["Choose icon…", "", false, true],
    ["Use website icon", "", false, true],
    ["Settle project", "archive", true, true],
    ["Move to PC…", "monitor", false, true],
    ["Remove from Harbor", "", false, true],
  ]);
  expect(items[0]?.desc).toBe("It opens in Harbor's window on desk");
  // By number too (a phone without global ids).
  expect(body(await a.route(call("v1/projects/menu", { project: id }, false))).id).toBe(id);
  expect((await a.route(call("v1/projects/menu", { project: "/nowhere" })))?.status).toBe(404);
});

test("a_chat_less_project_without_a_remote_still_has_its_menu", async () => {
  const dir = join(home, "Projects", "menu-plain");
  mkdirSync(dir, { recursive: true });
  store.addRepo(dir);
  const { api: a } = api();
  const m = body(await a.route(call("v1/projects/menu", { project: dir })));
  expect(m.main).toBeNull();
  expect((m.items as { label: string }[]).map((i) => i.label)).toEqual(["Open terminal", "Refresh icon", "Choose icon…", "Settle project", "Move to PC…", "Remove from Harbor"]);
});

test("the_project_sheets_acts_run_on_the_pc", async () => {
  const dir = join(home, "Projects", "menu-acts");
  mkdirSync(dir, { recursive: true });
  const id = store.addRepo(dir);
  const icons: unknown[] = [];
  const removed: number[] = [];
  const { api: a, touched } = api({
    setIcon: async (repo, how) => (icons.push([repo, how]), null),
    remove: (repo) => {
      removed.push(repo);
      store.removeRepo(repo);
    },
    uploadPath: (u) => (u === "ab/icon.png" ? "/tmp/up/icon.png" : null),
  });
  const run = (b: Record<string, unknown>) => a.route(call("v1/projects/do", { project: dir, ...b }));
  expect((await run({ act: "refresh_icon" }))?.status).toBe(200);
  expect((await run({ act: "website_icon" }))?.status).toBe(200);
  expect((await run({ act: "choose_icon", upload: "nope" }))?.status).toBe(400);
  expect((await run({ act: "choose_icon", upload: "ab/icon.png" }))?.status).toBe(200);
  expect(icons).toEqual([[id, "refresh"], [id, "website"], [id, { file: "/tmp/up/icon.png" }]]);

  const before = touched();
  const s = await run({ act: "snooze", text: "5h", off: 0 });
  expect(s?.status).toBe(200);
  expect(typeof body(s).snoozed_label).toBe("string");
  expect(touched()).toBeGreaterThan(before);
  expect(JSON.parse(store.get("snoozed") ?? "{}")[`r${id}`]).toBeGreaterThan(Date.now() / 1000);
  expect(String(body(await a.route(call("v1/projects/menu", { project: dir }))).snoozed)).toStartWith("until ");
  expect(body(await run({ act: "snooze", text: "soon" })).error).toBe("Try 5h, 1h30m, 2d or 18:00");
  expect((await run({ act: "snooze", wake: true }))?.status).toBe(200);
  expect(JSON.parse(store.get("snoozed") ?? "{}")[`r${id}`]).toBeUndefined();

  expect((await run({ act: "prs" }))?.status).toBe(400);
  expect((await run({ act: "remove" }))?.status).toBe(200);
  expect(removed).toEqual([id]);
  expect(store.repos().some((r) => r.id === id)).toBe(false);
  expect((await run({ act: "remove" }))?.status).toBe(404);
});

test("a_project_menu_on_another_pc_goes_there", async () => {
  const { api: a, forwarded } = api({ forward: async (peer, path, b) => (forwarded.push({ peer, path, body: b }), ok({ id: "/home/sam/x", path: "/home/sam/x", items: [] })) });
  const r = await a.route(call("v1/projects/menu", { pc: "pc:laptop", project: "/home/sam/x" }));
  expect(r?.status).toBe(200);
  expect(forwarded.at(-1)).toEqual({ peer: "pc:laptop", path: ["v1", "projects", "menu"], body: { project: "/home/sam/x" } });
  // Not added here as a new project: it's only a menu.
  expect(store.repos().some((x) => x.path === "/home/sam/x")).toBe(false);
  const old = api({ forward: async () => err(404, "no such call") }).api;
  expect(body(await old.route(call("v1/projects/do", { pc: "pc:laptop", project: "/x", act: "remove" }))).error).toBe("laptop runs an older Harbor that can't change its projects from a phone: update it there first");
});

test("a_phone_settles_and_unsettles_a_project", async () => {
  const dir = join(home, "Projects", "menu-settle");
  mkdirSync(dir, { recursive: true });
  const id = store.addRepo(dir);
  const lead = store.createChat(blankChat({ repoId: id, title: "work", role: "lead" }));
  const told: [number, boolean][] = [];
  let reloaded = 0;
  const { api: a, touched } = api({ settled: (repo, on) => told.push([repo, on]), reload: () => reloaded++ });
  const before = touched();
  const r = await a.route(call("v1/projects/do", { project: dir, act: "settle_project" }));
  expect(body(r)).toEqual({ ok: true, settled: true });
  expect(store.settledProjects().has(id)).toBe(true);
  expect(store.chat(lead.id)?.settled).toBe(true);
  expect([told, reloaded > 0, touched() > before]).toEqual([[[id, true]], true, true]);
  // Under Settled, the sheet offers Unsettle project and none of the row's buttons.
  const m = body(await a.route(call("v1/projects/menu", { project: dir })));
  expect(m.settled).toBe(true);
  expect(m.row).toEqual([]);
  expect((m.items as { label: string }[]).map((i) => i.label)).toContain("Unsettle project");
  expect((m.items as { label: string }[]).map((i) => i.label)).not.toContain("Settle project");
  expect(body(await a.route(call("v1/projects/do", { project: dir, act: "unsettle_project" })))).toEqual({ ok: true, settled: false });
  expect(store.settledProjects().has(id)).toBe(false);
  expect(store.chat(lead.id)?.settled).toBe(false);
  expect(told.at(-1)).toEqual([id, false]);
});

test("settling a project on another pc goes there", async () => {
  const { api: a, forwarded } = api({ forward: async (peer, path, b) => (forwarded.push({ peer, path, body: b }), ok({ ok: true, settled: true })) });
  expect(body(await a.route(call("v1/projects/do", { pc: "pc:laptop", project: "/home/sam/x", act: "settle_project" })))).toEqual({ ok: true, settled: true });
  expect(forwarded.at(-1)).toEqual({ peer: "pc:laptop", path: ["v1", "projects", "do"], body: { project: "/home/sam/x", act: "settle_project" } });
  expect(body(await a.route(call("v1/projects/do", { pc: "pc:off", project: "/x", act: "settle_project" }))).error).toBe("sam-work is off: pick a PC that's on");
});
