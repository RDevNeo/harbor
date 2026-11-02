import { describe, expect, test } from "bun:test";
import { parseItem, shown, toCard } from "../proto/items.ts";

describe("items", () => {
  test("every kind Rust writes is read", () => {
    const bodies = [
      `{"kind":"user","text":"hi","files":[],"at":5}`,
      `{"kind":"text","text":"yes","at":6}`,
      `{"kind":"thinking","text":"hm"}`,
      `{"kind":"tool","id":"t1","name":"Read","summary":"a.rs","input":"{}","result":null,"is_error":false}`,
      `{"kind":"result","cost_usd":0.1,"duration_ms":1500,"turns":1,"input_tokens":10,"output_tokens":2}`,
      `{"kind":"error","text":"boom"}`,
      `{"kind":"notice","icon":"started","text":"api started"}`,
      `{"kind":"message","from":"a","to":"b","text":"go"}`,
    ];
    expect(bodies.map(parseItem).every((i) => i !== null)).toBe(true);
  });

  test("what Rust would refuse is dropped", () => {
    expect(parseItem("not json")).toBeNull();
    expect(parseItem(`{"kind":"nope"}`)).toBeNull();
    expect(parseItem(`[1]`)).toBeNull();
  });

  test("a tool is one line, red when it failed", () => {
    const ok = toCard({ kind: "tool", id: "1", name: "Bash", summary: "ls\n-la", input: "", result: "", is_error: false });
    expect(ok).toEqual({ kind: "line", text: "Bash ls -la", meta: "" });
    expect(toCard({ kind: "tool", id: "1", name: "Bash", input: "", result: null, is_error: true }).kind).toBe("error");
  });

  test("empty thinking has no row", () => {
    expect(shown({ kind: "thinking", text: "  " })).toBe(false);
    expect(shown({ kind: "thinking", text: "why" })).toBe(true);
  });
});
