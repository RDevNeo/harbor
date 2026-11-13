// Computer use: one `computer` tool for every agent, served by Harbor's own MCP server (`harbor`), with the action set
// of Anthropic's computer-use tool (computer_20250124 plus zoom: screenshot, clicks, drags, keys, typing, scroll,
// waits). Screenshots are scaled down (long edge at most 1280 px, about 1.15 megapixels at most, as Anthropic
// recommends) and the agent's coordinates are in that picture's pixels, mapped back to the screen's here. The
// system side is @harbor/os `screen` (Windows, macOS, Linux compositors and X11).
//
// The user decides: off until they turn it on in Settings › General (kv `computer_use`), and another PC's chats
// only when they also allow that (kv `computer_use_peers`) and share everything with that PC. While an agent uses
// the screen the chat says so and the desktop shows a notification; moving the pointer into the screen's
// top-left corner stops every agent's input for a minute.
import { screen } from "@harbor/os";
import { hostname } from "@harbor/net";
import { ACTIONS, type ActionName, MAX_WAIT_S } from "./computerdef.ts";
import { isObject, type Json } from "./json.ts";

export { ACTIONS, type ActionName, MAX_WAIT_S, toolDef } from "./computerdef.ts";

export const ON_KEY = "computer_use";
export const PEERS_KEY = "computer_use_peers";

/** Actions that only look: allowed in every access mode. */
const LOOKING: readonly ActionName[] = ["screenshot", "zoom", "cursor_position", "wait"];
/** Actions after which a fresh screenshot comes back (unless `screenshot: false`). */
const CHANGING: readonly ActionName[] = ["left_click", "right_click", "middle_click", "double_click", "triple_click", "left_click_drag", "left_mouse_up", "scroll", "type", "key", "hold_key"];

export const MAX_LONG_EDGE = 1280;
export const MAX_PIXELS = 1_150_000;
export const MAX_TEXT = 5000;

export type Point = [number, number];

export type Action =
  | { action: "screenshot" | "cursor_position" | "left_mouse_down" | "left_mouse_up" }
  | { action: "zoom"; region: [number, number, number, number] }
  | { action: "mouse_move"; coordinate: Point }
  | { action: "left_click" | "right_click" | "middle_click" | "double_click" | "triple_click"; coordinate: Point | null; mods: string }
  | { action: "left_click_drag"; start: Point | null; coordinate: Point; mods: string }
  | { action: "scroll"; coordinate: Point | null; direction: screen.Direction; amount: number; mods: string }
  | { action: "type"; text: string }
  | { action: "key"; text: string; repeat: number }
  | { action: "hold_key"; text: string; duration: number }
  | { action: "wait"; duration: number };

/** The size screenshots are shown at for a screen of `w`×`h`. */
export function scaled(w: number, h: number): { w: number; h: number } {
  const s = Math.min(1, MAX_LONG_EDGE / Math.max(w, h), Math.sqrt(MAX_PIXELS / (w * h)));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

/** A point of the shown picture (`view`) on the screen (`real`), clamped inside it. */
export function toScreen(p: Point, view: { w: number; h: number }, real: { w: number; h: number }): Point {
  const x = Math.round((p[0] * real.w) / view.w);
  const y = Math.round((p[1] * real.h) / view.h);
  return [Math.max(0, Math.min(real.w - 1, x)), Math.max(0, Math.min(real.h - 1, y))];
}

/** A screen point in the shown picture's pixels. */
export function toView(p: Point, view: { w: number; h: number }, real: { w: number; h: number }): Point {
  return [Math.max(0, Math.min(view.w - 1, Math.round((p[0] * view.w) / real.w))), Math.max(0, Math.min(view.h - 1, Math.round((p[1] * view.h) / real.h)))];
}

/** A zoom region of the shown picture ([x0, y0, x1, y1], edges) as screen pixels: its edges scaled, outward. */
export function zoomRegion(r: readonly [number, number, number, number], view: { w: number; h: number }, real: { w: number; h: number }): { x: number; y: number; w: number; h: number } {
  const x = Math.max(0, Math.floor((r[0] * real.w) / view.w));
  const y = Math.max(0, Math.floor((r[1] * real.h) / view.h));
  const x1 = Math.min(real.w, Math.ceil((r[2] * real.w) / view.w));
  const y1 = Math.min(real.h, Math.ceil((r[3] * real.h) / view.h));
  return { x, y, w: Math.max(1, x1 - x), h: Math.max(1, y1 - y) };
}

/** The size a zoomed region is shown at: fitted into the screenshot's size, at most 4 times its own. */
export function zoomSize(region: { w: number; h: number }, view: { w: number; h: number }): { w: number; h: number } {
  const s = Math.min(4, view.w / region.w, view.h / region.h);
  return { w: Math.max(1, Math.round(region.w * s)), h: Math.max(1, Math.round(region.h * s)) };
}

function point(v: unknown, name: string, view: { w: number; h: number } | null): Point {
  if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === "number" && Number.isFinite(n))) throw new Error(`${name} must be [x, y], two numbers`);
  const [x, y] = v as [number, number];
  if (x < 0 || y < 0 || (view !== null && (x >= view.w || y >= view.h))) throw new Error(`${name} [${x}, ${y}] is outside the screen (${view ? `0-${view.w - 1}, 0-${view.h - 1}` : "negative"}); coordinates are in the last screenshot's pixels`);
  return [Math.round(x), Math.round(y)];
}

