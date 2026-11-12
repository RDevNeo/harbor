import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, type Reply } from "../packages/net/src/index.ts";
import { blankChat, type Item, Store } from "../packages/store/src/index.ts";
import { placeOlderStarts, WorkspaceMoves } from "../workspacemoves.ts";

const tmp = mkdtempSync(join(tmpdir(), "harbor-wsmove-"));
/** The test's folder gone; on Windows a store a test left open holds its file until this process ends (Windows clears its temp folder). */
function rmTmp(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    if (process.platform !== "win32") throw e;
  }
}
afterAll(() => rmTmp(tmp));

// A sandbox whose disk loads on first touch takes seconds to open a store: past bun's 5 s default.
const SLOW = 30_000;

const ALL = [
  { id: "org_a", name: "Sam's workspace" },
  { id: "org_b", name: "Team workspace" },
];

function rig(answer: (path: string[]) => Reply = () => ok({ ok: true })) {
  const store = Store.openAt(join(tmp, `${Math.random()}.db`));
  const sent: { peer: string; method: string; path: string[]; body: Record<string, unknown> }[] = [];
  const touched: (number | null)[] = [];
  let all = ALL;
  const moves = new WorkspaceMoves({
    store,
    workspaces: () => ({ all, mine: "org_a", pcs: new Map([["pc:other", "org_b"]]) }),
    pcName: (id) => (id === "pc:other" ? "other" : id),
    forward: async (peer, method, path, body) => {
      sent.push({ peer, method, path, body });
      return answer(path);
    },
    touch: (c) => void touched.push(c),
  });
  return { store, moves, sent, touched, signOut: () => (all = []) };
}

test("a_chat_of_this_pc_moves_here_and_its_peers_hear_of_it", async () => {
  const { store, moves, sent, touched, signOut } = rig();
  const repo = store.addRepo(tmp);
  const c = store.createChat(blankChat({ repoId: repo, title: "t", role: "lead" }));
  expect(moves.chatMenu(c).items.map((i) => [i.label, i.on])).toEqual([["Sam's workspace", true], ["Team workspace", false]]);
  const r = await moves.moveChat(c, "org_b");
  expect(r.body).toEqual({ ok: true, workspace: "org_b", in: "org_b", notice: "Moved to Team workspace" });
  expect(sent).toEqual([]);
  expect(store.placement().chats.get(c.id)).toBe("org_b");
  expect(touched).toEqual([c.id]);
  // Its menu now ticks the new one and offers the way back, which clears it.
  const back = moves.chatMenu(c).items.at(-1);
  expect(back).toMatchObject({ id: "", label: "Back to Sam's workspace", back: true });
  await moves.moveChat(c, back?.id ?? "x");
  expect(store.placement().chats.size).toBe(0);
  // Only the account's workspaces, and a sub-agent stays with its lead.
  expect((await moves.moveChat(c, "org_zzz")).status).toBe(400);
  const sub = store.createChat(blankChat({ repoId: repo, title: "s", role: "sub", parent: c.id }));
  expect((await moves.moveChat(sub, "org_b")).status).toBe(409);
  expect(moves.chatMenu(sub).why).toMatch(/lead/);
  signOut();
  expect(moves.chatMenu(c).why).toMatch(/Sign in/);
}, SLOW);

test("a_copys_move_goes_to_its_home_pc_first_then_shows_here", async () => {
  const { store, moves, sent } = rig();
  const c = store.createChat(blankChat({ title: "copy", role: "lead", home: "pc:other", homeId: 41 }));
  expect(moves.chatMenu(c).items.map((i) => [i.label, i.on, i.hint])).toEqual([["Sam's workspace", false, ""], ["Team workspace", true, "other's Workspace"]]);
  const r = await moves.moveChat(c, "org_a");
  expect(r.status).toBe(200);
  expect(sent).toEqual([{ peer: "pc:other", method: "POST", path: ["v1", "chats", "41", "workspace"], body: { workspace: "org_a" } }]);
  expect(store.placement().chats.get(c.id)).toBe("org_a");
  // Forwarded here from another PC, any id its account knows is taken.
  const own = store.createChat(blankChat({ title: "own", role: "lead" }));
  expect((await moves.moveChat(own, "org_elsewhere", true)).status).toBe(200);
}, SLOW);

