// Continue anywhere end to end, in one process: two PCs with their own harbor.db, Engine, workspace cloud (the
// Worker's handlers on SQLite) and clones of one Git repository. The PC a chat ran on goes off; the other takes the
// chat over with its agent session (paths moved to its own folder) and the work its remote doesn't have; then the
// first comes back, finds the chat moved on, and takes it back the same way. Both going on while apart splits it.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chatCloud } from "../cloudsync.ts";
import { carrySource, ContinueHere } from "../continuehere.ts";
import { Failover } from "../failover.ts";
import { Engine, movechat, type providers } from "../packages/agents/src/index.ts";
import { type AccountDirectory, type ChatCloud, type CloudContext, findRollout, Hub, StoreReplica } from "../packages/net/src/index.ts";
import { blankChat, type Chat, type Item, newUuid, Store } from "../packages/store/src/index.ts";
import { service } from "./cloudrig.ts";

const root = mkdtempSync(join(tmpdir(), "hcontinue-"));
const saved = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME, CODEX_HOME: process.env.CODEX_HOME };
process.env.XDG_DATA_HOME = join(root, "data");
process.env.XDG_STATE_HOME = join(root, "state");
const engines: Engine[] = [];
afterAll(async () => {
  for (const e of engines) {
    e.close();
    await e.idle();
  }
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows: a database file still held open
  }
});

const REMOTE = "https://example.org/sam/app.git";
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
// Git on Windows checks text out with CRLF (core.autocrlf): the content is what counts.
const read = (p: string) => readFileSync(p, "utf8").replaceAll("\r\n", "\n");
const user = (s: string): Item => ({ kind: "user", text: s, files: [], at: 1, mentions: [], sender: "", intent: "" });
const text = (s: string): Item => ({ kind: "text", text: s, at: 1 });

