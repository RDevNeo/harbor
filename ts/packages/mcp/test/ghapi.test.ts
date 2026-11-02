import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  type Call, type DiffLine, type GhDeps, type Issue, type IssueFetched, type IssueFilters, type Peer, type Pr, type PrFetched, type PrFilters, type Reply, type Source,
  GhApi, NOT_PROJECT, allProjects, diffJson, ghUrl, issueFilters, issueMeshJson, issueOfJson, prFilters, prsPage,
} from "../src/ghapi.ts";

const call = (q: [string, string][] = [], over: Partial<Call> = {}): Call => ({ method: "GET", path: ["v1", "prs"], query: q, body: null, token: "", device: "", global: false, ...over });

const defaultPrFilters: PrFilters = { state: "open", involvement: "all", labels: [] };

test("project_filter_lists_every_pcs_projects: the project filter lists every pc's projects", () => {
  const src = (pc: string, name: string, projects: string[]): Source => ({ pc, name, login: "x", projects });
  const d: IssueFetched = { viewer: "", items: [], sources: [src("", "desk", ["o/r"]), src("ts:lap", "laptop", ["o/r", "o/crm"])] };
  const otherProjects = (data: IssueFetched, local: string[]): [string, string, string][] => {
    const found = data.sources.filter((s) => s.pc !== "").flatMap((s) => s.projects.filter((r) => !local.includes(r)).map((r): [string, string, string] => [r.split("/").pop() ?? r, r, s.name]));
    return found;
  };
  const v = allProjects({ otherProjects }, [{ id: 1, name: "r", repo: "o/r" }], d);
  expect(v).toEqual([
    { id: 1, name: "r", repo: "o/r", pc: "desk, laptop" },
    { name: "crm", repo: "o/crm", pc: "laptop" },
  ]);
});

test("only_github_pages_reach_gh: only github pages reach gh", () => {
  expect(ghUrl("https://github.com/o/r/pull/12", "pull")).toBeDefined();
  expect(ghUrl(" https://github.com/my-org/repo.rs/issues/3 ", "issues")).toBe("https://github.com/my-org/repo.rs/issues/3");
  for (const bad of ["--help", "https://github.com/o/r/pull/12/files", "https://evil.example/o/r/pull/1", "https://github.com/o/r/issues/1", "https://github.com/../r/pull/1", "https://github.com/o/r/pull/1a"]) {
    expect(ghUrl(bad, "pull")).toBeUndefined();
  }
});

test("filters_from_the_query: filters from the query", () => {
  const a = prFilters(call([["state", "merged"], ["involvement", "authored"], ["label", "bug"], ["label", "ui"], ["draft", "hide"], ["review", "approved"], ["checks", "failing"], ["project", "o/r"], ["sort", "largest"], ["q", "fix"]]));
  expect(a.filters).toEqual({ state: "merged", involvement: "authored", labels: ["bug", "ui"], draft: false, review: "approved", checks: "failing", project: "o/r" });
  expect([a.sort, a.search]).toEqual(["largest", "fix"]);
  const none = prFilters(call());
  expect(none.filters).toEqual(defaultPrFilters);
  expect(none.sort).toBe("ready");
  const b = issueFilters(call([["state", "closed"], ["assignee", "none"], ["milestone", "none"], ["sort", "most_commented"]]));
  expect(b.filters.state).toBe("closed");
  expect(b.filters.assignee).toEqual({ kind: "nobody" });
  expect(b.filters.milestone).toBeNull();
  expect(b.sort).toBe("most_commented");
  const c = issueFilters(call([["assignee", "me"], ["milestone", "v1"]]));
  expect(c.filters.assignee).toEqual({ kind: "login", login: "me" });
  expect(c.filters.milestone).toBe("v1");
  expect(issueFilters(call()).filters.milestone).toBeUndefined();
});

