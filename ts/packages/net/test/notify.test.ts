import { describe, expect, test } from "bun:test";
import { MemKv } from "../src/kv.ts";
import {
  aliveNotes,
  asks,
  defaultPrefs,
  Desktop,
  excerpt,
  hm,
  loadPrefs,
  meshNotes,
  newNote,
  Notes,
  Notifier,
  noteJson,
  notesWire,
  parseNotes,
  prefsOn,
  prRefreshDue,
  quietAt,
  savePrefs,
  type NotifyProc,
  type PrItem,
} from "../src/notify.ts";
import { wire } from "../src/wire.ts";

function note(kind: string, key: string, title: string) {
  return newNote({ kind, key, title });
}

describe("notify", () => {
  test("notes_coalesce_per_key", () => {
    const n = new Notes();
    const [, start] = n.since(0);
    const a = n.push(note("done", "chat:1", "api finished"));
    const b = n.push(note("done", "chat:1", "api finished again"));
    n.push(note("ci", "ci:repo", "CI failed"));
    const [all, last] = n.since(start);
    expect(all.length).toBe(2);
    expect(b.id).toBeGreaterThan(a.id);
    expect(last).toBeGreaterThanOrEqual(b.id);
    expect(all[0]?.count).toBe(2);
    expect(all[0]?.title).toBe("api finished again");
    expect(n.since(last)[0].length).toBe(0);
    expect(n.since(last + 1000)[0].length).toBe(2);
    n.push(note("input", "chat:2", "api needs you"));
    const c = n.push(note("done", "chat:2", "api finished"));
    expect([c.kind, c.title, c.count]).toEqual(["input", "api needs you", 2]);
  });

  test("coalescing lasts 90 seconds; the list keeps a day and 200", () => {
    let t = 1000;
    const n = new Notes({ clock: () => t });
    n.push(note("done", "k", "a"));
    t += 89;
    expect(n.push(note("done", "k", "b")).count).toBe(2);
    t += 90;
    expect(n.push(note("done", "k", "c")).count).toBe(1);
    t += 24 * 3600 + 1;
    n.push(note("done", "other", "d"));
    expect(n.since(0)[0].map((x) => x.title)).toEqual(["d"]);
    for (let i = 0; i < 250; i++) n.push(note("done", `k${i}`, "x"));
    expect(n.since(0)[0].length).toBe(200);
  });

  test("ids start at the start time in ms", () => {
    const n = new Notes({ startMs: 1_761_600_000_000 });
    expect(n.last()).toBe(1_761_600_000_000);
    expect(n.push(note("done", "a", "x")).id).toBe(1_761_600_000_001);
    expect(n.push(note("done", "b", "x")).id).toBe(1_761_600_000_002);
    expect(new Notes().last()).toBeGreaterThan(1_761_600_000_000);
  });

  test("waiting_returns_when_one_comes", async () => {
    const n = new Notes();
    const [, last] = n.since(0);
    const got = n.wait(last, 5000);
    setTimeout(() => n.push(note("done", "chat:1", "x")), 100);
    expect((await got)[0].length).toBe(1);
    const t0 = Date.now();
    expect((await n.wait(n.since(0)[1], 200))[0]).toEqual([]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(190);
  });

  test("/v1/alive since and wait_ms", async () => {
    const n = new Notes();
    expect(await aliveNotes(n, {})).toBeNull();
    expect(await aliveNotes(n, { since: -1 })).toBeNull();
    const first = await aliveNotes(n, { since: 0, wait_ms: 5000 });
    expect(JSON.parse(wire(first))).toEqual({ notes: [], last: n.last() });
    const start = n.last();
    n.push(note("done", "chat:1", "x"));
    const got = JSON.parse(wire(await aliveNotes(n, { since: start }))) as { notes: { id: number }[]; last: number };
    expect(got.notes.length).toBe(1);
    expect(got.last).toBe(n.last());
    const t0 = Date.now();
    const none = JSON.parse(wire(await aliveNotes(n, { since: n.last(), wait_ms: 150 }))) as { notes: unknown[] };
    expect(none.notes).toEqual([]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    const waiting = aliveNotes(n, { since: n.last(), wait_ms: 5000 });
    setTimeout(() => n.push(note("input", "chat:2", "y")), 50);
    expect((JSON.parse(wire(await waiting)) as { notes: unknown[] }).notes.length).toBe(1);
    const future = JSON.parse(wire(await aliveNotes(n, { since: n.last() + 1000 }))) as { notes: unknown[] };
    expect(future.notes.length).toBe(2);
  });

  test("questions_and_excerpts", () => {
    expect(asks("Done.\n\nShould I also update the docs?")).toBe(true);
    expect(asks("Which one do you want: **A** or **B?**")).toBe(true);
    expect(asks("Fixed it. Tests pass.")).toBe(false);
    expect(asks("Is it ok? Yes.\n\nShipped.")).toBe(false);
    expect(excerpt("First part.\n\n## Summary\n- **Fixed** the `parser`")).toBe("Summary Fixed the parser");
    expect([...excerpt("x".repeat(500))].length).toBeLessThanOrEqual(160);
    expect(excerpt("é".repeat(200))).toBe(`${"é".repeat(159)}…`);
  });

  test("the_mesh_gets_only_this_pcs_own_notes", () => {
    const n = new Notes();
    const start = n.last();
    n.push(note("done", "chat:1", "a"));
    n.push(note("pc", "pc:x", "x went offline"));
    n.relay("desk", [note("done", "chat:2", "b")]);
    const [own] = n.ownSince(start);
    expect(own.map((x) => x.key)).toEqual(["chat:1"]);
    expect(n.since(start)[0].length).toBe(3);
    expect(n.since(start)[0][2]?.from).toBe("desk");
  });

  test("/mesh/v1/notes and relayed notes on the wire", () => {
    const n = new Notes();
    expect(JSON.parse(wire(meshNotes(n, null)))).toEqual({ notes: [], last: n.last() });
    const start = n.last();
    n.push(newNote({ kind: "done", key: "chat:1", title: "a", chat: "g1", reply: true }));
    n.push(note("pc", "pc:x", "x"));
    expect(JSON.parse(wire(meshNotes(n, "0")))).toEqual({ notes: [], last: n.last() });
    const got = JSON.parse(wire(meshNotes(n, String(start)))) as { notes: Record<string, unknown>[] };
    expect(got.notes.map((x) => x.key)).toEqual(["chat:1"]);
    const text = wire(notesWire(n.since(start)[0].slice(0, 1), 5));
    expect(text).toContain('"away":false,"body":"","chat":"g1","count":1,"id":');
    expect(Object.keys(noteJson(newNote({ kind: "k" })) as object)).toEqual(["id", "at", "kind", "key", "title", "body", "count", "away", "reply"]);
    const back = parseNotes((JSON.parse(text) as { notes: unknown }).notes);
    expect(back[0]).toMatchObject({ key: "chat:1", chat: "g1", reply: true, url: "", from: "" });
    expect(parseNotes("x")).toEqual([]);
    const m = new Notes();
    m.relay("laptop", back);
    expect(m.since(0)[0][0]?.from).toBe("laptop");
  });

  test("prefs_and_quiet_hours", () => {
    const p = defaultPrefs();
    expect(prefsOn(p, "done") && prefsOn(p, "input") && !prefsOn(p, "agent")).toBe(true);
    expect(quietAt(p, 23 * 60)).toBe(false);
    p.quiet = true;
    expect(quietAt(p, 23 * 60) && quietAt(p, 3 * 60) && !quietAt(p, 12 * 60)).toBe(true);
    p.quiet_from = "13:00";
    p.quiet_to = "14:30";
    expect(quietAt(p, 13 * 60 + 10) && !quietAt(p, 14 * 60 + 30)).toBe(true);
    expect(hm("7:05")).toBe(425);
    expect(hm("25:00")).toBeNull();
    expect(hm("nope")).toBeNull();
  });

  test("prefs are kept in kv notify", () => {
    const kv = new MemKv();
    expect(loadPrefs(kv)).toEqual(defaultPrefs());
    const p = { ...defaultPrefs(), kinds: { agent: true, ci: false }, quiet: true, away_only: true };
    savePrefs(kv, p);
    expect(kv.get("notify")).toBe('{"kinds":{"agent":true,"ci":false},"quiet":true,"quiet_from":"22:00","quiet_to":"07:00","away_only":true}');
    expect(loadPrefs(kv)).toEqual({ ...p, quiet: false, away_only: false });
    kv.set("notify", "{bad");
    expect(loadPrefs(kv)).toEqual(defaultPrefs());
    expect(prefsOn(p, "agent")).toBe(true);
    expect(prefsOn(p, "ci")).toBe(false);
    expect(prRefreshDue({ prefs: p, phonesPaired: false, loading: false, now: 700, last: 0, ghInstalled: true })).toBe(false);
    expect(prRefreshDue({ prefs: p, phonesPaired: true, loading: false, now: 700, last: 0, ghInstalled: true })).toBe(true);
    expect(prRefreshDue({ prefs: p, phonesPaired: true, loading: false, now: 500, last: 0, ghInstalled: true })).toBe(false);
  });

  interface Fake {
    args: string[];
    proc: NotifyProc;
    say(line: string): void;
    end(): void;
    killed: boolean;
  }

  function fakeSend() {
    const runs: Fake[] = [];
    const send = (args: string[]): NotifyProc => {
      const queue: string[] = [];
      let wake: (() => void) | null = null;
      let ended = false;
      let exit: () => void = () => {};
      const exited = new Promise<void>((r) => (exit = r));
      const lines: AsyncIterable<string> = {
        [Symbol.asyncIterator]: () => ({
          async next() {
            while (queue.length === 0 && !ended) await new Promise<void>((r) => (wake = r));
            const v = queue.shift();
            return v === undefined ? { done: true, value: undefined } : { done: false, value: v };
          },
        }),
      };
      const fake: Fake = {
        args,
        say: (l) => {
          queue.push(l);
          wake?.();
        },
        end: () => {
          ended = true;
          wake?.();
          exit();
        },
        killed: false,
        proc: { pid: 100 + runs.length, lines, kill: () => (fake.killed = true), exited },
      };
      runs.push(fake);
      return fake.proc;
    };
    return { runs, send };
  }

  test("the desktop popup: settings, replacing quietly, a click opens the chat", async () => {
    const { runs, send } = fakeSend();
    let t = 0;
    const d = new Desktop({ send, mono: () => t, localMinute: () => 12 * 60 });
    const notifier = new Notifier({ notes: new Notes(), desktop: d });
    notifier.post("input", "chat:g", "api needs you", "Which one?", "g", true);
    expect(runs[0]?.args).toEqual(["-a", "Harbor", "-p", "-u", "critical", "-A", "default=Open", "api needs you", "Which one?"]);
    runs[0]?.say("7");
    await new Promise((r) => setTimeout(r, 0));
    t = 10_000;
    notifier.post("input", "chat:g", "api needs you", "again", "g", true);
    expect(runs[0]?.killed).toBe(true);
    expect(runs[1]?.args).toEqual([
      "-a", "Harbor", "-p", "-u", "critical", "--replace-id=7", "-h", "boolean:suppress-sound:true", "-h", "boolean:transient:true", "-A", "default=Open", "api needs you (2)", "again",
    ]);
    runs[1]?.say("7");
    runs[1]?.say("default");
    runs[1]?.end();
    runs[0]?.end();
    await d.idle();
    expect(d.takeOpen()).toEqual(["g"]);
    expect(d.takeOpen()).toEqual([]);

    d.focused = true;
    notifier.post("done", "chat:h", "x finished", "", "h", true);
    expect(runs.length).toBe(2);
    d.focused = false;
    notifier.post("agent", "chat:s", "sub finished", "", "s", true);
    expect(runs.length).toBe(2);
    d.prefs = { ...defaultPrefs(), quiet: true, quiet_from: "11:00", quiet_to: "13:00" };
    notifier.post("done", "chat:q", "quiet", "", "", false);
    expect(runs.length).toBe(2);
    d.prefs = { ...defaultPrefs(), away_only: true };
    d.frame(true, true);
    expect(d.atPc()).toBe(true);
    d.frame(false, false);
    notifier.post("done", "chat:r", "away?", "", "", false);
    expect(runs.length).toBe(3);
    expect(runs[2]?.args).toEqual(["-a", "Harbor", "-p", "-u", "normal", "away?", ""]);
  });

  test("a note records whether the user was away", () => {
    const notes = new Notes();
    const d = new Desktop({ send: () => null, clock: () => 1000 });
    const n = new Notifier({ notes, desktop: d });
    d.frame(true, true);
    d.atPcAt = 1000 - 119;
    n.post("done", "a", "t", "x".repeat(300), "", false);
    n.push(newNote({ kind: "done", key: "b" }), false);
    d.atPcAt = 1000 - 120;
    n.push(newNote({ kind: "done", key: "c" }), false);
    const [all] = notes.since(0);
    expect(all.map((x) => x.away)).toEqual([false, false, true]);
    expect([...(all[0]?.body ?? "")].length).toBe(240);
  });

  test("events become notes", () => {
    const notes = new Notes();
    const n = new Notifier({ notes });
    const chat = { gid: "g1", title: "Fix login", name: "tests", home: "", project: "harbor" };
    n.noteTurn(chat, false, false, "Done.\n\nShould I ship it?");
    n.noteTurn({ ...chat, gid: "g2" }, false, true, "boom");
    n.noteTurn({ ...chat, gid: "g3" }, true, false, "");
    n.noteTurn({ ...chat, gid: "g4", project: null, title: "" }, false, false, "ok");
    n.noteTurn({ ...chat, gid: "g5", home: "ts:other" }, false, false, "ok");
    n.noteTurn({ ...chat, gid: "" }, false, false, "ok");
    n.noteTurn(null, false, false, "ok");
    const got = notes.since(0)[0].map((x) => [x.kind, x.key, x.title, x.body, x.chat, x.reply]);
    expect(got).toEqual([
      ["input", "chat:g1", "Fix login needs you", "harbor · Should I ship it?", "g1", true],
      ["done", "chat:g2", "Fix login stopped with an error", "harbor · boom", "g2", true],
      ["agent", "chat:g3", "tests finished", "harbor", "g3", true],
      ["done", "chat:g4", "A chat finished", "ok", "g4", true],
    ]);

    const m = new Notes();
    const l = new Notifier({ notes: m });
    l.noteLimit({ gid: "g", title: "Fix", home: "" }, "claude", "Claude", true, "resets at 5");
    l.noteLimit({ gid: "g", title: "Fix", home: "" }, "claude", "Claude", false, "resets at 5");
    l.noteLimit({ gid: "g", title: "Fix", home: "x" }, "claude", "Claude", false, "ignored");
    l.noteResumed({ gid: "g", title: "Fix" }, "claude2", "Claude 2", "continuing", false);
    expect(m.since(0)[0].map((x) => [x.kind, x.key, x.title, x.body, x.act])).toEqual([
      ["input", "chat:g", "Fix waits for you", "Claude: resets at 5", "continue"],
      ["limit", "limit:claude", "Claude hit its usage limit", "Fix: resets at 5", ""],
      ["limit", "limit:claude2", "Claude 2: usage limit reset", "Fix · continuing", ""],
    ]);
  });

  test("PCs going offline and back", () => {
    const notes = new Notes();
    const n = new Notifier({ notes });
    const pc = (online: boolean) => [{ id: "ts:a", name: "laptop", online }];
    n.notePeers(pc(false), true);
    n.notePeers(pc(true), true);
    expect(notes.since(0)[0]).toEqual([]);
    n.notePeers(pc(false), true);
    n.notePeers(pc(false), true);
    n.notePeers(pc(true), true);
    expect(notes.since(0)[0].map((x) => [x.kind, x.key, x.title, x.body])).toEqual([["pc", "pc:ts:a", "laptop is back online", ""]]);
    n.notePeers([{ id: "ts:b", name: "", online: true }], true);
    n.notePeers([{ id: "ts:b", name: "", online: false }], false);
    n.notePeers([{ id: "ts:b", name: "", online: true }], true);
    expect(notes.since(0)[0].length).toBe(1);
  });

  test("a PC that stops answering is a note", () => {
    const notes = new Notes();
    const n = new Notifier({ notes });
    n.notePeers([{ id: "ts:b", name: "", online: true }], true);
    n.notePeers([{ id: "ts:b", name: "", online: false }], true);
    expect(notes.since(0)[0].map((x) => [x.title, x.body, x.reply])).toEqual([["A PC went offline", "Harbor there doesn't answer any more.", false]]);
  });

  test("failed checks once per head commit, not on the first list", () => {
    const notes = new Notes();
    const n = new Notifier({ notes });
    const pr = (over: Partial<PrItem> = {}): PrItem => ({ repo: "org/harbor", number: 7, head: "aaa", title: "Fix it", url: "https://example.test/pr/7", author: "sam", state: "open", checks: "failing", ...over });
    n.noteChecks({ viewer: "sam", items: [pr()] });
    expect(notes.since(0)[0]).toEqual([]);
    n.noteChecks({ viewer: "sam", items: [pr(), pr({ number: 8, author: "other" }), pr({ number: 9, state: "closed" }), pr({ number: 10, checks: "passing" })] });
    expect(notes.since(0)[0]).toEqual([]);
    n.noteChecks({ viewer: "sam", items: [pr({ head: "bbb" }), pr({ number: 11, repo: "org/other", head: "c" })] });
    expect(notes.since(0)[0].map((x) => [x.kind, x.key, x.title, x.body, x.url])).toEqual([
      ["ci", "ci:org/harbor#7", "Checks failed on #7 in harbor", "Fix it", "https://example.test/pr/7"],
      ["ci", "ci:org/other#11", "Checks failed on #11 in other", "Fix it", "https://example.test/pr/7"],
    ]);
  });
});