const str = (a: Record<string, unknown>, k: string): string | undefined => (typeof a[k] === "string" ? (a[k] as string) : undefined);
const num = (a: Record<string, unknown>, k: string): number | undefined => (typeof a[k] === "number" && Number.isFinite(a[k]) ? (a[k] as number) : undefined);

/** A tool call's arguments as one action, checked; `view` is the screenshot size coordinates are checked against. Throws saying what's wrong. */
export function parseAction(args: unknown, view: { w: number; h: number } | null): Action {
  const a = isObject(args) ? (args as Record<string, unknown>) : {};
  const name = str(a, "action") ?? "";
  if (!(ACTIONS as readonly string[]).includes(name)) throw new Error(`action must be one of ${ACTIONS.join(", ")}`);
  const action = name as ActionName;
  const mods = (str(a, "text") ?? "").trim();
  const coord = (required: boolean): Point | null => (a.coordinate === undefined || a.coordinate === null ? (required ? (() => { throw new Error(`${action} needs coordinate [x, y]`); })() : null) : point(a.coordinate, "coordinate", view));
  if (mods !== "" && ["left_click", "right_click", "middle_click", "double_click", "triple_click", "left_click_drag", "scroll"].includes(action)) {
    const c = screen.parseCombo(mods);
    if (c.key !== "") throw new Error(`text on ${action} names modifier keys to hold (shift, ctrl, alt, super), not '${c.key}'`);
  }
  switch (action) {
    case "screenshot":
    case "cursor_position":
    case "left_mouse_down":
    case "left_mouse_up":
      return { action };
    case "zoom": {
      const r = a.region;
      if (!Array.isArray(r) || r.length !== 4 || !r.every((n) => typeof n === "number" && Number.isFinite(n))) throw new Error("zoom needs region [x0, y0, x1, y1]");
      const [x0, y0, x1, y1] = (r as number[]).map(Math.round) as [number, number, number, number];
      point([x0, y0], "region's top-left", view);
      if (x1 <= x0 || y1 <= y0) throw new Error("region's bottom-right must be right of and below its top-left");
      if (view !== null && (x1 > view.w || y1 > view.h)) throw new Error(`region [${x0}, ${y0}, ${x1}, ${y1}] goes past the screen (${view.w}x${view.h})`);
      return { action, region: [x0, y0, x1, y1] };
    }
    case "mouse_move":
      return { action, coordinate: coord(true) as Point };
    case "left_click":
    case "right_click":
    case "middle_click":
    case "double_click":
    case "triple_click":
      return { action, coordinate: coord(false), mods };
    case "left_click_drag": {
      const start = a.start_coordinate === undefined || a.start_coordinate === null ? null : point(a.start_coordinate, "start_coordinate", view);
      return { action, start, coordinate: coord(true) as Point, mods };
    }
    case "scroll": {
      const dir = str(a, "scroll_direction") ?? "";
      if (!["up", "down", "left", "right"].includes(dir)) throw new Error("scroll needs scroll_direction: up, down, left or right");
      const amount = Math.round(num(a, "scroll_amount") ?? 3);
      if (amount < 1 || amount > 100) throw new Error("scroll_amount is 1 to 100 notches of the wheel");
      return { action, coordinate: coord(false), direction: dir as screen.Direction, amount, mods };
    }
    case "type": {
      const text = str(a, "text") ?? "";
      if (text === "") throw new Error("type needs text");
      if (text.length > MAX_TEXT) throw new Error(`text is at most ${MAX_TEXT} characters a call`);
      return { action, text };
    }
    case "key":
    case "hold_key": {
      const text = (str(a, "text") ?? "").trim();
      if (text === "") throw new Error(`${action} needs text: a key or chord in xdotool's names, e.g. "Return" or "ctrl+s"`);
      screen.parseKeys(text);
      if (action === "key") {
        const repeat = Math.round(num(a, "repeat") ?? 1);
        if (repeat < 1 || repeat > 100) throw new Error("repeat is 1 to 100");
        return { action, text, repeat };
      }
      const duration = num(a, "duration") ?? 1;
      if (!(duration > 0 && duration <= MAX_WAIT_S)) throw new Error(`duration is more than 0 and at most ${MAX_WAIT_S} seconds`);
      return { action, text, duration };
    }
    case "wait": {
      const duration = num(a, "duration") ?? 1;
      if (!(duration >= 0 && duration <= MAX_WAIT_S)) throw new Error(`duration is 0 to ${MAX_WAIT_S} seconds`);
      return { action, duration };
    }
  }
}