const pr = (over: Partial<Pr> = {}): Pr => ({
  number: 7, title: "Fix it", url: "https://github.com/o/r/pull/7", repo: "o/r", state: "open", draft: false, adds: 3, dels: 1, created: 10, updated: 20,
  branch: "fix", head: "abc", review: "approved", checks: "passing", conflicting: false, author: "me", avatar: "", labels: [["bug", [255, 0, 16]]], review_requested: false, ...over,
});

const prsPort = (fetched: PrFetched[], failWith?: string): GhDeps["prs"] => ({
  fetch: async () => {
    if (failWith) throw new Error(failWith);
    fetched.push({ viewer: "me", items: [pr()] });
    return fetched[fetched.length - 1] as PrFetched;
  },
  groups: (d) => [{ key: "authored", label: "Authored", items: d.items }],
  authors: (d) => [["me", d.items.length]],
  labels: (d) => d.items.flatMap((p) => p.labels).map(([n, c]) => [n, c, 1]),
  sortLabel: (s) => (s === "ready" ? "Merge readiness" : s),
});

test("pages_on_the_wire: pages on the wire", () => {
  const v = prsPage(prsPort([]), { viewer: "me", items: [pr()] }, defaultPrFilters, "", "ready") as { groups: { key: string; items: Record<string, unknown>[] }[]; labels: { n: number }[]; sorts: unknown[] };
  expect(v.groups[0]?.key).toBe("authored");
  const p = v.groups[0]?.items[0];
  expect([p?.state, p?.review, p?.checks, p?.updated_ms]).toEqual(["open", "approved", "passing", 20_000]);
  expect(p?.labels).toEqual([{ name: "bug", color: "ff0010" }]);
  expect(v.labels[0]?.n).toBe(1);
  expect(v.sorts[0]).toEqual({ id: "ready", label: "Merge readiness" });
  const parse = (d: string): DiffLine[] => {
    expect(d).toContain("diff --git");
    return [{ t: "file", path: "x", adds: 1, dels: 1 }, { t: "hunk", text: "@@ -1 +1 @@" }, { t: "del", text: "a" }, { t: "add", text: "b" }];
  };
  const d = diffJson(parse, "diff --git a/x b/x\n") as { lines: unknown[]; clipped: boolean };
  expect(d.lines[0]).toEqual({ t: "file", text: "x", adds: 1, dels: 1 });
  expect(d.lines.length).toBe(4);
  expect(d.clipped).toBe(false);
  const many = (): DiffLine[] => Array.from({ length: 5001 }, () => ({ t: "ctx", text: "c" }));
  const big = diffJson(many, "") as { lines: unknown[]; clipped: boolean };
  expect([big.lines.length, big.clipped]).toEqual([5000, true]);
});

const issue = (over: Partial<Issue> = {}): Issue => ({
  number: 3, title: "Broken", url: "https://github.com/o/r/issues/3", repo: "o/r", state: "open", created: 100, updated: 200, comments: 2, author: "ana", avatar: "a.png",
  labels: [["bug", [1, 2, 3]]], assignees: ["me"], milestone: "v1", mentions: ["me"], accounts: ["me"], linked_pr: true, author_trusted: true, ...over,
});

test("an issue survives the trip between two pcs", () => {
  const wire = JSON.parse(JSON.stringify(issueMeshJson(issue()))) as unknown;
  expect(issueOfJson(wire, "me")).toEqual(issue({ created: 100, updated: 200 }));
  expect(issueOfJson(wire, "")).toEqual(issue({ mentions: [], accounts: [] }));
  expect(issueOfJson({ ...(wire as object), url: "https://evil.example/o/r/issues/3" }, "me")).toBeUndefined();
  expect(issueOfJson({ title: "no number", url: "https://github.com/o/r/issues/3" }, "me")).toBeUndefined();
});

