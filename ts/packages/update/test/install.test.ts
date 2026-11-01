import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hasPrevious, install, onDisk, rollback, rolledBack, runtimeOnDisk, skipped } from "../src/install.ts";
import { FakeHost, bundleSource, cleanup, configFor, makeInstall, makeKey } from "./support.ts";

afterEach(cleanup);

const text = (dir: string, f: string): string => readFileSync(join(dir, f), "utf8");

test("a bundle-only release replaces the bundle, keeps the old one and leaves the runtime alone", async () => {
  const key = await makeKey();
  const host = new FakeHost();
  const inst = makeInstall();
  const runtimeBefore = text(inst.dir, "harbor");
  await host.publishTs(key, "1.1.0", { minRuntime: "1.0.0", runtime: "1.0.0" });
  const cfg = host.config(inst, key);
  const done = await install(cfg, "1.1.0");
  expect(done.runtimeUpdated).toBe(false);
  expect(text(inst.dir, "harbor-app.js")).toContain('"1.1.0"');
  expect(text(inst.dir, "VERSION")).toBe("1.1.0");
  expect(text(inst.dir, "harbor")).toBe(runtimeBefore);
  expect(text(inst.dir, ".previous/harbor-app.js")).toContain('"1.0.0"');
  expect(text(inst.dir, ".previous/VERSION")).toBe("1.0.0");
  expect(JSON.parse(text(inst.dir, "manifest.json")).version).toBe("1.1.0");
  expect(existsSync(join(inst.dir, ".staging"))).toBe(false);
  expect(onDisk(cfg)).toBe("1.1.0");
  expect(hasPrevious(cfg)).toBe(true);
  expect(host.hits.some((h) => h.includes("harbor-runtime"))).toBe(false);
});

test("a bundle that needs a newer runtime fetches the runtime first, from the release that carries it", async () => {
  const key = await makeKey();
  const host = new FakeHost();
  const inst = makeInstall();
  await host.publishTs(key, "1.2.0", { minRuntime: "1.1.0", runtime: "1.1.0", runtimeFrom: "1.1.0" });
  const cfg = host.config(inst, key);
  const done = await install(cfg, "1.2.0");
  expect(done.runtimeUpdated).toBe(true);
  expect(runtimeOnDisk(cfg)).toBe("1.1.0");
  expect(text(inst.dir, "RUNTIME")).toBe("1.1.0");
  expect(statSync(join(inst.dir, "harbor")).mode & 0o111).not.toBe(0);
  const order = host.hits.filter((h) => h.includes("/download/")).map((h) => h.split("/").pop());
  expect(order.indexOf("harbor-runtime-x86_64")).toBeGreaterThan(-1);
  expect(order.indexOf("harbor-runtime-x86_64")).toBeLessThan(order.indexOf("harbor-app.js"));
  expect(text(inst.dir, ".previous/harbor")).toContain("FAKE_RUNTIME_VERSION=1.0.0");
  expect(text(inst.dir, "harbor")).toContain("FAKE_RUNTIME_VERSION=1.1.0");
});

test("a runtime that is new enough is not fetched again", async () => {
  const key = await makeKey();
  const host = new FakeHost();
  const inst = makeInstall({ runtime: "1.1.0" });
  await host.publishTs(key, "1.2.0", { minRuntime: "1.1.0", runtime: "1.1.0", runtimeFrom: "1.1.0" });
  const done = await install(host.config(inst, key, { runtime: "1.1.0" }), "1.2.0");
  expect(done.runtimeUpdated).toBe(false);
});

test("nothing is swapped when a file's signature is bad, and the staging folder is gone", async () => {
  const key = await makeKey();
  const host = new FakeHost();
  const inst = makeInstall();
  await host.publishTs(key, "1.1.0");
  host.put("1.1.0", "harbor-app.js", bundleSource("1.1.0", "evil();"));
  const cfg = host.config(inst, key);
  await expect(install(cfg, "1.1.0")).rejects.toThrow("harbor-app.js: bad signature");
  expect(text(inst.dir, "harbor-app.js")).toContain('"1.0.0"');
  expect(text(inst.dir, "VERSION")).toBe("1.0.0");
  expect(existsSync(join(inst.dir, ".staging"))).toBe(false);
  expect(hasPrevious(cfg)).toBe(false);
});

test("a file signed by another key is refused", async () => {
  const key = await makeKey();
  const other = await makeKey();
  const host = new FakeHost();
  const inst = makeInstall();
  await host.publishTs(other, "1.1.0");
  await expect(install(host.config(inst, key), "1.1.0")).rejects.toThrow("another key");
  expect(text(inst.dir, "VERSION")).toBe("1.0.0");
});

test("an old signed bundle cannot pass as a newer release", async () => {
  const key = await makeKey();
  const host = new FakeHost();
  const inst = makeInstall();
  await host.publishTs(key, "1.1.0");
  const old = await key.sign(new TextEncoder().encode(bundleSource("1.1.0")), "harbor v1.0.5 harbor-app.js");
  host.put("1.1.0", "harbor-app.js.minisig", old);
  await expect(install(host.config(inst, key), "1.1.0")).rejects.toThrow("signed for another release");
});

test("a manifest for another version is refused", async () => {
  const key = await makeKey();
  const host = new FakeHost();
  const inst = makeInstall();
  await host.publishTs(key, "1.1.0");
  await host.publish(key, "1.1.0", { "harbor-app.json": JSON.stringify({ version: "1.0.9", minRuntime: "1.0.0", runtime: "1.0.0" }) });
  await expect(install(host.config(inst, key), "1.1.0")).rejects.toThrow("another version");
});

