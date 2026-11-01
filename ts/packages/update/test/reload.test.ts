import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "@harbor/store";
import { Updater } from "../src/delivery.ts";
import { readMeta, writeMeta } from "../src/previewmeta.ts";
import { RELOADED_PID, Reloader, STATE_KEY, draftsFrom, draftsOf, takeSnapshot, watchFiles, type Kv } from "../src/reload.ts";
import { FakeHost, cleanup, configFor, makeInstall, makeKey, tmp, wait } from "./support.ts";

afterEach(cleanup);

function memory(): Kv & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v) };
}

test("drafts that hold text are kept and the blank ones are not", () => {
  const out = draftsOf(
    new Map([
      [1, "half a sentence"],
      [2, "   \n"],
      [3, ""],
    ]),
  );
  expect(out).toEqual({ "1": "half a sentence" });
  expect(draftsFrom({ drafts: { "1": "a", x: "b", "2": 5 } })).toEqual(new Map([[1, "a"]]));
  expect(draftsFrom({})).toEqual(new Map());
  expect(draftsFrom({ drafts: [1] })).toEqual(new Map());
});

test("the snapshot is read once, and unreadable ones are dropped", () => {
  const kv = memory();
  expect(takeSnapshot(kv)).toBeNull();
  kv.set(STATE_KEY, '{"view":{"t":"chat","id":4},"drafts":{"4":"hi"}}');
  expect(takeSnapshot(kv)).toEqual({ view: { t: "chat", id: 4 }, drafts: { "4": "hi" } });
  expect(takeSnapshot(kv)).toBeNull();
  kv.set(STATE_KEY, "not json");
  expect(takeSnapshot(kv)).toBeNull();
  kv.set(STATE_KEY, "[1]");
  expect(takeSnapshot(kv)).toBeNull();
});

test("a snapshot written by the Rust app restores here", () => {
  const kv = memory();
  const rust = {
    view: { t: "settings", tab: "general", back: 7 },
    draft_repo: 3,
    draft_main: false,
    drafts: { "7": "typing…" },
    files: { "7": ["/tmp/a.png"] },
    panes: [{ open: true, active: 0, surfaces: [{ t: "terminal", title: "sh", cwd: "/tmp" }] }, { open: false, active: 0, surfaces: [] }],
    max: null,
    pending: { "7": ["queued"] },
    queue: [],
  };
  kv.set(STATE_KEY, JSON.stringify(rust));
  const snap = takeSnapshot(kv);
  expect(snap).toEqual(rust);
  expect(draftsFrom(snap ?? {}).get(7)).toBe("typing…");
});

function reloader(over: Partial<ConstructorParameters<typeof Reloader>[0]> = {}) {
  const inst = makeInstall();
  const kv = memory();
  const calls: string[] = [];
  const spawned: Array<{ cmd: string[]; env: Record<string, string | undefined> }> = [];
  const r = new Reloader({
    cfg: configFor(inst),
    kv,
    snapshot: () => {
      calls.push("snapshot");
      return { drafts: { "5": "a draft" } };
    },
    args: () => ["--background", "x"],
    hidden: () => false,
    beforeExit: () => void calls.push("beforeExit"),
    release: () => void calls.push("release"),
    spawn: (cmd, env) => {
      calls.push("spawn");
      spawned.push({ cmd, env });
    },
    exit: (code) => void calls.push(`exit ${code}`),
    ...over,
  });
  return { r, kv, calls, spawned, inst };
}

test("a restart saves the screen first, starts the runtime again and then leaves", async () => {
  const { r, kv, calls, spawned, inst } = reloader();
  process.env.HARBOR_VIEW = "chat";
  process.env.HARBOR_POINTER = "x";
  try {
    expect(await r.now()).toBe(true);
  } finally {
    delete process.env.HARBOR_VIEW;
    delete process.env.HARBOR_POINTER;
  }
  expect(calls).toEqual(["snapshot", "beforeExit", "spawn", "release", "exit 0"]);
  expect(JSON.parse(kv.get(STATE_KEY) ?? "{}")).toEqual({ drafts: { "5": "a draft" } });
  expect(spawned[0]?.cmd).toEqual([join(inst.dir, "harbor"), "x"]);
  expect(spawned[0]?.env[RELOADED_PID]).toBe(String(process.pid));
  expect(spawned[0]?.env.HARBOR_VIEW).toBeUndefined();
  expect(spawned[0]?.env.HARBOR_POINTER).toBeUndefined();
});

