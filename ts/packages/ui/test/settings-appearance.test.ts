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

test("appearance is Light or Dark, dark by default (no Follow Omarchy), and has no density anymore", () => {
  const v = appearanceView(new Kv());
  expect(v.modes).toEqual(["Light", "Dark"]);
  expect(v.mode).toBe(1);
  expect(v.mode_note.startsWith("Colours and type are the rengaf design system (Geist).")).toBe(true);
  expect(Object.keys(v).some((k) => k.startsWith("densit"))).toBe(false);
});

test("appearance reads what kv holds, and an unknown theme (an older \"system\") is dark", () => {
  const kv = new Kv();
  kv.set("theme", "light");
  expect(appearanceView(kv).mode).toBe(0);
  kv.set("theme", "system");
  expect(appearanceView(kv).mode).toBe(1);
  // A density an older Harbor saved changes nothing.
  kv.set("density", "compact");
  expect(appearanceApplied(kv)).toEqual({ mode: "dark" });
});

test("appearance writes the theme where the Rust app kept it; density is no setting", () => {
  const kv = new Kv();
  expect(setAppearance(kv, "theme", 0)).toBe(true);
  expect(kv.get("theme")).toBe("light");
  expect(setAppearance(kv, "theme", 1)).toBe(true);
  expect(kv.get("theme")).toBe("dark");
  expect(setAppearance(kv, "density", 1)).toBe(false);
  expect(kv.get("density")).toBeNull();
  expect(setAppearance(kv, "follow_up", 1)).toBe(false);
  expect(setAppearance(kv, "theme", true)).toBe(false);
});

test("the sidebar's sun/moon picks the other of what shows", () => {
  expect(toggledMode(true)).toBe("light");
  expect(toggledMode(false)).toBe("dark");
});
