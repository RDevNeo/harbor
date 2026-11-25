import { describe, expect, it } from "bun:test";
import { aiParts, aiPartsJson } from "../src/aiparts.ts";

describe("aiParts", () => {
  it("splits drafts fenced as ```reply from the markdown around them", () => {
    expect(aiParts("Try this:\n```reply\nOi Luma!\nTudo bem?\n```\nor wait.")).toEqual([
      { type: "text", text: "Try this:" },
      { type: "draft", text: "Oi Luma!\nTudo bem?" },
      { type: "text", text: "or wait." },
    ]);
  });
  it("keeps a streaming (unclosed) draft up to the end", () => {
    expect(aiParts("```reply\nstreaming")).toEqual([{ type: "draft", text: "streaming" }]);
  });
  it("leaves other fences as markdown", () => {
    expect(aiParts("```js\ncode\n```")).toEqual([{ type: "text", text: "```js\ncode\n```" }]);
  });
  it("finds several drafts and plain answers", () => {
    expect(aiParts("No draft here.")).toEqual([{ type: "text", text: "No draft here." }]);
    expect(aiParts("```reply\nA\n```\n```reply pt\nB\n```").map((p) => p.text)).toEqual(["A", "B"]);
    expect(aiParts("")).toEqual([]);
  });
  it("gives the phone the text parts as blocks: bold, lists and inline code, no literal markers", () => {
    const parts = aiPartsJson("The payment is fixed.\n\n- **#28853 is paid.** Approved.\n- Deliver to `Rafarib113`.\n\n```reply\nOpa Yagas\n```");
    expect(parts.map((p) => p.type)).toEqual(["text", "draft"]);
    const text = parts[0];
    if (text?.type !== "text") throw new Error("no text part");
    expect(text.blocks[0]).toEqual({ type: "paragraph", spans: [{ text: "The payment is fixed." }] });
    const list = text.blocks[1];
    if (list?.type !== "list") throw new Error("no list");
    expect(list.items.length).toBe(2);
    const first = list.items[0]?.[0];
    expect(first?.type === "paragraph" && first.spans[0]).toEqual({ text: "#28853 is paid.", bold: true });
    expect(JSON.stringify(text.blocks)).not.toContain("**");
    expect(JSON.stringify(text.blocks)).toContain('"code":true');
    expect(parts[1]).toEqual({ type: "draft", text: "Opa Yagas" });
  });
});
