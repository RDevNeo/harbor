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
import { blankChat, type Chat, type Item, Store } from "../packages/store/src/index.ts";
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
  engine: Engine;
  failover: Failover;
  ch: ContinueHere;
  account: providers.Account;
  /** Turns the engine started after the chat was prepared: [chat, prompt]. */
  turns: [number, string][];
  call: CloudContext["call"];
  codexHome: string;
}

function pc(svc: ReturnType<typeof service>, name: string, fp: string, id: string, kind: "Claude" | "Codex"): Pc {
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
    mesh: () => null,
    accounts,
    ram: () => 1000,
    forgetCopy: () => {},
    place: () => null,
    touch: () => {},
    carry: { of: (x, h) => p.ch.of(x, h), begin: (c, f, h, off) => p.ch.begin(c, f, h, off) },
  });
  const replica = new StoreReplica({ store, hub, version: "t", took: (gid) => failover.took(gid), release: (o, peer, h, n) => failover.release(o, peer, h, n) });
  const cloud = chatCloud({
    stateDir: dir,
    fp: () => fp,
    store,
    hub,
    replica: () => replica,
    directory: () => directory,
    running: () => false,
    copied: () => p.engine.reload(),
    carry: carrySource({ store, engine: () => p.engine, accounts, scratch }),
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
  p = { name, store, hub, cloud, engine, failover, ch, account, turns, call: svc.callAs("u1", fp, ["W1"]), codexHome: join(dir, ".codex") };
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
    expect(B.failover.line(copy)?.text).toBe("omarchy is off. Next message runs on Windows.");

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
    const n = notices(B, copy.id).at(-1);
    expect(n?.kind === "notice" && n.text).toBe("Continued on Windows — omarchy is off");
    expect(n?.kind === "notice" && n.detail).toContain("1 unpushed commit and uncommitted changes came from omarchy.");

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
    const n2 = notices(A, chat.id).at(-1);
    expect(n2?.kind === "notice" && n2.text).toBe("Continued on Omarchy — windows is off");
    // The folder moved on in place: A's own changes were the state B's work came from.
    expect(n2?.kind === "notice" && n2.detail).not.toContain("worktree");
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
});
