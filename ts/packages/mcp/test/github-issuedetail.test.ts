import { expect, test } from "bun:test";
import type { Dest } from "../src/ghapi.ts";
import type { GhRun, MeshHttp } from "../src/github/gh.ts";
import { FIELDS, fetch, fetchOn, fetchRaw, parse, repoOf, setOpenOn, stateOf } from "../src/github/issuedetail.ts";

const view = {
  number: 3, title: "T", body: "b", url: "https://github.com/o/r/issues/3", state: "CLOSED", stateReason: "COMPLETED",
  author: { login: "a" }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z",
  labels: [{ name: "bug", color: "00ff00" }], assignees: [{ login: "b" }], milestone: { title: "v1" },
  comments: [{ author: { login: "c" }, body: "hi", createdAt: "2026-01-01T12:00:00Z" }],
};

const desk: Dest = { id: "peer-1" };

test("view_json", () => {
  const f = parse(view);
  expect(f.state).toBe("done");
  expect(f.labels[0]).toEqual(["bug", [0, 255, 0]]);
  expect([f.assignees, f.milestone]).toEqual([["b"], "v1"]);
  expect(f.comments[0]?.author).toBe("c");
  expect(repoOf(f.url)).toBe("o/r");
  expect(parse({ milestone: null }).milestone).toBeNull();
});

test("the rest of an issue view", () => {
  const f = parse(view);
  expect([f.number, f.title, f.body, f.author, f.created, f.updated]).toEqual([3, "T", "b", "a", 1_767_225_600, 1_767_225_600 + 86_400]);
  expect(f.comments[0]).toEqual({ author: "c", at: 1_767_225_600 + 43_200, body: "hi" });
  expect(parse({ milestone: { title: "" } }).milestone).toBeNull();
  const bare = parse({});
  expect([bare.number, bare.author, bare.state, bare.labels, bare.assignees, bare.comments]).toEqual([0, "ghost", "done", [], [], []]);
  expect(parse({ body: "<p>x</p>", assignees: [{ name: "Bot" }, {}] }).assignees).toEqual(["Bot", "ghost"]);
});

test("open, done and not planned", () => {
  expect(stateOf("OPEN", "")).toBe("open");
  expect(stateOf("open", "COMPLETED")).toBe("open");
  expect(stateOf("CLOSED", "COMPLETED")).toBe("done");
  expect(stateOf("CLOSED", "")).toBe("done");
  expect(stateOf("CLOSED", "NOT_PLANNED")).toBe("not_planned");
  expect(stateOf("closed", "duplicate")).toBe("not_planned");
  expect(parse({ state: "OPEN" }).state).toBe("open");
});

test("fetch and fetchRaw run gh issue view", async () => {
  const calls: string[][] = [];
  const run: GhRun = async (args) => {
    calls.push(args);
    return { code: 0, stdout: JSON.stringify(view), stderr: "" };
  };
  expect((await fetch("https://github.com/o/r/issues/3", run)).number).toBe(3);
  expect(await fetchRaw("https://github.com/o/r/issues/3", run)).toEqual(view);
  expect(calls[0]).toEqual(["issue", "view", "https://github.com/o/r/issues/3", "--json", FIELDS]);
  const bad: GhRun = async () => ({ code: 1, stdout: "", stderr: "Could not resolve to an Issue\n" });
  expect(await fetch("u", bad).then(() => "no error", (e: Error) => e.message)).toBe("Could not resolve to an Issue");
});

test("fetchOn asks the other PC and reads its answer", async () => {
  const seen: unknown[][] = [];
  const http: MeshHttp = async (dest, method, path, body, waitMs) => {
    seen.push([dest, method, path, body, waitMs]);
    return [200, view];
  };
  const f = await fetchOn(http, desk, "https://github.com/o/r/issues/3?x=a b&y");
  expect(f.title).toBe("T");
  expect(seen).toEqual([[desk, "GET", "/mesh/v1/issues/view?url=https%3A%2F%2Fgithub.com%2Fo%2Fr%2Fissues%2F3%3Fx%3Da%20b%26y", undefined, 90_000]]);
});

test("the other PC's refusal comes back as the error", async () => {
  const answer = (status: number, body: unknown): MeshHttp => async () => [status, body];
  const msg = (p: Promise<unknown>): Promise<string> => p.then(() => "no error", (e: Error) => e.message);
  expect(await msg(fetchOn(answer(502, { error: "gh: not signed in" }), desk, "u"))).toBe("gh: not signed in");
  expect(await msg(fetchOn(answer(404, "not json"), desk, "u"))).toBe("the other PC answered 404");
  expect(await msg(setOpenOn(answer(409, { error: "no" }), desk, "u", false))).toBe("no");
  expect(await msg(setOpenOn(answer(500, null), desk, "u", true))).toBe("the other PC answered 500");
  const down: MeshHttp = async () => {
    throw new Error("unreachable");
  };
  expect(await msg(fetchOn(down, desk, "u"))).toBe("unreachable");
});

test("setOpenOn posts close or reopen to the other PC", async () => {
  const seen: unknown[][] = [];
  const http: MeshHttp = async (_dest, method, path, body, waitMs) => {
    seen.push([method, path, body, waitMs]);
    return [200, { ok: true }];
  };
  await setOpenOn(http, desk, "https://github.com/o/r/issues/3", false);
  await setOpenOn(http, desk, "https://github.com/o/r/issues/3", true);
  const url = "?url=https%3A%2F%2Fgithub.com%2Fo%2Fr%2Fissues%2F3";
  expect(seen).toEqual([["POST", `/mesh/v1/issues/close${url}`, {}, 90_000], ["POST", `/mesh/v1/issues/reopen${url}`, {}, 90_000]]);
});
