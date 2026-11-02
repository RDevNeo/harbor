import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { alive } from "../src/files.ts";
import {
  ask,
  back,
  cli,
  enabled,
  failed,
  fetchOffer,
  giveUp,
  label,
  offeredFile,
  previewInfo,
  pushed,
  received,
  refuses,
  setEnabled,
  sha256,
  superseded,
  takes,
  versionIn,
  type Io,
  type Offer,
} from "../src/preview.ts";
import { readMeta, writeMeta, fail, type Meta } from "../src/previewmeta.ts";
import { bundleSource, cleanup, configFor, makeInstall, tmp, wait } from "./support.ts";

afterEach(cleanup);

const meta = (over: Partial<Meta> = {}): Meta => ({ id: "abc", sha256: "00", version: "1.2.3", note: "", from: "", at: 5, stage: "ok", why: "", shown_ms: 0, ...over });

function build(version = "1.5.0"): string {
  const f = join(tmp(), "harbor-app.js");
  writeFileSync(f, bundleSource(version));
  return f;
}

test("reads_the_version_line: the version line says which Harbor it is", () => {
  expect(versionIn("harbor 0.101.0 (abcdef0)\n")).toBe("0.101.0");
  expect(versionIn("harbor 0.101.0\n")).toBe("0.101.0");
  expect(versionIn("something else 1.0")).toBeNull();
  expect(versionIn("")).toBeNull();
});

test("a_newer_release_wins: a newer release wins over a preview build", () => {
  expect(superseded("0.101.0", "0.102.0")).toBe(true);
  expect(superseded("0.102.0", "0.102.0")).toBe(false);
  expect(superseded("0.103.0", "0.102.0")).toBe(false);
  expect(superseded("0.103.0", null)).toBe(false);
});

test("only_a_trusted_pc_with_previews_on: only a trusted PC with previews on may send one, and only a bundle", () => {
  const off = configFor(makeInstall());
  expect(refuses(off, true)).not.toBeNull();
  expect(refuses(off, false)).not.toBeNull();
  const inst = makeInstall();
  const on = configFor(inst);
  setEnabled(on, true);
  expect(refuses(on, true, { kind: "bundle" })).toBeNull();
  expect(refuses(on, false, { kind: "bundle" })).toContain("full access");
  expect(refuses(on, true, {})).toContain("Rust app");
  expect(refuses(on, true)).toBeNull();
});

test("says_what_runs: a PC says what it runs and whether it takes previews", () => {
  const cfg = configFor(makeInstall());
  expect(previewInfo(cfg)).toEqual({ preview_on: false, preview_kind: "bundle", preview: null });
  expect(takes({ preview_on: true, preview_kind: "bundle" })).toBe(true);
  expect(takes({ preview_on: true })).toBe(false);
  expect(takes({ version: "0.100.0" })).toBe(false);
  expect(takes(null)).toBe(false);
  setEnabled(cfg, true);
  expect(enabled(cfg)).toBe(true);
  expect(previewInfo(cfg).preview_on).toBe(true);
  setEnabled(cfg, false);
  expect(enabled(cfg)).toBe(false);
});

test("a running preview is named in the version and the info", () => {
  const inst = makeInstall();
  const cfg = configFor(inst, { preview: true });
  expect(label(cfg)).toBe("preview ?");
  writeMeta(inst.dir, meta({ note: "n", from: "pc", at: 9 }));
  expect(label(cfg)).toBe("preview abc");
  expect(previewInfo(cfg).preview).toEqual({ id: "abc", note: "n", from: "pc", at: 9 });
  expect(label(configFor(inst))).toBeNull();
});

test("meta_keeps_across_a_write: the preview's file keeps what was written, and a failure marks only that build", () => {
  const inst = makeInstall();
  const m = meta({ id: "abc", sha256: "00", version: "1.2.3", at: 5 });
  writeMeta(inst.dir, m);
  expect(readMeta(inst.dir)).toEqual(m);
  fail(inst.dir, "other", "no");
  expect(readMeta(inst.dir)).toEqual(m);
  fail(inst.dir, "abc", "it exited");
  expect(readMeta(inst.dir)?.stage).toBe("failed");
  expect(failed(configFor(inst))?.why).toBe("it exited");
  giveUp(configFor(inst));
  expect(readMeta(inst.dir)).toBeNull();
});

