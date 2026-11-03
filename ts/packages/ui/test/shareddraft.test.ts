import { describe, expect, test } from "bun:test";
import { type DraftIn, DraftSync } from "../src/logic/shareddraft.ts";

function rig() {
  const c = { t: 100_000 };
  const s = new DraftSync(() => "pc:desk", () => c.t);
  return { c, s };
}

const phone = (rev: number, text: string, files: string[] | null = []): DraftIn => ({ text, files, mentions: [], by: "tok:1", rev });
const cleared = (rev: number, files: string[] | null = []): DraftIn => ({ text: "", files, mentions: [], by: "", rev });
const held = (text: string, files: string[] = []) => ({ text, mentions: [], files });

describe("the window's shared draft (api.rs should_apply)", () => {
  test("the phone's draft, image included, goes into the window's composer", () => {
    const { s } = rig();
    const d = phone(10, "see [Image 1]", ["/up/1/5-cam.jpg"]);
    expect(s.decide(1, d)).toBe("now");
    s.took(1, d, held(d.text, ["/up/1/5-cam.jpg"]));
    // Taken in: not an edit, so it isn't sent back; and not applied twice.
    expect(s.changed(1, held(d.text, ["/up/1/5-cam.jpg"]))).toBe(false);
    expect(s.decide(1, d)).toBe("skip");
  });

  test("a send from the phone empties the window's composer", () => {
    const { c, s } = rig();
    expect(s.changed(1, held("typed on the PC"))).toBe(true);
    c.t += 5000;
    expect(s.decide(1, cleared(11))).toBe("now");
  });

  test("its own draft is skipped, an older one too, and a fresh edit here holds one off for a second", () => {
    const { c, s } = rig();
    expect(s.decide(1, { ...phone(10, "mine"), by: "pc:desk" })).toBe("skip");
    expect(s.decide(1, phone(9, "older"))).toBe("skip");
    expect(s.changed(1, held("a"))).toBe(true);
    c.t += 300;
    expect(s.decide(1, phone(11, "theirs"))).toBe(700);
    c.t += 700;
    expect(s.decide(1, phone(11, "theirs"))).toBe("now");
  });

  test("a chat opened with words from before doesn't report them; an edit does", () => {
    const { s } = rig();
    s.shown(3, held("from yesterday"));
    expect(s.changed(3, held("from yesterday"))).toBe(false);
    expect(s.changed(3, held("from yesterday!"))).toBe(true);
  });

  test("an empty composer isn't reported until it changes", () => {
    const { s } = rig();
    expect(s.changed(1, held(""))).toBe(false);
    expect(s.changed(1, held("x"))).toBe(true);
    expect(s.changed(1, held("x"))).toBe(false);
    expect(s.changed(1, held(""))).toBe(true);
  });

  test("the clear of its own message doesn't erase what's typed right after", () => {
    const { s } = rig();
    s.changed(1, held("first"));
    s.sent(1, 20);
    expect(s.changed(1, held("next"))).toBe(true);
    expect(s.decide(1, cleared(20))).toBe("skip");
  });

  test("a copy: the home PC's clear for the window's message is skipped once, a later one applies", () => {
    const { c, s } = rig();
    s.changed(2, held("to the other PC"));
    s.sent(2, null);
    s.changed(2, held("typed after"));
    c.t += 2000;
    expect(s.decide(2, cleared(30))).toBe("skip");
    expect(s.decide(2, cleared(31))).toBe("now");
    // A send that didn't go: no clear comes for it, so the next one is someone else's.
    s.sent(2, null);
    s.unsent(2);
    expect(s.decide(2, cleared(32))).toBe("now");
    // Expected for a minute at most.
    s.sent(2, null);
    c.t += 61_000;
    expect(s.decide(2, cleared(33))).toBe("now");
  });
});
