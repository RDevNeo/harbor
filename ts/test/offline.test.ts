import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankChat, dataDir, Store } from "../packages/store/src/index.ts";

const root = mkdtempSync(join(tmpdir(), `hbt-${process.pid}-offline-`));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// The db mirrors one ts/run.sh copies: things due that would act on their own.
function start(name: string, offline: boolean): { trap: string; started: string; proc: Bun.Subprocess } {
  const dir = join(root, name);
  const env: Record<string, string> = {
    HOME: join(dir, "home"),
    XDG_DATA_HOME: join(dir, "data"),
    XDG_STATE_HOME: join(dir, "state"),
    XDG_CACHE_HOME: join(dir, "cache"),
    XDG_CONFIG_HOME: join(dir, "config"),
    XDG_RUNTIME_DIR: join(dir, "run"),
    HARBOR_SOCK: join(dir, "run", "harbor.sock"),
    HARBOR_LISTEN: "127.0.0.1",
    HARBOR_TEST_NO_SIGNIN: "1",
    HARBOR_TEST_TRAP: join(dir, "trap.log"),
  };
  if (offline) env.HARBOR_OFFLINE = "1";
  for (const d of ["home", "state", "cache", "config", "run", "bin", "project"]) mkdirSync(join(dir, d), { recursive: true });
  const started = join(dir, "started");
  writeFileSync(join(dir, "bin", "claude"), `#!/bin/sh\n[ "$1" = --version ] && { echo '2.1.0 (Claude Code)'; exit 0; }\ntouch '${started}'\n`);
  chmodSync(join(dir, "bin", "claude"), 0o755);
  writeFileSync(env.HARBOR_TEST_TRAP as string, "");

  const store = Store.open(dataDir(env));
  const repo = store.addRepo(join(dir, "project"));
  const chat = store.createChat(blankChat({ repoId: repo, title: "copied", account: "claude", started: true, sessionId: "00000000-0000-4000-a000-000000000001" }));
  const past = Math.floor(Date.now() / 1000) - 60;
  store.addTimer(chat.id, past, "check the deploy");
  store.addLimitTimer(chat.id, past, "usage limit");
  store.set("limits", `{"blocks":{},"paused":{"${chat.id}":{"account":"claude","resume":true,"at":${past},"timer":null}},"pending":{"${chat.id}":["continue the work"]},"quota":{}}`);
  store.set("mesh_peers", JSON.stringify([{ id: "peer", name: "desk", addr: "127.0.0.1:9", dns: "", online: true, seen: past, version: "1.0.0", accounts: [], node: "", phones: false, fp: "ab", addrs: ["127.0.0.1:9"], owner: "", github: "", owner_suggested: false, update: null, moves: false }]));
  store.set("mesh_enabled", "1");
  store.set("api_enabled", "1");
  store.set("api_port", String(20000 + (process.pid % 20000)));
  store.addWebhook(repo, "deploys", "tok-offline", "");
  store.close();

  const entry = join(import.meta.dir, "..", "harbor.ts");
  const proc = Bun.spawn([process.execPath, "--preload", join(import.meta.dir, "trap.ts"), entry, "--background"], {
    env: { ...env, PATH: `${join(dir, "bin")}:/usr/bin:/bin` },
    stdout: "ignore",
    stderr: "ignore",
  });
  return { trap: env.HARBOR_TEST_TRAP as string, started, proc };
}

/** Lets Harbor run for 8 s; `until` (what the run should come to) keeps it going until then, up to 30 s: a slow
 *  sandbox may take longer than 8 s to start Harbor at all. */
async function settle(run: { proc: Bun.Subprocess }, until?: () => boolean): Promise<void> {
  const t = Date.now();
  await Bun.sleep(8000);
  while (until && !until() && Date.now() - t < 30_000) await Bun.sleep(100);
  run.proc.kill("SIGTERM");
  await run.proc.exited;
}

test("offline_mode_starts_no_turn_and_connects_nowhere", async () => {
  const run = start("offline", true);
  await settle(run);
  expect(readFileSync(run.trap, "utf8")).toBe("");
  expect(existsSync(run.started)).toBe(false);
}, 30_000);

// The same db without the switch: the wake-up starts a turn and discovery broadcasts, so the test above would see them.
test("without_offline_the_same_db_acts_on_its_own", async () => {
  const run = start("online", false);
  await settle(run, () => existsSync(run.started) && readFileSync(run.trap, "utf8") !== "");
  expect(readFileSync(run.trap, "utf8")).not.toBe("");
  expect(existsSync(run.started)).toBe(true);
}, 45_000);
