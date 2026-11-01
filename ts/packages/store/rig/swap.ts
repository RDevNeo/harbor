import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { install } from "../../update/src/install.ts";
import { FakeHost, configFor, makeKey } from "../../update/test/support.ts";

const [work = "", artifacts = "", fakeDir = ""] = process.argv.slice(2);
const A = { runtime: join(artifacts, "runtime-a"), bundle: join(artifacts, "bundle-a.js") };
const B = { runtime: join(artifacts, "runtime-b"), bundle: join(artifacts, "bundle-b.js") };
const dir = join(work, "install");
const env: Record<string, string> = {
  PATH: `${fakeDir}:/usr/bin:/bin`,
  HOME: join(work, "home"),
  XDG_DATA_HOME: join(work, "data"),
  XDG_STATE_HOME: join(work, "state"),
  XDG_CONFIG_HOME: join(work, "cfg"),
  XDG_CACHE_HOME: join(work, "cache"),
  XDG_RUNTIME_DIR: join(work, "run"),
  HARBOR_SOCK: join(work, "run", "h.sock"),
  HARBOR_TEST_NO_SIGNIN: "1",
  HARBOR_NO_TRAY: "1",
  HARBOR_LISTEN: "127.0.0.1",
  HARBOR_UPDATE_WORKER: "off",
  HTS_STREAM_S: "25",
  TZ: "UTC",
};
const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";
let failed = false;
const say = (ok: boolean, what: string): void => {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
};
const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const text = (p: string): string => (existsSync(p) ? readFileSync(p, "utf8").trim() : "");

for (const d of ["home", "data", "state", "cfg", "cache", "run"]) mkdirSync(join(work, d), { recursive: true, mode: 0o700 });
mkdirSync(join(work, "scratch"), { recursive: true });
mkdirSync(dir, { recursive: true });
copyFileSync(A.runtime, join(dir, "harbor"));
Bun.spawnSync(["chmod", "755", join(dir, "harbor")]);
copyFileSync(A.bundle, join(dir, "harbor-app.js"));
writeFileSync(join(dir, ".managed"), "");
writeFileSync(join(dir, "VERSION"), "0.109.0");
writeFileSync(join(dir, "RUNTIME"), "0.109.0");

Object.assign(process.env, env);
const { Store, dataDir } = await import("../src/index.ts");
const s = Store.open(dataDir());
s.setQuiet("api_enabled", "1");
s.setQuiet("api_port", "47930");
s.setQuiet("api_tokens", JSON.stringify([{ token: TOKEN, name: "", created: 0, group: "gggggggggggggggg", fp: "" }]));
const repo = s.addRepo(join(work, "scratch"));
s.close();

