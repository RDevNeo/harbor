import { afterEach, expect, test } from "bun:test";
import { abandonStart } from "../src/handoff.ts";
import { beginAttempt, readAttempt, watch } from "../src/startup.ts";
import { cleanup, configFor, makeInstall, windowsTime } from "./support.ts";

windowsTime();

afterEach(cleanup);

const attempt = (pid: number) => ({ version: "1.1.0", pid, kind: "release" as const, args: [], id: "" });

test("a start handed to another process (Windows' Run as administrator) leaves no attempt for the watchdog, and only its own", async () => {
  const inst = makeInstall();
  const cfg = configFor(inst);
  beginAttempt(cfg, attempt(process.pid + 1));
  abandonStart(cfg);
  expect(readAttempt(inst.dir)?.pid).toBe(process.pid + 1);
  beginAttempt(cfg, attempt(process.pid));
  abandonStart(cfg);
  expect(readAttempt(inst.dir)).toBeNull();
  // The watchdog then ends quietly: nothing failed, nothing rolled back.
  let relaunched = false;
  expect(await watch(configFor(inst, { sleep: async () => undefined }), process.pid, { relaunch: () => (relaunched = true), kill: () => {} })).toBe(0);
  expect(relaunched).toBe(false);
});
