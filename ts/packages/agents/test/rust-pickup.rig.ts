//   bun packages/agents/test/rust-pickup.rig.ts [RUST_HARBOR] [SCRATCH]
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agent, detach } from "../src/index.ts";
import type { Event } from "../src/agent.ts";

const rust = process.argv[2] ?? `${process.env.HOME}/.local/bin/harbor`;
const tmp = process.argv[3] ?? `${process.env.HOME}/.cache/hts/tmp-agents/pickup`;
rmSync(tmp, { recursive: true, force: true });
const home = join(tmp, "home");
for (const d of [home, join(tmp, "state"), join(tmp, "data")]) mkdirSync(d, { recursive: true });
process.env.HOME = home;
process.env.XDG_STATE_HOME = join(tmp, "state");
process.env.XDG_DATA_HOME = join(tmp, "data");

const fail = (why: string): never => {
  console.error(`FAIL: ${why}`);
  process.exit(1);
};

// The Rust app's folder for this data dir, and ours: the same FNV-1a name.
const root = detach.root();
const version = Bun.spawnSync(["unshare", "-Urn", "env", `HOME=${home}`, rust, "--version"], { stdout: "pipe" }).stdout.toString().trim();
console.log(`rust: ${version}\nroot: ${root}`);

// A Claude-shaped agent: init and a first answer, then each stdin line after the first is a
// message written mid-turn, echoed and answered; a result once its input ends.
const agentSh = join(tmp, "claude");
writeFileSync(
  agentSh,
  `#!/bin/sh
read -r first
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"s-rust","mcp_servers":[{"name":"harbor","status":"connected"}]}'
printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"first answer"}]}}'
while read -r line; do
  printf '{"type":"user","isReplay":true,"message":{"content":[{"type":"text","text":"echo"}]}}\\n'
  printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"second answer"}]}}'
  echo "seen mid-turn" >&2
done
printf '%s\\n' '{"type":"result","subtype":"success","total_cost_usd":0.01,"duration_ms":5,"num_turns":2,"usage":{"input_tokens":3,"output_tokens":4}}'
`,
);
chmodSync(agentSh, 0o755);

// What the Rust app writes before it starts the runner (detach.rs `spawn`).
const cmd = detach.command(agentSh);
cmd.args.push("-p", "--input-format", "stream-json");
cmd.cwd = tmp;
cmd.env.set("PATH", process.env.PATH ?? "/usr/bin:/bin");
const dir = join(root, `42-${BigInt(Date.now()) * 1000000n}`);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "cmd.json"), detach.cmdJson(cmd, true, false));
writeFileSync(join(dir, "in"), agent.claudeMessage("first", []));
const started = Math.floor(Date.now() / 1000);
Bun.spawnSync(["unshare", "-Urn", "env", `HOME=${home}`, `XDG_STATE_HOME=${join(tmp, "state")}`, `XDG_DATA_HOME=${join(tmp, "data")}`, "setsid", "-f", rust, "turn", dir], {
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
});
let pid = 0;
for (let i = 0; i < 500 && pid === 0; i++) {
  if (existsSync(join(dir, "pid"))) pid = Number(readFileSync(join(dir, "pid"), "utf8").trim());
  else await Bun.sleep(10);
}
if (!pid) fail("the Rust runner didn't start");
const { procStart } = await import("../src/procfs.ts");
const meta: detach.Meta = { chat_id: 42, kind: "Claude", started, base: 3, pid, pid_start: procStart(pid) ?? 0 };
writeFileSync(join(dir, "meta.json"), detach.metaJson(meta));
console.log(`rust runner pid ${pid}, cmdline: ${readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ")}`);

// A TypeScript Harbor starting now.
const live = detach.runners(root);
if (!live.some(([chat, d, p]) => chat === 42 && d === dir && p === pid)) fail(`runners() doesn't see the Rust runner: ${JSON.stringify(live)}`);
const left = detach.leftovers(root);
detach.followOrder(left);
const found = left.find(([d]) => d === dir);
if (!found) fail("leftovers() doesn't list the turn");
const [, m] = found as [string, detach.Meta];
if (m.pid !== pid || m.base !== 3) fail(`meta read back wrong: ${JSON.stringify(m)}`);

const events: Event[] = [];
let ended = false;
const turn = agent.reattach(dir, m, (_id, ev) => events.push(ev), (e) => (ended ||= e));
const waitFor = async (what: string, f: () => boolean): Promise<void> => {
  for (let i = 0; i < 500; i++) {
    if (f()) return;
    await Bun.sleep(20);
  }
  fail(`timed out waiting for ${what}; events: ${JSON.stringify(events)}`);
};
await waitFor("the first answer", () => events.some((e) => e.type === "textFinal" && e.text === "first answer"));
if (turn.steering() !== "active") fail("a Claude turn with open input should take a steer");
if (!turn.write("second")) fail("couldn't write to the Rust runner's input");
await waitFor("the second answer", () => events.some((e) => e.type === "textFinal" && e.text === "second answer"));
turn.closeInput();
await turn.done;
if (!ended) fail("wake(true) never came");
const exited = events.find((e) => e.type === "exited");
if (!exited || exited.type !== "exited" || !exited.ok) fail(`the turn didn't end well: ${JSON.stringify(exited)}`);
if (!events.some((e) => e.type === "session" && e.id === "s-rust")) fail("no session event");
if (!events.some((e) => e.type === "stderr" && e.text === "seen mid-turn")) fail("no stderr event");
const result = events.find((e) => e.type === "result");
if (!result || result.type !== "result" || result.costUsd !== 0.01) fail(`result wrong: ${JSON.stringify(result)}`);
if (existsSync(dir)) fail("the finished turn's folder is still there");
console.log(`events: ${events.map((e) => e.type).join(" ")}`);
console.log("PASS: a turn the Rust runner started was picked up, written to mid-turn and finished by the TypeScript side");
rmSync(tmp, { recursive: true, force: true });