test("a_copys_move_fails_when_its_home_pc_cant_take_it", async () => {
  const { store, moves } = rig(() => ({ status: 404, body: { error: "no such call" } }));
  const c = store.createChat(blankChat({ title: "copy", role: "lead", home: "pc:other", homeId: 41 }));
  const r = await moves.moveChat(c, "org_a");
  expect(r.status).toBe(409);
  expect(String((r.body as { error: string }).error)).toMatch(/other runs an older Harbor/);
  expect(store.placement().chats.size).toBe(0);
  const off = rig(() => ({ status: 409, body: { error: "other is off: try again when it's back" } }));
  const d = off.store.createChat(blankChat({ title: "copy", role: "lead", home: "pc:other", homeId: 41 }));
  expect((await off.moves.moveChat(d, "org_a")).status).toBe(409);
  expect(off.store.placement().chats.size).toBe(0);
}, SLOW);

test("a_project_moves_where_its_folder_is_and_its_chats_follow", async () => {
  const { store, moves, sent, touched } = rig();
  const here = store.addRepo(tmp);
  const a = store.createChat(blankChat({ repoId: here, title: "a", role: "lead" }));
  const r = await moves.moveProject(store.repos().find((x) => x.id === here)!, "org_b");
  expect(r.body).toMatchObject({ ok: true, workspace: "org_b", notice: "Moved to Team workspace" });
  expect(sent).toEqual([]);
  expect(store.placement().repos.get(here)).toBe("org_b");
  expect(touched).toContain(a.id);
  expect(moves.chatIn(a)).toBe("org_b");
  // A chat with its own stays where it was put.
  store.setChatWorkspace(a.id, "org_a");
  expect(moves.chatIn(a)).toBe("org_a");
  // A project whose folder is another PC's: there first.
  const away = store.addRepo("/nowhere/other/app");
  store.createChat(blankChat({ repoId: away, title: "copy", role: "lead", home: "pc:other", homeId: 9 }));
  const repo = store.repos().find((x) => x.id === away)!;
  expect(moves.projectMenu(repo).items.map((i) => [i.label, i.on])).toEqual([["Sam's workspace", false], ["Team workspace", true]]);
  expect((await moves.moveProject(repo, "org_a")).status).toBe(200);
  expect(sent).toEqual([{ peer: "pc:other", method: "POST", path: ["v1", "projects", "do"], body: { project: "/nowhere/other/app", act: "workspace", workspace: "org_a" } }]);
  expect(store.placement().repos.get(away)).toBe("org_a");
}, SLOW);

test("a_chat_is_shared_with_another_workspace_and_keeps_its_owner", async () => {
  const { store, moves, sent, touched, signOut } = rig();
  const repo = store.addRepo(tmp);
  const c = store.createChat(blankChat({ repoId: repo, title: "t", role: "lead" }));
  // The owner is shown, not a toggle; the others start unticked.
  expect(moves.chatShares(c).items.map((i) => [i.label, i.on, i.owner])).toEqual([["Sam's workspace", true, true], ["Team workspace", false, false]]);
  const r = await moves.shareChat(c, "org_b", true);
  expect(r.body).toEqual({ ok: true, shared: ["org_b"], notice: "Shared with Team workspace" });
  expect(sent).toEqual([]);
  expect(touched).toEqual([c.id]);
  expect(moves.chatIn(c)).toBe("org_a");
  expect(moves.chatShares(c).line).toBe("Owned by Sam's workspace · shared with Team workspace");
  // Its owner can't be a share; bad input and a sub-agent are refused.
  expect((await moves.shareChat(c, "org_a", true)).status).toBe(409);
  expect((await moves.shareChat(c, "org_zzz", true)).status).toBe(400);
  expect((await moves.shareChat(c, "org_b", "yes")).status).toBe(400);
  const sub = store.createChat(blankChat({ repoId: repo, title: "s", role: "sub", parent: c.id }));
  expect((await moves.shareChat(sub, "org_b", true)).status).toBe(409);
  expect(moves.chatShares(sub).why).toMatch(/lead/);
  // Moved to the workspace it was shared with: the share goes, it's the owner now.
  await moves.moveChat(c, "org_b");
  expect(store.placement().shared?.chats.has(c.id)).toBe(false);
  expect(moves.chatShares(c).line).toBe("Owned by Team workspace · not shared");
  await moves.shareChat(c, "org_a", true);
  expect((await moves.shareChat(c, "org_a", false)).body).toMatchObject({ shared: [], notice: "No longer shared with Sam's workspace" });
  signOut();
  expect(moves.chatShares(c).why).toMatch(/Sign in/);
}, SLOW);

