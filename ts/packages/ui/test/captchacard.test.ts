import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { Chat, Item } from "@harbor/store";
import { newOpened, transcriptCards } from "../src/cards.ts";
import { inChat } from "../src/captchapane.ts";
import { ChatCaptcha, type ChatCaptchaDeps } from "../src/chatcaptcha.ts";
import { fakeCaptcha, pngSize } from "../src/fakecaptcha.ts";
import { captchaNote, captchaRoles, clampTo, frame, inBox, rectOnImage, solvingLine, toPage } from "../src/logic/captchacard.ts";
import type { Pixels } from "../src/logos.ts";
import type { ChatCaptchaData } from "../src/window.ts";

const note = (id: string, state: string, text = `captcha ${state}`, guild: string | null = "Big Server"): Item => ({ kind: "notice", icon: "captcha", text, detail: JSON.stringify({ captcha: id, state, guild }) });
const user = (text: string): Item => ({ kind: "user", text, files: [], at: 100, mentions: [], sender: "", intent: "" });

test("a captcha notice's detail, and anything else isn't one", () => {
  expect(captchaNote(JSON.stringify({ captcha: "a1", state: "pending", guild: "G" }))).toEqual({ captcha: "a1", state: "pending", guild: "G" });
  expect(captchaNote(JSON.stringify({ captcha: "a1", state: "joined", guild: null }))).toEqual({ captcha: "a1", state: "joined", guild: null });
  expect(captchaNote("not json")).toBeNull();
  expect(captchaNote(JSON.stringify({ captcha: "a1", state: "weird" }))).toBeNull();
  expect(captchaNote(JSON.stringify({ state: "pending" }))).toBeNull();
});

test("pending alone is the card; with a later notice of it, nothing, and the later one its outcome line", () => {
  const items = [user("join"), note("a", "pending"), note("b", "pending"), { kind: "notice", icon: "bot", text: "x", detail: "" } as Item, note("a", "joined")];
  const roles = captchaRoles(items);
  expect([...roles].map(([seq, r]) => [seq, r.role, r.note.captcha])).toEqual([
    [1, "none", "a"],
    [2, "card", "b"],
    [4, "outcome", "a"],
  ]);
});

test("the transcript draws the live card, the outcome line, and drops the superseded one", () => {
  const open = newOpened();
  const live = [user("join it"), note("a", "pending")];
  const a = transcriptCards(live, false, [], open, "").filter((c) => c.seq >= 0);
  expect(a.map((c) => c.kind)).toEqual(["user", "captcha"]);
  const card = a[1];
  expect(card).toMatchObject({ kind: "captcha", detail: "a", label: "Big Server", result: "", actions: [] });
  expect(card?.text).toBe("To join Big Server. Only the captcha takes your clicks; Harbor never answers it for you.");
  // The same card object while nothing changes; the muted line once the host has none.
  expect(transcriptCards(live, false, [], open, "").find((c) => c.kind === "captcha")).toBe(card as never);
  expect(transcriptCards(live, false, [], open, "", 0, () => [], (id) => id === "a").find((c) => c.kind === "captcha")?.result).toBe("gone");
  const ended = [...live, note("a", "closed", "Captcha closed: Big Server wasn't joined")];
  const b = transcriptCards(ended, false, [], open, "").filter((c) => c.seq >= 0);
  expect(b.map((c) => [c.kind, c.text])).toEqual([
    ["user", "join it"],
    ["notice", "Captcha closed: Big Server wasn't joined"],
  ]);
  expect(b[1]?.expandable).toBe(false);
  expect(b[1]?.detail).toBe("");
});