test("a bundle that does not load on the runtime is not swapped in", async () => {
  const key = await makeKey();
  const host = new FakeHost();
  const inst = makeInstall();
  await host.publishTs(key, "1.1.0", { bundle: "throw new Error('boom');" });
  await expect(install(host.config(inst, key), "1.1.0")).rejects.toThrow("the new bundle");
  expect(text(inst.dir, "harbor-app.js")).toContain('"1.0.0"');
});

test("a bundle that says another version than the manifest is not swapped in", async () => {
  const key = await makeKey();
  const host = new FakeHost();
  const inst = makeInstall();
  await host.publishTs(key, "1.1.0", { bundle: bundleSource("1.0.7") });
  await expect(install(host.config(inst, key), "1.1.0")).rejects.toThrow("the bundle says harbor 1.0.7");
});

test("a runtime that does not start here is not swapped in", async () => {
  const key = await makeKey();
  const host = new FakeHost();
  const inst = makeInstall();
  await host.publishTs(key, "1.2.0", { minRuntime: "1.1.0", runtime: "1.1.0" });
  await host.publish(key, "1.1.0", { "harbor-runtime-x86_64": "#!/bin/sh\nexit 3\n" });
  await expect(install(host.config(inst, key), "1.2.0")).rejects.toThrow("the new runtime it doesn't run here");
  expect(text(inst.dir, "harbor")).toContain("FAKE_RUNTIME_VERSION=1.0.0");
});

test("a runtime older than the bundle's minimum is refused", async () => {
  const key = await makeKey();
  const host = new FakeHost();
  const inst = makeInstall();
  await host.publish(key, "1.2.0", { "harbor-app.json": JSON.stringify({ version: "1.2.0", minRuntime: "1.5.0", runtime: "1.1.0" }), "harbor-app.js": bundleSource("1.2.0") });
  await expect(install(host.config(inst, key), "1.2.0")).rejects.toThrow("needs runtime 1.5.0");
});

test("a missing asset fails with its name, after trying again", async () => {
  const key = await makeKey();
  const host = new FakeHost();
  const inst = makeInstall();
  const cfg = host.config(inst, key, { sleep: async () => undefined });
  await expect(install(cfg, "9.9.9")).rejects.toThrow("download failed: harbor-app.json (HTTP 404)");
  expect(host.hits.length).toBe(1);
});

test("a server error is tried again", async () => {
  const key = await makeKey();
  const host = new FakeHost();
  const inst = makeInstall();
  await host.publishTs(key, "1.1.0");
  const real = host.assets.get("v1.1.0/harbor-app.json") ?? { body: "" };
  host.assets.set("v1.1.0/harbor-app.json", { body: "later", status: 503 });
  let tries = 0;
  const cfg = host.config(inst, key, {
    sleep: async () => {
      if (++tries === 1) host.assets.set("v1.1.0/harbor-app.json", real);
    },
  });
  await install(cfg, "1.1.0");
  expect(text(inst.dir, "VERSION")).toBe("1.1.0");
});

test("rollback puts the previous files back, gives the version up and records why", async () => {
  const key = await makeKey();
  const host = new FakeHost();
  const inst = makeInstall();
  await host.publishTs(key, "1.2.0", { minRuntime: "1.1.0", runtime: "1.1.0", runtimeFrom: "1.1.0" });
  const cfg = host.config(inst, key);
  await install(cfg, "1.2.0");
  const r = rollback(cfg, "it exited while starting");
  expect(r).toEqual({ restored: "1.0.0", gaveUp: "1.2.0" });
  expect(text(inst.dir, "VERSION")).toBe("1.0.0");
  expect(text(inst.dir, "harbor-app.js")).toContain('"1.0.0"');
  expect(text(inst.dir, "harbor")).toContain("FAKE_RUNTIME_VERSION=1.0.0");
  expect(text(inst.dir, "RUNTIME")).toBe("1.0.0");
  expect(existsSync(join(inst.dir, ".previous"))).toBe(false);
  expect(existsSync(join(inst.dir, "manifest.json"))).toBe(false);
  expect(skipped(cfg, "1.2.0")).toBe(true);
  expect(skipped(cfg, "1.3.0")).toBe(false);
  expect(rolledBack(cfg)).toMatchObject({ version: "1.2.0", restored: "1.0.0", why: "it exited while starting" });
  expect(() => rollback(cfg)).toThrow("no previous version kept");
});

test("rolling back restores the manifest of the release that comes back", async () => {
  const key = await makeKey();
  const host = new FakeHost();
  const inst = makeInstall();
  await host.publishTs(key, "1.1.0");
  const cfg = host.config(inst, key);
  await install(cfg, "1.1.0");
  await host.publishTs(key, "1.2.0");
  await install({ ...cfg, version: "1.1.0" }, "1.2.0");
  expect(JSON.parse(text(inst.dir, "manifest.json")).version).toBe("1.2.0");
  rollback({ ...cfg, version: "1.1.0" });
  expect(JSON.parse(text(inst.dir, "manifest.json")).version).toBe("1.1.0");
  expect(text(inst.dir, "VERSION")).toBe("1.1.0");
});

test("a source build has nothing to install into", async () => {
  const key = await makeKey();
  const host = new FakeHost();
  const cfg = host.config(null, key);
  await expect(install(cfg, "1.1.0")).rejects.toThrow("not an installed copy");
  expect(onDisk(cfg)).toBeNull();
});

test("the version on disk is the installed one when it isn't the one running", () => {
  const inst = makeInstall();
  const cfg = configFor(inst);
  expect(onDisk(cfg)).toBeNull();
  writeFileSync(join(inst.dir, "VERSION"), "99.0.1\n");
  expect(onDisk(cfg)).toBe("99.0.1");
  writeFileSync(join(inst.dir, "VERSION"), "  \n");
  expect(onDisk(cfg)).toBeNull();
});

