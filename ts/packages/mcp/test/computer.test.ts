import { afterEach, describe, expect, test } from "bun:test";
import type { screen } from "@harbor/os";
import { hostname } from "@harbor/net";
import { act, allowedIn, call, type CallContext, parseAction, scaled, served, setHost, toolDef, toScreen, toView, zoomSize } from "../src/computer.ts";
import { answer, tools } from "../src/mcpshim.ts";

/** A screen that remembers what was done to it. */
function fake(w = 2560, h = 1440, cursor: { x: number; y: number } | null = { x: 500, y: 500 }) {
  const log: string[] = [];
  let at = cursor;
  const b: screen.Backend = {
    name: "fake",
    size: async () => ({ w, h }),
    capture: async (region, out) => {
      log.push(`capture ${region ? `${region.x},${region.y} ${region.w}x${region.h}` : "all"} -> ${out ? `${out.w}x${out.h}` : "native"}`);
      const ow = out?.w ?? region?.w ?? w;
      const oh = out?.h ?? region?.h ?? h;
      return { w: ow, h: oh, rgba: new Uint8Array(ow * oh * 4).fill(200) };
    },
    move: async (x, y) => {
      at = { x: Math.round(x), y: Math.round(y) };
      log.push(`move ${Math.round(x)},${Math.round(y)}`);
    },
    button: async (btn, how, count = 1) => void log.push(`${btn} ${how}${count > 1 ? ` x${count}` : ""}`),
    scroll: async (dir, n) => void log.push(`scroll ${dir} ${n}`),
    key: async (c, how = "press") => void log.push(`key ${how} ${[...c.mods, c.key].filter((k) => k !== "").join("+")}`),
    type: async (t) => void log.push(`type ${t}`),
    cursor: async () => at,
  };
  return { b, log };
}

const view = scaled(2560, 1440);

describe("scaling", () => {
  test("screenshots fit 1280 px and 1.15 megapixels, keeping the aspect", () => {
    expect(scaled(2560, 1440)).toEqual({ w: 1280, h: 720 });
    expect(scaled(1920, 1080)).toEqual({ w: 1280, h: 720 });
    expect(scaled(1280, 800)).toEqual({ w: 1280, h: 800 });
    expect(scaled(1024, 768)).toEqual({ w: 1024, h: 768 });
    // Retina 16:10.
    expect(scaled(3024, 1964)).toEqual({ w: 1280, h: 831 });
    // A tall portrait monitor: the megapixel cap.
    const tall = scaled(1080, 1920);
    expect(tall.h).toBeLessThanOrEqual(1280);
    expect(tall.w * tall.h).toBeLessThanOrEqual(1_150_000);
    // Never larger than the screen.
    expect(scaled(800, 600)).toEqual({ w: 800, h: 600 });
  });

  test("coordinates map to the screen and back", () => {
    const real = { w: 2560, h: 1440 };
    expect(toScreen([0, 0], view, real)).toEqual([0, 0]);
    expect(toScreen([640, 360], view, real)).toEqual([1280, 720]);
    expect(toScreen([1279, 719], view, real)).toEqual([2558, 1438]);
    expect(toView([1281, 721], view, real)).toEqual([641, 361]);
    expect(toView([2559, 1439], view, real)).toEqual([1279, 719]);
    for (const p of [[3, 7], [100, 200], [1279, 0], [512, 719]] as [number, number][]) expect(toView(toScreen(p, view, real), view, real)).toEqual(p);
    // 1:1 when the screen isn't scaled.
    expect(toScreen([17, 33], { w: 800, h: 600 }, { w: 800, h: 600 })).toEqual([17, 33]);
  });

  test("zoomed regions fill the screenshot's size, at most 4 times", () => {
    expect(zoomSize({ w: 640, h: 360 }, view)).toEqual({ w: 1280, h: 720 });
    expect(zoomSize({ w: 100, h: 100 }, view)).toEqual({ w: 400, h: 400 });
    expect(zoomSize({ w: 2000, h: 200 }, view)).toEqual({ w: 1280, h: 128 });
  });
});

