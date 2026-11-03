import { describe, expect, test } from "bun:test";
import { DeviceMemory, sshDevices } from "../devicemem.ts";
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
      running: (id) => (id === "ssh:1" ? 2 : 0),
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
    const d = new DeviceMemory({ devices: () => [[mac, false], [win, true]], harbors: () => harbors, read: async () => (reads++, null), running: () => 0 });
    expect(d.list().map((x) => [x.name, x.online, x.note])).toEqual([
      ["Work MacBook", false, ""],
      ["Gaming", true, "No numbers from Windows yet."],
    ]);
    expect(reads).toBe(0);
    const e = new DeviceMemory({ devices: () => [[mac, true]], harbors: () => harbors, read: async () => null, running: () => 0 });
    e.list();
    await Bun.sleep(1);
    expect(e.list()[0]?.note).toBe("No numbers: it didn't answer over SSH.");
  });
});
