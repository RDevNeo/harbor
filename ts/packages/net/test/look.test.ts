import { describe, expect, test } from "bun:test";
import type { Item } from "@harbor/store";
import { captchaRoles } from "../src/captchanote.ts";
import { GLYPHS } from "../src/glyphs.ts";
import { cardLook, dividerLook, FORK_DIVIDER, noticeGlyph, noticeLook, senderLook, toolLook } from "../src/look.ts";
import { groups, project } from "../src/view.ts";

const notice = (icon: string, detail = "", text = "n"): Item => ({ kind: "notice", icon, text, detail });
const captcha = (state: string, id = "c1"): Item => notice("captcha", JSON.stringify({ captcha: id, state, guild: "G" }), `captcha ${state}`);
const tool = (result: string | null, is_error = false): Item => ({ kind: "tool", id: "t", name: "Bash", summary: "ls", input: "{}", result, is_error });
const looks = (items: Item[], lead = false) => {
  const cards = project(items, lead, []);
  const roles = captchaRoles(items);
  const runs = groups(cards);
  return cards.map((s) => cardLook(s, roles.get(s.seq) ?? null, runs));
};

describe("look", () => {
  test("notice glyphs: the desktop's table, a check for anything else", () => {
    expect(noticeGlyph("wake")).toBe(GLYPHS.ALARM);
    expect(noticeGlyph("lock")).toBe(GLYPHS.LOCK);
    expect(noticeGlyph("report")).toBe(GLYPHS.BOT);
    expect(noticeGlyph("started")).toBe(GLYPHS.PLAY);
    expect(noticeGlyph("sent")).toBe(GLYPHS.SEND);
    expect(noticeGlyph("whatever")).toBe(GLYPHS.CIRCLE_CHECK);
  });

  test("a notice expands to a detail that isn't an address, never with a url", () => {
    const [plain, link, none, url] = project([notice("clock", "why"), notice("clock", "https://x"), notice("clock"), notice("process", "http://127.0.0.1:3000")], false, []).map((s) => s.card);
    for (const [c, want] of [[plain, true], [link, false], [none, false], [url, false]] as const) {
      if (c?.kind !== "notice") throw new Error("not a notice");
      expect(noticeLook(c).expandable).toBe(want);
    }
    if (url?.kind !== "notice") throw new Error("not a notice");
    expect(noticeLook(url).url).toBe("http://127.0.0.1:3000");
  });

  test("tool rows: spinner, check, cross", () => {
    expect(toolLook({ result: null, is_error: false })).toEqual({ glyph: GLYPHS.LOADER, tone: "" });
    expect(toolLook({ result: "ok", is_error: false })).toEqual({ glyph: GLYPHS.CIRCLE_CHECK, tone: "green" });
    expect(toolLook({ result: "no", is_error: true })).toEqual({ glyph: GLYPHS.CIRCLE_X, tone: "red" });
  });

  test("dividers and the sender row", () => {
    expect(dividerLook({ kind: "forked_from", chat: 1, seq: 2 })).toEqual({ glyph: GLYPHS.FORK, text: "Forked from conversation", link: "Open source conversation" });
    expect(dividerLook({ kind: "chat_link", gid: "g", text: "Opened “Docs”" })).toEqual({ glyph: GLYPHS.BOT, text: "Opened “Docs”", link: "Open chat" });
    const u = { kind: "user" as const, text: "", files: [], images: [], mentions: [], at: 0, sender: "Pixel", joined: false };
    expect(senderLook({ ...u, who: "Sam", via: "phone", intent: "" })).toMatchObject({ glyph: GLYPHS.SMARTPHONE, name: "Sam", steer: false });
    expect(senderLook({ ...u, who: "Sam", via: "pc", intent: "steer" })).toMatchObject({ glyph: GLYPHS.MONITOR, name: "Sam", steer: true, steer_glyph: GLYPHS.REDO_2 });
    expect(senderLook({ ...u, who: "", via: "", intent: "" })).toMatchObject({ glyph: "", name: "", steer: false });
  });

  test("captcha notices: a pending one that ended draws nothing, its end is the outcome line", () => {
    const [pending, ended, alone] = looks([captcha("pending"), captcha("timeout"), captcha("pending", "c2")]);
    expect(pending).toMatchObject({ captcha: "none" });
    expect(ended).toMatchObject({ captcha: "outcome", glyph: GLYPHS.CIRCLE_SLASH, text: "captcha timeout", expandable: false });
    expect(alone).toMatchObject({ captcha: "card", glyph: GLYPHS.USER_CHECK });
    expect(looks([captcha("joined")])[0]).toMatchObject({ captcha: "outcome", glyph: GLYPHS.USER_CHECK });
  });

  test("a run's first card carries the run's row; plain cards say nothing", () => {
    const l = looks([{ kind: "thinking", text: "hm" }, tool("ok"), tool(null), { kind: "text", text: "done", at: 1 }]);
    expect(l[0]).toEqual({ run: { label: "2 tool calls", pending: true } });
    expect(l[1]).toEqual({ glyph: GLYPHS.CIRCLE_CHECK, tone: "green" });
    expect(l[2]).toEqual({ glyph: GLYPHS.LOADER, tone: "" });
    expect(l[3]).toBeNull();
    expect(looks([tool("ok", true)])[0]).toEqual({ glyph: GLYPHS.CIRCLE_X, tone: "red", run: { label: "1 tool call", pending: false } });
  });

  test("a card with forks after it carries the fork divider", () => {
    const cards = project([{ kind: "text", text: "a", at: 1 }], false, [[0, 7]]);
    expect(cardLook(cards[0] as (typeof cards)[number], null, new Map())).toEqual({ fork: FORK_DIVIDER });
  });
});
