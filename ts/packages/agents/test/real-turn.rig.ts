//   bun packages/agents/test/real-turn.rig.ts [SCRATCH]
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { agent, detach, providers } from "../src/index.ts";
import type { Event } from "../src/agent.ts";

const starter = process.argv.includes("--starter");
const tmp = process.argv.find((a, i) => i > 1 && !a.startsWith("--")) ?? `${process.env.HOME}/.cache/hts/tmp-agents/real`;
if (!starter) rmSync(tmp, { recursive: true, force: true });
const work = join(tmp, "work");
const turns = join(tmp, "turns");
for (const d of [work, turns, join(tmp, "data"), join(tmp, "state")]) mkdirSync(d, { recursive: true });
// mise keeps its tools under XDG_DATA_HOME: the real one, so its shims find their installs.
process.env.MISE_DATA_DIR ??= join(process.env.HOME ?? "", ".local/share/mise");
process.env.XDG_DATA_HOME = join(tmp, "data");
process.env.XDG_STATE_HOME = join(tmp, "state");

const fail = (why: string): never => {
  console.error(`FAIL: ${why}`);
  process.exit(1);
};

const account = providers.discover().find((a) => a.id === "claude");
if (!account || !account.bin) fail("no Claude Code here");
const spec: agent.TurnSpec = {
  chatId: 77,
  cwd: work,
  prompt: "Reply with exactly the word: pong",
  files: [],
  sessionId: (process.env.HTS_SESSION ??= crypto.randomUUID()),
  resume: false,
  account: account as providers.Account,
  model: "claude-haiku-5-5",
  effort: "low",
  access: "plan",
  team: null,
  fast: false,
  base: 0,
  remote: null,
  trusted: false,
  context: agent.ownContext(),
};
const t0 = Date.now();
if (!starter) {
  // The first Harbor: starts the turn and quits while it runs.
  const r = Bun.spawnSync([process.execPath, import.meta.path, "--starter", tmp], { stdout: "pipe", stderr: "inherit", env: { ...process.env } });
  const out = r.stdout.toString();
  process.stdout.write(out);
  if (r.exitCode !== 0) fail("the starting Harbor failed");
  await pickUp(out.match(/^runner \d+ in (.+)$/m)?.[1] ?? fail("no turn folder"));
  rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}
const first: Event[] = [];
const turn = await agent.start(spec, (_id, ev) => first.push(ev), () => {}, turns);
console.log(`runner ${turn.meta.pid} in ${turn.dir}`);
const spec_ = JSON.parse(readFileSync(join(turn.dir, "cmd.json"), "utf8")) as Record<string, unknown>;
console.log(`cmd.json keys: ${Object.keys(spec_).join(",")}`);
if (readFileSync(`/proc/${turn.meta.pid}/cmdline`, "utf8").split("\0").indexOf("turn") < 0) fail("the runner isn't `harbor turn`");

// That Harbor quits once the session is known: the turn keeps running on its own.
for (let i = 0; i < 1500 && !first.some((e) => e.type === "session"); i++) await Bun.sleep(20);
turn.release();
await turn.done;
console.log(`the first Harbor quits after ${first.map((e) => e.type).join(" ")}`);
if (!existsSync(turn.dir)) fail("a released turn's folder must stay");
process.exit(0);

async function pickUp(dir: string): Promise<void> {
const left = detach.leftovers(turns);
detach.followOrder(left);
const found = left.find(([d]) => d === dir);
if (!found) fail("the running turn isn't among the leftovers");
const events: Event[] = [];
const again = agent.reattach(dir, (found as [string, detach.Meta])[1], (_id, ev) => {
  events.push(ev);
  // Claude's input stays open after its result: closed then, as the app does.
  if (ev.type === "result") again.closeInput();
});
const timer = setTimeout(() => fail(`no end after 120 s: ${JSON.stringify(events)}`), 120_000);
await again.done;
clearTimeout(timer);
const text = events.flatMap((e) => (e.type === "textFinal" ? [e.text] : [])).join("");
const exited = events.find((e) => e.type === "exited");
console.log(`replayed: ${events.map((e) => e.type).join(" ")}`);
console.log(`answer: ${JSON.stringify(text)} in ${Date.now() - t0} ms`);
for (const e of events) if (e.type === "error" || e.type === "stderr") console.log(`${e.type}: ${e.text}`);
if (!exited || exited.type !== "exited" || !exited.ok) fail("the turn didn't end well");
if (!/pong/i.test(text)) fail("no pong");
if (!events.some((e) => e.type === "session" && e.id === spec.sessionId)) fail("the replay didn't start from the beginning");
console.log("PASS: a real Claude turn ran detached under `harbor turn`, outlived the Harbor that started it and was picked up by the next one");
}
