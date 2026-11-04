import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceSpeech, SETUP_COMMAND, SPEECH_SSH, answerBudgetMs, serveCommand } from "../src/devicespeech.ts";
import { WORKER_PY, WORKER_VERSION, setupScript } from "../src/devicespeech-scripts.ts";

/** A fake ssh: the remote command picks a fake worker or a fake setup (bun scripts), as `mode` says. */
const FAKE_WORKER = String.raw`
const mode = process.argv[2];
if (mode === "missing") { process.stderr.write("sh: 1: exec: /home/sam/.harbor-voice/serve: not found\n"); process.exit(127); }
if (mode === "unreachable") { process.stderr.write("ssh: connect to host laptop port 22: No route to host\n"); process.exit(255); }
process.stdout.write(JSON.stringify({ hello: 1, version: mode === "old" ? "0" : process.argv[3], engine: "fake-engine" }) + "\n");
let buf = Buffer.alloc(0);
let loaded = false;
process.stdin.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const nl = buf.indexOf(10);
    if (nl < 0) return;
    const req = JSON.parse(buf.subarray(0, nl).toString());
    const n = req.bytes ?? 0;
    if (buf.length < nl + 1 + n) return;
    const body = buf.subarray(nl + 1, nl + 1 + n);
    buf = buf.subarray(nl + 1 + n);
    if (mode === "silent") continue;
    const cold = !loaded;
    loaded = true;
    if (req.op === "warm") process.stdout.write(JSON.stringify({ ok: true, op: "warm", cold }) + "\n");
    else process.stdout.write(JSON.stringify({ ok: true, text: "heard " + body.length / 2 + " samples in " + req.lang, model: "fake-engine", cold }) + "\n");
  }
});
process.stdin.on("end", () => process.exit(0));
`;
const FAKE_SETUP = String.raw`
const out = process.argv[2];
let got = "";
process.stdin.on("data", (d) => (got += d));
process.stdin.on("end", () => {
  require("node:fs").writeFileSync(out, got);
  process.stdout.write("step: getting uv\nstep: getting the speech model\n");
  if (process.argv[3] === "fail") { process.stdout.write("error: less than 4 GB free in /home/sam\n"); process.exit(3); }
  process.stdout.write("done: fake\n");
  process.exit(0);
});
`;

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function rig(mode: { worker: string; setup?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "devspeech-"));
  dirs.push(dir);
  writeFileSync(join(dir, "worker.js"), FAKE_WORKER);
  writeFileSync(join(dir, "setup.js"), FAKE_SETUP);
  const spawned: string[][] = [];
  let at = 1_000_000;
  const speech = new DeviceSpeech({
    devices: () => [{ id: "ssh:1", name: "laptop", ssh: ["-o", "BatchMode=yes", "--", "laptop"] }],
    keepSecs: () => 300,
    now: () => at,
    spawn: (args) => {
      spawned.push(args);
      const cmd = args.at(-1);
      if (cmd === SETUP_COMMAND) return spawn(process.execPath, [join(dir, "setup.js"), join(dir, "got.sh"), mode.setup ?? "ok"], { stdio: ["pipe", "pipe", "pipe"] });
      return spawn(process.execPath, [join(dir, "worker.js"), mode.worker, WORKER_VERSION], { stdio: ["pipe", "pipe", "pipe"] });
    },
  });
  return { speech, spawned, dir, mode, tick: (ms: number) => void (at += ms) };
}

