import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComponentCompiler } from "slint-ui/rust-module.cjs";
import { FILES, uiDir } from "../src/assets.ts";
import { iconsSlint } from "../src/icons.ts";
import { DARK, LIGHT, omarchyIsDark, parseMode, pinnedMode, presetMetrics, step, themeSlint, toggledMode, token } from "../src/theme.ts";

const slintDir = join(import.meta.dir, "../slint");

test("theme.slint and icons.slint are what theme.ts and icons.ts generate", () => {
  expect(readFileSync(join(slintDir, "theme.slint"), "utf8")).toBe(themeSlint());
  expect(readFileSync(join(slintDir, "icons.slint"), "utf8")).toBe(iconsSlint());
});

test("tokens: steps clamp, names resolve in both modes", () => {
  expect(step(DARK.gray, 50)).toBe(DARK.gray[0]);
  expect(step(DARK.gray, 1200)).toBe(DARK.gray[9]);
  expect(token("fg", true)).toBe("#ededed");
  expect(token("subtle", false)).toBe(LIGHT.gray[8]);
  expect(token("blue-900", true)).toBe("#52a8ff");
  expect(token("bg200", false)).toBe("#f5f5f5");
  expect(presetMetrics("heading-32")).toEqual([40, -1.28]);
  expect(presetMetrics("nothing")).toEqual([null, 0]);
});

test("the Omarchy theme file decides dark or light", () => {
  expect(omarchyIsDark(null)).toBe(true);
  expect(omarchyIsDark('accent = "#fff"\nmode = "light"\n')).toBe(false);
  expect(omarchyIsDark("mode = dark")).toBe(true);
});

test("light or dark only: a PC that followed Omarchy keeps what it showed, once", () => {
  expect(parseMode("light")).toBe("light");
  expect(parseMode("system")).toBe("dark");
  expect(parseMode("")).toBe("dark");
  // The sidebar's button picks the other of what shows.
  expect(toggledMode(true)).toBe("light");
  expect(toggledMode(false)).toBe("dark");
  const home = mkdtempSync(join(tmpdir(), "theme-pin-"));
  try {
    // A choice is kept as it is; nothing stored and no Omarchy: nothing to write.
    expect(pinnedMode("light", home)).toBeNull();
    expect(pinnedMode("dark", home)).toBeNull();
    expect(pinnedMode(null, home)).toBeNull();
    expect(pinnedMode("system", home)).toBe("dark");
    const dir = join(home, ".local/state/omarchy/current/theme");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "colors.toml"), 'mode = "light"\n');
    expect(pinnedMode("system", home)).toBe("light");
    expect(pinnedMode(null, home)).toBe("light");
    expect(pinnedMode("dark", home)).toBeNull();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("every .slint file compiles without errors or binding loops", async () => {
  const dir = await uiDir({ XDG_RUNTIME_DIR: undefined });
  for (const name of Object.keys(FILES)) expect(existsSync(join(dir, name))).toBe(true);
  for (const f of Object.keys(FILES).filter((n) => n === "app.slint" || n === "gallery.slint")) {
    const c = new ComponentCompiler();
    c.style = "fluent";
    c.buildFromPath(join(dir, f));
    const bad = c.diagnostics.map((d) => d.message).filter((m) => !m.includes("deprecated"));
    expect(bad).toEqual([]);
  }
});

