import { expect, test } from "bun:test";
import {
  type Place,
  type Role,
  type SidebarChat,
  type Tree,
  type Workspace,
  chatWorkspace,
  inWorkspaces,
  isMainOf,
  moveMenu,
  movedNotice,
  shareLine,
  shareMark,
  shareMenu,
  sharedNotice,
  sharedWith,
  parseSnooze,
  picked,
  reordered,
  sidebarList,
  snoozeLabel,
  snoozePresets,
  snoozePreview,
  toggled,
  tree,
  stepRow,
} from "../src/logic/sidebar.ts";

interface TestChat extends SidebarChat {
  parent: number | null;
  device: string;
}

function chat(id: number, repo: number | null, role: Role, updated: number): TestChat {
  return { id, repoId: repo, title: `chat ${id}`, settled: false, updated, role, parent: null, device: "", home: "" };
}

function place(id: number, snoozed: boolean, main: number | null, chats: number[]): Place {
  return { id, snoozed, main, chats };
}

function emptyTree(t: Partial<Tree>): Tree {
  return { projects: [], threads: [], settled: [], snoozed: [], settledProjects: [], ...t };
}

function only(ws: string): string[] {
  return [ws];
}

function workspaces(ids: string[]): Workspace[] {
  return ids.map((id) => ({ id, name: "" }));
}

/** A lead of PC `home` ("": this one). */
function fromPc(id: number, repo: number | null, home: string): TestChat {
  return { ...chat(id, repo, "lead", id), home };
}

/** This PC ("here") in workspace "a", "ts:b" in "b", "ts:loose" in none. */
function workspaceTree(): [Tree, TestChat[], Map<string, string>] {
  const settled = fromPc(5, 1, "ts:b");
  settled.settled = true;
  const chats = [fromPc(1, 1, ""), fromPc(2, 1, "ts:b"), fromPc(3, null, ""), fromPc(4, null, "ts:loose"), settled, fromPc(6, 2, "")];
  const t = emptyTree({ projects: [place(1, false, null, [1, 2]), place(2, false, 6, [])], threads: [3, 4], settled: [5] });
  return [t, chats, new Map([["ts:b", "b"]])];
}

test("several_workspaces_show_what_each_of_them_has", () => {
  let [t, chats, pcs] = workspaceTree();
  let got = inWorkspaces(t, ["a", "b"], "a", pcs, chats);
  // Both workspaces, and still not the PC in none.
  expect(got).toEqual(emptyTree({ projects: [place(1, false, null, [1, 2]), place(2, false, 6, [])], threads: [3], settled: [5] }));
  [t, chats, pcs] = workspaceTree();
  got = inWorkspaces(t, ["b", "gone"], "a", pcs, chats);
  // This PC's workspace isn't among them.
  expect(got.projects).toEqual([place(1, false, null, [2])]);
});

test("a_moved_chat_or_project_shows_under_the_workspace_it_was_moved_to", () => {
  const [t, chats, pcs] = workspaceTree();
  const sub = { ...chat(7, 1, "sub", 7), parent: 1 };
  const all = [...chats, sub];
  const byId = (id: number) => all.find((c) => c.id === id);
  // Chat 3 (this PC's thread) moved to b; project 2 (this PC's) moved to b; chat 2 (b's PC) moved to a.
  const place = { chats: new Map([[3, "b"], [2, "a"]]), carried: new Map<number, string>(), repos: new Map([[2, "b"]]) };
  // Its own, else its project's, else its PC's; a sub-agent's is its lead's.
  expect(chatWorkspace(byId(3) as TestChat, byId, place, "a", pcs)).toBe("b");
  expect(chatWorkspace(byId(6) as TestChat, byId, place, "a", pcs)).toBe("b");
  expect(chatWorkspace(byId(1) as TestChat, byId, place, "a", pcs)).toBe("a");
  expect(chatWorkspace(sub, byId, { ...place, chats: new Map([[1, "b"]]) }, "a", pcs)).toBe("b");
  // A copy follows its project as its home PC says it (`carried`), not this PC's project.
  expect(chatWorkspace(byId(5) as TestChat, byId, { ...place, carried: new Map([[5, "c"]]), repos: new Map([[1, "a"]]) }, "a", pcs)).toBe("c");
  // Filtered to a, the moved ones leave at once; chat 2 comes in.
  const a = inWorkspaces(t, ["a"], "a", pcs, chats, place);
  expect(a.threads).toEqual([]);
  expect(a.projects).toEqual([place1([1, 2])]);
  // Filtered to b, they're there: project 2 with its main chat, chat 3 among the threads.
  const b = inWorkspaces(t, ["b"], "a", pcs, chats, place);
  expect(b.threads).toEqual([3]);
  expect(b.projects.map((p) => p.id)).toEqual([2]);
  expect(b.settled).toEqual([5]);
});

