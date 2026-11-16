import { describe, expect, test } from "bun:test";
import { paneTitle } from "../src/logic/splitpanes.ts";

describe("paneTitle", () => {
  const chat = { id: 7, role: "lead", name: "", title: "hl" };
  test("a project's main chat goes by the project's name", () => {
    expect(paneTitle(chat, "harbor", 7)).toBe("harbor");
  });
  test("other chats keep their own title", () => {
    expect(paneTitle(chat, "harbor", 9)).toBe("hl");
    expect(paneTitle(chat, "harbor", null)).toBe("hl");
    expect(paneTitle(chat, null, 7)).toBe("hl");
  });
  test("a subagent goes by its name; no chat, no title", () => {
    expect(paneTitle({ id: 7, role: "sub", name: "panetitle", title: "x" }, "harbor", 7)).toBe("panetitle");
    expect(paneTitle(undefined, "harbor", 7)).toBe("");
  });
});
