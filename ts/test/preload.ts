import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const base = tmpdir();

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e instanceof Error && "code" in e && e.code === "EPERM";
  }
}

for (const name of readdirSync(base)) {
  const m = /^hbt-(\d+)-/.exec(name);
  if (m && !alive(Number(m[1]))) rmSync(join(base, name), { recursive: true, force: true });
}

const dir = mkdtempSync(join(base, `hbt-${process.pid}-`));
process.env.TMPDIR = dir;
// No test reaches the user's own Harbor: its data folder (the bridge's port file, harbor.db), state, config and
// instance lock. A test that served the bridge here once pointed every running turn's MCP servers at a port that closed.
const sandbox = join(dir, "user");
// The cache stays the user's: bun's transpiler cache there keeps the processes tests start quick.
process.env.XDG_CACHE_HOME ||= join(homedir(), ".cache");
for (const [k, sub] of [["HOME", "home"], ["XDG_DATA_HOME", "data"], ["XDG_STATE_HOME", "state"], ["XDG_CONFIG_HOME", "config"], ["XDG_RUNTIME_DIR", "run"]] as const) {
  process.env[k] = join(sandbox, sub);
  mkdirSync(process.env[k] ?? "", { recursive: true, mode: 0o700 });
}
delete process.env.HARBOR_SOCK;

const clean = (): void => rmSync(dir, { recursive: true, force: true });
afterAll(clean);
process.on("exit", clean);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    clean();
    process.exit(128);
  });
}
