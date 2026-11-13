import { describe, expect, test } from "bun:test";
import { failoverDraftLine, failoverLine, type FailoverPc, parseHeld, pickFailover, switchedNotice } from "../src/failover.ts";

const pc = (id: string, name: string, o: Partial<FailoverPc> = {}): FailoverPc => ({ id, name, ram: 4000, hasProject: true, canClone: true, claude: true, ...o });

describe("failover (failover.ts)", () => {
  test("a PC with the project beats one that would clone it, then the most free memory, then the name", () => {
    const p = pickFailover([pc("", "here", { hasProject: false, ram: 9000 }), pc("t", "tower", { ram: 2000 }), pc("d", "desk", { ram: 3000 })]);
    expect(p.to?.id).toBe("d");
    expect(pickFailover([pc("", "here", { ram: 2000 }), pc("t", "tower", { ram: 2000 })]).to?.id).toBe("");
    expect(pickFailover([pc("", "here", { ram: null }), pc("t", "tower", { ram: 10 })]).to?.id).toBe("t");
  });

  test("unusable PCs: no Claude account, or no project and nothing to clone", () => {
    const none = pickFailover([pc("", "here", { claude: false }), pc("t", "tower", { hasProject: false, canClone: false })]);
    expect(none.to).toBeNull();
    expect(pickFailover([pc("", "here", { hasProject: false, canClone: true, ram: 1 })]).to?.id).toBe("");
    expect(pickFailover([]).to).toBeNull();
  });

  test("the lines are short: where the chat goes, or that messages wait", () => {
    expect(failoverLine("Tower", { to: pc("d", "Desk") }, 0)).toBe("Tower is off. Next message runs on Desk.");
    expect(failoverLine("Tower", { to: pc("", "rig-pc") }, 0)).toBe("Tower is off. Next message runs on rig-pc.");
    expect(failoverLine("Tower", { to: null, why: "x" }, 0)).toBe("Tower is off and no PC can run this. Messages wait until one is back.");
    expect(failoverLine("Tower", { to: null, why: "x" }, 1)).toBe("Tower is off and no PC can run this. Messages wait until one is back. 1 waiting.");
    expect(failoverDraftLine("Tower", { to: pc("d", "Desk", { hasProject: false }) })).toBe("Tower is off. This chat runs on Desk.");
    expect(failoverDraftLine("Tower", { to: null, why: "x" })).toBe("Tower is off and no PC can run this. Try again when one is back.");
    expect(switchedNotice("Tower", "Desk", true)).toEqual({ text: "Tower is off: moved to Desk", detail: "A new session with the conversation so far. Unpushed work stays on Tower." });
    expect(switchedNotice("Tower", "Desk", false).text).toBe("Tower is off: started on Desk");
  });

  test("Codex runs a chat too; the chat's own provider first", () => {
    expect(pickFailover([pc("", "here", { claude: false, codex: true })]).to?.id).toBe("");
    const two = [pc("a", "alpha", { ram: 9000 }), pc("b", "beta", { claude: false, codex: true, ram: 1000 })];
    expect(pickFailover(two, "Codex").to?.id).toBe("b");
    expect(pickFailover(two, "Claude").to?.id).toBe("a");
    expect(pickFailover([pc("", "here", { claude: false })]).to).toBeNull();
  });

  test("waiting messages survive a bad value", () => {
    expect(parseHeld("nope")).toEqual([]);
    expect(parseHeld(JSON.stringify([{ text: "hi", files: ["/a"], mentions: [] }, { x: 1 }]))).toEqual([{ text: "hi", files: ["/a"], mentions: [] }]);
  });
});
