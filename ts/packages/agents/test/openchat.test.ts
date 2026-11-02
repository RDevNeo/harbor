import { expect, test } from "bun:test";
import type { Chat, Repo } from "@harbor/store";
import * as oc from "../src/openchat.ts";

const repo = (id: number, name: string, path: string): Repo => ({ id, name, path, sort: 0, remote: "", local: null });

function chat(id: number, title: string, gid: string, over: Partial<Chat> = {}): Chat {
  return {
    id,
    repoId: 1,
    title,
    sessionId: "",
    started: false,
    account: "claude",
    model: "",
    effort: "",
    access: "full",
    settled: false,
    updated: 0,
    role: "lead",
    parent: null,
    name: "lead",
    device: "",
    gid,
    home: "",
    homeId: 0,
    retired: false,
    ...over,
  };
}

test("finds_projects_by_path_name_or_folder", () => {
  const repos = [repo(1, "harbor", "/home/u/Projects/harbor"), repo(2, "Site", "/home/u/work/web-site")];
  expect(oc.findProject(repos, "/home/u/Projects/harbor/")).toBe(1);
  expect(oc.findProject(repos, "site")).toBe(2);
  expect(oc.findProject(repos, "web-site")).toBe(2);
  expect(oc.findProject(repos, "nope")).toBeNull();
});

test("finds_chats_by_id_gid_or_title", () => {
  const chats = [chat(4, "Fix login", "g-a"), chat(7, "Docs", "g-b")];
  expect(oc.findChat(chats, "7")?.id).toBe(7);
  expect(oc.findChat(chats, "#4")?.id).toBe(4);
  expect(oc.findChat(chats, "g-b")?.id).toBe(7);
  expect(oc.findChat(chats, "“fix login”")?.id).toBe(4);
  expect(oc.findChat(chats, "9")).toBeUndefined();
});

test("finds_chats_by_title_words_or_agent_name", () => {
  const chats = [chat(4, "Fix login page", "g-a", { updated: 5 }), chat(7, "Docs pass", "g-b"), chat(9, "Write the login tests", "g-c", { role: "sub", parent: 4, name: "tests", updated: 9 })];
  const ids = (q: string): number[] => oc.matching(chats, q, () => true).map((c) => c.id);
  // Most recent first, sub-agents too.
  expect(ids("login")).toEqual([9, 4]);
  // A sub-agent matches its lead's title too.
  expect(ids("LOGIN fix")).toEqual([9, 4]);
  expect(ids("tests")).toEqual([9]);
  expect(ids("docs")).toEqual([7]);
  expect(ids("nothing here")).toEqual([]);
  expect(ids("").length).toBe(3);
  expect(oc.matching(chats, "login", (c) => c.id !== 9).map((c) => c.id)).toEqual([4]);
});

test("opened_chats_link_back_on_both_sides", () => {
  expect(oc.openedBy("Fix login")).toBe("Opened by the agent of “Fix login”");
  expect(`${oc.LINK}g-a`).toBe("harbor:gid/g-a");
});

test("the_agent_learns_who_opened_it", () => {
  const p = oc.preamble(chat(4, "Fix login", "g"));
  expect(p).toContain("“Fix login” (id 4)");
  expect(p).toContain("message_chat");
});