describe("actions", () => {
  test("each action's arguments are checked", () => {
    expect(parseAction({ action: "screenshot" }, view)).toEqual({ action: "screenshot" });
    expect(parseAction({ action: "left_click", coordinate: [10.4, 20] }, view)).toEqual({ action: "left_click", coordinate: [10, 20], mods: "" });
    expect(parseAction({ action: "left_click", text: "shift" }, view)).toEqual({ action: "left_click", coordinate: null, mods: "shift" });
    expect(parseAction({ action: "scroll", scroll_direction: "down" }, view)).toEqual({ action: "scroll", coordinate: null, direction: "down", amount: 3, mods: "" });
    expect(parseAction({ action: "key", text: "ctrl+s", repeat: 2 }, view)).toEqual({ action: "key", text: "ctrl+s", repeat: 2 });
    expect(parseAction({ action: "zoom", region: [0, 0, 100, 50] }, view)).toEqual({ action: "zoom", region: [0, 0, 100, 50] });
    expect(parseAction({ action: "left_click_drag", start_coordinate: [1, 2], coordinate: [3, 4] }, view)).toMatchObject({ start: [1, 2], coordinate: [3, 4] });
  });

  test("and refused with a reason", () => {
    const no = (a: unknown) => () => parseAction(a, view);
    expect(no({ action: "fly" })).toThrow("action must be one of");
    expect(no({ action: "mouse_move" })).toThrow("mouse_move needs coordinate");
    expect(no({ action: "left_click", coordinate: [1280, 5] })).toThrow("outside the screen");
    expect(no({ action: "left_click", coordinate: [-1, 5] })).toThrow("outside the screen");
    expect(no({ action: "left_click", coordinate: "10,20" })).toThrow("must be [x, y]");
    expect(no({ action: "left_click", text: "ctrl+c" })).toThrow("modifier keys");
    expect(no({ action: "type" })).toThrow("type needs text");
    expect(no({ action: "type", text: "x".repeat(5001) })).toThrow("at most 5000");
    expect(no({ action: "key", text: "ctrl+nope" })).toThrow("unknown key");
    expect(no({ action: "scroll", scroll_direction: "sideways" })).toThrow("scroll_direction");
    expect(no({ action: "scroll", scroll_direction: "up", scroll_amount: 0 })).toThrow("1 to 100");
    expect(no({ action: "wait", duration: 61 })).toThrow("0 to 60");
    expect(no({ action: "hold_key", text: "shift", duration: 0 })).toThrow("more than 0");
    expect(no({ action: "zoom", region: [10, 10, 5, 20] })).toThrow("bottom-right");
    expect(no({ action: "zoom", region: [0, 0, 2000, 10] })).toThrow("goes past the screen");
  });

  test("below full access only looking", () => {
    expect(allowedIn("screenshot", "plan")).toBe(true);
    expect(allowedIn("zoom", "edits")).toBe(true);
    expect(allowedIn("left_click", "edits")).toBe(false);
    expect(allowedIn("type", "full")).toBe(true);
  });

  test("a click goes to the screen's pixels, then a screenshot comes back", async () => {
    const { b, log } = fake();
    const r = await act(parseAction({ action: "double_click", coordinate: [640, 360], text: "ctrl" }, view), { backend: b });
    expect(r.ok).toBe(true);
    expect(log).toEqual(["move 1280,720", "key down ctrl", "left click x2", "key up ctrl", "capture all -> 1280x720"]);
    expect(r.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
  });

  test("screenshot: false skips it; mouse_move never has one", async () => {
    const { b, log } = fake();
    expect((await act(parseAction({ action: "type", text: "hi" }, view), { backend: b, after: false })).content).toEqual([{ type: "text", text: "Typed 2 characters." }]);
    await act(parseAction({ action: "mouse_move", coordinate: [1, 1] }, view), { backend: b });
    expect(log).toEqual(["type hi", "move 2,2"]);
  });

  test("a drag presses, moves in steps and lets go", async () => {
    const { b, log } = fake();
    await act(parseAction({ action: "left_click_drag", start_coordinate: [0, 0], coordinate: [100, 0] }, view), { backend: b, after: false });
    expect(log[0]).toBe("move 0,0");
    expect(log[1]).toBe("left down");
    expect(log.filter((l) => l.startsWith("move")).length).toBe(9);
    expect(log.at(-2)).toBe("move 200,0");
    expect(log.at(-1)).toBe("left up");
  });

  test("zoom shoots the region at full detail", async () => {
    const { b, log } = fake();
    const r = await act(parseAction({ action: "zoom", region: [0, 0, 640, 360] }, view), { backend: b });
    expect(log).toEqual(["capture 0,0 1280x720 -> 1280x720"]);
    expect(r.content[1]).toMatchObject({ type: "image" });
  });

  test("cursor_position is in the screenshot's pixels", async () => {
    const { b } = fake(2560, 1440, { x: 1280, y: 720 });
    expect((await act({ action: "cursor_position" }, { backend: b })).content[0]).toEqual({ type: "text", text: "X=640, Y=360" });
  });

  test("the pointer in the top-left corner stops input, not looking", async () => {
    const { b, log } = fake(2560, 1440, { x: 0, y: 1 });
    const r = await act(parseAction({ action: "left_click", coordinate: [5, 5] }, view), { backend: b });
    expect(r.ok).toBe(false);
    expect((r.content[0] as { text: string }).text).toContain("top-left corner");
    expect((await act({ action: "screenshot" }, { backend: b })).ok).toBe(true);
    // Still stopped after the pointer leaves the corner, for a minute.
    await b.move(900, 900);
    expect((await act(parseAction({ action: "type", text: "x" }, view), { backend: b })).ok).toBe(false);
    expect(log.some((l) => l.startsWith("left") || l.startsWith("type"))).toBe(false);
  });
});

describe("the gate", () => {
  afterEach(() => setHost(null));
  const ctx = (access = "full", notes: string[] = []): CallContext => ({ chatId: 7, title: "Tests", access, chatGid: "g7", project: "harbor", notice: (t) => void notes.push(t) });

  test("input needs full access; the arguments are checked first", async () => {
    setHost({ sameAccount: () => false, started: () => {} });
    expect((await call({ action: "left_click" }, ctx("plan"))).content[0]).toMatchObject({ text: expect.stringContaining("needs full access") });
    expect((await call({ action: "nope" }, ctx())).ok).toBe(false);
  });

  test("another PC's calls go through the mesh, and the chat says so once", async () => {
    const sent: unknown[] = [];
    setHost({
      sameAccount: () => false,
      started: () => {},
      remote: async (m, args) => {
        sent.push([m, args]);
        return m === "lenovo" ? { ok: true, content: [{ type: "text", text: "done" }] } : null;
      },
    });
    const notes: string[] = [];
    expect(await call({ action: "screenshot", machine: "lenovo" }, ctx("full", notes))).toEqual({ ok: true, content: [{ type: "text", text: "done" }] });
    await call({ action: "screenshot", machine: "lenovo" }, ctx("full", notes));
    expect(sent).toEqual([["lenovo", { action: "screenshot" }], ["lenovo", { action: "screenshot" }]]);
    expect(notes).toEqual(["Using the screen of lenovo"]);
    expect((await call({ action: "screenshot", machine: "nobody" }, ctx())).content[0]).toMatchObject({ text: expect.stringContaining("No PC named 'nobody'") });
  });

  test("other PCs' chats only from PCs of the same account, never another person's", async () => {
    const asked: string[] = [];
    setHost({ sameAccount: (id) => (asked.push(id), id === "pc-mine"), started: () => {} });
    const r = await served({ id: "pc-theirs", name: "mac" }, { action: "left_click", coordinate: [1, 1] });
    expect(r.ok).toBe(false);
    expect(r.content[0]).toMatchObject({ text: expect.stringContaining("same account") });
    expect(asked).toEqual(["pc-theirs"]);
    // No host (no account known): refused too.
    setHost(null);
    expect((await served({ id: "pc-mine", name: "mac" }, { action: "screenshot" })).ok).toBe(false);
  });
});

describe("on Harbor's MCP server", () => {
  test("every agent gets the computer tool", () => {
    for (const role of ["lead", "sub"]) expect(tools(role).some((t) => t.name === "computer")).toBe(true);
    const schema = toolDef(true).inputSchema as { properties: Record<string, unknown>; required: string[] };
    expect(schema.required).toEqual(["action"]);
    expect(Object.keys(schema.properties)).toContain("machine");
  });

  test("a screenshot comes back as MCP image content", async () => {
    const image = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };
    const out = await answer({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "computer", arguments: { action: "screenshot" } } }, 3, "sub", async () => [true, "Screen", [{ type: "text", text: "Screen" }, image]], "1.0");
    expect(out).toEqual({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Screen" }, image], isError: false } });
  });
});
