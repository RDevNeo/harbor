import { afterAll } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

const clean = (): void => rmSync(dir, { recursive: true, force: true });
afterAll(clean);
process.on("exit", clean);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    clean();
    process.exit(128);
  });
}
