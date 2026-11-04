import { describe, expect, test } from "bun:test";
import type { Chat } from "@harbor/store";
import { MemWatch, type MemWatchDeps } from "../src/memwatch.ts";

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const RAM = { total: 16 * GB, used: 4 * GB, swap_total: 0, swap_used: 0 };

function watch(c: Partial<Chat> | undefined, over: Partial<MemWatchDeps> = {}): { w: MemWatch; pills: string[] } {
  const pills: string[] = [];
  const w = new MemWatch({
    ram: () => ({ total: RAM.total, used: RAM.used, swapTotal: 0, swapUsed: 0 }),
    local: () => ({ ram: RAM, running: 0, top: [], chat: { parts: [{ kind: "agent", label: "Lead · Claude", bytes: 0, idle: true }] } }),
    chat: () => c as Chat | undefined,
    looking: () => true,
    pcName: () => "desk",
    homeName: () => "studio",
    peers: null,
    chatMemory: null,
    show: (v) => pills.push(v.chat),
    popId: () => "",
    rows: () => {},
    sidebarPc: () => "",
    ...over,
  });
  return { w, pills };
}

describe("the chat's memory pill", () => {
  test("shows for every chat on screen: 0 MB while nothing of it runs", () => {
    const { w, pills } = watch({ id: 1, home: "", homeId: 0 });
    w.sample();
    expect(pills).toEqual(["0 MB"]);
  });

  test("no chat on screen: no pill", () => {
    const { w, pills } = watch(undefined);
    w.sample();
    expect(pills).toEqual([""]);
  });

  test("a copy: a dash until its home PC says, then its figure", async () => {
    const parts = [{ kind: "agent", label: "Lead · Claude", bytes: 300 * MB }, { kind: "sub", label: "tests", bytes: 100 * MB }];
    const { w, pills } = watch({ id: 7, home: "pc:studio", homeId: 3 }, { chatMemory: async () => ({ ram: RAM, running: 1, top: [], chat: { parts } }) });
    w.sample();
    await Bun.sleep(5);
    expect(pills).toEqual(["—", "400 MB"]);
  });

  test("a copy whose home PC is off or older: the dash stays", async () => {
    const { w, pills } = watch({ id: 7, home: "pc:studio", homeId: 3 }, { chatMemory: async () => null });
    w.sample();
    await Bun.sleep(5);
    expect(pills).toEqual(["—", "—"]);
  });
});

describe("the sidebar's gauge on another PC", () => {
  const far = { name: "laptop", online: true, mem: { ram: { total: 32 * GB, used: 30 * GB, swap_total: 0, swap_used: 0 }, running: 0, top: [] } };

  test("shows the picked PC once it answers, asking at most every 10 s", async () => {
    const tips: string[] = [];
    let asked = 0;
    const { w } = watch(undefined, {
      sidebarPc: () => "laptop",
      peers: async () => {
        asked++;
        return [far];
      },
      show: (v) => tips.push(`${v.pc} ${v.low}`),
    });
    w.sample();
    await Bun.sleep(5);
    w.sample();
    await Bun.sleep(5);
    expect(tips).toEqual(["4.0 GB false", "30 GB true", "30 GB true"]);
    expect(asked).toBe(1);
  });

  test("this PC picked: the peers aren't asked", async () => {
    let asked = 0;
    const { w } = watch(undefined, {
      peers: async () => {
        asked++;
        return [far];
      },
    });
    w.sample();
    await Bun.sleep(5);
    expect(asked).toBe(0);
  });

  test("the popover's rows carry each PC's submenu", async () => {
    const got: { kinds: string[]; subs: number }[] = [];
    const { w } = watch(undefined, {
      popId: () => "mem-devices",
      peers: async () => [far],
      rows: (rows, cards) => got.push({ kinds: rows.map((r) => r.kind), subs: cards.filter((c) => c !== null).length }),
    });
    w.sample();
    await Bun.sleep(5);
    expect(got[0]).toEqual({ kinds: ["label", "mem-pc", "usage-note"], subs: 1 });
    expect(got.at(-1)).toEqual({ kinds: ["label", "mem-pc", "separator", "mem-pc"], subs: 2 });
  });
});