const api = async (path: string, init: RequestInit = {}): Promise<unknown> => {
  const r = await fetch(`http://127.0.0.1:47930${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" } });
  return r.json() as Promise<unknown>;
};

function hub(name: string): Bun.Subprocess {
  const log = createWriteStream(join(work, `${name}.log`));
  const p = Bun.spawn([join(dir, "harbor"), "--background"], { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  void (p.stdout as ReadableStream).pipeTo(new WritableStream({ write: (c) => void log.write(c) }));
  void (p.stderr as ReadableStream).pipeTo(new WritableStream({ write: (c) => void log.write(c) }));
  return p;
}

async function up(): Promise<boolean> {
  for (let i = 0; i < 150; i++) {
    try {
      await fetch("http://127.0.0.1:47930/");
      return true;
    } catch {
      await sleep(200);
    }
  }
  return false;
}

function runners(): { pid: number; cmd: string; exe: string }[] {
  const out: { pid: number; cmd: string; exe: string }[] = [];
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const cmd = readFileSync(`/proc/${d}/cmdline`, "utf8").split("\0");
      if (cmd[1] === "turn" && cmd[0]?.startsWith(dir)) out.push({ pid: Number(d), cmd: cmd.join(" "), exe: readlinkSync(`/proc/${d}/exe`) });
    } catch {
      // gone
    }
  }
  return out;
}

const aOut = Bun.spawnSync([join(dir, "harbor"), "--version"], { env }).stdout.toString().trim();
say(aOut.includes("0.109.0"), `the installed runtime A says: ${aOut}`);

const hubA = hub("hub-a");
say(await up(), "hub A (runtime A + bundle A) is serving the phone API");
const state = (await api("/v1/state")) as { version?: string };
say(state.version === "0.109.0", `hub A reports version ${state.version}`);
const made = (await api("/v1/chats", { method: "POST", body: JSON.stringify({ project_id: repo, account: "claude", text: "a turn that outlives its app" }) })) as { id: number };
let before = runners();
for (let i = 0; i < 50 && before.length === 0; i++) {
  await sleep(200);
  before = runners();
}
say(before.length === 1, `a runner of runtime A is running the turn: ${before.map((r) => `pid ${r.pid}`).join(", ")}`);
const runnerPid = before[0]?.pid ?? 0;
const itemsBefore = (await api(`/v1/chats/${made.id}/items?since=0`)) as { running: boolean; count: number };
say(itemsBefore.running === true, `chat ${made.id} is running before the swap (${itemsBefore.count} cards)`);

const root = join(work, "state", "harbor");
const turnDirs = (): string[] => readdirSync(root).filter((f) => f.startsWith("turns")).flatMap((t) => readdirSync(join(root, t)).map((f) => join(root, t, f)));
const folder = turnDirs()[0] ?? "";
for (let i = 0; i < 40 && text(join(folder, "pid")) === ""; i++) await sleep(100);
say(text(join(folder, "pid")) === String(runnerPid), `the turn folder names runner pid ${runnerPid}`);

const key = await makeKey();
const host = new FakeHost();
const manifest = JSON.stringify({ version: "0.110.0", minRuntime: "0.110.0", runtime: "0.110.0" });
await host.publish(key, "0.110.0", { "harbor-app.json": manifest, "harbor-app.js": readFileSync(B.bundle), "harbor-runtime-x86_64": readFileSync(B.runtime) });
const cfg = configFor({ dir, exe: join(dir, "harbor") }, { github: host.url, repo: host.repo, worker: host.url, pubkey: key.publicKey, version: "0.109.0", runtime: "0.109.0", arch: "x86_64" });
const done = await install(cfg, "0.110.0");
say(done.version === "0.110.0" && done.runtimeUpdated, "the updater installed 0.110.0 and replaced the runtime (signature checked against a throwaway key)");
say(sha(join(dir, "harbor")) === sha(B.runtime) && sha(join(dir, "harbor-app.js")) === sha(B.bundle), "the files in the install folder are runtime B and bundle B");
say(text(join(dir, "VERSION")) === "0.110.0" && text(join(dir, "RUNTIME")) === "0.110.0", "VERSION and RUNTIME say 0.110.0");

const during = runners();
say(during.length === 1 && during[0]?.pid === runnerPid, `the runner is the same process after the swap (pid ${during[0]?.pid})`);
say(during[0]?.exe.includes("(deleted)") === true || during[0]?.exe !== join(dir, "harbor"), `it still runs the old runtime's file: ${during[0]?.exe}`);
const mid = (await api(`/v1/chats/${made.id}/items?since=0`)) as { running: boolean };
say(mid.running === true, "the turn is still running after the swap");

hubA.kill("SIGTERM");
await hubA.exited;
const alive = runners();
say(alive.length === 1 && alive[0]?.pid === runnerPid, "the runner outlived hub A");

const bOut = Bun.spawnSync([join(dir, "harbor"), "--version"], { env }).stdout.toString().trim();
say(bOut.includes("0.110.0"), `the installed runtime now says: ${bOut}`);
const hubB = hub("hub-b");
say(await up(), "hub B (runtime B + bundle B) is serving the phone API");
const stateB = (await api("/v1/state")) as { version?: string };
say(stateB.version === "0.110.0", `hub B reports version ${stateB.version}`);
const picked = (await api(`/v1/chats/${made.id}/items?since=0`)) as { running: boolean };
say(picked.running === true, "hub B sees the turn as running: it picked it up");

let ended: { running: boolean; count: number; items: { kind: string; text?: string }[] } | null = null;
for (let i = 0; i < 120; i++) {
  await sleep(500);
  const v = (await api(`/v1/chats/${made.id}/items?since=0`)) as { running: boolean; count: number; items: { kind: string; text?: string }[] };
  if (!v.running && v.items.some((x) => x.kind === "text")) {
    ended = v;
    break;
  }
}
say(ended !== null, "the turn finished");
hubB.kill("SIGTERM");
await hubB.exited;
const db = Store.open(dataDir());
const items = db.items(made.id);
db.close();
const kinds = items.map((x) => x.kind);
say(kinds[0] === "user" && kinds.includes("text") && kinds.includes("result"), `the transcript in harbor.db has the question, the reply and the result: ${kinds.join(",")}`);
const reply = items.find((x) => x.kind === "text");
say(reply?.kind === "text" && reply.text.length > 200, `the reply is the whole streamed text (${reply?.kind === "text" ? reply.text.length : 0} characters), written after hub B picked the turn up`);
say(!existsSync(folder), "the turn folder was cleaned up when the turn ended");
say(runners().length === 0, "no runner is left");
rmSync(join(work, "scratch"), { recursive: true, force: true });
console.log(failed ? "SOME FAILED" : "ALL PASS");
process.exit(failed ? 1 : 0);