interface Rig {
  api: GhApi;
  deps: GhDeps;
  localRepos: string[];
  now: { t: number };
  ghCalls: string[][];
  issueFetches: number;
  forwarded: { peer: string; path: string[]; body: unknown; sender: [string, string] }[];
  started: unknown[];
  prFetched: PrFetched[];
  mesh: { peers: Peer[]; on: boolean };
  projectOf: Map<string, number>;
  ownError: string | undefined;
  peerBodies: Map<string, { status: number; body: unknown }>;
}

let peerServer: ReturnType<typeof Bun.serve>;
const peerHits: string[] = [];

beforeAll(() => {
  peerServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      peerHits.push(url.pathname + url.search);
      if (url.searchParams.get("state") === "closed") return Response.json({ error: "gh auth login needed" }, { status: 500 });
      return Response.json({ login: "bo", projects: ["o/crm"], items: [issueMeshJson(issue({ number: 9, url: "https://github.com/o/crm/issues/9", repo: "o/crm", accounts: [], mentions: [] })), { number: "bad" }] });
    },
  });
});

afterAll(() => peerServer.stop(true));

const issueFetchedOf = (items: Issue[]): IssueFetched => ({ viewer: "me", items, sources: [] });

function rig(): Rig {
  const r: Rig = {
    api: undefined as unknown as GhApi,
    deps: undefined as unknown as GhDeps,
    localRepos: [],
    now: { t: 1_000_000 },
    ghCalls: [],
    issueFetches: 0,
    forwarded: [],
    started: [],
    prFetched: [],
    mesh: { peers: [], on: true },
    projectOf: new Map(),
    ownError: undefined,
    peerBodies: new Map(),
  };
  const sources = (parts: [Source, IssueFetched | undefined][]): Source[] => parts.map(([s, f]) => ({ ...s, login: s.login || f?.viewer || "" }));
  const deps: GhDeps = {
    prs: prsPort(r.prFetched),
    issues: {
      fetch: async () => {
        r.issueFetches++;
        if (r.ownError) throw new Error(r.ownError);
        return issueFetchedOf([issue()]);
      },
      groups: (d) => [{ key: "assigned", label: "Assigned", items: d.items }],
      mine: (d) => d.sources.map((s) => s.login).filter((l) => l !== ""),
      accounts: () => [],
      notes: (d) => d.sources.flatMap((s) => (s.error ? [`${s.name}: ${s.error}`] : [])),
      authors: () => [],
      assignees: () => [],
      milestones: () => [],
      labels: () => [],
      otherProjects: () => [],
      owner: (d, i, prefer, project) => d.sources.find((s) => s.error === undefined && (project ? s.projects.includes(i.repo) : s.login !== "")) ?? (prefer ? undefined : undefined),
      merge: (parts) => {
        const items: Issue[] = [];
        for (const [, f] of parts) for (const i of f?.items ?? []) if (!items.some((x) => x.url === i.url)) items.push(i);
        return { viewer: parts[0]?.[1]?.viewer ?? "", items, sources: sources(parts) };
      },
      shortError: (e) => (e.includes("auth login") ? "GitHub not connected" : (e.split("\n")[0] ?? "")),
      sortLabel: (s) => s,
    },
    details: {
      fetchPr: async (url) => ({
        number: 7, title: "Fix", url, state: "OPEN", draft: false, author: "me", created: 1, updated: 2, base: "main", head: "fix", adds: 1, dels: 0, files: 1, labels: [], reviewers: [["bo", "APPROVED"]],
        body: "**hi**", checks: [{ name: "ci", state: "pass", url: "u" }], comments: [{ author: "bo", at: 3, body: "ok" }], conflicting: false,
        timeline: [[1, "me", { kind: "opened" }], [2, "me", { kind: "commit", sha: "abc", headline: "h" }], [3, "bo", { kind: "review", state: "APPROVED", body: "lgtm" }]],
      }),
      fetchIssue: async (url) => ({ number: 3, title: "Broken", url, state: "open", author: "ana", created: 1, updated: 2, labels: [], assignees: [], milestone: null, body: "b", comments: [] }),
      fetchIssueRaw: async () => ({ raw: true }),
      fetchIssueOn: async (_d, url) => ({ number: 3, title: "From peer", url, state: "open", author: "ana", created: 1, updated: 2, labels: [], assignees: [], milestone: null, body: "b", comments: [] }),
      setIssueOpenOn: async (_d, url, open) => {
        r.ghCalls.push(["peer", open ? "reopen" : "close", url]);
      },
      gh: async (args) => {
        r.ghCalls.push(args);
        if (args[0] === "pr" && args[1] === "diff") return "diff --git a/x b/x";
        if (args.includes("https://github.com/o/r/issues/404")) throw new Error("gh: not found");
        return "";
      },
      parseDiff: () => [{ t: "ctx", text: "c" }],
    },
    mesh: {
      enabled: () => r.mesh.on,
      me: () => ({ name: "desk" }),
      peers: () => r.mesh.peers,
      peer: (id) => r.mesh.peers.find((p) => p.id === id),
      http: async (dest, method, path) => {
        const canned = r.peerBodies.get(String(dest.addr));
        if (canned) return [canned.status, canned.body];
        const res = await fetch(`http://localhost:${peerServer.port}${path}`, { method });
        return [res.status, await res.json()];
      },
      forward: async (peer, req) => {
        r.forwarded.push({ peer: peer.id, path: req.path, body: req.body, sender: req.sender });
        return { status: 200, body: { id: 5, gid: "g5" } };
      },
      mapNew: (home, reply, global) => ({ status: reply.status, body: { home, global, ...(reply.body as object) } }),
    },
    host: {
      repos: async () => r.localRepos,
      projects: async (global) => [{ id: global ? "/p/r" : 1, name: "r", repo: "o/r" }],
      projectOf: (repo) => r.projectOf.get(repo),
      agentLabel: () => "Claude",
      ctx: () => ({ person: "x" }),
      agentThread: async (global, start) => {
        r.started.push({ global, ...start });
        return { status: 200, body: { id: 1 } };
      },
    },
    blocks: (md) => [{ t: "p", md }],
    deviceId: (t) => `tok:${t.length}`,
    clock: () => r.now.t,
  };
  r.deps = deps;
  r.api = new GhApi(deps);
  return r;
}

