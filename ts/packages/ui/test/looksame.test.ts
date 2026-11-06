import { expect, test } from "bun:test";
import { captchaRoles, cardLook, groups, project } from "@harbor/net";
import type { Item } from "@harbor/store";
import { newOpened, transcriptCards } from "../src/cards.ts";

// The phone draws each card's `look` (net's look.ts); the desktop draws its cards from the same
// functions. Same transcript, same glyphs, labels and tones on both.
test("the desktop's cards and the phone's looks agree", () => {
  const items: Item[] = [
    { kind: "user", text: "go", files: [], at: 100, mentions: [], sender: "Pixel (Sam)", intent: "steer", who: "Sam", via: "phone", dev: "phone:x" } as Item,
    { kind: "thinking", text: "hm" },
    { kind: "tool", id: "a", name: "Bash", summary: "ls", input: "{}", result: "ok", is_error: false },
    { kind: "tool", id: "b", name: "Bash", summary: "rm", input: "{}", result: "no", is_error: true },
    { kind: "tool", id: "c", name: "Bash", summary: "sleep", input: "{}", result: null, is_error: false },
    { kind: "text", text: "done", at: 101 },
    { kind: "notice", icon: "wake", text: "wakes at 5", detail: "why" },
    { kind: "notice", icon: "lock", text: "locked", detail: "" },
    { kind: "notice", icon: "process", text: "server", detail: "http://127.0.0.1:3000" },
    { kind: "notice", icon: "captcha", text: "c", detail: JSON.stringify({ captcha: "k", state: "pending", guild: null }) },
    { kind: "notice", icon: "captcha", text: "not joined", detail: JSON.stringify({ captcha: "k", state: "closed", guild: null }) },
    { kind: "notice", icon: "fork", text: "Forked from conversation", detail: "harbor:chat/3/1" },
  ];
  const open = newOpened();
  open.limit = 100;
  const cards = project(items, false, [[5, 9]]);
  const runs = groups(cards);
  const roles = captchaRoles(items);
  const looks = cards.map((s) => cardLook(s, roles.get(s.seq) ?? null, runs));
  // Opened runs: the desktop builds every card of them.
  for (const s of cards) if (s.group !== null) open.groups.add(s.group);
  const desk = transcriptCards(items, false, [[5, 9]], open, "");
  const same = (a: unknown[], b: unknown[]) => expect(a).toEqual(b);
  const at = (seq: number, kind?: string) => desk.find((c) => c.seq === seq && (kind === undefined || c.kind === kind));
  // The user's row.
  same([at(0)?.icon, at(0)?.sender, at(0)?.steer], [looks[0]?.glyph, looks[0]?.name, looks[0]?.steer]);
  // The run's row and its tool rows.
  const run = desk.find((c) => c.kind === "group");
  same([run?.label, run?.pending], [(looks[1]?.run as { label: string }).label, (looks[1]?.run as { pending: boolean }).pending]);
  for (const seq of [2, 3, 4]) same([at(seq)?.icon, at(seq)?.tone], [looks[seq]?.glyph, looks[seq]?.tone]);
  // The fork after the reply.
  const fork = desk.find((c) => c.kind === "divider" && c.seq === 5);
  expect([fork?.icon, fork?.text, fork?.label]).toEqual(["glyph", "text", "link"].map((k) => (looks[5]?.fork as Record<string, string>)[k]));
  // Notices, the captcha's outcome line (its pending card draws nothing on either), the fork top.
  for (const seq of [6, 7, 8, 10]) same([at(seq)?.icon, at(seq)?.text, at(seq)?.expandable], [looks[seq]?.glyph, looks[seq]?.text, looks[seq]?.expandable]);
  expect(looks[9]?.captcha).toBe("none");
  expect(at(9)).toBeUndefined();
  same([at(11)?.icon, at(11)?.text, at(11)?.label], [looks[11]?.glyph, looks[11]?.text, looks[11]?.link]);
});