test("the new window is hidden only if this one was", async () => {
  const { r, spawned } = reloader({ hidden: () => true });
  await r.now();
  expect(spawned[0]?.cmd.slice(1)).toEqual(["x", "--background"]);
});

test("asking twice restarts once", async () => {
  const { r, calls } = reloader();
  await r.now();
  await r.now();
  expect(calls.filter((c) => c === "spawn").length).toBe(1);
});

test("a restart that cannot start the runtime stays, and a preview that caused it is marked failed", async () => {
  const { r, calls, inst } = reloader({
    spawn: () => {
      throw new Error("ENOEXEC");
    },
  });
  writeMeta(inst.dir, { id: "p1", sha256: "", version: "1.2.0", note: "", from: "", at: 1, stage: "trying", why: "", shown_ms: 0 });
  expect(await r.now()).toBe(false);
  expect(calls).not.toContain("exit 0");
  expect(readMeta(inst.dir)).toMatchObject({ stage: "failed", why: "ENOEXEC" });
  expect(await r.now()).toBe(false);
});

test("without the runtime file there is nothing to start", async () => {
  const kv = memory();
  const r = new Reloader({ cfg: configFor(null, { exe: "/nonexistent/harbor" }), kv, snapshot: () => ({}), args: () => [], hidden: () => false, spawn: () => undefined, exit: () => undefined });
  expect(await r.now()).toBe(false);
  expect(kv.get(STATE_KEY)).toBeNull();
});

test("the runtime really starts again with the old pid in its environment", async () => {
  const dir = tmp();
  const out = join(dir, "out");
  const script = join(dir, "harbor");
  writeFileSync(script, `#!/bin/sh\necho "$HARBOR_RELOADED_PID $*" > ${JSON.stringify(out)}\n`);
  chmodSync(script, 0o755);
  let exited = 0;
  const r = new Reloader({ cfg: configFor(null, { exe: script }), kv: memory(), snapshot: () => ({}), args: () => ["a"], hidden: () => false, exit: () => void exited++ });
  await r.now();
  await wait(() => exited === 1);
  await wait(() => existsSync(out) && readFileSync(out, "utf8") !== "");
  expect(readFileSync(out, "utf8").trim()).toBe(`${process.pid} a`);
});

test("a composer draft survives the swap: saved before the restart, read back by the next process", async () => {
  const key = await makeKey();
  const host = new FakeHost();
  const inst = makeInstall();
  const data = tmp("hupd-db-");
  await host.publishTs(key, "1.1.0");
  const first = Store.open(data);
  const drafts = new Map([[42, "a long message I was still typing"]]);
  const spawned: string[][] = [];
  const reload = new Reloader({
    cfg: host.config(inst, key),
    kv: first,
    snapshot: () => ({ view: { t: "chat", id: 42 }, drafts: draftsOf(drafts) }),
    args: () => [],
    hidden: () => false,
    spawn: (cmd) => void spawned.push(cmd),
    exit: () => first.close(),
  });
  const updater = new Updater(host.config(inst, key, { sleep: async () => undefined }), { swap: () => void reload.now() });
  await updater.onRelease("1.1.0");
  expect(spawned.length).toBe(1);
  expect(readFileSync(join(inst.dir, "VERSION"), "utf8")).toBe("1.1.0");

  const second = Store.open(data);
  try {
    const snap = takeSnapshot(second);
    expect(snap?.view).toEqual({ t: "chat", id: 42 });
    expect(draftsFrom(snap ?? {}).get(42)).toBe("a long message I was still typing");
    expect(second.get(STATE_KEY)).toBe("");
  } finally {
    second.close();
  }
});

test("a build written in place is noticed once it is finished writing", async () => {
  const f = join(tmp(), "harbor-app.js");
  writeFileSync(f, "one");
  let changes = 0;
  const stop = watchFiles([f], () => void changes++, 15);
  await new Promise((r) => setTimeout(r, 60));
  expect(changes).toBe(0);
  writeFileSync(f, "two, longer");
  await wait(() => changes === 1);
  await new Promise((r) => setTimeout(r, 60));
  expect(changes).toBe(1);
  stop();
});

test("a file renamed over is a change too, and a missing one is not", async () => {
  const dir = tmp();
  const a = join(dir, "a");
  const b = join(dir, "b");
  writeFileSync(a, "same");
  let changes = 0;
  const stop = watchFiles([a, b], () => void changes++, 15);
  writeFileSync(join(dir, "new"), "same");
  await new Promise((r) => setTimeout(r, 60));
  expect(changes).toBe(0);
  renameSync(join(dir, "new"), a);
  await wait(() => changes === 1);
  stop();
});