test("a_shared_chat_or_project_shows_under_its_owner_and_each_workspace_it_is_shared_with", () => {
  const [t, chats, pcs] = workspaceTree();
  const sub = { ...chat(7, 1, "sub", 7), parent: 1 };
  const all = [...chats, sub];
  const byId = (id: number) => all.find((c) => c.id === id);
  // Thread 3 (this PC's, so a's) shared with b; project 2 (a's) shared with c; copy 5 (b's PC) carries its project's share with c; lead 1 shared with d.
  const shared = { chats: new Map([[3, ["b"]], [1, ["d"]], [6, ["e"]]]), carried: new Map([[5, ["c"]]]), repos: new Map([[2, ["c"]]]) };
  const place = { chats: new Map<number, string>(), carried: new Map<number, string>(), repos: new Map<number, string>(), shared };
  // Owner unchanged; shares are extra. A sub-agent's are its lead's; a project's chats get the project's plus their own.
  expect(chatWorkspace(byId(3) as TestChat, byId, place, "a", pcs)).toBe("a");
  expect(sharedWith(sub, byId, place)).toEqual({ all: ["d"], inherited: [] });
  expect(sharedWith(byId(6) as TestChat, byId, place)).toEqual({ all: ["e", "c"], inherited: ["c"] });
  expect(sharedWith(byId(5) as TestChat, byId, place)).toEqual({ all: ["c"], inherited: ["c"] });
  // Under its owner it's still there; under b, the shared thread comes in (with b's own chats).
  expect(inWorkspaces(t, ["a"], "a", pcs, chats, place).threads).toEqual([3]);
  const b = inWorkspaces(t, ["b"], "a", pcs, chats, place);
  expect(b.threads).toEqual([3]);
  expect(b.projects.map((p) => [p.id, p.chats])).toEqual([[1, [2]]]);
  // Under c: project 2 (shared) with its main chat, and the copy that carries its project's share.
  const c = inWorkspaces(t, ["c"], "a", pcs, chats, place);
  expect(c.projects.map((p) => [p.id, p.chats])).toEqual([[2, []]]);
  expect(c.threads).toEqual([]);
  expect(c.settled).toEqual([5]);
  // Under d: lead 1 alone brings its project along (an unsettled lead is there).
  const d = inWorkspaces(t, ["d"], "a", pcs, chats, place);
  expect(d.projects.map((p) => [p.id, p.chats])).toEqual([[1, [1]]]);
  // A move elsewhere keeps the shares: moved to b, thread 3 still shows under b (owner) and not under a.
  const moved = { ...place, chats: new Map([[3, "b"]]) };
  expect(inWorkspaces(t, ["a"], "a", pcs, chats, moved).threads).toEqual([]);
});

