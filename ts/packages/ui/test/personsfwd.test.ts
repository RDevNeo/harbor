import { describe, expect, test } from "bun:test";
import { fwdSubtitle, pickable, pickerRows, projectMatches, quoteMeta, stepPick, type FwdProject } from "../src/tabs/persons/fwdproject.ts";

const P = (id: string, name: string, path: string, last = 0, working = false, settled = false): FwdProject => ({ id, name, path, short: path.split("/").slice(-3).join("/"), last, working, settled });
const list = [
  P("1", "Persons [TAB]", "/h/harbor-projects/creators-hub/tabs/Persons", 500),
  P("2", "Projects [TAB]", "/h/harbor-projects/creators-hub/tabs/Projects", 400),
  P("3", "Collector [TAB]", "/h/harbor-projects/creators-hub/tabs/Collector", 300),
  P("4", "spokpay", "/h/harbor-projects/spokpay", 200, true),
  P("5", "hub-persons", "/h/harbor-projects/hub-persons"),
  P("6", "archive", "/h/harbor-projects/archive", 0, false, true),
  P("7", "Spok-CRM", "/h/harbor-projects/spok-crm"),
];
const view = (rows: ReturnType<typeof pickerRows>): string[] => rows.map((r) => (r.kind === "head" ? `# ${r.name}` : r.kind === "empty" ? `(${r.name})` : `${r.name}${r.on ? " ✓" : ""}${r.dot ? " •" : ""}`));

describe("Forward to Projects' picker", () => {
  test("Recent: the three with the newest chats (the picked one ticked); All projects: the rest by name, settled last", () => {
    expect(view(pickerRows(list, "", "1"))).toEqual(["# Recent", "Persons [TAB] ✓", "Projects [TAB]", "Collector [TAB]", "# All projects", "hub-persons", "Spok-CRM", "spokpay •", "archive"]);
  });
  test("the search matches names and paths, every word, any case; groups stay", () => {
    expect(view(pickerRows(list, "SPOK", "1"))).toEqual(["# Recent", "spokpay •", "# All projects", "Spok-CRM"]);
    expect(view(pickerRows(list, "tabs coll", "1"))).toEqual(["# Recent", "Collector [TAB]"]);
    expect(projectMatches(list[4]!, "harbor-projects/hub")).toBe(true);
  });
  test("no recent chats: one Projects group; nothing matching: a note", () => {
    expect(view(pickerRows([P("5", "b", "/b"), P("6", "a", "/a")], "", null))).toEqual(["# Projects", "a", "b"]);
    expect(view(pickerRows(list, "zzz", "1"))).toEqual(["(No project matches.)"]);
    expect(view(pickerRows([], "", null))).toEqual(["(No projects in Hub yet.)"]);
  });
  test("Up / Down walk the projects only, wrapping; none highlighted starts at an end", () => {
    const rows = pickerRows(list, "spok", "1");
    expect(pickable(rows).map((r) => r.id)).toEqual(["4", "7"]);
    expect(stepPick(rows, "", 1)).toBe("4");
    expect(stepPick(rows, "", -1)).toBe("7");
    expect(stepPick(rows, "4", 1)).toBe("7");
    expect(stepPick(rows, "7", 1)).toBe("4");
    expect(stepPick(rows, "4", -1)).toBe("7");
    expect(stepPick(pickerRows(list, "zzz", "1"), "", 1)).toBe("");
  });
  test("the quote's line and the subtitle", () => {
    expect(quoteMeta({ author: "zeus.exxe", time: "21:41", section: "SpokPay" })).toEqual({ author: "zeus.exxe", rest: " · 21:41 · SpokPay" });
    expect(quoteMeta({ author: "You", time: "", section: "Creators" }).rest).toBe(" · Creators");
    expect(fwdSubtitle("Persons [TAB]")).toBe("Starts a new chat in Persons [TAB] with this message and your prompt.");
  });
});
