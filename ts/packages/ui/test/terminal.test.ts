import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { ansiPalette, fade, gridSize, idxColor, keyBytes, pasteBytes, pasteText } from "../src/logic/terminal.ts";
import { Terminal } from "../src/terminal.ts";
import { token } from "../src/theme.ts";

const none = { ctrl: false, alt: false, shift: false };

describe("terminal.rs", () => {
  test("pastes_lose_escapes", () => {
    expect(pasteText("ls\x1b[201~\nrm -rf x\n")).toBe("ls[201~\nrm -rf x\n");
    expect(pasteText("a\tb\r\nc\x07\x1b[200~")).toBe("a\tb\r\nc[200~");
    expect(pasteText("héllo ✓")).toBe("héllo ✓");
    expect(pasteBytes("x\x1b", true)).toBe("\x1b[200~x\x1b[201~");
  });

  test("keys send xterm's bytes, arrows follow the cursor-key mode", () => {
    expect(keyBytes("enter", none, false)).toBe("\r");
    expect(keyBytes("up", none, false)).toBe("\x1b[A");
    expect(keyBytes("up", none, true)).toBe("\x1bOA");
    expect(keyBytes("backspace", { ...none, alt: true }, false)).toBe("\x1b\x7f");
    expect(keyBytes("tab", { ...none, shift: true }, false)).toBe("\x1b[Z");
    expect(keyBytes("pagedown", none, false)).toBe("\x1b[6~");
    expect(keyBytes({ text: "c" }, { ...none, ctrl: true }, false)).toBe("\x03");
    expect(keyBytes({ text: "[" }, { ...none, ctrl: true }, false)).toBe("\x1b");
    expect(keyBytes({ text: "1" }, { ...none, ctrl: true }, false)).toBe("");
    expect(keyBytes({ text: "é" }, none, false)).toBe("é");
  });

  test("256 colours: the ANSI 16, the cube and the grey ramp", () => {
    const ansi = ansiPalette(true);
    expect(ansi[1]).toBe(token("red-900", true));
    expect(idxColor(1, ansi)).toBe(ansi[1] ?? "");
    expect(idxColor(16, ansi)).toBe("#000000");
    expect(idxColor(21, ansi)).toBe("#0000ff");
    expect(idxColor(231, ansi)).toBe("#ffffff");
    expect(idxColor(232, ansi)).toBe("#080808");
    expect(fade("#ffffff", 0.6, "#000000")).toBe("#999999");
    expect(gridSize(808, 344, 8, 17)).toEqual([20, 100]);
    expect(gridSize(0, 0, 8, 17)).toEqual([2, 4]);
  });

  test("a shell's output becomes styled runs on the grid", async () => {
    const t = new Terminal("t", tmpdir(), ["sh", "-c", "printf 'a\\033[31mred\\033[0m \\033[7minv\\033[0m\\n'; sleep 5"], {}, () => {});
    t.resize(5, 30);
    for (let i = 0; i < 50 && !t.frame(true).rows[0]?.runs.some((r) => r.text.includes("inv")); i++) await Bun.sleep(40);
    await t.settled();
    const runs = t.frame(true).rows[0]?.runs ?? [];
    expect(runs.map((r) => [r.col, r.text.trimEnd()])).toEqual([
      [0, "a"],
      [1, "red"],
      [5, "inv"],
    ]);
    expect(runs[1]?.fg).toBe(token("red-900", true));
    expect([runs[2]?.has_bg, runs[2]?.bg]).toEqual([true, token("fg", true)]);
    t.kill();
    await t.exited;
    expect(t.alive).toBe(false);
    expect(t.frame(true).cursor_row).toBe(-1);
  });
});