test("share_with_workspace_is_a_checklist_with_the_owner_fixed_and_the_projects_shares_locked", () => {
  const all = [{ id: "a", name: "Sam's workspace" }, { id: "b", name: "Team" }, { id: "c", name: "Ops workspace" }];
  expect(shareMenu([], "a", []).why).toMatch(/Sign in/);
  expect(shareMenu(all.slice(0, 1), "a", []).why).toMatch(/one workspace/);
  const m = shareMenu(all, "a", ["b"], ["c"]);
  expect(m.why).toBeNull();
  expect(m.line).toBe("Owned by Sam's workspace · shared with Team, Ops workspace");
  expect(m.items.map((i) => [i.id, i.on, i.owner, i.locked])).toEqual([["a", true, true, false], ["b", true, false, false], ["c", true, false, true]]);
  expect(shareMenu(all, "b", []).line).toBe("Owned by Team · not shared");
  // The owner never counts as a share (one moved to a workspace it was shared with).
  expect(shareLine(all, "b", ["b"])).toBe("Owned by Team · not shared");
  expect(sharedNotice(all, "b", true)).toBe("Shared with Team");
  expect(sharedNotice(all, "b", false)).toBe("No longer shared with Team");
  // The mark: plain when its owner is picked or under All; "here" when it shows only because it's shared.
  expect(shareMark(all, "a", [], ["b"])).toEqual({ shared: "", shared_tip: "" });
  expect(shareMark(all, "a", ["b"], [])).toEqual({ shared: "shared", shared_tip: "Owned by Sam's workspace · shared with Team" });
  expect(shareMark(all, "a", ["b"], ["a", "b"]).shared).toBe("shared");
  expect(shareMark(all, "a", ["b"], ["b"])).toEqual({ shared: "here", shared_tip: "Shown here because it's shared. Owned by Sam's workspace · shared with Team" });
});

function place1(chats: number[]): Place {
  return place(1, false, null, chats);
}

test("move_to_workspace_lists_the_accounts_workspaces_and_the_way_back", () => {
  const all = [{ id: "a", name: "Sam's workspace" }, { id: "b", name: "Team" }];
  expect(moveMenu([], "", "a", "a", "desk").why).toMatch(/Sign in/);
  expect(moveMenu(all.slice(0, 1), "", "a", "a", "desk").why).toMatch(/one workspace/);
  // Where it is ticked; its PC's marked; no way back while it's there.
  const home = moveMenu(all, "", "a", "a", "desk");
  expect(home.why).toBeNull();
  expect(home.items).toEqual([
    { id: "", to: "a", label: "Sam's workspace", hint: "desk's workspace", on: true, back: false },
    { id: "b", to: "b", label: "Team", hint: "", on: false, back: false },
  ]);
  // Moved: the way back clears its own.
  const moved = moveMenu(all, "b", "a", "a", "desk");
  expect(moved.items.map((i) => [i.label, i.on, i.id])).toEqual([["Sam's workspace", false, ""], ["Team", true, "b"], ["Back to Sam's workspace", false, ""]]);
  // In a moved project: back to its PC's is a workspace of its own.
  expect(moveMenu(all, "", "b", "a", "desk").items.at(-1)).toEqual({ id: "a", to: "a", label: "Back to Sam's workspace", hint: "Where its PC is", on: false, back: true });
  expect(movedNotice(all, "a")).toBe("Moved to Sam's workspace");
  expect(movedNotice(all, "b")).toBe("Moved to the workspace Team");
});

test("the_picked_workspaces_drop_what_is_gone", () => {
  const all = workspaces(["a", "b", "c"]);
  expect(picked("", all)).toEqual([]);
  expect(picked("a", all)).toEqual(["a"]);
  expect(picked("c,a", all)).toEqual(["a", "c"]);
  // An id that's gone drops out.
  expect(picked("a,left", all)).toEqual(["a"]);
  // None left: All.
  expect(picked("left,gone", all)).toEqual([]);
  // Every one isn't All.
  expect(picked("a,b,c", all)).toEqual(["a", "b", "c"]);
  // The only one left stays picked.
  expect(picked("a,left", workspaces(["a"]))).toEqual(["a"]);
  // Signed out.
  expect(picked("a", [])).toEqual([]);
});