/** Whether `action` may run in a chat of `access` (only looking below full access). */
export function allowedIn(action: ActionName, access: string): boolean {
  return access === "full" || LOOKING.includes(action);
}

type JsonObj = { [k: string]: Json };

// --- Running actions on this PC ---

export interface Result {
  ok: boolean;
  content: Json[];
}

const textOf = (ok: boolean, t: string): Result => ({ ok, content: [{ type: "text", text: t }] });

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Where the pointer must be for the user to stop agents: the top-left corner of the screen. */
const CORNER = 2;
const STOP_MS = 60_000;
let stoppedUntil = 0;

/** The screen's view and real size for this call: the backend's size, scaled. */
async function sizes(b: screen.Backend): Promise<{ real: { w: number; h: number }; view: { w: number; h: number } }> {
  const real = await b.size();
  return { real, view: scaled(real.w, real.h) };
}

async function shot(b: screen.Backend, real: { w: number; h: number }, view: { w: number; h: number }, region?: screen.Rect): Promise<Json> {
  const out = region ? zoomSize(region, view) : view;
  let img = await b.capture(region, out);
  // A backend that shoots the whole screen at its own size: cropped and scaled here.
  if (region && (img.w !== out.w || img.h !== out.h) && img.w === real.w && img.h === real.h) img = screen.crop(img, region);
  if (img.w !== out.w || img.h !== out.h) img = screen.resize(img, out.w, out.h);
  const data = Buffer.from(await screen.png(img)).toString("base64");
  return { type: "image", data, mimeType: "image/png" };
}

