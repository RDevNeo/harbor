import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { Chat, Item } from "@harbor/store";
import { newOpened, transcriptCards } from "../src/cards.ts";
import { inChat } from "../src/captchapane.ts";
import { ChatCaptcha, type ChatCaptchaDeps } from "../src/chatcaptcha.ts";
import { fakeCaptcha, pngSize } from "../src/fakecaptcha.ts";
import { captchaNote, captchaRoles, clampTo, frame, inBox, rectOnImage, solvingLine, toPage } from "../src/logic/captchacard.ts";
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
  expect(frame({ captcha: "a", width: 10, height: 5 })).toEqual({ captcha: "a", guild: null, data: null, width: 10, height: 5, crop: { x: 0, y: 0, width: 10, height: 5 }, rect: null, solver: null });
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
const pixels = { width: 1, height: 1, data: new Uint8Array(4) };

function rig(answers: { status: number; body: unknown }[]) {
  const calls: Record<string, unknown>[] = [];
  const shown: ChatCaptchaData[] = [];
  let looking = true;
  let changed = 0;
  const deps: ChatCaptchaDeps = {
    call: async (_c, body) => {
      calls.push(body);
      if (body.action !== "frame") return { status: 200, body: body.action === "input" ? { taken: true, solver: { who: "pc:me", label: "Me" } } : {} };
      return answers.shift() ?? { status: 404, body: {} };
    },
    chat: () => chat,
    looking: () => looking,
    decode: async () => pixels,
    me: () => ({ who: "pc:me", label: "Me" }),
    show: (d) => shown.push(d),
    changed: () => changed++,
    max: () => 460,
  };
  const cap = new ChatCaptcha(deps);
  return { cap, calls, shown, changed: () => changed, hide: () => (looking = false) };
}

const ok = (extra: Record<string, unknown> = {}) => ({ status: 200, body: { captcha: "a", guild: "G", data: "AAAA", width: 400, height: 300, crop: { x: 0, y: 0, width: 800, height: 600 }, rect: { x: 200, y: 150, width: 400, height: 300 }, solver: null, ...extra } });

test("frames come only while the card is on screen and the window shown", async () => {
  const r = rig([ok(), ok()]);
  r.cap.cards(7, ["a"]);
  await Bun.sleep(10);
  expect(r.calls).toEqual([]);
  r.cap.seen("a", true);
  await Bun.sleep(10);
  expect(r.calls).toEqual([{ action: "frame", max: 460 }]);
  expect(r.shown.at(-1)).toMatchObject({ id: "a", has_frame: true, width: 400, height: 300, rx: 0.25, ry: 0.25, rw: 0.5, rh: 0.5, solving: "" });
  r.cap.seen("a", false);
  await Bun.sleep(450);
  expect(r.calls.length).toBe(1);
  r.cap.stop();
});

test("404: the card's captcha waits no more", async () => {
  const r = rig([{ status: 404, body: {} }]);
  r.cap.cards(7, ["a"]);
  r.cap.seen("a", true);
  await Bun.sleep(10);
  expect(r.cap.gone("a")).toBe(true);
  expect(r.changed()).toBe(1);
  r.cap.stop();
});

test("another captcha in the answer: the older card's is gone; another device holding it is said", async () => {
  const r = rig([ok({ captcha: "b", solver: { who: "phone:1", label: "Pixel" } })]);
  r.cap.cards(7, ["a", "b"]);
  r.cap.seen("a", true);
  await Bun.sleep(10);
  expect(r.cap.gone("a")).toBe(true);
  expect(r.cap.gone("b")).toBe(false);
  expect(r.shown.at(-1)).toMatchObject({ id: "b", solving: "Being solved on Pixel" });
  r.cap.stop();
});

test("only points inside the captcha go, in page pixels: presses in order, moves the newest", async () => {
  const r = rig([ok()]);
  r.cap.cards(7, ["a"]);
  r.cap.seen("a", true);
  await Bun.sleep(10);
  r.cap.stop();
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
});

test("Don't join asks the host to close it", async () => {
  const r = rig([ok()]);
  r.cap.cards(7, ["a"]);
  r.cap.cancel("a");
  await Bun.sleep(10);
  expect(r.calls).toContainEqual({ action: "cancel", who: "pc:me" });
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
  expect((await f.call(chat, { action: "frame" })).status).toBe(200);
  await f.call(chat, { action: "cancel" });
  expect((await f.call(chat, { action: "frame" })).status).toBe(404);
  expect(fakeCaptcha({})).toBeNull();
  rmSync(path);
});