const peer = (id: string, online = true): Peer => ({ id, name: id === "ts:lap" ? "laptop" : id, online, dest: { addr: id } });
const body = (r: Reply): Record<string, unknown> => r.body as Record<string, unknown>;

test("the pull request list is served again for a minute", async () => {
  const r = rig();
  const get = (q: [string, string][] = []) => r.api.handle(call(q));
  const first = await get();
  expect(first.status).toBe(200);
  expect(body(first).projects).toEqual([{ id: 1, name: "r", repo: "o/r" }]);
  await get();
  expect(r.prFetched.length).toBe(1);
  r.now.t += 59_000;
  await get([["sort", "newest"]]);
  expect(r.prFetched.length).toBe(1);
  r.now.t += 2_000;
  await get();
  expect(r.prFetched.length).toBe(2);
  await get([["refresh", "1"]]);
  expect(r.prFetched.length).toBe(3);
  await get([["state", "closed"]]);
  expect(r.prFetched.length).toBe(4);
  const global = await r.api.handle(call([], { global: true }));
  expect(body(global).projects).toEqual([{ id: "/p/r", name: "r", repo: "o/r" }]);
});

test("a failing fetch answers 502", async () => {
  const r = rig();
  const api = new GhApi({ ...r.deps, prs: prsPort([], "gh: not signed in") });
  const reply = await api.handle(call());
  expect(reply).toEqual({ status: 502, body: { error: "gh: not signed in" } });
});

