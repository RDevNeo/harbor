import { describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { APP_INBOX, Hub, type Token } from "../src/hub.ts";
import { newConfig, newHost } from "../src/remote.ts";
import { newPeer } from "../src/shared.ts";
import { newPcVersion, runningVersion } from "../src/versions.ts";
import {
  DEVICE_SEND_MAX,
  FileBrowser,
  clearDeviceTransfers,
  deviceCanSend,
  deviceDetails,
  deviceDirName,
  deviceFrom,
  deviceGroup,
  deviceGuessImage,
  deviceHumanSize,
  deviceJson,
  deviceParseListing,
  deviceSend,
  deviceShCmd,
  deviceSshArgs,
  freeFileName,
  imageSendNote,
  newDeviceTransfer,
  newPairedDevice,
  pairedDevices,
  phoneAppNote,
  previewCachePath,
  receiveDelivery,
  sendMenuNote,
  transferStatus,
  type DeliverSink,
  type DeviceTransfer,
  type SshSpawn,
  spawnLocal,
} from "../src/devices.ts";

function tmp(tag: string): string {
  return mkdtempSync(join(tmpdir(), `devices-${tag}-`));
}

function tok(token: string, group = "", name = ""): Token {
  return { token, name, created: 0, group, fp: "", account: "", account_name: "" };
}

const ip = (...o: number[]) => o.join(".");

function sink(over: Partial<DeliverSink> & { body?: Buffer } = {}): DeliverSink & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    home: "/home/me",
    downloads: () => "/nonexistent-downloads",
    copyText: (t) => log.push(`text ${t}`),
    copyImage: (b) => log.push(`image ${b.length}`),
    open: (p) => log.push(`open ${p}`),
    notify: (a, b) => log.push(`notify ${a} | ${b}`),
    read: async (len, max) => {
      const b = over.body ?? Buffer.alloc(0);
      if (len > max || b.length < len) throw new Error("short or too large");
      return b.subarray(0, len);
    },
    ...over,
  };
}

