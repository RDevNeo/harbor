import { expect, test } from "bun:test";
import { KEY, parseZoom, STEPS, stepZoom, Zoom } from "../src/logic/zoom.ts";
import { listed, classOf } from "../../store/src/settingsync.ts";

test("steps_like_chrome", () => {
  expect(STEPS).toContain(1);
  expect(stepZoom(1, 1)).toBe(1.1);
  expect(stepZoom(1.1, 1)).toBe(1.25);
  expect(stepZoom(1, -1)).toBe(0.9);
  expect(stepZoom(0.9, -1)).toBe(0.8);
  expect(stepZoom(1.75, 0)).toBe(1);
  // the ends hold
  expect(stepZoom(3, 1)).toBe(3);
  expect(stepZoom(0.5, -1)).toBe(0.5);
  // between steps it goes to the next one
  expect(stepZoom(1.2, 1)).toBe(1.25);
  expect(stepZoom(1.2, -1)).toBe(1.1);
});

test("parse_stored_level", () => {
  expect(parseZoom(null)).toBe(1);
  expect(parseZoom("")).toBe(1);
  expect(parseZoom("1.25")).toBe(1.25);
  expect(parseZoom("1.3")).toBe(1);
  expect(parseZoom("abc")).toBe(1);
  expect(parseZoom("9")).toBe(1);
});

test("level_stays_on_this_pc", () => {
  expect(listed(KEY)).toBe(true);
  expect(classOf(KEY)).toBe("device");
});

function rig(stored: string | null, display = 1.25) {
  const kv = new Map<string, string>();
  if (stored !== null) kv.set(KEY, stored);
  const w = { scale: display, sets: [] as number[], level: 0, changed: 0 };
  const z = new Zoom(
    {
      scale: () => w.scale,
      setScale: (s) => {
        w.scale = s;
        w.sets.push(s);
      },
      level: (l) => (w.level = l),
      changed: () => w.changed++,
    },
    { get: (k) => kv.get(k), set: (k, v) => kv.set(k, v) },
  );
  return { z, w, kv };
}

test("applies_saved_level_on_show_over_the_display_scale", () => {
  const { z, w } = rig("1.5");
  expect(w.level).toBe(1.5);
  expect(w.sets).toEqual([]);
  z.shown();
  expect(w.sets).toEqual([1.875]);
  // Slint tells of the scale Harbor set: nothing more to do
  z.scaleChanged(1.875);
  expect(w.sets).toEqual([1.875]);
});

test("at_100_percent_nothing_changes", () => {
  const { z, w } = rig(null);
  z.shown();
  z.scaleChanged(1.25);
  expect(w.sets).toEqual([]);
});

test("keys_zoom_and_save", () => {
  const { z, w, kv } = rig(null, 1);
  z.shown();
  z.key(1);
  expect(w.sets).toEqual([1.1]);
  expect(kv.get(KEY)).toBe("1.1");
  expect(w.changed).toBe(1);
  z.key(1);
  z.key(-1);
  z.key(0);
  expect(w.sets).toEqual([1.1, 1.25, 1.1, 1]);
  expect(kv.get(KEY)).toBe("1");
  // already at 100%: nothing changes
  z.key(0);
  expect(w.sets.length).toBe(4);
  expect(w.changed).toBe(4);
});

test("display_scale_change_keeps_the_level", () => {
  const { z, w } = rig("2", 1);
  z.shown();
  expect(w.sets).toEqual([2]);
  // the window moved to a screen at 1.5: winit set the display's own scale
  w.scale = 1.5;
  z.scaleChanged(1.5);
  expect(w.sets).toEqual([2, 3]);
});

test("a_scale_before_show_waits", () => {
  const { z, w } = rig("1.25", 1);
  z.scaleChanged(2);
  expect(w.sets).toEqual([]);
  w.scale = 2;
  z.shown();
  expect(w.sets).toEqual([2.5]);
});
