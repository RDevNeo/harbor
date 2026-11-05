import { expect, test } from "bun:test";
import { fromJson, procWakes, type WaitSource, waitingOf, waitText, waitWords, wakeTime } from "../src/waiting.ts";

const chat = (id: number, role: string, parent: number | null = null, retired = false) => ({ id, role, parent, retired });

function source(o: Partial<Omit<WaitSource, "live">> & { live?: number[] } = {}): WaitSource {
  const live = new Set(o.live ?? []);
  return {
    chats: o.chats ?? [chat(1, "lead"), chat(2, "sub", 1), chat(3, "sub", 1), chat(9, "lead")],
    procs: o.procs ?? [],
    timers: o.timers ?? [],
    pending: o.pending ?? new Map(),
    live: (id) => live.has(id),
  };
}

// 2026-11-05 12:00 UTC, a Thursday.
const NOW = 1793880000;

test("a chat that waits on nothing isn't waiting", () => {
  expect(waitingOf(source(), 1)).toBeNull();
  expect(waitingOf(source(), 404)).toBeNull();
});

test("a process the chat started waits until it exits; one that serves a URL doesn't", () => {
  const s = source({ procs: [{ lead: 1, owner: 1, url: null }, { lead: 1, owner: 1, url: null }, { lead: 1, owner: 1, url: "http://127.0.0.1:5173" }] });
  expect(waitingOf(s, 1)).toEqual({ procs: 2, subs: 0, wake: null, keys: 0 });
  expect(waitText(waitingOf(s, 1)!, NOW, 0)).toBe("Waiting · 2 processes");
  // Another team's chat isn't touched.
  expect(waitingOf(s, 9)).toBeNull();
});

test("a subagent's process makes it and its lead wait; a retired one's reports to the lead", () => {
  const s = source({ procs: [{ lead: 1, owner: 2, url: null }] });
  expect(waitingOf(s, 2)?.procs).toBe(1);
  expect(waitingOf(s, 1)?.procs).toBe(1);
  expect(waitingOf(s, 3)).toBeNull();
  const retired = source({ chats: [chat(1, "lead"), chat(2, "sub", 1, true)], procs: [{ lead: 1, owner: 2, url: null }] });
  expect(procWakes(retired, { lead: 1, owner: 2 })).toBe(1);
  expect(waitingOf(retired, 1)?.procs).toBe(1);
  expect(waitingOf(retired, 2)).toBeNull();
});

test("a lead waits on its subagents running or with work queued", () => {
  const s = source({ live: [2], pending: new Map([[3, ["[message from lead] go on"]]]) });
  expect(waitingOf(s, 1)).toEqual({ procs: 0, subs: 2, wake: null, keys: 0 });
  expect(waitText(waitingOf(s, 1)!, NOW, 0)).toBe("Waiting · 2 subagents");
  expect(waitText(waitingOf(source({ live: [3] }), 1)!, NOW, 0)).toBe("Waiting · subagent");
  // A subagent doesn't wait on itself running (that's working).
  expect(waitingOf(s, 2)).toBeNull();
});

test("a snooze waits until its wake-up, the earliest one shown", () => {
  const s = source({ timers: [{ chatId: 1, at: NOW + 7200 }, { chatId: 1, at: NOW + 1800 }] });
  expect(waitingOf(s, 1)?.wake).toBe(NOW + 1800);
  expect(waitText(waitingOf(s, 1)!, NOW, 0)).toBe("Waiting · wake 12:30");
  // Shown in local time.
  expect(waitText(waitingOf(s, 1)!, NOW, -3 * 3600)).toBe("Waiting · wake 09:30");
});

test("a key asked of the user waits until it's answered", () => {
  const asks = [{ chat: 2 }, { chat: 9 }];
  expect(waitingOf(source(), 1, asks)?.keys).toBe(1);
  expect(waitText(waitingOf(source(), 9, asks)!, NOW, 0)).toBe("Waiting · key");
});

test("everything at once reads subagents, processes, wake-up, keys", () => {
  const s = source({ live: [2], procs: [{ lead: 1, owner: 1, url: null }], timers: [{ chatId: 1, at: NOW + 86400 }] });
  const w = waitingOf(s, 1, [{ chat: 1 }, { chat: 1 }])!;
  expect(waitText(w, NOW, 0)).toBe("Waiting · subagent · process · wake Fri 12:00 · 2 keys");
  expect(waitWords(w, NOW, 0)).toBe("waiting on subagent, process, wake Fri 12:00, 2 keys");
});

test("a retired chat waits on nothing", () => {
  const s = source({ chats: [chat(1, "lead", null, true)], timers: [{ chatId: 1, at: NOW + 60 }] });
  expect(waitingOf(s, 1)).toBeNull();
});

test("wake-up times: today, this week, later", () => {
  expect(wakeTime(NOW + 60, NOW, 0)).toBe("12:01");
  expect(wakeTime(NOW + 2 * 86400, NOW, 0)).toBe("Sat 12:00");
  expect(wakeTime(NOW + 10 * 86400, NOW, 0)).toBe("15 Nov 12:00");
});

test("another PC's word on what its chat waits on", () => {
  expect(fromJson({ label: "Waiting", text: "Waiting · process", procs: 1, subs: 0, wake_ms: null, keys: 0 })).toEqual({ procs: 1, subs: 0, wake: null, keys: 0 });
  expect(fromJson({ procs: 0, subs: 0, wake_ms: (NOW + 60) * 1000, keys: 0 })?.wake).toBe(NOW + 60);
  expect(fromJson(null)).toBeNull();
  expect(fromJson({ procs: 0, subs: 0, wake_ms: null, keys: 0 })).toBeNull();
  expect(fromJson("waiting")).toBeNull();
});