test("image points to page pixels, and the captcha on the image", () => {
  const crop = { x: 100, y: 50, width: 800, height: 600 };
  expect(toPage(0, 0, crop)).toEqual([100, 50]);
  expect(toPage(0.5, 0.25, crop)).toEqual([500, 200]);
  const rect = { x: 300, y: 200, width: 400, height: 300 };
  expect(rectOnImage(rect, crop)).toEqual({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
  // A captcha partly outside the crop is cut to the image.
  expect(rectOnImage({ x: 0, y: 0, width: 300, height: 1000 }, crop)).toEqual({ x: 0, y: 0, width: 0.25, height: 1 });
  expect(inBox(300, 200, rect)).toBe(true);
  expect(inBox(700, 200, rect)).toBe(false);
  expect(clampTo(900, 100, rect)).toEqual([699, 200]);
});

test("a frame answer, and who holds it", () => {
  expect(frame({ captcha: "a", width: 10, height: 5 })).toEqual({ captcha: "a", guild: null, data: null, width: 10, height: 5, crop: { x: 0, y: 0, width: 10, height: 5 }, rect: null, solver: null, seq: 0, same: false });
  expect(frame({ captcha: "a", seq: 9, same: true })).toMatchObject({ seq: 9, same: true, data: null });
  expect(frame({})).toBeNull();
  expect(solvingLine(null, "pc:me")).toBe("");
  expect(solvingLine({ who: "pc:me", label: "Me" }, "pc:me")).toBe("");
  expect(solvingLine({ who: "phone:1", label: "Pixel" }, "pc:me")).toBe("Being solved on Pixel");
});

test("the overlay stays away from a captcha that has a chat", () => {
  expect(inChat({ captcha: { guild: "G", chat: 4 } })).toBe(true);
  expect(inChat({ captcha: { guild: "G", chat: null } })).toBe(false);
  expect(inChat({ captcha: { guild: "G" } })).toBe(false);
  expect(inChat({})).toBe(false);
});

const chat = { id: 7, home: "" } as Chat;
type Answer = { status: number; body: unknown };

/** A ChatCaptcha on a fake chatCaptcha and a virtual clock: frame answers come from `answers`, and once
 * they run out a request waits (`held`) until the test answers it. */
function rig(answers: Answer[], o: { holdDecode?: boolean } = {}) {
  const calls: (Record<string, unknown> & { t: number })[] = [];
  const shown: ChatCaptchaData[] = [];
  const images: Pixels[] = [];
  const decoded: string[] = [];
  const decodes: (() => void)[] = [];
  let held: ((a: Answer) => void) | null = null;
  let looking = true;
  let open = chat;
  let failing = 0;
  let changed = 0;
  let t = 1000;
  const deps: ChatCaptchaDeps = {
    call: async (c, body) => {
      calls.push({ ...body, t, chat: c.id });
      if (body.action !== "frame") return { status: 200, body: body.action === "input" ? { taken: true, solver: { who: "pc:me", label: "Me" } } : {} };
      const a = answers.shift();
      return a ?? new Promise<Answer>((done) => (held = done));
    },
    chat: () => open,
    looking: () => looking,
    decode: async (b) => {
      const name = Buffer.from(b).toString();
      if (failing > 0) {
        failing--;
        return null;
      }
      if (o.holdDecode) await new Promise<void>((done) => decodes.push(done));
      decoded.push(name);
      return { width: name.length, height: 1, data: new Uint8ClampedArray(4 * name.length) };
    },
    me: () => ({ who: "pc:me", label: "Me" }),
    show: (d) => shown.push(d),
    image: (p) => images.push(p),
    changed: () => changed++,
    scale: () => 2,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      await Promise.resolve();
    },
  };
  const cap = new ChatCaptcha(deps);
  const frames = () => calls.filter((c) => c.action === "frame");
  /** The request waiting now, to answer later. */
  const take = () => {
    const h = held;
    held = null;
    return (a: Answer) => h?.(a);
  };
  const answer = (a: Answer) => take()(a);
  return { cap, calls, frames, shown, images, decoded, decodes, answer, changed: () => changed, hide: () => (looking = false), held: () => held !== null, open: (c: Chat) => (open = c), take, failDecode: (n: number) => (failing = n) };
}

const flush = () => Bun.sleep(2);
const b64 = (s: string) => Buffer.from(s).toString("base64");
const ok = (extra: Record<string, unknown> = {}): Answer => ({ status: 200, body: { captcha: "a", guild: "G", data: b64("A"), width: 400, height: 300, crop: { x: 0, y: 0, width: 800, height: 600 }, rect: { x: 200, y: 150, width: 400, height: 300 }, solver: null, seq: 1, ...extra } });
const same = (seq: number): Answer => ({ status: 200, body: { captcha: "a", guild: "G", width: 400, height: 300, crop: { x: 0, y: 0, width: 800, height: 600 }, rect: { x: 200, y: 150, width: 400, height: 300 }, solver: null, seq, same: true } });

test("frames long-poll: after the last seq, the card's real pixel width, no decode for `same`", async () => {
  const r = rig([ok({ seq: 3 }), same(3), same(3), ok({ seq: 5, data: b64("B") })]);
  r.cap.cards(7, ["a"]);
  await flush();
  expect(r.calls).toEqual([]);
  r.cap.seen("a", true, 300);
  await flush();
  expect(r.frames().map((c) => [c.after, c.max, c.wait])).toEqual([
    [0, 600, 2000],
    [3, 600, 2000],
    [3, 600, 2000],
    [3, 600, 2000],
    [5, 600, 2000],
  ]);
  expect(r.decoded).toEqual(["A", "B"]);
  expect(r.images.length).toBe(2);
  expect(r.shown.at(-1)).toMatchObject({ id: "a", has_frame: true, width: 400, height: 300, rx: 0.25, ry: 0.25, rw: 0.5, rh: 0.5, solving: "" });
  r.cap.stop();
  r.answer(same(5));
});

test("a frame that couldn't be drawn is asked for again: after 0", async () => {
  const r = rig([ok({ seq: 4 }), same(4)]);
  r.failDecode(1);
  r.cap.cards(7, ["a"]);
  r.cap.seen("a", true);
  await flush();
  expect(r.frames().map((c) => c.after)).toEqual([0, 0, 0]);
  r.cap.stop();
  r.answer(same(0));
});

test("at most one request every 50 ms, even when answers come at once", async () => {
  const r = rig([ok(), same(1), same(1), same(1)]);
  r.cap.cards(7, ["a"]);
  r.cap.seen("a", true);
  await flush();
  const starts = r.frames().map((c) => c.t);
  expect(starts.length).toBe(5);
  for (let i = 1; i < starts.length; i++) expect((starts[i] ?? 0) - (starts[i - 1] ?? 0)).toBeGreaterThanOrEqual(50);
  r.cap.stop();
  r.answer(same(1));
});

test("hidden: the loop stops, and the answer still on its way is dropped", async () => {
  const r = rig([]);
  r.cap.cards(7, ["a"]);
  r.cap.seen("a", true);
  await flush();
  expect(r.held()).toBe(true);
  r.hide();
  r.answer(ok());
  await flush();
  expect(r.decoded).toEqual([]);
  expect(r.shown).toEqual([]);
  expect(r.frames().length).toBe(1);
  expect(r.cap.looping).toBe(false);
});

test("scrolled away: no new request after the one in flight", async () => {
  const r = rig([]);
  r.cap.cards(7, ["a"]);
  r.cap.seen("a", true);
  await flush();
  r.cap.seen("a", false);
  r.answer(same(0));
  await flush();
  expect(r.frames().length).toBe(1);
  expect(r.cap.looping).toBe(false);
  // Back on screen: it starts again.
  r.cap.seen("a", true);
  await flush();
  expect(r.frames().length).toBe(2);
  r.cap.stop();
  r.answer(same(0));
});

test("another chat: its frames start at once; the old chat's answer is dropped", async () => {
  const r = rig([]);
  r.cap.cards(7, ["a"]);
  r.cap.seen("a", true);
  await flush();
  const old = r.take();
  const other = { id: 8, home: "" } as Chat;
  r.open(other);
  r.cap.cards(8, ["z"]);
  r.cap.seen("z", true);
  await flush();
  expect(r.frames().map((c) => [c.chat, c.after])).toEqual([
    [7, 0],
    [8, 0],
  ]);
  old(ok());
  await flush();
  expect(r.decoded).toEqual([]);
  expect(r.cap.gone("a")).toBe(false);
  expect(r.frames().length).toBe(2);
  r.cap.stop();
  r.answer(same(0));
});

test("404: the card's captcha waits no more, and the next ask is 2 s later", async () => {
  const r = rig([{ status: 404, body: {} }]);
  r.cap.cards(7, ["a"]);
  r.cap.seen("a", true);
  await flush();
  expect(r.cap.gone("a")).toBe(true);
  expect(r.changed()).toBe(1);
  const [first, second] = r.frames();
  expect((second?.t ?? 0) - (first?.t ?? 0)).toBeGreaterThanOrEqual(2000);
  r.cap.stop();
  r.answer(same(0));
});

test("a frame that comes while one decodes takes the place of the one waiting; the slot takes each frame's shape", async () => {
  const r = rig([ok({ data: b64("A") }), ok({ seq: 2, data: b64("BB"), width: 400, height: 200 }), ok({ seq: 3, data: b64("CCC"), width: 400, height: 200 })], { holdDecode: true });
  r.cap.cards(7, ["a"]);
  r.cap.seen("a", true);
  await flush();
  expect(r.held()).toBe(true);
  expect(r.decodes.length).toBe(1);
  r.decodes.shift()?.();
  await flush();
  r.decodes.shift()?.();
  await flush();
  expect(r.decoded).toEqual(["A", "CCC"]);
  expect(r.images.map((p) => p.width)).toEqual([1, 3]);
  // The checkbox's shape first, then the challenge's (here 400 by 200): never the old shape stretched.
  expect(r.shown.at(-1)).toMatchObject({ width: 400, height: 200 });
  r.cap.stop();
  r.answer(same(3));
});

test("another captcha in the answer: the older card's is gone; another device holding it is said", async () => {
  const r = rig([ok({ captcha: "b", solver: { who: "phone:1", label: "Pixel" } })]);
  r.cap.cards(7, ["a", "b"]);
  r.cap.seen("a", true);
  await flush();
  expect(r.cap.gone("a")).toBe(true);
  expect(r.cap.gone("b")).toBe(false);
  expect(r.shown.at(-1)).toMatchObject({ id: "b", solving: "Being solved on Pixel" });
  r.cap.stop();
  r.answer(same(1));
});

test("only points inside the captcha go, in page pixels, while a frame request waits", async () => {
  const r = rig([ok()]);
  r.cap.cards(7, ["a"]);
  r.cap.seen("a", true);
  await flush();
  expect(r.held()).toBe(true);
  r.cap.pointer("a", "down", 0.1, 0.1); // outside: nothing
  r.cap.pointer("a", "move", 0.3, 0.3);
  r.cap.pointer("a", "move", 0.4, 0.4);
  r.cap.pointer("a", "move", 0.5, 0.5);
  r.cap.pointer("a", "down", 0.5, 0.5);
  r.cap.pointer("a", "up", 0.95, 0.5); // a release outside still lets go, at the captcha's edge
  r.cap.pointer("b", "down", 0.5, 0.5); // another card: nothing
  await r.cap.settled();
  const inputs = r.calls.filter((c) => c.action === "input").map((c) => [c.kind, c.x, c.y, c.who, c.label]);
  expect(inputs).toEqual([
    ["move", 400, 300, "pc:me", "Me"],
    ["down", 400, 300, "pc:me", "Me"],
    ["up", 599, 300, "pc:me", "Me"],
  ]);
  r.cap.stop();
  r.answer(same(1));
});

test("Don't join asks the host to close it", async () => {
  const r = rig([]);
  r.cap.cards(7, ["a"]);
  r.cap.cancel("a");
  await flush();
  expect(r.calls).toContainEqual(expect.objectContaining({ action: "cancel", who: "pc:me" }));
  r.cap.stop();
});

test("the fake: a pending notice after the chat's items, frames until Don't join", async () => {
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47], 0);
  new DataView(png.buffer).setUint32(16, 960);
  new DataView(png.buffer).setUint32(20, 600);
  expect(pngSize(png)).toEqual([960, 600]);
  const path = `${process.env.TMPDIR ?? "/tmp"}/fake-captcha-${process.pid}.png`;
  await Bun.write(path, png);
  const f = fakeCaptcha({ HARBOR_FAKE_CAPTCHA: path });
  if (f === null) throw new Error("no fake");
  const items = f.items([user("hi")]);
  expect(captchaRoles(items).get(1)?.role).toBe("card");
  const first = (await f.call(chat, { action: "frame", after: 0 })).body as { seq: number; data?: string };
  expect(first.data).toBeDefined();
  // Nothing repainted: `same` after the wait; a press repaints it and answers the poll waiting.
  expect(await f.call(chat, { action: "frame", after: first.seq, wait: 10 })).toMatchObject({ status: 200, body: { same: true, seq: first.seq } });
  const poll = f.call(chat, { action: "frame", after: first.seq, wait: 2000 });
  await f.call(chat, { action: "input", kind: "down", x: 1, y: 1, who: "pc:me", label: "Me" });
  expect(((await poll).body as { data?: string; seq: number }).seq).toBe(first.seq + 1);
  await f.call(chat, { action: "cancel" });
  expect((await f.call(chat, { action: "frame" })).status).toBe(404);
  expect(fakeCaptcha({})).toBeNull();
  rmSync(path);
});