test("the issues page merges this pc with the mesh", async () => {
  const r = rig();
  r.mesh.peers = [peer("ts:lap"), peer("ts:off", false)];
  const reply = await r.api.handle(call([], { path: ["v1", "issues"] }));
  expect(reply.status).toBe(200);
  const v = body(reply) as { total: number; notes: string[]; groups: { items: { url: string }[] }[]; viewer: string };
  expect(v.total).toBe(2);
  expect(v.notes).toEqual(["ts:off: unreachable"]);
  expect(v.groups[0]?.items.map((i) => i.url)).toEqual(["https://github.com/o/r/issues/3", "https://github.com/o/crm/issues/9"]);
  expect(peerHits).toContain("/mesh/v1/issues?state=open");
  const again = await r.api.handle(call([], { path: ["v1", "issues"] }));
  expect(body(again).total).toBe(2);
  expect(r.issueFetches).toBe(1);
  await r.api.handle(call([["refresh", "1"]], { path: ["v1", "issues"] }));
  expect(peerHits).toContain("/mesh/v1/issues?state=open&refresh=1");
  expect(r.issueFetches).toBe(2);
});

test("a pc that is off, old or not signed in leaves a note, and only a total failure fails", async () => {
  const r = rig();
  r.mesh.peers = [peer("a"), peer("b"), peer("c"), peer("d")];
  r.peerBodies.set("a", { status: 404, body: null });
  r.peerBodies.set("b", { status: 200, body: { login: "", error: "gh auth login needed" } });
  r.peerBodies.set("c", { status: 500, body: { error: "boom\nmore" } });
  r.peerBodies.set("d", { status: 503, body: null });
  const ok = await r.api.handle(call([], { path: ["v1", "issues"] }));
  expect((body(ok) as { notes: string[] }).notes).toEqual(["a: runs an older Harbor", "b: GitHub not connected", "c: boom", "d: didn't answer"]);
  const lone = rig();
  lone.ownError = "gh failed hard";
  lone.mesh.peers = [peer("a")];
  lone.peerBodies.set("a", { status: 404, body: null });
  expect(await lone.api.handle(call([], { path: ["v1", "issues"] }))).toEqual({ status: 502, body: { error: "gh failed hard" } });
  const survives = rig();
  survives.ownError = "gh failed hard";
  survives.mesh.peers = [peer("ts:lap")];
  const reply = await survives.api.handle(call([], { path: ["v1", "issues"] }));
  expect(reply.status).toBe(200);
  expect((body(reply) as { notes: string[] }).notes).toEqual(["desk: gh failed hard"]);
});

test("this pc's own part is what another pc asks for", async () => {
  const r = rig();
  r.localRepos = ["o/r"];
  const reply = await r.api.handle(call([], { path: ["mesh", "v1", "issues"] }));
  expect(body(reply)).toMatchObject({ login: "me", projects: ["o/r"] });
  expect((body(reply).items as { avatar: string; trusted: boolean }[])[0]).toMatchObject({ avatar: "a.png", trusted: true, number: 3 });
  r.ownError = "no gh";
  r.now.t += 61_000;
  expect(body(await r.api.handle(call([], { path: ["mesh", "v1", "issues"] })))).toEqual({ login: "", projects: ["o/r"], error: "no gh" });
});

