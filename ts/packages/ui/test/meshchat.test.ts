import { expect, test } from "bun:test";
import { blankChat, type Chat } from "@harbor/store";
import { MeshChat, type ShellMesh } from "../src/logic/meshchat.ts";
import type { Mention } from "../src/logic/mentions.ts";

const mention: Mention = { item: 3, from: "Claude", at: 0, text: "hi", len: 2, excerpt: false, note: "", kind: "", chat: "", title: "" };

function rig(o: { online?: boolean; answer?: { status: number; body: unknown }; peerOnline?: boolean } = {}) {
  const calls: { method: string; tail: string[]; body: Record<string, unknown>; files: readonly string[] }[] = [];
  const created: Record<string, unknown>[] = [];
  const leases: string[] = [];
  const restored: { chat: number; text: string; mentions: Mention[]; append: boolean }[] = [];
  const opened: number[] = [];
  let clock = 1000;
  const m: ShellMesh = {
    me: () => "pc:desk",
    home: (c) => (c.home === "" ? null : { name: "laptop", online: o.online ?? true }),
    peer: (id) => (id === "pc:laptop" ? { name: "laptop", online: o.peerOnline ?? true } : null),
    remote: (id) => (id === 7 ? { running: true, queued: 2 } : null),
    typers: (id) => (id === 7 ? [{ device: "tok:1", label: "Galaxy" }] : []),
    viewers: () => [{ device: "pc:laptop", kind: "away", label: "laptop" }],
    forward: async (_c, method, tail, body, files = []) => {
      calls.push({ method, tail, body, files });
      return o.answer ?? { status: 200, body: { ok: true } };
    },
    create: async (_peer, body) => {
      created.push(body);
      return o.answer ?? { status: 200, body: { id: 42 } };
    },
    lease: (id, view, kind, on) => void leases.push(`${id} ${view ? "view" : "type"} ${kind} ${on}`),
  };
  const mc = new MeshChat(m, {
    restore: (chat, text, mentions, append) => void restored.push({ chat, text, mentions, append }),
    changed: () => {},
    opened: (id) => void opened.push(id),
    now: () => clock,
  });
  const tick = (ms: number) => {
    clock += ms;
  };
  return { mc, calls, created, leases, restored, opened, tick, m };
}

const copy: Chat = blankChat({ id: 7, home: "pc:laptop", homeId: 70, title: "Laptop's chat" });
const own: Chat = blankChat({ id: 8, title: "Mine" });
const flush = () => new Promise((r) => setTimeout(r, 0));

test("a copy's message goes to its home PC with its mentions, files and steer or queue", async () => {
  const { mc, calls, restored } = rig();
  expect(mc.send(copy, "do it", ["/tmp/a.png"], [mention], "steer")).toBe(true);
  await flush();
  expect(calls).toEqual([{ method: "POST", tail: ["send"], body: { text: "do it", mentions: [mention], mode: "steer" }, files: ["/tmp/a.png"] }]);
  expect(restored).toEqual([]);
  expect(mc.error(7)).toBe("");
});

test("this PC's own chat is not forwarded", async () => {
  const { mc, calls } = rig();
  expect(mc.send(own, "x", [], [], "queue")).toBe(false);
  expect(mc.stop(own)).toBe(false);
  expect(mc.patch(own, { settled: true })).toBe(false);
  await flush();
  expect(calls).toEqual([]);
});

test("stop holds the queue at the home PC; settle, model and fork change the chat there", async () => {
  const { mc, calls } = rig();
  mc.stop(copy);
  mc.patch(copy, { settled: true });
  mc.fork(copy, 4);
  await flush();
  expect(calls.map((c) => [c.method, c.tail.join("/"), c.body])).toEqual([
    ["POST", "stop", { hold: true }],
    ["PATCH", "", { settled: true }],
    ["POST", "fork", { seq: 4 }],
  ]);
});

test("with the home PC off nothing goes out: the composer gets the text and its mentions back, and says why", async () => {
  const { mc, calls, restored } = rig({ online: false });
  expect(mc.writable(copy)).toBe(false);
  expect(mc.readOnly(copy)).toBe("laptop is off. This chat runs there, so it's read-only until laptop is back; then it catches up.");
  mc.send(copy, "hello", [], [mention], "queue");
  await flush();
  expect(calls).toEqual([]);
  expect(restored).toEqual([{ chat: 7, text: "hello", mentions: [mention], append: true }]);
  expect(mc.error(7)).toBe("Couldn't send: laptop is off");
});

