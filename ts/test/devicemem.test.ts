import { describe, expect, test } from "bun:test";
import { DeviceMemory, deviceMemSh, sshDevices } from "../devicemem.ts";
import { newHost } from "../packages/net/src/index.ts";

const mac = newHost({ id: "ssh:1", name: "Work MacBook", host: "mac", os: "macOS" });
const studio = newHost({ id: "ts:studio", name: "Studio", host: "studio.tail.ts.net", os: "linux" });
const byHand = newHost({ id: "ssh:2", name: "", host: "laptop.local", os: "linux" });
const hidden = newHost({ id: "ssh:3", host: "old", hidden: true });
const win = newHost({ id: "ssh:4", name: "Gaming", host: "gaming", os: "windows" });
const harbors = { ids: ["ts:me", "ts:studio"], names: ["me", "studio", "laptop"] };
const MACOUT = "hw.memsize: 17179869184\nvm.swapusage: total = 0.00M  used = 0.00M  free = 0.00M\nMach Virtual Memory Statistics: (page size of 16384 bytes)\nPages wired down: 100000.\nAnonymous pages: 400000.\nPages occupied by compressor: 0.\n";

describe("Runs on devices in the PCs popover", () => {
  test("only the shown devices that aren't a Harbor PC of the mesh, by id or by name", () => {
    expect(sshDevices([[mac, true], [studio, true], [byHand, true], [hidden, null], [win, null]], harbors).map(([h]) => h.id)).toEqual(["ssh:1", "ssh:4"]);
  });

  test("asking, then RAM and the chats running there, read again only when old", async () => {
    let now = 0;
    let reads = 0;
    const d = new DeviceMemory({
      devices: () => [[mac, null]],
      harbors: () => harbors,
      read: async () => (reads++, MACOUT),
      turns: (id) => (id === "ssh:1" ? [{ mark: "a.1", title: "one" }, { mark: "a.2", title: "two" }] : []),
      now: () => now,
    });
    expect(d.list()).toEqual([{ name: "Work MacBook", online: true, mem: null, asking: true, note: "", ssh: true }]);
    await Bun.sleep(1);
    const [m] = d.list();
    expect(m?.asking).toBe(false);
    expect(m?.mem).toEqual({ ram: { total: 17179869184, used: 500000 * 16384, swap_total: 0, swap_used: 0 }, running: 2, top: [] });
    expect(reads).toBe(1);
    now = 20_000;
    d.list();
    await Bun.sleep(1);
    expect(reads).toBe(2);
  });

  test("off: not asked; no answer over SSH: said; Windows: said", async () => {
    let reads = 0;
    const d = new DeviceMemory({ devices: () => [[mac, false], [win, true]], harbors: () => harbors, read: async () => (reads++, null), turns: () => [] });
    expect(d.list().map((x) => [x.name, x.online, x.note])).toEqual([
      ["Work MacBook", false, ""],
      ["Gaming", true, "No numbers from Windows yet."],
    ]);
    expect(reads).toBe(0);
    const e = new DeviceMemory({ devices: () => [[mac, true]], harbors: () => harbors, read: async () => null, turns: () => [] });
    e.list();
    await Bun.sleep(1);
    expect(e.list()[0]?.note).toBe("No numbers: it didn't answer over SSH.");
  });

  test("a chat running there: its turn's bytes from the same read, asked sooner for a new turn", async () => {
    let now = 0;
    const cmds: string[] = [];
    let turns = [{ mark: "pc.7", title: "Fix the pill" }];
    const d = new DeviceMemory({
      devices: () => [[mac, true], [win, true]],
      harbors: () => harbors,
      read: async (_h, c) => (cmds.push(c), `${MACOUT}harbor-mem pc.7 409600\n`),
      turns: () => turns,
      now: () => now,
    });
    expect(d.chat("ssh:1", "pc.7", true)).toEqual({ name: mac.name, ram: null, bytes: null, asking: true });
    await Bun.sleep(1);
    expect(cmds).toEqual([deviceMemSh(["pc.7"])]);
    expect(d.chat("ssh:1", "pc.7", true)).toEqual({ name: mac.name, ram: { total: 17179869184, used: 500000 * 16384, swapTotal: 0, swapUsed: 0 }, bytes: 400 * 1024 * 1024, asking: false });
    // The device's card lists it too.
    expect(d.list()[0]?.mem?.top).toEqual([{ title: "Fix the pill", bytes: 400 * 1024 * 1024 }]);
    // A turn the last read didn't ask about: read again after a short while, not at once.
    turns = [...turns, { mark: "pc.8", title: "Other" }];
    expect(d.chat("ssh:1", "pc.8", true)?.bytes).toBeNull();
    expect(cmds).toHaveLength(1);
    now = 4_000;
    d.chat("ssh:1", "pc.8", true);
    await Bun.sleep(1);
    expect(cmds).toHaveLength(2);
    expect(cmds[1]).toContain("m='pc.7 pc.8'");
    // pc.8's processes weren't found (an older turn without the mark): no number, not 0 MB.
    expect(d.chat("ssh:1", "pc.8", true)).toMatchObject({ bytes: null, asking: false });
    // Between turns: RAM only; a Windows device: nothing; an unknown one: null.
    expect(d.chat("ssh:1", "pc.7", false)?.bytes).toBeNull();
    expect(d.chat("ssh:4", "pc.9", true)).toEqual({ name: "Gaming", ram: null, bytes: null, asking: false });
    expect(d.chat("ssh:9", "pc.9", true)).toBeNull();
    expect(deviceMemSh([])).not.toContain("harbor-mem");
  });
});
