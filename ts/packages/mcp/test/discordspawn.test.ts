import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { request, status } from "../src/discord.ts";
import * as setup from "../src/discordsetup.ts";
import { Host, Electron, Policy, listen } from "../src/discordhost.ts";
import { rig, until } from "./discordkit.ts";

let r: ReturnType<typeof rig>;
let pidFile = "";

beforeAll(() => {
  r = rig();
  pidFile = join(r.box.dir, "host.pid");
  process.env.HARBOR_DISCORD_HOST_PID = pidFile;
  process.env.HARBOR_DISCORD_IDLE = "1";
  process.env.HARBOR_DISCORD_QUIT_IDLE = "1";
  process.env.HARBOR_DISCORD_NO_SWAP = "1";
  process.env.SECRET_FOR_AGENTS = "must not reach the host";
  setup.configure({ selfCommand: () => [process.execPath, join(import.meta.dir, "fakeharbor.ts")] });
});
afterAll(async () => {
  if (existsSync(pidFile)) {
    try {
      process.kill(Number(readFileSync(pidFile, "utf8")), "SIGTERM");
    } catch {
      // already gone
    }
  }
  delete process.env.SECRET_FOR_AGENTS;
  setup.configure({ selfCommand: () => undefined });
  r.box.restore();
});

test("a request starts the host when nobody is there, and one host holds the lock", async () => {
  expect(existsSync(setup.socket())).toBe(false);
  const reply = (await request({ op: "status" }, 5000)) as Record<string, unknown>;
  expect(reply.phase).toBe("stopped");
  expect(reply.electron).toBe(setup.ELECTRON);
  expect(existsSync(pidFile)).toBe(true);
  expect(((await status()) as Record<string, unknown>).phase).toBe("stopped");

  const other = new Host({ engine: new Electron(setup.profile(), () => {}), scratch: new Electron(join(setup.root(), "scratch"), () => {}), policy: new Policy(1, 1, 1, 1) });
  expect(await listen(other)).toBeUndefined();

  const call = (await request({ op: "call", name: "discord_view", args: { a: 1 } }, 20_000)) as Record<string, unknown>;
  expect(call).toEqual({ ran: "discord_view", args: { a: 1 } });
  const env = JSON.parse(readFileSync(`${pidFile}.env`, "utf8")) as string[];
  expect(env).not.toContain("SECRET_FOR_AGENTS");
  expect(env).toContain("HARBOR_DISCORD_ELECTRON");
  expect(env).toContain("XDG_DATA_HOME");
}, 40_000);

test("an idle host quits with its client and goes away by itself", async () => {
  const pid = Number(readFileSync(pidFile, "utf8"));
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }, 40_000);
  expect(existsSync(setup.socket())).toBe(false);
}, 50_000);