/** Runs one checked action on this PC's screen. */
export async function act(a: Action, opts: { after?: boolean; backend?: screen.Backend; sizes?: Awaited<ReturnType<typeof sizes>> } = {}): Promise<Result> {
  const b = opts.backend ?? screen.backend();
  const { real, view } = opts.sizes ?? (await sizes(b));
  const at = (p: Point): Point => toScreen(p, view, real);
  const looking = LOOKING.includes(a.action);
  if (!looking) {
    if (Date.now() < stoppedUntil) return textOf(false, `The user stopped computer use on ${hostname()} (pointer moved into the top-left corner); try again in ${Math.ceil((stoppedUntil - Date.now()) / 1000)} s, or ask them.`);
    const c = await b.cursor().catch(() => null);
    if (c !== null && c.x <= CORNER && c.y <= CORNER && (real.w > 100 || real.h > 100)) {
      stoppedUntil = Date.now() + STOP_MS;
      return textOf(false, `The user stopped computer use on ${hostname()}: they moved the pointer into the top-left corner. Don't use the screen for a minute; ask them what they want.`);
    }
  }
  const withMods = async (mods: string, f: () => Promise<void>): Promise<void> => {
    if (mods === "") return f();
    const c = screen.parseCombo(mods);
    await b.key(c, "down");
    try {
      await f();
    } finally {
      await b.key(c, "up");
    }
  };
  let said = "";
  switch (a.action) {
    case "screenshot":
      return { ok: true, content: [{ type: "text", text: `Screen of ${hostname()}: ${real.w}x${real.h}, shown at ${view.w}x${view.h}. Coordinates are in this picture's pixels.` }, await shot(b, real, view)] };
    case "zoom": {
      const region = zoomRegion(a.region, view, real);
      return { ok: true, content: [{ type: "text", text: `Region [${a.region.join(", ")}] (${region.w}x${region.h} screen pixels). Coordinates stay those of the full screenshot.` }, await shot(b, real, view, region)] };
    }
    case "cursor_position": {
      const c = await b.cursor();
      if (c === null) return textOf(false, "This system doesn't say where the pointer is.");
      const [x, y] = toView([c.x, c.y], view, real);
      return textOf(true, `X=${x}, Y=${y}`);
    }
    case "wait":
      await pause(a.duration * 1000);
      return { ok: true, content: [{ type: "text", text: `Waited ${a.duration} s.` }, await shot(b, real, view)] };
    case "mouse_move": {
      const [x, y] = at(a.coordinate);
      await b.move(x, y);
      said = `Moved the pointer to [${a.coordinate.join(", ")}].`;
      break;
    }
    case "left_click":
    case "right_click":
    case "middle_click":
    case "double_click":
    case "triple_click": {
      if (a.coordinate) {
        const [x, y] = at(a.coordinate);
        await b.move(x, y);
        await pause(30);
      }
      const button: screen.Button = a.action === "right_click" ? "right" : a.action === "middle_click" ? "middle" : "left";
      const count = a.action === "double_click" ? 2 : a.action === "triple_click" ? 3 : 1;
      await withMods(a.mods, () => b.button(button, "click", count));
      said = `${a.action.replace("_", " ")}${a.coordinate ? ` at [${a.coordinate.join(", ")}]` : ""}${a.mods === "" ? "" : ` with ${a.mods}`}.`;
      break;
    }
    case "left_click_drag": {
      const from = a.start ? at(a.start) : null;
      const to = at(a.coordinate);
      await withMods(a.mods, async () => {
        if (from) await b.move(from[0], from[1]);
        const c = from === null ? await b.cursor() : null;
        const [sx, sy] = from ?? (c === null ? to : [c.x, c.y]);
        await b.button("left", "down");
        try {
          // A few steps between, so apps see a drag rather than a jump.
          for (let i = 1; i <= 8; i++) {
            await pause(15);
            await b.move(sx + ((to[0] - sx) * i) / 8, sy + ((to[1] - sy) * i) / 8);
          }
          await pause(30);
        } finally {
          await b.button("left", "up");
        }
      });
      said = `Dragged ${a.start ? `from [${a.start.join(", ")}] ` : ""}to [${a.coordinate.join(", ")}].`;
      break;
    }
    case "left_mouse_down":
      await b.button("left", "down");
      said = "Left button down.";
      break;
    case "left_mouse_up":
      await b.button("left", "up");
      said = "Left button up.";
      break;
    case "scroll": {
      if (a.coordinate) {
        const [x, y] = at(a.coordinate);
        await b.move(x, y);
        await pause(30);
      }
      await withMods(a.mods, () => b.scroll(a.direction, a.amount));
      said = `Scrolled ${a.direction} ${a.amount}.`;
      break;
    }
    case "type":
      await b.type(a.text);
      said = `Typed ${a.text.length} characters.`;
      break;
    case "key": {
      const combos = screen.parseKeys(a.text);
      for (let i = 0; i < a.repeat; i++) for (const c of combos) await b.key(c);
      said = `Pressed ${a.text}${a.repeat > 1 ? ` ${a.repeat} times` : ""}.`;
      break;
    }
    case "hold_key": {
      const combos = screen.parseKeys(a.text);
      const c = combos[0] as screen.Combo;
      const ms = Math.round(a.duration * 1000);
      if (b.hold) await b.hold(c, ms);
      else {
        await b.key(c, "down");
        try {
          await pause(ms);
        } finally {
          await b.key(c, "up");
        }
      }
      said = `Held ${a.text} for ${a.duration} s.`;
      break;
    }
  }
  if (opts.after === false || !CHANGING.includes(a.action)) return textOf(true, said);
  // The screen takes a moment to answer a click or a key.
  await pause(600);
  return { ok: true, content: [{ type: "text", text: said }, await shot(b, real, view)] };
}

// --- The gate, the indicator, and other PCs ---

export interface Gate {
  /** kv flags, read on every call (a switch in Settings takes effect at once). */
  on(): boolean;
  peers(): boolean;
}

export interface Host extends Gate {
  /** An agent starts using a screen: a desktop notification here (`who` is the chat or the other PC). */
  started(who: string, here: boolean): void;
  /** Another PC of the mesh: forwards the call there (`machines`' mesh), or null when there's no such PC. */
  remote?(machine: string, args: JsonObj, ctx: { chat: string; project: string }): Promise<Result | null>;
}

let host: Host | null = null;

/** The app sets it once its store and mesh are up; tests set their own. */
export function setHost(h: Host | null): void {
  host = h;
}

/** Whether this PC's owner lets agents use its screen. */
export function enabled(): boolean {
  return host?.on() === true;
}

