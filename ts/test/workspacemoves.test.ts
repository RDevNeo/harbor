import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, type Reply } from "../packages/net/src/index.ts";
import { blankChat, Store } from "../packages/store/src/index.ts";
import { WorkspaceMoves } from "../workspacemoves.ts";

const tmp = mkdtempSync(join(tmpdir(), "harbor-wsmove-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

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
});

test("a_copys_move_goes_to_its_home_pc_first_then_shows_here", async () => {
  const { store, moves, sent } = rig();
  const c = store.createChat(blankChat({ title: "copy", role: "lead", home: "pc:other", homeId: 41 }));
  expect(moves.chatMenu(c).items.map((i) => [i.label, i.on, i.hint])).toEqual([["Sam's workspace", false, ""], ["Team workspace", true, "other's workspace"]]);
  const r = await moves.moveChat(c, "org_a");
  expect(r.status).toBe(200);
  expect(sent).toEqual([{ peer: "pc:other", method: "POST", path: ["v1", "chats", "41", "workspace"], body: { workspace: "org_a" } }]);
  expect(store.placement().chats.get(c.id)).toBe("org_a");
  // Forwarded here from another PC, any id its account knows is taken.
  const own = store.createChat(blankChat({ title: "own", role: "lead" }));
  expect((await moves.moveChat(own, "org_elsewhere", true)).status).toBe(200);
});

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
});

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
});
