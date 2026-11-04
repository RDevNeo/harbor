import "./sandbox.ts";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { claim, close, owner, ownerAlive, parsePortFile, port, portFile, portLine, reclaim } from "../src/bridge.ts";

const primary = owner.primary;
const read = () => parsePortFile(readFileSync(portFile(), "utf8"));
/** A pid nothing runs as anymore. */
const gonePid = (): number => {
  const p = Bun.spawnSync(["true"]);
  return p.pid;
};

beforeAll(async () => {
  await close();
  reclaim.ms = 100;
});
afterEach(() => {
  owner.primary = primary;
});
afterAll(async () => {
  await close();
  reclaim.ms = 5000;
});

test("the port file names the port and the process serving it; an older Harbor's plain port still reads", async () => {
  const p = await port();
  expect(p).not.toBeNull();
  const o = read();
  expect(o?.port).toBe(p as number);
  expect(o?.pid).toBe(process.pid);
  expect(o && ownerAlive(o)).toBe(true);
  expect(parsePortFile("47940\n")).toEqual({ port: 47940, pid: null, start: null });
  expect(parsePortFile("47941 123 456\n")).toEqual({ port: 47941, pid: 123, start: 456 });
  expect(parsePortFile(portLine(47942, 7, null))).toEqual({ port: 47942, pid: 7, start: null });
  expect(parsePortFile("nope")).toBeNull();
  expect(parsePortFile("70000 1")).toBeNull();
  // An older Harbor's writer is unknown: taken as running, as before.
  expect(ownerAlive({ port: 1, pid: null, start: null })).toBe(true);
  expect(ownerAlive({ port: 1, pid: gonePid(), start: null })).toBe(false);
});

test("a file left by a process that has gone is taken back within moments", async () => {
  const p = await port();
  owner.primary = () => false;
  writeFileSync(portFile(), portLine(1, gonePid(), null));
  await Bun.sleep(400);
  expect(read()).toMatchObject({ port: p as number, pid: process.pid });
});

test("another bridge that still serves keeps the file, unless this is the session's Harbor", async () => {
  const p = await port();
  const other = Bun.spawn(["sleep", "30"]);
  try {
    owner.primary = () => false;
    writeFileSync(portFile(), portLine(2, other.pid, null));
    claim();
    expect(read()).toMatchObject({ port: 2, pid: other.pid });
    // A plain port (an older Harbor's) is left to the session's Harbor too.
    writeFileSync(portFile(), "3\n");
    claim();
    expect(read()).toMatchObject({ port: 3, pid: null });
    owner.primary = () => true;
    claim();
    expect(read()).toMatchObject({ port: p as number, pid: process.pid });
  } finally {
    other.kill();
  }
});

test("close removes the file only while it still names this process", async () => {
  await port();
  owner.primary = () => false;
  const other = Bun.spawn(["sleep", "30"]);
  try {
    writeFileSync(portFile(), portLine(4, other.pid, null));
    await close();
    expect(read()).toMatchObject({ port: 4, pid: other.pid });
  } finally {
    other.kill();
  }
  await port();
  await Bun.sleep(300);
  expect(read()?.pid).toBe(process.pid);
  await close();
  expect(existsSync(portFile())).toBe(false);
});
