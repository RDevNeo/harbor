import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fit, known, PRIMS_V1, row, type Screen } from "../packages/ui/src/logic/phoneui.ts";
import { phoneSettings, phoneSettingsDo } from "../packages/ui/src/logic/settings-phone.ts";

const kv = (o: Record<string, string> = {}) => ({ get: (k: string) => o[k] ?? null, set: (k: string, v: string) => void (o[k] = v), o });

test("the_app_knows_the_v1_primitives_the_pc_thinks_it_does", () => {
  // Prims.java's KNOWN is what phones send; the PC fits its screens to it.
  const java = readFileSync(join(import.meta.dir, "../../android/src/dev/harbor/app/Prims.java"), "utf8");
  const m = /KNOWN = \{([^}]*)\}/.exec(java);
  const names = [...(m?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  expect(names.filter((n) => !n?.startsWith("native:"))).toEqual([...PRIMS_V1]);
});

test("fit_swaps_rows_a_phone_cant_draw_for_their_alt_and_drops_empty_sections", () => {
  const s: Screen = {
    v: 1,
    sections: [
      { id: "a", title: "A", rows: [row({ id: "t", kind: "toggle", title: "Toggle", alt: row({ id: "t", title: "Toggle as a row" }) }), row({ id: "n", title: "Native", tap: { kind: "native", screen: "nope" } })] },
      { id: "b", title: "B", rows: [row({ id: "x", kind: "slider", title: "Slider" })] },
    ],
  };
  const out = fit(s, known([...PRIMS_V1]));
  expect(out.sections.map((x) => x.id)).toEqual(["a"]);
  expect(out.sections[0]?.rows.map((r) => r.title)).toEqual(["Toggle as a row"]);
  expect("alt" in (out.sections[0]?.rows[0] ?? {})).toBe(false);
  expect(fit(s, known(["section", "row", "toggle", "native:nope"])).sections[0]?.rows.map((r) => r.title)).toEqual(["Toggle", "Native"]);
  // A phone that sends nothing usable gets the v1 set; one without rows gets nothing.
  expect(known("junk")).toEqual(new Set(PRIMS_V1));
  expect(fit(s, new Set(["section"])).sections).toEqual([]);
});

test("the_phone_settings_say_what_the_app_said_before", () => {
  const k = kv();
  const s = phoneSettings(k, { dictionary: [] });
  expect(s.sections.map((x) => x.title)).toEqual(["Voice", "Worktrees"]);
  expect(s.sections[0]?.rows[0]?.sub).toBe("Names and terms to spell exactly, like SpokPay");
  expect(s.sections[1]?.rows[0]).toMatchObject({ title: "Delete merged worktrees", sub: "Once a chat's PR is merged · their branches too", lines: 2, chevron: true });
  const terms = ["SpokPay", "Harbor", "Omarchy", "Hyprland", "Parakeet", "Whisper", "Servo", "Slint", "Bun"];
  expect(phoneSettings(k, { dictionary: terms }).sections[0]?.rows[0]?.sub).toBe("9 words · SpokPay, Harbor, Omarchy, Hyprland, Parakeet, Whisper, Servo");
  expect(phoneSettings(k, { dictionary: ["One"] }).sections[0]?.rows[0]?.sub).toBe("1 word · One");
  expect(phoneSettings(k, { dictionary: null }).sections.map((x) => x.id)).toEqual(["worktrees"]);
  expect(phoneSettingsDo(k, "worktrees", { values: { wt_clean_merged: false } })).toBe("");
  expect(phoneSettings(k, { dictionary: null }).sections[0]?.rows[0]?.sub).toBe("Off: merged worktrees stay");
  expect(phoneSettingsDo(k, "worktrees", { values: { auto_fix: true } })).toBe("");
  expect(k.o.auto_fix).toBeUndefined();
  expect(phoneSettingsDo(k, "nope", {})).toBeNull();
});

test("the phone sets the Projects folder from a list: the default, the current one, the PC's folders", () => {
  const k = kv();
  const s = phoneSettings(k, { dictionary: null, projects: { home: "/h", dirs: [join("/h", "Documents"), join("/h", "Projects")] } });
  expect(s.sections.map((x) => x.id)).toEqual(["projects", "worktrees"]);
  const r = s.sections[0]?.rows[0];
  expect(r).toMatchObject({ title: "Projects folder", sub: "~/Projects" });
  const tap = r?.tap;
  if (tap?.kind !== "pick") throw new Error("not a pick");
  expect(tap.options.map((o) => o.label)).toEqual(["~/Projects", "~/Documents"]);
  expect(tap.selected).toBe(join("/h", "Projects"));
  const dir = join(mkdtempSync(join(tmpdir(), "hts-pdir-")), "work");
  expect(phoneSettingsDo(k, "projects_dir", { value: dir })).toStartWith("Projects folder: ");
  expect(k.o.projects_dir).toBe(dir);
  expect(existsSync(dir)).toBe(true);
  expect(phoneSettingsDo(k, "projects_dir", { value: "relative/x" })).toBeNull();
});
