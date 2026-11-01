import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ELECTRON, Vencords, electronBin, addEdit, applyEdits, baseScript, checkVencord, download, ensureElectron, ensureShell, ensureVencord, fileSha256, liveScript, loadOverride, profile, root, shellDir, shellFiles, socket, unzip, vencordDir, writeLiveScript } from "../src/discordsetup.ts";
import type { Edit } from "../src/discordsetup.ts";
import { sandbox, zip } from "./discordkit.ts";

const repoDiscord = join(import.meta.dir, "../../../../discord");
let box: ReturnType<typeof sandbox>;
let server: ReturnType<typeof Bun.serve>;
const served = new Map<string, Uint8Array | string>();
const hits: string[] = [];
let flaky = 0;

beforeAll(() => {
  box = sandbox();
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      hits.push(path);
      if (path === "/flaky") return flaky++ < 1 ? new Response("no", { status: 503 }) : new Response("ok");
      if (path === "/redirect") return new Response(null, { status: 302, headers: { location: "/a.txt" } });
      const body = served.get(path);
      return body === undefined ? new Response("missing", { status: 404 }) : new Response(body);
    },
  });
});
afterAll(() => {
  server.stop(true);
  box.restore();
});

const base = (): string => `http://127.0.0.1:${server.port}`;

test("sums match the shell files", async () => {
  expect(shellFiles().length).toBeGreaterThan(0);
  for (const [want, rel] of shellFiles()) {
    expect(await fileSha256(join(repoDiscord, rel))).toBe(want);
  }
  for (const rel of ["main.js", "preload.js", "scratch.js", "package.json", "tools.json", "page/harbor.js"]) {
    expect(shellFiles().some(([, r]) => r === rel)).toBe(true);
  }
});

test("rollback returns to the last good version", () => {
  const v = new Vencords();
  v.offer("a");
  expect(v.rollback()).toBe(false);
  v.passed();
  v.offer("b");
  expect(v.current).toBe("b");
  expect(v.rollback()).toBe(true);
  expect([v.current, v.good]).toEqual(["a", "a"]);
  v.offer("b");
  expect(v.current).toBe("a");
  expect(v.rollback()).toBe(false);
  v.offer("c");
  v.passed();
  expect(v.good).toBe("c");
});

test("vencord.json round-trips and survives a bad file", () => {
  const v = new Vencords();
  v.offer("abc");
  v.passed();
  v.bad = ["old"];
  v.checked = 77;
  v.save();
  expect(Vencords.load()).toEqual(v);
  writeFileSync(join(root(), "vencord.json"), "not json");
  expect(Vencords.load()).toEqual(new Vencords());
  expect(statSync(join(root(), "vencord.json")).mode & 0o777).toBe(0o600);
});

const edit = (old: string, nw: string): Edit => ({ old, new: nw, why: "" });

test("edits apply once and can't add network or token access", () => {
  const script = 'a: { props: [["x"]] },\nb: 1,\nb: 1,\n';
  expect(applyEdits(script, [edit('["x"]', '["y"]')])).toBe('a: { props: [["y"]] },\nb: 1,\nb: 1,\n');
  expect(() => applyEdits(script, [edit("nope", "y")])).toThrow("isn't in the script");
  expect(() => applyEdits(script, [edit("b: 1", "y")])).toThrow("2 times");
  for (const evil of ["fetch(u)", "new WebSocket(u)", "getToken()", "eval(x)", "'htt' + 'p:'.concat(atob(x))", 'window["\\x66"]', "a.constructor.constructor", "https://x"]) {
    expect(() => applyEdits(script, [edit('["x"]', evil)])).toThrow();
  }
  expect(applyEdits("getToken: 1", [edit("getToken: 1", "getToken: 2")])).toBe("getToken: 2");
  expect(applyEdits("a", [edit("a", "$& $1")])).toBe("$& $1");
});

test("unzip keeps modes and refuses escapes", async () => {
  const d = join(box.dir, "unzip");
  mkdirSync(d, { recursive: true });
  const p = join(d, "a.zip");
  writeFileSync(p, zip([{ name: "bin/run", data: "hello", mode: 0o100755 }]));
  await unzip(p, join(d, "out"));
  expect(readFileSync(join(d, "out/bin/run"), "utf8")).toBe("hello");
  expect(statSync(join(d, "out/bin/run")).mode & 0o777).toBe(0o755);
  writeFileSync(p, zip([{ name: "../evil", data: "x" }]));
  await expect(unzip(p, join(d, "out2"))).rejects.toThrow("damaged");
  writeFileSync(p, zip([{ name: "/abs", data: "x" }]));
  await expect(unzip(p, join(d, "out3"))).rejects.toThrow("damaged");
  expect(existsSync(join(d, "evil"))).toBe(false);
});

