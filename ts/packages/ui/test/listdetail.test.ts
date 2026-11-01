import { describe, expect, test } from "bun:test";
import { escLeaves, Memo, MenuKeys, Split } from "../src/logic/listdetail.ts";

describe("listdetail.rs", () => {
  test("esc_leaves_a_page_unless_a_field_or_popover_takes_it", () => {
    expect([escLeaves(true, false), escLeaves(true, true), escLeaves(false, false)]).toEqual([true, false, false]);
    expect(escLeaves(true, false, true)).toBe(false);
  });

  test("tabs_open_switch_and_close", () => {
    const s = new Split();
    expect(s.showing()).toBe(false);
    s.select("a");
    s.select("b");
    s.select("c");
    expect(s.current()).toBe("c");
    s.select("a");
    expect([s.tabs.length, s.current()]).toEqual([3, "a"]);
    s.close(0);
    expect(s.current()).toBe("b");
    s.apply({ kind: "activate", i: 1 });
    s.close(1);
    expect(s.current()).toBe("b");
    s.toggle();
    expect(!s.showing() && s.tabs.length === 1).toBe(true);
    s.toggle();
    expect(s.current()).toBe("b");
    s.apply({ kind: "maximize" });
    s.close(0);
    expect(!s.open && !s.max && s.tabs.length === 0).toBe(true);
    s.toggle();
    expect(s.open).toBe(false);
  });

  test("close_others_and_right", () => {
    const s = new Split();
    for (const k of ["a", "b", "c", "d"]) s.select(k);
    s.apply({ kind: "close_right", i: 1 });
    expect(s.tabs).toEqual(["a", "b"]);
    expect(s.active).toBe(1);
    s.apply({ kind: "close_others", i: 0 });
    expect([s.tabs, s.active]).toEqual([["a"], 0]);
  });

  test("memo_recomputes_only_when_its_key_changes", () => {
    const m = new Memo<number>();
    const a = [1];
    const b = [1];
    let runs = 0;
    const get = (k: unknown[]) => m.get(k, () => ++runs);
    expect(get([a, "x"])).toBe(1);
    expect(get([a, "x"])).toBe(1);
    expect(get([b, "x"])).toBe(2);
    expect(get([b, "y"])).toBe(3);
  });

  test("menu keys move, wrap, pick and leave", () => {
    const k = new MenuKeys();
    expect(k.input("enter", 3)).toBeNull();
    k.input("up", 3);
    expect(k.hl).toBe(2);
    k.input("down", 3);
    expect(k.hl).toBe(0);
    expect(k.input("space", 3)).toEqual({ kind: "pick", i: 0 });
    expect(k.input("right", 3)).toEqual({ kind: "enter", i: 0 });
    expect(k.input("left", 3)).toEqual({ kind: "leave" });
    expect(k.input("esc", 0)).toEqual({ kind: "close" });
  });

  test("the panel covers the list when the page is too narrow to share", () => {
    const s = new Split();
    expect(s.areas(1000)).toEqual([1000, null]);
    s.select("a");
    expect(s.areas(1000)).toEqual([500, 500]);
    expect(s.areas(600)).toEqual([null, 600]);
    s.drag(100, 1000);
    expect(s.frac).toBe(0.8);
    expect(s.areas(1000)).toEqual([340, 660]);
  });
});
