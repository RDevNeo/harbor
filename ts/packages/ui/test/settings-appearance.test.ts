import { expect, test } from "bun:test";
import { appearanceApplied, appearanceView, setAppearance } from "../src/logic/settings-appearance.ts";

class Kv {
  readonly map = new Map<string, string>();
  get(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  set(key: string, value: string): void {
    this.map.set(key, value);
  }
}

test("appearance reads follow Omarchy and comfortable by default", () => {
  const v = appearanceView(new Kv());
  expect(v.modes).toEqual(["Follow Omarchy", "Light", "Dark"]);
  expect([v.mode, v.density]).toEqual([0, 0]);
  expect(v.densities).toEqual(["Comfortable", "Compact"]);
  expect(v.mode_note).toBe("Colours and type are the rengaf design system (Geist).");
  expect(v.density_note.endsWith("On this PC only.")).toBe(true);
});

test("appearance reads what kv holds, and an unknown theme is Follow Omarchy", () => {
  const kv = new Kv();
  kv.set("theme", "dark");
  kv.set("density", "compact");
  expect([appearanceView(kv).mode, appearanceView(kv).density]).toEqual([2, 1]);
  kv.set("theme", "sepia");
  expect(appearanceView(kv).mode).toBe(0);
  expect(appearanceApplied(kv)).toEqual({ mode: "system", compact: true });
});

test("appearance writes the theme and density where the Rust app keeps them", () => {
  const kv = new Kv();
  expect(setAppearance(kv, "theme", 1)).toBe(true);
  expect(kv.get("theme")).toBe("light");
  expect(setAppearance(kv, "theme", 0)).toBe(true);
  expect(kv.get("theme")).toBe("system");
  expect(setAppearance(kv, "density", 1)).toBe(true);
  expect(kv.get("density")).toBe("compact");
  expect(setAppearance(kv, "density", 0)).toBe(true);
  expect(kv.get("density")).toBe("comfortable");
  expect(setAppearance(kv, "follow_up", 1)).toBe(false);
  expect(setAppearance(kv, "theme", true)).toBe(false);
});