test("a preview file written by the Rust app reads here", () => {
  const inst = makeInstall();
  writeFileSync(join(inst.dir, "preview.json"), JSON.stringify({ id: "r1", sha256: "ab", version: "0.108.0", note: "", from: "", at: 3, stage: "ok", why: "", shown_ms: 77 }));
  expect(readMeta(inst.dir)).toMatchObject({ id: "r1", stage: "ok", shown_ms: 77 });
  writeFileSync(join(inst.dir, "preview.json"), "junk");
  expect(readMeta(inst.dir)).toBeNull();
});

test("hashes_a_file: a file hashes to its SHA-256", async () => {
  const f = join(tmp(), "f");
  writeFileSync(f, "abc");
  expect(await sha256(f)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("a_dead_process_is_not_alive: a dead process is not alive", () => {
  expect(alive(process.pid)).toBe(true);
  expect(alive(4_294_967_295)).toBe(false);
});

test("a pushed build goes in the slot when previews are on, and is on offer either way", async () => {
  const inst = makeInstall({ version: "1.0.0" });
  const cfg = configFor(inst);
  const src = build("1.5.0");
  const off = await received(cfg, { path: src, id: "feat-1", note: "a change" });
  expect(off.here).toBe(false);
  expect(off.offer).toMatchObject({ id: "feat-1", note: "a change", kind: "bundle" });
  expect(existsSync(join(inst.dir, "harbor-preview.js"))).toBe(false);
  expect(offeredFile(cfg, "bundle", "feat-1")).toBe(join(inst.dir, "preview-out", "harbor-app.js"));
  expect(offeredFile(cfg, "bundle", "other")).toBeNull();
  expect(offeredFile(cfg, "binary", "feat-1")).toBeNull();

  setEnabled(cfg, true);
  const on = await received(cfg, { path: src, id: "feat-2", note: "n".repeat(300) });
  expect(on.here).toBe(true);
  expect(readFileSync(join(inst.dir, "harbor-preview.js"), "utf8")).toBe(readFileSync(src, "utf8"));
  const m = readMeta(inst.dir);
  expect(m).toMatchObject({ id: "feat-2", version: "1.5.0", stage: "trying", sha256: on.offer.sha256 });
  expect(m?.note.length).toBe(120);
});

test("a build that does not run, is not Harbor or is older than the release is not taken", async () => {
  const inst = makeInstall({ version: "1.0.0" });
  const cfg = configFor(inst);
  setEnabled(cfg, true);
  const junk = join(tmp(), "j.js");
  writeFileSync(junk, "throw new Error('x')");
  await expect(received(cfg, { path: junk, id: "j" })).rejects.toThrow("it doesn't run here");
  const notBundle = join(tmp(), "n.js");
  writeFileSync(notBundle, "export const a = 1;");
  await expect(received(cfg, { path: notBundle, id: "n" })).rejects.toThrow("it doesn't run here");
  writeFileSync(join(inst.dir, "VERSION"), "2.0.0");
  await expect(received(cfg, { path: build("1.5.0"), id: "old" })).rejects.toThrow("older than the release here (2.0.0)");
  expect(existsSync(join(inst.dir, "harbor-preview.js"))).toBe(false);
  expect(existsSync(join(inst.dir, "harbor-preview.new.js"))).toBe(false);
  await expect(received(cfg, { path: "/nonexistent", id: "x" })).rejects.toThrow("no such file");
  await expect(received(cfg, { id: "x" })).rejects.toThrow("needs a path");
});

test("a build offered by another PC is fetched, checked against its hash and put in the slot", async () => {
  const inst = makeInstall();
  const cfg = configFor(inst);
  const src = build("1.5.0");
  const offer: Offer = { id: "p9", sha256: await sha256(src), note: "from there", kind: "bundle" };
  const m = await fetchOffer(cfg, offer, "other-pc", async (_k, to) => void (await Bun.write(to, Bun.file(src))));
  expect(m).toMatchObject({ id: "p9", from: "other-pc", note: "from there", version: "1.5.0" });
  expect(existsSync(join(inst.dir, ".preview-fetch"))).toBe(false);
  await expect(fetchOffer(cfg, { ...offer, sha256: "00" }, "x", async (_k, to) => void (await Bun.write(to, Bun.file(src))))).rejects.toThrow("isn't the one offered");
  expect(existsSync(join(inst.dir, ".preview-fetch"))).toBe(false);
});

test("pushing announces the offer and restarts only when this PC took it", async () => {
  const inst = makeInstall();
  const cfg = configFor(inst);
  const announced: string[] = [];
  let restarts = 0;
  const hooks = { announce: (o: Offer) => void announced.push(o.id), restart: () => void restarts++ };
  const src = build();
  const a = await pushed(cfg, { path: src, id: "one" }, hooks);
  expect(a).toMatchObject({ ok: true, restarting: false });
  expect(a.text).toContain("Previews are off");
  setEnabled(cfg, true);
  const b = await pushed(cfg, { path: src, id: "two" }, hooks);
  expect(b).toEqual({ ok: true, restarting: true, text: "" });
  expect(announced).toEqual(["one", "two"]);
  expect(restarts).toBe(1);
  const c = await pushed(cfg, { path: "/nonexistent", id: "three" }, hooks);
  expect(c.ok).toBe(false);
});

test("back to the release gives the preview up, and off turns previews off", async () => {
  const inst = makeInstall();
  const cfg = configFor(inst, { preview: true });
  setEnabled(cfg, true);
  writeMeta(inst.dir, meta());
  let restarts = 0;
  await back(cfg, false, () => void restarts++);
  expect(readMeta(inst.dir)).toBeNull();
  expect(enabled(cfg)).toBe(true);
  expect(restarts).toBe(1);
  await back(cfg, true, () => void restarts++);
  expect(enabled(cfg)).toBe(false);
  await back(configFor(inst), false, () => void restarts++);
  expect(restarts).toBe(2);
});

function io(answer: (v: unknown) => Record<string, unknown> | null = () => null) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: unknown[] = [];
  const i: Io = {
    out: (l) => void out.push(l),
    err: (l) => void err.push(l),
    ask: async (v) => {
      asked.push(v);
      return answer(v);
    },
    sleep: async () => undefined,
  };
  return { i, out, err, asked };
}

test("harbor preview status says what runs", async () => {
  const inst = makeInstall();
  const cfg = configFor(inst);
  const a = io();
  expect(await cli(cfg, [], a.i)).toBe(0);
  expect(a.out).toEqual(["Previews are off on this PC.", "Running the release."]);
  writeMeta(inst.dir, meta({ stage: "failed", note: "a note", why: "it exited" }));
  setEnabled(cfg, true);
  const b = io();
  await cli(cfg, ["status"], b.i);
  expect(b.out).toEqual(["Previews are on on this PC.", "abc: failed, a note (it exited)"]);
  const c = io();
  await cli(cfg, ["status", "--json"], c.i);
  expect(JSON.parse(c.out[0] ?? "{}")).toMatchObject({ on: true, managed: true, preview: { id: "abc" } });
});

test("harbor preview on and off, back with no Harbor running", async () => {
  const inst = makeInstall();
  const cfg = configFor(inst);
  const a = io();
  expect(await cli(cfg, ["on"], a.i)).toBe(0);
  expect(enabled(cfg)).toBe(true);
  writeMeta(inst.dir, meta());
  const b = io();
  expect(await cli(cfg, ["off"], b.i)).toBe(0);
  expect(b.asked).toEqual([{ preview_back: true, off: true }]);
  expect(enabled(cfg)).toBe(false);
  expect(readMeta(inst.dir)).toBeNull();
  expect(b.out).toEqual(["Back on the release, previews off."]);
  const c = io(() => ({ ok: true }));
  writeMeta(inst.dir, meta());
  await cli(cfg, ["back"], c.i);
  expect(readMeta(inst.dir)).not.toBeNull();
  const d = io();
  expect(await cli(configFor(null), ["on"], d.i)).toBe(1);
  expect(d.err[0]).toContain("install.sh");
});

test("harbor preview push sends the build to the running Harbor, or keeps it when none runs", async () => {
  const inst = makeInstall();
  const cfg = configFor(inst);
  const src = build();
  const a = io(() => ({ ok: true, restarting: false, text: "Previews are off on this PC (harbor preview on): only offered to the other PCs." }));
  expect(await cli(cfg, ["push", src, "--id", "x1", "--note", "hello"], a.i)).toBe(0);
  expect(a.asked[0]).toEqual({ preview: { path: src, id: "x1", note: "hello" } });
  expect(a.out[0]).toContain("only offered");
  const b = io();
  expect(await cli(cfg, ["push", src, "--id", "x2"], b.i)).toBe(0);
  expect(b.out).toEqual(["Kept: the next start runs it."]);
  expect(offeredFile(cfg, "bundle", "x2")).not.toBeNull();
  const c = io(() => ({ ok: false, text: "no" }));
  expect(await cli(cfg, ["push", src, "--id", "x3"], c.i)).toBe(1);
  expect(c.err).toEqual(["harbor: no"]);
  const d = io();
  expect(await cli(cfg, ["push", src], d.i)).toBe(2);
  expect(d.err[0]).toStartWith("Usage:");
  expect(await cli(cfg, ["push", "/nonexistent", "--id", "x"], io().i)).toBe(2);
  expect(await cli(cfg, ["bogus"], io().i)).toBe(2);
});

test("push --wait reports how the new build started", async () => {
  const inst = makeInstall();
  let clock = 1_000;
  const cfg = configFor(inst, { now: () => clock });
  const src = build();
  const ok = io(() => ({ ok: true, restarting: true }));
  ok.i.sleep = async () => {
    clock += 100;
    writeMeta(inst.dir, meta({ id: "w1", stage: "ok", shown_ms: 1_050 }));
  };
  expect(await cli(cfg, ["push", src, "--id", "w1", "--wait"], ok.i)).toBe(0);
  expect(ok.out[0]).toMatch(/^on screen 50 ms after the push, confirmed \d+ ms after it$/);

  const bad = io(() => ({ ok: true, restarting: true }));
  bad.i.sleep = async () => {
    writeMeta(inst.dir, meta({ id: "w2", stage: "failed", why: "it exited while starting" }));
  };
  expect(await cli(cfg, ["push", src, "--id", "w2", "--wait"], bad.i)).toBe(1);
  expect(bad.err[0]).toBe("harbor: w2 failed to start (it exited while starting): back on the release");

  const silent = io(() => ({ ok: true, restarting: true }));
  silent.i.sleep = async () => {
    clock += 20_000;
  };
  writeMeta(inst.dir, meta({ id: "w3", stage: "trying" }));
  expect(await cli(cfg, ["push", src, "--id", "w3", "--wait"], silent.i)).toBe(1);
  expect(silent.err[0]).toBe("harbor: no word from w3");

  const gone = io(() => ({ ok: true, restarting: true }));
  gone.i.sleep = async () => {
    clock += 6_000;
  };
  expect(await cli(cfg, ["push", src, "--id", "w4", "--wait"], gone.i)).toBe(1);
  expect(gone.err[0]).toContain("isn't this PC's preview any more");
});

test("the control socket answers one JSON line per question", async () => {
  const path = join(tmp(), "s.sock");
  const server = Bun.listen<{ buf: string }>({
    unix: path,
    socket: {
      open: (s) => void (s.data = { buf: "" }),
      data: (s, d) => {
        s.data.buf += d.toString();
        if (s.data.buf.includes("\n")) s.write(`${JSON.stringify({ ok: true, echo: JSON.parse(s.data.buf) })}\n`);
      },
    },
  });
  try {
    expect(await ask({ preview_back: true }, path)).toEqual({ ok: true, echo: { preview_back: true } });
  } finally {
    server.stop(true);
  }
  expect(await ask({}, join(tmp(), "none.sock"))).toBeNull();
  await wait(() => true);
});
