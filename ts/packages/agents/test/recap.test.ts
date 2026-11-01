import { describe, expect, test } from "bun:test";
import { type Item, Store } from "@harbor/store";
import * as recap from "../src/recap.ts";

test("cleans_like_claude_code", () => {
  expect(recap.clean("<suggestion>run the tests</suggestion>")).toBe("run the tests");
  expect(recap.clean("Suggestion: run the tests")).toBe("run the tests");
  expect(recap.clean("  suggested reply：push it ")).toBe("push it");
  expect(recap.clean("commit this")).toBe("commit this");
});

test("filters_like_claude_code", () => {
  for (const [s, why] of [
    ["", "empty"],
    ["done", "done"],
    ["Nothing to suggest here", "meta_text"],
    ["(silence)", "meta_text"],
    ["[none]", "meta_wrapped"],
    ["API Error: overloaded", "error_message"],
    ["Note: run it", "prefixed_label"],
    ["tests", "too_few_words"],
    ["one two three four five six seven eight nine ten eleven twelve thirteen", "too_many_words"],
    ["Run the tests. Then push", "multiple_sentences"],
    ["run **all** tests", "has_formatting"],
    ["looks good, push it", "evaluative"],
    ["Let me run the tests", "claude_voice"],
  ] as const)
    expect([s, recap.suppressed(s)]).toEqual([s, why]);
  for (const ok of ["run the tests", "yes", "push", "/commit", "commit this and push it", "try it out"]) expect([ok, recap.suppressed(ok)]).toEqual([ok, null]);
});

test("counts_words_and_caps", () => {
  expect(recap.words("run the tests")).toBe(3);
  expect(recap.words("テストを実行")).toBe(2);
  const c = recap.cap("word ".repeat(120).trim(), 400);
  expect([...c].length).toBeLessThanOrEqual(400);
  expect(c.endsWith("…")).toBe(true);
  expect(recap.cap("short", 400)).toBe("short");
});

test("context_keeps_the_request_and_the_end", () => {
  const user = (text: string): Item => ({ kind: "user", text, files: [], at: 0, mentions: [], sender: "", intent: "" });
  const items: Item[] = [user("build the login page")];
  for (let i = 0; i < 400; i++) items.push({ kind: "text", text: `step ${i} done with some words to fill the line`, at: 0 });
  items.push(user("now add tests"));
  const c = recap.context(items, 2000);
  expect(c.startsWith("User: build the login page\n[… earlier")).toBe(true);
  expect(c.endsWith("User: now add tests")).toBe(true);
  expect(c.length).toBeLessThan(2600);
  expect(recap.userCount(items)).toBe(2);
  expect(recap.assistantCount(items)).toBe(400);
});

test("tool labels", () => {
  expect(recap.toolLabel("mcp__harbor__start_process")).toBe("Start process");
  expect(recap.toolLabel("mcp__github__get_me")).toBe("github · get_me");
  expect(recap.toolLabel("Bash")).toBe("Bash");
});

describe("the timers", () => {
  const setup = () => {
    const store = Store.openTemp();
    const chat = store.createChat({ id: 0, repoId: null, title: "t", sessionId: "s", started: true, account: "claude", model: "", effort: "", access: "full", settled: false, updated: 0, role: "lead", parent: null, name: "lead", device: "", gid: "", home: "", homeId: 0, retired: false });
    const items: Item[] = [];
    const user = (text: string): Item => ({ kind: "user", text, files: [], at: 0, mentions: [], sender: "", intent: "" });
    for (const t of ["one", "two", "three"]) items.push(user(t), { kind: "text", text: `did ${t}`, at: 0 });
    let running = false;
    let watched = false;
    const asked: string[] = [];
    const r = new recap.Recaps({
      store,
      chat: (id) => (id === chat.id ? store.chats().find((c) => c.id === id) : undefined),
      items: () => items,
      running: () => running,
      subsRunning: () => false,
      asker: () => ({ bin: "claude", env: [] }),
      watched: () => watched,
      changed: () => {},
    });
    r.ask = async (_b, _e, _s, prompt) => {
      asked.push(prompt.includes("SUGGESTION MODE") ? "suggestion" : "recap");
      return prompt.includes("SUGGESTION MODE") ? "run the tests" : "Building the login page; next, add tests.";
    };
    return { store, chat, r, asked, set: (o: { running?: boolean; watched?: boolean }) => ((running = o.running ?? running), (watched = o.watched ?? watched)) };
  };

  test("a suggestion after the turn, a recap once the user has been away", async () => {
    process.env.HARBOR_TEST_RECAP_S = "0";
    const { store, chat, r, asked, set } = setup();
    r.exited(chat.id, false);
    await Bun.sleep(10);
    expect(asked).toEqual(["suggestion"]);
    expect(r.shownFor(chat.id)).toEqual([null, "run the tests"]);
    // Watched: no recap.
    set({ watched: true });
    r.tick();
    expect(asked).toEqual(["suggestion"]);
    // Away for at least two seconds.
    set({ watched: false });
    r.tick();
    await Bun.sleep(2100);
    r.tick();
    await Bun.sleep(10);
    expect(asked).toEqual(["suggestion", "recap"]);
    expect(r.shownFor(chat.id)[0]).toBe("Building the login page; next, add tests. (disable recaps in Settings)");
    expect(store.get(`recap:${chat.id}`)).toStartWith(`${chat.gid}\n`);
    // A new turn hides both.
    set({ running: true });
    r.tick();
    set({ running: false });
    expect(r.shownFor(chat.id)).toEqual([null, null]);
    delete process.env.HARBOR_TEST_RECAP_S;
    store.close();
  });

  test("a stopped turn or a read-only chat gets no suggestion", async () => {
    const { store, chat, r, asked } = setup();
    r.exited(chat.id, true);
    await Bun.sleep(10);
    expect(asked).toEqual([]);
    store.close();
  });
});