const until = async (ok: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("device speech", () => {
  test("the worker runs over the device's ssh, answers in order, and says how warm it was", async () => {
    const r = rig({ worker: "ok" });
    expect(r.speech.list()).toEqual([{ id: "ssh:1", name: "laptop" }]);
    r.speech.warm("ssh:1");
    await until(() => r.speech.state("ssh:1").startsWith("Ready, model loaded"));
    expect(r.spawned).toEqual([[...SPEECH_SSH, "-o", "BatchMode=yes", "--", "laptop", serveCommand(300)]]);
    const one = await r.speech.transcribe("ssh:1", new Int16Array(16000), "auto");
    expect(one).toEqual({ text: "heard 16000 samples in auto", model: "fake-engine warm" });
    const two = await Promise.all([r.speech.transcribe("ssh:1", new Int16Array(800), "auto"), r.speech.transcribe("ssh:1", new Int16Array(1600), "pt")]);
    expect(two.map((x) => x.text)).toEqual(["heard 800 samples in auto", "heard 1600 samples in pt"]);
    // One ssh for all of them.
    expect(r.spawned.length).toBe(1);
    r.speech.stop();
  });

  test("a device without the worker is set up in the background, then transcribes", async () => {
    const r = rig({ worker: "missing" });
    const e = await r.speech.transcribe("ssh:1", new Int16Array(1600), "auto").catch((x: unknown) => x);
    expect(String(e)).toContain("laptop is being set up to transcribe");
    expect(r.spawned.at(-1)?.at(-1)).toBe(SETUP_COMMAND);
    await until(() => !r.speech.state("ssh:1").startsWith("Setting up"));
    expect(r.speech.state("ssh:1")).toBe("");
    // It got the whole script, the worker inside.
    const got = readFileSync(join(r.dir, "got.sh"), "utf8");
    expect(got).toBe(setupScript());
    expect(got).toContain(WORKER_PY);
    r.mode.worker = "ok";
    expect((await r.speech.transcribe("ssh:1", new Int16Array(1600), "auto")).model).toBe("fake-engine cold");
    r.speech.stop();
  });

  test("a failed setup says why and isn't retried until picked again", async () => {
    const r = rig({ worker: "missing", setup: "fail" });
    r.speech.warm("ssh:1");
    await until(() => r.speech.state("ssh:1").startsWith("Couldn't"));
    expect(r.speech.state("ssh:1")).toBe("Couldn't set it up: less than 4 GB free in /home/sam");
    const n = r.spawned.length;
    const e = await r.speech.transcribe("ssh:1", new Int16Array(1600), "auto").catch((x: unknown) => x);
    expect(String(e)).toContain("laptop couldn't be set up to transcribe: less than 4 GB free");
    expect(r.spawned.filter((a) => a.at(-1) === SETUP_COMMAND).length).toBe(1);
    expect(r.spawned.length).toBe(n + 1);
    r.speech.prepare("ssh:1");
    expect(r.spawned.filter((a) => a.at(-1) === SETUP_COMMAND).length).toBe(2);
    await until(() => r.speech.state("ssh:1").startsWith("Couldn't"));
  });

  test("an unreachable device fails at once for a while, then is tried again", async () => {
    const r = rig({ worker: "unreachable" });
    const e = await r.speech.transcribe("ssh:1", new Int16Array(1600), "auto").catch((x: unknown) => x);
    expect(String(e)).toContain("connect to host laptop port 22: No route to host");
    expect(r.speech.state("ssh:1")).toStartWith("Not reachable:");
    const again = await r.speech.transcribe("ssh:1", new Int16Array(1600), "auto").catch((x: unknown) => x);
    expect(String(again)).toContain("No route to host");
    expect(r.spawned.length).toBe(1);
    r.tick(31_000);
    r.mode.worker = "ok";
    expect((await r.speech.transcribe("ssh:1", new Int16Array(1600), "auto")).text).toBe("heard 1600 samples in auto");
    r.speech.stop();
  });

  test("an older worker answers while the new one is put in place", async () => {
    const r = rig({ worker: "old" });
    expect((await r.speech.transcribe("ssh:1", new Int16Array(1600), "auto")).text).toBe("heard 1600 samples in auto");
    expect(r.spawned.filter((a) => a.at(-1) === SETUP_COMMAND).length).toBe(1);
    await until(() => !r.speech.state("ssh:1").startsWith("Setting up"));
    r.speech.stop();
  });

  test("the answer's time allows for a cold model and long recordings", () => {
    expect(answerBudgetMs(10, true)).toBe(10_000);
    expect(answerBudgetMs(10, false)).toBe(34_000);
    expect(answerBudgetMs(600, true)).toBe(246_000);
  });

  test("the setup script is POSIX sh, and its versions agree", () => {
    const s = setupScript();
    expect(s).toContain(`VERSION=${WORKER_VERSION}\n`);
    expect(WORKER_PY).toContain(`VERSION = "${WORKER_VERSION}"`);
    expect(s).not.toContain("@WORKER@");
    const sh = spawnSync("sh", ["-n"], { input: s });
    expect(sh.status).toBe(0);
    // The serve command quotes nothing fish or sh would read differently.
    expect(serveCommand(300)).toBe(`sh -c 'exec "$HOME/.harbor-voice/serve" 300'`);
  });
});