test("a_copys_share_goes_to_its_home_pc_first_and_fails_when_it_cant_take_it", async () => {
  const { store, moves, sent } = rig();
  const c = store.createChat(blankChat({ title: "copy", role: "lead", home: "pc:other", homeId: 41 }));
  expect((await moves.shareChat(c, "org_a", true)).status).toBe(200);
  expect(sent).toEqual([{ peer: "pc:other", method: "POST", path: ["v1", "chats", "41", "share"], body: { workspace: "org_a", on: true } }]);
  expect(store.placement().shared?.chats.get(c.id)).toEqual(["org_a"]);
  const old = rig(() => ({ status: 404, body: { error: "no such call" } }));
  const d = old.store.createChat(blankChat({ title: "copy", role: "lead", home: "pc:other", homeId: 41 }));
  const r = await old.moves.shareChat(d, "org_a", true);
  expect(r.status).toBe(409);
  expect(String((r.body as { error: string }).error)).toMatch(/other runs an older Harbor/);
  expect(old.store.placement().shared?.chats.size).toBe(0);
  // Forwarded here from another PC: any id its account knows is taken.
  const own = store.createChat(blankChat({ title: "own", role: "lead" }));
  expect((await moves.shareChat(own, "org_elsewhere", true, true)).status).toBe(200);
}, SLOW);

test("a_project_is_shared_where_its_folder_is_and_its_chats_get_its_shares", async () => {
  const { store, moves, sent, touched } = rig();
  const here = store.addRepo(tmp);
  const a = store.createChat(blankChat({ repoId: here, title: "a", role: "lead" }));
  const repo = store.repos().find((x) => x.id === here)!;
  expect((await moves.shareProject(repo, "org_b", true)).body).toMatchObject({ ok: true, shared: ["org_b"], notice: "Shared with Team workspace" });
  expect(sent).toEqual([]);
  expect(touched).toContain(a.id);
  expect(touched).toContain(null);
  // Its chat gets it, locked (it's the project's), and keeps its owner.
  expect(moves.chatShares(a).items.map((i) => [i.label, i.on, i.owner, i.locked])).toEqual([["Sam's workspace", true, true, false], ["Team workspace", true, false, true]]);
  expect(moves.chatIn(a)).toBe("org_a");
  expect((await moves.shareProject(repo, "org_a", true)).status).toBe(409);
  // Moved where it was shared: the share goes.
  await moves.moveProject(repo, "org_b");
  expect(store.placement().shared?.repos.has(here)).toBe(false);
  // Another PC's folder: there first.
  const away = store.addRepo("/nowhere/other/app");
  store.createChat(blankChat({ repoId: away, title: "copy", role: "lead", home: "pc:other", homeId: 9 }));
  const there = store.repos().find((x) => x.id === away)!;
  expect(moves.projectShares(there).items.map((i) => [i.label, i.owner])).toEqual([["Sam's workspace", false], ["Team workspace", true]]);
  expect((await moves.shareProject(there, "org_a", true)).status).toBe(200);
  expect(sent).toEqual([{ peer: "pc:other", method: "POST", path: ["v1", "projects", "do"], body: { project: "/nowhere/other/app", act: "share", workspace: "org_a", on: true } }]);
  expect(store.placement().shared?.repos.get(away)).toEqual(["org_a"]);
}, SLOW);

