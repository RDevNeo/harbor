// The `computer` tool's name, actions and schema: what `harbor mcp` lists, without the screen code (computer.ts) it runs.
import type { Json } from "./json.ts";

type JsonObj = { [k: string]: Json };

export const ACTIONS = [
  "screenshot",
  "zoom",
  "cursor_position",
  "mouse_move",
  "left_click",
  "right_click",
  "middle_click",
  "double_click",
  "triple_click",
  "left_click_drag",
  "left_mouse_down",
  "left_mouse_up",
  "scroll",
  "type",
  "key",
  "hold_key",
  "wait",
] as const;
export type ActionName = (typeof ACTIONS)[number];

export const MAX_WAIT_S = 60;

const MACHINE = { type: "string", description: "Another PC of the user's own (signed in to the same account) to use (its name, as the machines tool's `list` shows it); default: this PC" };

/** The tool's definition on the `harbor` server. */
export function toolDef(mesh: boolean): JsonObj {
  const properties: JsonObj = {
    action: {
      type: "string",
      enum: [...ACTIONS],
      description:
        "screenshot: the screen now. zoom: a region at full detail. cursor_position: where the pointer is. mouse_move, left_click, right_click, middle_click, double_click, triple_click: at coordinate (default: where the pointer is). left_click_drag: from start_coordinate (default: the pointer) to coordinate. left_mouse_down/up: press or release the left button. scroll: scroll_amount notches toward scroll_direction, at coordinate. type: text as typed. key: a key or chord (xdotool names), repeat times. hold_key: hold it for duration seconds. wait: duration seconds, then a screenshot",
    },
    coordinate: { type: "array", items: { type: "number" }, description: "[x, y] in the last screenshot's pixels (not the zoomed picture's)" },
    start_coordinate: { type: "array", items: { type: "number" }, description: "left_click_drag: where the drag starts, [x, y]" },
    text: { type: "string", description: "type: the text. key and hold_key: e.g. 'Return', 'ctrl+s', 'alt+Tab', 'super', several chords separated by spaces. Clicks and scroll: modifier keys to hold, e.g. 'shift', 'ctrl+shift'" },
    scroll_direction: { type: "string", enum: ["up", "down", "left", "right"], description: "scroll: which way" },
    scroll_amount: { type: "integer", description: "scroll: notches of the wheel (default 3)" },
    duration: { type: "number", description: `wait and hold_key: seconds (at most ${MAX_WAIT_S})` },
    repeat: { type: "integer", description: "key: how many times (default 1)" },
    region: { type: "array", items: { type: "number" }, description: "zoom: [x0, y0, x1, y1] in the last screenshot's pixels" },
    sign_in: { type: "boolean", description: "type, key and hold_key: true only when the user explicitly asked you to do this sign-in. Without it, typing into a password field or a system sign-in or permission dialog is refused" },
    screenshot: { type: "boolean", description: "After a click, drag, key, typing or scroll a screenshot comes back (default true); false skips it" },
  };
  if (mesh) properties.machine = MACHINE;
  return {
    name: "computer",
    description:
      "See and control the screen of the PC Harbor runs on (or another PC of the mesh with `machine`): screenshots, the mouse and the keyboard, like Anthropic's computer-use tool. Start with a screenshot; coordinates are in its pixels (it's scaled down from the real screen). It's always on for this PC's chats; another PC's screen works only when that PC is signed in to the same account as this one (never another person's). The user sees when you start (a notification) and stops you by moving the pointer into the screen's top-left corner. Typing and keys are refused while a password field or a system sign-in or permission dialog (UAC, credentials, polkit, keychain, SecurityAgent) has the focus: ask the user to do it, and pass sign_in only when they explicitly asked you to do that sign-in. Ask before anything that sends, buys, deletes or signs in, and don't touch windows unrelated to the task. Below full access only screenshot, zoom, cursor_position and wait work.",
    inputSchema: { type: "object", properties, required: ["action"] },
  };
}

