import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outputWithin, type ProcOptions, type ProcOutput, type Spawner } from "../src/proc.ts";
import { newHost } from "../src/remote.ts";
import {
  configLines,
  deviceWhy,
  dirtyScript,
  placeFiles,
  placeName,
  placeOf,
  pullScript,
  pushScript,
  relocateBlocker,
  relocateCheck,
  relocateRun,
  relocateSessions,
  relocateWhy,
  relocatedText,
  type RelocateDev,
  type RelocatePlace,
} from "../src/relocate.ts";
import { sessionDir } from "../src/movepc.ts";
import { newPeer } from "../src/shared.ts";

function tmp(tag: string): string {
  return mkdtempSync(join(tmpdir(), `reloc-${tag}-`));
}

function sh(script: string, home: string, input: Uint8Array = new Uint8Array()): Promise<ProcOutput> {
  return outputWithin("sh", ["-c", script], { timeoutMs: 20_000, cwd: home, env: { HOME: home }, input });
}

const SID = "1c0ffee0-aaaa-4bbb-8ccc-0123456789ab";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("relocate", () => {
  test("profile_lines_follow_the_turn_setup", () => {
    expect(configLines([])).toBe('c="$HOME/.claude"');
    expect(configLines([{ kind: "token" }, { kind: "guest", rel: ".local/state/harbor/guests/pc-a" }]).startsWith("c=\"$HOME\"/'.local/state/harbor/guests/pc-a'")).toBe(true);
    expect(configLines([{ kind: "profile", rel: ".claude2" }])).toContain("[ -d \"$HOME\"/'.claude2' ] && c=\"$HOME\"/'.claude2'");
  });

  // The device side with a plain `sh` and a fake home: the newest copy in any profile is packed with its sidecar, unpacked where the turn's profile and folder say.
  test("sessions_travel_through_the_device_scripts", async () => {
    const dev = tmp("dev");
    const here = tmp("here");
    const other = tmp("other");
    try {
      // Two copies: the newer in a profile folder of another project.
      const old = join(dev, ".claude/projects/-x-old");
      const fresh = join(dev, ".claude2/projects/-x-new");
      for (const d of [old, fresh]) mkdirSync(join(d, SID, "subagents"), { recursive: true });
      writeFileSync(join(old, `${SID}.jsonl`), "old\n");
      await sleep(20);
      writeFileSync(join(fresh, `${SID}.jsonl`), "new\n");
      writeFileSync(join(fresh, SID, "subagents/a.jsonl"), "{}\n");
      const out = await sh(pullScript(SID), dev);
      expect(out.code).toBe(0);
      const x = await outputWithin("tar", ["-xf", "-", "-C", here], { timeoutMs: 20_000, input: out.stdout });
      expect(x.code).toBe(0);
      expect(readFileSync(join(here, `${SID}.jsonl`), "utf8")).toBe("new\n");
      expect(existsSync(join(here, SID, "subagents/a.jsonl"))).toBe(true);
      // None there: a clear word, exit 96.
      const none = await sh(pullScript("no-such-session"), dev);
      expect(none.code).toBe(96);
      expect(none.stderr.toString()).toContain("isn't on");
      // Back onto a device, in the folder its turn runs in, under the guest profile.
      mkdirSync(join(other, "code/app"), { recursive: true });
      const packed = (await outputWithin("tar", ["-cf", "-", "-C", here, `${SID}.jsonl`, SID], { timeoutMs: 20_000 })).stdout;
      const lines = configLines([{ kind: "guest", rel: ".local/state/harbor/guests/pc-a" }]);
      const put = await sh(pushScript("~/code/app", lines), other, packed);
      expect(put.stderr.toString()).toBe("");
      expect(put.code).toBe(0);
      const slug = realpathSync(join(other, "code/app")).replace(/[^A-Za-z0-9]/g, "-");
      const placed = join(other, ".local/state/harbor/guests/pc-a/projects", slug);
      expect(readFileSync(join(placed, `${SID}.jsonl`), "utf8")).toBe("new\n");
      expect(existsSync(join(placed, SID, "subagents/a.jsonl"))).toBe(true);
      // A folder that isn't there: exit 97, said.
      const missing = await sh(pushScript("~/code/missing", lines), other, packed);
      expect(missing.code).toBe(97);
      expect(missing.stderr.toString()).toContain("doesn't exist");
    } finally {
      for (const d of [dev, here, other]) rmSync(d, { recursive: true, force: true });
    }
  });

  test("device_folders_report_uncommitted_changes", async () => {
    const home = tmp("dirty");
    try {
      const repo = join(home, "code/app");
      mkdirSync(repo, { recursive: true });
      const count = async (dir = "~/code/app") => (await sh(dirtyScript(dir), home)).stdout.toString().trim();
      expect(await count()).toBe("0");
      execFileSync("git", ["-C", repo, "init", "-q"]);
      writeFileSync(join(repo, "a.txt"), "x");
      writeFileSync(join(repo, "b.txt"), "x");
      expect(await count()).toBe("2");
      expect(await count("~/code/none")).toBe("0");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("files_change_place_only_with_device_files", () => {
    const h = (files: boolean): RelocatePlace => ({ kind: "device", host: newHost({ id: "ssh:1", device_files: files }) });
    const here: RelocatePlace = { kind: "here" };
    expect(placeFiles(here)).toBe(placeFiles(h(false)));
    expect(placeFiles(here)).not.toBe(placeFiles(h(true)));
    expect(placeFiles(h(true))).not.toBe(placeFiles({ kind: "hub", peer: newPeer({ id: "pc:b" }) }));
  });
});

describe("relocate beyond the Rust tests", () => {
  // `ssh <host> sh -c '<script>'` runs here, in the fake home of that host.
  function fakeSsh(homes: Record<string, string>): Spawner {
    return (program: string, args: string[], o: ProcOptions) => {
      if (program !== "ssh") return outputWithin(program, args, o);
      const host = args[args.length - 2] ?? "";
      const home = homes[host];
      if (home === undefined) return Promise.reject(new Error("no route"));
      return outputWithin("sh", ["-c", args[args.length - 1] ?? ""], { ...o, cwd: home, env: { ...o.env, HOME: home } });
    };
  }

  test("a session goes from a device to this PC and back to another device", async () => {
    const root = tmp("run");
    try {
      const devA = join(root, "a");
      const devB = join(root, "b");
      const home = join(root, "home");
      const data = join(root, "data");
      mkdirSync(join(devA, ".claude/projects/-x/", SID, "subagents"), { recursive: true });
      writeFileSync(join(devA, ".claude/projects/-x", `${SID}.jsonl`), "{}\n");
      writeFileSync(join(devA, ".claude/projects/-x", SID, "subagents/a.jsonl"), "s\n");
      mkdirSync(join(devB, "code/app"), { recursive: true });
      mkdirSync(join(home, "proj"), { recursive: true });
      const run = fakeSsh({ a: devA, b: devB });
      const env = { home, dataDir: data, overlays: () => [] as string[], run, newId: () => "job" };
      const a: RelocateDev = { name: "A", ssh: ["-p", "22"], host: "a", dir: "~", config: configLines([]) };
      const b: RelocateDev = { name: "B", ssh: [], host: "b", dir: "~/code/app", config: configLines([]) };
      const cwd = join(home, "proj");
      await relocateRun({ from: a, to: null, sessions: [{ sid: SID, config: null, here: cwd }], check: { kind: "none" } }, env);
      const dir = sessionDir(home, null, cwd);
      expect(readFileSync(join(dir, `${SID}.jsonl`), "utf8")).toBe("{}\n");
      expect(readFileSync(join(dir, SID, "subagents/a.jsonl"), "utf8")).toBe("s\n");
      expect(existsSync(join(data, "relocate", "job"))).toBe(false);
      await relocateRun({ from: null, to: b, sessions: [{ sid: SID, config: null, here: cwd }], check: { kind: "none" } }, env);
      const slug = realpathSync(join(devB, "code/app")).replace(/[^A-Za-z0-9]/g, "-");
      expect(readFileSync(join(devB, ".claude/projects", slug, `${SID}.jsonl`), "utf8")).toBe("{}\n");
      await expect(relocateRun({ from: null, to: b, sessions: [{ sid: "nope", config: null, here: cwd }], check: { kind: "none" } }, env)).rejects.toThrow("its Claude session isn't on this PC");
      await expect(relocateRun({ from: b, to: null, sessions: [{ sid: "nope", config: null, here: cwd }], check: { kind: "none" } }, env)).rejects.toThrow("couldn't read the session on B: harbor: the chat's session isn't on");
      const gone: RelocateDev = { ...a, host: "gone" };
      await expect(relocateRun({ from: gone, to: null, sessions: [{ sid: SID, config: null, here: cwd }], check: { kind: "none" } }, env)).rejects.toThrow("ssh to A: no route");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the files check refuses uncommitted changes", async () => {
    const root = tmp("check");
    try {
      const dev = join(root, "dev");
      const repo = join(dev, "code/app");
      mkdirSync(repo, { recursive: true });
      execFileSync("git", ["-C", repo, "init", "-q"]);
      writeFileSync(join(repo, "a.txt"), "x");
      const d: RelocateDev = { name: "Dev", ssh: [], host: "dev", dir: "~/code/app", config: configLines([]) };
      const env = { home: join(root, "home"), dataDir: join(root, "data"), overlays: () => [] as string[], run: fakeSsh({ dev }) };
      await expect(relocateRun({ from: null, to: null, sessions: [], check: { kind: "device", dev: d } }, env)).rejects.toThrow("~/code/app on Dev has 1 uncommitted change: commit or stash them first");
      await expect(relocateRun({ from: null, to: null, sessions: [], check: { kind: "here", dir: repo } }, env)).rejects.toThrow("1 uncommitted change");
      await relocateRun({ from: null, to: null, sessions: [], check: { kind: "device", dev: { ...d, dir: "~/code/none" } } }, env);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blockers and reasons", () => {
    const lead = { id: 1, name: "lead", device: "ssh:1", claude: true, running: false };
    const sub = { id: 2, name: "helper", device: "ssh:1", claude: true, running: false };
    const base = { foreignHome: null, isSub: false, movingTo: null, chats: [lead, sub], leadDevice: { os: "linux" } };
    expect(relocateBlocker(base)).toBeNull();
    expect(relocateBlocker({ ...base, foreignHome: "desk" })).toBe("it runs in desk's Harbor: change it there, or move it with Move to PC…");
    expect(relocateBlocker({ ...base, chats: [lead, { ...sub, device: "" }] })).toBe("its sub-agent helper runs on another device");
    expect(relocateBlocker({ ...base, leadDevice: null })).toBe("its device isn't in Settings › Workspace anymore, so its session can't be fetched");
    expect(relocateBlocker({ ...base, leadDevice: { os: "Windows" } })).toBe("Windows devices can't hand a started chat over yet");
    expect(relocateBlocker({ ...base, chats: [{ ...lead, running: true }] })).toBe("it is running: move it once its turn ends");

    const win = newHost({ id: "ssh:2", os: "windows" });
    const hub = newPeer({ id: "pc:b", online: true, moves: true, accounts: [["claude", "C", "claude"]] });
    const why = (to: string, over: { blocker?: string | null; meshOn?: boolean; online?: boolean | null; peer?: Partial<typeof hub> } = {}) =>
      relocateWhy({
        started: true,
        device: "",
        to,
        blocker: () => over.blocker ?? null,
        place: placeOf(to, [{ ...hub, ...over.peer }], [[win, over.online ?? true]]),
        meshOn: over.meshOn ?? true,
      });
    expect(why("")).toBeNull();
    expect(why("", { blocker: "busy" })).toBeNull();
    expect(why("ssh:1")).toBe("no such device");
    expect(why("ssh:2")).toBe("Windows devices can't take a started chat yet");
    expect(why("pc:b", { blocker: "busy" })).toBe("busy");
    expect(why("pc:b")).toBeNull();
    expect(why("pc:b", { meshOn: false })).toBe("this PC doesn't share chats with other PCs (Settings › Workspace)");
    expect(why("pc:b", { peer: { online: false } })).toBe("it's off or out of reach");
    expect(why("pc:b", { peer: { moves: false } })).toBe("it runs an older Harbor: update it first");
    expect(why("pc:b", { peer: { accounts: [] } })).toBe("it has no Claude account");
    expect(relocateWhy({ started: false, device: "", to: "x", blocker: () => "no", place: null, meshOn: true })).toBeNull();
    expect(deviceWhy(false, false, ["a"], () => "x")).toBeNull();
    expect(deviceWhy(true, false, ["a", "b"], (id) => (id === "b" ? "off" : null))).toEqual({ b: "off" });
  });

  test("places, names, sessions and checks", () => {
    const me = { name: "", hostname: "desk" };
    expect(placeName({ kind: "here" }, me)).toBe("desk");
    expect(placeName({ kind: "device", host: newHost({ id: "ssh:1", host: "devbox" }) }, me)).toBe("devbox");
    expect(placeName({ kind: "hub", peer: newPeer({ id: "pc:lap", name: "" }) }, me)).not.toBe("");
    expect(relocateSessions([{ name: "a", started: true, session_id: SID, configDir: null }, { name: "b", started: false, session_id: "", configDir: null }], "/w")).toEqual([{ sid: SID, config: null, here: "/w" }]);
    expect(() => relocateSessions([{ name: "a", started: true, session_id: "../x", configDir: null }], "/w")).toThrow("a's session id looks wrong");
    const dev = newHost({ id: "ssh:1", device_files: true });
    const d: RelocateDev = { name: "D", ssh: [], host: "d", dir: "~", config: "" };
    const hub: RelocatePlace = { kind: "hub", peer: newPeer({ id: "pc:b" }) };
    const devPlace: RelocatePlace = { kind: "device", host: dev };
    expect(relocateCheck({ source: { kind: "here" }, target: { kind: "here" }, hasRepo: true, sourceDev: null, cwd: "/w" })).toEqual({ kind: "none" });
    expect(relocateCheck({ source: devPlace, target: { kind: "here" }, hasRepo: true, sourceDev: d, cwd: "/w" })).toEqual({ kind: "device", dev: d });
    expect(relocateCheck({ source: { kind: "here" }, target: devPlace, hasRepo: true, sourceDev: null, cwd: "/w" })).toEqual({ kind: "here", dir: "/w" });
    expect(relocateCheck({ source: { kind: "here" }, target: hub, hasRepo: true, sourceDev: null, cwd: "/w" })).toEqual({ kind: "none" });
    expect(relocateCheck({ source: { kind: "here" }, target: devPlace, hasRepo: false, sourceDev: null, cwd: "/w" })).toEqual({ kind: "none" });
    expect(relocatedText({ kind: "here" }, "A", "desk").detail).toBe("Its Claude session came along; its next turn runs on this PC.");
  });
});
