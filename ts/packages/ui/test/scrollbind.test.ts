import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A ScrollView's or Flickable's position bound two-way to a global's property (`viewport-y <=> SettingsBus.scroll-y`)
// stays at 0 whatever the wheel, touchpad, scrollbar or keys do (Slint 1.18): no Settings page scrolled from 0.173
// to 0.183. Sync it with `changed` handlers instead (settings.slint).
test("no scroll position is bound two-way to a global", () => {
  const dir = join(import.meta.dir, "..", "slint");
  const bad: string[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".slint"))) {
    const src = readFileSync(join(dir, f), "utf8");
    const globals = [...src.matchAll(/global\s+([\w-]+)/g)].map((m) => m[1]);
    src
      .split("\n")
      .forEach((line, i) => {
        const m = /^\s*(?:viewport|content)-[xy]\s*<=>\s*([\w-]+)\./.exec(line);
        if (m && (/Bus$/.test(m[1] ?? "") || globals.includes(m[1]))) bad.push(`${f}:${i + 1}: ${line.trim()}`);
      });
  }
  expect(bad).toEqual([]);
});