test("unzip reads deflated files, folders, empty files and symlinks", async () => {
  const d = join(box.dir, "unzip2");
  mkdirSync(d, { recursive: true });
  const big = "abc".repeat(50_000);
  writeFileSync(
    join(d, "b.zip"),
    zip([
      { name: "lib/", data: "" },
      { name: "lib/big.txt", data: big, deflate: true },
      { name: "lib/empty", data: "" },
      { name: "lib/link", data: "big.txt", mode: 0o120777 },
      { name: "lib/packed-link", data: "big.txt", mode: 0o120777, deflate: true },
    ]),
  );
  await unzip(join(d, "b.zip"), join(d, "out"));
  expect(readFileSync(join(d, "out/lib/big.txt"), "utf8")).toBe(big);
  expect(readFileSync(join(d, "out/lib/empty"), "utf8")).toBe("");
  expect(lstatSync(join(d, "out/lib/link")).isSymbolicLink()).toBe(true);
  expect(readlinkSync(join(d, "out/lib/link"))).toBe("big.txt");
  expect(readlinkSync(join(d, "out/lib/packed-link"))).toBe("big.txt");
  writeFileSync(join(d, "c.zip"), "not a zip at all");
  await expect(unzip(join(d, "c.zip"), join(d, "out4"))).rejects.toThrow("damaged");
});

test("download follows redirects, retries a 503 and reports progress", async () => {
  served.set("/a.txt", "hello world");
  const to = join(box.dir, "dl.txt");
  const seen: number[] = [];
  await download(`${base()}/redirect`, to, (n) => seen.push(n));
  expect(readFileSync(to, "utf8")).toBe("hello world");
  expect(seen.at(-1)).toBe(11);
  await download(`${base()}/flaky`, join(box.dir, "flaky.txt"));
  expect(readFileSync(join(box.dir, "flaky.txt"), "utf8")).toBe("ok");
  await expect(download(`${base()}/nothing`, join(box.dir, "nothing.txt"))).rejects.toThrow("Couldn't download");
  expect(existsSync(join(box.dir, "nothing.txt"))).toBe(false);
});

test("the paths live under the private store", () => {
  expect(root()).toBe(join(box.dir, "data/harbor/apps/discord"));
  expect(profile()).toBe(join(root(), "profile"));
  expect(socket()).toBe(join(root(), "h.sock"));
  expect(statSync(root()).mode & 0o777).toBe(0o700);
});

test("Electron is checked against its pinned hash before it is unpacked", async () => {
  const name = `electron-v${ELECTRON}-linux-${process.arch}.zip`;
  const archive = zip([{ name: "electron", data: "#!/bin/sh\n", mode: 0o100755 }, { name: "resources/app.asar", data: "x", deflate: true }]);
  served.set(`/${name}`, archive);
  process.env.HARBOR_DISCORD_ELECTRON_URL = base();
  const notes: string[] = [];
  await expect(ensureElectron((s) => notes.push(s))).rejects.toThrow("doesn't match its checksum");
  expect(existsSync(join(root(), `${name}.part`))).toBe(false);
  expect(existsSync(join(root(), `electron-${ELECTRON}`))).toBe(false);

  const sums = { x64: createHash("sha256").update(archive).digest("hex"), arm64: createHash("sha256").update(archive).digest("hex") };
  await ensureElectron((s) => notes.push(s), sums);
  expect(statSync(join(root(), `electron-${ELECTRON}/electron`)).mode & 0o777).toBe(0o755);
  expect(notes).toContain("Unpacking…");
  hits.length = 0;
  await ensureElectron(() => {}, sums);
  expect(hits).toEqual([]);
  delete process.env.HARBOR_DISCORD_ELECTRON_URL;
});

test("HARBOR_DISCORD_ELECTRON points at another binary", () => {
  expect(electronBin()).toBe(join(root(), `electron-${ELECTRON}`, "electron"));
  process.env.HARBOR_DISCORD_ELECTRON = "/x/y";
  expect(electronBin()).toBe("/x/y");
  delete process.env.HARBOR_DISCORD_ELECTRON;
});

