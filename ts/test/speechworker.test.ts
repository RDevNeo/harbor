import { expect, test } from "bun:test";
import { join } from "node:path";
import { parakeet } from "../packages/media/src/index.ts";

test("harbor --speech-worker answers a request on stdin and exits when it closes", async () => {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "harbor.ts"), "--speech-worker"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write('{"op":"nothing","n":0}\n');
  await proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  expect(JSON.parse(out.trim())).toEqual({ error: "unknown request" });
});

test("the worker runs on the compiled binary itself only when compiled", () => {
  expect(parakeet.compiled()).toBe(false);
  parakeet.useOwnBinaryForWorker();
  expect(parakeet.workerPid()).toBeNull();
});
