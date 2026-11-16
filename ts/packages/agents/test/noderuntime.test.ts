import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { nodedist, platform } from "@harbor/os";
import * as noderuntime from "../src/noderuntime.ts";
import * as providers from "../src/providers.ts";

describe("nodedist.distFor", () => {
  test("the official archive, its folder and where node is, per system and architecture", () => {
    const v = nodedist.NODE_VERSION;
    expect(nodedist.distFor("win32", "x64")).toEqual({
      version: v,
      archive: `node-v${v}-win-x64.zip`,
      url: `https://nodejs.org/dist/v${v}/node-v${v}-win-x64.zip`,
      sha256: nodedist.NODE_SHA256[`node-v${v}-win-x64.zip`] as string,
      folder: `node-v${v}-win-x64`,
      bin: "",
      node: "node.exe",
      kind: "zip",
    });
    const mac = nodedist.distFor("darwin", "arm64");
    expect([mac?.archive, mac?.bin, mac?.node, mac?.kind]).toEqual([`node-v${v}-darwin-arm64.tar.gz`, "bin", "node", "tar.gz"]);
    const linux = nodedist.distFor("linux", "x64");
    expect([linux?.archive, linux?.url, linux?.folder]).toEqual([`node-v${v}-linux-x64.tar.gz`, `https://nodejs.org/dist/v${v}/node-v${v}-linux-x64.tar.gz`, `node-v${v}-linux-x64`]);
    expect(nodedist.distFor("linux", "arm64")?.archive).toBe(`node-v${v}-linux-arm64.tar.gz`);
    expect(nodedist.distFor("win32", "arm64")?.archive).toBe(`node-v${v}-win-arm64.zip`);
    expect(nodedist.distFor("darwin", "x64")?.archive).toBe(`node-v${v}-darwin-x64.tar.gz`);
    // No official build Harbor uses: nothing to download.
    expect(nodedist.distFor("linux", "ia32")).toBeNull();
    expect(nodedist.distFor("other", "x64")).toBeNull();
    // A mirror, and a version with no pinned hash.
    expect(nodedist.distFor("linux", "x64", v, "http://127.0.0.1:1/dist/")?.url).toBe(`http://127.0.0.1:1/dist/v${v}/node-v${v}-linux-x64.tar.gz`);
    expect(nodedist.distFor("linux", "x64", "1.2.3")).toBeNull();
  });

  test("every pinned hash is a SHA-256 of an archive of the pinned version", () => {
    const names = Object.keys(nodedist.NODE_SHA256);
    expect(names.length).toBe(6);
    for (const [name, h] of Object.entries(nodedist.NODE_SHA256)) {
      expect(name.startsWith(`node-v${nodedist.NODE_VERSION}-`)).toBe(true);
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

// A fake Node release, served from 127.0.0.1: an archive of this system's kind holding the folder and node file
// the real one has.
const VERSION = "0.0.1";
const work = mkdtempSync(join(tmpdir(), "hnode-"));
const plat = platform();
const os = plat === "win32" ? "win" : plat === "darwin" ? "darwin" : "linux";
const kind = plat === "win32" ? "zip" : "tar.gz";
const folder = `node-v${VERSION}-${os}-x64`;
const archive = `${folder}.${kind}`;

function makeArchive(): Buffer {
  const src = join(work, "src");
  const bin = plat === "win32" ? join(src, folder) : join(src, folder, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, plat === "win32" ? "node.exe" : "node"), "fake node", { mode: 0o755 });
  writeFileSync(join(bin, plat === "win32" ? "npx.cmd" : "npx"), "fake npx", { mode: 0o755 });
  const out = join(work, archive);
  const tar = plat === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  const argv = plat === "win32" ? [tar, "-a", "-cf", out, "-C", src, folder] : [tar, "-czf", out, "-C", src, folder];
  const r = Bun.spawnSync(argv);
  if (r.exitCode !== 0) throw new Error(`making the fixture: ${r.stderr.toString()}`);
  return readFileSync(out);
}

const bytes = makeArchive();
const good = createHash("sha256").update(bytes).digest("hex");
let hits = 0;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    hits++;
    const p = new URL(req.url).pathname;
    if (p === `/dist/v${VERSION}/${archive}`) return new Response(bytes);
    if (p === `/dist/v${VERSION}/bad-${archive}`) return new Response(Buffer.concat([bytes, Buffer.from("tampered")]));
    return new Response("not found", { status: 404 });
  },
});
const base = `http://127.0.0.1:${server.port}/dist`;
const dist = (sha = good): nodedist.NodeDist => {
  const d = nodedist.distFor(plat, "x64", VERSION, base, { [archive]: sha });
  if (d === null) throw new Error("no dist");
  return d;
};
const ok = async (): Promise<void> => undefined;

afterAll(() => {
  server.stop(true);
  rmSync(work, { recursive: true, force: true });
});

let root: string;
const saved = { ...process.env };
beforeEach(() => {
  root = mkdtempSync(join(work, "rt-"));
  hits = 0;
  noderuntime.resetForTests();
});
afterEach(() => {
  process.env = { ...saved };
  noderuntime.resetForTests();
});

/** What's in `root`: the installed folder, and never a leftover temporary one. */
const listing = (): string[] => readdirSync(root).sort();

describe("install", () => {
  test("downloads, checks the hash, unpacks and moves the folder in whole", async () => {
    const checked: string[] = [];
    const bin = await noderuntime.install(root, dist(), fetch, async (n) => void checked.push(n));
    expect(bin).toBe(noderuntime.binOf(root, dist()));
    expect(existsSync(join(bin, plat === "win32" ? "node.exe" : "node"))).toBe(true);
    expect(listing()).toEqual([folder]);
    // node was checked where it was unpacked, before the move.
    expect(checked.length).toBe(1);
    expect(checked[0]?.includes(".tmp-")).toBe(true);
  });

  test("a download whose hash doesn't match is refused and leaves nothing", async () => {
    await expect(noderuntime.install(root, dist("0".repeat(64)), fetch, ok)).rejects.toThrow(/SHA-256/);
    expect(listing()).toEqual([]);
    const tampered = { ...dist(), url: `${base}/v${VERSION}/bad-${archive}` };
    await expect(noderuntime.install(root, tampered, fetch, ok)).rejects.toThrow(/SHA-256/);
    expect(listing()).toEqual([]);
  });

  test("an HTTP error, or a node that doesn't run here, leaves nothing", async () => {
    await expect(noderuntime.install(root, { ...dist(), url: `${base}/missing` }, fetch, ok)).rejects.toThrow(/HTTP 404/);
    expect(listing()).toEqual([]);
    await expect(
      noderuntime.install(root, dist(), fetch, async () => {
        throw new Error("node --version exited 126");
      }),
    ).rejects.toThrow(/126/);
    expect(listing()).toEqual([]);
  });

  test("an older version is pruned once the new one is in; an old temporary folder is swept", async () => {
    mkdirSync(join(root, "node-v0.0.0-linux-x64"));
    mkdirSync(join(root, "keep-me"));
    await noderuntime.install(root, dist(), fetch, ok);
    await Bun.sleep(50);
    expect(listing()).toEqual(["keep-me", folder]);
  });
});

describe("ensure", () => {
  test("installs once, then answers from the disk; a user's own Node means no download", async () => {
    const path = join(root, "nothing-on-path");
    const a = noderuntime.ensure({ path, root, dist: dist(), fetch, check: ok });
    expect(noderuntime.current().kind).toBe("installing");
    // A second caller meanwhile waits for the same install.
    const b = noderuntime.ensure({ path, root, dist: dist(), fetch, check: ok });
    expect(await a).toBe(noderuntime.binOf(root, dist()));
    expect(await b).toBe(await a);
    expect(hits).toBe(1);
    expect(noderuntime.current()).toEqual({ kind: "ready", bin: noderuntime.binOf(root, dist()) });
    expect(await noderuntime.ensure({ path, root, dist: dist(), fetch, check: ok })).toBe(await a);
    expect(hits).toBe(1);

    // The user's node and npx on PATH: nothing fetched.
    const other = mkdtempSync(join(work, "rt-"));
    const user = join(other, "userbin");
    mkdirSync(user);
    const sfx = plat === "win32" ? ".exe" : "";
    writeFileSync(join(user, `node${sfx}`), "", { mode: 0o755 });
    writeFileSync(join(user, plat === "win32" ? "npx.cmd" : "npx"), "", { mode: 0o755 });
    noderuntime.resetForTests();
    expect(await noderuntime.ensure({ path: user, root: other, dist: dist(), fetch, check: ok })).toBeNull();
    expect(noderuntime.current().kind).toBe("user");
    expect(hits).toBe(1);
  });

  test("a failure is kept, said in the chip's tip, and not retried at once", async () => {
    const path = join(root, "none");
    expect(await noderuntime.ensure({ path, root, dist: dist("f".repeat(64)), fetch, check: ok })).toBeNull();
    const s = noderuntime.current();
    expect(s.kind).toBe("failed");
    expect(noderuntime.tip()).toMatch(/^Couldn't install Node\.js: .*SHA-256.* tried again on the next start$/);
    expect(await noderuntime.ensure({ path, root, dist: dist(), fetch, check: ok })).toBeNull();
    expect(hits).toBe(1);
    expect(await noderuntime.ensure({ path, root, dist: dist(), fetch, check: ok, force: true })).toBe(noderuntime.binOf(root, dist()));
    expect(listing()).toEqual([folder]);
  });

  test("no official build for this PC: nothing to do", async () => {
    expect(await noderuntime.ensure({ path: "", root, dist: null })).toBeNull();
    expect(noderuntime.tip()).toMatch(/no official build/);
  });

  test("under bun test, nothing reaches nodejs.org without a fetch of the test's own", async () => {
    expect(await noderuntime.ensure({ path: join(root, "none"), root, dist: dist() })).toBeNull();
    expect(hits).toBe(0);
    expect(noderuntime.current().kind).toBe("idle");
  });
});

describe("PATH", () => {
  test("childPath() ends with the managed Node's bin folder once it's installed", () => {
    process.env.XDG_DATA_HOME = join(root, "data");
    process.env.HOME = root;
    process.env.PATH = join(root, "empty");
    const real = nodedist.distFor();
    if (real === null) return;
    expect(providers.childPath().split(delimiter)).not.toContain(noderuntime.binOf(noderuntime.runtimesDir(), real));
    const bin = noderuntime.binOf(noderuntime.runtimesDir(), real);
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, real.node), "", { mode: 0o755 });
    writeFileSync(join(bin, plat === "win32" ? "npx.cmd" : "npx"), "", { mode: 0o755 });
    noderuntime.resetForTests();
    const dirs = providers.childPath().split(delimiter);
    expect(dirs[dirs.length - 1]).toBe(bin);
    expect(providers.basePath().split(delimiter)).not.toContain(bin);
    // Found by which() (so mcp.locals() offers Playwright), unless the OS's own tool folders have one first.
    if (noderuntime.onPath("npx", providers.basePath()) === null) expect(providers.which("npx")?.startsWith(bin)).toBe(true);
  });
});