const QUIET_MS = 5 * 60_000;
const lastUse = new Map<string, number>();

/** Whether `key` (a chat, or a PC) starts a new stretch of use now: nothing for five minutes before. */
function startsUse(key: string): boolean {
  const t = Date.now();
  const before = lastUse.get(key);
  lastUse.set(key, t);
  return before === undefined || t - before > QUIET_MS;
}

const OFF = (): string =>
  `Computer use is off on ${hostname()}. The user turns it on in Harbor › Settings › General › Computer use; ask them, then try again.`;

/** Gate line for the agent when this PC can't act: off, or what this desktop lacks. Null when it can. */
export function unavailable(): string | null {
  if (!enabled()) return OFF();
  const p = screen.probe(process.env, true);
  if (!p.ok) return `Computer use can't run on ${hostname()} (${p.name}): it needs ${p.missing.join("; ")}. Tell the user what to install or allow.`;
  return null;
}

export interface CallContext {
  /** The chat's id (for the notice), title and access mode. */
  chatId: number;
  title: string;
  access: string;
  /** For calls forwarded to another PC. */
  chatGid: string;
  project: string;
  /** Says in the chat that its agent uses a screen (`text`), once per stretch of use. */
  notice(text: string): void;
}

/** The `computer` tool for a chat of this PC. */
export async function call(args: unknown, ctx: CallContext): Promise<Result> {
  const a = isObject(args) ? (args as JsonObj) : {};
  const machine = typeof a.machine === "string" ? a.machine.trim() : "";
  const here = machine === "" || machine.toLowerCase() === hostname().toLowerCase();
  let parsed: Action;
  try {
    parsed = parseAction(a, null);
  } catch (e) {
    return textOf(false, e instanceof Error ? e.message : String(e));
  }
  if (!allowedIn(parsed.action, ctx.access)) return textOf(false, `${parsed.action} needs full access; this chat may only look (screenshot, zoom, cursor_position, wait).`);
  if (!here) {
    if (!host?.remote) return textOf(false, `No PC named '${machine}': this Harbor has no mesh.`);
    const rest: JsonObj = { ...a };
    delete rest.machine;
    const r = await host.remote(machine, rest, { chat: ctx.chatGid, project: ctx.project });
    if (r === null) return textOf(false, `No PC named '${machine}' in the mesh; the machines tool's \`list\` shows them.`);
    if (r.ok && startsUse(`chat:${ctx.chatId}:${machine}`)) ctx.notice(`Using the screen of ${machine}`);
    return r;
  }
  const why = unavailable();
  if (why !== null) return textOf(false, why);
  try {
    const b = screen.backend();
    const sz = await sizes(b);
    const checked = parseAction(a, sz.view);
    if (startsUse(`chat:${ctx.chatId}`)) {
      ctx.notice("Using this PC's screen (computer use)");
      host?.started(ctx.title, true);
    }
    return await act(checked, { after: a.screenshot !== false, backend: b, sizes: sz });
  } catch (e) {
    return textOf(false, e instanceof Error ? e.message : String(e));
  }
}

/** The `computer` tool for a chat of another PC (`peer`, its name), through `/mesh/v1/tool`: only when this PC's owner
 *  allows other PCs' chats and shares everything with that one (`full`). */
export async function served(peer: string, full: boolean, args: unknown): Promise<Result> {
  if (!enabled()) return textOf(false, OFF());
  if (!host?.peers()) return textOf(false, `${hostname()} doesn't let other PCs' chats use its screen; its owner can allow it in Settings › General › Computer use there.`);
  if (!full) return textOf(false, `${hostname()} shares less than everything with ${peer}, and its screen goes only with everything (Settings › Workspace there).`);
  const why = unavailable();
  if (why !== null) return textOf(false, why);
  try {
    const b = screen.backend();
    const sz = await sizes(b);
    const a = parseAction(args, sz.view);
    if (startsUse(`peer:${peer}`)) host.started(`a chat on ${peer}`, false);
    return await act(a, { after: !(isObject(args) && args.screenshot === false), backend: b, sizes: sz });
  } catch (e) {
    return textOf(false, e instanceof Error ? e.message : String(e));
  }
}

/** One line for Settings: what this PC's desktop can do. */
export function statusLine(): string {
  const p = screen.probe();
  if (p.ok) return `Works here: ${p.name}.${p.limits.length > 0 ? ` ${p.limits.map((l) => l.charAt(0).toUpperCase() + l.slice(1)).join(". ")}.` : ""}`;
  return `Not ready here (${p.name}): needs ${p.missing.join("; ")}.`;
}
