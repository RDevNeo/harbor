import { describe, expect, test } from "bun:test";
import { chatParts, type MemSource, parseMeminfo, parseStat, type ProcTable, ram, snapshot, topChats, treeBytes } from "../src/memory.ts";

const MB = 1024 * 1024;

/** pid → [ppid, pgrp, MB]. */
function table(rows: Record<number, [number, number, number]>): ProcTable {
  const t: ProcTable = { rss: new Map(), kids: new Map(), groups: new Map() };
  for (const [k, [pp, pg, mb]] of Object.entries(rows)) {
    const pid = Number(k);
    t.rss.set(pid, mb * MB);
    t.kids.set(pp, [...(t.kids.get(pp) ?? []), pid]);
    t.groups.set(pg, [...(t.groups.get(pg) ?? []), pid]);
  }
  return t;
}

const chat = (id: number, over: Partial<MemSource["chats"][number]> = {}) => ({ id, title: `chat ${id}`, name: "", role: "chat", parent: null, home: "", retired: false, ...over });

describe("memory", () => {
  test("meminfo: used is what isn't available, swap from its own lines", () => {
    const r = parseMeminfo("MemTotal:       16000000 kB\nMemFree:  100 kB\nMemAvailable:    6000000 kB\nSwapTotal:  2000000 kB\nSwapFree:   1500000 kB\n");
    expect(r).toEqual({ total: 16000000 * 1024, used: 10000000 * 1024, swapTotal: 2000000 * 1024, swapUsed: 500000 * 1024 });
    expect(parseMeminfo("nothing")).toBeNull();
  });

  test("stat: fields after the last parenthesis, whatever the name holds", () => {
    const line = "4242 (a) b (c) S 17 4242 4242 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 100 1000 2560 18446744073709551615";
    expect(parseStat(line)).toEqual({ ppid: 17, pgrp: 4242, pages: 2560 });
    expect(parseStat("garbage")).toBeNull();
  });

  test("trees count each process once", () => {
    const t = table({ 10: [1, 10, 100], 11: [10, 10, 20], 12: [11, 12, 5], 20: [1, 20, 50] });
    const seen = new Set<number>();
    expect(treeBytes(t, [10], seen)).toBe(125 * MB);
    expect(treeBytes(t, [11, 20], seen)).toBe(50 * MB);
    expect(treeBytes(t, [999], new Set())).toBe(0);
  });

  test("a lead's parts: its agent, its subagents and its processes, the most first", () => {
    const t = table({ 100: [1, 100, 200], 101: [100, 101, 40], 200: [1, 200, 90], 300: [1, 300, 10], 301: [300, 300, 30], 400: [1, 400, 70] });
    const src: MemSource = {
      chats: [chat(1, { role: "lead" }), chat(2, { role: "sub", parent: 1, name: "tests" }), chat(3, { role: "sub", parent: 1, retired: true }), chat(4)],
      runner: (id) => ({ 1: { pid: 100, kind: "Claude" }, 2: { pid: 200, kind: "Claude" }, 3: { pid: 999, kind: "Claude" }, 4: { pid: 400, kind: "Codex" } })[id] ?? null,
      procs: [{ name: "vite", lead: 1, owner: 2, pid: 300 }],
    };
    expect(chatParts(src, 1, t)).toEqual([
      { kind: "agent", label: "Lead · Claude", bytes: 240 * MB },
      { kind: "sub", label: "tests", bytes: 90 * MB },
      { kind: "proc", label: "vite", bytes: 40 * MB },
    ]);
    expect(chatParts(src, 2, t).map((p) => p.label)).toEqual(["Agent · Claude", "vite"]);
    expect(topChats(src, t)).toEqual([
      { id: 1, title: "chat 1", bytes: 370 * MB },
      { id: 4, title: "chat 4", bytes: 70 * MB },
    ]);
  });

  test("this PC's own numbers read", () => {
    if (process.platform !== "linux") return;
    const r = ram();
    expect(r !== null && r.total > 0 && r.used <= r.total).toBe(true);
    const s = snapshot({ chats: [chat(1)], runner: () => ({ pid: process.pid, kind: "Claude" }), procs: [] }, 1);
    expect(s.running).toBe(1);
    expect((s.chat as { parts: unknown[] }).parts).toHaveLength(1);
  });
});
