import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankChat, Store } from "@harbor/store";
import { addFolder, folderOf, foldProjects } from "../src/projectfold.ts";

const tmp = mkdtempSync(join(tmpdir(), "harbor-fold-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// A slow sandbox opens a store in seconds.
const SLOW = 30_000;
const HOME = "/home/me";
const THEIRS = "/home/sam/Documents/game";
const MINE = "/home/me/Documents/game";
/** Which folders are on this PC. */
const here = (dirs: string[]) => (d: string) => dirs.includes(d);

function store(): Store {
  return Store.openAt(join(tmp, `${Math.random()}.db`));
}

test("a_folder_is_another_pcs_project_by_its_remote_or_without_git_by_name_and_place", () => {
  const away = { path: THEIRS, name: "game", remote: "" };
  // No Git on either side: the same name where Harbor would put it here.
  expect(folderOf(away, MINE, "", HOME)).toBe(true);
  expect(folderOf(away, `${MINE}/`, "", HOME)).toBe(true);
  expect(folderOf(away, "/home/me/work/game", "", HOME)).toBe(false);
  expect(folderOf(away, "/home/me/Documents/other", "", HOME)).toBe(false);
  // One side with Git, the other without: not the same project.
  expect(folderOf(away, MINE, "git@github.com:sam/game.git", HOME)).toBe(false);
  // With Git: the same remote, wherever the folder is; another remote isn't it, even with the name.
  const git = { path: THEIRS, name: "game", remote: "https://github.com/sam/game.git" };
  expect(folderOf(git, "/home/me/src/anything", "git@github.com:sam/game.git", HOME)).toBe(true);
  expect(folderOf(git, MINE, "https://github.com/other/game.git", HOME)).toBe(false);
});

test("projects_listed_twice_fold_into_this_pcs_with_every_chat", () => {
  const s = store();
  s.set("account_ws", "org_me");
  const theirs = s.addRepo(THEIRS);
  s.setProjectPc(theirs, "ts:sam");
  // Sam moved it to this PC's workspace and shared it with Sam's own.
  s.setRepoWorkspace(theirs, "org_me");
  s.setRepoShares(theirs, ["org_sam"]);
  const copy = s.createChat(blankChat({ repoId: theirs, title: "Sam's", role: "lead", home: "ts:sam", homeId: 4 }));
  const hi = s.createChat(blankChat({ repoId: theirs, title: "started in Sam's row", role: "lead" }));
  s.setMainChat(theirs, hi.id);
  const mine = s.addRepo(MINE);
  const lead = s.createChat(blankChat({ repoId: mine, title: "mine", role: "lead" }));
  const sub = s.createChat(blankChat({ repoId: mine, title: "sub", role: "sub", parent: lead.id }));
  s.setMainChat(mine, lead.id);
  // A project of this PC's own whose folder is gone isn't another PC's: left alone.
  const gone = s.addRepo("/home/me/old/game");
  const other = s.addRepo("/home/me/Documents/notes");
  const dirs = here([MINE, "/home/me/Documents/notes"]);
  expect(foldProjects(s, HOME, dirs)).toEqual([[theirs, mine]]);
  // One row: this PC's, its path and folder as they were; every chat is still there, in it.
  const repos = s.repos();
  expect(repos.map((r) => r.id).sort()).toEqual([mine, gone, other].sort());
  expect(repos.find((r) => r.id === mine)).toMatchObject({ path: MINE, local: null });
  expect([copy.id, hi.id, lead.id, sub.id].map((id) => s.chat(id)?.repoId)).toEqual([mine, mine, mine, mine]);
  expect(s.mainChats().get(mine)).toBe(lead.id);
  // Put in this PC's workspace by its PC: it shows as that PC set it (owner and shares).
  expect(s.placement().repos.get(mine)).toBe("org_me");
  expect(s.placement().shared?.repos.get(mine)).toEqual(["org_sam"]);
  // Nothing more to fold the next time.
  expect(foldProjects(s, HOME, dirs)).toEqual([]);
}, SLOW);

test("another_pcs_own_move_doesnt_move_this_pcs_project", () => {
  const s = store();
  s.set("account_ws", "org_me");
  const theirs = s.addRepo(THEIRS);
  s.setProjectPc(theirs, "ts:sam");
  s.setRepoWorkspace(theirs, "org_sam");
  const mine = s.addRepo(MINE);
  expect(foldProjects(s, HOME, here([MINE]))).toEqual([[theirs, mine]]);
  expect(s.placement().repos.get(mine)).toBeUndefined();
  expect(s.placement().shared?.repos.get(mine)).toBeUndefined();
}, SLOW);

test("adding_a_folder_of_another_pcs_project_gives_it_its_folder_here", () => {
  const s = store();
  const theirs = s.addRepo(THEIRS);
  s.setProjectPc(theirs, "ts:sam");
  expect(addFolder(s, MINE, "", HOME, here([MINE]))).toBe(theirs);
  expect(s.repos().find((r) => r.id === theirs)?.local).toBe(MINE);
  expect(s.repos().length).toBe(1);
  // Again: the project it already is.
  expect(addFolder(s, MINE, "", HOME, here([MINE]))).toBe(theirs);
  // Another folder is a project of its own.
  const own = addFolder(s, "/home/me/src/tool", "https://example.com/tool.git", HOME, here([MINE, "/home/me/src/tool"]));
  expect(own).not.toBe(theirs);
  expect(s.repos().find((r) => r.id === own)?.remote).toBe("https://example.com/tool.git");
  // Two projects of other PCs it could be a folder of: neither (no guessing).
  const t = store();
  for (const [p, pc] of [[THEIRS, "ts:sam"], ["/home/ana/Documents/game", "ts:ana"]] as const) t.setProjectPc(t.addRepo(p), pc);
  const made = addFolder(t, MINE, "", HOME, here([MINE]));
  expect(t.repos().find((r) => r.id === made)?.path).toBe(MINE);
}, SLOW);