test("the shell is fetched file by file and checked against SHA256SUMS", async () => {
  for (const [, rel] of shellFiles()) served.set(`/shell/${rel}`, readFileSync(join(repoDiscord, rel)));
  process.env.HARBOR_DISCORD_SHELL_URL = `${base()}/shell`;
  mkdirSync(join(root(), "shell-old"), { recursive: true });
  const real = served.get("/shell/main.js");
  served.set("/shell/main.js", "tampered");
  await expect(ensureShell(() => {})).rejects.toThrow("main.js");
  expect(existsSync(`${shellDir()}.tmp`)).toBe(false);
  expect(existsSync(shellDir())).toBe(false);
  if (real !== undefined) served.set("/shell/main.js", real);
  await ensureShell(() => {});
  expect(existsSync(join(shellDir(), "page/harbor.js"))).toBe(true);
  expect(existsSync(join(root(), "shell-old"))).toBe(false);
  hits.length = 0;
  await ensureShell(() => {});
  expect(hits).toEqual([]);
  delete process.env.HARBOR_DISCORD_SHELL_URL;
});

const vencordFiles = (tag: string): void => {
  for (const f of ["vencordDesktopMain.js", "vencordDesktopPreload.js", "vencordDesktopRenderer.js", "vencordDesktopRenderer.css"]) served.set(`/v/${f}`, `${f} ${tag}`);
};

test("Vencord is downloaded once, found daily, and old versions are pruned", async () => {
  process.env.HARBOR_DISCORD_VENCORD_URL = `${base()}/v`;
  vencordFiles("one");
  const v = await ensureVencord(() => {});
  expect(v.current).toHaveLength(12);
  expect(existsSync(join(vencordDir(v.current), "vencordDesktopMain.js"))).toBe(true);
  expect(Vencords.load().current).toBe(v.current);

  expect(await checkVencord(false)).toBe(false);
  const stale = Vencords.load();
  stale.checked = 1;
  stale.save();
  vencordFiles("two");
  expect(await checkVencord(false)).toBe(true);
  const second = Vencords.load().current;
  expect(second).not.toBe(v.current);

  const t = (Date.now() - 100_000) / 1000;
  for (const [i, tag] of ["three", "four", "five", "six"].entries()) {
    const old = Vencords.load();
    old.checked = 1;
    old.save();
    vencordFiles(tag);
    expect(await checkVencord(false)).toBe(true);
    utimesSync(vencordDir(Vencords.load().current), t + i, t + i);
  }
  const keep = readdirSync(join(root(), "vencord"));
  expect(keep.length).toBeLessThanOrEqual(5);
  expect(keep).toContain(Vencords.load().current);

  const failing = Vencords.load();
  failing.checked = 1;
  failing.save();
  process.env.HARBOR_DISCORD_VENCORD_URL = `${base()}/gone`;
  expect(await checkVencord(true)).toBe(false);
  delete process.env.HARBOR_DISCORD_VENCORD_URL;
});

test("repair's edits are kept per version of the script and applied to the live one", () => {
  process.env.HARBOR_DISCORD_SHELL = repoDiscord;
  const script = baseScript();
  expect(loadOverride(script)).toBeUndefined();
  const first = script.split("\n").find((l) => l.trim().length > 12 && script.split(l).length === 2 && !l.includes("//") && !l.includes("fetch(")) ?? "";
  expect(first).not.toBe("");
  addEdit({ old: first, new: `${first} `, why: "spacing" });
  expect(loadOverride(script)?.edits).toHaveLength(1);
  const live = writeLiveScript();
  expect(readFileSync(live, "utf8")).toBe(applyEdits(script, [edit(first, `${first} `)]));
  expect(liveScript()).toBe(readFileSync(live, "utf8"));
  expect(() => addEdit({ old: "no such text in the script ☃", new: "x", why: "" })).toThrow();
  expect(loadOverride(script)?.edits).toHaveLength(1);
  expect(loadOverride(`${script}\n// a newer script`)).toBeUndefined();
  writeFileSync(join(root(), "override.json"), JSON.stringify({ base: loadOverride(script)?.base, edits: [{ old: "gone", new: "x" }], at: 1 }));
  expect(readFileSync(writeLiveScript(), "utf8")).toBe(script);
  delete process.env.HARBOR_DISCORD_SHELL;
});