describe("devices", () => {
  test("ssh_reuses_one_connection_through_harbor_nc", () => {
    const h = newHost({ id: "pc:desk", host: ip(192, 0, 2, 5), user: "me" });
    const ctx = { home: "/home/me", selfExe: () => null, sshConfig: () => [], probe: () => undefined };
    const v = deviceSshArgs(ctx, newConfig(), h);
    const joined = v.join(" ");
    expect(joined.startsWith("-o ControlMaster=auto -o ControlPath=")).toBe(true);
    expect(v.filter((o) => o.startsWith("ControlMaster=")).length).toBe(1);
    expect(v.filter((o) => o.startsWith("ControlPath=")).length).toBe(1);
    expect(joined).toContain("-l me");
    expect(v.slice(-2)).toEqual(["--", ip(192, 0, 2, 5)]);
  });

  test("device_keys_stay_one_cache_folder", () => {
    expect(deviceDirName("pc:desk")).toBe("pc_desk");
    for (const k of ["/tmp/x", "../../x", "..", ".", "", "a/b\0c"]) {
      const d = deviceDirName(k);
      expect(!d.includes("/") && d !== "." && d !== ".." && d !== "").toBe(true);
      expect(dirname(join("/c", d))).toBe(join("/c"));
    }
  });

  test("remote_commands_survive_any_login_shell", () => {
    // a name that breaks out of POSIX quoting under fish
    const dir = tmp("devq");
    try {
      const name = join(dir, "\\';touch poc;#.png");
      writeFileSync(name, "ok");
      const line = deviceShCmd(`cat -- '${name.replaceAll("'", "'\\''")}'`);
      expect(!line.includes("\\") && line.split("'").length - 1 === 2).toBe(true);
      if (spawnSync("python3", ["-V"]).status === 0) {
        const o = spawnSync("bash", ["-c", line], { cwd: dir, encoding: "utf8" });
        expect(o.stdout).toBe("ok");
        expect(existsSync(join(dir, "poc"))).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("receive_refuses_what_it_cant_take", async () => {
    expect((await receiveDelivery("desk", "nope", "x", 0, sink())).status).toBe(400);
    expect((await receiveDelivery("desk", "file", "x", DEVICE_SEND_MAX + 1, sink())).status).toBe(413);
    expect((await receiveDelivery("desk", "clip-image", "x", 12, sink({ body: Buffer.from("not an image") }))).status).toBe(400);
  });

  test("devices_round_trip_for_reload", () => {
    const d = newPairedDevice({ key: "phone:g1", name: "Pixel", kind: "android", online: true, ip: ip(192, 0, 2, 9), seen: 5 });
    const back = deviceFrom(deviceJson(d));
    expect([back.key, deviceGroup(back), back.kind === "android", back.seen]).toEqual(["phone:g1", "g1", true, 5]);
    expect(deviceCanSend(back)).toBe(true);
    expect(deviceCanSend(newPairedDevice({ kind: "pc" }))).toBe(false);
  });
});

describe("devices beyond the Rust tests", () => {
  test("sizes, names and notes", () => {
    expect([0, 1023, 1024, 2560, 1_048_575, 1_310_720, 5_368_709_120].map(deviceHumanSize)).toEqual(["0 B", "1023 B", "1 KB", "2 KB", "1024 KB", "1.2 MB", "5.0 GB"]);
    const d = tmp("free");
    try {
      writeFileSync(join(d, "a.png"), "x");
      writeFileSync(join(d, "a (2).png"), "x");
      expect(freeFileName(d, "a.png")).toBe(join(d, "a (3).png"));
      expect(freeFileName(d, "b.png")).toBe(join(d, "b.png"));
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
    expect(phoneAppNote(0, 0, 66000)).toBeNull();
    expect(phoneAppNote(0, 5, 0)).toEqual(["app older than 0.17: update it", true]);
    expect(phoneAppNote(APP_INBOX, 5, 0)).toEqual(["app 0.17+", false]);
    expect(phoneAppNote(APP_INBOX, 5, 66000)).toEqual(["app 0.17+, 0.66.0 available", true]);
    expect(phoneAppNote(18001, 5, 19000)).toEqual(["app 0.18.1 → 0.19.0 available", true]);
    expect(phoneAppNote(19000, 5, 19000)).toEqual(["app 0.19.0", false]);
    expect(sendMenuNote(newPairedDevice({ kind: "android", seen: 1, app: 100 }))).toBe("The phone's app is too old to take these: update it (Settings › Update there)");
    expect(sendMenuNote(newPairedDevice({ kind: "android", seen: 1, app: 99999 }))).toBe("Arrives when Harbor is open on the phone");
    expect(sendMenuNote(newPairedDevice({ kind: "pc" }))).toBeNull();
    expect(imageSendNote({ kind: "pc" })).toBe("Saved to its Downloads and opened there");
    expect(deviceGuessImage(Buffer.from("89504e470d0a1a0a", "hex"))).toBe(true);
    expect(deviceGuessImage(Buffer.from("hello"))).toBe(false);
  });

  test("the row says what is known", () => {
    const at = 10_000;
    const phone = newPairedDevice({ kind: "android", online: true, open: true, via: "laptop", owner: "Sam", app: 66000, seen: at - 10 });
    expect(deviceDetails(phone, 66000, at)).toBe("Phone · Harbor open, via laptop · Sam · app 0.66.0");
    expect(deviceDetails(newPairedDevice({ kind: "android", online: true }), 0, at)).toBe("Phone · online");
    const off = newPairedDevice({ kind: "pc", down: "harbor", seen: at - 7200, harbor: "Harbor 0.66.0" });
    expect(deviceDetails(off, 0, at)).toBe("PC · Harbor isn't running, seen 2h ago · Harbor 0.66.0");
    expect(deviceDetails(newPairedDevice({ kind: "pc", online: true, ip: ip(192, 0, 2, 7) }), 0, at)).toBe(`PC · online · ${ip(192, 0, 2, 7)}`);
    expect(deviceDetails(newPairedDevice({ kind: "pc" }), 0, at)).toBe("PC · offline");
  });

  test("transfers read as the list shows them", () => {
    const t = (o: Partial<DeviceTransfer>) => transferStatus(newDeviceTransfer(o));
    expect(t({ error: "no" })).toBe("no");
    expect(t({ done: true, size: 2048, saved: "/d/a.png" })).toBe("2 KB · saved to /d/a.png");
    expect(t({ done: true })).toBe("Done");
    expect(t({ done: true, size: 12 })).toBe("12 B");
    expect(t({ waiting: true })).toBe("Waiting for Harbor on the phone (open the app)");
    expect(t({ sent: 1024, size: 4096 })).toBe("1 KB of 4 KB");
    expect(clearDeviceTransfers([newDeviceTransfer({ done: true }), newDeviceTransfer({ error: "x" }), newDeviceTransfer({})]).length).toBe(1);
  });

  test("a PC's running version is its update info's build, else the advertised one", () => {
    expect(runningVersion(newPcVersion({ version: "0.109.0.ts", update: { managed: true, build: "0.167.1+abc1234" } }))).toBe("0.167.1+abc1234");
    expect(runningVersion(newPcVersion({ version: "0.109.0.ts", update: { managed: true } }))).toBe("0.109.0.ts");
    expect(runningVersion(newPcVersion({ version: "0.66.0", update: null }))).toBe("0.66.0");
  });

  test("paired devices: this PC first, PCs from the mesh, phones from the hub", () => {
    const hub = new Hub([tok("t1", "g1", "Pixel")], 0);
    hub.mesh.on = true;
    hub.enabled = true;
    hub.mesh.workspacePeers = () => [
      { node: "", name: "desk", fp: "fp1", id: "pc:desk", addrs: [`${ip(192, 0, 2, 5)}:7878`] },
      { node: "", name: "lap", fp: "fp2", id: "pc:lap", addrs: [] },
    ];
    hub.mesh.peers.set("pc:desk", newPeer({ id: "pc:desk", online: true, seen: 50 }));
    hub.mesh.peers.set("pc:lap", newPeer({ id: "pc:lap", online: false, seen: 40 }));
    hub.mesh.down.set("pc:lap", "harbor");
    hub.seen.set("t1", ["", 990]);
    hub.alive.set("t1", [995, 0]);
    hub.apps.set("t1", 66000);
    const versions = [newPcVersion({ id: "pc:lap", name: "lap", version: "0.60.0" }), newPcVersion({ id: "pc:desk", name: "desk", online: true, version: "0.66.0", update: { managed: true, latest: "0.66.0", build: "0.66.0+abc1234" } })];
    const [self, ...v] = pairedDevices(hub, versions, 1000);
    expect(self).toMatchObject({ key: hub.mesh.me.id, name: hub.mesh.me.name, kind: "pc", online: true, here: true });
    expect(deviceCanSend(self!)).toBe(false);
    expect(deviceDetails(self!, 0, 1000).startsWith("This PC")).toBe(true);
    expect(v.map((d) => [d.key, d.kind, d.online, d.down, d.seen])).toEqual([
      ["pc:desk", "pc", true, "", 50],
      ["pc:lap", "pc", false, "harbor", 40],
      ["phone:g1", "android", true, "", 995],
    ]);
    expect(v[0]?.harbor.startsWith("Harbor 0.66.0+abc1234")).toBe(true);
    expect(v[1]?.harbor).toBe("Harbor 0.60.0");
    expect(v[2]).toMatchObject({ name: "Pixel", open: true, app: 66000 });
    hub.mesh.on = false;
    hub.enabled = false;
    expect(pairedDevices(hub, versions, 1000).map((d) => d.online)).toEqual([true, false, false]);
  });

  test("sends go to a phone through the hub and to a PC over the mesh", async () => {
    const root = tmp("send");
    try {
      const file = join(root, "a.txt");
      writeFileSync(file, "hello");
      const hub = new Hub([tok("t1", "g1")], 0);
      const calls: { path: string; body: string }[] = [];
      const woke: number[] = [];
      const env = {
        hub,
        peer: (k: string) => (k === "pc:desk" ? newPeer({ id: "pc:desk", name: "desk", addr: `127.0.0.1:1` }) : null),
        http: async (_d: unknown, _m: string, path: string, body: { data: string | Uint8Array } | null): Promise<[number, unknown]> => {
          calls.push({ path, body: Buffer.from(body?.data ?? "").toString() });
          return path.includes("kind=text") ? [200, { ok: true }] : [409, { error: "full" }];
        },
        clock: () => 7,
        wake: () => woke.push(1),
      };
      const list: DeviceTransfer[] = [];
      const phone = newPairedDevice({ key: "phone:g1", name: "Pixel", kind: "android" });
      await deviceSend(phone, "file", null, [file], list, env);
      expect(list.map((t) => [t.label, t.waiting, t.size])).toEqual([["a.txt → Pixel", true, 5]]);
      expect(hub.inbox.map((p) => [p.group, p.kind, p.name, p.at, p.path])).toEqual([["g1", "file", "a.txt", 7, file]]);
      hub.inbox[0]?.report(5, true, null);
      expect(list[0]).toMatchObject({ waiting: false, done: true, sent: 5 });

      const pc = newPairedDevice({ key: "pc:desk", name: "desk", kind: "pc", online: true });
      const l2: DeviceTransfer[] = [];
      await deviceSend(pc, "text", "ok", [], l2, env);
      expect(calls[0]).toEqual({ path: "/mesh/v1/deliver?kind=text&name=Text", body: "ok" });
      expect(l2[0]).toMatchObject({ label: "Text → desk's clipboard", done: true, error: null });
      const l3: DeviceTransfer[] = [];
      await deviceSend(pc, "file", null, [file], l3, env);
      expect(l3[0]).toMatchObject({ done: false, error: "full" });
      await deviceSend(newPairedDevice({ key: "pc:none", name: "gone", kind: "pc" }), "text", "x", [], l3, env);
      expect(l3[1]?.error).toBe("this PC isn't connected right now");
      // Not a PNG and no converter: the transfer says so, nothing is sent.
      const l4: DeviceTransfer[] = [];
      await deviceSend(pc, "clip-image", null, [file], l4, env);
      expect(l4).toMatchObject([{ label: "a.txt → desk's clipboard", error: "only PNG and JPEG images can go on the clipboard" }]);
      const old = { ...env, http: async (): Promise<[number, unknown]> => [404, null] };
      const l5: DeviceTransfer[] = [];
      await deviceSend(pc, "text", "x", [], l5, old);
      expect(l5[0]?.error).toBe("desk's Harbor is too old to take this: update it");
      const down = { ...env, http: async (): Promise<[number, unknown]> => { throw new Error("timed out"); } };
      const l6: DeviceTransfer[] = [];
      await deviceSend(pc, "text", "x", [], l6, down);
      expect(l6[0]?.error).toBe("desk didn't answer: timed out");
      expect(woke.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("what a PC delivers lands on the clipboard or in Downloads", async () => {
    const root = tmp("recv");
    try {
      const s = sink({ downloads: () => join(root, "dl"), home: root, body: Buffer.from("hello") });
      expect((await receiveDelivery("desk", "text", "Text", 5, s)).status).toBe(200);
      expect(s.log).toEqual(["text hello", "notify Copied to clipboard | Text from desk"]);
      const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("rest")]);
      const si = sink({ body: png });
      expect((await receiveDelivery("desk", "clip-image", "x", png.length, si)).status).toBe(200);
      expect(si.log[0]).toBe(`image ${png.length}`);
      expect((await receiveDelivery("desk", "text", "Text", 9, s)).body).toEqual({ error: "short or too large" });

      const f = sink({ downloads: () => join(root, "dl"), home: root, body: Buffer.from("data") });
      expect((await receiveDelivery("desk", "file", "../a.txt", 4, f)).status).toBe(200);
      expect((await receiveDelivery("desk", "image", "a.txt", 4, f)).status).toBe(200);
      expect(readdirSync(join(root, "dl")).sort()).toEqual(["a (2).txt", "a.txt"]);
      expect(f.log).toEqual([`notify From desk | a.txt, in ~/dl`, `open ${join(root, "dl", "a (2).txt")}`, `notify From desk | a (2).txt, in ~/dl`]);
      const short = await receiveDelivery("desk", "file", "b.txt", 10, f);
      expect(short.status).toBe(500);
      expect(readdirSync(join(root, "dl")).some((n) => n.endsWith(".part"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a listing is sorted and checked", () => {
    const out = deviceParseListing(Buffer.from(JSON.stringify({ path: "/home/x", entries: [["b.txt", false, 5, 100], ["Zdir", true, 0, 0], ["a.png", false, 10, 5], ["adir", true, 0, 0], [".hid", false, 1, 1]] })));
    expect(out.path).toBe("/home/x");
    expect(out.entries.map((e) => e.name)).toEqual(["adir", "Zdir", ".hid", "a.png", "b.txt"]);
    expect(() => deviceParseListing(Buffer.from("nope"))).toThrow("unexpected answer");
    expect(deviceParseListing(Buffer.from("{}"))).toEqual({ path: "/", entries: [] });
    const p = previewCachePath("/c", "pc:desk", "/x/Photo.PNG", 99);
    expect(p).toMatch(/^[\\/]c[\\/]harbor[\\/]devices[\\/]pc_desk[\\/][0-9a-f]{16}\.png$/);
    expect(previewCachePath("/c", "pc:desk", "/x/Photo.PNG", 99)).toBe(p);
    expect(previewCachePath("/c", "pc:desk", "/x/Photo.PNG", 100)).not.toBe(p);
  });

  // ssh is replaced by a local sh: the base64 wrapper is decoded and the command runs here; a python3 listing is answered from `listing`.
  function fakeSsh(listing: () => { code: number; out: string; err: string }): { spawn: SshSpawn; ran: string[] } {
    const ran: string[] = [];
    const spawnFake: SshSpawn = (args, stdin, stdout) => {
      const last = args[args.length - 1] ?? "";
      const cmd = Buffer.from(/b64decode\("([^"]+)"\)/.exec(last)?.[1] ?? "", "base64").toString("utf8");
      ran.push(cmd);
      if (cmd.startsWith("python3 -c")) {
        const l = listing();
        return spawn("sh", ["-c", `printf %s "$OUT"; printf %s "$ERR" >&2; exit ${l.code}`], { env: { ...process.env, OUT: l.out, ERR: l.err }, stdio: [stdin, stdout, "pipe"] }) as ChildProcess;
      }
      return spawn("sh", ["-c", cmd], { stdio: [stdin, stdout, "pipe"] });
    };
    return { spawn: spawnFake, ran };
  }

  test.skipIf(Bun.which("python3") === null)("this PC's file browser lists its own folders without ssh", async () => {
    const root = tmp("fblocal");
    try {
      writeFileSync(join(root, "here.txt"), "local");
      mkdirSync(join(root, "sub"));
      const fb = new FileBrowser(newPairedDevice({ key: "pc:me", name: "me", kind: "pc", here: true }), [], root, { home: root, spawn: spawnLocal, downloads: () => join(root, "dl") });
      await fb.idle();
      expect(fb.error).toBeNull();
      expect(fb.entries.map((e) => e.name).sort()).toEqual(["here.txt", "sub"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The fake ssh runs the device's side here: a Linux or macOS device's sh and python3, which Windows hasn't.
  test.if(process.platform !== "win32")("the file browser lists, goes back on errors, downloads and uploads", async () => {
    const root = tmp("fb");
    try {
      const remote = join(root, "remote");
      mkdirSync(remote);
      writeFileSync(join(remote, "note.txt"), "remote note");
      writeFileSync(join(remote, "pic.png"), "png bytes");
      let fail = false;
      const listing = () =>
        fail
          ? { code: 255, out: "", err: "ssh: connect to host x port 22: Connection refused\n" }
          : { code: 0, out: JSON.stringify({ path: remote, entries: [["note.txt", false, 11, 100], ["pic.png", false, 9, 200], ["sub", true, 0, 0], [".hid", false, 1, 1]] }), err: "" };
      const f = fakeSsh(listing);
      const dl = join(root, "dl");
      const fb = new FileBrowser(newPairedDevice({ key: "pc:desk", name: "desk", kind: "pc" }), ["-o", "X=1", "--", "desk"], null, { home: root, spawn: f.spawn, downloads: () => dl, cacheHome: join(root, "cache") });
      expect(fb.title()).toBe("desk files");
      expect(fb.loading).toBe(true);
      await fb.idle();
      expect(fb.loading).toBe(false);
      expect([fb.path, fb.shown().map((e) => e.name)]).toEqual([remote, ["sub", "note.txt", "pic.png"]]);
      expect(f.ran[0]).toContain("python3 -c");
      expect(fb.parent()).toBe(root);
      // A Windows folder (the test's own temp folder there) joins by Windows' rules.
      expect(fb.join("x")).toBe(/^[A-Za-z]:/.test(remote) ? join(remote, "x") : `${remote}/x`);

      fail = true;
      fb.go("/elsewhere");
      await fb.idle();
      expect([fb.error, fb.path]).toEqual(["Connection refused", remote]);
      fail = false;

      // A click on a file downloads it to Downloads; the transfer ends saved.
      const note = fb.entries.find((e) => e.name === "note.txt");
      if (!note) throw new Error("no note");
      expect(await fb.click(note)).toBeNull();
      await fb.idle();
      expect(readFileSync(join(dl, "note.txt"), "utf8")).toBe("remote note");
      expect(fb.transfers[0]).toMatchObject({ label: "note.txt ← desk", done: true, saved: join(dl, "note.txt"), sent: 11 });
      await fb.downloadToDownloads(`${remote}/note.txt`, 11);
      await fb.idle();
      expect(existsSync(join(dl, "note (2).txt"))).toBe(true);
      // A broken download reports the last word of ssh's error.
      fb.download(`${remote}/missing.txt`, 1, join(dl, "missing.txt"), true);
      await fb.idle();
      expect(fb.transfers.at(-1)?.error).toBe("No such file or directory");
      expect(existsSync(join(dl, "missing.txt.part"))).toBe(false);

      // Images are previewed from a cache, fetched two at a time.
      expect(fb.preview(`${remote}/pic.png`, 9, 200)).toBeNull();
      expect(fb.queued.length).toBe(1);
      fb.pumpPreviews();
      expect(fb.fetching.size).toBe(1);
      await fb.idle();
      const shown = fb.preview(`${remote}/pic.png`, 9, 200);
      expect(shown && readFileSync(shown, "utf8")).toBe("png bytes");
      const pic = fb.entries.find((e) => e.name === "pic.png");
      expect(pic && (await fb.click(pic))).toBe(shown);

      // Upload: a taken name gets (2), then the folder is listed again.
      const local = join(root, "note.txt");
      writeFileSync(local, "from here");
      const before = f.ran.length;
      fb.upload([local, join(root, "nothing.txt")]);
      await fb.idle();
      expect(readFileSync(join(remote, "note (2).txt"), "utf8")).toBe("from here");
      expect(fb.transfers.at(-1)).toMatchObject({ label: "note.txt → desk", done: true, sent: 9 });
      expect(f.ran.length).toBe(before + 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
