import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as stallwatch from "../src/stallwatch.ts";

const lines: string[] = [];
const stop = stallwatch.start((l) => lines.push(l), { stallMs: 150, beatMs: 50, quietMs: 0 });
stallwatch.hookSqlite();
afterAll(stop);

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

function spin(ms: number): void {
  const t = performance.now();
  while (performance.now() - t < ms) {
    // busy
  }
}

test("a busy main thread is logged with its label and running samples", async () => {
  await tick(200);
  lines.length = 0;
  stallwatch.within("busy test", () => spin(500));
  await tick(200);
  expect(lines.length).toBe(1);
  expect(lines[0]).toContain("main thread blocked");
  expect(lines[0]).toContain("in busy test");
  const last = stallwatch.seen.last.at(-1);
  expect(last?.label).toBe("busy test");
  expect(last?.ms ?? 0).toBeGreaterThan(300);
  if (process.platform === "linux") {
    expect(last?.running ?? 0).toBeGreaterThan(0);
    expect(last?.cpuMs ?? 0).toBeGreaterThan(100);
  }
});

test("a main thread that sleeps synchronously shows as sleeping, short ones not at all", async () => {
  lines.length = 0;
  const count = stallwatch.seen.count;
  spin(60);
  await tick(200);
  expect(stallwatch.seen.count).toBe(count);
  stallwatch.within("sleep test", () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500));
  await tick(200);
  expect(lines.length).toBe(1);
  const last = stallwatch.seen.last.at(-1);
  expect(last?.label).toBe("sleep test");
  if (process.platform === "linux") expect(last?.sleeping ?? 0).toBeGreaterThan(0);
}, 10_000);

test("SQLite statements and synchronous processes carry their own labels", async () => {
  const db = new Database(":memory:");
  db.query("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 4000000) SELECT count(*) AS n FROM c").get();
  await tick(200);
  expect(stallwatch.seen.last.at(-1)?.label).toStartWith("sqlite WITH RECURSIVE");
  Bun.spawnSync(["sleep", "0.4"]);
  await tick(200);
  expect(stallwatch.seen.last.at(-1)?.label).toBe("spawnSync sleep");
}, 10_000);

test.skipIf(process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))("a main thread stuck in a file syscall names the file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hstall-"));
  const fifo = join(dir, "slow-file");
  Bun.spawnSync(["mkfifo", fifo]);
  // Opening a FIFO for reading blocks until a writer comes: here, 500 ms later.
  Bun.spawn(["sh", "-c", `sleep 0.5; echo x > '${fifo}'`]);
  readFileSync(fifo);
  await tick(200);
  const last = stallwatch.seen.last.at(-1);
  expect(last?.syscall).toContain(fifo);
  expect(lines.at(-1)).toContain(fifo);
  rmSync(dir, { recursive: true, force: true });
}, 10_000);