test("a_project_whose_folder_is_another_pcs_is_in_that_pcs_workspace", () => {
  const { store, moves } = rig();
  // Its chats' copies say which PC; with none left, the PC its copies last came from.
  const away = store.addRepo("/nowhere/other/game");
  store.createChat(blankChat({ repoId: away, title: "copy", role: "lead", home: "pc:other", homeId: 3 }));
  expect(moves.projectIn(store.repos().find((x) => x.id === away)!)).toBe("org_b");
  const bare = store.addRepo("/nowhere/other/bare");
  store.setProjectPc(bare, "pc:other");
  const repo = store.repos().find((x) => x.id === bare)!;
  expect(moves.projectIn(repo)).toBe("org_b");
  expect(moves.projectHome(repo)).toBe("pc:other");
  // A PC in no workspace known here, or none known at all: no workspace, not this PC's.
  store.setProjectPc(bare, "pc:loose");
  expect(moves.projectIn(repo)).toBe("");
  const lost = store.addRepo("/nowhere/lost");
  expect(moves.projectIn(store.repos().find((x) => x.id === lost)!)).toBe("");
  // Its PC's move, as a copy carries it, is where it is.
  const c = store.createChat(blankChat({ repoId: bare, title: "copy", role: "lead", home: "pc:other", homeId: 4 }));
  store.setCarriedWorkspace(c.id, "org_a");
  expect(moves.projectIn(repo)).toBe("org_a");
  expect(moves.projectMenu(repo).items.filter((i) => i.on).map((i) => [i.to, i.id])).toEqual([["org_a", ""]]);
  // This PC's own project: this PC's workspace.
  const here = store.addRepo(tmp);
  expect(moves.projectIn(store.repos().find((x) => x.id === here)!)).toBe("org_a");
}, SLOW);

test(
  "chats with no project others started here before are placed in their workspace once",
  () => {
    const store = Store.openAt(join(tmp, `${Math.random()}.db`));
    const said = (dev: string | undefined): Item => ({ kind: "user", text: "hi", files: [], at: 1, mentions: [], sender: dev ? "Pixel (Sam)" : "", intent: "", ...(dev ? { dev } : {}) });
    const chat = (title: string, first: Item | null, more: Partial<Parameters<typeof blankChat>[0]> = {}) => {
      const c = store.createChat(blankChat({ title, role: "lead", ...more }));
      if (first) store.saveItems(c.id, [first]);
      return c.id;
    };
    const sams = chat("sam's phone", said("phone:g-sam"));
    const pc = chat("sam's pc", said("pc:ts:sam-pc"));
    const mine = chat("typed here", said(undefined));
    const empty = chat("nothing yet", null);
    const kept = chat("moved already", said("phone:g-sam"));
    store.setChatWorkspace(kept, "org_a");
    const repo = store.addRepo(tmp);
    const inProject = chat("in a project", said("phone:g-sam"), { repoId: repo });
    const copy = chat("a copy", said("phone:g-sam"), { home: "pc:other", homeId: 3 });
    const devs: string[] = [];
    const n = placeOlderStarts(store, (dev) => {
      devs.push(dev);
      return dev === "phone:g-sam" || dev === "pc:ts:sam-pc" ? "org_b" : "";
    });
    expect(n).toBe(2);
    const place = store.placement().chats;
    expect([sams, pc, mine, empty, kept, inProject, copy].map((id) => place.get(id) ?? "")).toEqual(["org_b", "org_b", "", "", "org_a", "", ""]);
    expect(devs).toEqual(["phone:g-sam", "pc:ts:sam-pc"]);
    store.close();
  },
  SLOW,
);