test("with the home PC off, a change makes the chat this PC's and is made here; a stop has nothing to do", async () => {
  const { mc, calls, m } = rig({ online: false });
  const adopted: number[] = [];
  m.adopt = (c) => {
    adopted.push(c.id);
    return { ...c, home: "", homeId: 0, account: "claude2" };
  };
  m.failover = () => null;
  const c = { ...copy };
  expect(mc.writable(c)).toBe(true);
  expect(mc.readOnly(c)).toBeNull();
  expect(mc.stop(c)).toBe(true);
  expect(adopted).toEqual([]);
  // false: the caller settles it as one of its own; the window's object is this PC's chat now.
  expect(mc.patch(c, { settled: true })).toBe(false);
  expect(adopted).toEqual([7]);
  expect(c.home).toBe("");
  expect(c.account).toBe("claude2");
  expect(mc.rename(c, "New name")).toBe(false);
  await flush();
  expect(calls).toEqual([]);
  expect(mc.error(7)).toBe("");
});

test("with the home PC off, a change this PC can't take says why", async () => {
  const { mc, m } = rig({ online: false });
  m.adopt = () => "laptop is off, and it isn't one of the PCs this account uses";
  const c = { ...copy };
  expect(mc.remove(c)).toBe(true);
  expect(c.home).toBe("pc:laptop");
  expect(mc.error(7)).toBe("Couldn't delete the chat: laptop is off, and it isn't one of the PCs this account uses");
});

test("a send the home PC refuses comes back into an empty composer, and its error line goes after 12 s", async () => {
  const { mc, restored, tick } = rig({ answer: { status: 409, body: { error: "the chat is gone" } } });
  mc.send(copy, "hello", [], [mention], "queue");
  await flush();
  expect(restored).toEqual([{ chat: 7, text: "hello", mentions: [mention], append: false }]);
  expect(mc.error(7)).toBe("Couldn't send: the chat is gone");
  expect(mc.error(8)).toBe("");
  tick(11_999);
  expect(mc.error(7)).not.toBe("");
  tick(1);
  expect(mc.error(7)).toBe("");
});

test("a copy that its home PC answers names its PC on the device chip, its running turn and who types there", () => {
  const { mc } = rig();
  expect(mc.writable(copy)).toBe(true);
  expect(mc.readOnly(copy)).toBeNull();
  // The composer's device chip names the PC the copy runs on, not "This PC".
  expect(mc.homeName(copy)).toBe("laptop");
  expect(mc.running(copy)).toBe(true);
  expect(mc.running(own)).toBe(false);
  expect(mc.queued(copy)).toBe(2);
  expect(mc.typing(7)).toBe("\u{270E}  Galaxy");
  expect(mc.typing(8)).toBe("");
  expect(mc.sendTip(7)).toBe("Queue (Enter): Galaxy is typing; it goes out when they're done");
  expect(mc.sendTip(8)).toBe("Send (Enter)");
  expect(mc.viewers(7)).toBe("laptop (away)");
  expect(mc.readOnly(blankChat({ id: 9, home: "pc:laptop", retired: true }))).toBeNull();
});

test("typing and viewing leases go out as typing pc and focused or away", () => {
  const { mc, leases } = rig();
  mc.typed(7, true, { text: "Hel" });
  mc.viewed(7, true, true);
  mc.viewed(7, false, false);
  expect(leases).toEqual(["7 type pc true", "7 view focused true", "7 view away false"]);
});

test("a draft's first message starts the chat on another PC and opens its copy", async () => {
  const { mc, created, opened, restored } = rig();
  expect(mc.create("pc:laptop", { text: "start", account: "claude" }, [], null, 0, { text: "start", mentions: [] })).toBe(true);
  await flush();
  expect(created).toEqual([{ text: "start", account: "claude" }]);
  expect(opened).toEqual([42]);
  expect(restored).toEqual([]);
  expect(mc.create("pc:nope", {}, [], null, 0, { text: "", mentions: [] })).toBe(false);
});

test("a draft for a PC that is off stays in the composer", async () => {
  const { mc, created, restored } = rig({ peerOnline: false });
  mc.create("pc:laptop", { text: "start" }, [], null, 0, { text: "start", mentions: [] });
  await flush();
  expect(created).toEqual([]);
  expect(restored).toEqual([{ chat: 0, text: "start", mentions: [], append: true }]);
  expect(mc.error(0)).toBe("laptop is off: pick a PC that's on");
});
