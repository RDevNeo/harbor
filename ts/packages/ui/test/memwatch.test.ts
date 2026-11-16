import { describe, expect, test } from "bun:test";
import type { Chat } from "@harbor/store";
import { type MemAsk, MemWatch, type MemWatchDeps } from "../src/memwatch.ts";
import type { MemRow } from "../src/logic/mempop.ts";

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const RAM = { total: 16 * GB, used: 4 * GB, swap_total: 0, swap_used: 0 };
const IDLE = [{ kind: "agent", label: "Lead · Claude", bytes: 0, idle: true }];

/** `c`: the chat on screen, or every split pane's; each sample's chips, said as "figure | figure" in their order. */
function watch(c: Partial<Chat> | Partial<Chat>[] | undefined, over: Partial<MemWatchDeps> = {}): { w: MemWatch; pills: string[] } {
  const pills: string[] = [];
  const chats = (c === undefined ? [] : Array.isArray(c) ? c : [c]) as Chat[];
  const w = new MemWatch({
    ram: () => ({ total: RAM.total, used: RAM.used, swapTotal: 0, swapUsed: 0 }),
    local: (asks) => ({ ram: RAM, running: 0, top: [], chats: asks.map((a) => ({ id: a.id, parts: IDLE })) }),
    chats: () => chats,
    project: () => null,
    looking: () => true,
    pcName: () => "desk",
    homeName: () => "studio",
    peers: null,
    chatMemory: null,
    show: (v) => pills.push([...v.chats.values()].map((f) => f.text + (f.project ? " (project)" : "")).join(" | ")),
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

describe("the chips of split panes and projects", () => {
  const parts = (id: number) => (id === 1 ? [{ kind: "agent", label: "Lead · Claude", bytes: 200 * MB }] : [{ kind: "agent", label: "Agent · Codex", bytes: 50 * MB }, { kind: "proc", label: "vite", bytes: 30 * MB }]);
  const local = (asks: readonly MemAsk[]) => ({ ram: RAM, running: 2, top: [], chats: asks.map((a) => ({ id: a.id, parts: parts(a.id) })) });

  test("every pane's chat has its own figure, this PC's from one scan, a copy's from its home PC", async () => {
    const scans: number[][] = [];
    const { w, pills } = watch([{ id: 1, home: "", homeId: 0 }, { id: 2, home: "", homeId: 0 }, { id: 7, home: "pc:studio", homeId: 3 }], {
      local: (asks) => {
        scans.push(asks.map((a) => a.id));
        return local(asks);
      },
      chatMemory: async () => ({ ram: RAM, running: 1, top: [], chat: { parts: [{ kind: "agent", label: "Lead · Claude", bytes: 1.5 * GB }] } }),
    });
    w.sample();
    await Bun.sleep(5);
    expect(pills).toEqual(["200 MB | 80 MB | —", "200 MB | 80 MB | 1.5 GB"]);
    expect(scans).toEqual([[1, 2], [1, 2]]);
  });

  test("a project's main chat is asked with its project's other chats, and says its figure is the project's", () => {
    const asked: MemAsk[][] = [];
    const { w, pills } = watch([{ id: 1, home: "", homeId: 0 }, { id: 2, home: "", homeId: 0 }], {
      project: (c) => (c.id === 1 ? [2, 3] : null),
      local: (asks) => {
        asked.push([...asks]);
        return local(asks);
      },
    });
    w.sample();
    expect(asked).toEqual([[{ id: 1, project: [2, 3] }, { id: 2 }]]);
    expect(pills).toEqual(["200 MB (project) | 80 MB"]);
  });

  test("a copy that is its project's main chat keeps its own figure, from its home PC", async () => {
    const { w, pills } = watch({ id: 7, home: "pc:studio", homeId: 3 }, { project: () => [8], chatMemory: async () => null });
    w.sample();
    await Bun.sleep(5);
    expect(pills).toEqual(["—", "—"]);
  });

  test("the popover is for the chip clicked: another pane's, then the project's rows", () => {
    const got: MemRow[][] = [];
    const { w } = watch([{ id: 1, home: "", homeId: 0 }, { id: 2, home: "", homeId: 0 }], {
      project: (c) => (c.id === 1 ? [2] : null),
      local,
      popId: () => "mem-chat",
      rows: (rows) => got.push(rows),
    });
    w.pick(2);
    w.sample();
    w.pick(1);
    w.sample();
    expect(got.map((rows) => [rows[0]?.label, rows[0]?.badge])).toEqual([
      ["This chat", "80 MB"],
      ["This project", "200 MB"],
    ]);
    // A chip no longer on screen: the first one's.
    w.pick(9);
    w.sample();
    expect(got.at(-1)?.[0]?.label).toBe("This project");
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