test("toggling_a_workspace_follows_the_checklist", () => {
  const all = workspaces(["a", "b", "c"]);
  // From All, only the one checked.
  expect(toggled("", "b", all)).toBe("b");
  // One more.
  expect(toggled("b", "a", all)).toBe("a,b");
  // Checking every one stays every one.
  expect(toggled("a,b", "c", all)).toBe("a,b,c");
  // Unchecking one.
  expect(toggled("a,b", "a", all)).toBe("b");
  // Unchecking the last goes back to All.
  expect(toggled("b", "b", all)).toBe("");
  // Ids that are gone don't stay.
  expect(toggled("a,left", "b", all)).toBe("a,b");
  // An account's only workspace can be picked, and unpicked back to All.
  expect(toggled("", "a", workspaces(["a"]))).toBe("a");
  expect(toggled("a", "a", workspaces(["a"]))).toBe("");
});

test("a_workspace_shows_its_pcs_chats_and_projects", () => {
  const [t, chats, pcs] = workspaceTree();
  const want = emptyTree({ projects: [place(1, false, null, [1]), place(2, false, 6, [])], threads: [3] });
  // This PC's own: its projects, without other PCs' chats.
  expect(inWorkspaces(t, only("a"), "a", pcs, chats)).toEqual(want);
});

test("another_workspace_keeps_only_the_projects_it_has_chats_in", () => {
  const [t, chats, pcs] = workspaceTree();
  expect(inWorkspaces(t, only("b"), "a", pcs, chats)).toEqual(emptyTree({ projects: [place(1, false, null, [2])], settled: [5] }));
});

test("a_settled_chat_alone_keeps_no_project_in_a_workspace", () => {
  const settled = fromPc(1, 1, "ts:b");
  settled.settled = true;
  const t = emptyTree({ projects: [place(1, false, null, [])], settled: [1] });
  const got = inWorkspaces(t, only("b"), "a", new Map([["ts:b", "b"]]), [settled]);
  expect(got).toEqual(emptyTree({ settled: [1] }));
});

test("a_snoozed_chat_keeps_its_project_in_its_workspace", () => {
  const t = emptyTree({ projects: [place(1, false, null, [])], snoozed: [2, 3] });
  const chats = [fromPc(2, 1, "ts:b"), fromPc(3, 1, "")];
  const got = inWorkspaces(t, only("b"), "a", new Map([["ts:b", "b"]]), chats);
  expect(got).toEqual(emptyTree({ projects: [place(1, false, null, [])], snoozed: [2] }));
});

test("chats_of_no_workspace_show_only_under_all", () => {
  // A PC the directory doesn't list, and this PC while it's in none.
  let [t, chats, pcs] = workspaceTree();
  const got = inWorkspaces(t, only("b"), "", pcs, chats);
  expect(got.threads).toEqual([]);
  expect(got.projects).toEqual([place(1, false, null, [2])]);
  [t, chats, pcs] = workspaceTree();
  expect(inWorkspaces(t, only("a"), "a", pcs, chats).threads.includes(4)).toBe(false);
});

function none(): Map<number, number> {
  return new Map();
}

test("every_open_lead_is_a_sibling_row_of_its_project", () => {
  // The reported case: older chats settled, so the oldest open lead (once the project
  // row's hidden "main" chat) must still get its own row, beside a newer lead.
  const old = chat(1, 6, "lead", 10);
  old.settled = true;
  const oldestOpen = chat(2, 6, "lead", 20);
  const sub = chat(3, 6, "sub", 40);
  sub.parent = 2;
  const remote = chat(4, 6, "lead", 30);
  remote.device = "ssh:1";
  const sub2 = chat(5, 6, "sub", 50);
  sub2.parent = 4;
  const t = tree([6], [old, oldestOpen, sub, remote, sub2], none(), () => false);
  expect(t.projects).toEqual([place(6, false, null, [4, 2])]);
  expect(t.threads).toEqual([]);
  expect(t.settled).toEqual([1]);
});

