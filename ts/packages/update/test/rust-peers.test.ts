import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { updateCli } from "../src/commands.ts";
import { Updater } from "../src/delivery.ts";
import { install, NoBuild } from "../src/install.ts";
import { launch, useEmbedded, type AppBundle } from "../src/launcher.ts";
import { advertised, compare, RUST_PARITY } from "../src/version.ts";
import { FakeHost, cleanup, configFor, makeInstall, makeKey } from "./support.ts";

afterEach(cleanup);

// update.rs `parse`: the part before "-" is the release, three numbers, the third may be missing.
function rustParse(v: string): [number, number, number, boolean] | null {
  const t = v.trim().replace(/^v/, "");
  const dash = t.indexOf("-");
  const core = dash < 0 ? t : t.slice(0, dash);
  const it = core.split(".");
  const n = (s: string | undefined): number | null => (s !== undefined && /^\d+$/.test(s) ? Number(s) : null);
  const a = n(it[0]);
  const b = n(it[1]);
  if (a === null || b === null) return null;
  return [a, b, n(it[2]) ?? 0, dash < 0];
}
const rustNewer = (c: string, cur: string): boolean => {
  const x = rustParse(c);
  const y = rustParse(cur);
  if (x === null || y === null) return false;
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return Number(x[i]) > Number(y[i]);
  return false;
};
// Update.java `code`: what the phone compares.
function phoneCode(v: string): number {
  const p = v.trim().replace(/^v/, "").split("-")[0]?.split(".") ?? [];
  let out = 0;
  for (let i = 0; i < 3; i++) {
    const s = p[i];
    if (s !== undefined && !/^\d+$/.test(s)) return 0;
    out = out * 1000 + (s === undefined ? 0 : Number(s));
  }
  return out;
}

test("this app's version is above the Rust release it matches, and what it tells peers and phones is not", () => {
  const mine = "0.109.1-ts";
  expect(compare(mine, RUST_PARITY)).toBeGreaterThan(0);
  expect(rustNewer(mine, RUST_PARITY)).toBe(true);
  const said = advertised(mine);
  expect(said).toBe("0.109.0.ts");
  expect(rustNewer(said, RUST_PARITY)).toBe(false);
  expect(rustNewer(RUST_PARITY, said)).toBe(false);
  expect(compare(said, RUST_PARITY)).toBe(0);
  expect(phoneCode(said)).toBe(phoneCode(RUST_PARITY));
  expect(advertised("0.108.0")).toBe("0.108.0");
  expect(advertised("0.0.0-dev")).toBe("0.0.0-dev");
});

test("a Rust release has no build of this app: nothing is swapped and the staging folder is gone", async () => {
  const key = await makeKey();
  const host = new FakeHost();
  await host.publish(key, "1.1.0", { "harbor-x86_64-linux.tar.gz": "rust" });
  host.latest = "1.1.0";
  const inst = makeInstall();
  const before = readFileSync(join(inst.dir, "harbor-app.js"), "utf8");
  const err = await install(host.config(inst, key), "1.1.0").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(NoBuild);
  expect(readFileSync(join(inst.dir, "harbor-app.js"), "utf8")).toBe(before);
  expect(readFileSync(join(inst.dir, "VERSION"), "utf8")).toBe("1.0.0");
  expect(existsSync(join(inst.dir, ".staging"))).toBe(false);
  expect(existsSync(join(inst.dir, ".previous"))).toBe(false);
});

test("the updater stays up to date on a Rust-only release, says no error, doesn't retry it and takes its phone app", async () => {
  const key = await makeKey();
  const host = new FakeHost();
  const apk = new Uint8Array([0x50, 0x4b, 3, 4, 9, 9]);
  await host.publish(key, "1.1.0", { "harbor-x86_64-linux.tar.gz": "rust", "harbor-android.apk": apk });
  host.latest = "1.1.0";
  const inst = makeInstall();
  const logs: string[] = [];
  const swapped: string[] = [];
  const updater = new Updater(host.config(inst, key, { worker: null, log: (m) => void logs.push(m) }), { swap: (v) => void swapped.push(v), advertise: advertised });
  await updater.check();
  expect(updater.state()).toEqual({ t: "upToDate" });
  const info = updater.info();
  expect(info.latest).toBeNull();
  expect(info.error).toBeNull();
  expect(info.status).toBe("up to date");
  expect(info.version).toBe("0.109.0.ts");
  expect(swapped).toEqual([]);
  expect(logs).toEqual([]);
  expect(readFileSync(join(inst.dir, "harbor-android.apk"))).toEqual(Buffer.from(apk));
  expect(readFileSync(join(inst.dir, "harbor-android.version"), "utf8")).toBe("1001000");
  const asked = host.hits.filter((h) => h.includes("harbor-app.json")).length;
  await updater.check();
  await updater.onRelease("1.1.0");
  expect(host.hits.filter((h) => h.includes("harbor-app.json")).length).toBe(asked);
  expect(updater.state()).toEqual({ t: "upToDate" });
});

test("harbor --update on a Rust-only release says so and keeps this one", async () => {
  const key = await makeKey();
  const host = new FakeHost();
  await host.publish(key, "1.1.0", { "harbor-x86_64-linux.tar.gz": "rust" });
  host.latest = "1.1.0";
  const inst = makeInstall();
  const out: string[] = [];
  const err: string[] = [];
  expect(await updateCli(host.config(inst, key), "--update", { out: (l) => void out.push(l), err: (l) => void err.push(l) })).toBe(0);
  expect(out.at(-1)).toBe("Harbor 1.1.0 has no build of this app yet: staying on 1.0.0.");
  expect(err).toEqual([]);
});

const bundle = (version: string, ran: string[]): AppBundle => ({
  meta: { version, minRuntime: "1.0.0" },
  main: (argv) => (ran.push(`${version} ${argv.join(" ")}`), 0),
});

test("a single executable runs the bundle it carries unless a newer one was installed beside it", async () => {
  const inst = makeInstall({ version: "1.0.0" });
  const ran: string[] = [];
  const cfg = configFor(inst);
  const loaded: string[] = [];
  const load = async (p: string): Promise<unknown> => (loaded.push(p), bundle("1.2.0", ran));
  const opts = { cfg, armWatchdog: false, load, embedded: bundle("1.1.0", ran) };
  expect(await launch(["turn", "x"], opts)).toBe(0);
  expect(ran.at(-1)).toBe("1.1.0 turn x");
  expect(loaded).toEqual([]);
  expect(globalThis.__harbor?.runtime?.bundle).toBe(inst.exe);
  writeFileSync(join(inst.dir, "VERSION"), "1.2.0");
  expect(await launch(["turn", "y"], opts)).toBe(0);
  expect(ran.at(-1)).toBe("1.2.0 turn y");
  expect(loaded).toEqual([join(inst.dir, "harbor-app.js")]);
  expect(useEmbedded({ kind: "release", path: join(inst.dir, "nothing.js"), id: "", version: "9.0.0" }, bundle("1.1.0", ran))).toBe(true);
  expect(useEmbedded({ kind: "preview", path: join(inst.dir, "harbor-app.js"), id: "p", version: "1.0.0" }, bundle("1.1.0", ran))).toBe(false);
});