test("details of a pull request and an issue", async () => {
  const r = rig();
  const view = body(await r.api.handle(call([["url", "https://github.com/o/r/pull/7"]], { path: ["v1", "prs", "view"] })));
  expect(view).toMatchObject({ number: 7, repo: "o/r", state: "open", agent: "Claude", body: "**hi**", blocks: [{ t: "p", md: "**hi**" }] });
  expect((view.timeline as { kind: string }[]).map((t) => t.kind)).toEqual(["opened", "commit", "review"]);
  expect(view.checks).toEqual([{ name: "ci", state: "pass", url: "u" }]);
  expect(view.reviewers).toEqual([{ login: "bo", state: "APPROVED" }]);
  const diff = body(await r.api.handle(call([["url", "https://github.com/o/r/pull/7"]], { path: ["v1", "prs", "diff"] })));
  expect(diff).toEqual({ lines: [{ t: "ctx", text: "c" }], clipped: false });
  const iss = body(await r.api.handle(call([["url", "https://github.com/o/r/issues/3"]], { path: ["v1", "issues", "view"] })));
  expect(iss).toMatchObject({ title: "Broken", repo: "o/r", agent: "Claude" });
  const raw = await r.api.handle(call([["url", "https://github.com/o/r/issues/3"]], { path: ["mesh", "v1", "issues", "view"] }));
  expect(raw).toEqual({ status: 200, body: { raw: true } });
  expect(await r.api.handle(call([["url", "--help"]], { path: ["v1", "prs", "view"] }))).toEqual({ status: 400, body: { error: "url must be a GitHub pull request" } });
  expect(await r.api.handle(call([["url", "https://github.com/o/r/pull/1"]], { path: ["v1", "issues", "view"] }))).toEqual({ status: 400, body: { error: "url must be a GitHub issue" } });
});

const peerOwns = (r: Rig, projects: string[] = []): void => {
  r.ownError = "no gh here";
  r.mesh.peers = [peer("ts:lap")];
  r.peerBodies.set("ts:lap", { status: 200, body: { login: "bo", projects, items: [issueMeshJson(issue({ accounts: [], mentions: [] }))] } });
};

test("issue details come from the pc that sees the issue when it is not this one", async () => {
  const r = rig();
  peerOwns(r);
  await r.api.handle(call([], { path: ["v1", "issues"] }));
  const url = "https://github.com/o/r/issues/3";
  const there = body(await r.api.handle(call([["url", url]], { path: ["v1", "issues", "view"] })));
  expect(there.title).toBe("From peer");
  const alone = rig();
  await alone.api.handle(call([], { path: ["v1", "issues"] }));
  expect(body(await alone.api.handle(call([["url", url]], { path: ["v1", "issues", "view"] }))).title).toBe("Broken");
});

test("ready, close and reopen call gh and expire the lists", async () => {
  const r = rig();
  await r.api.handle(call());
  const ready = await r.api.handle(call([], { method: "POST", path: ["v1", "prs", "ready"], body: { url: "https://github.com/o/r/pull/7" } }));
  expect(ready).toEqual({ status: 200, body: { ok: true } });
  expect(r.ghCalls).toEqual([["pr", "ready", "https://github.com/o/r/pull/7"]]);
  await r.api.handle(call());
  expect(r.prFetched.length).toBe(2);

  await r.api.handle(call([], { path: ["v1", "issues"] }));
  const url = "https://github.com/o/r/issues/3";
  const close = await r.api.handle(call([], { method: "POST", path: ["v1", "issues", "close"], body: { url } }));
  expect(close.status).toBe(200);
  expect(r.ghCalls[1]).toEqual(["issue", "close", url]);
  await r.api.handle(call([], { path: ["v1", "issues"] }));
  expect(r.issueFetches).toBe(2);
  await r.api.handle(call([], { method: "POST", path: ["mesh", "v1", "issues", "reopen"], body: { url } }));
  expect(r.ghCalls[2]).toEqual(["issue", "reopen", url]);
  const failed = await r.api.handle(call([], { method: "POST", path: ["v1", "issues", "close"], body: { url: "https://github.com/o/r/issues/404" } }));
  expect(failed).toEqual({ status: 502, body: { error: "gh: not found" } });
});

test("closing an issue another pc owns goes to that pc", async () => {
  const r = rig();
  peerOwns(r);
  await r.api.handle(call([], { path: ["v1", "issues"] }));
  const url = "https://github.com/o/r/issues/3";
  await r.api.handle(call([], { method: "POST", path: ["v1", "issues", "reopen"], body: { url, account: "bo" } }));
  expect(r.ghCalls.at(-1)).toEqual(["peer", "reopen", url]);
});

