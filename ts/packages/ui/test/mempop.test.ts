import { describe, expect, test } from "bun:test";
import { bytesText, chatRows, deviceRows, low, parseMem, ramText, usedText } from "../src/logic/mempop.ts";

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const ram = (used: number, total: number, swap = 0) => ({ total: total * GB, used: used * GB, swap_total: 4 * GB, swap_used: swap * GB });

describe("memory popovers", () => {
  test("figures", () => {
    expect([bytesText(412 * MB), bytesText(1.15 * GB), bytesText(16 * GB), bytesText(10)]).toEqual(["412 MB", "1.2 GB", "16 GB", "1 MB"]);
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

  test("the PCs' popover: this PC first, then off, older and answering PCs", () => {
    const here = parseMem({ ram: ram(8, 16), running: 2, top: [{ title: "a", bytes: 300 * MB }, { title: "b", bytes: 100 * MB }] });
    const there = parseMem({ ram: ram(4, 32), running: 0, top: [] });
    const rows = deviceRows({ name: "desk", online: true, mem: here }, [
      { name: "off", online: false, mem: null },
      { name: "old", online: true, mem: null },
      { name: "far", online: true, mem: there },
    ]);
    expect(rows.map((r) => [r.kind, r.label, r.badge || r.desc])).toEqual([
      ["label", "Memory", ""],
      ["usage-account", "desk", "This PC"],
      ["mem-ram", "RAM", "8 of 16 GB  ·  50%"],
      ["mem-row", "a", "300 MB"],
      ["mem-row", "b", "100 MB"],
      ["separator", "", ""],
      ["usage-account", "off", "Off"],
      ["separator", "", ""],
      ["usage-account", "old", ""],
      ["usage-note", "No numbers: its Harbor is older.", ""],
      ["separator", "", ""],
      ["usage-account", "far", "Nothing running"],
      ["mem-ram", "RAM", "4 of 32 GB  ·  13%"],
    ]);
  });
});
