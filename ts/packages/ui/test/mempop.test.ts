import { describe, expect, test } from "bun:test";
import { bytesText, chatRows, deviceRows, gauge, low, type MemRow, type PcCard, parseMem, ramText, usedText } from "../src/logic/mempop.ts";

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const ram = (used: number, total: number, swap = 0) => ({ total: total * GB, used: used * GB, swap_total: 4 * GB, swap_used: swap * GB });

describe("memory popovers", () => {
  test("figures", () => {
    expect([bytesText(412 * MB), bytesText(1.15 * GB), bytesText(16 * GB), bytesText(10), bytesText(0)]).toEqual(["412 MB", "1.2 GB", "16 GB", "1 MB", "0 MB"]);
    const r = { total: 16 * GB, used: 9.8 * GB, swapTotal: 0, swapUsed: 0 };
    expect([usedText(r), ramText(r)]).toEqual(["9.8 GB", "9.8 of 16 GB  ·  61%"]);
    expect(usedText({ ...r, used: 5 * GB })).toBe("5.0 GB");
  });

  test("low on memory: 90% used, or 80% with swap in use", () => {
    const r = (used: number, swap: number) => ({ total: 16 * GB, used: used * GB, swapTotal: 4 * GB, swapUsed: swap * GB });
    expect([low(r(14.5, 0)), low(r(13, 0)), low(r(13, 1)), low(r(9, 2))]).toEqual([true, false, true, false]);
  });

  test("an older Harbor's answer isn't numbers", () => {
    expect(parseMem({ error: "not found" })).toBeNull();
    expect(parseMem(null)).toBeNull();
    expect(parseMem({ ram: null, running: 0, top: [] })).toEqual({ ram: null, running: 0, top: [], parts: null });
  });

  test("the chat's popover: total, parts by share, the PC's RAM", () => {
    const m = parseMem({ ram: ram(14.6, 16, 1.2), running: 1, top: [], chat: { parts: [{ kind: "agent", label: "Lead · Claude", bytes: 300 * MB }, { kind: "proc", label: "vite", bytes: 100 * MB }] } });
    if (!m) throw new Error("no numbers");
    const rows = chatRows(m, "studio");
    expect(rows.map((r) => [r.kind, r.label, r.badge, r.desc])).toEqual([
      ["usage-account", "This chat", "400 MB", "on studio"],
      ["mem-row", "Lead · Claude", "", "300 MB"],
      ["mem-row", "vite", "process", "100 MB"],
      ["separator", "", "", ""],
      ["mem-ram", "studio", "", "14.6 of 16 GB  ·  91%"],
      ["mem-warn", "Low on memory: 1.2 GB in swap.", "", ""],
    ]);
    expect(rows[1]?.value).toBe(0.75);
    expect(chatRows({ ram: null, running: 0, top: [], parts: [] }, "").map((r) => r.label)).toEqual(["This chat", "Nothing of this chat is running now."]);
  });

  test("a lead between turns: listed idle, the chat at 0 MB", () => {
    const m = parseMem({ ram: ram(4, 16), running: 0, top: [], chat: { parts: [{ kind: "agent", label: "Lead · Claude", bytes: 0, idle: true }] } });
    if (!m) throw new Error("no numbers");
    expect(m.parts).toEqual([{ kind: "agent", label: "Lead · Claude", bytes: 0, idle: true }]);
    expect(chatRows(m, "").map((r) => [r.kind, r.label, r.badge || r.desc])).toEqual([
      ["usage-account", "This chat", "0 MB"],
      ["mem-row", "Lead · Claude", "Idle"],
      ["separator", "", ""],
      ["mem-ram", "This PC", "4 of 16 GB  ·  25%"],
    ]);
  });

  const card = (r: MemRow) => [r.kind, r.label, r.badge, r.desc, r.icon, r.checked, r.enabled];
  const subOf = (c: PcCard | null | undefined) => (c ?? { sub: [] }).sub.map((r) => [r.kind, r.label, r.desc || (r.checked ? "checked" : "")]);

  test("a Runs on device over SSH: one card, its RAM, or why there are none", () => {
    const mac = parseMem({ ram: ram(9, 16), running: 2, top: [] });
    const { rows, cards } = deviceRows({ name: "desk", online: true, mem: null }, [
      { name: "mac", online: true, mem: mac, ssh: true },
      { name: "pi", online: true, mem: null, ssh: true, note: "No numbers: it didn't answer over SSH." },
      { name: "new", online: true, mem: null, ssh: true, asking: true },
    ]);
    expect(rows.slice(2).map(card)).toEqual([
      ["separator", "", "", "", "", false, false],
      ["mem-pc", "mac", "SSH", "2 chats", "9 of 16 GB  ·  56%", false, false],
      ["separator", "", "", "", "", false, false],
      ["mem-pc", "pi", "SSH", "", "No numbers: it didn't answer over SSH.", false, false],
      ["separator", "", "", "", "", false, false],
      ["mem-pc", "new", "SSH", "", "Asking…", false, false],
    ]);
    expect(rows.slice(2).map((r) => r.value)).toEqual([0, 0.5625, 0, -1, 0, -1]);
    expect(subOf(cards[5])).toEqual([["usage-note", "No numbers: it didn't answer over SSH.", ""]]);
    expect(cards[5]?.pc).toBe("pi");
  });

  test("the PCs' popover: one card per PC, chats only in its submenu", () => {
    const here = parseMem({ ram: ram(8, 16), running: 2, top: [{ title: "a", bytes: 300 * MB }, { title: "b", bytes: 100 * MB }] });
    const there = parseMem({ ram: ram(4, 32), running: 0, top: [] });
    const { rows, cards } = deviceRows({ name: "desk", online: true, mem: here }, [
      { name: "off", online: false, mem: null },
      { name: "old", online: true, mem: null },
      { name: "far", online: true, mem: there },
    ]);
    expect(rows.map(card)).toEqual([
      ["label", "Memory", "", "", "", false, false],
      ["mem-pc", "desk", "This PC", "2 chats", "8 of 16 GB  ·  50%", false, true],
      ["separator", "", "", "", "", false, false],
      ["mem-pc", "off", "", "Off", "Off: no numbers now.", false, false],
      ["separator", "", "", "", "", false, false],
      ["mem-pc", "old", "", "", "No numbers: its Harbor is older.", false, false],
      ["separator", "", "", "", "", false, false],
      ["mem-pc", "far", "", "No chats", "4 of 32 GB  ·  13%", false, false],
    ]);
    expect(cards.map((c) => c?.pc ?? null)).toEqual([null, "", null, "off", null, "old", null, "far"]);
    expect(subOf(cards[1])).toEqual([
      ["mem-row", "a", "300 MB"],
      ["mem-row", "b", "100 MB"],
    ]);
    expect(cards[1]?.sub[0]?.value).toBe(0.75);
    expect(subOf(cards[3])[0]).toEqual(["usage-note", "Off: no numbers now.", ""]);
    expect(subOf(cards[7])[0]).toEqual(["usage-note", "Nothing running", ""]);
  });

  test("a low PC: the same card, red label, the swap line atop its submenu; the sidebar's pick is the default", () => {
    const top = [1, 2, 3, 4, 5, 6].map((n) => ({ title: `c${n}`, bytes: n * 100 * MB }));
    const short = parseMem({ ram: ram(14.6, 16, 5.6), running: 6, top });
    const { rows, cards } = deviceRows({ name: "desk", online: true, mem: null }, [{ name: "laptop", online: true, mem: short }], "laptop");
    expect(card(rows[3] as MemRow)).toEqual(["mem-pc", "laptop", "", "6 chats", "14.6 of 16 GB  ·  91%", true, true]);
    expect((rows[1] as MemRow).enabled).toBe(false);
    expect(rows.some((r) => r.kind === "mem-warn" || r.kind === "mem-row")).toBe(false);
    const sub = subOf(cards[3]);
    expect(sub[0]).toEqual(["mem-warn", "Low on memory: 5.6 GB in swap.", ""]);
    expect(sub.slice(1).map((r) => r[0])).toEqual(["mem-row", "mem-row", "mem-row", "mem-row", "mem-row"]);
    expect(cards.flatMap((c) => c?.sub ?? []).some((r) => r.kind === "item" || r.kind === "separator")).toBe(false);
  });

  test("the sidebar's gauge: the picked PC, else this PC's numbers with why", () => {
    const mine = { total: 16 * GB, used: 8 * GB, swapTotal: 0, swapUsed: 0 };
    const far = parseMem({ ram: ram(14.6, 16, 1.2), running: 0, top: [] });
    const peers = [
      { name: "laptop", online: true, mem: far },
      { name: "box", online: false, mem: null },
      { name: "old", online: true, mem: null },
    ];
    expect(gauge("desk", mine, "", peers)).toEqual({ pc: "8.0 GB", frac: 0.5, low: false, tip: "Memory on desk: 8 of 16 GB  ·  50%" });
    expect(gauge("desk", mine, "laptop", peers)).toEqual({ pc: "15 GB", frac: 14.6 / 16, low: true, tip: "Memory on laptop: 14.6 of 16 GB  ·  91%. Low on memory" });
    expect(gauge("desk", mine, "box", peers).tip).toBe("Memory on desk: 8 of 16 GB  ·  50%. box is off");
    expect(gauge("desk", mine, "old", peers).tip).toBe("Memory on desk: 8 of 16 GB  ·  50%. No numbers from old");
    expect(gauge("desk", mine, "gone", peers).tip).toBe("Memory on desk: 8 of 16 GB  ·  50%. gone isn't in your PCs now");
    // Not asked yet, or no mesh: this PC's, quietly.
    expect(gauge("desk", mine, "laptop", null).tip).toBe("Memory on desk: 8 of 16 GB  ·  50%");
    expect(gauge("", null, "laptop", null)).toEqual({ pc: "", frac: 0, low: false, tip: "" });
  });
});
