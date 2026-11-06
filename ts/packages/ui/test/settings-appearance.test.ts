import { expect, test } from "bun:test";
import { appearanceApplied, appearanceView, setAppearance, toggledMode } from "../src/logic/settings-appearance.ts";

class Kv {
  readonly map = new Map<string, string>();
  get(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  set(key: string, value: string): void {
    this.map.set(key, value);
  }
}

test("appearance reads follow Omarchy by default, and has no density anymore", () => {
  const v = appearanceView(new Kv());
  expect(v.modes).toEqual(["Follow Omarchy", "Light", "Dark"]);
  expect(v.mode).toBe(0);
  expect(v.mode_note.startsWith("Colours and type are the rengaf design system (Geist).")).toBe(true);
  expect(Object.keys(v).some((k) => k.startsWith("densit"))).toBe(false);
});

test("appearance reads what kv holds, and an unknown theme is Follow Omarchy", () => {
  const kv = new Kv();
  kv.set("theme", "dark");
  expect(appearanceView(kv).mode).toBe(2);
  kv.set("theme", "sepia");
  expect(appearanceView(kv).mode).toBe(0);
  // A density an older Harbor saved changes nothing.
  kv.set("density", "compact");
  expect(appearanceApplied(kv)).toEqual({ mode: "system" });
});

test("appearance writes the theme where the Rust app kept it; density is no setting", () => {
  const kv = new Kv();
  expect(setAppearance(kv, "theme", 1)).toBe(true);
  expect(kv.get("theme")).toBe("light");
  expect(setAppearance(kv, "theme", 0)).toBe(true);
  expect(kv.get("theme")).toBe("system");
  expect(setAppearance(kv, "density", 1)).toBe(false);
  expect(kv.get("density")).toBeNull();
  expect(setAppearance(kv, "follow_up", 1)).toBe(false);
  expect(setAppearance(kv, "theme", true)).toBe(false);
});

test("the sidebar's sun/moon picks the other of what shows", () => {
  expect(toggledMode(true)).toBe("light");
  expect(toggledMode(false)).toBe("dark");
});
