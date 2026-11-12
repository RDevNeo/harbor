import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Store } from "@harbor/store";
import { Engine } from "../src/engine.ts";
import * as procs from "../src/procs.ts";
import { reap } from "./reap.ts";

const base = mkdtempSync(join(tmpdir(), "hts-procrestart-"));
afterAll(() => {
  reap(base);
  rmSync(base, { recursive: true, force: true });
});

async function until(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!ready() && Date.now() < deadline) await Bun.sleep(20);
  expect(ready()).toBe(true);
}

// Unlike an in-process adopt() test, the controller really dies here. Where a user's systemd runs,
// kill its entire scope too: detached:true alone cannot protect a job from its parent's cgroup.
async function restart(scoped: boolean, finishWhileAway: boolean): Promise<void> {
  const dir = join(base, crypto.randomUUID());
  mkdirSync(dir);
  const db = join(dir, "harbor.db");
  const gate = join(dir, "continue");
  const handoff = join(dir, "handoff.json");
  const helper = join(dir, "controller.ts");
  const code = finishWhileAway ? 0 : 7;
  const command = `echo before; echo error-output >&2; while [ ! -f '${gate}' ]; do sleep 0.02; done; echo after; exit ${code}`;
  writeFileSync(helper, `
import { writeFileSync } from "node:fs";
import { Store } from ${JSON.stringify(join(import.meta.dir, "../../store/src/index.ts"))};
import * as procs from ${JSON.stringify(join(import.meta.dir, "../src/procs.ts"))};
const store = Store.openAt(${JSON.stringify(db)});
const blank = { id: 0, repoId: null, title: "process restart", sessionId: "s", started: false, account: "test", model: "", effort: "", access: "full" as const, settled: false, updated: 0, parent: null, name: "", device: "", gid: "", home: "", homeId: 0, retired: false };
const lead = store.createChat({ ...blank, role: "lead" });
const owner = store.createChat({ ...blank, role: "sub", parent: lead.id });
const p = await procs.spawn(store, { name: "survivor", cmd: ${JSON.stringify(command)}, cwd: ${JSON.stringify(dir)}, repoId: null, lead: lead.id, owner: owner.id }, () => {});
writeFileSync(${JSON.stringify(handoff)}, JSON.stringify(store.procs()[0]));
setInterval(() => {}, 1000);
`);
  const unit = `harbor-process-test-${crypto.randomUUID()}.scope`;
  const argv = scoped ? ["systemd-run", "--user", "--scope", "--quiet", "--collect", `--unit=${unit}`, "--", process.execPath, helper] : [process.execPath, helper];
  const controller = Bun.spawn(argv, {
    env: { ...process.env, XDG_STATE_HOME: join(dir, "state"), XDG_DATA_HOME: join(dir, "data"), XDG_RUNTIME_DIR: scoped ? `/run/user/${process.getuid?.()}` : process.env.XDG_RUNTIME_DIR, HARBOR_TURN_SCOPE: scoped ? "1" : "0", HARBOR_ENTRY: join(import.meta.dir, "../../../harbor.ts"), GITHUB_TOKEN: "not-for-cmd-json" },
    stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  let store: Store | undefined;
  let pid: number | undefined;
  try {
    await until(() => existsSync(handoff));
    const row = JSON.parse(readFileSync(handoff, "utf8")) as { id: number; pid: number; startTicks: number; log: string; owner: number };
    pid = row.pid;
    await until(() => procs.tailFile(row.log, 10).includes("error-output"));
    expect(readFileSync(join(dirname(row.log), "cmd.json"), "utf8")).not.toContain("not-for-cmd-json");
    if (scoped) {
      const cg = readFileSync(`/proc/${row.pid}/cgroup`, "utf8");
      expect(cg).toContain("/harbor-turns.slice/");
      expect(cg).not.toContain(unit);
      expect(Bun.spawnSync(["systemctl", "--user", "kill", "--signal=SIGKILL", unit], { env: { ...process.env, XDG_RUNTIME_DIR: `/run/user/${process.getuid?.()}` } }).exitCode).toBe(0);
    } else controller.kill("SIGKILL");
    await controller.exited;
    expect(procs.alive(row.pid, row.startTicks)).toBe(true);
    if (finishWhileAway) {
      writeFileSync(gate, "");
      await until(() => existsSync(join(dirname(row.log), "exit")));
    }
    store = Store.openAt(db);
    const engine = new Engine({ store, accounts: () => [], changed: () => {} });
    const reports: [number, string][] = [];
    engine.trigger = (owner, message) => { reports.push([owner, message]); };
    engine.adoptProcs();
    expect(engine.procs.map((p) => p.pid)).toEqual([row.pid]);
    if (!finishWhileAway) {
      expect(engine.procs[0]?.tail(10)).toContain("before");
      writeFileSync(gate, "");
    }
    await until(() => reports.length > 0);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.[0]).toBe(row.owner);
    expect(reports[0]?.[1]).toContain(code === 0 ? "finished" : "exited with code 7");
    expect(reports[0]?.[1]).toContain("error-output");
    expect(reports[0]?.[1]).toContain("after");
    expect(engine.procs).toEqual([]);
    expect(store.procs()).toEqual([]);
    expect(existsSync(dirname(row.log))).toBe(false);
    // A second restart cannot send the completed job again.
    engine.adoptProcs();
    await Bun.sleep(30);
    expect(reports).toHaveLength(1);
  } finally {
    controller.kill("SIGKILL");
    if (pid !== undefined) procs.signalGroup("SIGKILL", pid);
    if (scoped) Bun.spawnSync(["systemctl", "--user", "stop", unit], { env: { ...process.env, XDG_RUNTIME_DIR: `/run/user/${process.getuid?.()}` }, stdout: "ignore", stderr: "ignore" });
    store?.close();
  }
}

test("a running job survives its controller's death and reports its exit to the owning chat", () => restart(false, false), 15_000);
test("a job that finished while Harbor was away keeps its log and successful exit report", () => restart(false, true), 15_000);
test.skipIf(!existsSync(`/run/user/${process.getuid?.()}/systemd/private`))("a job survives killing Harbor's entire systemd scope during a restart", () => restart(true, false), 15_000);