test("the_main_chat_is_the_project_row_and_stays_put", () => {
  const chats = [chat(1, 6, "lead", 10), chat(2, 6, "lead", 20), chat(3, 6, "lead", 30)];
  const mains = new Map([[6, 1]]);
  // The oldest is main: not a row of its own, whatever the others do.
  let t = tree([6], chats, mains, () => false);
  expect(t.projects).toEqual([place(6, false, 1, [3, 2])]);
  // Others settling or snoozing don't change it.
  const settled = chats.map((c) => ({ ...c }));
  const second = settled[1];
  if (second) second.settled = true;
  t = tree([6], settled, mains, (k) => k === "c3");
  expect(t.projects).toEqual([place(6, false, 1, [])]);
  expect([t.settled, t.snoozed]).toEqual([[2], [3]]);
  // Snoozed itself, it's still the project row.
  t = tree([6], chats, mains, (k) => k === "c1");
  expect(t.projects[0]?.main).toBe(1);
  expect(t.snoozed).toEqual([]);
});

test("a_main_chat_that_no_longer_qualifies_is_none", () => {
  const settled = chat(1, 6, "lead", 10);
  settled.settled = true;
  const moved = chat(2, 7, "lead", 20);
  const sub = chat(3, 8, "sub", 30);
  sub.parent = 2;
  const mains = new Map([
    [6, 1],
    [7, 9],
    [8, 3],
    [9, 2],
  ]);
  const t = tree([6, 7, 8, 9], [settled, moved, sub], mains, () => false);
  // Settled: in Settled, and its project has no main chat (the next message starts one).
  expect(t.settled).toEqual([1]);
  expect(t.projects.map((p) => p.main)).toEqual([null, null, null, null]);
  // Moved to project 7: a row there, not 9's main chat; a deleted one (9) or a sub-agent is none.
  expect(t.projects[1]?.chats).toEqual([2]);
  expect(isMainOf(chat(5, 6, "lead", 1), 6)).toBe(true);
  expect(isMainOf(chat(5, null, "lead", 1), 6)).toBe(false);
  expect(isMainOf(null, 6)).toBe(false);
});

test("loose_unknown_and_settled_chats", () => {
  const settledLoose = chat(4, null, "lead", 5);
  settledLoose.settled = true;
  const chats = [
    chat(1, null, "lead", 1),
    // A project this PC doesn't have (another PC's chat, a removed project): Threads, not lost.
    chat(2, 99, "lead", 2),
    chat(3, 7, "lead", 3),
    settledLoose,
    chat(5, 7, "chat", 9),
  ];
  const t = tree([7, 8], chats, none(), () => false);
  expect(t.projects).toEqual([place(7, false, null, [3]), place(8, false, null, [])]);
  expect(t.threads).toEqual([2, 1]);
  expect(t.settled).toEqual([4]);
});

test("snoozed_chats_and_projects", () => {
  const chats = [chat(1, 7, "lead", 1), chat(2, 7, "lead", 2), chat(3, 8, "lead", 3)];
  const t = tree([7, 8], chats, none(), (k) => k === "c2" || k === "r8");
  expect(t.projects).toEqual([place(7, false, null, [1]), place(8, true, null, [3])]);
  // Out of its project, kept apart for a search.
  expect(t.snoozed).toEqual([2]);
});

test("same_update_time_orders_newest_id_first", () => {
  const t = tree([7], [chat(1, 7, "lead", 5), chat(2, 7, "lead", 5)], none(), () => false);
  expect(t.projects[0]?.chats).toEqual([2, 1]);
});

/** Wednesday 2026-10-28 14:20:00 UTC. */
const NOW = 1_793_197_200;
const H = 3600;

