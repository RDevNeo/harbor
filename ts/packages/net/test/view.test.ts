import { describe, expect, test } from "bun:test";
import type { Item } from "@harbor/store";
import { fixture, notice, result, text, tool, user } from "./fixture.ts";
import { actions, gallery, cardMedia, groupLabel, groups, project, THIS_CHAT, toolLabel, type Media } from "../src/view.ts";

describe("view.rs", () => {
  test("tool_calls_fold_into_runs", () => {
    const groupsOf = (items: Item[]) => project(items, false, []).map((s) => s.group);
    const items: Item[] = [user("go"), tool("a", "ok"), { kind: "thinking", text: "hmm" }, tool("b", "ok"), text("Done with a and b."), tool("c", null)];
    expect(groupsOf(items)).toEqual([null, 1, 1, 1, null, 5]);
    const g = groups(project(items, false, []));
    expect([g.get(1), g.get(5)]).toEqual([
      { calls: 2, pending: false },
      { calls: 1, pending: true },
    ]);
    expect([groupLabel(1), groupLabel(5)]).toEqual(["1 tool call", "5 tool calls"]);
    items.push(tool("d", "ok"));
    expect(groupsOf(items).slice(5)).toEqual([5, 5]);
    expect(groupsOf(items.slice(1, 3))).toEqual([0, 0]);
    expect(groupsOf([{ kind: "thinking", text: "x" }, text("hi")])).toEqual([null, null]);
  });

  test("the_gallery_is_one_cards_images_and_videos_each_once_in_the_order_they_show", () => {
    const m = (path: string, shown: boolean, video: boolean): Media => ({ path, caption: "", video, shown, url: null });
    const items: Item[] = [user("look", ["/p/a.png", "/p/notes.txt", "/p/b.png"]), text("reply"), tool("Read", "read", false, "read"), text("reply"), result()];
    const cards = project(items, false, []);
    const find = (t: string): Media[] =>
      t === "reply" ? [m("/p/named.png", false, false), m("/p/c.png", true, false), m("/p/run.mp4", true, true), m("/p/d.png", true, false), m("/p/c.png", false, false)] : t === "read" ? [m("/p/e.png", true, false)] : [];
    const card = (i: number) => (cards[i] as (typeof cards)[number]).card;
    expect(gallery(card(0), find)).toEqual(["/p/a.png", "/p/b.png"]);
    expect(gallery(card(1), find)).toEqual(["/p/c.png", "/p/run.mp4", "/p/d.png", "/p/named.png"]);
    expect(gallery(card(2), find)).toEqual(["/p/e.png"]);
    expect(gallery(card(4), find)).toEqual([]);
  });

  test("tool_label_accepts_empty_and_non_ascii_names", () => {
    expect(toolLabel("mcp__harbor__spawn_agent")).toBe("Spawn agent");
    expect(toolLabel("mcp__harbor__")).toBe("mcp__harbor__");
    expect(toolLabel("mcp__harbor__été")).toBe("Été");
    expect(toolLabel("mcp__linear__list")).toBe("linear · list");
  });

  test("a_lead_shows_what_it_says_not_how_the_work_got_done", () => {
    const items = fixture();
    const cards = project(items, true, [[8, 42]]);
    expect(cards.map((s) => s.card.kind)).toEqual(["user", "hidden", "hidden", "text", "hidden", "hidden", "hidden", "hidden", "text", "hidden", "hidden", "error"]);
    expect(cards[8]?.forksAfter).toEqual([42]);
    const c8 = cards[8]?.card;
    expect(c8?.kind === "text" && c8.forkable).toBe(true);
    const c0 = cards[0]?.card;
    expect(c0?.kind === "user" ? [c0.files, c0.images] : null).toEqual([["/tmp/notes.txt"], ["/tmp/shot.png"]]);
    expect(cards.every((s) => s.group === null)).toBe(true);
    expect(project(items, false, []).every((s, i) => (s.card.kind === "hidden") === (items[i]?.kind === "result"))).toBe(true);
  });

  test("a_lead_hides_activity_and_keeps_what_the_user_has_to_know", () => {
    const shown = (icons: string[], lead: boolean) => project(icons.map((i) => notice(i, `${i} line`, "more")), lead, []).map((s) => s.card.kind !== "hidden");
    const quiet = ["bot", "report", "process", "wake", "webhook"];
    expect(shown(quiet, true)).toEqual(Array(5).fill(false));
    const kept = ["alert", "clock", "restart", "monitor", "worktree", "folder", "users", "lock", "fork", "chat"];
    expect(shown(kept, true)).toEqual(Array(10).fill(true));
    expect(shown(quiet, false)).toEqual(Array(5).fill(true));
  });

  test("a_turn_of_only_tool_calls_leaves_nothing_in_a_leads_chat", () => {
    const items: Item[] = [tool("Bash", "ok"), tool("Bash", "ok", true), tool("mcp__github__get_pr", "ok"), tool("mcp__harbor__spawn_agent", "ok"), { kind: "thinking", text: "hmm" }, text(" \n")];
    expect(project(items, true, []).every((s) => s.card.kind === "hidden" && s.group === null)).toBe(true);
    expect(project(items, true, [[1, 7]])[1]?.forksAfter).toEqual([7]);
    expect(groups(project(items, false, [])).get(0)?.calls).toBe(4);
  });

  test("a_lead_hides_its_agents_messages_but_not_another_chats", () => {
    const items: Item[] = [
      { kind: "message", from: "api", to: "lead", text: "done" },
      { kind: "message", from: 'chat "Fix login"', to: THIS_CHAT, text: "look at this" },
    ];
    expect(project(items, true, []).map((s) => s.card.kind)).toEqual(["hidden", "message"]);
    expect(project(items, false, []).every((s) => s.card.kind === "message")).toBe(true);
  });

  test("an_old_show_media_call_is_a_tool_card_with_its_file", () => {
    const sm = (r: string, err: boolean) => tool("mcp__harbor__show_media", r, err, '{"path":"out/demo.png","caption":"Demo"}');
    const cards = project([sm("Shown in the chat: /p/out/demo.png (image, 0.1 MB).", false), sm("no such file", true)], true, []);
    expect(cards.map((c) => c.card.kind)).toEqual(["tool", "hidden"]);
    expect(cards[0]?.group).toBeNull();
    const asked: string[] = [];
    const m = cardMedia((cards[0] as (typeof cards)[number]).card, (t) => {
      asked.push(t);
      return [{ path: "/p/out/demo.png", caption: "", video: false, shown: true, url: null }];
    });
    expect(asked.some((a) => a.includes("/p/out/demo.png"))).toBe(true);
    expect(m).toHaveLength(1);
    expect(m[0]?.shown).toBe(false);
  });

  test("labels", () => {
    expect(toolLabel("mcp__harbor__spawn_agent")).toBe("Spawn agent");
    expect(toolLabel("mcp__github__get_pr")).toBe("github · get_pr");
    expect(toolLabel("Bash")).toBe("Bash");
    expect(actions({ kind: "text", text: "", at: 0, forkable: true })).toEqual(["copy", "fork", "mention"]);
  });
});