test("Merge with… needs the list, a project and starts an agent thread", async () => {
  const r = rig();
  const url = "https://github.com/o/r/pull/7";
  const post = (extra?: string) => r.api.handle(call([], { method: "POST", path: ["v1", "prs", "merge"], body: { url, ...(extra ? { extra } : {}) }, global: true }));
  expect(await post()).toEqual({ status: 409, body: { error: "refresh the list first" } });
  await r.api.handle(call());
  expect(await post()).toEqual({ status: 409, body: { error: NOT_PROJECT } });
  r.projectOf.set("o/r", 4);
  expect(await post("squash")).toEqual({ status: 200, body: { id: 1 } });
  expect(r.started).toEqual([{ global: true, kind: "merge", project: 4, pr: pr(), extra: "squash" }]);
});

test("Fix with… starts here, or forwards to the pc that has the project", async () => {
  const r = rig();
  const url = "https://github.com/o/r/issues/3";
  const post = (device = "", extra?: string) => r.api.handle(call([], { method: "POST", path: ["v1", "issues", "fix"], body: { url, ...(extra ? { extra } : {}) }, token: "secret", device }));
  expect(await post()).toEqual({ status: 409, body: { error: "refresh the list first" } });
  peerOwns(r, ["o/r"]);
  await r.api.handle(call([], { path: ["v1", "issues"] }));
  const forwarded = await post("Pixel", "be careful");
  expect(forwarded).toEqual({ status: 200, body: { home: "ts:lap", global: false, id: 5, gid: "g5" } });
  expect(r.forwarded).toEqual([{ peer: "ts:lap", path: ["v1", "issues", "fix"], body: { url, extra: "be careful" }, sender: ["Pixel via desk", "tok:6"] }]);
  await post();
  expect(r.forwarded[1]?.sender[0]).toBe("Phone via desk");
  r.projectOf.set("o/r", 2);
  expect(await post("", "now")).toEqual({ status: 200, body: { id: 1 } });
  expect(r.started.length).toBe(1);
  expect(r.started[0]).toMatchObject({ kind: "fix", project: 2, extra: "now" });

  const alone = rig();
  await alone.api.handle(call([], { path: ["v1", "issues"] }));
  expect(await alone.api.handle(call([], { method: "POST", path: ["v1", "issues", "fix"], body: { url } }))).toEqual({ status: 409, body: { error: NOT_PROJECT } });
});

test("the window's Issues list is the merged one, and its Fix goes to the pc that has the project under the desk's own name", async () => {
  const r = rig();
  const url = "https://github.com/o/r/issues/3";
  expect(await r.api.fixAway(url, "", undefined, ["desk", "pc:desk"], false)).toEqual({ status: 409, body: { error: NOT_PROJECT } });
  peerOwns(r, ["o/r"]);
  const list = await r.api.mergedIssues("open", true);
  expect(list.items.map((i) => i.url)).toContain(url);
  expect(r.api.issuePeer(url, undefined, true)?.id).toBe("ts:lap");
  expect(r.api.pcName).toBe("desk");
  const reply = await r.api.fixAway(url, "carefully", undefined, ["desk", "pc:desk"], false);
  expect(reply.body).toEqual({ home: "ts:lap", global: false, id: 5, gid: "g5" });
  expect(r.forwarded).toEqual([{ peer: "ts:lap", path: ["v1", "issues", "fix"], body: { url, extra: "carefully" }, sender: ["desk", "pc:desk"] }]);
  const fetches = r.issueFetches;
  await r.api.mergedIssues("open", false);
  expect(r.issueFetches).toBe(fetches);
});

test("unknown calls are 404", async () => {
  const r = rig();
  expect(await r.api.handle(call([], { path: ["v1", "nope"] }))).toEqual({ status: 404, body: { error: "unknown call" } });
  expect(await r.api.handle(call([], { method: "DELETE" }))).toEqual({ status: 404, body: { error: "unknown call" } });
  const f: IssueFilters = issueFilters(call()).filters;
  expect(f).toEqual({ state: "open", involvement: "all", labels: [] });
});