const after = (s: string, off = 0) => {
  const t = parseSnooze(s, NOW, off);
  return t === null ? null : t - NOW;
};

test("snooze_durations", () => {
  expect(after("5h")).toBe(5 * H);
  expect(after("90m")).toBe(90 * 60);
  expect(after("1h30m")).toBe(90 * 60);
  expect(after("1h30")).toBe(90 * 60);
  expect(after("1.5h")).toBe(90 * 60);
  expect(after("2d")).toBe(48 * H);
  expect(after("1w")).toBe(7 * 24 * H);
  expect(after("1d12h")).toBe(36 * H);
  expect(after("3")).toBe(3 * H);
  expect(after(" 2 H 15 min ")).toBe(2 * H + 15 * 60);
  expect(after("45 minutes")).toBe(45 * 60);
  expect(after("in 5h")).toBe(5 * H);
  expect(after("365d")).toBe(365 * 24 * H);
  expect(after("1m")).toBe(60);
});

test("snooze_clock_times_are_the_next_one", () => {
  // Still ahead today.
  expect(after("18:00")).toBe(3 * H + 40 * 60);
  expect(after("6pm")).toBe(3 * H + 40 * 60);
  expect(after("6:30 PM")).toBe(4 * H + 10 * 60);
  expect(after("at 16")).toBe(H + 40 * 60);
  expect(after("14:21")).toBe(60);
  // Gone today: tomorrow.
  expect(after("9:30")).toBe(19 * H + 10 * 60);
  expect(after("9am")).toBe(18 * H + 40 * 60);
  expect(after("14:20")).toBe(24 * H);
  expect(after("12pm")).toBe(21 * H + 40 * 60);
  expect(after("12am")).toBe(9 * H + 40 * 60);
  expect(after("0:00")).toBe(9 * H + 40 * 60);
  // Local time three hours behind UTC: it's 11:20 there.
  expect(after("18:00", -3 * H)).toBe(6 * H + 40 * 60);
  expect(after("9:00", -3 * H)).toBe(21 * H + 40 * 60);
  // ... and five and a half ahead: 19:50.
  expect(after("19:00", 5 * H + 1800)).toBe(23 * H + 10 * 60);
});

test("snooze_text_that_is_no_time", () => {
  for (const s of ["", "  ", "abc", "h", "5x", "0", "0h", "0.5m", "-5h", "30s", "366d", "53w", "2y", "1.2.3h", "5h-", "1d30", "25:00", "18:60", "18:5", "13pm", "0am", "18:00pm", "at", "at 5h", "+5h"]) {
    expect([s, parseSnooze(s, NOW, 0)]).toEqual([s, null]);
  }
});

test("snooze_presets_and_preview", () => {
  const p = snoozePresets(NOW, 0).map(([l, u]) => [l, u - NOW]);
  expect(p).toEqual([
    ["1 hour", H],
    ["3 hours", 3 * H],
    ["Tomorrow, 9:00", 18 * H + 40 * 60],
    ["Next week", 6 * 24 * H + 18 * H + 40 * 60],
  ]);
  // Three hours behind UTC it's 11:20: tomorrow 9:00 there is 21:40 away.
  expect((snoozePresets(NOW, -3 * H)[2]?.[1] ?? 0) - NOW).toBe(21 * H + 40 * 60);
  expect(snoozePreview("5h", NOW, 0)).toEqual([NOW + 5 * H, "until Today, 19:20"]);
  expect(snoozePreview("5hx", NOW, 0)).toEqual([null, "Try 5h, 1h30m, 2d or 18:00"]);
  expect(snoozePreview("  ", NOW, 0)).toEqual([null, ""]);
});

