import { describe, expect, test } from "bun:test";
import type { patches } from "@harbor/agents";
import { ICONS } from "../src/icons.ts";
import { glyphOf, patchChips } from "../src/logic/patchchips.ts";
import { listRows } from "../src/patchbar.ts";
import { runScript } from "../src/shell.ts";

const file = (over: Partial<patches.PatchFile>): patches.PatchFile => ({ path: "/p/.harbor/patches/dev.ts", name: "dev", root: "/p", hash: "h", state: "trusted", error: "", actions: [], panels: [], ...over });
const action = (title: string, kind: patches.ActionKind = "run"): patches.PatchAction => ({ id: title, title, kind, value: "x", icon: "", patch: "/p.ts" });

describe("patch chips", () => {
  test("actions, panels, then patches to trust and problems", () => {
    const { chips, acts } = patchChips([
      file({ actions: [action("Tests"), action("Docs", "url")], panels: [{ id: "p", title: "App", icon: "", url: "http://localhost:3000", patch: "/p.ts" }] }),
      file({ path: "/q.ts", name: "q", state: "untrusted" }),
      file({ path: "/r.ts", name: "r", state: "error", error: "boom" }),
    ]);
    expect(chips.map((c) => c.text)).toEqual(["Tests", "Docs", "App", "Patch to trust", "r patch: problem"]);
    expect(chips.map((c) => c.icon)).toEqual([ICONS.TERMINAL, ICONS.EXTERNAL, ICONS.GLOBE, ICONS.LOCK, ICONS.ALERT]);
    expect(acts.map((a) => a.kind)).toEqual(["action", "action", "panel", "trust", "problems"]);
  });

  test("past six, the rest go under +N", () => {
    const { chips, acts } = patchChips([file({ actions: ["a", "b", "c", "d", "e", "f", "g", "h"].map((t) => action(t)) })]);
    expect(chips.map((c) => c.text)).toEqual(["a", "b", "c", "d", "e", "+3"]);
    const more = acts.at(-1);
    expect(more?.kind === "more" && more.chips.map((c) => c.text)).toEqual(["f", "g", "h"]);
  });

  test("icons by name, else the kind's", () => {
    expect(glyphOf("git-merge", "TERMINAL")).toBe(ICONS.GIT_MERGE);
    expect(glyphOf("flask", "TERMINAL")).toBe(ICONS.TERMINAL);
  });

  test("list rows get a heading per section", () => {
    expect(listRows([{ title: "a", section: "S" }, { title: "b", section: "S", url: "https://e" }, { title: "c" }]).map((r) => [r.head, r.title, r.link])).toEqual([
      [true, "S", false],
      [false, "a", false],
      [false, "b", true],
      [false, "c", false],
    ]);
  });

  test("a run button's script runs the command, then keeps a shell", async () => {
    const s = runScript("It's", "echo hi");
    const p = Bun.spawn(["bash", "-c", s.replace(/\nexec .*$/, "")], { stdout: "pipe" });
    const out = await new Response(p.stdout).text();
    expect(out).toContain("hi");
    expect(out).toContain("[It's exited 0]");
  });
});