async function until(what: string, f: () => boolean, ms = 15_000): Promise<void> {
  const t = Date.now();
  while (!f()) {
    if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

function origin(name: string): string {
  const bare = join(root, `${name}.git`);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  const seed = join(root, `${name}-seed`);
  execFileSync("git", ["clone", "-q", bare, seed], { stdio: "ignore" });
  writeFileSync(join(seed, "a.txt"), "one\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "c1");
  git(seed, "push", "-q", "origin", "HEAD:main");
  return bare;
}

const pcEntry = (fp: string, id: string, name: string) => ({ fp, id, name, addrs: [], owner: "u1", owner_name: "Sam", seen: 0, version: "t" });
const directory: AccountDirectory = {
  at: 1,
  workspaces: [{ id: "W1", name: "Sam's", role: "owner", personal: true, members: [], pcs: [pcEntry("fpA", "ts:omarchy", "Omarchy"), pcEntry("fpB", "pc:windows", "Windows")], devices: [], invites: [] }],
  peers: [],
};

interface Pc {
  name: string;
  store: Store;
  hub: Hub;
  cloud: ChatCloud;
  replica: StoreReplica;
  engine: Engine;
  failover: Failover;
  ch: ContinueHere;
  account: providers.Account;
  /** Turns the engine started after the chat was prepared: [chat, prompt]. */
  turns: [number, string][];
  call: CloudContext["call"];
  codexHome: string;
  /** The mesh as failover sees it (run anywhere's handoff goes through `forward`); null: none. */
  mesh: { forward: (...a: never[]) => Promise<{ status: number; body: unknown }> } | null;
  /** Copies running at their PC now (failover's `busy`). */
  busy: Set<number>;
}

function pc(svc: ReturnType<typeof service>, name: string, fp: string, id: string, kind: "Claude" | "Codex", carries = true): Pc {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const store = Store.openAt(join(dir, "harbor.db"));
  const hub = new Hub([], 0);
  hub.mesh.me = { id, name };
  const account: providers.Account =
    kind === "Claude"
      ? { id: "claude", kind: "Claude", name: "Claude", email: "", badge: "C", plan: "", configDir: join(dir, ".claude"), bin: "/nonexistent/claude", loggedIn: true, usage: [] }
      : { id: "codex", kind: "Codex", name: "Codex", email: "", badge: "", plan: "", configDir: null, bin: "/nonexistent/codex", loggedIn: true, usage: [] };
  const accounts = () => [account];
  const scratch = join(dir, "scratch");
  // eslint-disable-next-line prefer-const
  let p: Pc;
  const failover = new Failover({
    store,
    engine: () => p.engine,
    hub,
    mesh: () => p.mesh as never,
    accounts,
    ram: () => 1000,
    forgetCopy: () => {},
    place: () => null,
    touch: () => {},
    carry: { of: (x, h) => p.ch.of(x, h), begin: (c, f, h, off, quiet) => p.ch.begin(c, f, h, off, quiet) },
    mine: () => true,
    busy: (id) => p.busy.has(id),
    refresh: () => cloud.refresh(),
    carryNow: (hid, ms) => cloud.carryNow(hid, ms),
  });
  const replica = new StoreReplica({ store, hub, version: "t", took: (gid) => failover.took(gid), release: (o, peer, h, n) => failover.release(o, peer, h, n), dropOwn: (o, by, n) => failover.dropOwn(o, by, n) });
  const cloud = chatCloud({
    stateDir: dir,
    fp: () => fp,
    store,
    hub,
    replica: () => replica,
    directory: () => directory,
    running: () => false,
    copied: () => p.engine.reload(),
    carry: carries ? carrySource({ store, engine: () => p.engine, accounts, scratch }) : undefined,
    // Each round is a minute later (the cloud reads the workspaces at most every 45 s).
    clock: () => Date.now() + skew,
    log: process.env.CARRY_LOG ? (l: string) => console.log(`${name}: ${l}`) : undefined,
  });
  const ch = new ContinueHere({ store, engine: () => p.engine, accounts, scratch, cloud: () => cloud, here: () => name, touch: () => {} });
  const engine = new Engine({ store, accounts, changed: () => {}, prepare: (c, prompt, files) => ch.prepare(c, prompt, files) });
  engines.push(engine);
  const turns: [number, string][] = [];
  // Turns aren't run here: the first start of a taken-over chat goes through the engine (its hook holds it), the
  // one after it is recorded.
  const start = engine.startTurn.bind(engine);
  engine.startTurn = (c: number, prompt: string, files: readonly string[] = []) => {
    // Held by the hook (it's being prepared now, or this start begins it): the engine's own; else recorded.
    if (ch.preparing(c) || ch.waiting(c)) return start(c, prompt, [...files]);
    turns.push([c, prompt]);
  };
  p = { name, store, hub, cloud, replica, engine, failover, ch, account, turns, call: svc.callAs("u1", fp, ["W1"]), codexHome: join(dir, ".codex"), mesh: null, busy: new Set() };
  return p;
}

let skew = 0;

/** A round of the account loop on `p` (its own CODEX_HOME while it runs), a minute after the last. */
async function round(p: Pc): Promise<void> {
  skew += 60_000;
  process.env.CODEX_HOME = p.codexHome;
  await p.cloud.sync({ account: "u1", mine: "W1", workspaces: ["W1"], call: p.call });
  p.engine.reload();
}

/** A message sent to a copy whose PC is off, as the window sends it; then the turn that starts once it's prepared. */
async function sendTo(p: Pc, copy: Chat, msg: string): Promise<string> {
  process.env.CODEX_HOME = p.codexHome;
  const n = p.turns.length;
  const r = await p.failover.send(copy, { text: msg, files: [], mentions: [] });
  expect(r.status).toBe(200);
  await until(`${p.name}'s turn`, () => p.turns.length > n);
  return p.turns[n]?.[1] ?? "";
}

const notices = (p: Pc, id: number) => p.engine.transcript(id).items.filter((i) => i.kind === "notice");

describe("continue anywhere", () => {
  test("Claude: the owner goes off, another PC goes on with its session and work; back again the same way", async () => {
    const svc = service();
    const bare = origin("app");
    const A = pc(svc, "Omarchy", "fpA", "ts:omarchy", "Claude");
    const B = pc(svc, "Windows", "fpB", "pc:windows", "Claude");
    // A: the project with an unpushed commit, a change and a new file; a chat that ran on it.
    const dirA = join(root, "Omarchy", "Projects", "app");
    execFileSync("git", ["clone", "-q", bare, dirA], { stdio: "ignore" });
    writeFileSync(join(dirA, "a.txt"), "two\n");
    git(dirA, "commit", "-q", "-am", "unpushed on A");
    writeFileSync(join(dirA, "a.txt"), "three\n");
    writeFileSync(join(dirA, "new.txt"), "new on A\n");
    const repoA = A.store.addRepo(dirA);
    A.store.setRepoRemote(repoA, REMOTE);
    const sid = "11111111-2222-3333-4444-555555555555";
    const chat = A.store.createChat(blankChat({ repoId: repoA, title: "Fix the parser", account: "claude", started: true, sessionId: sid, updated: Math.floor(Date.now() / 1000) }));
    A.store.saveItems(chat.id, [user("fix the parser"), text("Done: edited a.txt")]);
    const sessA = join(movechat.sessionDir(A.account.configDir, dirA), `${sid}.jsonl`);
    mkdirSync(dirname(sessA), { recursive: true });
    writeFileSync(sessA, `${JSON.stringify({ type: "user", cwd: dirA, sessionId: sid, message: { content: "fix the parser" } })}\n${JSON.stringify({ type: "assistant", cwd: dirA, message: { content: [{ type: "tool_use", input: { file_path: join(dirA, "a.txt") } }] } })}\n`);
    A.engine.reload();
    await round(A);
    expect(Object.keys(A.cloud.internals.pub.carry?.chats ?? {})).toEqual([String(chat.id)]);

    // B: its own clone of the project (found by its remote), clean.
    const dirB = join(root, "Windows", "code", "app");
    execFileSync("git", ["clone", "-q", bare, dirB], { stdio: "ignore" });
    const repoB = B.store.addRepo(dirB);
    B.store.setRepoRemote(repoB, REMOTE);
    await round(B);
    const copy = B.store.chats().find((c) => c.home === "ts:omarchy" && c.homeId === chat.id);
    if (!copy) throw new Error("no copy on B");
    expect(copy.repoId).toBe(repoB);
    // It runs here, as any chat typed here does (run anywhere): no line over the composer.
    expect(B.failover.line(copy)).toBeNull();

    // A is off: a message on B takes the chat over and resumes A's session in B's folder.
    const prompt = await sendTo(B, copy, "now the tests");
    const own = B.engine.chat(copy.id);
    expect(own?.home).toBe("");
    expect(own?.sessionId).toBe(sid);
    expect(own?.started).toBe(true);
    expect(prompt).not.toContain("This conversation started on");
    expect(prompt).toContain("now the tests");
    const sessB = join(movechat.sessionDir(B.account.configDir, dirB), `${sid}.jsonl`);
    const lines = read(sessB).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0].cwd).toBe(dirB);
    expect(lines[1].message.content[0].input.file_path).toBe(join(dirB, "a.txt"));
    expect(git(dirB, "rev-parse", "HEAD")).toBe(git(dirA, "rev-parse", "HEAD"));
    expect(read(join(dirB, "a.txt"))).toBe("three\n");
    expect(read(join(dirB, "new.txt"))).toBe("new on A\n");
    // The account's own PC's chat: it simply goes on here, with no notice naming PCs.
    expect(notices(B, copy.id)).toEqual([]);

    // B goes on: its session grows, it commits and changes more; then it's off too.
    appendFileSync(sessB, `${JSON.stringify({ type: "assistant", cwd: dirB, message: { content: [{ type: "text", text: `wrote ${join(dirB, "test.txt")}` }] } })}\n`);
    writeFileSync(join(dirB, "test.txt"), "tests\n");
    git(dirB, "add", "test.txt");
    git(dirB, "commit", "-q", "-m", "tests on B");
    writeFileSync(join(dirB, "new.txt"), "edited on B\n");
    const itemsB = [...B.store.items(copy.id), text("Tests added")];
    B.store.saveItems(copy.id, itemsB);
    B.store.saveChat({ ...(B.store.chat(copy.id) as Chat), updated: Math.floor(Date.now() / 1000) + 5 });
    B.engine.reload();
    await round(B);

    // A is back while B is off: its chat is B's now (one owner), and its next message takes it back with B's work.
    await round(A);
    const back = A.store.chat(chat.id);
    expect(back?.home).toBe("pc:windows");
    expect(A.store.items(chat.id).length).toBe(itemsB.length);
    const prompt2 = await sendTo(A, back as Chat, "ship it");
    expect(prompt2).toContain("ship it");
    expect(A.engine.chat(chat.id)?.home).toBe("");
    expect(git(dirA, "log", "-1", "--format=%s")).toBe("tests on B");
    expect(read(join(dirA, "new.txt"))).toBe("edited on B\n");
    expect(read(join(dirA, "test.txt"))).toBe("tests\n");
    const linesA = read(sessA).trim().split("\n").map((l) => JSON.parse(l));
    expect(linesA.length).toBe(3);
    expect(linesA[2].message.content[0].text).toBe(`wrote ${join(dirA, "test.txt")}`);
    // The folder moved on in place (A's own changes were the state B's work came from): nothing to say.
    expect(notices(A, chat.id)).toEqual([]);
    for (const p of [A, B]) p.store.close();
  }, 60_000);

  test("Codex: the rollout goes along and resumes under this PC's CODEX_HOME", async () => {
    const svc = service();
    const A = pc(svc, "Mac", "fpA", "ts:omarchy", "Codex");
    const B = pc(svc, "Linux", "fpB", "pc:windows", "Codex");
    const sid = "019a0000-aaaa-bbbb-cccc-ddddeeeeffff";
    const chat = A.store.createChat(blankChat({ title: "Codex chat", account: "codex", started: true, sessionId: sid, updated: Math.floor(Date.now() / 1000) }));
    A.store.saveItems(chat.id, [user("hi"), text("hello")]);
    const cwdA = A.engine.chatCwd(chat);
    const roll = join(A.codexHome, "sessions", "2026", "11", "13", `rollout-2026-11-13T10-00-00-${sid}.jsonl`);
    mkdirSync(dirname(roll), { recursive: true });
    writeFileSync(roll, `${JSON.stringify({ type: "session_meta", payload: { id: sid, cwd: cwdA } })}\n`);
    A.engine.reload();
    // The rollout is looked for in the background: found by the second round.
    await round(A);
    await Bun.sleep(50);
    await round(A);
    await round(B);
    const copy = B.store.chats().find((c) => c.home === "ts:omarchy");
    if (!copy) throw new Error("no copy");
    await sendTo(B, copy, "go on");
    expect(B.engine.chat(copy.id)?.account).toBe("codex");
    expect(B.engine.chat(copy.id)?.sessionId).toBe(sid);
    const placed = await findRollout(B.codexHome, sid);
    expect(placed).not.toBeNull();
    expect(placed?.endsWith(`rollout-2026-11-13T10-00-00-${sid}.jsonl`)).toBe(true);
    expect(JSON.parse(read(placed as string).trim()).payload.cwd).toBe(B.engine.chatCwd(B.engine.chat(copy.id) as Chat));
    expect(existsSync(roll)).toBe(true);
    for (const p of [A, B]) p.store.close();
  }, 60_000);

  test("both PCs went on while apart: the owner's goes its own way, the other's comes beside it", async () => {
    const svc = service();
    const A = pc(svc, "Tower", "fpA", "ts:omarchy", "Claude");
    const B = pc(svc, "Desk", "fpB", "pc:windows", "Claude");
    const chat = A.store.createChat(blankChat({ title: "Shared", account: "claude", updated: Math.floor(Date.now() / 1000) }));
    A.store.saveItems(chat.id, [user("start")]);
    A.engine.reload();
    await round(A);
    await round(B);
    const copy = B.store.chats().find((c) => c.home === "ts:omarchy");
    if (!copy) throw new Error("no copy");
    const gid = copy.gid;
    // Nothing carried (it never ran): B goes on with a new session.
    await sendTo(B, copy, "on B");
    B.store.saveItems(copy.id, [...B.store.items(copy.id), text("B's answer")]);
    B.store.saveChat({ ...(B.store.chat(copy.id) as Chat), updated: Math.floor(Date.now() / 1000) + 5 });
    await round(B);
    // Meanwhile someone wrote on A too.
    A.store.saveItems(chat.id, [user("start"), user("on A")]);
    await round(A);
    const mine = A.store.chat(chat.id);
    expect(mine?.home).toBe("");
    expect(mine?.gid).not.toBe(gid);
    const theirs = A.store.chats().find((c) => c.gid === gid);
    expect(theirs?.home).toBe("pc:windows");
    expect(A.store.items(chat.id).map((i) => (i.kind === "user" || i.kind === "notice" ? i.text : i.kind))).toContain("on A");
    const n = A.engine.transcript(chat.id).items.filter((i) => i.kind === "notice").at(-1);
    expect(n?.kind === "notice" && n.text).toBe("windows went on with this chat too: this is Tower's, kept as its own chat");
    for (const p of [A, B]) p.store.close();
  }, 60_000);

  test("run anywhere: a message typed on B brings A's chat to B while A is on, with its session and work; A's becomes a copy", async () => {
    const svc = service();
    const bare = origin("app3");
    const A = pc(svc, "Tower", "fpA", "ts:omarchy", "Claude");
    const B = pc(svc, "Desk", "fpB", "pc:windows", "Claude");
    const dirA = join(root, "Tower", "Projects", "app3");
    execFileSync("git", ["clone", "-q", bare, dirA], { stdio: "ignore" });
    writeFileSync(join(dirA, "a.txt"), "edited on the Tower\n");
    const repoA = A.store.addRepo(dirA);
    A.store.setRepoRemote(repoA, REMOTE);
    const sid = "22222222-3333-4444-5555-666666666666";
    const chat = A.store.createChat(blankChat({ repoId: repoA, title: "Old chat", account: "claude", started: true, sessionId: sid }));
    A.store.saveItems(chat.id, [user("start"), text("ok")]);
    // Three weeks old: past what goes up by itself; the handoff sends it anyway.
    A.store.saveChat({ ...(A.store.chat(chat.id) as Chat), updated: Math.floor(Date.now() / 1000) - 21 * 86_400 });
    const sessA = join(movechat.sessionDir(A.account.configDir, dirA), `${sid}.jsonl`);
    mkdirSync(dirname(sessA), { recursive: true });
    writeFileSync(sessA, `${JSON.stringify({ type: "user", cwd: dirA, sessionId: sid, message: { content: "start" } })}\n`);
    A.engine.reload();
    await round(A);
    expect(A.cloud.internals.pub.carry?.chats[String(chat.id)]).toBeUndefined();
    const dirB = join(root, "Desk", "code", "app3");
    execFileSync("git", ["clone", "-q", bare, dirB], { stdio: "ignore" });
    const repoB = B.store.addRepo(dirB);
    B.store.setRepoRemote(repoB, REMOTE);
    await round(B);
    const copy = B.store.chats().find((c) => c.home === "ts:omarchy" && c.homeId === chat.id);
    if (!copy) throw new Error("no copy on B");

    // A is on: B reaches it over the mesh, and its handoff route is A's failover.
    B.hub.mesh.peers.set("ts:omarchy", { id: "ts:omarchy", name: "omarchy", online: true, addr: "", fp: "fpA" } as never);
    const asked: string[] = [];
    B.mesh = {
      forward: (async (_d: unknown, _n: string, method: string, path: string[], body: Record<string, unknown>) => {
        asked.push(`${method} ${path.join("/")}`);
        const own = A.store.chat(Number(path[2]));
        if (!own) return { status: 404, body: {} };
        return A.failover.handoff(own, String(body.to));
      }) as never,
    };
    // While it runs there, its messages go to that run: it stays.
    B.busy.add(copy.id);
    expect(B.failover.whyNotHere(copy)).toBe("it runs there now");
    expect(await B.failover.claim(copy, { text: "x", files: [], mentions: [] })).toBeNull();
    B.busy.delete(copy.id);
    // Picked to run on A: it stays too.
    B.failover.pickRunsOn(copy, "ts:omarchy");
    expect(B.failover.whyNotHere(copy)).toBe("picked to run there");
    B.failover.pickRunsOn(copy, "");
    expect(B.failover.whyNotHere(copy)).toBeNull();

    process.env.CODEX_HOME = B.codexHome;
    const n = B.turns.length;
    const r = await B.failover.claim(copy, { text: "go on here", files: [], mentions: [] });
    expect(r?.status).toBe(200);
    expect(asked).toEqual([`POST v1/chats/${chat.id}/handoff`]);
    await until("B's turn", () => B.turns.length > n);
    expect(B.turns[n]?.[1]).toContain("go on here");
    const own = B.engine.chat(copy.id);
    expect(own?.home).toBe("");
    expect(own?.sessionId).toBe(sid);
    expect(read(join(dirB, "a.txt"))).toBe("edited on the Tower\n");
    const lines = read(join(movechat.sessionDir(B.account.configDir, dirB), `${sid}.jsonl`)).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0].cwd).toBe(dirB);
    // Quietly: no notice naming a PC.
    expect(notices(B, copy.id)).toEqual([]);

    // A sees B's chat (here through the cloud; the mesh does the same): A's own becomes a copy of B's.
    await round(B);
    await round(A);
    expect(A.store.chat(chat.id)?.home).toBe("pc:windows");
    for (const p of [A, B]) p.store.close();
  }, 60_000);

  test("its PC off with nothing carried: another PC sends, settles, renames and deletes; back, the PC agrees", async () => {
    const svc = service();
    // Windows never sent a session up (an older Harbor, or it was switched off first): no carry rows at all.
    const W = pc(svc, "Dual-Windows", "fpB", "pc:windows", "Claude", false);
    const O = pc(svc, "Dual-Omarchy", "fpA", "ts:omarchy", "Claude");
    const at = Math.floor(Date.now() / 1000) - 600;
    const mk = (title: string) => {
      const c = W.store.createChat(blankChat({ title, account: "claude", started: true, sessionId: newUuid(), updated: at }));
      W.store.saveItems(c.id, [user(`${title}?`), text("ok")]);
      return c;
    };
    const hi = mk("Hi");
    const settle = mk("Settle me");
    const rename = mk("Rename me");
    const drop = mk("Delete me");
    const keep = mk("Deleted there, written here");
    W.engine.reload();
    await round(W);
    expect(W.cloud.internals.pub.carry?.chats ?? {}).toEqual({});
    await round(O);
    const copy = (c: Chat) => {
      const x = O.store.chats().find((k) => k.home === "pc:windows" && k.homeId === c.id);
      if (!x) throw new Error(`no copy of ${c.title}`);
      return x;
    };
    // Windows is off (never in O's mesh): every chat of it can be used here.
    const hiCopy = copy(hi);
    const prompt = await sendTo(O, hiCopy, "still there?");
    const hiHere = O.engine.chat(hiCopy.id);
    expect(hiHere?.home).toBe("");
    // A new session with the conversation so far, and a short notice that its own session stayed behind.
    expect(prompt).toContain("This conversation started on");
    expect(prompt).toContain("Hi?");
    expect(prompt).toContain("still there?");
    expect(notices(O, hiHere?.id ?? -1).map((n) => (n.kind === "notice" ? n.text : ""))).toEqual(["New session here, with the conversation so far"]);

    // Settle, rename, delete: the chat becomes Omarchy's (nothing carried, nothing cloned), the change is made here.
    const s1 = O.failover.adopt(copy(settle));
    if (typeof s1 === "string") throw new Error(s1);
    O.store.saveChat({ ...s1, settled: true });
    const r1 = O.failover.adopt(copy(rename));
    if (typeof r1 === "string") throw new Error(r1);
    O.store.saveChat({ ...r1, title: "Renamed on Omarchy" });
    const dropHere = copy(drop);
    const d1 = O.failover.adopt(dropHere);
    if (typeof d1 === "string") throw new Error(d1);
    O.store.deleteChat(d1.id);
    const keepHere = copy(keep);
    const k1 = O.failover.adopt(keepHere);
    if (typeof k1 === "string") throw new Error(k1);
    O.store.deleteChat(k1.id);
    O.engine.reload();
    expect(O.turns.length).toBe(1);
    expect(O.store.chat(s1.id)?.home).toBe("");
    expect(O.store.chat(s1.id)?.settled).toBe(true);
    expect(O.replica.dropped().map((d) => [d.gid, d.from])).toEqual([
      [drop.gid, "pc:windows"],
      [keep.gid, "pc:windows"],
    ]);
    // On Omarchy the deleted chats stay gone while Windows' old listing still names them.
    await O.replica.applyChats("pc:windows", 9, { full: true, chats: (await W.replica.chats(0, true)).chats });
    expect(O.store.chats().filter((c) => c.gid === drop.gid || c.gid === keep.gid)).toEqual([]);
    expect(O.store.chat(s1.id)?.home).toBe("");
    await round(O);
    // The mesh's list says the same to Windows when both are on.
    expect(((await O.replica.chats(0, true)).dropped ?? []).length).toBe(2);

    // Windows, meanwhile (both apart): someone wrote in one of them there.
    W.store.saveItems(keep.id, [...W.store.items(keep.id), user("written on Windows")]);
    // Back on Windows (Omarchy off): one owner per chat, the changes made, nothing lost.
    await round(W);
    const w = (c: Chat) => W.store.chats().find((k) => k.id === c.id);
    for (const c of [hi, settle, rename]) expect([c.title, w(c)?.home]).toEqual([c.title, "ts:omarchy"]);
    expect(w(settle)?.settled).toBe(true);
    expect(w(rename)?.title).toBe("Renamed on Omarchy");
    expect(w(hi)?.sessionId).toBe("");
    expect(w(drop)).toBeUndefined();
    // Written there after Omarchy took it: kept, as a chat of its own (a new gid the delete doesn't match).
    expect(w(keep)?.home).toBe("");
    expect(w(keep)?.gid).not.toBe(keep.gid);

    // Omarchy again: its chats stay its own, the deleted one stays gone, Windows' kept one comes as a copy.
    await round(W);
    await round(O);
    const own = O.store.chats().filter((c) => c.home === "").map((c) => c.title).sort();
    expect(own).toEqual(["Hi", "Renamed on Omarchy", "Settle me"]);
    expect(O.store.chats().filter((c) => c.gid === drop.gid)).toEqual([]);
    expect(O.store.chats().find((c) => c.home === "pc:windows")?.title).toBe("Deleted there, written here");
    for (const p of [W, O]) p.store.close();
  }, 60_000);
});