test("snooze_labels", () => {
  const l = (until: number) => snoozeLabel(until, NOW, 0);
  expect(l(NOW + H)).toBe("Today, 15:20");
  expect(l(NOW + 9 * H + 39 * 60)).toBe("Today, 23:59");
  expect(l(NOW + 9 * H + 40 * 60)).toBe("Tomorrow, 0:00");
  expect(l(NOW + 18 * H + 40 * 60)).toBe("Tomorrow, 9:00");
  expect(l(NOW + 3 * 24 * H)).toBe("Sat, 14:20");
  expect(l(NOW + 10 * 24 * H)).toBe("Sat 7 Nov, 14:20");
  // Local time: 11:20 three hours behind UTC, so 22:20 is still today there.
  expect(snoozeLabel(NOW + 11 * H, NOW, -3 * H)).toBe("Today, 22:20");
});

test("a dragged project lands above or below the row it's dropped on", () => {
  expect(reordered([1, 2, 3, 4], 1, 3, true)).toEqual([2, 1, 3, 4]);
  expect(reordered([1, 2, 3, 4], 1, 3, false)).toEqual([2, 3, 1, 4]);
  expect(reordered([1, 2, 3, 4], 4, 1, true)).toEqual([4, 1, 2, 3]);
  expect(reordered([1, 2, 3, 4], 4, 2, false)).toEqual([1, 2, 4, 3]);
  expect(reordered([1, 2, 3], 2, 9, true)).toEqual([1, 2, 3]);
});

test("a_settled_project_and_every_chat_of_it_are_under_settled", () => {
  // Chat 3 is another PC's copy, still unsettled: it goes with its project all the same.
  const chats = [chat(1, 6, "lead", 10), chat(2, 7, "lead", 20), chat(3, 6, "lead", 30)];
  const t = tree([6, 7], chats, new Map([[6, 1]]), () => false, new Set([6]));
  expect(t.projects).toEqual([place(7, false, null, [2])]);
  expect(t.settledProjects).toEqual([6]);
  expect(t.settled).toEqual([3, 1]);
  const list = sidebarList(t, chats, [{ id: 6, name: "alpha", path: "/a" }, { id: 7, name: "beta", path: "/b" }] as never, "");
  expect(list.settledProjects.map((r: { name: string }) => r.name)).toEqual(["alpha"]);
  expect(sidebarList(t, chats, [{ id: 6, name: "alpha", path: "/a" }] as never, "zzz").settledProjects).toEqual([]);
});

test("alt_up_down_step_through_the_sidebar_rows_in_order", () => {
  const row = (kind: string, id: number, active = false) => ({ kind, id, active });
  const rows = [row("project", 1), row("thread", 10), row("thread", 11), row("project", 2), row("label", 0), row("loose", 20), row("loose", 21)];
  const at = (i: number) => rows.map((r, j) => ({ ...r, active: j === i }));
  const step = (i: number, dir: 1 | -1) => {
    const r = stepRow(at(i), dir);
    return r === null ? null : `${r.kind}:${r.id}`;
  };
  // Down and up one row at a time, project rows (their main chat) included, the "Threads" label skipped.
  expect(step(0, 1)).toBe("thread:10");
  expect(step(2, 1)).toBe("project:2");
  expect(step(3, 1)).toBe("loose:20");
  expect(step(5, -1)).toBe("project:2");
  expect(step(1, -1)).toBe("project:1");
  // No wrap-around at either end.
  expect(step(0, -1)).toBeNull();
  expect(step(6, 1)).toBeNull();
  // Nothing open (a new chat, Settings): Down goes to the first row, Up to the last.
  expect(stepRow(rows, 1)?.id).toBe(1);
  expect(stepRow(rows, -1)?.id).toBe(21);
  // Settled rows, passed only while that section is open, come after the others.
  const withSettled = [...at(6), row("settled-project", 3), row("loose", 30)];
  expect(stepRow(withSettled, 1)?.kind).toBe("settled-project");
  expect(stepRow([...rows, row("loose", 30, true)], -1)?.id).toBe(21);
  expect(stepRow([], 1)).toBeNull();
  expect(stepRow([row("label", 0)], -1)).toBeNull();
});
